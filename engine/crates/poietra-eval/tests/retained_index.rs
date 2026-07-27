use std::fs;
use std::path::PathBuf;

use poietra_eval::{
    CompileEngineFrameOptionsV1, EngineSessionV1, SampleEngineSessionOptionsV1,
    compile_render_packet_v1,
};
use poietra_geometry::compose_affine_transforms_v1;
use poietra_scene_ir::{RenderDrawV1, SceneIrBundleV1, ViewportV1};
use serde_json::Value;

fn fixture_bundle() -> SceneIrBundleV1 {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/shared-circle-opacity.json");
    let fixture: Value = serde_json::from_slice(
        &fs::read(path).expect("shared retained-index fixture must be readable"),
    )
    .expect("shared retained-index fixture must be JSON");
    serde_json::from_value(serde_json::json!({
        "assets": fixture["assets"],
        "scene": fixture["scene"],
    }))
    .expect("shared retained-index fixture must contain a valid bundle")
}

fn viewport() -> ViewportV1 {
    ViewportV1 {
        height_px: 90,
        width_px: 160,
    }
}

fn sample(
    session: &EngineSessionV1,
    packet_id: &str,
    sample_time: f64,
) -> poietra_scene_ir::RenderPacketV1 {
    session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &["retained-index parity".to_owned()],
            packet_id,
            sample_time,
            viewport: viewport(),
        })
        .expect("retained sample must compile")
}

#[test]
fn three_hundred_samples_reuse_indices_and_match_the_reference_path_exactly() {
    let bundle = fixture_bundle();
    let session = EngineSessionV1::new(bundle.clone()).expect("fixture must install");
    let installed = session.retained_index_stats();

    assert_eq!(installed.build_count(), 1);
    assert_eq!(installed.entity_entries(), bundle.scene.entities.len());
    assert_eq!(
        installed.channel_entries(),
        bundle.scene.animation_channels.len()
    );
    assert_eq!(installed.hierarchy_entries(), bundle.scene.entities.len());
    assert_eq!(installed.paint_order_entries(), bundle.scene.entities.len());

    for sample_index in 0..300 {
        let sample_time = f64::from(sample_index) * bundle.scene.duration / 300.0;
        let packet_id = format!("retained:{sample_index}");
        let retained = sample(&session, &packet_id, sample_time);
        let reference = compile_render_packet_v1(CompileEngineFrameOptionsV1 {
            assets: &bundle.assets,
            evidence: &["retained-index parity".to_owned()],
            packet_id: &packet_id,
            sample_time,
            scene: &bundle.scene,
            viewport: viewport(),
        })
        .expect("reference sample must compile");
        assert_eq!(retained, reference, "sample {sample_index} diverged");
    }

    assert_eq!(session.retained_index_stats(), installed);
}

#[test]
fn hierarchy_sampling_is_independent_of_translucent_paint_order() {
    let mut bundle = fixture_bundle();
    let parent_index = bundle
        .scene
        .entities
        .iter()
        .position(|entity| entity.id == "earlier")
        .unwrap();
    let child_index = bundle
        .scene
        .entities
        .iter()
        .position(|entity| entity.id == "later")
        .unwrap();
    bundle.scene.entities[parent_index].source_z_index = 1.0;
    bundle.scene.entities[parent_index].transform.m11 = 2.0;
    bundle.scene.entities[parent_index].transform.tx = 3.0;
    bundle.scene.entities[child_index].parent_id = Some("earlier".to_owned());
    bundle.scene.entities[child_index].source_z_index = -1.0;
    bundle.scene.entities[child_index].transform.ty = 2.0;

    let expected_child_transform = compose_affine_transforms_v1(
        &bundle.scene.entities[parent_index].transform,
        &bundle.scene.entities[child_index].transform,
    );
    let session = EngineSessionV1::new(bundle).expect("hierarchy fixture must install");
    let packet = sample(&session, "retained:hierarchy", 1.0);

    assert_eq!(
        packet
            .draws
            .iter()
            .map(RenderDrawV1::entity_id)
            .collect::<Vec<_>>(),
        vec!["later", "earlier", "stroke"]
    );
    let RenderDrawV1::Path {
        opacity, transform, ..
    } = &packet.draws[0]
    else {
        panic!("child must remain a path draw");
    };
    assert!((*opacity - 0.5).abs() <= f64::EPSILON);
    assert_eq!(*transform, expected_child_transform);
}

#[test]
fn failed_replacement_preserves_scene_assets_indices_and_build_evidence() {
    let bundle = fixture_bundle();
    let mut session = EngineSessionV1::new(bundle).expect("fixture must install");
    let before_assets = session.assets().clone();
    let before_scene = session.scene().clone();
    let before_stats = session.retained_index_stats();
    let before_packet = sample(&session, "retained:before-rejection", 1.0);

    let mut invalid_scene = before_scene.clone();
    invalid_scene.duration = 0.0;
    assert!(
        session
            .replace_snapshot(SceneIrBundleV1 {
                assets: before_assets.clone(),
                scene: invalid_scene,
            })
            .is_err()
    );

    assert_eq!(session.assets(), &before_assets);
    assert_eq!(session.scene(), &before_scene);
    assert_eq!(session.retained_index_stats(), before_stats);
    assert_eq!(
        sample(&session, "retained:before-rejection", 1.0),
        before_packet
    );
}

#[test]
fn successful_replacement_commits_one_complete_new_index() {
    let bundle = fixture_bundle();
    let mut session = EngineSessionV1::new(bundle.clone()).expect("fixture must install");
    let before = session.retained_index_stats();
    let mut replacement = bundle;
    replacement.scene.entities.reverse();
    replacement.scene.source = poietra_scene_ir::SceneSourceV1::StudioEditProgram {
        edit_program_version: poietra_scene_ir::ContractVersionV1,
        revision_hash: "b".repeat(64),
    };

    session
        .replace_snapshot(replacement)
        .expect("valid replacement must commit");
    let after = session.retained_index_stats();
    assert_eq!(after.build_count(), before.build_count() + 1);
    assert_eq!(after.entity_entries(), before.entity_entries());
    assert_eq!(
        sample(&session, "retained:replacement", 1.0).scene_revision_hash,
        "b".repeat(64)
    );
}
