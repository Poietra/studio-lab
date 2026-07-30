//! Opt-in per-frame stage telemetry and adapter evidence wire formats.
//!
//! These responses are only produced by the explicit telemetry ABI
//! (`renderWithTelemetry` / `adapterEvidence`). The normal canvas render
//! response stays compact and is untouched by this module.

use poietra_scene_ir::ContractVersionV1;
use serde::Serialize;

use crate::bounded_writer::BoundedWriter;
use crate::canvas_protocol::{CanvasRenderResultV1, truncate_utf16};

/// Telemetry acknowledgements stay bounded like every other worker response.
pub const MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES_V1: usize = 32 * 1024;
/// Adapter evidence is a handful of bounded identification strings plus the
/// requested device features/limits dumps.
pub const MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES_V1: usize = 8 * 1024;
/// Telemetry render ABI version, independent of the base canvas ABI.
pub const POIETRA_CANVAS_TELEMETRY_ABI_VERSION_V1: u32 = 1;

const MAX_EVIDENCE_STRING_UTF16_UNITS_V1: usize = 256;
const MAX_EVIDENCE_DUMP_UTF16_UNITS_V1: usize = 1_000;
const MAX_PHASE_REASON_UTF16_UNITS_V1: usize = 500;

#[derive(Clone, Copy, Debug, Serialize)]
enum CanvasRenderTelemetryResponseSchemaV1 {
    #[serde(rename = "poietra.canvas-render-telemetry-response")]
    CanvasRenderTelemetryResponse,
}

#[derive(Clone, Copy, Debug, Serialize)]
enum CanvasAdapterEvidenceSchemaV1 {
    #[serde(rename = "poietra.canvas-adapter-evidence")]
    CanvasAdapterEvidence,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum CanvasAdapterEvidenceAvailabilityV1 {
    Available,
}

/// One phase observation. `Measured` values are wall-clock milliseconds on the
/// worker thread; `Unavailable` names why the phase could not be observed
/// (architecture, missing clock, or an invalid clock interval); `Skipped`
/// marks phases that did not execute for this frame, either after an earlier
/// failure or because the frame had no such work.
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PhaseSampleV1 {
    Measured { ms: f64 },
    Skipped,
    Unavailable { reason: String },
}

pub(crate) const INVALID_CLOCK_INTERVAL_REASON_V1: &str =
    "the worker clock reported a negative, non-finite, or non-monotonic interval";
pub(crate) const CLOCK_UNAVAILABLE_REASON_V1: &str =
    "worker performance.now() is unavailable in this worker scope";

impl PhaseSampleV1 {
    /// The only constructor for `Measured`: a negative or non-finite interval
    /// is recorded as `Unavailable` so a broken clock can never look healthy.
    pub(crate) fn from_optional_ms(ms: Option<f64>, unavailable_reason: &str) -> Self {
        match ms {
            Some(value) if value.is_finite() && value >= 0.0 => Self::Measured { ms: value },
            Some(_) => Self::unavailable(INVALID_CLOCK_INTERVAL_REASON_V1),
            None => Self::unavailable(unavailable_reason),
        }
    }

    pub(crate) fn unavailable(reason: &str) -> Self {
        Self::Unavailable {
            reason: truncate_utf16(reason, MAX_PHASE_REASON_UTF16_UNITS_V1),
        }
    }
}

/// Maps one GPU-path stage observation to a phase sample.
///
/// `Skipped` is reserved for stages that genuinely did not execute. A stage
/// that executed but produced no interval (clock probe returned nothing) is
/// `Unavailable`, and an executed stage with an invalid interval is
/// `Unavailable` with the invalid-clock reason — an unmeasurable execution
/// must never be misfiled as "did not run".
pub(crate) fn stage_phase_sample(executed: bool, raw_interval_ms: Option<f64>) -> PhaseSampleV1 {
    if !executed {
        return PhaseSampleV1::Skipped;
    }
    match raw_interval_ms {
        Some(raw) => PhaseSampleV1::from_optional_ms(Some(raw), CLOCK_UNAVAILABLE_REASON_V1),
        None => PhaseSampleV1::unavailable(CLOCK_UNAVAILABLE_REASON_V1),
    }
}

/// Derives the surface-configuration cache outcome and count from the actual
/// per-frame reconfiguration counter.
///
/// A `hit` means the frame completed without any surface reconfiguration —
/// including the outdated-retry and suboptimal paths, which reconfigure and
/// therefore report `miss`. A `None` counter means the checked counter
/// overflowed: at least one reconfiguration definitely happened (so the
/// outcome is still truthfully `miss`) but the count itself is reported as
/// explicitly unavailable rather than a silently saturated number.
pub(crate) fn surface_configuration_evidence(
    configurations: Option<u32>,
) -> (CacheOutcomeV1, Option<u64>) {
    match configurations {
        Some(0) => (CacheOutcomeV1::Hit, Some(0)),
        Some(count) => (CacheOutcomeV1::Miss, Some(u64::from(count))),
        None => (CacheOutcomeV1::Miss, None),
    }
}

/// Writes the surface-configuration cache outcome and count into a frame's
/// telemetry.
///
/// This finalizer MUST run on every exit path that reached the per-frame
/// configuration counter — successful presentation, surface-acquisition
/// failure (including the outdated-retry second attempt), and renderer/stage
/// failure after acquisition — so an executed configuration can never be
/// serialized as `skipped`/`null`. Only failures BEFORE the surface section
/// (evaluate/prepare/tessellate errors, terminal pre-checks) legitimately
/// leave the skipped defaults in place by never calling this.
pub(crate) fn finalize_surface_configuration_evidence(
    telemetry: &mut FrameTelemetryV1,
    configurations: Option<u32>,
) {
    let (outcome, count) = surface_configuration_evidence(configurations);
    telemetry.caches.surface_configuration = outcome;
    telemetry.counts.surface_configurations = count;
}

/// How an attempted `GPUQueue.onSubmittedWorkDone` observation failed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FenceObservationFailureV1 {
    /// The fence promise itself rejected: the queue reported a real failure.
    Rejected { reason: String },
    /// The API surface needed to observe the fence is missing on this
    /// platform (no raw device/queue handle, or no promise-returning method).
    Unobservable { reason: String },
}

/// Which step of the fence observation failed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FenceObservationStepV1 {
    /// Lookup/shape validation: the handle chain is missing, the method is
    /// absent or not callable, or the call did not return a Promise. The
    /// fence genuinely cannot be observed on this platform surface.
    ApiShape,
    /// The returned promise rejected: the queue reported a real failure.
    PromiseRejection,
    /// The callable method threw synchronously when invoked: an explicit
    /// queue observation failure, not a missing API.
    SynchronousThrow,
}

/// Maps a fence-observation step failure to its policy category.
///
/// Only lookup/shape failures may claim `Unobservable`. A synchronous throw
/// from the ACTUAL method call is treated exactly like a rejected promise —
/// `Rejected` — so it always follows the fail-frame path and can never hide
/// behind a presented frame with an unavailable phase, even when the
/// device-lost callback has not fired yet.
pub(crate) fn classify_fence_observation_failure(
    step: FenceObservationStepV1,
    reason: String,
) -> FenceObservationFailureV1 {
    match step {
        FenceObservationStepV1::ApiShape => FenceObservationFailureV1::Unobservable { reason },
        FenceObservationStepV1::PromiseRejection | FenceObservationStepV1::SynchronousThrow => {
            FenceObservationFailureV1::Rejected { reason }
        }
    }
}

/// What a telemetry frame must do after a failed fence observation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum FenceFailurePolicyV1 {
    /// Fail the frame as a render error; never report it as presented.
    FailFrame { message: String },
    /// Present the frame with the fence phase explicitly unavailable.
    PresentWithUnavailablePhase { reason: String },
}

/// Fail-closed policy for fence-observation failures.
///
/// An explicit promise rejection ALWAYS fails the frame — even when the
/// device-lost callback has not fired yet, so a late terminal callback can
/// never hide the failure behind a "presented" acknowledgement. Only a
/// genuinely unobservable fence API (and no known terminal failure) may
/// present with an unavailable phase.
pub(crate) fn fence_failure_policy(
    failure: &FenceObservationFailureV1,
    has_terminal_failure: bool,
) -> FenceFailurePolicyV1 {
    match failure {
        FenceObservationFailureV1::Rejected { reason } => FenceFailurePolicyV1::FailFrame {
            message: format!("the GPUQueue.onSubmittedWorkDone fence rejected: {reason}"),
        },
        FenceObservationFailureV1::Unobservable { reason } if has_terminal_failure => {
            FenceFailurePolicyV1::FailFrame {
                message: format!(
                    "the GPUQueue.onSubmittedWorkDone fence is unobservable and the device \
                     reported a terminal failure: {reason}"
                ),
            }
        }
        FenceObservationFailureV1::Unobservable { reason } => {
            FenceFailurePolicyV1::PresentWithUnavailablePhase {
                reason: format!("the GPUQueue.onSubmittedWorkDone fence is unobservable: {reason}"),
            }
        }
    }
}

/// Normalizes a raw wall-clock duration for the `totalMs` field.
///
/// A negative or non-finite raw difference (broken clock) becomes an explicit
/// `None` — the nullable wire representation of "unavailable" — so the
/// response always stays schema-valid: a negative value would violate the
/// consumer schema and a NaN/Infinity would corrupt JSON serialization.
pub(crate) fn normalized_duration_ms(raw: Option<f64>) -> Option<f64> {
    raw.filter(|value| value.is_finite() && *value >= 0.0)
}

/// Fixed phase map. Every phase is always present so consumers never have to
/// guess whether an absent key means "fast" or "not measured".
///
/// Naming is deliberately literal about what each interval covers:
/// `vertex_index_encode` and `buffer_create_and_stage` are CPU costs, not GPU
/// transfers; `command_encode_total` is a labeled nested total that includes
/// `draw_record`; `surface_acquire` covers surface configuration, current-
/// texture acquisition, and view creation; `gpu_error_scope_resolution` is
/// the awaited resolution of the three popped WebGPU error scopes (which can
/// block on GPU progress); `gpu_queue_submitted_work_done` is a genuinely
/// awaited `GPUQueue.onSubmittedWorkDone` fence; `gpu_execution` and
/// `browser_composite` stay unavailable because nothing observes them.
///
/// Every phase except `draw_record` (nested inside `command_encode_total`)
/// covers a pairwise non-overlapping interval, so consumers may sum them and
/// compare against `total_ms` to expose unattributed time.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrameTelemetryPhasesV1 {
    pub(crate) browser_composite: PhaseSampleV1,
    pub(crate) buffer_create_and_stage: PhaseSampleV1,
    pub(crate) command_encode_total: PhaseSampleV1,
    pub(crate) draw_record: PhaseSampleV1,
    pub(crate) evaluate: PhaseSampleV1,
    pub(crate) gpu_error_scope_resolution: PhaseSampleV1,
    pub(crate) gpu_execution: PhaseSampleV1,
    pub(crate) gpu_queue_submitted_work_done: PhaseSampleV1,
    /// Post-present surface reconfiguration after a suboptimal acquisition;
    /// executes (and is measured) only on suboptimal frames.
    pub(crate) post_present_reconfigure: PhaseSampleV1,
    pub(crate) prepare: PhaseSampleV1,
    pub(crate) present: PhaseSampleV1,
    pub(crate) submit: PhaseSampleV1,
    pub(crate) surface_acquire: PhaseSampleV1,
    pub(crate) tessellate: PhaseSampleV1,
    pub(crate) vertex_index_encode: PhaseSampleV1,
}

pub(crate) const BROWSER_COMPOSITE_UNAVAILABLE_REASON_V1: &str = "The dedicated worker cannot \
observe browser compositor presentation; only the embedding page could approximate it.";
pub(crate) const GPU_EXECUTION_UNAVAILABLE_REASON_V1: &str = "GPU-side execution timing requires \
timestamp queries, which this pipeline does not request; only the awaited queue \
onSubmittedWorkDone fence is observed.";

impl FrameTelemetryPhasesV1 {
    pub(crate) fn all_skipped() -> Self {
        Self {
            browser_composite: PhaseSampleV1::unavailable(BROWSER_COMPOSITE_UNAVAILABLE_REASON_V1),
            buffer_create_and_stage: PhaseSampleV1::Skipped,
            command_encode_total: PhaseSampleV1::Skipped,
            draw_record: PhaseSampleV1::Skipped,
            evaluate: PhaseSampleV1::Skipped,
            gpu_error_scope_resolution: PhaseSampleV1::Skipped,
            gpu_execution: PhaseSampleV1::unavailable(GPU_EXECUTION_UNAVAILABLE_REASON_V1),
            gpu_queue_submitted_work_done: PhaseSampleV1::Skipped,
            post_present_reconfigure: PhaseSampleV1::Skipped,
            prepare: PhaseSampleV1::Skipped,
            present: PhaseSampleV1::Skipped,
            submit: PhaseSampleV1::Skipped,
            surface_acquire: PhaseSampleV1::Skipped,
            tessellate: PhaseSampleV1::Skipped,
            vertex_index_encode: PhaseSampleV1::Skipped,
        }
    }
}

/// Per-frame work counts. `None` means the pipeline failed before the count
/// was known, never zero work.
#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrameTelemetryCountsV1 {
    pub(crate) buffer_creations: Option<u64>,
    pub(crate) draw_calls: Option<u64>,
    pub(crate) evaluated_draws: Option<u64>,
    pub(crate) evaluated_entities: Option<u64>,
    pub(crate) image_sampler_binding_creations: Option<u64>,
    pub(crate) image_texture_evictions: Option<u64>,
    pub(crate) image_texture_uploads: Option<u64>,
    pub(crate) surface_configurations: Option<u64>,
    /// Per-draw tessellation operations counted at the tessellation call
    /// sites, never inferred from vertex or index totals.
    pub(crate) tessellation_calls: Option<u64>,
    pub(crate) tessellated_indices: Option<u64>,
    pub(crate) tessellated_vertices: Option<u64>,
    pub(crate) upload_bytes: Option<u64>,
}

/// Per-frame cache outcomes for the caches that exist in this pipeline.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CacheOutcomeV1 {
    Hit,
    Miss,
    /// Created once per session and reused without a per-frame lookup.
    Retained,
    /// The frame failed before the cache was consulted.
    Skipped,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrameTelemetryCachesV1 {
    pub(crate) image_sampler_binding: CacheOutcomeV1,
    pub(crate) image_texture: CacheOutcomeV1,
    pub(crate) pipeline: CacheOutcomeV1,
    pub(crate) prepared_geometry: CacheOutcomeV1,
    pub(crate) surface_configuration: CacheOutcomeV1,
}

impl FrameTelemetryCachesV1 {
    pub(crate) fn skipped() -> Self {
        Self {
            image_sampler_binding: CacheOutcomeV1::Skipped,
            image_texture: CacheOutcomeV1::Skipped,
            pipeline: CacheOutcomeV1::Retained,
            prepared_geometry: CacheOutcomeV1::Skipped,
            surface_configuration: CacheOutcomeV1::Skipped,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum TelemetryClockSourceV1 {
    Unavailable,
    WorkerPerformanceNow,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FrameTelemetryV1 {
    pub(crate) caches: FrameTelemetryCachesV1,
    pub(crate) clock: TelemetryClockSourceV1,
    pub(crate) counts: FrameTelemetryCountsV1,
    pub(crate) phases: FrameTelemetryPhasesV1,
    pub(crate) total_ms: Option<f64>,
}

impl FrameTelemetryV1 {
    pub(crate) fn new(clock: TelemetryClockSourceV1) -> Self {
        Self {
            caches: FrameTelemetryCachesV1::skipped(),
            clock,
            counts: FrameTelemetryCountsV1::default(),
            phases: FrameTelemetryPhasesV1::all_skipped(),
            total_ms: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanvasRenderTelemetryResponseV1 {
    result: CanvasRenderResultV1,
    schema: CanvasRenderTelemetryResponseSchemaV1,
    telemetry: FrameTelemetryV1,
    version: ContractVersionV1,
}

/// Bounded adapter and surface identification captured inside the worker.
///
/// Fields come from the worker's own wgpu adapter, never from the page-level
/// `navigator.gpu` hint, and stay truncated to safe identification strings.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdapterEvidenceV1 {
    pub(crate) backend: String,
    pub(crate) device_id: u32,
    pub(crate) device_type: String,
    pub(crate) driver: String,
    pub(crate) driver_info: String,
    pub(crate) name: String,
    pub(crate) source: AdapterEvidenceSourceV1,
    pub(crate) subgroup_max_size: u32,
    pub(crate) subgroup_min_size: u32,
    pub(crate) vendor_id: u32,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AdapterEvidenceSourceV1 {
    WorkerWgpuAdapterInfo,
}

/// What the worker actually requested when creating its WebGPU device.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeviceEvidenceV1 {
    pub(crate) label: String,
    pub(crate) requested_features: String,
    pub(crate) requested_limits: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SurfaceEvidenceV1 {
    pub(crate) alpha_mode: String,
    pub(crate) present_mode: String,
    pub(crate) surface_format: String,
    pub(crate) view_format: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CanvasAdapterEvidenceV1 {
    pub(crate) adapter: AdapterEvidenceV1,
    pub(crate) device: DeviceEvidenceV1,
    kind: CanvasAdapterEvidenceAvailabilityV1,
    schema: CanvasAdapterEvidenceSchemaV1,
    pub(crate) surface: SurfaceEvidenceV1,
    version: ContractVersionV1,
}

pub(crate) fn bounded_evidence_string(value: &str) -> String {
    truncate_utf16(value, MAX_EVIDENCE_STRING_UTF16_UNITS_V1)
}

/// Longer bound for structured debug dumps such as requested device limits.
pub(crate) fn bounded_evidence_dump(value: &str) -> String {
    truncate_utf16(value, MAX_EVIDENCE_DUMP_UTF16_UNITS_V1)
}

impl CanvasAdapterEvidenceV1 {
    pub(crate) fn new(
        adapter: AdapterEvidenceV1,
        device: DeviceEvidenceV1,
        surface: SurfaceEvidenceV1,
    ) -> Self {
        Self {
            adapter,
            device,
            kind: CanvasAdapterEvidenceAvailabilityV1::Available,
            schema: CanvasAdapterEvidenceSchemaV1::CanvasAdapterEvidence,
            surface,
            version: ContractVersionV1,
        }
    }
}

/// Last-resort static fallback. It MUST stay a schema-valid telemetry
/// response whose `telemetry` object is semantically identical to
/// `FrameTelemetryV1::new(TelemetryClockSourceV1::Unavailable)`: in
/// particular, `browserComposite` and `gpuExecution` are architecturally
/// unobservable and therefore `unavailable` with their bounded reasons, never
/// `skipped`. A Rust test asserts deep equality with the constructor output
/// and a TypeScript protocol test parses this exact document.
pub(crate) const TELEMETRY_SERIALIZATION_FALLBACK_V1: &[u8] = br#"{"result":{"kind":"error","code":"serialization-failed","message":"Canvas telemetry response serialization failed","packetId":null,"sampleTime":null,"viewport":null},"schema":"poietra.canvas-render-telemetry-response","telemetry":{"caches":{"imageSamplerBinding":"skipped","imageTexture":"skipped","pipeline":"retained","preparedGeometry":"skipped","surfaceConfiguration":"skipped"},"clock":"unavailable","counts":{"bufferCreations":null,"drawCalls":null,"evaluatedDraws":null,"evaluatedEntities":null,"imageSamplerBindingCreations":null,"imageTextureEvictions":null,"imageTextureUploads":null,"surfaceConfigurations":null,"tessellationCalls":null,"tessellatedIndices":null,"tessellatedVertices":null,"uploadBytes":null},"phases":{"browserComposite":{"kind":"unavailable","reason":"The dedicated worker cannot observe browser compositor presentation; only the embedding page could approximate it."},"bufferCreateAndStage":{"kind":"skipped"},"commandEncodeTotal":{"kind":"skipped"},"drawRecord":{"kind":"skipped"},"evaluate":{"kind":"skipped"},"gpuErrorScopeResolution":{"kind":"skipped"},"gpuExecution":{"kind":"unavailable","reason":"GPU-side execution timing requires timestamp queries, which this pipeline does not request; only the awaited queue onSubmittedWorkDone fence is observed."},"gpuQueueSubmittedWorkDone":{"kind":"skipped"},"postPresentReconfigure":{"kind":"skipped"},"prepare":{"kind":"skipped"},"present":{"kind":"skipped"},"submit":{"kind":"skipped"},"surfaceAcquire":{"kind":"skipped"},"tessellate":{"kind":"skipped"},"vertexIndexEncode":{"kind":"skipped"}},"totalMs":null},"version":1}"#;

/// Serializes one telemetry acknowledgement within the bounded envelope.
///
/// On overflow or serialization failure the response degrades first to a
/// minimal but still schema-valid telemetry error document, and only then to
/// the static fallback — `telemetry` is always a contract-valid object.
pub(crate) fn telemetry_response(
    result: CanvasRenderResultV1,
    telemetry: FrameTelemetryV1,
) -> Vec<u8> {
    let response = CanvasRenderTelemetryResponseV1 {
        result,
        schema: CanvasRenderTelemetryResponseSchemaV1::CanvasRenderTelemetryResponse,
        telemetry,
        version: ContractVersionV1,
    };
    let mut writer = BoundedWriter::new(MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, &response).is_ok() {
        return writer.into_bytes();
    }
    let minimal = CanvasRenderTelemetryResponseV1 {
        result: crate::canvas_protocol::error_result(
            crate::canvas_protocol::CanvasRenderErrorCodeV1::SerializationFailed,
            "Canvas telemetry response could not be serialized within the v1 limit",
            None,
        ),
        schema: CanvasRenderTelemetryResponseSchemaV1::CanvasRenderTelemetryResponse,
        telemetry: FrameTelemetryV1::new(TelemetryClockSourceV1::Unavailable),
        version: ContractVersionV1,
    };
    serde_json::to_vec(&minimal).unwrap_or_else(|_| TELEMETRY_SERIALIZATION_FALLBACK_V1.to_vec())
}

const ADAPTER_EVIDENCE_SERIALIZATION_FALLBACK_V1: &[u8] = br#"{"kind":"unavailable","reason":"Canvas adapter evidence serialization failed","schema":"poietra.canvas-adapter-evidence","version":1}"#;

/// Serializes bounded adapter evidence, degrading to an explicit unavailable document.
pub(crate) fn adapter_evidence_response(evidence: &CanvasAdapterEvidenceV1) -> Vec<u8> {
    let mut writer = BoundedWriter::new(MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES_V1);
    if serde_json::to_writer(&mut writer, evidence).is_ok() {
        return writer.into_bytes();
    }
    ADAPTER_EVIDENCE_SERIALIZATION_FALLBACK_V1.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use poietra_scene_ir::ViewportV1;
    use serde_json::{Value, json};

    use crate::canvas_protocol::{CanvasRenderErrorCodeV1, error_result, presented_result};
    use crate::protocol::SampleRequestCorrelationV1;

    fn correlation() -> SampleRequestCorrelationV1 {
        SampleRequestCorrelationV1 {
            packet_id: "canvas:telemetry-3".to_owned(),
            sample_time: 0.5,
            viewport: ViewportV1 {
                height_px: 1_080,
                width_px: 1_920,
            },
        }
    }

    fn measured(ms: f64) -> PhaseSampleV1 {
        PhaseSampleV1::from_optional_ms(Some(ms), "unused")
    }

    fn measured_telemetry() -> FrameTelemetryV1 {
        let mut telemetry = FrameTelemetryV1::new(TelemetryClockSourceV1::WorkerPerformanceNow);
        telemetry.phases.evaluate = measured(1.25);
        telemetry.phases.vertex_index_encode = measured(0.3);
        telemetry.phases.command_encode_total = measured(0.2);
        telemetry.phases.gpu_error_scope_resolution = measured(12.0);
        telemetry.phases.gpu_queue_submitted_work_done = measured(4.0);
        telemetry.counts.evaluated_entities = Some(100);
        telemetry.counts.tessellation_calls = Some(100);
        telemetry.counts.upload_bytes = Some(40_800);
        telemetry.caches = FrameTelemetryCachesV1 {
            image_sampler_binding: CacheOutcomeV1::Hit,
            image_texture: CacheOutcomeV1::Hit,
            pipeline: CacheOutcomeV1::Retained,
            prepared_geometry: CacheOutcomeV1::Miss,
            surface_configuration: CacheOutcomeV1::Hit,
        };
        telemetry.total_ms = Some(21.5);
        telemetry
    }

    #[test]
    fn presented_telemetry_response_is_bounded_and_correlated() {
        let response = telemetry_response(
            presented_result(&correlation(), false),
            measured_telemetry(),
        );
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert!(response.len() <= MAX_CANVAS_TELEMETRY_RESPONSE_JSON_BYTES_V1);
        for (pointer, expected) in [
            ("/schema", json!("poietra.canvas-render-telemetry-response")),
            ("/version", json!(1)),
            ("/result/kind", json!("presented")),
            ("/result/packetId", json!("canvas:telemetry-3")),
            ("/telemetry/clock", json!("worker-performance-now")),
            ("/telemetry/phases/evaluate/ms", json!(1.25)),
            ("/telemetry/phases/gpuQueueSubmittedWorkDone/ms", json!(4.0)),
            ("/telemetry/phases/gpuErrorScopeResolution/ms", json!(12.0)),
            (
                "/telemetry/phases/browserComposite/kind",
                json!("unavailable"),
            ),
            ("/telemetry/phases/gpuExecution/kind", json!("unavailable")),
            (
                "/telemetry/phases/postPresentReconfigure/kind",
                json!("skipped"),
            ),
            ("/telemetry/counts/uploadBytes", json!(40_800)),
            ("/telemetry/counts/tessellationCalls", json!(100)),
            ("/telemetry/caches/surfaceConfiguration", json!("hit")),
            ("/telemetry/totalMs", json!(21.5)),
        ] {
            assert_eq!(value.pointer(pointer), Some(&expected), "{pointer}");
        }
        assert!(value["result"].get("packet").is_none());
    }

    #[test]
    fn failed_frame_keeps_partial_phases_and_null_counts() {
        let mut telemetry = FrameTelemetryV1::new(TelemetryClockSourceV1::WorkerPerformanceNow);
        telemetry.phases.evaluate = measured(1.0);
        let response = telemetry_response(
            error_result(
                CanvasRenderErrorCodeV1::UnsupportedFrame,
                "unsupported",
                Some(&correlation()),
            ),
            telemetry,
        );
        let value: Value = serde_json::from_slice(&response).unwrap();

        for (pointer, expected) in [
            ("/result/code", json!("unsupported-frame")),
            ("/telemetry/phases/evaluate/kind", json!("measured")),
            ("/telemetry/phases/tessellate/kind", json!("skipped")),
            ("/telemetry/phases/surfaceAcquire/kind", json!("skipped")),
            ("/telemetry/counts/evaluatedDraws", Value::Null),
            ("/telemetry/caches/surfaceConfiguration", json!("skipped")),
            ("/telemetry/totalMs", Value::Null),
        ] {
            assert_eq!(value.pointer(pointer), Some(&expected), "{pointer}");
        }
    }

    #[test]
    fn phase_samples_distinguish_missing_invalid_executed_and_skipped() {
        let sample = PhaseSampleV1::from_optional_ms(None, "worker performance.now is unavailable");
        let value = serde_json::to_value(&sample).unwrap();
        assert_eq!(value["kind"], "unavailable");
        assert_eq!(value["reason"], "worker performance.now is unavailable");
        for interval in [0.0, 0.75] {
            assert_eq!(
                serde_json::to_value(measured(interval)).unwrap()["ms"],
                interval
            );
        }
        for interval in [-0.001, -5.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let sample = PhaseSampleV1::from_optional_ms(Some(interval), "unused");
            let value = serde_json::to_value(&sample).unwrap();
            assert_eq!(value["kind"], "unavailable", "interval {interval}");
            assert_eq!(value["reason"], INVALID_CLOCK_INTERVAL_REASON_V1);
        }
        for (executed, interval, expected) in [
            (
                true,
                None,
                json!({"kind": "unavailable", "reason": CLOCK_UNAVAILABLE_REASON_V1}),
            ),
            (
                true,
                Some(-1.0),
                json!({"kind": "unavailable", "reason": INVALID_CLOCK_INTERVAL_REASON_V1}),
            ),
            (true, Some(0.5), json!({"kind": "measured", "ms": 0.5})),
            (false, None, json!({"kind": "skipped"})),
            (false, Some(1.0), json!({"kind": "skipped"})),
        ] {
            assert_eq!(
                serde_json::to_value(stage_phase_sample(executed, interval)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn invalid_total_durations_serialize_as_explicit_null_not_corruption() {
        assert_eq!(normalized_duration_ms(Some(2.5)), Some(2.5));
        assert_eq!(normalized_duration_ms(Some(0.0)), Some(0.0));
        assert_eq!(normalized_duration_ms(None), None);
        for raw in [-0.001, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(normalized_duration_ms(Some(raw)), None, "raw {raw}");
        }

        let mut telemetry = FrameTelemetryV1::new(TelemetryClockSourceV1::WorkerPerformanceNow);
        telemetry.total_ms = normalized_duration_ms(Some(f64::NAN));
        let response = telemetry_response(presented_result(&correlation(), false), telemetry);
        let value: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(value["schema"], "poietra.canvas-render-telemetry-response");
        assert_eq!(value["telemetry"]["totalMs"], Value::Null);
        assert_eq!(value["result"]["kind"], "presented");
    }

    #[test]
    fn serialization_fallback_is_a_schema_valid_telemetry_object() {
        let value: Value = serde_json::from_slice(TELEMETRY_SERIALIZATION_FALLBACK_V1).unwrap();
        assert_eq!(value["schema"], "poietra.canvas-render-telemetry-response");
        assert_eq!(value["result"]["code"], "serialization-failed");
        let constructor_telemetry =
            serde_json::to_value(FrameTelemetryV1::new(TelemetryClockSourceV1::Unavailable))
                .unwrap();
        assert_eq!(value["telemetry"], constructor_telemetry);
        let minimal = CanvasRenderTelemetryResponseV1 {
            result: error_result(CanvasRenderErrorCodeV1::SerializationFailed, "x", None),
            schema: CanvasRenderTelemetryResponseSchemaV1::CanvasRenderTelemetryResponse,
            telemetry: FrameTelemetryV1::new(TelemetryClockSourceV1::Unavailable),
            version: ContractVersionV1,
        };
        let bytes = serde_json::to_vec(&minimal).unwrap();
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["telemetry"], constructor_telemetry);
    }

    #[test]
    fn fence_classification_and_policy_fail_closed() {
        let shape = classify_fence_observation_failure(
            FenceObservationStepV1::ApiShape,
            "missing API".to_owned(),
        );
        assert!(matches!(
            shape,
            FenceObservationFailureV1::Unobservable { .. }
        ));
        assert!(matches!(
            fence_failure_policy(&shape, false),
            FenceFailurePolicyV1::PresentWithUnavailablePhase { .. }
        ));
        assert!(matches!(
            fence_failure_policy(&shape, true),
            FenceFailurePolicyV1::FailFrame { .. }
        ));
        for step in [
            FenceObservationStepV1::SynchronousThrow,
            FenceObservationStepV1::PromiseRejection,
        ] {
            let rejected = classify_fence_observation_failure(step, "queue failure".to_owned());
            assert!(matches!(
                rejected,
                FenceObservationFailureV1::Rejected { .. }
            ));
            for terminal in [false, true] {
                assert!(matches!(
                    fence_failure_policy(&rejected, terminal),
                    FenceFailurePolicyV1::FailFrame { .. }
                ));
            }
        }
    }

    #[test]
    fn surface_evidence_finalization_covers_every_distinct_count_case() {
        for (configurations, expected) in [
            (Some(0), (CacheOutcomeV1::Hit, Some(0))),
            (Some(1), (CacheOutcomeV1::Miss, Some(1))),
            (Some(2), (CacheOutcomeV1::Miss, Some(2))),
            (None, (CacheOutcomeV1::Miss, None)),
        ] {
            assert_eq!(surface_configuration_evidence(configurations), expected);
        }
        let mut telemetry = FrameTelemetryV1::new(TelemetryClockSourceV1::WorkerPerformanceNow);
        telemetry.phases.surface_acquire = measured(0.3);
        telemetry.phases.post_present_reconfigure = measured(0.2);
        finalize_surface_configuration_evidence(&mut telemetry, Some(1));
        let value = serde_json::to_value(&telemetry).unwrap();
        assert_eq!(value["phases"]["surfaceAcquire"]["kind"], "measured");
        assert_eq!(
            value["phases"]["postPresentReconfigure"]["kind"],
            "measured"
        );
        assert_eq!(telemetry.caches.surface_configuration, CacheOutcomeV1::Miss);
        assert_eq!(telemetry.counts.surface_configurations, Some(1));
    }

    #[test]
    fn adapter_evidence_is_bounded_and_names_its_source() {
        let evidence = CanvasAdapterEvidenceV1::new(
            AdapterEvidenceV1 {
                backend: bounded_evidence_string("BrowserWebGpu"),
                device_id: 0,
                device_type: bounded_evidence_string("Other"),
                driver: bounded_evidence_string(&"d".repeat(2_000)),
                driver_info: bounded_evidence_string("info"),
                name: bounded_evidence_string("Example Adapter"),
                source: AdapterEvidenceSourceV1::WorkerWgpuAdapterInfo,
                subgroup_max_size: 128,
                subgroup_min_size: 4,
                vendor_id: 0x10de,
            },
            DeviceEvidenceV1 {
                label: bounded_evidence_string("poietra canvas device v1"),
                requested_features: bounded_evidence_dump("Features(0x0)"),
                requested_limits: bounded_evidence_dump(&format!(
                    "Limits {{ {} }}",
                    "x".repeat(4_000)
                )),
            },
            SurfaceEvidenceV1 {
                alpha_mode: bounded_evidence_string("Opaque"),
                present_mode: bounded_evidence_string("Fifo"),
                surface_format: bounded_evidence_string("Bgra8Unorm"),
                view_format: bounded_evidence_string("Bgra8UnormSrgb"),
            },
        );
        let response = adapter_evidence_response(&evidence);
        let value: Value = serde_json::from_slice(&response).unwrap();

        assert!(response.len() <= MAX_CANVAS_ADAPTER_EVIDENCE_JSON_BYTES_V1);
        assert_eq!(value["kind"], "available");
        assert_eq!(value["schema"], "poietra.canvas-adapter-evidence");
        assert_eq!(value["adapter"]["source"], "worker-wgpu-adapter-info");
        assert_eq!(value["adapter"]["driver"].as_str().unwrap().len(), 256);
        assert_eq!(value["adapter"]["vendorId"], 0x10de);
        assert_eq!(value["device"]["label"], "poietra canvas device v1");
        assert_eq!(
            value["device"]["requestedLimits"].as_str().unwrap().len(),
            1_000
        );
        assert_eq!(value["surface"]["viewFormat"], "Bgra8UnormSrgb");

        let fallback: Value =
            serde_json::from_slice(ADAPTER_EVIDENCE_SERIALIZATION_FALLBACK_V1).unwrap();
        assert_eq!(fallback["kind"], "unavailable");
        assert!(
            fallback["reason"]
                .as_str()
                .is_some_and(|reason| !reason.is_empty())
        );
    }
}
