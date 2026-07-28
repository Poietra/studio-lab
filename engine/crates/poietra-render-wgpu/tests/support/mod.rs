use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use poietra_eval::{CompileEngineFrameOptionsV1, compile_engine_frame_v1};
use poietra_scene_ir::{
    AnimationChannelV1, AssetManifestV1, CubicPathV1, CubicSegmentV1, CubicSubpathV1, PointV1,
    RenderCapabilityV1, RenderDrawV1, RgbaColorV1, SceneIrV1, StrokeCapV1, StrokeJoinV1,
    StrokeStyleV1, ViewportV1,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedFixture {
    assets: AssetManifestV1,
    #[allow(dead_code)]
    #[serde(default)]
    reference: Option<PixelReferenceSet>,
    sample: EvaluationRequest,
    scene: SceneIrV1,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
pub struct PixelReferenceSet {
    pub reason: String,
    pub samples: BTreeMap<String, PixelReference>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
pub struct PixelReference {
    pub at: [u32; 2],
    pub rgba: [u8; 4],
    pub tolerance: u8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationRequest {
    evidence: Vec<String>,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

fn fixture_path(file_name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1")
        .join(file_name)
}

fn read_fixture(file_name: &str) -> SharedFixture {
    let fixture: SharedFixture = serde_json::from_slice(
        &fs::read(fixture_path(file_name)).expect("shared fixture must be readable"),
    )
    .expect("shared fixture must match its envelope");
    fixture
}

fn compile_fixture(fixture: &SharedFixture) -> poietra_scene_ir::RenderPacketV1 {
    compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
        assets: &fixture.assets,
        evidence: &fixture.sample.evidence,
        packet_id: &fixture.sample.packet_id,
        sample_time: fixture.sample.sample_time,
        scene: &fixture.scene,
        viewport: fixture.sample.viewport.clone(),
    })
    .expect("shared fixture must evaluate")
    .packet
}

pub fn sampled_packet() -> poietra_scene_ir::RenderPacketV1 {
    compile_fixture(&read_fixture("shared-circle-opacity.json"))
}

#[allow(dead_code)]
pub fn generic_fill_fixture() -> (poietra_scene_ir::RenderPacketV1, PixelReferenceSet) {
    let mut fixture = read_fixture("generic-fill-topology.json");
    let reference = fixture
        .reference
        .take()
        .expect("generic fill fixture must carry its pixel reference");
    (compile_fixture(&fixture), reference)
}

#[allow(dead_code)]
pub fn generic_stroke_fixture() -> (poietra_scene_ir::RenderPacketV1, PixelReferenceSet) {
    let mut fixture = read_fixture("generic-stroke-topology.json");
    let reference = fixture
        .reference
        .take()
        .expect("generic stroke fixture must carry its pixel reference");
    (compile_fixture(&fixture), reference)
}

#[allow(dead_code)]
pub fn generic_stroke_packet_with_initial_trim(
    initial_trim: f64,
) -> poietra_scene_ir::RenderPacketV1 {
    let mut fixture = read_fixture("generic-stroke-topology.json");
    fixture.sample.sample_time = 0.0;
    let trim = fixture
        .scene
        .animation_channels
        .iter_mut()
        .find_map(|channel| match channel {
            AnimationChannelV1::PathTrim {
                entity_id,
                keyframes,
                ..
            } if entity_id == "curve" => Some(keyframes),
            _ => None,
        })
        .expect("generic stroke fixture must contain the curve trim channel");
    trim[0].value = initial_trim;
    compile_fixture(&fixture)
}

fn line_control(start: &PointV1, end: &PointV1, factor: f64) -> PointV1 {
    PointV1 {
        x: start.x + (end.x - start.x) * factor,
        y: start.y + (end.y - start.y) * factor,
    }
}

pub fn straight_stroke_packet(cap: StrokeCapV1) -> poietra_scene_ir::RenderPacketV1 {
    let mut packet = sampled_packet();
    packet.draws.truncate(1);
    let start = PointV1 { x: -2.0, y: 0.0 };
    let end = PointV1 { x: 2.0, y: 0.0 };
    let RenderDrawV1::Path {
        fill,
        opacity,
        path,
        stroke,
        ..
    } = &mut packet.draws[0]
    else {
        panic!("fixture draw must be a path");
    };
    *fill = None;
    *opacity = 0.5;
    *path = CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: false,
            segments: vec![CubicSegmentV1 {
                control1: line_control(&start, &end, 1.0 / 3.0),
                control2: line_control(&start, &end, 2.0 / 3.0),
                end,
            }],
            start,
        }],
    };
    *stroke = Some(StrokeStyleV1 {
        cap,
        color: RgbaColorV1 {
            alpha: 1.0,
            blue: 0.0,
            green: 1.0,
            red: 0.0,
        },
        join: StrokeJoinV1::Miter,
        miter_limit: 4.0,
        width_world: 1.0,
    });
    packet.required_capabilities = vec![RenderCapabilityV1::CubicPathStroke];
    packet
}
