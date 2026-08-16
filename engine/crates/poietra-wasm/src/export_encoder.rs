//! Hand-owned `WebCodecs` H.264 encoder binding for client-side export.
//!
//! web-sys 0.3.103 gates `VideoEncoder` and `EncodedVideoChunk` behind the
//! `web_sys_unstable_apis` cfg and its generated `VideoEncoderConfig` lacks
//! the AVC codec-registration `avc: { format }` member entirely, so this
//! module owns minimal `#[wasm_bindgen] extern "C"` bindings instead of
//! enabling the unstable cfg for the whole workspace (decision recorded in
//! issue #693). `VideoFrame` construction uses only stable web-sys APIs.
//!
//! Everything is fail-closed: a configuration is only reported as supported
//! after `isConfigSupported()` AND a real two-frame encode proof, and a
//! session that fails for any reason reports one named refusal and yields no
//! partial chunks.

use std::cell::RefCell;
use std::fmt;
use std::rc::Rc;

use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::export_encoder_protocol::{
    EXPORT_ENCODER_FLUSH_TIMEOUT_MILLISECONDS_V1, EXPORT_ENCODER_WAIT_TIMEOUT_MILLISECONDS_V1,
    ExportEncoderColorSpaceEvidenceV1, ExportEncoderDecoderConfigEvidenceV1,
    ExportEncoderRefusalReasonV1, ExportEncoderResultV1, ExportEncoderSessionConfigV1,
    H264_CODEC_LADDER_V1, MAX_ENCODE_QUEUE_DEPTH_V1, MAX_ENCODED_CHUNKS_V1,
    MAX_TOTAL_ENCODED_BYTES_V1, export_encoder_refusal_result, export_encoder_response,
    key_frame_required_v1, parse_export_encoder_session_request_v1,
};

const EXPORT_ENCODER_REFUSED_ERROR_NAME: &str = "PoietraExportEncoderRefused";
const TIMEOUT_SENTINEL_V1: &str = "poietra.export-encoder-timeout";
const MAX_EXACT_JAVASCRIPT_INTEGER_V1: f64 = 9_007_199_254_740_991.0;

const PROBE_FRAME_DIMENSION_PX_V1: u32 = 64;
const PROBE_FRAME_RGBA_BYTES_V1: usize = 64 * 64 * 4;
const PROBE_FRAME_COUNT_V1: usize = 2;
const PROBE_FRAME_DURATION_MICROSECONDS_V1: f64 = 33_333.0;
const PROBE_BITRATE_V1: u32 = 1_000_000;
const PROBE_FRAMES_PER_SECOND_V1: u32 = 30;

#[wasm_bindgen]
extern "C" {
    /// Minimal hand-owned `WebCodecs` `VideoEncoder` binding. Only the members
    /// this module needs are declared; nothing here is re-exported to JS.
    #[wasm_bindgen(js_name = VideoEncoder)]
    type VideoEncoder;

    #[wasm_bindgen(catch, constructor, js_class = "VideoEncoder")]
    fn new(init: &js_sys::Object) -> Result<VideoEncoder, JsValue>;

    #[wasm_bindgen(catch, static_method_of = VideoEncoder, js_name = isConfigSupported)]
    fn is_config_supported(config: &js_sys::Object) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(catch, method, js_class = "VideoEncoder")]
    fn configure(this: &VideoEncoder, config: &js_sys::Object) -> Result<(), JsValue>;

    #[wasm_bindgen(catch, method, js_class = "VideoEncoder", js_name = encode)]
    fn encode_with_options(
        this: &VideoEncoder,
        frame: &web_sys::VideoFrame,
        options: &js_sys::Object,
    ) -> Result<(), JsValue>;

    #[wasm_bindgen(catch, method, js_class = "VideoEncoder")]
    fn flush(this: &VideoEncoder) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(catch, method, js_class = "VideoEncoder")]
    fn close(this: &VideoEncoder) -> Result<(), JsValue>;

    #[wasm_bindgen(method, getter, js_class = "VideoEncoder", js_name = encodeQueueSize)]
    fn encode_queue_size(this: &VideoEncoder) -> u32;

    #[wasm_bindgen(method, setter, js_class = "VideoEncoder", js_name = ondequeue)]
    fn set_ondequeue(this: &VideoEncoder, handler: &js_sys::Function);

    /// Minimal hand-owned `WebCodecs` `EncodedVideoChunk` binding.
    #[wasm_bindgen(js_name = EncodedVideoChunk)]
    type EncodedVideoChunk;

    #[wasm_bindgen(method, getter, js_class = "EncodedVideoChunk", js_name = byteLength)]
    fn byte_length(this: &EncodedVideoChunk) -> f64;

    #[wasm_bindgen(method, getter, js_class = "EncodedVideoChunk")]
    fn timestamp(this: &EncodedVideoChunk) -> f64;

    #[wasm_bindgen(method, getter, js_class = "EncodedVideoChunk")]
    fn duration(this: &EncodedVideoChunk) -> Option<f64>;

    #[wasm_bindgen(method, getter, js_class = "EncodedVideoChunk", js_name = type)]
    fn chunk_type(this: &EncodedVideoChunk) -> String;

    #[wasm_bindgen(catch, method, js_class = "EncodedVideoChunk", js_name = copyTo)]
    fn copy_to(this: &EncodedVideoChunk, destination: &js_sys::Uint8Array) -> Result<(), JsValue>;
}

#[derive(Clone, Debug)]
struct EncoderFailureV1 {
    message: String,
    reason: ExportEncoderRefusalReasonV1,
}

impl EncoderFailureV1 {
    fn new(reason: ExportEncoderRefusalReasonV1, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reason,
        }
    }

    fn refusal_result(&self) -> ExportEncoderResultV1 {
        export_encoder_refusal_result(self.reason, &self.message)
    }
}

#[derive(Debug)]
struct CollectedChunkV1 {
    bytes: Vec<u8>,
    duration_microseconds: Option<f64>,
    key_frame: bool,
    timestamp_microseconds: f64,
}

#[derive(Debug)]
struct CollectedDecoderConfigV1 {
    color_space: ExportEncoderColorSpaceEvidenceV1,
    description: Vec<u8>,
}

/// State shared between the session and the encoder's JS callbacks. Borrows
/// are never held across `await` points, so callback re-entrancy from the
/// browser task queue cannot observe an open borrow.
#[derive(Debug, Default)]
struct EncoderSharedStateV1 {
    chunks: Vec<CollectedChunkV1>,
    decoder_config: Option<CollectedDecoderConfigV1>,
    failure: Option<EncoderFailureV1>,
    total_chunk_bytes: u64,
    waiters: Vec<js_sys::Function>,
}

type SharedEncoderStateV1 = Rc<RefCell<EncoderSharedStateV1>>;

fn retain_first_encoder_failure(shared: &SharedEncoderStateV1, failure: EncoderFailureV1) {
    {
        let mut state = shared.borrow_mut();
        if state.failure.is_none() {
            state.failure = Some(failure);
        }
    }
    wake_dequeue_waiters(shared);
}

fn read_encoder_failure(shared: &SharedEncoderStateV1) -> Option<EncoderFailureV1> {
    shared.borrow().failure.clone()
}

fn wake_dequeue_waiters(shared: &SharedEncoderStateV1) {
    let waiters = std::mem::take(&mut shared.borrow_mut().waiters);
    for resolve in waiters {
        let _ = resolve.call0(&JsValue::UNDEFINED);
    }
}

fn exact_unsigned_integer(value: f64) -> Option<u64> {
    if !value.is_finite()
        || value < 0.0
        || value.fract() != 0.0
        || value > MAX_EXACT_JAVASCRIPT_INTEGER_V1
    {
        return None;
    }
    // The checks above make this conversion exact; Rust has no checked
    // f64-to-u64 conversion primitive.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(value as u64)
}

fn reflected_string(value: &JsValue, property: &str) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str(property))
        .ok()
        .and_then(|value| value.as_string())
}

fn reflected_bool(value: &JsValue, property: &str) -> Option<bool> {
    js_sys::Reflect::get(value, &JsValue::from_str(property))
        .ok()
        .and_then(|value| value.as_bool())
}

fn js_error_message(error: &JsValue) -> String {
    let name = reflected_string(error, "name")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Error".to_owned());
    let message = reflected_string(error, "message")
        .or_else(|| error.as_string())
        .unwrap_or_else(|| "WebCodecs operation failed".to_owned());
    format!("{name}: {message}")
}

/// Rejection carrying `PoietraExportEncoderRefused` as its `name` and the
/// stable refusal wire name as its message prefix.
fn refused_js_error(reason: ExportEncoderRefusalReasonV1, message: &str) -> JsValue {
    let error = js_sys::Error::new(&format!("{}: {message}", reason.wire_name()));
    error.set_name(EXPORT_ENCODER_REFUSED_ERROR_NAME);
    error.into()
}

fn set_object_property(
    target: &js_sys::Object,
    property: &str,
    value: &JsValue,
) -> Result<(), EncoderFailureV1> {
    let assigned = js_sys::Reflect::set(target, &JsValue::from_str(property), value)
        .map_err(|error| encoder_failure_from_js(&error))?;
    if assigned {
        Ok(())
    } else {
        Err(EncoderFailureV1::new(
            ExportEncoderRefusalReasonV1::EncoderError,
            format!("could not assign the {property} configuration member"),
        ))
    }
}

fn encoder_failure_from_js(error: &JsValue) -> EncoderFailureV1 {
    EncoderFailureV1::new(
        ExportEncoderRefusalReasonV1::EncoderError,
        js_error_message(error),
    )
}

fn video_encoder_constructor_available() -> bool {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("VideoEncoder"))
        .ok()
        .is_some_and(|value| value.is_function())
}

/// Builds one complete `VideoEncoderConfig` as a plain object so the
/// codec-registration `avc: { format: "avc" }` member (absent from generated
/// web-sys dictionaries) is always present.
fn build_encoder_config(
    codec: &str,
    width_px: u32,
    height_px: u32,
    bitrate: u32,
    frames_per_second: u32,
) -> Result<js_sys::Object, EncoderFailureV1> {
    let config = js_sys::Object::new();
    set_object_property(&config, "codec", &JsValue::from_str(codec))?;
    set_object_property(&config, "width", &JsValue::from_f64(f64::from(width_px)))?;
    set_object_property(&config, "height", &JsValue::from_f64(f64::from(height_px)))?;
    set_object_property(&config, "bitrate", &JsValue::from_f64(f64::from(bitrate)))?;
    set_object_property(
        &config,
        "framerate",
        &JsValue::from_f64(f64::from(frames_per_second)),
    )?;
    set_object_property(&config, "latencyMode", &JsValue::from_str("quality"))?;
    let avc = js_sys::Object::new();
    set_object_property(&avc, "format", &JsValue::from_str("avc"))?;
    set_object_property(&config, "avc", &avc)?;
    Ok(config)
}

/// Constructs one `VideoFrame` from a tight RGBA buffer through stable
/// web-sys, always tagging the export colour contract explicitly:
/// primaries bt709 / transfer iec61966-2-1 / matrix bt709 / limited range.
fn rgba_video_frame(
    rgba: &mut [u8],
    width_px: u32,
    height_px: u32,
    timestamp_microseconds: f64,
    duration_microseconds: f64,
) -> Result<web_sys::VideoFrame, EncoderFailureV1> {
    let init = web_sys::VideoFrameBufferInit::new_with_f64(
        height_px,
        width_px,
        web_sys::VideoPixelFormat::Rgba,
        timestamp_microseconds,
    );
    init.set_duration_f64(duration_microseconds);
    let color_space = web_sys::VideoColorSpaceInit::new();
    color_space.set_primaries(Some(web_sys::VideoColorPrimaries::Bt709));
    color_space.set_transfer(Some(web_sys::VideoTransferCharacteristics::Iec6196621));
    color_space.set_matrix(Some(web_sys::VideoMatrixCoefficients::Bt709));
    color_space.set_full_range(Some(false));
    init.set_color_space(&color_space);
    web_sys::VideoFrame::new_with_u8_slice_and_video_frame_buffer_init(rgba, &init).map_err(
        |error| {
            EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::InvalidFrame,
                js_error_message(&error),
            )
        },
    )
}

fn buffer_source_to_vec(value: &JsValue) -> Option<Vec<u8>> {
    if let Some(buffer) = value.dyn_ref::<js_sys::ArrayBuffer>() {
        return Some(js_sys::Uint8Array::new(buffer).to_vec());
    }
    if !value.is_object() {
        return None;
    }
    let buffer = js_sys::Reflect::get(value, &JsValue::from_str("buffer"))
        .ok()?
        .dyn_into::<js_sys::ArrayBuffer>()
        .ok()?;
    let byte_offset = exact_unsigned_integer(
        js_sys::Reflect::get(value, &JsValue::from_str("byteOffset"))
            .ok()?
            .as_f64()?,
    )?;
    let byte_length = exact_unsigned_integer(
        js_sys::Reflect::get(value, &JsValue::from_str("byteLength"))
            .ok()?
            .as_f64()?,
    )?;
    let view = js_sys::Uint8Array::new_with_byte_offset_and_length(
        &buffer,
        u32::try_from(byte_offset).ok()?,
        u32::try_from(byte_length).ok()?,
    );
    Some(view.to_vec())
}

/// Reads `decoderConfig.description` bytes and `decoderConfig.colorSpace`
/// members from one chunk-metadata value. Metadata arrives as a plain JS
/// object, so every member is read through `js_sys::Reflect`.
fn collect_decoder_config_evidence(metadata: &JsValue) -> Option<CollectedDecoderConfigV1> {
    if !metadata.is_object() {
        return None;
    }
    let decoder_config = js_sys::Reflect::get(metadata, &JsValue::from_str("decoderConfig"))
        .ok()
        .filter(JsValue::is_object)?;
    let description =
        js_sys::Reflect::get(&decoder_config, &JsValue::from_str("description")).ok()?;
    let description = buffer_source_to_vec(&description).filter(|bytes| !bytes.is_empty())?;
    let color_space = js_sys::Reflect::get(&decoder_config, &JsValue::from_str("colorSpace"))
        .ok()
        .filter(JsValue::is_object)
        .map(|color_space| ExportEncoderColorSpaceEvidenceV1 {
            full_range: reflected_bool(&color_space, "fullRange"),
            matrix: reflected_string(&color_space, "matrix"),
            primaries: reflected_string(&color_space, "primaries"),
            transfer: reflected_string(&color_space, "transfer"),
        })
        .unwrap_or_default();
    Some(CollectedDecoderConfigV1 {
        color_space,
        description,
    })
}

fn record_encoder_output(shared: &SharedEncoderStateV1, chunk: &JsValue, metadata: &JsValue) {
    if shared.borrow().failure.is_some() {
        return;
    }
    let chunk: &EncodedVideoChunk = chunk.unchecked_ref();
    let Some(byte_length) = exact_unsigned_integer(chunk.byte_length()) else {
        retain_first_encoder_failure(
            shared,
            EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::EncoderError,
                "an encoded chunk reported a non-integer byte length",
            ),
        );
        return;
    };
    let key_frame = match chunk.chunk_type().as_str() {
        "key" => true,
        "delta" => false,
        other => {
            retain_first_encoder_failure(
                shared,
                EncoderFailureV1::new(
                    ExportEncoderRefusalReasonV1::EncoderError,
                    format!("an encoded chunk reported the unknown type {other:?}"),
                ),
            );
            return;
        }
    };
    {
        let state = shared.borrow();
        if state.chunks.len() >= MAX_ENCODED_CHUNKS_V1
            || state
                .total_chunk_bytes
                .checked_add(byte_length)
                .is_none_or(|total| total > MAX_TOTAL_ENCODED_BYTES_V1)
        {
            drop(state);
            retain_first_encoder_failure(
                shared,
                EncoderFailureV1::new(
                    ExportEncoderRefusalReasonV1::CapacityExceeded,
                    format!(
                        "the encoded output exceeds the v1 bounds of {MAX_ENCODED_CHUNKS_V1} chunks / {MAX_TOTAL_ENCODED_BYTES_V1} bytes"
                    ),
                ),
            );
            return;
        }
    }
    let Ok(destination_length) = u32::try_from(byte_length) else {
        retain_first_encoder_failure(
            shared,
            EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::CapacityExceeded,
                "an encoded chunk exceeds the addressable transfer size",
            ),
        );
        return;
    };
    let destination = js_sys::Uint8Array::new_with_length(destination_length);
    if let Err(error) = chunk.copy_to(&destination) {
        retain_first_encoder_failure(shared, encoder_failure_from_js(&error));
        return;
    }
    let collected = CollectedChunkV1 {
        bytes: destination.to_vec(),
        duration_microseconds: chunk.duration(),
        key_frame,
        timestamp_microseconds: chunk.timestamp(),
    };
    let decoder_config = collect_decoder_config_evidence(metadata);
    let mut state = shared.borrow_mut();
    state.total_chunk_bytes += byte_length;
    if state.decoder_config.is_none() {
        state.decoder_config = decoder_config;
    }
    state.chunks.push(collected);
}

/// One constructed-and-configured encoder plus the retained JS callbacks.
/// Dropping the harness closes the encoder first so the browser can never
/// invoke an already-freed Rust closure.
struct EncoderHarnessV1 {
    encoder: VideoEncoder,
    shared: SharedEncoderStateV1,
    _dequeue_callback: Closure<dyn FnMut(JsValue)>,
    _error_callback: Closure<dyn FnMut(JsValue)>,
    _output_callback: Closure<dyn FnMut(JsValue, JsValue)>,
}

impl fmt::Debug for EncoderHarnessV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncoderHarnessV1")
            .field("chunk_count", &self.shared.borrow().chunks.len())
            .finish_non_exhaustive()
    }
}

impl Drop for EncoderHarnessV1 {
    fn drop(&mut self) {
        self.close_quietly();
    }
}

impl EncoderHarnessV1 {
    fn create(config: &js_sys::Object) -> Result<Self, EncoderFailureV1> {
        let shared: SharedEncoderStateV1 = Rc::new(RefCell::new(EncoderSharedStateV1::default()));

        let output_shared = Rc::clone(&shared);
        let output_callback = Closure::wrap(Box::new(move |chunk: JsValue, metadata: JsValue| {
            record_encoder_output(&output_shared, &chunk, &metadata);
        }) as Box<dyn FnMut(JsValue, JsValue)>);
        let error_shared = Rc::clone(&shared);
        let error_callback = Closure::wrap(Box::new(move |error: JsValue| {
            retain_first_encoder_failure(&error_shared, encoder_failure_from_js(&error));
        }) as Box<dyn FnMut(JsValue)>);
        let dequeue_shared = Rc::clone(&shared);
        let dequeue_callback = Closure::wrap(Box::new(move |_event: JsValue| {
            wake_dequeue_waiters(&dequeue_shared);
        }) as Box<dyn FnMut(JsValue)>);

        let init = js_sys::Object::new();
        set_object_property(&init, "output", output_callback.as_ref())?;
        set_object_property(&init, "error", error_callback.as_ref())?;
        let encoder = VideoEncoder::new(&init).map_err(|error| encoder_failure_from_js(&error))?;
        encoder.set_ondequeue(dequeue_callback.as_ref().unchecked_ref());
        let harness = Self {
            encoder,
            shared,
            _dequeue_callback: dequeue_callback,
            _error_callback: error_callback,
            _output_callback: output_callback,
        };
        harness
            .encoder
            .configure(config)
            .map_err(|error| encoder_failure_from_js(&error))?;
        Ok(harness)
    }

    fn close_quietly(&self) {
        let _ = self.encoder.close();
    }

    /// Encodes one frame and closes the `VideoFrame` immediately, before the
    /// encode outcome is even inspected.
    fn encode_and_close_frame(
        &self,
        frame: &web_sys::VideoFrame,
        key_frame: bool,
    ) -> Result<(), EncoderFailureV1> {
        let options = js_sys::Object::new();
        let encoded = set_object_property(&options, "keyFrame", &JsValue::from_bool(key_frame))
            .and_then(|()| {
                self.encoder
                    .encode_with_options(frame, &options)
                    .map_err(|error| encoder_failure_from_js(&error))
            });
        frame.close();
        encoded
    }

    async fn wait_for_dequeue_or_failure(&self) -> Result<(), EncoderFailureV1> {
        let waiter_shared = Rc::clone(&self.shared);
        let waiter = js_sys::Promise::new(&mut |resolve, _reject| {
            waiter_shared.borrow_mut().waiters.push(resolve);
        });
        // Re-check after installing the waiter: a dequeue that fired between
        // the caller's queue-size read and the installation must not stall.
        if self.encoder.encode_queue_size() <= MAX_ENCODE_QUEUE_DEPTH_V1 {
            wake_dequeue_waiters(&self.shared);
        }
        match await_with_timeout(waiter, EXPORT_ENCODER_WAIT_TIMEOUT_MILLISECONDS_V1).await? {
            BoundedWaitOutcomeV1::Completed(_) => Ok(()),
            BoundedWaitOutcomeV1::TimedOut => Err(EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::Timeout,
                "the encoder produced no dequeue event within the bounded wait",
            )),
        }
    }

    /// Applies dequeue-driven backpressure: awaits while the encoder queue is
    /// deeper than the declared bound. Frames are never dropped.
    async fn await_backpressure(&self) -> Result<(), EncoderFailureV1> {
        while self.encoder.encode_queue_size() > MAX_ENCODE_QUEUE_DEPTH_V1 {
            if let Some(failure) = read_encoder_failure(&self.shared) {
                return Err(failure);
            }
            self.wait_for_dequeue_or_failure().await?;
        }
        if let Some(failure) = read_encoder_failure(&self.shared) {
            return Err(failure);
        }
        Ok(())
    }

    async fn flush_bounded(&self, timeout_milliseconds: f64) -> Result<(), EncoderFailureV1> {
        let flush = self
            .encoder
            .flush()
            .map_err(|error| self.prefer_shared_failure(encoder_failure_from_js(&error)))?;
        match await_with_timeout(flush, timeout_milliseconds).await? {
            BoundedWaitOutcomeV1::Completed(Ok(_)) => Ok(()),
            BoundedWaitOutcomeV1::Completed(Err(error)) => {
                Err(self.prefer_shared_failure(encoder_failure_from_js(&error)))
            }
            BoundedWaitOutcomeV1::TimedOut => Err(EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::Timeout,
                "the encoder flush did not settle within the bounded wait",
            )),
        }
    }

    /// The asynchronous error callback carries the authoritative named reason;
    /// a rejected flush merely echoes it.
    fn prefer_shared_failure(&self, fallback: EncoderFailureV1) -> EncoderFailureV1 {
        read_encoder_failure(&self.shared).unwrap_or(fallback)
    }
}

enum BoundedWaitOutcomeV1 {
    Completed(Result<JsValue, JsValue>),
    TimedOut,
}

fn timeout_sentinel_promise(milliseconds: f64) -> Result<js_sys::Promise, EncoderFailureV1> {
    let global = js_sys::global();
    let set_timeout = js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout"))
        .ok()
        .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
        .ok_or_else(|| {
            EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::ApiUnavailable,
                "setTimeout is unavailable, so encoder waits cannot be bounded",
            )
        })?;
    let mut schedule_error = None;
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let resolve_with_sentinel =
            resolve.bind1(&JsValue::UNDEFINED, &JsValue::from_str(TIMEOUT_SENTINEL_V1));
        if let Err(error) = set_timeout.call2(
            &global,
            &resolve_with_sentinel,
            &JsValue::from_f64(milliseconds),
        ) {
            schedule_error = Some(error);
        }
    });
    if let Some(error) = schedule_error {
        return Err(EncoderFailureV1::new(
            ExportEncoderRefusalReasonV1::ApiUnavailable,
            format!("setTimeout failed: {}", js_error_message(&error)),
        ));
    }
    Ok(promise)
}

async fn await_with_timeout(
    promise: js_sys::Promise,
    timeout_milliseconds: f64,
) -> Result<BoundedWaitOutcomeV1, EncoderFailureV1> {
    let timeout = timeout_sentinel_promise(timeout_milliseconds)?;
    let race = js_sys::Promise::race(&js_sys::Array::of2(&promise, &timeout));
    Ok(match JsFuture::from(race).await {
        Ok(value) if value == JsValue::from_str(TIMEOUT_SENTINEL_V1) => {
            BoundedWaitOutcomeV1::TimedOut
        }
        outcome => BoundedWaitOutcomeV1::Completed(outcome),
    })
}

async fn require_config_supported(config: &js_sys::Object) -> Result<(), EncoderFailureV1> {
    let support_promise = VideoEncoder::is_config_supported(config).map_err(|error| {
        EncoderFailureV1::new(
            ExportEncoderRefusalReasonV1::UnsupportedCodec,
            format!("isConfigSupported rejected: {}", js_error_message(&error)),
        )
    })?;
    let support =
        match await_with_timeout(support_promise, EXPORT_ENCODER_WAIT_TIMEOUT_MILLISECONDS_V1)
            .await?
        {
            BoundedWaitOutcomeV1::Completed(Ok(support)) => support,
            BoundedWaitOutcomeV1::Completed(Err(error)) => {
                return Err(EncoderFailureV1::new(
                    ExportEncoderRefusalReasonV1::UnsupportedCodec,
                    format!("isConfigSupported rejected: {}", js_error_message(&error)),
                ));
            }
            BoundedWaitOutcomeV1::TimedOut => {
                return Err(EncoderFailureV1::new(
                    ExportEncoderRefusalReasonV1::Timeout,
                    "isConfigSupported did not settle within the bounded wait",
                ));
            }
        };
    // Anything other than an explicit `supported: true` is a refusal.
    if reflected_bool(&support, "supported") == Some(true) {
        Ok(())
    } else {
        Err(EncoderFailureV1::new(
            ExportEncoderRefusalReasonV1::UnsupportedCodec,
            "isConfigSupported did not report explicit support",
        ))
    }
}

fn solid_probe_frame_rgba(red: u8, green: u8, blue: u8) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(PROBE_FRAME_RGBA_BYTES_V1);
    for _ in 0..PROBE_FRAME_RGBA_BYTES_V1 / 4 {
        rgba.extend_from_slice(&[red, green, blue, 255]);
    }
    rgba
}

/// Proves one ladder codec with `isConfigSupported` plus a real two-frame
/// encode: both chunks must arrive, the first must be a key frame, and the
/// first chunk's metadata must carry `decoderConfig.description`.
async fn probe_single_codec(codec: &str) -> Result<(), EncoderFailureV1> {
    let config = build_encoder_config(
        codec,
        PROBE_FRAME_DIMENSION_PX_V1,
        PROBE_FRAME_DIMENSION_PX_V1,
        PROBE_BITRATE_V1,
        PROBE_FRAMES_PER_SECOND_V1,
    )?;
    require_config_supported(&config).await?;
    let harness = EncoderHarnessV1::create(&config)?;
    let probe_frames: [(f64, (u8, u8, u8)); PROBE_FRAME_COUNT_V1] = [
        (0.0, (255, 0, 0)),
        (PROBE_FRAME_DURATION_MICROSECONDS_V1, (0, 255, 0)),
    ];
    for (timestamp, (red, green, blue)) in probe_frames {
        let mut rgba = solid_probe_frame_rgba(red, green, blue);
        let frame = rgba_video_frame(
            &mut rgba,
            PROBE_FRAME_DIMENSION_PX_V1,
            PROBE_FRAME_DIMENSION_PX_V1,
            timestamp,
            PROBE_FRAME_DURATION_MICROSECONDS_V1,
        )?;
        harness.encode_and_close_frame(&frame, timestamp == 0.0)?;
    }
    harness
        .flush_bounded(EXPORT_ENCODER_WAIT_TIMEOUT_MILLISECONDS_V1)
        .await?;
    if let Some(failure) = read_encoder_failure(&harness.shared) {
        return Err(failure);
    }
    let state = harness.shared.borrow();
    if state.chunks.len() != PROBE_FRAME_COUNT_V1 {
        return Err(EncoderFailureV1::new(
            ExportEncoderRefusalReasonV1::NoChunk,
            format!(
                "expected {PROBE_FRAME_COUNT_V1} probe chunks, observed {}",
                state.chunks.len()
            ),
        ));
    }
    if !state.chunks[0].key_frame {
        return Err(EncoderFailureV1::new(
            ExportEncoderRefusalReasonV1::NoKeyFrame,
            "the first probe chunk was not a key frame",
        ));
    }
    if state.decoder_config.is_none() {
        return Err(EncoderFailureV1::new(
            ExportEncoderRefusalReasonV1::NoDecoderConfig,
            "the probe chunks carried no decoderConfig.description",
        ));
    }
    Ok(())
}

async fn probe_h264_ladder() -> ExportEncoderResultV1 {
    if !video_encoder_constructor_available() {
        return export_encoder_refusal_result(
            ExportEncoderRefusalReasonV1::ApiUnavailable,
            "VideoEncoder is unavailable in this scope",
        );
    }
    let mut last_reason = ExportEncoderRefusalReasonV1::UnsupportedCodec;
    let mut attempts = Vec::with_capacity(H264_CODEC_LADDER_V1.len());
    for codec in H264_CODEC_LADDER_V1 {
        match probe_single_codec(codec).await {
            Ok(()) => {
                return ExportEncoderResultV1::Supported {
                    codec: codec.to_owned(),
                };
            }
            Err(failure) => {
                attempts.push(format!(
                    "{codec}: {} ({})",
                    failure.message,
                    failure.reason.wire_name()
                ));
                last_reason = failure.reason;
            }
        }
    }
    export_encoder_refusal_result(last_reason, &attempts.join("; "))
}

/// Probes the closed H.264 ladder fail-closed and reports either the exact
/// codec string that passed the full two-frame proof or one named refusal.
///
/// The response is bounded JSON in the `poietra.export-encoder-response`
/// schema; this function never rejects.
#[wasm_bindgen(js_name = probeExportEncoderH264V1)]
pub async fn probe_export_encoder_h264_v1() -> Vec<u8> {
    export_encoder_response(probe_h264_ladder().await)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExportEncoderSessionStateV1 {
    Encoding,
    Failed,
    Finished,
}

/// One bounded H.264 export encode session owned by a browser worker.
///
/// The caller supplies tight RGBA frames with explicit microsecond
/// timestamps; the session owns colour tagging, key-frame cadence,
/// dequeue-driven backpressure, chunk collection, and first-chunk
/// `decoderConfig` evidence. Push and finish calls must be awaited
/// sequentially. On any failure the session reports one named refusal,
/// discards every collected chunk, and accepts nothing further.
#[wasm_bindgen]
pub struct PoietraExportEncoderSessionV1 {
    config: ExportEncoderSessionConfigV1,
    failure: Option<EncoderFailureV1>,
    frame_count: u64,
    harness: EncoderHarnessV1,
    last_key_frame_timestamp_microseconds: Option<f64>,
    last_timestamp_microseconds: Option<f64>,
    state: ExportEncoderSessionStateV1,
}

impl fmt::Debug for PoietraExportEncoderSessionV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PoietraExportEncoderSessionV1")
            .field("config", &self.config)
            .field("frame_count", &self.frame_count)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

#[wasm_bindgen]
impl PoietraExportEncoderSessionV1 {
    /// Validates one bounded session request, requires explicit
    /// `isConfigSupported` approval, and configures a dedicated encoder.
    ///
    /// # Errors
    ///
    /// Rejects with a JavaScript `Error` named `PoietraExportEncoderRefused`
    /// whose message starts with the stable refusal wire name.
    #[wasm_bindgen(js_name = create)]
    pub async fn create(request_json: &[u8]) -> Result<PoietraExportEncoderSessionV1, JsValue> {
        let config = parse_export_encoder_session_request_v1(request_json).map_err(|error| {
            refused_js_error(ExportEncoderRefusalReasonV1::InvalidRequest, &error)
        })?;
        if !video_encoder_constructor_available() {
            return Err(refused_js_error(
                ExportEncoderRefusalReasonV1::ApiUnavailable,
                "VideoEncoder is unavailable in this scope",
            ));
        }
        let encoder_config = build_encoder_config(
            &config.codec,
            config.width_px,
            config.height_px,
            config.bitrate,
            config.frames_per_second,
        )
        .map_err(|failure| refused_js_error(failure.reason, &failure.message))?;
        require_config_supported(&encoder_config)
            .await
            .map_err(|failure| refused_js_error(failure.reason, &failure.message))?;
        let harness = EncoderHarnessV1::create(&encoder_config)
            .map_err(|failure| refused_js_error(failure.reason, &failure.message))?;
        Ok(Self {
            config,
            failure: None,
            frame_count: 0,
            harness,
            last_key_frame_timestamp_microseconds: None,
            last_timestamp_microseconds: None,
            state: ExportEncoderSessionStateV1::Encoding,
        })
    }

    /// Encodes one tight RGBA frame at the supplied microsecond timestamp.
    ///
    /// Applies the 2-second key-frame cadence, closes the `VideoFrame`
    /// immediately after submission, and awaits dequeue events while the
    /// encoder queue is deeper than the declared bound. The bounded JSON
    /// response reports acceptance or one named refusal.
    #[wasm_bindgen(js_name = pushFrame)]
    pub async fn push_frame(&mut self, mut rgba: Vec<u8>, timestamp_microseconds: f64) -> Vec<u8> {
        if let Some(refusal) = self.reject_unless_encoding() {
            return refusal;
        }
        if let Some(failure) = read_encoder_failure(&self.harness.shared) {
            return self.fail_session(failure);
        }
        if Some(rgba.len()) != self.config.tight_rgba_byte_length() {
            return self.fail_session(EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::InvalidFrame,
                format!(
                    "the frame buffer holds {} bytes instead of the tight RGBA length for {}x{}",
                    rgba.len(),
                    self.config.width_px,
                    self.config.height_px
                ),
            ));
        }
        if !timestamp_microseconds.is_finite()
            || timestamp_microseconds < 0.0
            || self
                .last_timestamp_microseconds
                .is_some_and(|last| timestamp_microseconds <= last)
        {
            return self.fail_session(EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::InvalidFrame,
                "frame timestamps must be finite, non-negative and strictly increasing",
            ));
        }
        let key_frame = key_frame_required_v1(
            self.last_key_frame_timestamp_microseconds,
            timestamp_microseconds,
        );
        let frame = match rgba_video_frame(
            &mut rgba,
            self.config.width_px,
            self.config.height_px,
            timestamp_microseconds,
            self.config.frame_duration_microseconds(),
        ) {
            Ok(frame) => frame,
            Err(failure) => return self.fail_session(failure),
        };
        if let Err(failure) = self.harness.encode_and_close_frame(&frame, key_frame) {
            return self.fail_session(self.harness.prefer_shared_failure(failure));
        }
        let frame_index = self.frame_count;
        self.frame_count += 1;
        self.last_timestamp_microseconds = Some(timestamp_microseconds);
        if key_frame {
            self.last_key_frame_timestamp_microseconds = Some(timestamp_microseconds);
        }
        if let Err(failure) = self.harness.await_backpressure().await {
            return self.fail_session(failure);
        }
        export_encoder_response(ExportEncoderResultV1::Accepted {
            frame_index,
            key_frame,
        })
    }

    /// Flushes the encoder and settles the session.
    ///
    /// Success requires exactly one chunk per pushed frame, a leading key
    /// frame, and first-chunk `decoderConfig.description` evidence; anything
    /// else discards all output and reports one named refusal.
    #[wasm_bindgen(js_name = finish)]
    pub async fn finish(&mut self) -> Vec<u8> {
        if let Some(refusal) = self.reject_unless_encoding() {
            return refusal;
        }
        if self.frame_count == 0 {
            return self.fail_session(EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::NoChunk,
                "no frames were pushed before finish",
            ));
        }
        if let Err(failure) = self
            .harness
            .flush_bounded(EXPORT_ENCODER_FLUSH_TIMEOUT_MILLISECONDS_V1)
            .await
        {
            return self.fail_session(failure);
        }
        if let Some(failure) = read_encoder_failure(&self.harness.shared) {
            return self.fail_session(failure);
        }
        let evidence = {
            let state = self.harness.shared.borrow();
            if state.chunks.len() as u64 != self.frame_count {
                Err(EncoderFailureV1::new(
                    ExportEncoderRefusalReasonV1::NoChunk,
                    format!(
                        "expected {} chunks after flush, observed {}",
                        self.frame_count,
                        state.chunks.len()
                    ),
                ))
            } else if !state.chunks[0].key_frame {
                Err(EncoderFailureV1::new(
                    ExportEncoderRefusalReasonV1::NoKeyFrame,
                    "the first encoded chunk was not a key frame",
                ))
            } else {
                match &state.decoder_config {
                    None => Err(EncoderFailureV1::new(
                        ExportEncoderRefusalReasonV1::NoDecoderConfig,
                        "no chunk metadata carried decoderConfig.description",
                    )),
                    Some(decoder_config) => {
                        let key_frame_count =
                            state.chunks.iter().filter(|chunk| chunk.key_frame).count();
                        Ok(ExportEncoderResultV1::Finished {
                            chunk_count: u32::try_from(state.chunks.len()).unwrap_or(u32::MAX),
                            decoder_config: ExportEncoderDecoderConfigEvidenceV1 {
                                color_space: decoder_config.color_space.clone(),
                                description_byte_length: u32::try_from(
                                    decoder_config.description.len(),
                                )
                                .unwrap_or(u32::MAX),
                            },
                            key_frame_count: u32::try_from(key_frame_count).unwrap_or(u32::MAX),
                            total_byte_length: state.total_chunk_bytes,
                        })
                    }
                }
            }
        };
        match evidence {
            Ok(result) => {
                self.harness.close_quietly();
                self.state = ExportEncoderSessionStateV1::Finished;
                export_encoder_response(result)
            }
            Err(failure) => self.fail_session(failure),
        }
    }

    /// Returns bounded JSON metadata for one retained chunk of a finished
    /// session; the chunk bytes travel separately via [`Self::chunk_bytes`].
    #[must_use]
    #[wasm_bindgen(js_name = chunkStatus)]
    pub fn chunk_status(&self, index: u32) -> Vec<u8> {
        match self.require_finished_chunk(index) {
            Ok(()) => {
                let state = self.harness.shared.borrow();
                let chunk = &state.chunks[index as usize];
                export_encoder_response(ExportEncoderResultV1::Chunk {
                    byte_length: u32::try_from(chunk.bytes.len()).unwrap_or(u32::MAX),
                    duration_microseconds: chunk.duration_microseconds,
                    index,
                    key_frame: chunk.key_frame,
                    timestamp_microseconds: chunk.timestamp_microseconds,
                })
            }
            Err(failure) => export_encoder_response(failure.refusal_result()),
        }
    }

    /// Returns one retained chunk's encoded bytes as a fresh `Uint8Array`.
    /// Chunk bytes never travel through the bounded JSON responses.
    ///
    /// # Errors
    ///
    /// Rejects with a `PoietraExportEncoderRefused` error when the session
    /// has not finished successfully or the index is out of range.
    #[wasm_bindgen(js_name = chunkBytes)]
    pub fn chunk_bytes(&self, index: u32) -> Result<js_sys::Uint8Array, JsValue> {
        self.require_finished_chunk(index)
            .map_err(|failure| refused_js_error(failure.reason, &failure.message))?;
        let state = self.harness.shared.borrow();
        Ok(js_sys::Uint8Array::from(
            state.chunks[index as usize].bytes.as_slice(),
        ))
    }

    /// Returns the first chunk's `decoderConfig.description` bytes (the avcC
    /// record) as a fresh `Uint8Array`.
    ///
    /// # Errors
    ///
    /// Rejects with a `PoietraExportEncoderRefused` error when the session
    /// has not finished successfully.
    #[wasm_bindgen(js_name = descriptionBytes)]
    pub fn description_bytes(&self) -> Result<js_sys::Uint8Array, JsValue> {
        self.require_finished()
            .map_err(|failure| refused_js_error(failure.reason, &failure.message))?;
        let state = self.harness.shared.borrow();
        let description = state
            .decoder_config
            .as_ref()
            .map(|decoder_config| decoder_config.description.as_slice())
            .ok_or_else(|| {
                refused_js_error(
                    ExportEncoderRefusalReasonV1::NoDecoderConfig,
                    "the finished session retained no decoderConfig.description",
                )
            })?;
        Ok(js_sys::Uint8Array::from(description))
    }
}

impl PoietraExportEncoderSessionV1 {
    /// Non-encoding states answer every mutation with a named refusal: the
    /// original failure is echoed verbatim, a finished session is closed.
    fn reject_unless_encoding(&self) -> Option<Vec<u8>> {
        match self.state {
            ExportEncoderSessionStateV1::Encoding => None,
            ExportEncoderSessionStateV1::Failed => {
                let failure = self.failure.clone().unwrap_or_else(|| {
                    EncoderFailureV1::new(
                        ExportEncoderRefusalReasonV1::SessionClosed,
                        "the session already failed",
                    )
                });
                Some(export_encoder_response(failure.refusal_result()))
            }
            ExportEncoderSessionStateV1::Finished => {
                Some(export_encoder_response(export_encoder_refusal_result(
                    ExportEncoderRefusalReasonV1::SessionClosed,
                    "the session already finished",
                )))
            }
        }
    }

    /// Fails closed: records the first failure, discards every collected
    /// chunk so nothing partial can be observed, and closes the encoder.
    fn fail_session(&mut self, failure: EncoderFailureV1) -> Vec<u8> {
        let refusal = failure.refusal_result();
        if self.failure.is_none() {
            self.failure = Some(failure);
        }
        self.state = ExportEncoderSessionStateV1::Failed;
        {
            let mut state = self.harness.shared.borrow_mut();
            state.chunks.clear();
            state.decoder_config = None;
            state.total_chunk_bytes = 0;
        }
        self.harness.close_quietly();
        export_encoder_response(refusal)
    }

    fn require_finished(&self) -> Result<(), EncoderFailureV1> {
        match self.state {
            ExportEncoderSessionStateV1::Finished => Ok(()),
            ExportEncoderSessionStateV1::Failed => Err(self.failure.clone().unwrap_or_else(|| {
                EncoderFailureV1::new(
                    ExportEncoderRefusalReasonV1::SessionClosed,
                    "the session already failed",
                )
            })),
            ExportEncoderSessionStateV1::Encoding => Err(EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::InvalidRequest,
                "chunks are only readable after a successful finish",
            )),
        }
    }

    fn require_finished_chunk(&self, index: u32) -> Result<(), EncoderFailureV1> {
        self.require_finished()?;
        let chunk_count = self.harness.shared.borrow().chunks.len();
        if (index as usize) < chunk_count {
            Ok(())
        } else {
            Err(EncoderFailureV1::new(
                ExportEncoderRefusalReasonV1::InvalidRequest,
                format!("chunk index {index} is outside the {chunk_count} retained chunks"),
            ))
        }
    }
}
