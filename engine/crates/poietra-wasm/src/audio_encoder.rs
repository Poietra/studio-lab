//! Minimal `WebCodecs` Opus encoder used by WAV-bearing local exports.

use std::cell::RefCell;
use std::num::NonZeroU32;
use std::rc::Rc;

use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::audio_encoder_protocol::AudioEncoderRefusal;
use crate::audio_wav::PreparedPcm;

const AUDIO_SAMPLE_RATE_HZ: u32 = 48_000;
const AUDIO_BITRATE: u32 = 128_000;
const AUDIO_PACKET_DURATION_MICROSECONDS: u64 = 20_000;
const MAX_AUDIO_QUEUE_DEPTH: u32 = 8;
const MAX_AUDIO_CHUNKS: usize = 65_536;
const MAX_EXACT_JAVASCRIPT_INTEGER: f64 = 9_007_199_254_740_991.0;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = AudioEncoder)]
    type AudioEncoder;

    #[wasm_bindgen(catch, constructor, js_class = "AudioEncoder")]
    fn new(init: &js_sys::Object) -> Result<AudioEncoder, JsValue>;

    #[wasm_bindgen(catch, static_method_of = AudioEncoder, js_name = isConfigSupported)]
    fn is_config_supported(config: &js_sys::Object) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(catch, method, js_class = "AudioEncoder")]
    fn configure(this: &AudioEncoder, config: &js_sys::Object) -> Result<(), JsValue>;

    #[wasm_bindgen(catch, method, js_class = "AudioEncoder")]
    fn encode(this: &AudioEncoder, data: &AudioData) -> Result<(), JsValue>;

    #[wasm_bindgen(catch, method, js_class = "AudioEncoder")]
    fn flush(this: &AudioEncoder) -> Result<js_sys::Promise, JsValue>;

    #[wasm_bindgen(catch, method, js_class = "AudioEncoder")]
    fn close(this: &AudioEncoder) -> Result<(), JsValue>;

    #[wasm_bindgen(method, getter, js_class = "AudioEncoder", js_name = encodeQueueSize)]
    fn encode_queue_size(this: &AudioEncoder) -> u32;

    #[wasm_bindgen(method, setter, js_class = "AudioEncoder", js_name = ondequeue)]
    fn set_ondequeue(this: &AudioEncoder, handler: &js_sys::Function);

    #[wasm_bindgen(js_name = AudioData)]
    type AudioData;

    #[wasm_bindgen(catch, constructor, js_class = "AudioData")]
    fn new(init: &js_sys::Object) -> Result<AudioData, JsValue>;

    #[wasm_bindgen(method, js_class = "AudioData")]
    fn close(this: &AudioData);

    #[wasm_bindgen(js_name = EncodedAudioChunk)]
    type EncodedAudioChunk;

    #[wasm_bindgen(method, getter, js_class = "EncodedAudioChunk", js_name = byteLength)]
    fn byte_length(this: &EncodedAudioChunk) -> f64;

    #[wasm_bindgen(method, getter, js_class = "EncodedAudioChunk")]
    fn timestamp(this: &EncodedAudioChunk) -> f64;

    #[wasm_bindgen(method, getter, js_class = "EncodedAudioChunk")]
    fn duration(this: &EncodedAudioChunk) -> Option<f64>;

    #[wasm_bindgen(catch, method, js_class = "EncodedAudioChunk", js_name = copyTo)]
    fn copy_to(this: &EncodedAudioChunk, destination: &js_sys::Uint8Array) -> Result<(), JsValue>;
}

#[derive(Clone, Debug)]
pub(crate) struct AudioEncodeFailure {
    pub(crate) message: String,
    pub(crate) reason: AudioEncoderRefusal,
}

impl AudioEncodeFailure {
    fn new(reason: AudioEncoderRefusal, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reason,
        }
    }
}

#[derive(Debug)]
pub(crate) struct EncodedOpusChunk {
    pub(crate) bytes: Vec<u8>,
    pub(crate) duration_samples: NonZeroU32,
}

#[derive(Debug)]
pub(crate) struct FinishedOpusOutput {
    pub(crate) channel_mapping_family: u8,
    pub(crate) channels: u8,
    pub(crate) chunks: Vec<EncodedOpusChunk>,
    pub(crate) output_gain: i16,
    pub(crate) pre_skip: u16,
}

#[derive(Debug)]
struct OpusHead {
    channel_mapping_family: u8,
    channels: u8,
    output_gain: i16,
    pre_skip: u16,
}

#[derive(Debug, Default)]
struct SharedState {
    chunks: Vec<EncodedOpusChunk>,
    decoder_description: Option<Vec<u8>>,
    failure: Option<AudioEncodeFailure>,
    total_bytes: u64,
    waiters: Vec<js_sys::Function>,
}

type Shared = Rc<RefCell<SharedState>>;

fn exact_unsigned_integer(value: f64) -> Option<u64> {
    if !value.is_finite()
        || value < 0.0
        || value.fract() != 0.0
        || value > MAX_EXACT_JAVASCRIPT_INTEGER
    {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(value as u64)
}

fn reflected_string(value: &JsValue, property: &str) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str(property))
        .ok()
        .and_then(|value| value.as_string())
}

fn js_error_message(error: &JsValue) -> String {
    let name = reflected_string(error, "name")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Error".to_owned());
    let message = reflected_string(error, "message")
        .or_else(|| error.as_string())
        .unwrap_or_else(|| "WebCodecs audio operation failed".to_owned());
    format!("{name}: {message}")
}

fn set_property(
    object: &js_sys::Object,
    property: &str,
    value: &JsValue,
) -> Result<(), AudioEncodeFailure> {
    match js_sys::Reflect::set(object, &JsValue::from_str(property), value) {
        Ok(true) => Ok(()),
        Ok(false) => Err(AudioEncodeFailure::new(
            AudioEncoderRefusal::EncoderError,
            format!("could not assign AudioEncoder {property}"),
        )),
        Err(error) => Err(AudioEncodeFailure::new(
            AudioEncoderRefusal::EncoderError,
            js_error_message(&error),
        )),
    }
}

fn constructor_available(name: &str) -> bool {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str(name))
        .ok()
        .is_some_and(|value| value.is_function())
}

fn build_config(channels: u8) -> Result<js_sys::Object, AudioEncodeFailure> {
    let config = js_sys::Object::new();
    set_property(&config, "codec", &JsValue::from_str("opus"))?;
    set_property(
        &config,
        "sampleRate",
        &JsValue::from_f64(f64::from(AUDIO_SAMPLE_RATE_HZ)),
    )?;
    set_property(
        &config,
        "numberOfChannels",
        &JsValue::from_f64(f64::from(channels)),
    )?;
    set_property(
        &config,
        "bitrate",
        &JsValue::from_f64(f64::from(AUDIO_BITRATE)),
    )?;
    Ok(config)
}

fn buffer_source_to_vec(value: &JsValue) -> Option<Vec<u8>> {
    if let Some(buffer) = value.dyn_ref::<js_sys::ArrayBuffer>() {
        return Some(js_sys::Uint8Array::new(buffer).to_vec());
    }
    let buffer = js_sys::Reflect::get(value, &JsValue::from_str("buffer"))
        .ok()?
        .dyn_into::<js_sys::ArrayBuffer>()
        .ok()?;
    let offset = exact_unsigned_integer(
        js_sys::Reflect::get(value, &JsValue::from_str("byteOffset"))
            .ok()?
            .as_f64()?,
    )?;
    let length = exact_unsigned_integer(
        js_sys::Reflect::get(value, &JsValue::from_str("byteLength"))
            .ok()?
            .as_f64()?,
    )?;
    Some(
        js_sys::Uint8Array::new_with_byte_offset_and_length(
            &buffer,
            u32::try_from(offset).ok()?,
            u32::try_from(length).ok()?,
        )
        .to_vec(),
    )
}

fn decoder_description(metadata: &JsValue) -> Option<Vec<u8>> {
    let decoder_config = js_sys::Reflect::get(metadata, &JsValue::from_str("decoderConfig"))
        .ok()
        .filter(JsValue::is_object)?;
    let description =
        js_sys::Reflect::get(&decoder_config, &JsValue::from_str("description")).ok()?;
    buffer_source_to_vec(&description).filter(|bytes| !bytes.is_empty())
}

fn fail(shared: &Shared, failure: AudioEncodeFailure) {
    let waiters = {
        let mut state = shared.borrow_mut();
        if state.failure.is_none() {
            state.failure = Some(failure);
        }
        std::mem::take(&mut state.waiters)
    };
    for resolve in waiters {
        let _ = resolve.call0(&JsValue::UNDEFINED);
    }
}

fn wake_waiters(shared: &Shared) {
    let waiters = std::mem::take(&mut shared.borrow_mut().waiters);
    for resolve in waiters {
        let _ = resolve.call0(&JsValue::UNDEFINED);
    }
}

fn duration_samples(duration_microseconds: u64) -> Option<NonZeroU32> {
    let numerator = duration_microseconds.checked_mul(u64::from(AUDIO_SAMPLE_RATE_HZ))?;
    if numerator % 1_000_000 != 0 {
        return None;
    }
    u32::try_from(numerator / 1_000_000)
        .ok()
        .and_then(NonZeroU32::new)
}

fn timestamp_matches_packet_index(timestamp: u64, packet_index: usize) -> bool {
    u64::try_from(packet_index)
        .ok()
        .and_then(|index| index.checked_mul(AUDIO_PACKET_DURATION_MICROSECONDS))
        .is_some_and(|expected| timestamp.abs_diff(expected) <= 1)
}

#[allow(
    clippy::too_many_lines,
    reason = "the output callback validates and records one complete encoded chunk"
)]
fn record_output(shared: &Shared, chunk: &JsValue, metadata: &JsValue) {
    if shared.borrow().failure.is_some() {
        return;
    }
    let chunk: &EncodedAudioChunk = chunk.unchecked_ref();
    let Some(byte_length) = exact_unsigned_integer(chunk.byte_length()) else {
        fail(
            shared,
            AudioEncodeFailure::new(
                AudioEncoderRefusal::EncoderError,
                "an Opus chunk reported an invalid byte length",
            ),
        );
        return;
    };
    let Some(timestamp) = exact_unsigned_integer(chunk.timestamp()) else {
        fail(
            shared,
            AudioEncodeFailure::new(
                AudioEncoderRefusal::EncoderError,
                "an Opus chunk reported an invalid timestamp",
            ),
        );
        return;
    };
    let Some(duration_microseconds) = chunk.duration().and_then(exact_unsigned_integer) else {
        fail(
            shared,
            AudioEncodeFailure::new(
                AudioEncoderRefusal::EncoderError,
                "an Opus chunk reported an invalid duration",
            ),
        );
        return;
    };
    let Some(duration_samples) = duration_samples(duration_microseconds) else {
        fail(
            shared,
            AudioEncodeFailure::new(
                AudioEncoderRefusal::EncoderError,
                "an Opus chunk duration is not representable at 48 kHz",
            ),
        );
        return;
    };
    {
        let state = shared.borrow();
        if !timestamp_matches_packet_index(timestamp, state.chunks.len()) {
            drop(state);
            fail(
                shared,
                AudioEncodeFailure::new(
                    AudioEncoderRefusal::InvalidTimestamp,
                    "Opus chunk timestamps are not on the 20 ms packet grid",
                ),
            );
            return;
        }
        if state.chunks.len() >= MAX_AUDIO_CHUNKS
            || state
                .total_bytes
                .checked_add(byte_length)
                .is_none_or(|total| total > poietra_scene_ir::MAX_EXPORT_OUTPUT_BYTES_V1)
        {
            drop(state);
            fail(
                shared,
                AudioEncodeFailure::new(
                    AudioEncoderRefusal::OutputLimitExceeded,
                    "the encoded Opus output exceeded the browser export bound",
                ),
            );
            return;
        }
    }
    let Ok(destination_length) = u32::try_from(byte_length) else {
        fail(
            shared,
            AudioEncodeFailure::new(
                AudioEncoderRefusal::OutputLimitExceeded,
                "an Opus chunk is too large to copy",
            ),
        );
        return;
    };
    let destination = js_sys::Uint8Array::new_with_length(destination_length);
    if let Err(error) = chunk.copy_to(&destination) {
        fail(
            shared,
            AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&error)),
        );
        return;
    }
    let mut state = shared.borrow_mut();
    if state.decoder_description.is_none() {
        state.decoder_description = decoder_description(metadata);
    }
    state.total_bytes += byte_length;
    state.chunks.push(EncodedOpusChunk {
        bytes: destination.to_vec(),
        duration_samples,
    });
}

fn parse_opus_head(description: &[u8], channels: u8) -> Result<OpusHead, AudioEncodeFailure> {
    if description.len() != 19 || &description[..8] != b"OpusHead" {
        return Err(AudioEncodeFailure::new(
            AudioEncoderRefusal::MuxFailed,
            "AudioEncoder returned no canonical mapping-family-zero OpusHead",
        ));
    }
    let input_sample_rate = u32::from_le_bytes([
        description[12],
        description[13],
        description[14],
        description[15],
    ]);
    if description[8] != 1
        || description[9] != channels
        || input_sample_rate != AUDIO_SAMPLE_RATE_HZ
        || description[18] != 0
    {
        return Err(AudioEncodeFailure::new(
            AudioEncoderRefusal::MuxFailed,
            "AudioEncoder returned an incompatible OpusHead",
        ));
    }
    Ok(OpusHead {
        channels,
        pre_skip: u16::from_le_bytes([description[10], description[11]]),
        output_gain: i16::from_le_bytes([description[16], description[17]]),
        channel_mapping_family: description[18],
    })
}

fn audio_data(
    bytes: &[u8],
    channels: u8,
    sample_frames: u32,
    first_sample: u64,
) -> Result<AudioData, AudioEncodeFailure> {
    let timestamp_numerator = first_sample.checked_mul(1_000_000).ok_or_else(|| {
        AudioEncodeFailure::new(
            AudioEncoderRefusal::InvalidTimestamp,
            "timestamp overflowed",
        )
    })?;
    if timestamp_numerator % u64::from(AUDIO_SAMPLE_RATE_HZ) != 0 {
        return Err(AudioEncodeFailure::new(
            AudioEncoderRefusal::InvalidTimestamp,
            "an audio chunk timestamp is not an exact integer microsecond",
        ));
    }
    let timestamp = timestamp_numerator / u64::from(AUDIO_SAMPLE_RATE_HZ);
    #[allow(clippy::cast_precision_loss)]
    let timestamp = timestamp as f64;
    let data = js_sys::Uint8Array::from(bytes);
    let init = js_sys::Object::new();
    set_property(&init, "format", &JsValue::from_str("s16"))?;
    set_property(
        &init,
        "sampleRate",
        &JsValue::from_f64(f64::from(AUDIO_SAMPLE_RATE_HZ)),
    )?;
    set_property(
        &init,
        "numberOfFrames",
        &JsValue::from_f64(f64::from(sample_frames)),
    )?;
    set_property(
        &init,
        "numberOfChannels",
        &JsValue::from_f64(f64::from(channels)),
    )?;
    set_property(&init, "timestamp", &JsValue::from_f64(timestamp))?;
    set_property(&init, "data", &data)?;
    AudioData::new(&init).map_err(|error| {
        AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&error))
    })
}

async fn wait_for_capacity(
    encoder: &AudioEncoder,
    shared: &Shared,
) -> Result<(), AudioEncodeFailure> {
    while encoder.encode_queue_size() >= MAX_AUDIO_QUEUE_DEPTH {
        if let Some(failure) = shared.borrow().failure.clone() {
            return Err(failure);
        }
        let waiter_shared = Rc::clone(shared);
        let waiter = js_sys::Promise::new(&mut |resolve, _reject| {
            waiter_shared.borrow_mut().waiters.push(resolve);
        });
        if encoder.encode_queue_size() < MAX_AUDIO_QUEUE_DEPTH {
            wake_waiters(shared);
        }
        JsFuture::from(waiter).await.map_err(|error| {
            AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&error))
        })?;
    }
    shared.borrow().failure.clone().map_or(Ok(()), Err)
}

/// Encodes one already-fitted 48 kHz PCM timeline into Opus chunks and the
/// exact `OpusHead` required by the MP4 muxer.
#[allow(
    clippy::too_many_lines,
    reason = "the browser encoder lifecycle remains linear and always closes before callbacks drop"
)]
pub(crate) async fn encode_opus(
    pcm: &PreparedPcm,
) -> Result<FinishedOpusOutput, AudioEncodeFailure> {
    if !constructor_available("AudioEncoder") || !constructor_available("AudioData") {
        return Err(AudioEncodeFailure::new(
            AudioEncoderRefusal::ApiUnavailable,
            "AudioEncoder or AudioData is unavailable in this worker",
        ));
    }
    let config = build_config(pcm.channels())?;
    let support_promise = AudioEncoder::is_config_supported(&config).map_err(|error| {
        AudioEncodeFailure::new(
            AudioEncoderRefusal::UnsupportedCodec,
            js_error_message(&error),
        )
    })?;
    let support = JsFuture::from(support_promise).await.map_err(|error| {
        AudioEncodeFailure::new(
            AudioEncoderRefusal::UnsupportedCodec,
            js_error_message(&error),
        )
    })?;
    let supported = js_sys::Reflect::get(&support, &JsValue::from_str("supported"))
        .ok()
        .and_then(|value| value.as_bool());
    if supported != Some(true) {
        return Err(AudioEncodeFailure::new(
            AudioEncoderRefusal::UnsupportedCodec,
            "AudioEncoder does not support Opus at 48 kHz for this channel count",
        ));
    }

    let shared = Rc::new(RefCell::new(SharedState::default()));
    let output_shared = Rc::clone(&shared);
    let output = Closure::wrap(Box::new(move |chunk: JsValue, metadata: JsValue| {
        record_output(&output_shared, &chunk, &metadata);
    }) as Box<dyn FnMut(JsValue, JsValue)>);
    let error_shared = Rc::clone(&shared);
    let error = Closure::wrap(Box::new(move |value: JsValue| {
        fail(
            &error_shared,
            AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&value)),
        );
    }) as Box<dyn FnMut(JsValue)>);
    let dequeue_shared = Rc::clone(&shared);
    let dequeue = Closure::wrap(Box::new(move |_event: JsValue| {
        wake_waiters(&dequeue_shared);
    }) as Box<dyn FnMut(JsValue)>);
    let init = js_sys::Object::new();
    set_property(&init, "output", output.as_ref())?;
    set_property(&init, "error", error.as_ref())?;
    let encoder = AudioEncoder::new(&init).map_err(|value| {
        AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&value))
    })?;
    encoder.set_ondequeue(dequeue.as_ref().unchecked_ref());
    let result = async {
        encoder.configure(&config).map_err(|value| {
            AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&value))
        })?;
        for chunk in pcm.chunks() {
            wait_for_capacity(&encoder, &shared).await?;
            let data = audio_data(
                &chunk.bytes,
                pcm.channels(),
                chunk.sample_frames,
                chunk.first_sample,
            )?;
            let encode_result = encoder.encode(&data).map_err(|value| {
                AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&value))
            });
            data.close();
            encode_result?;
        }
        let flushed = encoder.flush().map_err(|value| {
            AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&value))
        })?;
        JsFuture::from(flushed).await.map_err(|value| {
            shared.borrow().failure.clone().unwrap_or_else(|| {
                AudioEncodeFailure::new(AudioEncoderRefusal::EncoderError, js_error_message(&value))
            })
        })?;
        if let Some(failure) = shared.borrow().failure.clone() {
            return Err(failure);
        }
        let mut state = shared.borrow_mut();
        if state.chunks.is_empty() {
            return Err(AudioEncodeFailure::new(
                AudioEncoderRefusal::EncoderError,
                "AudioEncoder emitted no Opus chunks",
            ));
        }
        let description = state.decoder_description.take().ok_or_else(|| {
            AudioEncodeFailure::new(
                AudioEncoderRefusal::MuxFailed,
                "AudioEncoder emitted no decoderConfig.description",
            )
        })?;
        let head = parse_opus_head(&description, pcm.channels())?;
        Ok(FinishedOpusOutput {
            channel_mapping_family: head.channel_mapping_family,
            channels: head.channels,
            chunks: std::mem::take(&mut state.chunks),
            output_gain: head.output_gain,
            pre_skip: head.pre_skip,
        })
    }
    .await;
    let _ = encoder.close();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mapping_family_zero_opus_head() {
        let mut description = b"OpusHead\x01\x02\x38\x01\x80\xbb\0\0\0\0\0".to_vec();
        description[16..18].copy_from_slice(&(-2_i16).to_le_bytes());
        let parsed = parse_opus_head(&description, 2).unwrap();
        assert_eq!(parsed.channels, 2);
        assert_eq!(parsed.pre_skip, 312);
        assert_eq!(parsed.output_gain, -2);
        assert_eq!(parsed.channel_mapping_family, 0);
    }

    #[test]
    fn rejects_incompatible_opus_head() {
        assert!(parse_opus_head(b"not opus", 1).is_err());
        let wrong_channels = b"OpusHead\x01\x02\x38\x01\x80\xbb\0\0\0\0\0";
        assert!(parse_opus_head(wrong_channels, 1).is_err());
    }

    #[test]
    fn converts_only_exact_positive_opus_durations() {
        assert_eq!(duration_samples(20_000), NonZeroU32::new(960));
        assert_eq!(duration_samples(2_500), NonZeroU32::new(120));
        assert_eq!(duration_samples(1), None);
        assert_eq!(duration_samples(0), None);
    }

    #[test]
    fn accepts_only_one_microsecond_of_encoder_timestamp_rounding() {
        assert!(timestamp_matches_packet_index(0, 0));
        assert!(timestamp_matches_packet_index(259_999, 13));
        assert!(timestamp_matches_packet_index(260_001, 13));
        assert!(!timestamp_matches_packet_index(259_998, 13));
        assert!(!timestamp_matches_packet_index(280_000, 13));
    }
}
