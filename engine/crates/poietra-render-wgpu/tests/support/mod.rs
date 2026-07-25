use std::fs;
use std::path::PathBuf;

use poietra_eval::{CompileEngineFrameOptionsV1, compile_engine_frame_v1};
use poietra_scene_ir::{AssetManifestV1, SceneIrV1, ViewportV1};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedFixture {
    assets: AssetManifestV1,
    sample: EvaluationRequest,
    scene: SceneIrV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationRequest {
    evidence: Vec<String>,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/shared-circle-opacity.json")
}

pub fn sampled_packet() -> poietra_scene_ir::RenderPacketV1 {
    let fixture: SharedFixture =
        serde_json::from_slice(&fs::read(fixture_path()).expect("shared fixture must be readable"))
            .expect("shared fixture must match its envelope");
    compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
        assets: &fixture.assets,
        evidence: &fixture.sample.evidence,
        packet_id: &fixture.sample.packet_id,
        sample_time: fixture.sample.sample_time,
        scene: &fixture.scene,
        viewport: fixture.sample.viewport,
    })
    .expect("shared fixture must evaluate")
    .packet
}
