//! Test-only browser proof for the async offscreen export readback (#718).
//!
//! Exposes one hidden wasm entry so the browser readback e2e can execute the
//! exact async export path that the native headless proofs execute: parse and
//! validate a Scene bundle, sample uniform `i / fps` instants through the
//! retained evaluator, render each frame into the offscreen
//! `COPY_SRC | RENDER_ATTACHMENT` export target, await the `map_async`
//! readback future, and return every frame's tight RGBA bytes concatenated in
//! frame order. This never touches a canvas surface, is bounded by the proof
//! frame cap inside the renderer hook, and is superseded by the #721 export
//! contract.

use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_render_wgpu::prove_export_frame_sequence_readback_v1;
use poietra_scene_ir::parse_scene_ir_bundle_json_v1;
use wasm_bindgen::prelude::*;

fn proof_error(stage: &str, message: &str) -> JsValue {
    JsValue::from_str(&format!("export readback proof {stage}: {message}"))
}

/// Renders one validated Scene's bounded uniform export grid through the
/// offscreen async readback path and returns all frames' tight RGBA bytes
/// concatenated in frame order.
///
/// # Errors
///
/// Returns a stringified staged error (`snapshot`, `adapter`, `device`, or
/// `sequence`) and never a partial frame.
#[wasm_bindgen(js_name = poietraProveExportFrameSequenceReadbackV1)]
pub async fn poietra_prove_export_frame_sequence_readback_v1(
    snapshot_json: &[u8],
    width_px: u32,
    height_px: u32,
    fps: u32,
) -> Result<Vec<u8>, JsValue> {
    let bundle = parse_scene_ir_bundle_json_v1(snapshot_json)
        .map_err(|error| proof_error("snapshot", &error.to_string()))?;
    let evaluator = EngineSessionV1::new(bundle)
        .map_err(|error| proof_error("snapshot", &error.to_string()))?;

    let mut instance_descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    instance_descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
    let instance = wgpu::Instance::new(instance_descriptor);
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .map_err(|error| proof_error("adapter", &error.to_string()))?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("poietra export readback proof device v1"),
            ..wgpu::DeviceDescriptor::default()
        })
        .await
        .map_err(|error| proof_error("device", &error.to_string()))?;

    let frames = prove_export_frame_sequence_readback_v1(
        &device,
        &queue,
        evaluator.scene(),
        width_px,
        height_px,
        fps,
        |frame_index, requested_time, viewport| {
            evaluator
                .sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: &format!("packet:export-readback-proof-{frame_index}"),
                    sample_time: requested_time,
                    viewport,
                })
                .map_err(|error| error.to_string())
        },
    )
    .await
    .map_err(|error| proof_error("sequence", &error))?;

    let mut concatenated = Vec::new();
    for frame in frames {
        concatenated.extend_from_slice(&frame);
    }
    Ok(concatenated)
}
