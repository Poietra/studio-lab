use poietra_scene_ir::*;
use serde_json::json;

const REVISION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EMPTY_MANIFEST_DIGEST: &str =
    "8f2a9813bcfc60b693fc34b8046d64352004b50a17e224bb138daae7da9e941d";

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

#[test]
fn canonical_empty_manifest_matches_the_typescript_wire_digest() {
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
}

#[test]
fn imported_snapshot_source_accepts_profiles_one_and_two_only() {
    for snapshot_version in [SnapshotProfileVersionV1::V1, SnapshotProfileVersionV1::V2] {
        let mut scene = empty_scene();
        scene.source = SceneSourceV1::ImportedManimServerSnapshot {
            runtime_config_hash: REVISION.to_owned(),
            snapshot_hash: REVISION.to_owned(),
            snapshot_version,
            source_hash: REVISION.to_owned(),
        };
        validate_scene_ir_v1(&scene).unwrap();
        assert_eq!(
            parse_scene_ir_json_v1(&serde_json::to_vec(&scene).unwrap()).unwrap(),
            scene
        );
        if snapshot_version == SnapshotProfileVersionV1::V2 {
            let json = serde_json::to_string(&scene)
                .unwrap()
                .replace(r#""snapshotVersion":2"#, r#""snapshotVersion":2.0"#);
            assert_eq!(parse_scene_ir_json_v1(json.as_bytes()).unwrap(), scene);
        }
    }

    let mut invalid = serde_json::to_value(empty_scene()).unwrap();
    invalid["source"] = json!({
        "kind": "imported-manim-server-snapshot",
        "runtimeConfigHash": REVISION,
        "snapshotHash": REVISION,
        "snapshotVersion": 3.0,
        "sourceHash": REVISION,
    });
    assert!(serde_json::from_value::<SceneIrV1>(invalid).is_err());
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
            .contains_message("requires an exactly singular transform")
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
