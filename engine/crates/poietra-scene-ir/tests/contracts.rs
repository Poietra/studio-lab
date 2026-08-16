use poietra_scene_ir::*;
use serde_json::json;

const REVISION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EMPTY_MANIFEST_DIGEST: &str =
    "8f2a9813bcfc60b693fc34b8046d64352004b50a17e224bb138daae7da9e941d";

fn assert_f64_bits_eq(actual: f64, expected: f64) {
    assert_eq!(actual.to_bits(), expected.to_bits());
}

fn black() -> RgbaColorV1 {
    RgbaColorV1 {
        alpha: 1.0,
        blue: 0.0,
        green: 0.0,
        red: 0.0,
    }
}

fn empty_manifest() -> AssetManifestV1 {
    AssetManifestV1 {
        assets: Vec::new(),
        manifest_digest: EMPTY_MANIFEST_DIGEST.to_owned(),
        manifest_id: "manifest-fixture".to_owned(),
        schema: AssetManifestSchemaV1::AssetManifest,
        version: ContractVersionV1,
    }
}

fn manifest_reference() -> AssetManifestReferenceV1 {
    AssetManifestReferenceV1 {
        manifest_digest: EMPTY_MANIFEST_DIGEST.to_owned(),
        manifest_id: "manifest-fixture".to_owned(),
    }
}

fn empty_scene() -> SceneIrV1 {
    SceneIrV1 {
        animation_channels: Vec::new(),
        asset_manifest: manifest_reference(),
        camera: SceneCameraV1 {
            background: black(),
            view: SceneCameraViewV1 {
                center: PointV1 { x: 0.0, y: 0.0 },
                frame_height: 9.0,
                frame_width: 16.0,
            },
        },
        compositing: RenderCompositingV1::LinearLight,
        coordinate_space: CoordinateSpaceV1::default(),
        duration: 2.0,
        entities: Vec::new(),
        fidelity: FidelityV1::Exact {},
        provenance: vec![ProvenanceRecordV1 {
            evidence: Vec::new(),
            id: "fixture:root".to_owned(),
            origin: ProvenanceOriginV1::Fixture,
        }],
        required_capabilities: Vec::new(),
        scene_id: "scene:empty".to_owned(),
        schema: SceneIrSchemaV1::SceneIr,
        source: SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: REVISION.to_owned(),
        },
        state_sampling: SceneStateSamplingV1 {
            frame_rate: None,
            retains_terminal_state: false,
        },
        version: ContractVersionV1,
    }
}

fn empty_packet() -> RenderPacketV1 {
    RenderPacketV1 {
        asset_manifest: manifest_reference(),
        camera: RenderCameraV1 {
            bottom: -4.5,
            clear_color: black(),
            kind: RenderCameraKindV1::Orthographic2d,
            left: -8.0,
            right: 8.0,
            top: 4.5,
        },
        compositing: RenderCompositingV1::LinearLight,
        coordinate_space: CoordinateSpaceV1::default(),
        draws: Vec::new(),
        evidence: Vec::new(),
        packet_id: "packet:empty:1".to_owned(),
        required_capabilities: Vec::new(),
        sample_time: 1.0,
        scene_duration: 2.0,
        scene_id: "scene:empty".to_owned(),
        scene_revision_hash: REVISION.to_owned(),
        schema: RenderPacketSchemaV1::RenderPacket,
        scene_contract_version: ContractVersionV1,
        version: ContractVersionV1,
        viewport: ViewportV1 {
            height_px: 90,
            width_px: 160,
        },
    }
}

fn filled_path_draw(paint_order: u32) -> RenderDrawV1 {
    RenderDrawV1::Path {
        draw_id: "draw:path".to_owned(),
        entity_id: "path".to_owned(),
        fill: Some(FillStyleV1 {
            color: black(),
            rule: FillRuleV1::NonZero,
        }),
        opacity: 1.0,
        paint_order,
        path: CubicPathV1 {
            subpaths: vec![CubicSubpathV1 {
                closed: true,
                segments: vec![CubicSegmentV1 {
                    control1: PointV1 { x: 1.0, y: 0.0 },
                    control2: PointV1 { x: 1.0, y: 1.0 },
                    end: PointV1 { x: 0.0, y: 1.0 },
                }],
                start: PointV1 { x: 0.0, y: 0.0 },
            }],
        },
        source_z_index: 0.0,
        stroke: None,
        transform: AffineTransformV1::identity(),
    }
}

#[test]
fn canonical_empty_manifest_digest_is_stable() {
    let manifest = empty_manifest();
    assert_eq!(
        canonical_asset_manifest_v1(&manifest).unwrap(),
        r#"{"assets":[],"manifestId":"manifest-fixture","schema":"poietra.asset-manifest","version":1}"#
    );
    assert_eq!(
        digest_asset_manifest_v1(&manifest).unwrap(),
        EMPTY_MANIFEST_DIGEST
    );
    validate_asset_manifest_v1(&manifest).unwrap();
    validate_asset_manifest_digest_v1(&manifest).unwrap();

    let mut stale = manifest;
    stale.manifest_id = "manifest-stale".to_owned();
    assert!(
        validate_asset_manifest_digest_v1(&stale)
            .unwrap_err()
            .contains_message("does not match")
    );
}

#[test]
fn serde_rejects_unknown_fields_at_root_and_inside_tagged_values() {
    let scene = empty_scene();
    let mut root = serde_json::to_value(&scene).unwrap();
    root["unexpected"] = json!(true);
    let root_error = serde_json::from_value::<SceneIrV1>(root).unwrap_err();
    assert!(root_error.to_string().contains("unknown field"));

    let mut nested = serde_json::to_value(&scene).unwrap();
    nested["camera"]["view"]["z"] = json!(0);
    let nested_error = serde_json::from_value::<SceneIrV1>(nested).unwrap_err();
    assert!(nested_error.to_string().contains("unknown field"));

    let easing_error = serde_json::from_value::<EasingV1>(json!({
        "kind": "linear",
        "spring": 0.5
    }))
    .unwrap_err();
    assert!(easing_error.to_string().contains("unknown field"));
}

#[test]
fn path_trim_parameterization_is_optional_and_fail_closed() {
    let channel = AnimationChannelV1::PathTrim {
        entity_id: "line".to_owned(),
        id: "create".to_owned(),
        keyframes: vec![
            KeyframeV1 {
                at: 0.0,
                easing_to_next: Some(EasingV1::Linear {}),
                value: 0.0,
            },
            KeyframeV1 {
                at: 1.0,
                easing_to_next: None,
                value: 1.0,
            },
        ],
        parameterization: None,
        provenance_id: "fixture:root".to_owned(),
    };
    let omitted = serde_json::to_value(&channel).unwrap();
    assert!(omitted.get("parameterization").is_none());
    assert_eq!(
        serde_json::from_value::<AnimationChannelV1>(omitted.clone()).unwrap(),
        channel
    );

    let mut explicit = omitted;
    explicit["parameterization"] = json!("uniform-cubic-parameter-v1");
    assert!(matches!(
        serde_json::from_value::<AnimationChannelV1>(explicit.clone()).unwrap(),
        AnimationChannelV1::PathTrim {
            parameterization: Some(PathTrimParameterizationV1::UniformCubicParameterV1),
            ..
        }
    ));
    explicit["parameterization"] = json!("future-mode");
    assert!(serde_json::from_value::<AnimationChannelV1>(explicit).is_err());
}

#[test]
fn motion_path_parameterization_is_optional_and_fail_closed() {
    let mut channel = json!({
        "entityId": "mover",
        "id": "motion:mover",
        "keyframes": [
            { "at": 0, "easingToNext": { "kind": "linear" }, "value": 0 },
            { "at": 1, "easingToNext": null, "value": 1 }
        ],
        "kind": "motion-path",
        "orientToPath": false,
        "path": {
            "subpaths": [{
                "closed": false,
                "segments": [{
                    "control1": { "x": 1, "y": 0 },
                    "control2": { "x": 2, "y": 0 },
                    "end": { "x": 3, "y": 0 }
                }],
                "start": { "x": 0, "y": 0 }
            }]
        },
        "provenanceId": "fixture:root"
    });
    assert!(matches!(
        serde_json::from_value::<AnimationChannelV1>(channel.clone()).unwrap(),
        AnimationChannelV1::MotionPath {
            parameterization: None,
            ..
        }
    ));
    channel["parameterization"] = json!("manim-point-from-proportion-v1");
    assert!(matches!(
        serde_json::from_value::<AnimationChannelV1>(channel.clone()).unwrap(),
        AnimationChannelV1::MotionPath {
            parameterization: Some(MotionPathParameterizationV1::ManimPointFromProportionV1),
            ..
        }
    ));
    channel["parameterization"] = json!("future-mode");
    assert!(serde_json::from_value::<AnimationChannelV1>(channel).is_err());
}

fn assert_required_nullable_field<T>(value: &serde_json::Value, field: &str)
where
    T: serde::de::DeserializeOwned + std::fmt::Debug,
{
    serde_json::from_value::<T>(value.clone()).expect("an explicit null must remain valid");
    let mut omitted = value.clone();
    omitted
        .as_object_mut()
        .expect("required-nullable fixture must be an object")
        .remove(field);
    let error = serde_json::from_value::<T>(omitted).unwrap_err();
    assert!(
        error.to_string().contains("missing field"),
        "omitted {field} was not rejected as missing: {error}"
    );
}

#[test]
fn serde_requires_nullable_fields_while_accepting_explicit_null() {
    let appearance = json!({
        "fill": null,
        "kind": "vector",
        "opacity": 1,
        "stroke": null,
    });
    assert_required_nullable_field::<SceneAppearanceV1>(&appearance, "fill");
    assert_required_nullable_field::<SceneAppearanceV1>(&appearance, "stroke");

    let entity = json!({
        "appearance": appearance,
        "geometry": { "center": { "x": 0, "y": 0 }, "kind": "circle", "radius": 1 },
        "id": "entity",
        "lifetimes": [{ "end": 1, "start": 0 }],
        "parentId": null,
        "provenanceId": "fixture",
        "sceneOrder": 0,
        "sourceZIndex": 0,
        "transform": AffineTransformV1::identity(),
    });
    assert_required_nullable_field::<SceneEntityV1>(&entity, "parentId");

    let keyframe = json!({ "at": 1, "easingToNext": null, "value": 1 });
    assert_required_nullable_field::<KeyframeV1<f64>>(&keyframe, "easingToNext");

    let draw = json!({
        "drawId": "draw:entity",
        "entityId": "entity",
        "fill": null,
        "kind": "path",
        "opacity": 1,
        "paintOrder": 0,
        "path": {
            "subpaths": [{
                "closed": false,
                "segments": [{
                    "control1": { "x": 0, "y": 0 },
                    "control2": { "x": 1, "y": 1 },
                    "end": { "x": 1, "y": 1 },
                }],
                "start": { "x": 0, "y": 0 },
            }],
        },
        "sourceZIndex": 0,
        "stroke": null,
        "transform": AffineTransformV1::identity(),
    });
    assert_required_nullable_field::<RenderDrawV1>(&draw, "fill");
    assert_required_nullable_field::<RenderDrawV1>(&draw, "stroke");
}

#[test]
fn serde_rejects_non_v1_versions_and_unknown_tags() {
    let mut scene = serde_json::to_value(empty_scene()).unwrap();
    scene["version"] = json!(2);
    let version_error = serde_json::from_value::<SceneIrV1>(scene).unwrap_err();
    assert!(version_error.to_string().contains("expected 1"));

    let tag_error = serde_json::from_value::<EasingV1>(json!({ "kind": "spring" })).unwrap_err();
    assert!(tag_error.to_string().contains("unknown variant"));

    let mut missing_compositing = serde_json::to_value(empty_scene()).unwrap();
    missing_compositing
        .as_object_mut()
        .unwrap()
        .remove("compositing");
    assert!(serde_json::from_value::<SceneIrV1>(missing_compositing).is_err());

    let mut missing_state_sampling = serde_json::to_value(empty_scene()).unwrap();
    missing_state_sampling
        .as_object_mut()
        .unwrap()
        .remove("stateSampling");
    assert!(serde_json::from_value::<SceneIrV1>(missing_state_sampling).is_err());
}

#[test]
fn scene_semantics_do_not_dispatch_on_runtime_trace_version() {
    let mut scene = empty_scene();
    scene.duration = 6.0;
    scene.compositing = RenderCompositingV1::ManimCairoSrgb;
    scene.state_sampling.frame_rate = Some(60.0);
    scene.source = SceneSourceV1::ImportedManimRuntimeTrace {
        runtime_config_hash: REVISION.to_owned(),
        source_hash: REVISION.to_owned(),
        trace_digest: REVISION.to_owned(),
        trace_version: RuntimeTraceVersionV1::V1,
    };
    scene.provenance[0].origin = ProvenanceOriginV1::FastManimRuntimeTrace;

    assert_eq!(scene.source.revision_hash(), REVISION);
    assert_eq!(scene.state_sample_time(0.0).to_bits(), 0.0_f64.to_bits());
    assert_eq!(
        scene.state_sample_time(1.0 / 60.0 - 1e-9).to_bits(),
        0.0_f64.to_bits()
    );
    assert_eq!(
        scene.state_sample_time(1.0 / 60.0).to_bits(),
        (1.0_f64 / 60.0).to_bits()
    );
    assert_eq!(
        scene.state_sample_time(1.0 / 60.0 + 1e-9).to_bits(),
        (1.0_f64 / 60.0).to_bits()
    );
    assert_eq!(
        scene.state_sample_time(6.0 - 1e-9).to_bits(),
        (359.0_f64 / 60.0).to_bits()
    );
    assert_f64_bits_eq(scene.state_sample_time(6.0), 6.0);
    scene.state_sampling.retains_terminal_state = true;
    assert_f64_bits_eq(scene.state_sample_time(6.0), 359.0 / 60.0);
    validate_scene_ir_v1(&scene).unwrap();

    let json = serde_json::to_value(&scene).unwrap();
    assert_eq!(json["source"]["kind"], "imported-manim-runtime-trace");
    assert_eq!(json["provenance"][0]["origin"], "fast-manim-runtime-trace");
    assert_eq!(
        parse_scene_ir_json_v1(&serde_json::to_vec(&json).unwrap()).unwrap(),
        scene
    );

    let mut v2 = scene.clone();
    let SceneSourceV1::ImportedManimRuntimeTrace { trace_version, .. } = &mut v2.source else {
        unreachable!()
    };
    *trace_version = RuntimeTraceVersionV1::V2;
    validate_scene_ir_v1(&v2).unwrap();
    assert_eq!(
        v2.state_sample_time(6.0).to_bits(),
        scene.state_sample_time(6.0).to_bits()
    );
    assert_eq!(
        v2.state_sample_time(1.0 / 60.0 + 1e-9).to_bits(),
        (1.0_f64 / 60.0).to_bits()
    );

    let mut v3 = v2.clone();
    let SceneSourceV1::ImportedManimRuntimeTrace { trace_version, .. } = &mut v3.source else {
        unreachable!()
    };
    *trace_version = RuntimeTraceVersionV1::V3;
    validate_scene_ir_v1(&v3).unwrap();
    assert_eq!(
        serde_json::to_value(&v3).unwrap()["source"]["traceVersion"],
        3
    );
    assert_eq!(
        parse_scene_ir_json_v1(&serde_json::to_vec(&v3).unwrap()).unwrap(),
        v3
    );
    assert_eq!(
        v3.state_sample_time(6.0).to_bits(),
        scene.state_sample_time(6.0).to_bits()
    );

    let mut partial_final_frame = v2.clone();
    partial_final_frame.duration = 3.01;
    partial_final_frame.state_sampling.retains_terminal_state = false;
    validate_scene_ir_v1(&partial_final_frame).unwrap();
    assert_f64_bits_eq(partial_final_frame.state_sample_time(3.01), 3.0);
    partial_final_frame.state_sampling.retains_terminal_state = true;
    assert_f64_bits_eq(partial_final_frame.state_sample_time(3.01), 3.0);

    let mut invalid_sampling_range = v2;
    invalid_sampling_range.state_sampling.frame_rate = Some(f64::MAX);
    assert!(
        validate_scene_ir_v1(&invalid_sampling_range)
            .unwrap_err()
            .contains_message("positive JavaScript-safe sampling range")
    );

    let mut invalid_digest = scene;
    let SceneSourceV1::ImportedManimRuntimeTrace { trace_digest, .. } = &mut invalid_digest.source
    else {
        unreachable!()
    };
    *trace_digest = "not-a-digest".to_owned();
    assert!(
        validate_scene_ir_v1(&invalid_digest)
            .unwrap_err()
            .contains_message("lower-case SHA-256")
    );
}

#[test]
fn linear_compositing_keeps_the_existing_packet_wire_while_cairo_is_explicit() {
    let packet = empty_packet();
    assert_eq!(
        serde_json::to_string(&packet).unwrap(),
        concat!(
            r#"{"assetManifest":{"manifestDigest":"8f2a9813bcfc60b693fc34b8046d64352004b50a17e224bb138daae7da9e941d","manifestId":"manifest-fixture"},"#,
            r#""camera":{"bottom":-4.5,"clearColor":{"alpha":1.0,"blue":0.0,"green":0.0,"red":0.0},"kind":"orthographic-2d","left":-8.0,"right":8.0,"top":4.5},"#,
            r#""coordinateSpace":{"cpuPrecision":"f64","kind":"cartesian-2d","origin":"center","unit":"scene-unit","xAxis":"right","yAxis":"up"},"#,
            r#""draws":[],"evidence":[],"packetId":"packet:empty:1","requiredCapabilities":[],"sampleTime":1.0,"sceneDuration":2.0,"sceneId":"scene:empty","#,
            r#""sceneRevisionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","schema":"poietra.render-packet","sceneContractVersion":1,"version":1,"viewport":{"heightPx":90,"widthPx":160}}"#,
        )
    );
    let implicit = serde_json::to_value(&packet).unwrap();
    assert!(implicit.get("compositing").is_none());
    assert_eq!(
        serde_json::from_value::<RenderPacketV1>(implicit.clone()).unwrap(),
        packet
    );

    let mut explicit_linear = implicit;
    explicit_linear["compositing"] = json!("linear-light");
    assert_eq!(
        serde_json::from_value::<RenderPacketV1>(explicit_linear).unwrap(),
        packet
    );

    let mut cairo = packet;
    cairo.compositing = RenderCompositingV1::ManimCairoSrgb;
    assert_eq!(
        serde_json::to_value(&cairo).unwrap()["compositing"],
        "manim-cairo-srgb"
    );
}

#[test]
fn cairo_compositing_rejects_image_draws() {
    let mut packet = empty_packet();
    packet.compositing = RenderCompositingV1::ManimCairoSrgb;
    packet.draws.push(RenderDrawV1::Image {
        asset: AssetReferenceV1 {
            asset_id: "image:fixture".to_owned(),
            sha256: REVISION.to_owned(),
        },
        draw_id: "draw:image".to_owned(),
        entity_id: "image".to_owned(),
        local_rect: ImageLocalRectV1 {
            bottom: -1.0,
            left: -1.0,
            right: 1.0,
            top: 1.0,
        },
        opacity: 1.0,
        paint_order: 0,
        sampler: ImageSamplerV1::Linear,
        source_z_index: 0.0,
        transform: AffineTransformV1::identity(),
    });
    packet.required_capabilities = vec![RenderCapabilityV1::PngImage];

    let errors = validate_render_packet_v1(&packet).unwrap_err();
    assert!(errors.issues().contains(&ValidationIssue {
        message: "manim-cairo-srgb compositing does not support image draws".to_owned(),
        path: "$.draws[0].kind".to_owned(),
    }));
}

#[test]
fn render_packet_rejects_invalid_time_and_camera_aspect() {
    let mut late_sample = empty_packet();
    late_sample.sample_time = late_sample.scene_duration + 1.0;
    assert!(
        validate_render_packet_v1(&late_sample)
            .unwrap_err()
            .contains_message("must not exceed sceneDuration")
    );

    let mut wrong_aspect = empty_packet();
    wrong_aspect.viewport.width_px = wrong_aspect.viewport.height_px;
    assert!(
        validate_render_packet_v1(&wrong_aspect)
            .unwrap_err()
            .contains_message("camera and viewport aspect ratios must match")
    );
}

#[test]
fn render_packet_enforces_draw_order_paint_and_capabilities() {
    let mut packet = empty_packet();
    packet.draws.push(filled_path_draw(0));
    packet.required_capabilities = vec![RenderCapabilityV1::CubicPathFill];
    validate_render_packet_v1(&packet).unwrap();

    let mut wrong_order = packet.clone();
    wrong_order.draws[0] = filled_path_draw(1);
    assert!(
        validate_render_packet_v1(&wrong_order)
            .unwrap_err()
            .contains_message("must equal the back-to-front array index")
    );

    let mut wrong_capabilities = packet.clone();
    wrong_capabilities.required_capabilities.clear();
    assert!(
        validate_render_packet_v1(&wrong_capabilities)
            .unwrap_err()
            .contains_message("must exactly equal the capabilities derived from packet draws")
    );

    let mut unpainted = packet;
    let RenderDrawV1::Path { fill, .. } = &mut unpainted.draws[0] else {
        unreachable!()
    };
    *fill = None;
    unpainted.required_capabilities.clear();
    assert!(
        validate_render_packet_v1(&unpainted)
            .unwrap_err()
            .contains_message("path draws require a fill or stroke")
    );
}

#[test]
fn representative_scene_semantics_are_fail_closed() {
    let scene = empty_scene();
    validate_scene_ir_v1(&scene).unwrap();

    let mut self_asserted_capability = scene.clone();
    self_asserted_capability.required_capabilities = vec![SceneCapabilityV1::ShapePrimitives];
    assert!(
        validate_scene_ir_v1(&self_asserted_capability)
            .unwrap_err()
            .contains_message("derived from scene content")
    );

    let mut invalid_duration = scene;
    invalid_duration.duration = 0.0;
    assert!(
        validate_scene_ir_v1(&invalid_duration)
            .unwrap_err()
            .contains_message("must be positive")
    );
}

#[test]
fn engine_frame_checks_digest_and_cross_document_identity() {
    let frame = EngineFrameV1 {
        assets: empty_manifest(),
        packet: empty_packet(),
        scene: empty_scene(),
    };
    validate_engine_frame_v1(&frame).unwrap();
    let json = serde_json::to_vec(&frame).unwrap();
    assert_eq!(parse_engine_frame_json_v1(&json).unwrap(), frame);

    let mut stale_revision = frame.clone();
    stale_revision.packet.scene_revision_hash =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned();
    assert!(
        validate_engine_frame_v1(&stale_revision)
            .unwrap_err()
            .contains_message("scene revision")
    );

    let mut stale_compositing = frame.clone();
    stale_compositing.packet.compositing = RenderCompositingV1::ManimCairoSrgb;
    assert!(
        validate_engine_frame_v1(&stale_compositing)
            .unwrap_err()
            .contains_message("compositing does not match scene semantics")
    );

    let mut v11 = frame.clone();
    v11.scene.source = SceneSourceV1::ImportedManimServerSnapshot {
        runtime_config_hash: REVISION.to_owned(),
        snapshot_hash: REVISION.to_owned(),
        snapshot_version: SnapshotProfileVersionV1::V11,
        source_hash: REVISION.to_owned(),
    };
    validate_engine_frame_v1(&v11).unwrap();
    v11.scene.compositing = RenderCompositingV1::ManimCairoSrgb;
    assert!(
        validate_engine_frame_v1(&v11)
            .unwrap_err()
            .contains_message("compositing does not match scene semantics")
    );
    v11.packet.compositing = RenderCompositingV1::ManimCairoSrgb;
    validate_engine_frame_v1(&v11).unwrap();

    let mut stale_digest = frame;
    stale_digest.assets.manifest_digest =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned();
    assert!(
        validate_engine_frame_v1(&stale_digest)
            .unwrap_err()
            .contains_message("canonical manifest metadata")
    );
}

#[test]
fn singular_affine_empty_draw_requires_a_singular_transform_and_matching_channel() {
    let mut scene = empty_scene();
    scene.entities.push(SceneEntityV1 {
        appearance: SceneAppearanceV1::Vector {
            fill: Some(FillStyleV1 {
                color: black(),
                rule: FillRuleV1::NonZero,
            }),
            opacity: 1.0,
            stroke: None,
        },
        geometry: SceneGeometryV1::Circle {
            center: PointV1 { x: 0.0, y: 0.0 },
            radius: 1.0,
        },
        id: "circle".to_owned(),
        lifetimes: vec![IntervalV1 {
            end: 2.0,
            start: 0.0,
        }],
        parent_id: None,
        provenance_id: "fixture:root".to_owned(),
        scene_order: 0,
        source_z_index: 0.0,
        transform: AffineTransformV1::identity(),
    });
    scene.required_capabilities = vec![SceneCapabilityV1::ShapePrimitives];

    let singular_transform = AffineTransformV1 {
        m11: 0.0,
        ..AffineTransformV1::identity()
    };
    let mut packet = empty_packet();
    packet.draws.push(RenderDrawV1::Empty {
        draw_id: "draw:0".to_owned(),
        entity_id: "circle".to_owned(),
        opacity: 1.0,
        paint_order: 0,
        reason: RenderEmptyReasonV1::SingularAffineSample,
        source_z_index: 0.0,
        transform: singular_transform,
    });
    validate_render_packet_v1(&packet).unwrap();

    let mut frame = EngineFrameV1 {
        assets: empty_manifest(),
        packet,
        scene,
    };
    assert!(
        validate_engine_frame_v1(&frame)
            .unwrap_err()
            .contains_message("no affine-transform channel")
    );

    frame
        .scene
        .animation_channels
        .push(AnimationChannelV1::AffineTransform {
            entity_id: "circle".to_owned(),
            id: "reflect:circle".to_owned(),
            keyframes: vec![
                KeyframeV1 {
                    at: 0.0,
                    easing_to_next: Some(EasingV1::Linear {}),
                    value: AffineTransformV1::identity(),
                },
                KeyframeV1 {
                    at: 2.0,
                    easing_to_next: None,
                    value: AffineTransformV1 {
                        m11: -1.0,
                        ..AffineTransformV1::identity()
                    },
                },
            ],
            provenance_id: "fixture:root".to_owned(),
        });
    frame.scene.required_capabilities = vec![
        SceneCapabilityV1::AffineTransformAnimation,
        SceneCapabilityV1::ShapePrimitives,
    ];
    validate_engine_frame_v1(&frame).unwrap();

    let RenderDrawV1::Empty { transform, .. } = &mut frame.packet.draws[0] else {
        unreachable!()
    };
    *transform = AffineTransformV1::identity();
    assert!(
        validate_render_packet_v1(&frame.packet)
            .unwrap_err()
            .contains_message("requires a singular or near-singular transform")
    );
}

#[test]
fn near_singular_affine_empty_draws_are_accepted_at_the_f32_threshold() {
    // The production snapshot profile seals every finite, bounded, non-zero
    // matrix. The canonical Rust predicate therefore classifies a sample that
    // only collapses in f32 before WGPU preparation can fail the complete frame.
    let empty_packet_with = |transform: AffineTransformV1| {
        let mut packet = empty_packet();
        packet.draws.push(RenderDrawV1::Empty {
            draw_id: "draw:0".to_owned(),
            entity_id: "circle".to_owned(),
            opacity: 1.0,
            paint_order: 0,
            reason: RenderEmptyReasonV1::SingularAffineSample,
            source_z_index: 0.0,
            transform,
        });
        packet
    };
    let matrix = |m11: f64, m22: f64| AffineTransformV1 {
        m11,
        m22,
        ..AffineTransformV1::identity()
    };

    // Bit equality: the threshold is an exact IEEE-754 quantity, not a
    // tolerance chosen independently by an adapter.
    assert_eq!(
        MIN_AFFINE_DETERMINANT_V1.to_bits(),
        1.175_494_350_822_287_5e-38_f64.to_bits()
    );
    // Exactly singular keeps classifying exactly as before.
    validate_render_packet_v1(&empty_packet_with(matrix(0.0, 1.0))).unwrap();
    // Determinant below the smallest normal f32.
    validate_render_packet_v1(&empty_packet_with(matrix(1e-50, 1.0))).unwrap();
    // One entry underflows in f32 even though the f64 determinant is 1e-20,
    // which is why the predicate rounds entries before multiplying.
    validate_render_packet_v1(&empty_packet_with(matrix(1e-50, 1e30))).unwrap();
    // Exactly at the threshold is renderable, so the reason does not apply.
    assert!(
        validate_render_packet_v1(&empty_packet_with(matrix(1.0, MIN_AFFINE_DETERMINANT_V1)))
            .unwrap_err()
            .contains_message("requires a singular or near-singular transform")
    );
    // An ordinary small-but-renderable scale keeps its path draw.
    assert!(
        validate_render_packet_v1(&empty_packet_with(matrix(1e-3, 1e-3)))
            .unwrap_err()
            .contains_message("requires a singular or near-singular transform")
    );
}

#[test]
fn serialized_field_and_tag_names_match_the_v1_wire_format() {
    let scene = serde_json::to_value(empty_scene()).unwrap();
    assert!(scene.get("animationChannels").is_some());
    assert!(scene.get("assetManifest").is_some());
    assert!(scene.get("coordinateSpace").is_some());
    assert!(scene.get("animation_channels").is_none());

    let easing = serde_json::to_value(EasingV1::CubicBezier {
        x1: 0.25,
        x2: 0.75,
        y1: 0.1,
        y2: 0.9,
    })
    .unwrap();
    assert_eq!(easing["kind"], "cubic-bezier");

    let manim_smooth = serde_json::to_value(EasingV1::ManimSmooth {}).unwrap();
    assert_eq!(manim_smooth, json!({ "kind": "manim-smooth" }));
    assert_eq!(
        serde_json::from_value::<EasingV1>(manim_smooth).unwrap(),
        EasingV1::ManimSmooth {}
    );

    let channel = json!({
        "entityId": "shape",
        "id": "appearance:shape",
        "keyframes": [
            {
                "at": 0,
                "easingToNext": { "kind": "manim-smooth" },
                "value": {
                    "fill": {
                        "color": { "alpha": 0, "blue": 1, "green": 1, "red": 1 },
                        "rule": "nonzero"
                    },
                    "stroke": null
                }
            },
            {
                "at": 1,
                "easingToNext": null,
                "value": {
                    "fill": {
                        "color": { "alpha": 0.5, "blue": 0.75, "green": 0.25, "red": 0.8 },
                        "rule": "nonzero"
                    },
                    "stroke": null
                }
            }
        ],
        "kind": "vector-appearance",
        "provenanceId": "fixture:root"
    });
    assert!(matches!(
        serde_json::from_value::<AnimationChannelV1>(channel.clone()).unwrap(),
        AnimationChannelV1::VectorAppearance { .. }
    ));
    let mut missing_nullable = channel.clone();
    missing_nullable["keyframes"][0]["value"]
        .as_object_mut()
        .unwrap()
        .remove("stroke");
    assert!(serde_json::from_value::<AnimationChannelV1>(missing_nullable).is_err());
    let mut unknown_paint = channel;
    unknown_paint["keyframes"][1]["value"]["fill"]["gradient"] = json!(true);
    assert!(serde_json::from_value::<AnimationChannelV1>(unknown_paint).is_err());
    assert_eq!(
        serde_json::to_value(SceneCapabilityV1::VectorAppearanceAnimation).unwrap(),
        json!("vector-appearance-animation")
    );
}

#[test]
fn json_boundary_rejects_oversized_documents_before_deserialization() {
    let oversized = vec![b' '; MAX_CONTRACT_JSON_BYTES_V1 + 1];
    let error = parse_scene_ir_json_v1(&oversized).unwrap_err();
    assert!(matches!(
        error,
        ContractJsonError::InputTooLarge {
            actual_bytes,
            maximum_bytes: MAX_CONTRACT_JSON_BYTES_V1,
        } if actual_bytes == MAX_CONTRACT_JSON_BYTES_V1 + 1
    ));
}

#[test]
fn validation_error_collection_is_bounded() {
    let issues = (0..(MAX_VALIDATION_ISSUES_V1 * 2))
        .map(|index| ValidationIssue {
            path: format!("$.items[{index}]"),
            message: "invalid".to_owned(),
        })
        .collect();
    let errors = ValidationErrors::new(issues);
    assert_eq!(errors.issues().len(), MAX_VALIDATION_ISSUES_V1);
    assert!(errors.contains_message("additional validation issues omitted"));
}

#[test]
fn bounded_text_uses_javascript_utf16_length() {
    let mut scene = empty_scene();
    scene.provenance[0].evidence = vec!["😀".repeat(250)];
    validate_scene_ir_v1(&scene).unwrap();

    scene.provenance[0].evidence = vec!["😀".repeat(251)];
    assert!(
        validate_scene_ir_v1(&scene)
            .unwrap_err()
            .contains_message("1 to 500")
    );
}

const SHARED_EXPORT_PROFILE_JSON: &str =
    include_str!("../../../../fixtures/engine-v1/shared-export-profile.json");
const SHARED_EXPORT_PROFILE_CANONICAL: &str = concat!(
    r#"{"codec":"h264-mp4","colorContractVersion":1,"frameRate":30,"#,
    r#""maxDurationSeconds":900,"maxOutputBytes":134217728,"resolution":"1920x1080","#,
    r#""schema":"poietra.export-profile","version":1}"#
);
const SHARED_EXPORT_PROFILE_HASH: &str =
    "a6c8e0a9178087ae3ee29acc14a5d5e21fe596b440f1e90d61cdd91b2b87d70c";

fn shared_export_profile() -> ExportProfileV1 {
    ExportProfileV1 {
        codec: ExportCodecTierV1::H264Mp4,
        color_contract_version: ExportColorContractVersionV1,
        frame_rate: ExportFrameRateV1::Fps30,
        max_duration_seconds: MAX_EXPORT_DURATION_SECONDS_V1,
        max_output_bytes: MAX_EXPORT_OUTPUT_BYTES_V1,
        resolution: ExportResolutionV1::FullHd1920x1080,
        schema: ExportProfileSchemaV1::ExportProfile,
        version: ContractVersionV1,
    }
}

#[test]
fn shared_export_profile_fixture_parses_and_matches_the_canonical_hash() {
    let profile = parse_export_profile_json_v1(SHARED_EXPORT_PROFILE_JSON.as_bytes()).unwrap();
    assert_eq!(profile, shared_export_profile());
    validate_export_profile_v1(&profile).unwrap();
    assert_eq!(profile.resolution.width_px(), 1920);
    assert_eq!(profile.resolution.height_px(), 1080);
    assert_f64_bits_eq(profile.frame_rate.frames_per_second(), 30.0);
    assert_eq!(
        canonical_export_profile_v1(&profile).unwrap(),
        SHARED_EXPORT_PROFILE_CANONICAL
    );
    assert_eq!(
        export_profile_hash_v1(&profile).unwrap(),
        SHARED_EXPORT_PROFILE_HASH
    );
    assert_eq!(
        serde_json::to_string(&profile).unwrap(),
        SHARED_EXPORT_PROFILE_CANONICAL
    );
}

#[test]
fn export_profile_serde_is_closed_over_every_field() {
    let base = serde_json::to_value(shared_export_profile()).unwrap();

    let mut unknown = base.clone();
    unknown["encoderQueueDepth"] = json!(8);
    assert!(
        serde_json::from_value::<ExportProfileV1>(unknown)
            .unwrap_err()
            .to_string()
            .contains("unknown field")
    );

    for (field, value) in [
        ("codec", json!("av1-webm")),
        ("colorContractVersion", json!(2)),
        ("frameRate", json!(24)),
        ("frameRate", json!(59.94)),
        ("resolution", json!("640x360")),
        ("schema", json!("poietra.scene-ir")),
        ("version", json!(2)),
        ("maxDurationSeconds", json!(1.5)),
        ("maxOutputBytes", json!(-1)),
    ] {
        let mut open = base.clone();
        open[field] = value;
        assert!(
            serde_json::from_value::<ExportProfileV1>(open).is_err(),
            "open {field} value was not rejected"
        );
    }
}

#[test]
fn export_profile_declared_bounds_are_fail_closed_at_the_v1_ceilings() {
    let mut profile = shared_export_profile();
    validate_export_profile_v1(&profile).unwrap();

    profile.max_duration_seconds = MAX_EXPORT_DURATION_SECONDS_V1 + 1;
    assert!(
        validate_export_profile_v1(&profile)
            .unwrap_err()
            .contains_message("between 1 and 900 seconds")
    );
    profile.max_duration_seconds = 0;
    assert!(validate_export_profile_v1(&profile).is_err());
    profile.max_duration_seconds = 1;

    profile.max_output_bytes = MAX_EXPORT_OUTPUT_BYTES_V1 + 1;
    assert!(
        validate_export_profile_v1(&profile)
            .unwrap_err()
            .contains_message("between 1 and 134217728 bytes")
    );
    profile.max_output_bytes = 0;
    assert!(validate_export_profile_v1(&profile).is_err());
    profile.max_output_bytes = 1;
    validate_export_profile_v1(&profile).unwrap();

    let mut oversized = serde_json::to_value(shared_export_profile()).unwrap();
    oversized["maxDurationSeconds"] = json!(901);
    let error = parse_export_profile_json_v1(&serde_json::to_vec(&oversized).unwrap()).unwrap_err();
    assert!(matches!(error, ContractJsonError::Validation(_)));
}

/// #693 Question 6 decision: the profile supplies the sampling fps, while the
/// Scene's own `state_sampling` declaration keeps quantizing each requested
/// instant and is never overwritten by the profile.
#[test]
fn export_stepping_composes_profile_fps_with_the_scene_sampling_grid() {
    let mut scene = empty_scene();
    scene.state_sampling = SceneStateSamplingV1 {
        frame_rate: Some(15.0),
        retains_terminal_state: true,
    };
    let profile = shared_export_profile();
    let fps = profile.frame_rate.frames_per_second();

    // The profile chooses the requested instants i / fps; the Scene's 15 fps
    // grid still resolves each request, so the 30 fps step between grid frames
    // floors onto the preceding Scene frame.
    assert_f64_bits_eq(scene.state_sample_time(0.0 / fps), 0.0);
    assert_f64_bits_eq(scene.state_sample_time(1.0 / fps), 0.0);
    assert_f64_bits_eq(scene.state_sample_time(2.0 / fps), 1.0 / 15.0);

    // The Scene declaration survives export stepping untouched.
    assert_eq!(scene.state_sampling.frame_rate, Some(15.0));
    assert!(scene.state_sampling.retains_terminal_state);
}
