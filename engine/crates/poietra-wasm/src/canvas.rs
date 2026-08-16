use std::collections::BTreeSet;
use std::fmt;
use std::sync::{Arc, Mutex};

use poietra_render_wgpu::{
    PreparedFrameV1, PreparedGeometryCacheFrameStatsV1, PreparedGeometryCacheV1,
    WgpuPaintRendererV1, WgpuRenderTargetV1, prepare_frame_with_cache_and_assets_v1,
    tessellate_validated_frame_with_cache_and_assets_v1, validate_frame_packet_v1,
};
use poietra_scene_ir::{RenderDrawV1, ViewportV1, parse_scene_ir_bundle_json_v1};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{JsFuture, spawn_local};
use web_sys::OffscreenCanvas;

use crate::canvas_assets::{CanvasPngAssetRegistryV1, copy_asset_byte_arrays};
use crate::canvas_protocol::{
    CanvasRenderErrorCodeV1, error_response, error_result, gpu_error_code_from_js_class_name,
    interaction_metadata, presented_response_with_interaction, presented_result, sample_error_code,
    sample_error_response, surface_configuration_required,
};
use crate::canvas_telemetry::{
    AdapterEvidenceSourceV1, AdapterEvidenceV1, CLOCK_UNAVAILABLE_REASON_V1, CacheOutcomeV1,
    CanvasAdapterEvidenceV1, DeviceEvidenceV1, EngineMemoryCurrentV1, EngineMemoryHighWaterV1,
    FenceFailurePolicyV1, FenceObservationFailureV1, FenceObservationStepV1, FrameMemorySampleV1,
    FrameTelemetryV1, PhaseSampleV1, SurfaceEvidenceV1, TelemetryClockSourceV1,
    adapter_evidence_response, bounded_evidence_dump, bounded_evidence_string,
    classify_fence_observation_failure, fence_failure_policy,
    finalize_surface_configuration_evidence, normalized_duration_ms, stage_phase_sample,
    telemetry_response as serialize_telemetry_response,
};
use crate::protocol::EngineWorkerSessionV1;

const SNAPSHOT_REJECTED_ERROR_NAME: &str = "PoietraCanvasSnapshotRejected";
const RENDERER_UNAVAILABLE_ERROR_NAME: &str = "PoietraCanvasRendererUnavailable";
const MAX_EXACT_JAVASCRIPT_INTEGER_V1: f64 = 9_007_199_254_740_991.0;

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn wasm_linear_memory_bytes() -> Result<u64, String> {
    let memory = wasm_bindgen::memory()
        .dyn_into::<js_sys::WebAssembly::Memory>()
        .map_err(|_| "the WebAssembly linear memory export is unavailable".to_owned())?;
    // Create the property key before taking the buffer handle: creating a JS
    // string may grow linear memory and detach the previous ArrayBuffer view.
    let byte_length_key = JsValue::from_str("byteLength");
    let buffer = memory.buffer();
    let byte_length = js_sys::Reflect::get(&buffer, &byte_length_key)
        .map_err(|_| "the WebAssembly linear memory byte length is unavailable".to_owned())?
        .as_f64()
        .ok_or_else(|| "the WebAssembly linear memory byte length is not numeric".to_owned())?;
    if !byte_length.is_finite()
        || byte_length < 0.0
        || byte_length.fract() != 0.0
        || byte_length > MAX_EXACT_JAVASCRIPT_INTEGER_V1
    {
        return Err(
            "the WebAssembly linear memory byte length is not an exact JavaScript integer"
                .to_owned(),
        );
    }
    // The finite, non-negative, integral and JS-safe checks above make this
    // conversion exact; Rust has no checked f64-to-u64 conversion primitive.
    Ok(byte_length as u64)
}

fn prepared_geometry_cache_outcome(stats: PreparedGeometryCacheFrameStatsV1) -> CacheOutcomeV1 {
    if stats.misses() > 0 {
        CacheOutcomeV1::Miss
    } else if stats.hits() > 0 {
        CacheOutcomeV1::Hit
    } else {
        CacheOutcomeV1::Skipped
    }
}

fn image_texture_cache_outcome(
    stats: poietra_render_wgpu::ImageTextureCacheFrameStatsV1,
    has_images: bool,
) -> CacheOutcomeV1 {
    if !has_images {
        CacheOutcomeV1::Skipped
    } else if stats.texture_uploads() > 0 {
        CacheOutcomeV1::Miss
    } else {
        CacheOutcomeV1::Hit
    }
}

fn image_sampler_binding_cache_outcome(
    stats: poietra_render_wgpu::ImageTextureCacheFrameStatsV1,
    has_images: bool,
) -> CacheOutcomeV1 {
    if !has_images {
        CacheOutcomeV1::Skipped
    } else if stats.sampler_binding_creations() > 0 {
        CacheOutcomeV1::Miss
    } else {
        CacheOutcomeV1::Hit
    }
}

#[derive(Clone, Debug)]
struct RuntimeFailureV1 {
    code: CanvasRenderErrorCodeV1,
    message: String,
}

#[derive(Clone, Copy, Debug)]
struct SurfaceSelectionV1 {
    alpha_mode: wgpu::CompositeAlphaMode,
    surface_format: wgpu::TextureFormat,
    view_format: wgpu::TextureFormat,
}

/// Complete device-bound Canvas state constructed before it replaces a lost
/// runtime. The retained Scene and decoded PNG registry deliberately live on
/// [`PoietraCanvasEngineV1`] instead, so recovery never needs page I/O.
struct CanvasGpuCandidateV1 {
    adapter_evidence: CanvasAdapterEvidenceV1,
    uncaptured_error_listener: RawUncapturedErrorListenerV1,
    device: wgpu::Device,
    device_lost: SharedFailureV1,
    queue: wgpu::Queue,
    renderer: WgpuPaintRendererV1,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    uncaptured_gpu_failure: SharedFailureV1,
    view_format: wgpu::TextureFormat,
}

type SharedFailureV1 = Arc<Mutex<Option<RuntimeFailureV1>>>;

#[derive(Debug, Default)]
struct DeferredGpuScopeStateV1 {
    failure: Option<RuntimeFailureV1>,
    pending: bool,
}

type SharedDeferredGpuScopeStateV1 = Arc<Mutex<DeferredGpuScopeStateV1>>;

/// Captured `performance.now` handle from the worker global scope.
///
/// Capturing once per frame keeps every phase mark on the same clock and lets
/// the telemetry response state explicitly when no monotonic clock exists.
struct WorkerClockV1 {
    now: Option<(js_sys::Function, JsValue)>,
}

impl WorkerClockV1 {
    fn capture() -> Self {
        let global = js_sys::global();
        let now = js_sys::Reflect::get(&global, &JsValue::from_str("performance"))
            .ok()
            .filter(|performance| !performance.is_undefined() && !performance.is_null())
            .and_then(|performance| {
                let function = js_sys::Reflect::get(&performance, &JsValue::from_str("now"))
                    .ok()?
                    .dyn_into::<js_sys::Function>()
                    .ok()?;
                Some((function, performance))
            });
        Self { now }
    }

    fn source(&self) -> TelemetryClockSourceV1 {
        if self.now.is_some() {
            TelemetryClockSourceV1::WorkerPerformanceNow
        } else {
            TelemetryClockSourceV1::Unavailable
        }
    }

    fn now_ms(&self) -> Option<f64> {
        let (function, target) = self.now.as_ref()?;
        function.call0(target).ok()?.as_f64()
    }

    /// Raw clock difference; deliberately NOT clamped or sanitized. A
    /// non-monotonic or non-finite clock surfaces as an invalid interval,
    /// which [`PhaseSampleV1::from_optional_ms`] reports as unavailable.
    fn elapsed_ms(&self, started: Option<f64>) -> Option<f64> {
        Some(self.now_ms()? - started?)
    }
}

struct GpuErrorScopesV1 {
    raw_device: JsValue,
}

struct PendingGpuErrorScopesV1 {
    internal: PendingRawErrorScopeV1,
    out_of_memory: PendingRawErrorScopeV1,
    validation: PendingRawErrorScopeV1,
}

enum PendingRawErrorScopeV1 {
    Promise(js_sys::Promise),
    Rejected(RuntimeFailureV1),
}

struct RawUncapturedErrorListenerV1 {
    callback: Closure<dyn FnMut(JsValue)>,
    raw_device: JsValue,
}

impl RawUncapturedErrorListenerV1 {
    fn install(
        device: &wgpu::Device,
        failures: &SharedFailureV1,
    ) -> Result<Self, RuntimeFailureV1> {
        let raw_device = raw_webgpu_device(device)?;
        let reported_failure = Arc::clone(failures);
        let callback = Closure::wrap(Box::new(move |event: JsValue| {
            let failure = match js_sys::Reflect::get(&event, &JsValue::from_str("error")) {
                Ok(error) => runtime_failure_from_js_gpu_error(&error),
                Err(error) => RuntimeFailureV1 {
                    code: CanvasRenderErrorCodeV1::GpuInternal,
                    message: format!(
                        "could not inspect WebGPU uncaptured error: {}",
                        js_error_message(&error)
                    ),
                },
            };
            retain_first_failure(&reported_failure, failure);
        }) as Box<dyn FnMut(JsValue)>);
        call_js_method_two(
            &raw_device,
            "addEventListener",
            &JsValue::from_str("uncapturederror"),
            callback.as_ref(),
        )
        .map_err(|error| RuntimeFailureV1 {
            code: CanvasRenderErrorCodeV1::GpuInternal,
            message: format!(
                "could not install WebGPU uncaptured-error listener: {}",
                js_error_message(&error)
            ),
        })?;
        Ok(Self {
            callback,
            raw_device,
        })
    }
}

impl Drop for RawUncapturedErrorListenerV1 {
    fn drop(&mut self) {
        let _ = call_js_method_two(
            &self.raw_device,
            "removeEventListener",
            &JsValue::from_str("uncapturederror"),
            self.callback.as_ref(),
        );
    }
}

impl GpuErrorScopesV1 {
    fn push(device: &wgpu::Device) -> Result<Self, RuntimeFailureV1> {
        // wgpu 30's browser `pop_error_scope` converter panics on GPUInternalError.
        // Use the same WebGPU scopes directly so every variant fails closed instead.
        let raw_device = raw_webgpu_device(device)?;
        for (pushed_scope_count, filter) in ["internal", "out-of-memory", "validation"]
            .into_iter()
            .enumerate()
        {
            if let Err(error) =
                call_js_method_one(&raw_device, "pushErrorScope", &JsValue::from_str(filter))
            {
                // `pushErrorScope()` is not transactional. Roll back every
                // scope that this call already pushed before returning the
                // failure, otherwise a partial diagnostic batch could sit
                // above the rolling normal batch and corrupt its next pop.
                rollback_pushed_error_scopes(&raw_device, pushed_scope_count);
                return Err(RuntimeFailureV1 {
                    code: CanvasRenderErrorCodeV1::GpuInternal,
                    message: format!(
                        "could not push {filter} WebGPU error scope: {}",
                        js_error_message(&error)
                    ),
                });
            }
        }
        Ok(Self { raw_device })
    }

    fn pop(self) -> PendingGpuErrorScopesV1 {
        // `popErrorScope()` removes a scope from the device stack immediately,
        // before its returned Promise settles. Pop all three synchronously so
        // later frames cannot become nested inside an earlier frame's scopes.
        // The normal path may then drain these already-started Promises in the
        // background, while the diagnostic path retains ownership and awaits
        // them for error attribution and timing.
        PendingGpuErrorScopesV1 {
            validation: begin_pop_raw_error_scope(&self.raw_device),
            out_of_memory: begin_pop_raw_error_scope(&self.raw_device),
            internal: begin_pop_raw_error_scope(&self.raw_device),
        }
    }
}

impl PendingGpuErrorScopesV1 {
    fn immediate_failure(&self) -> Option<RuntimeFailureV1> {
        self.out_of_memory
            .immediate_failure()
            .or_else(|| self.validation.immediate_failure())
            .or_else(|| self.internal.immediate_failure())
    }

    async fn finish(self) -> Option<RuntimeFailureV1> {
        // Every Promise is already in flight, so these awaits do not serialize
        // the three WebGPU pop operations. Preserve the established failure
        // priority: OOM, validation, then internal.
        let validation = self.validation.finish().await;
        let out_of_memory = self.out_of_memory.finish().await;
        let internal = self.internal.finish().await;
        out_of_memory.or(validation).or(internal)
    }
}

impl PendingRawErrorScopeV1 {
    fn immediate_failure(&self) -> Option<RuntimeFailureV1> {
        match self {
            Self::Promise(_) => None,
            Self::Rejected(failure) => Some(failure.clone()),
        }
    }

    async fn finish(self) -> Option<RuntimeFailureV1> {
        let promise = match self {
            Self::Promise(promise) => promise,
            Self::Rejected(failure) => return Some(failure),
        };
        match JsFuture::from(promise).await {
            Ok(value) if value.is_null() || value.is_undefined() => None,
            Ok(error) => Some(runtime_failure_from_js_gpu_error(&error)),
            Err(error) => Some(RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::GpuInternal,
                message: format!(
                    "WebGPU error scope promise rejected: {}",
                    js_error_message(&error)
                ),
            }),
        }
    }
}

fn rollback_pushed_error_scopes(raw_device: &JsValue, pushed_scope_count: usize) {
    if pushed_scope_count == 0 {
        return;
    }

    // All successful pushes are synchronously matched with a pop before the
    // caller can continue. Promise settlement is drained by exactly one task;
    // the fixed filter set bounds this vector at two entries on push failure.
    let pending_scopes: Vec<_> = (0..pushed_scope_count)
        .map(|_| begin_pop_raw_error_scope(raw_device))
        .collect();
    spawn_local(async move {
        for pending_scope in pending_scopes {
            let _failure = pending_scope.finish().await;
        }
    });
}

async fn acquire_canvas_gpu_candidate(
    canvas: &OffscreenCanvas,
) -> Result<CanvasGpuCandidateV1, JsValue> {
    let mut instance_descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    instance_descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
    let instance = wgpu::Instance::new(instance_descriptor);
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
        .map_err(|error| renderer_unavailable(&format!("could not create surface: {error}")))?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            ..wgpu::RequestAdapterOptions::default()
        })
        .await
        .map_err(|error| renderer_unavailable(&format!("no compatible WebGPU adapter: {error}")))?;
    let selection = select_surface_capabilities(&surface.get_capabilities(&adapter))?;
    let device_descriptor = wgpu::DeviceDescriptor {
        label: Some("poietra canvas device v1"),
        ..wgpu::DeviceDescriptor::default()
    };
    let (device, queue) = adapter
        .request_device(&device_descriptor)
        .await
        .map_err(|error| {
            renderer_unavailable(&format!("could not create WebGPU device: {error}"))
        })?;
    let (browser_architecture, browser_vendor) = device
        .as_webgpu()
        .map(|device| {
            let info = device.adapter_info();
            (info.architecture(), info.vendor())
        })
        .unwrap_or_default();
    let adapter_evidence = build_adapter_evidence(
        &device.adapter_info(),
        &browser_architecture,
        &browser_vendor,
        &device_descriptor,
        &selection,
    );

    let device_lost = install_device_lost_handler(&device);
    let uncaptured_gpu_failure = shared_failure();
    let uncaptured_error_listener =
        RawUncapturedErrorListenerV1::install(&device, &uncaptured_gpu_failure)
            .map_err(|failure| renderer_unavailable(&failure.message))?;

    let scopes = GpuErrorScopesV1::push(&device)
        .map_err(|failure| renderer_unavailable(&failure.message))?;
    let renderer = WgpuPaintRendererV1::new(&device, selection.view_format).map_err(|error| {
        renderer_unavailable(&format!("could not create paint renderer: {error}"))
    });
    let scoped_failure = scopes.pop().finish().await;
    if let Some(failure) = scoped_failure {
        return Err(renderer_unavailable(&failure.message));
    }
    if let Some(failure) =
        read_shared_failure(&device_lost).or_else(|| read_shared_failure(&uncaptured_gpu_failure))
    {
        return Err(renderer_unavailable(&failure.message));
    }
    let renderer = renderer?;

    Ok(CanvasGpuCandidateV1 {
        adapter_evidence,
        uncaptured_error_listener,
        device,
        device_lost,
        queue,
        renderer,
        surface,
        surface_config: wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: selection.surface_format,
            color_space: wgpu::SurfaceColorSpace::Auto,
            width: 1,
            height: 1,
            desired_maximum_frame_latency: 2,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: selection.alpha_mode,
            view_formats: vec![selection.view_format],
        },
        uncaptured_gpu_failure,
        view_format: selection.view_format,
    })
}

/// Retained Scene evaluator and WebGPU surface owned by one browser worker.
#[wasm_bindgen]
pub struct PoietraCanvasEngineV1 {
    adapter_evidence: CanvasAdapterEvidenceV1,
    asset_registry: CanvasPngAssetRegistryV1,
    canvas: OffscreenCanvas,
    configured_viewport: Option<ViewportV1>,
    // Checked count of surface reconfigurations within the frame being
    // rendered; `None` records an explicit counter overflow.
    frame_surface_configurations: Option<u32>,
    memory_high_water: EngineMemoryHighWaterV1,
    // Kept before `device` so Drop unregisters the JS callback first.
    _uncaptured_error_listener: RawUncapturedErrorListenerV1,
    device: wgpu::Device,
    deferred_scope_state: SharedDeferredGpuScopeStateV1,
    device_lost: SharedFailureV1,
    normal_active_error_scopes: Option<GpuErrorScopesV1>,
    prepared_geometry_cache: PreparedGeometryCacheV1,
    queue: wgpu::Queue,
    renderer: WgpuPaintRendererV1,
    session: EngineWorkerSessionV1,
    surface: wgpu::Surface<'static>,
    surface_config: wgpu::SurfaceConfiguration,
    terminal_surface_failure: Option<RuntimeFailureV1>,
    uncaptured_gpu_failure: SharedFailureV1,
    view_format: wgpu::TextureFormat,
}

impl fmt::Debug for PoietraCanvasEngineV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PoietraCanvasEngineV1")
            .field(
                "canvas_extent",
                &[self.canvas.width(), self.canvas.height()],
            )
            .field("configured_viewport", &self.configured_viewport)
            .field("surface_format", &self.surface_config.format)
            .field("view_format", &self.view_format)
            .field(
                "has_terminal_surface_failure",
                &self.terminal_surface_failure.is_some(),
            )
            .finish_non_exhaustive()
    }
}

#[wasm_bindgen]
impl PoietraCanvasEngineV1 {
    /// Validates a snapshot and asynchronously acquires an `OffscreenCanvas` WebGPU device.
    ///
    /// # Errors
    ///
    /// Rejects with a named JavaScript `Error`: `PoietraCanvasSnapshotRejected`
    /// for invalid snapshots or `PoietraCanvasRendererUnavailable` for WebGPU setup failures.
    #[wasm_bindgen(js_name = create)]
    pub async fn create(
        snapshot_json: &[u8],
        asset_metadata_json: &[u8],
        asset_bytes: js_sys::Array,
        canvas: OffscreenCanvas,
    ) -> Result<PoietraCanvasEngineV1, JsValue> {
        let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error.to_string()))?;
        let copied_asset_bytes = copy_asset_byte_arrays(&asset_bytes)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error))?;
        let asset_registry = CanvasPngAssetRegistryV1::default()
            .prepare_candidate(&bundle.assets, asset_metadata_json, &copied_asset_bytes)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error.to_string()))?;
        let session = EngineWorkerSessionV1::from_bundle(bundle)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error.to_string()))?;
        let gpu = acquire_canvas_gpu_candidate(&canvas).await?;

        Ok(Self {
            adapter_evidence: gpu.adapter_evidence,
            asset_registry,
            canvas,
            configured_viewport: None,
            frame_surface_configurations: Some(0),
            memory_high_water: EngineMemoryHighWaterV1::default(),
            _uncaptured_error_listener: gpu.uncaptured_error_listener,
            device: gpu.device,
            deferred_scope_state: Arc::new(Mutex::new(DeferredGpuScopeStateV1::default())),
            device_lost: gpu.device_lost,
            normal_active_error_scopes: None,
            prepared_geometry_cache: PreparedGeometryCacheV1::default(),
            queue: gpu.queue,
            renderer: gpu.renderer,
            session,
            surface: gpu.surface,
            surface_config: gpu.surface_config,
            terminal_surface_failure: None,
            uncaptured_gpu_failure: gpu.uncaptured_gpu_failure,
            view_format: gpu.view_format,
        })
    }

    /// Atomically validates and installs a complete replacement snapshot.
    ///
    /// # Errors
    ///
    /// Returns a JavaScript error and preserves the current snapshot on failure.
    #[wasm_bindgen(js_name = replaceSnapshot)]
    pub fn replace_snapshot(
        &mut self,
        snapshot_json: &[u8],
        asset_metadata_json: &[u8],
        asset_bytes: js_sys::Array,
    ) -> Result<(), JsValue> {
        let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error.to_string()))?;
        let copied_asset_bytes = copy_asset_byte_arrays(&asset_bytes)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error))?;
        let candidate_registry = self
            .asset_registry
            .prepare_candidate(&bundle.assets, asset_metadata_json, &copied_asset_bytes)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error.to_string()))?;
        self.session
            .replace_snapshot_bundle(bundle)
            .map_err(|error| named_js_error(SNAPSHOT_REJECTED_ERROR_NAME, &error.to_string()))?;
        self.asset_registry = candidate_registry;
        self.prepared_geometry_cache.clear();
        self.renderer.clear_image_texture_cache();
        Ok(())
    }

    /// Evaluates and presents one bounded sample request.
    ///
    /// The returned JSON contains only presentation correlation or a structured
    /// error. A `RenderPacket` never crosses this ABI.
    #[must_use]
    pub async fn render(&mut self, request_json: &[u8]) -> Vec<u8> {
        let sampled = match self.session.sample_packet_json(request_json) {
            Ok(sampled) => sampled,
            Err(error) => return sample_error_response(&error),
        };
        let correlation = &sampled.correlation;
        let mut recovery_attempted = false;
        if let Some(failure) = self.current_terminal_failure() {
            if failure.code != CanvasRenderErrorCodeV1::DeviceLost {
                return error_response(failure.code, &failure.message, Some(correlation));
            }
            recovery_attempted = true;
            if let Err(recovery_failure) = self.recover_after_device_loss().await {
                return error_response(
                    recovery_failure.code,
                    &recovery_failure.message,
                    Some(correlation),
                );
            }
        }
        let frame = match prepare_frame_with_cache_and_assets_v1(
            &sampled.packet,
            &mut self.prepared_geometry_cache,
            &self.asset_registry,
        ) {
            Ok(frame) => frame,
            Err(error) => {
                return error_response(
                    CanvasRenderErrorCodeV1::UnsupportedFrame,
                    &error.to_string(),
                    Some(correlation),
                );
            }
        };

        let first_attempt = self.render_prepared_frame(&frame);
        let rendered = match first_attempt {
            Err(failure)
                if failure.code == CanvasRenderErrorCodeV1::DeviceLost && !recovery_attempted =>
            {
                if let Err(recovery_failure) = self.recover_after_device_loss().await {
                    return error_response(
                        recovery_failure.code,
                        &recovery_failure.message,
                        Some(correlation),
                    );
                }
                self.render_prepared_frame(&frame)
            }
            outcome => outcome,
        };

        match rendered {
            Ok(suboptimal) => {
                let interaction_bounds = matches!(
                    &sampled.interaction,
                    crate::protocol::SampledInteractionRequestV1::Available(_)
                )
                .then(|| frame.interaction_clip_bounds_by_entity(self.session.scene()))
                .flatten()
                .unwrap_or_default();
                let interaction = interaction_metadata(&sampled.interaction, |entity_id| {
                    interaction_bounds.get(entity_id).copied()
                });
                presented_response_with_interaction(correlation, suboptimal, interaction)
            }
            Err(failure) => error_response(failure.code, &failure.message, Some(correlation)),
        }
    }

    /// Evaluates and presents one sample request while recording opt-in
    /// per-phase stage telemetry.
    ///
    /// The response is larger than [`Self::render`]'s compact acknowledgement
    /// and additionally waits for `GPUQueue.onSubmittedWorkDone`, so this path
    /// measures isolated frame cost rather than pipelined throughput. Normal
    /// rendering must keep using [`Self::render`].
    #[must_use]
    #[allow(clippy::too_many_lines)] // Sequential phase marks; splitting would obscure ordering.
    #[wasm_bindgen(js_name = renderWithTelemetry)]
    pub async fn render_with_telemetry(&mut self, request_json: &[u8]) -> Vec<u8> {
        let clock = WorkerClockV1::capture();
        let mut telemetry = FrameTelemetryV1::new(clock.source());
        let total_started = clock.now_ms();

        let evaluate_started = clock.now_ms();
        let sampled = match self.session.sample_packet_json(request_json) {
            Ok(sampled) => sampled,
            Err(error) => {
                telemetry.phases.evaluate = PhaseSampleV1::from_optional_ms(
                    clock.elapsed_ms(evaluate_started),
                    CLOCK_UNAVAILABLE_REASON_V1,
                );
                telemetry.total_ms = normalized_duration_ms(clock.elapsed_ms(total_started));
                return self.telemetry_response(
                    error_result(
                        sample_error_code(error.code),
                        &error.message,
                        error.correlation.as_ref(),
                    ),
                    telemetry,
                );
            }
        };
        telemetry.phases.evaluate = PhaseSampleV1::from_optional_ms(
            clock.elapsed_ms(evaluate_started),
            CLOCK_UNAVAILABLE_REASON_V1,
        );
        let draws = &sampled.packet.draws;
        telemetry.counts.evaluated_draws = Some(draws.len() as u64);
        let evaluated_entities: BTreeSet<&str> =
            draws.iter().map(RenderDrawV1::entity_id).collect();
        telemetry.counts.evaluated_entities = Some(evaluated_entities.len() as u64);
        let correlation = sampled.correlation.clone();

        if let Some(failure) = self.current_terminal_failure() {
            telemetry.total_ms = normalized_duration_ms(clock.elapsed_ms(total_started));
            return self.telemetry_response(
                error_result(failure.code, &failure.message, Some(&correlation)),
                telemetry,
            );
        }

        let prepare_started = clock.now_ms();
        let validated = match validate_frame_packet_v1(&sampled.packet) {
            Ok(validated) => validated,
            Err(error) => {
                telemetry.phases.prepare = PhaseSampleV1::from_optional_ms(
                    clock.elapsed_ms(prepare_started),
                    CLOCK_UNAVAILABLE_REASON_V1,
                );
                telemetry.total_ms = normalized_duration_ms(clock.elapsed_ms(total_started));
                return self.telemetry_response(
                    error_result(
                        CanvasRenderErrorCodeV1::UnsupportedFrame,
                        &error.to_string(),
                        Some(&correlation),
                    ),
                    telemetry,
                );
            }
        };
        telemetry.phases.prepare = PhaseSampleV1::from_optional_ms(
            clock.elapsed_ms(prepare_started),
            CLOCK_UNAVAILABLE_REASON_V1,
        );

        let tessellate_started = clock.now_ms();
        let frame = match tessellate_validated_frame_with_cache_and_assets_v1(
            validated,
            &mut self.prepared_geometry_cache,
            &self.asset_registry,
        ) {
            Ok(frame) => frame,
            Err(error) => {
                telemetry.caches.prepared_geometry =
                    prepared_geometry_cache_outcome(self.prepared_geometry_cache.frame_stats());
                telemetry.phases.tessellate = PhaseSampleV1::from_optional_ms(
                    clock.elapsed_ms(tessellate_started),
                    CLOCK_UNAVAILABLE_REASON_V1,
                );
                telemetry.total_ms = normalized_duration_ms(clock.elapsed_ms(total_started));
                return self.telemetry_response(
                    error_result(
                        CanvasRenderErrorCodeV1::UnsupportedFrame,
                        &error.to_string(),
                        Some(&correlation),
                    ),
                    telemetry,
                );
            }
        };
        telemetry.caches.prepared_geometry =
            prepared_geometry_cache_outcome(self.prepared_geometry_cache.frame_stats());
        telemetry.phases.tessellate = PhaseSampleV1::from_optional_ms(
            clock.elapsed_ms(tessellate_started),
            CLOCK_UNAVAILABLE_REASON_V1,
        );
        telemetry.counts.tessellated_vertices = Some(frame.geometry_plan().vertices().len() as u64);
        telemetry.counts.tessellated_indices = Some(frame.indices().len() as u64);
        // Counted at the tessellation call sites inside the renderer crate,
        // never inferred from vertex or index totals.
        telemetry.counts.tessellation_calls = Some(frame.tessellation_calls());

        match self
            .render_prepared_frame_instrumented(&frame, &clock, &mut telemetry)
            .await
        {
            Ok(suboptimal) => {
                // The only phase allowed to claim GPU completion: it awaits
                // the real GPUQueue.onSubmittedWorkDone fence.
                let fence_started = clock.now_ms();
                match self.await_submitted_work_done().await {
                    Ok(()) => {
                        telemetry.phases.gpu_queue_submitted_work_done =
                            PhaseSampleV1::from_optional_ms(
                                clock.elapsed_ms(fence_started),
                                CLOCK_UNAVAILABLE_REASON_V1,
                            );
                    }
                    Err(observation) => {
                        // An explicit rejection always fails the frame, even
                        // if the device-lost callback has not fired yet; only
                        // a genuinely unobservable fence API (with no known
                        // terminal failure) may present with an unavailable
                        // phase. A rejected fence is also rechecked against
                        // terminal failures so the most specific error wins.
                        let terminal = self.current_terminal_failure();
                        match fence_failure_policy(&observation, terminal.is_some()) {
                            FenceFailurePolicyV1::FailFrame { message } => {
                                telemetry.phases.gpu_queue_submitted_work_done =
                                    PhaseSampleV1::unavailable(&message);
                                telemetry.total_ms =
                                    normalized_duration_ms(clock.elapsed_ms(total_started));
                                let (code, message) = match terminal {
                                    Some(failure) => (failure.code, failure.message),
                                    None => (CanvasRenderErrorCodeV1::GpuInternal, message),
                                };
                                return self.telemetry_response(
                                    error_result(code, &message, Some(&correlation)),
                                    telemetry,
                                );
                            }
                            FenceFailurePolicyV1::PresentWithUnavailablePhase { reason } => {
                                telemetry.phases.gpu_queue_submitted_work_done =
                                    PhaseSampleV1::unavailable(&reason);
                            }
                        }
                    }
                }
                telemetry.total_ms = normalized_duration_ms(clock.elapsed_ms(total_started));
                self.telemetry_response(presented_result(&correlation, suboptimal), telemetry)
            }
            Err(failure) => {
                telemetry.total_ms = normalized_duration_ms(clock.elapsed_ms(total_started));
                self.telemetry_response(
                    error_result(failure.code, &failure.message, Some(&correlation)),
                    telemetry,
                )
            }
        }
    }

    /// Returns bounded adapter and surface evidence captured inside this
    /// worker, distinct from any page-level `navigator.gpu` adapter hint.
    #[must_use]
    #[wasm_bindgen(js_name = adapterEvidence)]
    pub fn adapter_evidence_json(&self) -> Vec<u8> {
        adapter_evidence_response(&self.adapter_evidence)
    }
}

impl PoietraCanvasEngineV1 {
    fn current_memory_values(&self) -> Result<EngineMemoryCurrentV1, String> {
        let renderer = self
            .renderer
            .memory_snapshot()
            .map_err(|error| error.to_string())?;
        let retained_scene_index = u64::try_from(self.session.retained_index_accounted_bytes())
            .map_err(|_| {
                "the retained Scene index byte count is not representable as u64".to_owned()
            })?;
        let prepared_geometry_cache = u64::try_from(self.prepared_geometry_cache.accounted_bytes())
            .map_err(|_| {
                "the prepared geometry cache byte count is not representable as u64".to_owned()
            })?;
        let decoded_image_assets = self
            .asset_registry
            .decoded_image_asset_bytes()
            .map_err(|error| error.to_string())?;
        // Read linear memory last so the reported total contains all Rust-side
        // allocations needed to gather the logical component breakdown.
        let wasm_linear = wasm_linear_memory_bytes()?;
        Ok(EngineMemoryCurrentV1 {
            decoded_image_assets,
            geometry_buffer_arena: renderer.geometry_buffer_arena_bytes(),
            multisample_color_target: renderer.multisample_color_target_bytes(),
            prepared_geometry_cache,
            retained_image_textures: renderer.retained_image_texture_bytes(),
            retained_scene_index,
            wasm_linear,
        })
    }

    /// Captures memory at the opt-in response boundary, immediately before
    /// serialization. Reporting allocations themselves are intentionally not
    /// folded recursively into the snapshot.
    fn telemetry_response(
        &mut self,
        result: crate::canvas_protocol::CanvasRenderResultV1,
        mut telemetry: FrameTelemetryV1,
    ) -> Vec<u8> {
        telemetry.memory = match self.current_memory_values() {
            Ok(current) => self
                .memory_high_water
                .observe(current)
                .unwrap_or_else(|error| FrameMemorySampleV1::unavailable(&error.to_string())),
            Err(reason) => FrameMemorySampleV1::unavailable(&reason),
        };
        serialize_telemetry_response(result, telemetry)
    }

    /// Reacquires every GPU-owned object and swaps only after the complete
    /// candidate is ready. A failed recovery leaves the already-lost state in
    /// place so the caller can terminate fail-closed; Scene/revision and
    /// decoded PNG authorities are never moved or reconstructed.
    async fn recover_after_device_loss(&mut self) -> Result<(), RuntimeFailureV1> {
        let gpu = acquire_canvas_gpu_candidate(&self.canvas)
            .await
            .map_err(|error| RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::DeviceLost,
                message: format!(
                    "WebGPU device recovery failed: {}",
                    js_error_message(&error)
                ),
            })?;

        // Drop device-bound dependants before replacing the old device. Any
        // detached error-scope drain retains only the old Arc and cannot poison
        // this new generation.
        self.normal_active_error_scopes = None;
        self.renderer = gpu.renderer;
        self.surface = gpu.surface;
        self.queue = gpu.queue;
        self._uncaptured_error_listener = gpu.uncaptured_error_listener;
        self.device = gpu.device;
        self.adapter_evidence = gpu.adapter_evidence;
        self.device_lost = gpu.device_lost;
        self.uncaptured_gpu_failure = gpu.uncaptured_gpu_failure;
        self.deferred_scope_state = Arc::new(Mutex::new(DeferredGpuScopeStateV1::default()));
        self.surface_config = gpu.surface_config;
        self.view_format = gpu.view_format;
        self.configured_viewport = None;
        self.frame_surface_configurations = Some(0);
        self.terminal_surface_failure = None;
        self.prepared_geometry_cache.clear();
        Ok(())
    }

    fn render_prepared_frame(&mut self, frame: &PreparedFrameV1) -> Result<bool, RuntimeFailureV1> {
        if let Some(failure) = self.current_terminal_failure() {
            return Err(failure);
        }

        // One engine-owned rolling batch always covers normal GPU operations.
        // It may span many frames while the previous popped batch waits for
        // GPU progress, but normal rendering is never allowed to run unscoped.
        if self.normal_active_error_scopes.is_none() {
            match GpuErrorScopesV1::push(&self.device) {
                Ok(scopes) => self.normal_active_error_scopes = Some(scopes),
                Err(failure) => {
                    retain_deferred_gpu_scope_failure(&self.deferred_scope_state, failure.clone());
                    return Err(failure);
                }
            }
        }

        let operation = self.render_frame_operation(frame, None);
        if let Some(failure) = self.current_terminal_failure() {
            return Err(failure);
        }

        // Only rotate at a frame boundary when the single deferred slot is
        // free. While it is occupied, the active batch remains on the device
        // stack and covers every subsequent normal frame without creating new
        // tasks or Promises.
        if !begin_deferred_gpu_scope_batch(&self.deferred_scope_state) {
            return operation;
        }
        let Some(active_scopes) = self.normal_active_error_scopes.take() else {
            let failure = RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::GpuInternal,
                message: "normal rendering lost its active WebGPU error scopes".to_owned(),
            };
            complete_deferred_gpu_scope_batch(&self.deferred_scope_state, Some(failure.clone()));
            return Err(failure);
        };
        let pending_scopes = active_scopes.pop();
        let immediate_failure = pending_scopes.immediate_failure();
        let replacement_failure = match GpuErrorScopesV1::push(&self.device) {
            Ok(scopes) => {
                self.normal_active_error_scopes = Some(scopes);
                None
            }
            Err(failure) => Some(failure),
        };
        let deferred_scope_state = Arc::clone(&self.deferred_scope_state);
        // Scope Promises can wait for GPU progress. The replacement batch is
        // already active before this detached drain is scheduled, so coverage
        // is continuous while ownership stays bounded at one active batch plus
        // one pending batch/task.
        spawn_local(async move {
            let failure = pending_scopes.finish().await;
            complete_deferred_gpu_scope_batch(&deferred_scope_state, failure);
        });

        if let Some(failure) = immediate_failure.or(replacement_failure) {
            retain_deferred_gpu_scope_failure(&self.deferred_scope_state, failure.clone());
            return Err(failure);
        }
        operation
    }

    async fn render_prepared_frame_instrumented(
        &mut self,
        frame: &PreparedFrameV1,
        clock: &WorkerClockV1,
        telemetry: &mut FrameTelemetryV1,
    ) -> Result<bool, RuntimeFailureV1> {
        if let Some(failure) = self.current_terminal_failure() {
            return Err(failure);
        }

        let scopes = match GpuErrorScopesV1::push(&self.device) {
            Ok(scopes) => scopes,
            Err(failure) => {
                retain_deferred_gpu_scope_failure(&self.deferred_scope_state, failure.clone());
                return Err(failure);
            }
        };
        let operation = self.render_frame_operation(frame, Some((clock, telemetry)));
        // Popping the three WebGPU error scopes awaits their promises, which
        // can block on GPU progress; measure it as its own additive phase so
        // the wait is attributed instead of vanishing into totalMs.
        let scope_resolution_started = clock.now_ms();
        let scoped_failure = scopes.pop().finish().await;
        telemetry.phases.gpu_error_scope_resolution = PhaseSampleV1::from_optional_ms(
            clock.elapsed_ms(scope_resolution_started),
            CLOCK_UNAVAILABLE_REASON_V1,
        );

        if let Some(failure) = scoped_failure {
            // A pop API failure, rejected Promise, or scoped GPU error means
            // the scope stack can no longer be trusted for later frames. Keep
            // it terminal even though this diagnostic call already reports it.
            retain_deferred_gpu_scope_failure(&self.deferred_scope_state, failure.clone());
        }
        if let Some(failure) = self.current_terminal_failure() {
            return Err(failure);
        }
        operation
    }

    #[allow(clippy::too_many_lines)] // Every exit path finalizes evidence in place; splitting would hide that.
    fn render_frame_operation(
        &mut self,
        frame: &PreparedFrameV1,
        telemetry: Option<(&WorkerClockV1, &mut FrameTelemetryV1)>,
    ) -> Result<bool, RuntimeFailureV1> {
        let (clock, mut recorder) = match telemetry {
            Some((clock, recorder)) => (Some(clock), Some(recorder)),
            None => (None, None),
        };
        let [width_px, height_px] = frame.viewport();
        let viewport = ViewportV1 {
            height_px,
            width_px,
        };
        self.frame_surface_configurations = Some(0);
        let surface_acquire_started = clock.and_then(WorkerClockV1::now_ms);
        self.ensure_configured_for_viewport(&viewport);

        // The surfaceAcquire phase (configuration, current-texture
        // acquisition, view creation) is finalized on EVERY path that reached
        // it — including acquisition failures — so Skipped is reserved for
        // stages that genuinely never started.
        let record_surface_acquire = |recorder: &mut Option<&mut FrameTelemetryV1>| {
            if let Some(recorder) = recorder {
                recorder.phases.surface_acquire = PhaseSampleV1::from_optional_ms(
                    clock.and_then(|clock| clock.elapsed_ms(surface_acquire_started)),
                    CLOCK_UNAVAILABLE_REASON_V1,
                );
            }
        };
        let (surface_texture, suboptimal) = match self.acquire_surface_texture(&viewport) {
            Ok(acquired) => acquired,
            Err(failure) => {
                // Configurations already executed on this frame (the initial
                // viewport configure and/or the outdated-retry configure)
                // must never serialize as skipped/null just because the
                // acquisition ultimately failed.
                record_surface_acquire(&mut recorder);
                if let Some(recorder) = &mut recorder {
                    finalize_surface_configuration_evidence(
                        recorder,
                        self.frame_surface_configurations,
                    );
                }
                return Err(failure);
            }
        };
        let target_format = self
            .renderer
            .target_format_for_compositing(frame.compositing());
        let view_label = match frame.compositing() {
            poietra_scene_ir::RenderCompositingV1::LinearLight => {
                "poietra canvas linear-light sRGB view v1"
            }
            poietra_scene_ir::RenderCompositingV1::ManimCairoSrgb => {
                "poietra canvas Manim Cairo base Unorm view v1"
            }
        };
        let view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor {
                label: Some(view_label),
                format: Some(target_format),
                ..wgpu::TextureViewDescriptor::default()
            });
        record_surface_acquire(&mut recorder);
        let stage_clock = clock.map(|clock| move || clock.now_ms());
        let stage_clock_ref: Option<&dyn Fn() -> Option<f64>> = stage_clock
            .as_ref()
            .map(|function| function as &dyn Fn() -> Option<f64>);
        let stage_result = self.renderer.render_with_stage_evidence(
            &self.device,
            &self.queue,
            WgpuRenderTargetV1 {
                format: target_format,
                height_px,
                view: &view,
                width_px,
            },
            frame,
            stage_clock_ref,
        );
        let (_submission, stage_evidence) = match stage_result {
            Ok(rendered) => rendered,
            Err(error) => {
                // A renderer/stage failure after acquisition still finalizes
                // the configurations that actually ran before the failure.
                if let Some(recorder) = &mut recorder {
                    finalize_surface_configuration_evidence(
                        recorder,
                        self.frame_surface_configurations,
                    );
                }
                return Err(RuntimeFailureV1 {
                    code: CanvasRenderErrorCodeV1::GpuValidation,
                    message: error.to_string(),
                });
            }
        };
        if let Some(recorder) = &mut recorder {
            // Whether a stage executed comes from the renderer's explicit
            // evidence, never inferred from interval presence: an executed
            // stage with no interval is unavailable, not skipped.
            let geometry = stage_evidence.geometry_stages_executed;
            recorder.phases.vertex_index_encode =
                stage_phase_sample(geometry, stage_evidence.vertex_index_encode_ms);
            recorder.phases.buffer_create_and_stage =
                stage_phase_sample(geometry, stage_evidence.buffer_create_and_stage_ms);
            recorder.phases.command_encode_total =
                stage_phase_sample(true, stage_evidence.command_encode_total_ms);
            recorder.phases.draw_record =
                stage_phase_sample(geometry, stage_evidence.draw_record_ms);
            recorder.phases.submit = stage_phase_sample(true, stage_evidence.submit_ms);
            recorder.counts.buffer_creations = Some(u64::from(stage_evidence.buffer_creations));
            recorder.counts.draw_calls = Some(stage_evidence.draw_calls);
            recorder.counts.image_sampler_binding_creations = Some(
                stage_evidence
                    .image_texture_cache
                    .sampler_binding_creations(),
            );
            recorder.counts.image_texture_evictions =
                Some(stage_evidence.image_texture_cache.evictions());
            recorder.counts.image_texture_uploads =
                Some(stage_evidence.image_texture_cache.texture_uploads());
            recorder.counts.upload_bytes = Some(stage_evidence.upload_bytes);
            let has_images = !frame.image_draws().is_empty();
            recorder.caches.image_sampler_binding =
                image_sampler_binding_cache_outcome(stage_evidence.image_texture_cache, has_images);
            recorder.caches.image_texture =
                image_texture_cache_outcome(stage_evidence.image_texture_cache, has_images);
        }
        let present_started = clock.and_then(WorkerClockV1::now_ms);
        self.queue.present(surface_texture);
        if let Some(recorder) = &mut recorder {
            recorder.phases.present = PhaseSampleV1::from_optional_ms(
                clock.and_then(|clock| clock.elapsed_ms(present_started)),
                CLOCK_UNAVAILABLE_REASON_V1,
            );
        }
        if suboptimal {
            // Post-present reconfiguration is its own explicit additive phase
            // so a suboptimal frame's extra work never hides in the residual.
            let reconfigure_started = clock.and_then(WorkerClockV1::now_ms);
            self.force_configure_for_viewport(&viewport);
            if let Some(recorder) = &mut recorder {
                recorder.phases.post_present_reconfigure = PhaseSampleV1::from_optional_ms(
                    clock.and_then(|clock| clock.elapsed_ms(reconfigure_started)),
                    CLOCK_UNAVAILABLE_REASON_V1,
                );
            }
        }
        if let Some(recorder) = &mut recorder {
            // Cache outcome and count derive from the reconfigurations that
            // actually happened this frame, including the outdated-retry and
            // suboptimal paths above; a hit requires zero reconfigurations.
            finalize_surface_configuration_evidence(recorder, self.frame_surface_configurations);
        }
        Ok(suboptimal)
    }

    /// Awaits `GPUQueue.onSubmittedWorkDone` through the raw browser handle.
    ///
    /// Resolution proves the queue finished the submitted GPU work; it says
    /// nothing about browser compositing of the presented canvas. Lookup and
    /// shape validation are deliberately separated from invocation: a missing
    /// or non-callable method (or a non-Promise return) is genuinely
    /// `Unobservable`, while a synchronous throw from the ACTUAL method call
    /// is an explicit queue observation failure classified `Rejected`, so it
    /// fails the frame exactly like a rejected promise.
    async fn await_submitted_work_done(&self) -> Result<(), FenceObservationFailureV1> {
        let raw_device = raw_webgpu_device(&self.device).map_err(|failure| {
            classify_fence_observation_failure(FenceObservationStepV1::ApiShape, failure.message)
        })?;
        let queue =
            js_sys::Reflect::get(&raw_device, &JsValue::from_str("queue")).map_err(|error| {
                classify_fence_observation_failure(
                    FenceObservationStepV1::ApiShape,
                    format!(
                        "could not access the WebGPU queue: {}",
                        js_error_message(&error)
                    ),
                )
            })?;
        if queue.is_undefined() || queue.is_null() {
            return Err(classify_fence_observation_failure(
                FenceObservationStepV1::ApiShape,
                "the WebGPU queue handle is unavailable".to_owned(),
            ));
        }
        // Step 1: lookup and callable-type validation only — no invocation.
        let method = js_sys::Reflect::get(&queue, &JsValue::from_str("onSubmittedWorkDone"))
            .ok()
            .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
            .ok_or_else(|| {
                classify_fence_observation_failure(
                    FenceObservationStepV1::ApiShape,
                    "onSubmittedWorkDone is missing or not callable on the WebGPU queue".to_owned(),
                )
            })?;
        // Step 2: invocation. A synchronous throw from the callable method is
        // an explicit observation failure, never "unobservable".
        let returned = method.call0(&queue).map_err(|error| {
            classify_fence_observation_failure(
                FenceObservationStepV1::SynchronousThrow,
                format!(
                    "onSubmittedWorkDone threw synchronously: {}",
                    js_error_message(&error)
                ),
            )
        })?;
        // Step 3: return-shape validation — a non-Promise return means the
        // platform surface cannot be observed as a fence.
        let promise = returned.dyn_into::<js_sys::Promise>().map_err(|_| {
            classify_fence_observation_failure(
                FenceObservationStepV1::ApiShape,
                "onSubmittedWorkDone did not return a Promise".to_owned(),
            )
        })?;
        // Step 4: the awaited fence itself.
        JsFuture::from(promise).await.map(|_| ()).map_err(|error| {
            classify_fence_observation_failure(
                FenceObservationStepV1::PromiseRejection,
                js_error_message(&error),
            )
        })
    }

    fn acquire_surface_texture(
        &mut self,
        viewport: &ViewportV1,
    ) -> Result<(wgpu::SurfaceTexture, bool), RuntimeFailureV1> {
        match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(texture) => Ok((texture, false)),
            wgpu::CurrentSurfaceTexture::Suboptimal(texture) => Ok((texture, true)),
            wgpu::CurrentSurfaceTexture::Outdated => {
                self.force_configure_for_viewport(viewport);
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(texture) => Ok((texture, false)),
                    wgpu::CurrentSurfaceTexture::Suboptimal(texture) => Ok((texture, true)),
                    wgpu::CurrentSurfaceTexture::Outdated => Err(RuntimeFailureV1 {
                        code: CanvasRenderErrorCodeV1::SurfaceOutdated,
                        message: "surface remained outdated after one reconfiguration".to_owned(),
                    }),
                    wgpu::CurrentSurfaceTexture::Lost => Err(self.record_terminal_surface_failure(
                        CanvasRenderErrorCodeV1::SurfaceLost,
                        "surface was lost while retrying an outdated frame",
                    )),
                    wgpu::CurrentSurfaceTexture::Validation => Err(self
                        .record_terminal_surface_failure(
                            CanvasRenderErrorCodeV1::SurfaceValidation,
                            "surface acquisition raised a validation error after reconfiguration",
                        )),
                    wgpu::CurrentSurfaceTexture::Timeout => Err(RuntimeFailureV1 {
                        code: CanvasRenderErrorCodeV1::SurfaceTimeout,
                        message: "surface acquisition timed out after reconfiguration".to_owned(),
                    }),
                    wgpu::CurrentSurfaceTexture::Occluded => Err(RuntimeFailureV1 {
                        code: CanvasRenderErrorCodeV1::SurfaceOccluded,
                        message: "surface was occluded after reconfiguration".to_owned(),
                    }),
                }
            }
            wgpu::CurrentSurfaceTexture::Lost => Err(self.record_terminal_surface_failure(
                CanvasRenderErrorCodeV1::SurfaceLost,
                "surface was lost and must be recreated",
            )),
            wgpu::CurrentSurfaceTexture::Validation => Err(self.record_terminal_surface_failure(
                CanvasRenderErrorCodeV1::SurfaceValidation,
                "surface acquisition raised a validation error",
            )),
            wgpu::CurrentSurfaceTexture::Timeout => Err(RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::SurfaceTimeout,
                message: "surface acquisition timed out".to_owned(),
            }),
            wgpu::CurrentSurfaceTexture::Occluded => Err(RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::SurfaceOccluded,
                message: "surface is occluded".to_owned(),
            }),
        }
    }

    fn ensure_configured_for_viewport(&mut self, viewport: &ViewportV1) {
        if !surface_configuration_required(self.configured_viewport.as_ref(), viewport, false) {
            return;
        }
        self.force_configure_for_viewport(viewport);
    }

    fn force_configure_for_viewport(&mut self, viewport: &ViewportV1) {
        self.frame_surface_configurations = self
            .frame_surface_configurations
            .and_then(|count| count.checked_add(1));
        self.surface_config.width = viewport.width_px;
        self.surface_config.height = viewport.height_px;
        // The wgpu WebGPU backend applies these configuration dimensions to
        // the OffscreenCanvas backing store before configuring GPUCanvasContext.
        self.surface.configure(&self.device, &self.surface_config);
        self.configured_viewport = Some(viewport.clone());
    }

    fn current_terminal_failure(&mut self) -> Option<RuntimeFailureV1> {
        let failure = read_shared_failure(&self.device_lost)
            .or_else(|| read_shared_failure(&self.uncaptured_gpu_failure))
            .or_else(|| self.terminal_surface_failure.clone())
            .or_else(|| read_deferred_gpu_scope_failure(&self.deferred_scope_state));
        if failure.is_some() {
            self.prepared_geometry_cache.clear();
        }
        failure
    }

    fn record_terminal_surface_failure(
        &mut self,
        code: CanvasRenderErrorCodeV1,
        message: &str,
    ) -> RuntimeFailureV1 {
        let failure = RuntimeFailureV1 {
            code,
            message: message.to_owned(),
        };
        self.terminal_surface_failure = Some(failure.clone());
        failure
    }
}

fn call_js_method_zero(target: &JsValue, name: &str) -> Result<JsValue, JsValue> {
    let function =
        js_sys::Reflect::get(target, &JsValue::from_str(name))?.dyn_into::<js_sys::Function>()?;
    function.call0(target)
}

fn call_js_method_one(
    target: &JsValue,
    name: &str,
    argument: &JsValue,
) -> Result<JsValue, JsValue> {
    let function =
        js_sys::Reflect::get(target, &JsValue::from_str(name))?.dyn_into::<js_sys::Function>()?;
    function.call1(target, argument)
}

fn call_js_method_two(
    target: &JsValue,
    name: &str,
    first: &JsValue,
    second: &JsValue,
) -> Result<JsValue, JsValue> {
    let function =
        js_sys::Reflect::get(target, &JsValue::from_str(name))?.dyn_into::<js_sys::Function>()?;
    function.call2(target, first, second)
}

fn raw_webgpu_device(device: &wgpu::Device) -> Result<JsValue, RuntimeFailureV1> {
    device
        .as_webgpu()
        .ok_or_else(|| RuntimeFailureV1 {
            code: CanvasRenderErrorCodeV1::GpuInternal,
            message: "WebGPU device handle is unavailable".to_owned(),
        })
        .map(|device| device.clone().into())
}

fn begin_pop_raw_error_scope(raw_device: &JsValue) -> PendingRawErrorScopeV1 {
    match call_js_method_zero(raw_device, "popErrorScope")
        .and_then(wasm_bindgen::JsCast::dyn_into::<js_sys::Promise>)
    {
        Ok(promise) => PendingRawErrorScopeV1::Promise(promise),
        Err(error) => PendingRawErrorScopeV1::Rejected(RuntimeFailureV1 {
            code: CanvasRenderErrorCodeV1::GpuInternal,
            message: format!(
                "could not pop WebGPU error scope: {}",
                js_error_message(&error)
            ),
        }),
    }
}

fn runtime_failure_from_js_gpu_error(error: &JsValue) -> RuntimeFailureV1 {
    let class_name = js_error_class_name(error).unwrap_or_default();
    RuntimeFailureV1 {
        code: gpu_error_code_from_js_class_name(&class_name),
        message: js_error_message(error),
    }
}

fn reflected_string(value: &JsValue, property: &str) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str(property))
        .ok()
        .and_then(|value| value.as_string())
}

fn reflected_constructor_name(value: &JsValue) -> Option<String> {
    js_sys::Reflect::get(value, &JsValue::from_str("constructor"))
        .ok()
        .and_then(|constructor| reflected_string(&constructor, "name"))
}

fn js_error_class_name(error: &JsValue) -> Option<String> {
    reflected_string(error, "name")
        .filter(|name| !name.is_empty())
        .or_else(|| reflected_constructor_name(error).filter(|name| !name.is_empty()))
}

fn js_error_message(error: &JsValue) -> String {
    let name = js_error_class_name(error).unwrap_or_else(|| "WebGPUError".to_owned());
    let message = reflected_string(error, "message")
        .or_else(|| error.as_string())
        .unwrap_or_else(|| "WebGPU operation failed".to_owned());
    format!("{name}: {message}")
}

fn shared_failure() -> SharedFailureV1 {
    Arc::new(Mutex::new(None))
}

fn install_device_lost_handler(device: &wgpu::Device) -> SharedFailureV1 {
    let device_lost = shared_failure();
    let device_lost_callback = Arc::clone(&device_lost);
    device.set_device_lost_callback(move |reason, message| {
        retain_first_failure(
            &device_lost_callback,
            RuntimeFailureV1 {
                code: CanvasRenderErrorCodeV1::DeviceLost,
                message: format!("WebGPU device lost ({reason:?}): {message}"),
            },
        );
    });

    device_lost
}

fn select_surface_capabilities(
    capabilities: &wgpu::SurfaceCapabilities,
) -> Result<SurfaceSelectionV1, JsValue> {
    let surface_format = capabilities
        .formats
        .iter()
        .copied()
        .find(|format| {
            matches!(
                format,
                wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Rgba8Unorm
            )
        })
        .ok_or_else(|| {
            renderer_unavailable("surface does not expose a base BGRA8Unorm or RGBA8Unorm format")
        })?;
    if !capabilities
        .usages
        .contains(wgpu::TextureUsages::RENDER_ATTACHMENT)
    {
        return Err(renderer_unavailable(
            "surface does not support render attachments",
        ));
    }
    if !capabilities
        .present_modes
        .contains(&wgpu::PresentMode::Fifo)
    {
        return Err(renderer_unavailable(
            "surface does not support FIFO presentation",
        ));
    }
    let alpha_mode = capabilities
        .alpha_modes
        .iter()
        .copied()
        .find(|mode| {
            matches!(
                mode,
                wgpu::CompositeAlphaMode::Auto
                    | wgpu::CompositeAlphaMode::Opaque
                    | wgpu::CompositeAlphaMode::PreMultiplied
            )
        })
        .ok_or_else(|| renderer_unavailable("surface does not expose an alpha mode"))?;
    Ok(SurfaceSelectionV1 {
        alpha_mode,
        surface_format,
        view_format: surface_format.add_srgb_suffix(),
    })
}

fn retain_first_failure(shared: &SharedFailureV1, failure: RuntimeFailureV1) {
    let mut current = shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if current.is_none() {
        *current = Some(failure);
    }
}

fn read_shared_failure(shared: &SharedFailureV1) -> Option<RuntimeFailureV1> {
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn begin_deferred_gpu_scope_batch(shared: &SharedDeferredGpuScopeStateV1) -> bool {
    let mut state = shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if state.pending {
        return false;
    }
    state.pending = true;
    true
}

fn complete_deferred_gpu_scope_batch(
    shared: &SharedDeferredGpuScopeStateV1,
    failure: Option<RuntimeFailureV1>,
) {
    let mut state = shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if state.failure.is_none() {
        state.failure = failure;
    }
    // Publish the failure before reopening the slot. A later render therefore
    // observes either the terminal error or an available batch, never a gap in
    // which another detached scope task could be created first.
    state.pending = false;
}

fn retain_deferred_gpu_scope_failure(
    shared: &SharedDeferredGpuScopeStateV1,
    failure: RuntimeFailureV1,
) {
    let mut state = shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if state.failure.is_none() {
        state.failure = Some(failure);
    }
}

fn read_deferred_gpu_scope_failure(
    shared: &SharedDeferredGpuScopeStateV1,
) -> Option<RuntimeFailureV1> {
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .failure
        .clone()
}

fn named_js_error(name: &str, message: &str) -> JsValue {
    let error = js_sys::Error::new(message);
    error.set_name(name);
    error.into()
}

/// Builds bounded evidence from `GPUDevice.adapterInfo` for the device this
/// worker actually created, never from a second page/Worker adapter request,
/// plus the exact device request and surface selection. The raw browser handle
/// retains the privacy-safe vendor and architecture strings that wgpu's native
/// shaped `AdapterInfo` deliberately discards.
fn build_adapter_evidence(
    adapter_info: &wgpu::AdapterInfo,
    browser_architecture: &str,
    browser_vendor: &str,
    device_descriptor: &wgpu::DeviceDescriptor<'_>,
    selection: &SurfaceSelectionV1,
) -> CanvasAdapterEvidenceV1 {
    CanvasAdapterEvidenceV1::new(
        AdapterEvidenceV1 {
            backend: bounded_evidence_string(&format!("{:?}", adapter_info.backend)),
            browser_architecture: bounded_evidence_string(browser_architecture),
            browser_vendor: bounded_evidence_string(browser_vendor),
            device_id: adapter_info.device,
            device_type: bounded_evidence_string(&format!("{:?}", adapter_info.device_type)),
            driver: bounded_evidence_string(&adapter_info.driver),
            driver_info: bounded_evidence_string(&adapter_info.driver_info),
            name: bounded_evidence_string(&adapter_info.name),
            source: AdapterEvidenceSourceV1::WorkerWgpuAdapterInfo,
            subgroup_max_size: adapter_info.subgroup_max_size,
            subgroup_min_size: adapter_info.subgroup_min_size,
            vendor_id: adapter_info.vendor,
        },
        DeviceEvidenceV1 {
            label: bounded_evidence_string(device_descriptor.label.unwrap_or("unlabeled")),
            requested_features: bounded_evidence_dump(&format!(
                "{:?}",
                device_descriptor.required_features
            )),
            requested_limits: bounded_evidence_dump(&format!(
                "{:?}",
                device_descriptor.required_limits
            )),
        },
        SurfaceEvidenceV1 {
            alpha_mode: bounded_evidence_string(&format!("{:?}", selection.alpha_mode)),
            present_mode: bounded_evidence_string(&format!("{:?}", wgpu::PresentMode::Fifo)),
            surface_format: bounded_evidence_string(&format!("{:?}", selection.surface_format)),
            view_format: bounded_evidence_string(&format!("{:?}", selection.view_format)),
        },
    )
}

fn renderer_unavailable(message: &str) -> JsValue {
    named_js_error(RENDERER_UNAVAILABLE_ERROR_NAME, message)
}
