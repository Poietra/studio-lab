use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use poietra_eval::{
    CompileEngineFrameOptionsV1, EngineSessionV1, SampleEngineSessionOptionsV1,
    compile_render_packet_v1,
};
use poietra_render_wgpu::{
    PreparedGeometryCacheV1, WgpuPaintRendererV1, WgpuRenderTargetV1, prepare_frame_v1,
    prepare_frame_with_cache_v1,
};
use poietra_scene_ir::{
    RenderCompositingV1, RenderDrawV1, RenderPacketV1, SceneCapabilityV1, SceneIrBundleV1,
    SceneSourceV1, SnapshotProfileVersionV1, ViewportV1,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const FAST_MANIM_COMMIT: &str = "044a61aa0d868fc9e799588f2eb88006594b6c44";
const FAST_MANIM_TREE: &str = "996ad2b7375a6f911b1b00747eaad38834bde25c";
const ENGINE_COMMIT: &str = "8b19ef72e425d41f271c785c74a0fd295a14b5b5";
const FIXTURE_ID: &str = "eng-v1-real-write-stuff-v12";
const PRODUCER_SNAPSHOT_DIGEST: &str =
    "dd6ca2c3e1015718f9fa9b8ad0e926de8260013eb85d17574c3c7fdeaba89817";
const SNAPSHOT_HASH: &str = "b4cb36f1756e1204d6093f9fd838f75eb6810429b5aad30abc68af4c7d7c2594";
const SOURCE_SHA256: &str = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const SEMANTIC_NUMBER_SCALE: f64 = 1_000_000_000.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureV12 {
    assets: Value,
    id: String,
    producer_reference: ProducerReferenceV12,
    samples: Vec<SampleV12>,
    scene: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProducerReferenceV12 {
    engine_commit: String,
    fast_manim_commit: String,
    fast_manim_tree: String,
    kind: String,
    producer_snapshot_digest: String,
    snapshot_hash: String,
    source_path: String,
    source_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleV12 {
    expected: ExpectedV12,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedV12 {
    semantic_digest: String,
}

fn fixture() -> (FixtureV12, SceneIrBundleV1) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/real-write-stuff-v12.json");
    let fixture: FixtureV12 = serde_json::from_slice(
        &fs::read(path).expect("the sealed WriteStuff V12 fixture must be readable"),
    )
    .expect("the sealed WriteStuff V12 fixture must match its envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("the sealed WriteStuff V12 bundle must match Scene IR");
    (fixture, bundle)
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "finite fixture coordinates are rounded into a bounded semantic digest"
)]
fn normalize_semantic_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            let scaled = (number
                .as_f64()
                .expect("frame semantics must contain finite JSON numbers")
                * SEMANTIC_NUMBER_SCALE)
                .round() as i64;
            *number = scaled.into();
        }
        Value::Array(entries) => entries.iter_mut().for_each(normalize_semantic_numbers),
        Value::Object(entries) => entries.values_mut().for_each(normalize_semantic_numbers),
        Value::Bool(_) | Value::Null | Value::String(_) => {}
    }
}

fn semantic_digest(packet: &RenderPacketV1) -> String {
    let mut value = serde_json::json!({
        "camera": packet.camera,
        "compositing": packet.compositing,
        "draws": packet.draws,
    });
    normalize_semantic_numbers(&mut value);
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&value).expect("normalized semantics must serialize"))
    )
}

fn union_bounds<'a>(bounds: impl Iterator<Item = &'a [f32; 4]>) -> Option<[f32; 4]> {
    bounds.copied().reduce(|left, right| {
        [
            left[0].min(right[0]),
            left[1].min(right[1]),
            left[2].max(right[2]),
            left[3].max(right[3]),
        ]
    })
}

fn proof_target(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    width_px: u32,
    height_px: u32,
    label: &'static str,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            depth_or_array_layers: 1,
            height: height_px,
            width: width_px,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn submit_prepared(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &mut WgpuPaintRendererV1,
    prepared: &poietra_render_wgpu::PreparedFrameV1,
    label: &'static str,
) -> wgpu::SubmissionIndex {
    let [width_px, height_px] = prepared.viewport();
    let format = renderer.target_format_for_compositing(prepared.compositing());
    let (_texture, view) = proof_target(device, format, width_px, height_px, label);
    renderer
        .render(
            device,
            queue,
            WgpuRenderTargetV1 {
                format,
                height_px,
                view: &view,
                width_px,
            },
            prepared,
        )
        .unwrap_or_else(|error| panic!("{label} must submit: {error}"))
}

fn fallback_device() -> (wgpu::Device, wgpu::Queue) {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        apply_limit_buckets: false,
        compatible_surface: None,
        force_fallback_adapter: true,
        power_preference: wgpu::PowerPreference::None,
    }))
    .expect("a native fallback WGPU adapter is required for the V12 proof");
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("poietra WriteStuff V12 proof device"),
        memory_hints: wgpu::MemoryHints::MemoryUsage,
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_defaults(),
        ..Default::default()
    }))
    .expect("the fallback adapter must create the V12 proof device")
}

fn multisample_bytes(renderer: &WgpuPaintRendererV1) -> u64 {
    renderer
        .memory_snapshot()
        .expect("the renderer memory snapshot must remain representable")
        .multisample_color_target_bytes()
}

#[test]
#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one vertical-slice proof binds all eight Write phases, nested roots, and retained preparation"
)]
fn sealed_v12_evaluates_and_prepares_all_61_entities_and_58_write_channels() {
    let (fixture, bundle) = fixture();
    assert_eq!(fixture.id, FIXTURE_ID);
    assert_eq!(fixture.producer_reference.engine_commit, ENGINE_COMMIT);
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        FAST_MANIM_COMMIT
    );
    assert_eq!(fixture.producer_reference.fast_manim_tree, FAST_MANIM_TREE);
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v12"
    );
    assert_eq!(
        fixture.producer_reference.producer_snapshot_digest,
        PRODUCER_SNAPSHOT_DIGEST
    );
    assert_eq!(fixture.producer_reference.snapshot_hash, SNAPSHOT_HASH);
    assert_eq!(
        fixture.producer_reference.source_path,
        "example_scenes/basic.py"
    );
    assert_eq!(fixture.producer_reference.source_sha256, SOURCE_SHA256);

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("WriteStuff V12 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V12);
    assert_eq!(snapshot_hash, SNAPSHOT_HASH);
    assert_eq!(source_hash, SOURCE_SHA256);
    assert_eq!(
        bundle.scene.source.render_compositing(),
        RenderCompositingV1::ManimCairoSrgb
    );
    assert_eq!(bundle.scene.duration, 4.0);
    assert_eq!(bundle.scene.entities.len(), 61);
    assert_eq!(bundle.scene.animation_channels.len(), 58);
    assert_eq!(
        bundle.scene.required_capabilities,
        [
            SceneCapabilityV1::CubicPathGeometry,
            SceneCapabilityV1::LogicalGroup,
            SceneCapabilityV1::PathTrimAnimation,
            SceneCapabilityV1::VectorAppearanceAnimation,
        ]
    );

    let group_id = &bundle.scene.entities[0].id;
    let tex_root_id = &bundle.scene.entities[1].id;
    let math_root_id = &bundle.scene.entities[32].id;
    let expected_samples = [
        ("start", 0.0, 1, false, false),
        ("tex-early", 0.25, 3, true, false),
        ("tex-midpoint", 1.0, 10, true, false),
        ("math-start", 2.0, 16, true, false),
        ("math-midpoint", 2.5, 25, true, true),
        ("math-end", 3.0, 29, true, true),
        ("hold", 3.5, 29, true, true),
        ("end", 4.0, 29, true, true),
    ];
    assert_eq!(fixture.samples.len(), expected_samples.len());

    let session = EngineSessionV1::new(bundle.clone()).expect("the sealed V12 bundle must install");
    let installed_index = session.retained_index_stats();
    assert_eq!(installed_index.entity_entries(), 61);
    assert_eq!(installed_index.channel_entries(), 58);
    let mut cache = PreparedGeometryCacheV1::default();

    for (sample, (expected_id, expected_time, draw_count, tex_present, math_present)) in
        fixture.samples.iter().zip(expected_samples)
    {
        assert_eq!(sample.id, expected_id);
        assert_eq!(sample.sample_time, expected_time);
        assert_eq!(
            sample.packet_id,
            format!("real-write-stuff-v12:{expected_id}")
        );
        assert_eq!(
            sample.viewport,
            ViewportV1 {
                height_px: 360,
                width_px: 640
            }
        );
        let evidence = [fixture.id.clone(), sample.id.clone()];
        let retained = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &evidence,
                packet_id: &sample.packet_id,
                sample_time: sample.sample_time,
                viewport: sample.viewport.clone(),
            })
            .unwrap_or_else(|error| panic!("retained V12 sample {expected_id} failed: {error}"));
        let reference = compile_render_packet_v1(CompileEngineFrameOptionsV1 {
            assets: &bundle.assets,
            evidence: &evidence,
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            scene: &bundle.scene,
            viewport: sample.viewport.clone(),
        })
        .unwrap_or_else(|error| panic!("reference V12 sample {expected_id} failed: {error}"));
        assert_eq!(retained, reference);
        assert_eq!(retained.compositing, RenderCompositingV1::ManimCairoSrgb);
        assert_eq!(retained.draws.len(), draw_count);
        assert_eq!(semantic_digest(&retained), sample.expected.semantic_digest);

        if expected_time == 0.0 || expected_time == 2.0 {
            assert!(
                retained
                    .draws
                    .iter()
                    .any(|draw| matches!(draw, RenderDrawV1::Empty { .. }))
            );
        }
        let direct = prepare_frame_v1(&retained)
            .unwrap_or_else(|error| panic!("direct V12 prepare failed at {expected_id}: {error}"));
        let cached = prepare_frame_with_cache_v1(&retained, &mut cache)
            .unwrap_or_else(|error| panic!("cached V12 prepare failed at {expected_id}: {error}"));
        assert_eq!(
            direct.geometry_plan().vertices(),
            cached.geometry_plan().vertices()
        );
        assert_eq!(direct.indices(), cached.indices());
        assert_eq!(direct.material_plan(), cached.material_plan());
        assert_eq!(direct.ordered_draw_plan(), cached.ordered_draw_plan());
        assert_eq!(direct.viewport(), cached.viewport());
        assert_eq!(direct.clip_bounds_for_entity(group_id), None);
        assert_eq!(direct.clip_bounds_for_entity(tex_root_id), None);
        assert_eq!(direct.clip_bounds_for_entity(math_root_id), None);

        let interaction_bounds = direct
            .interaction_clip_bounds_by_entity(&bundle.scene)
            .expect("the retained V12 Scene must match its prepared packet");
        assert_eq!(interaction_bounds.contains_key(tex_root_id), tex_present);
        assert_eq!(interaction_bounds.contains_key(math_root_id), math_present);

        for (root_index, descendants) in [(1usize, 2..32), (32, 33..61)] {
            let expected_root = union_bounds(
                bundle.scene.entities[descendants]
                    .iter()
                    .filter_map(|entity| interaction_bounds.get(&entity.id)),
            );
            assert_eq!(
                interaction_bounds
                    .get(&bundle.scene.entities[root_index].id)
                    .copied(),
                expected_root
            );
        }
        let expected_group = union_bounds(
            [tex_root_id, math_root_id]
                .into_iter()
                .filter_map(|entity_id| interaction_bounds.get(entity_id)),
        );
        assert_eq!(interaction_bounds.get(group_id).copied(), expected_group);
        assert_eq!(session.retained_index_stats(), installed_index);
    }
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
fn sealed_v12_full_write_submits_to_a_real_headless_wgpu_target() {
    let (fixture, bundle) = fixture();
    let session = EngineSessionV1::new(bundle).expect("the sealed V12 bundle must install");
    let sample = fixture
        .samples
        .iter()
        .find(|sample| sample.id == "end")
        .expect("the V12 fixture must retain its duration endpoint");
    let packet = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[fixture.id],
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            viewport: sample.viewport.clone(),
        })
        .expect("the completed V12 Write must evaluate");
    let prepared = prepare_frame_v1(&packet).expect("the completed V12 Write must prepare");
    assert_eq!(packet.draws.len(), 29);
    assert!(!prepared.indices().is_empty());

    let (device, queue) = fallback_device();
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);

    let mut renderer = WgpuPaintRendererV1::new(&device, wgpu::TextureFormat::Rgba8UnormSrgb)
        .expect("the V12 proof renderer must support the browser target format");
    assert_eq!(multisample_bytes(&renderer), 0);
    let target_format = renderer.target_format_for_compositing(prepared.compositing());
    assert_eq!(target_format, wgpu::TextureFormat::Rgba8Unorm);
    submit_prepared(
        &device,
        &queue,
        &mut renderer,
        &prepared,
        "poietra WriteStuff V12 proof target",
    );
    assert_eq!(multisample_bytes(&renderer), 3_686_400);

    let mut linear_packet = packet.clone();
    linear_packet.compositing = RenderCompositingV1::LinearLight;
    let linear_prepared = prepare_frame_v1(&linear_packet)
        .expect("the completed V12 geometry must prepare for linear-light proof");
    submit_prepared(
        &device,
        &queue,
        &mut renderer,
        &linear_prepared,
        "poietra WriteStuff V12 linear format-switch target",
    );
    assert_eq!(multisample_bytes(&renderer), 3_686_400);

    let resized_viewport = ViewportV1 {
        height_px: 180,
        width_px: 320,
    };
    let resized_packet = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &["WriteStuff V12 multisample resize proof".to_owned()],
            packet_id: "real-write-stuff-v12:resized",
            sample_time: sample.sample_time,
            viewport: resized_viewport.clone(),
        })
        .expect("the completed V12 Write must evaluate at a resized viewport");
    let resized_prepared =
        prepare_frame_v1(&resized_packet).expect("the resized completed V12 Write must prepare");
    let submission = submit_prepared(
        &device,
        &queue,
        &mut renderer,
        &resized_prepared,
        "poietra WriteStuff V12 resized Cairo target",
    );
    assert_eq!(multisample_bytes(&renderer), 921_600);
    let status = device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(10)),
        })
        .expect("the V12 WGPU submission must complete before the timeout");
    assert!(status.wait_finished());
    assert!(pollster::block_on(out_of_memory_scope.pop()).is_none());
    assert!(pollster::block_on(internal_scope.pop()).is_none());
    assert!(pollster::block_on(validation_scope.pop()).is_none());
}
