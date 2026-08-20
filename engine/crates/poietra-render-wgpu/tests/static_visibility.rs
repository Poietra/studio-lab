use std::fs;
use std::path::PathBuf;

use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_render_wgpu::prepare_frame_v1;
use poietra_scene_ir::{SceneIrBundleV1, ViewportV1};

fn load_bundle() -> SceneIrBundleV1 {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/shared-circle-opacity.json");
    let fixture: serde_json::Value =
        serde_json::from_slice(&fs::read(path).expect("shared fixture must be readable"))
            .expect("shared fixture must contain JSON");
    serde_json::from_value(serde_json::json!({
        "assets": fixture["assets"],
        "scene": fixture["scene"],
    }))
    .expect("shared fixture must contain a valid Scene IR bundle")
}

fn sample(session: &EngineSessionV1, packet_id: &str) -> poietra_scene_ir::RenderPacketV1 {
    session
        .sample_export_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id,
            sample_time: 1.0,
            viewport: ViewportV1 {
                height_px: 90,
                width_px: 160,
            },
        })
        .expect("static visibility must sample through the export camera fit")
}

#[test]
fn hidden_root_leaf_leaves_no_draw_or_prepared_bounds_and_show_restores_both() {
    let shown_bundle = load_bundle();
    let shown_session =
        EngineSessionV1::new(shown_bundle.clone()).expect("shown fixture must install");
    let shown_packet = sample(&shown_session, "shown");
    let shown_prepared = prepare_frame_v1(&shown_packet).expect("shown frame must prepare");
    let shown_bounds = shown_prepared
        .clip_bounds_for_entity("later")
        .expect("shown root leaf must expose prepared bounds");

    let mut hidden_bundle = shown_bundle.clone();
    hidden_bundle
        .scene
        .entities
        .iter_mut()
        .find(|entity| entity.id == "later")
        .expect("fixture must contain the target root leaf")
        .visible = false;
    let hidden_session =
        EngineSessionV1::new(hidden_bundle.clone()).expect("hidden root leaf must install");
    let hidden_packet = sample(&hidden_session, "hidden");
    assert_eq!(hidden_packet.camera, shown_packet.camera);
    assert!(
        hidden_packet
            .draws
            .iter()
            .all(|draw| draw.entity_id() != "later")
    );
    let hidden_prepared = prepare_frame_v1(&hidden_packet).expect("hidden frame must prepare");
    assert_eq!(hidden_prepared.clip_bounds_for_entity("later"), None);
    assert!(
        !hidden_prepared
            .interaction_clip_bounds_by_entity(&hidden_bundle.scene)
            .expect("hidden Scene must match its prepared packet")
            .contains_key("later")
    );

    let restored_packet = sample(&shown_session, "restored");
    let restored_prepared =
        prepare_frame_v1(&restored_packet).expect("restored frame must prepare");
    assert!(
        restored_packet
            .draws
            .iter()
            .any(|draw| draw.entity_id() == "later")
    );
    assert_eq!(
        restored_prepared.clip_bounds_for_entity("later"),
        Some(shown_bounds)
    );
}
