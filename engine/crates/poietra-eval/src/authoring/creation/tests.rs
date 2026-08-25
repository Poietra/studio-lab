use std::f64::consts::{FRAC_PI_2, PI};

use super::super::tests::{NEXT_REVISION, fixture_bundle, imported_bundle, static_imported_bundle};
use super::super::{
    StudioTextAlignment, StudioTextFontFamily, StudioTextFontWeight, StudioTextLayout,
};
use super::*;

#[test]
fn property_easing_input_names_expand_to_canonical_scene_easing() {
    let cases = [
        ("linear", EasingV1::Linear {}),
        ("smooth", EasingV1::ManimSmooth {}),
        (
            "ease-in",
            EasingV1::CubicBezier {
                x1: 0.42,
                x2: 1.0,
                y1: 0.0,
                y2: 1.0,
            },
        ),
        (
            "ease-out",
            EasingV1::CubicBezier {
                x1: 0.0,
                x2: 0.58,
                y1: 0.0,
                y2: 1.0,
            },
        ),
        (
            "ease-in-out",
            EasingV1::CubicBezier {
                x1: 0.42,
                x2: 0.58,
                y1: 0.0,
                y2: 1.0,
            },
        ),
    ];

    for (name, expected) in cases {
        let easing: StudioPropertyEasing = serde_json::from_str(&format!("\"{name}\"")).unwrap();
        assert_eq!(property_easing(easing), expected);
    }
}

#[test]
fn shape_transform_wire_uses_the_bounded_flat_contract() {
    let operation: StudioCreationOperationKind = serde_json::from_value(serde_json::json!({
        "kind": "shape-transform",
        "easing": "smooth",
        "fromShape": "rectangle",
        "fromDimensions": { "width": 4.0, "height": 2.0 },
        "toShape": "circle",
        "toDimensions": { "radius": 1.0 }
    }))
    .unwrap();
    assert!(matches!(
        operation,
        StudioCreationOperationKind::TransformShape {
            easing: StudioPropertyEasing::Smooth,
            from_shape: StudioAuthoringEntityKind::Rectangle,
            to_shape: StudioAuthoringEntityKind::Circle,
            ..
        }
    ));

    let projection = StudioCreationProjectedMutationKind::ShapeTransform {
        easing: EasingV1::ManimSmooth {},
        from_dimensions: StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: Some(2.0),
            radius: None,
            sides: None,
            width: Some(4.0),
        },
        from_shape: StudioAuthoringEntityKind::Rectangle,
        to_dimensions: StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: Some(1.0),
            sides: None,
            width: None,
        },
        to_shape: StudioAuthoringEntityKind::Circle,
    };
    assert_eq!(
        serde_json::to_value(projection).unwrap(),
        serde_json::json!({
            "kind": "shape-transform",
            "easing": { "kind": "manim-smooth" },
            "fromShape": "rectangle",
            "fromDimensions": { "width": 4.0, "height": 2.0 },
            "toShape": "circle",
            "toDimensions": { "radius": 1.0 }
        })
    );
}

#[test]
fn path_morph_wire_keeps_geometry_separate_from_appearance() {
    let operation: StudioCreationOperationKind = serde_json::from_value(serde_json::json!({
        "kind": "path-morph",
        "easing": "smooth",
        "fromPath": {
            "closed": false,
            "start": { "x": -1.0, "y": 0.0 },
            "segments": [{
                "control1": { "x": -0.5, "y": 1.0 },
                "control2": { "x": 0.5, "y": 1.0 },
                "end": { "x": 1.0, "y": 0.0 }
            }]
        },
        "toPath": {
            "closed": false,
            "start": { "x": -1.0, "y": 0.0 },
            "segments": [{
                "control1": { "x": -0.5, "y": -1.0 },
                "control2": { "x": 0.5, "y": -1.0 },
                "end": { "x": 1.0, "y": 0.0 }
            }]
        }
    }))
    .unwrap();
    let StudioCreationOperationKind::PathMorph {
        easing,
        from_path,
        to_path,
    } = operation
    else {
        panic!("path-morph must deserialize to the canonical operation");
    };
    assert_eq!(easing, StudioPropertyEasing::Smooth);
    assert!(!from_path.closed);
    assert_eq!(from_path.segments.len(), 1);

    let projection = StudioCreationProjectedMutationKind::PathMorph {
        easing: EasingV1::ManimSmooth {},
        from_path,
        to_path,
    };
    let serialized = serde_json::to_value(projection).unwrap();
    assert_eq!(serialized["kind"], "path-morph");
    assert_eq!(serialized["easing"]["kind"], "manim-smooth");
    assert!(serialized.get("fillColor").is_none());
    assert!(serialized.get("strokeWidth").is_none());
    assert_eq!(
        serialized["fromPath"]["segments"].as_array().unwrap().len(),
        1
    );
    assert_eq!(
        serialized["toPath"]["segments"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn paint_color_keyframe_wire_uses_one_property_discriminant() {
    let operation: StudioCreationOperationKind = serde_json::from_value(serde_json::json!({
        "kind": "paint-color-keyframes",
        "easing": "smooth",
        "from": "#ff0000",
        "property": "fill-color",
        "to": "#0000ff"
    }))
    .unwrap();
    assert!(matches!(
        operation,
        StudioCreationOperationKind::PaintColorKeyframes {
            easing: StudioPropertyEasing::Smooth,
            property: StudioPaintColorProperty::FillColor,
            ..
        }
    ));

    let projection = StudioCreationProjectedMutationKind::PaintColorKeyframes {
        easing: EasingV1::Linear {},
        from: "#ffffff".to_owned(),
        property: StudioPaintColorProperty::StrokeColor,
        to: "#22c55e".to_owned(),
    };
    assert_eq!(
        serde_json::to_value(projection).unwrap(),
        serde_json::json!({
            "kind": "paint-color-keyframes",
            "easing": { "kind": "linear" },
            "from": "#ffffff",
            "property": "stroke-color",
            "to": "#22c55e"
        })
    );
}

#[test]
fn stroke_color_tracks_are_limited_to_stroke_only_paths() {
    for kind in [
        StudioAuthoringEntityKind::Arc,
        StudioAuthoringEntityKind::Axes,
        StudioAuthoringEntityKind::CubicBezier,
        StudioAuthoringEntityKind::DataPlot,
        StudioAuthoringEntityKind::Line,
        StudioAuthoringEntityKind::NumberLine,
        StudioAuthoringEntityKind::NumberPlane,
    ] {
        assert!(studio_creation_supports_stroke_color_track(kind));
    }
    for kind in [
        StudioAuthoringEntityKind::Arrow,
        StudioAuthoringEntityKind::Circle,
        StudioAuthoringEntityKind::Sector,
        StudioAuthoringEntityKind::SvgPath,
    ] {
        assert!(!studio_creation_supports_stroke_color_track(kind));
    }
}

#[test]
fn static_stroke_style_support_is_limited_to_supported_paths() {
    for kind in [
        StudioAuthoringEntityKind::Arc,
        StudioAuthoringEntityKind::Axes,
        StudioAuthoringEntityKind::DataPlot,
        StudioAuthoringEntityKind::NumberLine,
        StudioAuthoringEntityKind::NumberPlane,
    ] {
        assert!(studio_creation_supports_stroke_width(kind));
        assert!(studio_creation_supports_stroke_cap(kind));
    }
    for kind in [
        StudioAuthoringEntityKind::Arrow,
        StudioAuthoringEntityKind::CubicBezier,
        StudioAuthoringEntityKind::Sector,
        StudioAuthoringEntityKind::SvgPath,
    ] {
        assert!(!studio_creation_supports_stroke_width(kind));
        assert!(!studio_creation_supports_stroke_cap(kind));
    }
}

#[test]
fn camera_animation_wire_uses_scene_level_views() {
    let operation: StudioCreationOperationKind = serde_json::from_value(serde_json::json!({
        "kind": "animate-camera",
        "easing": "smooth",
        "fromView": {
            "center": { "x": 0.0, "y": 0.0 },
            "frameHeight": 9.0,
            "frameWidth": 16.0
        },
        "toView": {
            "center": { "x": 4.0, "y": 0.0 },
            "frameHeight": 4.5,
            "frameWidth": 8.0
        }
    }))
    .unwrap();
    assert!(matches!(
        operation,
        StudioCreationOperationKind::AnimateCamera {
            easing: StudioPropertyEasing::Smooth,
            ..
        }
    ));

    let mutation = StudioCreationProjectedMutation {
        entity_id: String::new(),
        interval: IntervalV1 {
            start: 0.25,
            end: 0.75,
        },
        kind: StudioCreationProjectedMutationKind::AnimateCamera {
            easing: EasingV1::ManimSmooth {},
            from_view: camera_view(0.0, 16.0),
            to_view: camera_view(4.0, 8.0),
        },
        operation_id: "camera-focus".to_owned(),
        transaction_id: "camera-focus".to_owned(),
    };
    let serialized = serde_json::to_value(mutation).unwrap();
    assert!(serialized.get("entityId").is_none());
    assert_eq!(serialized["kind"], "animate-camera");
    assert_eq!(serialized["fromView"]["frameWidth"], 16.0);
    assert_eq!(serialized["toView"]["frameWidth"], 8.0);
}

fn studio_scene_background_edit_input(color: Option<&str>) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: 0.0,
        anchor_resolved_seconds: 0.0,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(0.0),
        },
        intent_count: 1,
        lowering_supported: false,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: None,
            id: "set-scene-background".to_owned(),
            interval: IntervalV1 {
                end: 0.0,
                start: 0.0,
            },
            kind: StudioCreationOperationKind::SceneBackground {
                color: color.map(str::to_owned),
            },
            origin: StudioAuthoringOrigin::StudioDefault,
        }],
        origin: StudioAuthoringOrigin::StudioDefault,
        requested_execution: SceneEditExecution::Parallel,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order: vec!["set-scene-background".to_owned()],
        transaction_id: "scene-background".to_owned(),
    }
}

#[test]
fn studio_native_scene_background_is_projected_and_materialized_atomically() {
    let mut bundle = static_imported_bundle();
    bundle.scene.source = SceneSourceV1::StudioEditProgram {
        edit_program_version: ContractVersionV1,
        revision_hash: "ab".repeat(32),
    };
    bundle.scene.provenance.push(ProvenanceRecordV1 {
        evidence: vec!["Source-free Studio-native Editor Document".to_owned()],
        id: "studio-native-document".to_owned(),
        origin: ProvenanceOriginV1::StudioEditProgram,
    });
    let program = studio_scene_background_edit_input(Some("#123456"));
    let projection =
        project_studio_creation_edits(bundle.scene.duration, std::slice::from_ref(&program))
            .unwrap();
    assert!(projection.entities.is_empty());
    assert_eq!(projection.mutations.len(), 1);
    assert!(matches!(
        &projection.mutations[0].kind,
        StudioCreationProjectedMutationKind::SceneBackground { value } if value == "#123456"
    ));

    let mut command = studio_creation_command(&bundle);
    command.programs = vec![program];
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection, Some(projection));
    assert_eq!(
        result.bundle.scene.camera.background,
        RgbaColorV1 {
            alpha: 1.0,
            blue: 86.0 / 255.0,
            green: 52.0 / 255.0,
            red: 18.0 / 255.0,
        }
    );
    assert_eq!(
        session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "scene-background",
                sample_time: 0.0,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap()
            .camera
            .clear_color,
        result.bundle.scene.camera.background
    );
}

#[test]
fn scene_background_rejects_alpha_and_imported_scenes() {
    let mut imported = static_imported_bundle();
    imported.scene.provenance.push(ProvenanceRecordV1 {
        evidence: vec!["forged Studio-native marker".to_owned()],
        id: "studio-native-document".to_owned(),
        origin: ProvenanceOriginV1::StudioEditProgram,
    });
    let invalid = studio_scene_background_edit_input(Some("#123456ff"));
    assert!(matches!(
        project_studio_creation_edits(imported.scene.duration, &[invalid]),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut command = studio_creation_command(&imported);
    command.programs = vec![studio_scene_background_edit_input(Some("#123456"))];
    let mut session = EngineSessionV1::new(imported).unwrap();
    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
}

fn studio_persistent_remove_edit_input(
    entity_id: &str,
    start: f64,
    end: f64,
) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: start,
        anchor_resolved_seconds: start,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(start),
        },
        intent_count: 1,
        lowering_supported: true,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.to_owned()),
            id: "remove-created".to_owned(),
            interval: IntervalV1 { end, start },
            kind: StudioCreationOperationKind::PersistentRemove { persistent: true },
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Parallel,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order: vec!["remove-created".to_owned()],
        transaction_id: "remove-created".to_owned(),
    }
}

fn studio_group_lifetime_trim_edit_input(
    entity_ids: &[String],
    at: f64,
) -> StudioCreationEditInput {
    let operations = entity_ids
        .iter()
        .enumerate()
        .map(|(index, entity_id)| StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.clone()),
            id: format!("trim-group-lifetime-{index}"),
            interval: IntervalV1 { end: at, start: at },
            kind: StudioCreationOperationKind::PersistentRemove { persistent: true },
            origin: StudioAuthoringOrigin::DirectManipulation,
        })
        .collect::<Vec<_>>();
    StudioCreationEditInput {
        anchor_captured_playhead: at,
        anchor_resolved_seconds: at,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(at),
        },
        intent_count: 1,
        lowering_supported: true,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order: operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect(),
        operations,
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Parallel,
        transaction_id: "trim-group-lifetime".to_owned(),
    }
}

fn mathtex_fixture_path() -> CubicPathV1 {
    let SceneGeometryV1::CubicPath { path } =
        fixture_bundle("mathtex-nested-radical-fraction.json")
            .scene
            .entities
            .remove(0)
            .geometry
    else {
        panic!("MathTex fixture must contain cubic-path geometry");
    };
    path
}

#[allow(
    clippy::too_many_lines,
    reason = "keeps the complete creation fixture explicit"
)]
fn create_command(bundle: &SceneIrBundleV1) -> CreateSceneEntitiesCommand {
    CreateSceneEntitiesCommand {
        camera_animation: None,
        entities: vec![
            CreateSceneEntity {
                animated_resize: None,
                appearance_at: None,
                draw_in: None,
                fade_in: None,
                fill_color: None,
                geometry: CreateSceneEntityGeometry::Circle { radius: 0.75 },
                id: "tx:create/entity:circle".to_owned(),
                lifetime: IntervalV1 {
                    end: 2.5,
                    start: 0.5,
                },
                material_parameter_keyframes: vec![],
                math_tex_morph: None,
                paint_opacity: 1.0,
                opacity_keyframes: vec![],
                paint_color_track: None,
                position: PointV1 { x: 2.0, y: -1.0 },
                rotation: 0.0,
                rotation_keyframes: vec![],
                scale: 1.25,
                uniform_scale_keyframes: vec![],
                source_z_index: None,
                path_morph: None,
                shape_morph: None,
                stroke_color: None,
                stroke_cap: None,
                stroke_dash: None,
                stroke_join: None,
                stroke_width_world: None,
                instant_transform: None,
                visible: true,
                write_in: None,
            },
            CreateSceneEntity {
                animated_resize: None,
                appearance_at: None,
                draw_in: None,
                fade_in: Some(CreateSceneEntityFadeIn { end: 0.9 }),
                fill_color: None,
                geometry: CreateSceneEntityGeometry::Rectangle {
                    height: 2.0,
                    width: 3.0,
                },
                id: "tx:create/entity:rectangle".to_owned(),
                lifetime: IntervalV1 {
                    end: 2.5,
                    start: 0.5,
                },
                material_parameter_keyframes: vec![],
                math_tex_morph: None,
                paint_opacity: 1.0,
                opacity_keyframes: vec![],
                paint_color_track: None,
                position: PointV1 { x: -2.0, y: 1.0 },
                rotation: 0.0,
                rotation_keyframes: vec![],
                scale: 0.5,
                uniform_scale_keyframes: vec![],
                source_z_index: None,
                path_morph: None,
                shape_morph: None,
                stroke_color: None,
                stroke_cap: None,
                stroke_dash: None,
                stroke_join: None,
                stroke_width_world: None,
                instant_transform: Some(CreateSceneEntityInstantTransform {
                    at: 1.25,
                    position: PointV1 { x: -1.0, y: 0.5 },
                    rotation: 0.0,
                    scale_x: 0.75,
                    scale_y: 1.0,
                }),
                visible: true,
                write_in: None,
            },
            CreateSceneEntity {
                animated_resize: None,
                appearance_at: None,
                draw_in: None,
                fade_in: None,
                fill_color: None,
                geometry: CreateSceneEntityGeometry::CubicOutline {
                    path: mathtex_fixture_path(),
                },
                id: "tx:create/entity:mathtex".to_owned(),
                lifetime: IntervalV1 {
                    end: 2.5,
                    start: 0.5,
                },
                material_parameter_keyframes: vec![],
                math_tex_morph: None,
                paint_opacity: 1.0,
                opacity_keyframes: vec![],
                paint_color_track: None,
                position: PointV1 { x: 0.0, y: 1.5 },
                rotation: 0.0,
                rotation_keyframes: vec![],
                scale: 2.0,
                uniform_scale_keyframes: vec![],
                source_z_index: None,
                path_morph: None,
                shape_morph: None,
                stroke_color: None,
                stroke_cap: None,
                stroke_dash: None,
                stroke_join: None,
                stroke_width_world: None,
                instant_transform: None,
                visible: true,
                write_in: None,
            },
        ],
        expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
        groups: vec![],
        motions: vec![],
        next_revision: NEXT_REVISION.to_owned(),
        persistent_removals: vec![],
        provenance: ProvenanceRecordV1 {
            evidence: vec!["authorized Studio creation batch".to_owned()],
            id: "studio-create".to_owned(),
            origin: ProvenanceOriginV1::StudioEditProgram,
        },
        scene_background: None,
        timeline_insertions: vec![
            SceneTimelineInsertion {
                at: 0.5,
                duration: 0.25,
            },
            SceneTimelineInsertion {
                at: 0.75,
                duration: 0.25,
            },
        ],
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "one explicit normalized command fixture keeps the accepted wire subset visible"
)]
fn studio_creation_command(bundle: &SceneIrBundleV1) -> ApplyStudioCreationEditCommand {
    let entity_id = "tx:create/entity:circle";
    let create_interval = IntervalV1 {
        end: 0.5,
        start: 0.5,
    };
    let resize_interval = IntervalV1 {
        end: 0.85,
        start: 0.85,
    };
    ApplyStudioCreationEditCommand {
        expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
        frame: StudioAuthoringSize {
            height: bundle.scene.camera.view.frame_height,
            width: bundle.scene.camera.view.frame_width,
        },
        math_tex_outlines: vec![],
        next_revision: NEXT_REVISION.to_owned(),
        programs: vec![
            StudioCreationEditInput {
                anchor_captured_playhead: 0.5,
                anchor_resolved_seconds: 0.5,
                anchor_source: SceneEditAnchorSource::Playhead {
                    reference_seconds: Some(0.5),
                },
                intent_count: 1,
                lowering_supported: true,
                operations: vec![
                    StudioCreationOperation {
                        depends_on: vec![],
                        entity_id: None,
                        id: "create".to_owned(),
                        interval: create_interval.clone(),
                        kind: StudioCreationOperationKind::Create {
                            entity: StudioCreationEntitySpec {
                                cubic_bezier: None,
                                data_series: None,
                                dimensions: StudioAuthoringDimensions {
                                    angles: None,
                                    coordinate_system: None,
                                    height: None,
                                    radius: Some(1.0),
                                    sides: None,
                                    width: None,
                                },
                                id: entity_id.to_owned(),
                                image: None,
                                kind: StudioAuthoringEntityKind::Circle,
                                layout: None,
                                lifetime_end: None,
                                lifetime_start: 0.5,
                                text: None,
                                tex_parts: None,
                                svg: None,
                            },
                        },
                        origin: StudioAuthoringOrigin::StudioDefault,
                    },
                    StudioCreationOperation {
                        depends_on: vec!["create".to_owned()],
                        entity_id: Some(entity_id.to_owned()),
                        id: "position".to_owned(),
                        interval: create_interval,
                        kind: StudioCreationOperationKind::Position {
                            position: Some(PointV1 { x: 320.0, y: 180.0 }),
                        },
                        origin: StudioAuthoringOrigin::StudioDefault,
                    },
                    StudioCreationOperation {
                        depends_on: vec!["position".to_owned()],
                        entity_id: Some(entity_id.to_owned()),
                        id: "fade".to_owned(),
                        interval: IntervalV1 {
                            end: 0.9,
                            start: 0.5,
                        },
                        kind: StudioCreationOperationKind::FadeIn { persistent: true },
                        origin: StudioAuthoringOrigin::StudioDefault,
                    },
                ],
                origin: StudioAuthoringOrigin::StudioDefault,
                requested_execution: SceneEditExecution::Parallel,
                schedule_edge_count: 4,
                schedule_mode: SceneEditScheduleMode::DependencyDag,
                schedule_order: vec![
                    "create".to_owned(),
                    "position".to_owned(),
                    "fade".to_owned(),
                ],
                transaction_id: "create".to_owned(),
            },
            StudioCreationEditInput {
                anchor_captured_playhead: 0.85,
                anchor_resolved_seconds: 0.85,
                anchor_source: SceneEditAnchorSource::Playhead {
                    reference_seconds: Some(0.85),
                },
                intent_count: 1,
                lowering_supported: true,
                operations: vec![StudioCreationOperation {
                    depends_on: vec![],
                    entity_id: Some(entity_id.to_owned()),
                    id: "resize".to_owned(),
                    interval: resize_interval,
                    kind: StudioCreationOperationKind::Resize {
                        from_dimensions: StudioAuthoringDimensions {
                            angles: None,
                            coordinate_system: None,
                            height: None,
                            radius: Some(1.0),
                            sides: None,
                            width: None,
                        },
                        from_position: PointV1 { x: 320.0, y: 180.0 },
                        from_scale: 1.0,
                        shape: StudioAuthoringEntityKind::Circle,
                        to_dimensions: StudioAuthoringDimensions {
                            angles: None,
                            coordinate_system: None,
                            height: None,
                            radius: Some(2.0),
                            sides: None,
                            width: None,
                        },
                        to_position: PointV1 { x: 360.0, y: 180.0 },
                    },
                    origin: StudioAuthoringOrigin::DirectManipulation,
                }],
                origin: StudioAuthoringOrigin::DirectManipulation,
                requested_execution: SceneEditExecution::Sequence,
                schedule_edge_count: 0,
                schedule_mode: SceneEditScheduleMode::Sequence,
                schedule_order: vec!["resize".to_owned()],
                transaction_id: "resize".to_owned(),
            },
        ],
        segmented_math_tex_outlines: vec![],
        text_outlines: vec![],
        viewport: StudioAuthoringSize {
            height: 360.0,
            width: 640.0,
        },
    }
}

fn studio_creation_duration_wait_input(
    transaction_id: &str,
    operation_id: &str,
    source_seconds: f64,
    duration: f64,
) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: source_seconds,
        anchor_resolved_seconds: source_seconds,
        anchor_source: SceneEditAnchorSource::Absolute {
            seconds: Some(source_seconds),
        },
        intent_count: 1,
        lowering_supported: true,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: None,
            id: operation_id.to_owned(),
            interval: IntervalV1 {
                end: source_seconds + duration,
                start: source_seconds,
            },
            kind: StudioCreationOperationKind::InsertWait {
                event_kind: StudioTimelineEventKind::Wait,
                purpose: Some(StudioTimelinePurpose::SceneDuration),
            },
            origin: StudioAuthoringOrigin::StudioDefault,
        }],
        origin: StudioAuthoringOrigin::StudioDefault,
        requested_execution: SceneEditExecution::Sequence,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Sequence,
        schedule_order: vec![operation_id.to_owned()],
        transaction_id: transaction_id.to_owned(),
    }
}

fn studio_creation_duration_trim_input(
    transaction_id: &str,
    operation_id: &str,
    source_seconds: f64,
    removed_duration: f64,
    target_duration: f64,
    wait_operation_ids: Vec<String>,
) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: source_seconds,
        anchor_resolved_seconds: source_seconds,
        anchor_source: SceneEditAnchorSource::Absolute {
            seconds: Some(source_seconds),
        },
        intent_count: 1,
        lowering_supported: true,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: None,
            id: operation_id.to_owned(),
            interval: IntervalV1 {
                end: source_seconds,
                start: source_seconds,
            },
            kind: StudioCreationOperationKind::TrimSceneDuration {
                removed_duration,
                target_duration,
                wait_operation_ids,
            },
            origin: StudioAuthoringOrigin::StudioDefault,
        }],
        origin: StudioAuthoringOrigin::StudioDefault,
        requested_execution: SceneEditExecution::Sequence,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Sequence,
        schedule_order: vec![operation_id.to_owned()],
        transaction_id: transaction_id.to_owned(),
    }
}

#[test]
fn normalized_creation_preserves_same_anchor_duration_and_creation_order() {
    for (wait_index, expected_insertions, expected_creation_start, expected_barriers) in [
        (
            0,
            vec![("duration-wait", 0.5, 1.0), ("create", 1.5, 0.4)],
            1.5,
            vec!["duration-wait-operation"],
        ),
        (
            1,
            vec![("create", 0.5, 0.4), ("duration-wait", 0.9, 1.0)],
            0.5,
            vec![],
        ),
    ] {
        let bundle = static_imported_bundle();
        let base_duration = bundle.scene.duration;
        let mut command = studio_creation_command(&bundle);
        command.programs.insert(
            wait_index,
            studio_creation_duration_wait_input(
                "duration-wait",
                "duration-wait-operation",
                0.5,
                1.0,
            ),
        );

        let projection = project_studio_creation_edits(base_duration, &command.programs).unwrap();
        assert_eq!(projection.insertions.len(), expected_insertions.len());
        for (actual, (transaction_id, at, duration)) in
            projection.insertions.iter().zip(expected_insertions)
        {
            assert_eq!(actual.transaction_id, transaction_id);
            assert!((actual.at - at).abs() < 1e-12);
            assert!((actual.duration - duration).abs() < 1e-12);
        }
        assert!((projection.projected_duration - (base_duration + 1.4)).abs() < 1e-12);
        assert_eq!(
            projection.duration_trim_barrier_operation_ids,
            expected_barriers
        );
        assert_eq!(projection.timeline_projection.program_projections.len(), 1);
        assert_eq!(projection.timeline_projection.transforms.len(), 1);
        assert!(
            (projection.timeline_projection.program_projections[0].working_anchor - 0.5).abs()
                < 1e-12
        );
        assert!(
            (projection.timeline_projection.projected_duration - projection.projected_duration)
                .abs()
                < 1e-12
        );
        assert!(
            (projection.entities[0].created_lifetime.start - expected_creation_start).abs() < 1e-12
        );
        let resize = projection
            .mutations
            .iter()
            .find(|mutation| {
                matches!(
                    mutation.kind,
                    StudioCreationProjectedMutationKind::Resize { .. }
                )
            })
            .unwrap();
        assert!((resize.interval.start - 2.25).abs() < 1e-12);

        let mut session = EngineSessionV1::new(bundle).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        assert_eq!(result.creation_projection.as_ref(), Some(&projection));
        assert!((result.bundle.scene.duration - projection.projected_duration).abs() < 1e-12);
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "tx:create/entity:circle")
            .unwrap();
        assert!((created.lifetimes[0].start - expected_creation_start).abs() < 1e-12);
    }
}

#[test]
fn normalized_creation_trims_only_the_trailing_duration_wait() {
    let bundle = static_imported_bundle();
    let base_duration = bundle.scene.duration;
    let mut command = studio_creation_command(&bundle);
    command.programs.insert(
        1,
        studio_creation_duration_wait_input("duration-wait", "duration-wait-operation", 0.5, 1.0),
    );
    command.programs.insert(
        2,
        studio_creation_duration_trim_input(
            "duration-trim",
            "duration-trim-operation",
            0.5,
            0.5,
            base_duration + 0.9,
            vec!["duration-wait-operation".to_owned()],
        ),
    );

    let projection = project_studio_creation_edits(base_duration, &command.programs).unwrap();
    assert_eq!(projection.insertions.len(), 2);
    assert_eq!(projection.insertions[0].transaction_id, "create");
    assert!((projection.insertions[0].at - 0.5).abs() < 1e-12);
    assert!((projection.insertions[0].duration - 0.4).abs() < 1e-12);
    assert_eq!(projection.insertions[1].transaction_id, "duration-wait");
    assert!((projection.insertions[1].at - 0.9).abs() < 1e-12);
    assert!((projection.insertions[1].duration - 0.5).abs() < 1e-12);
    assert!((projection.projected_duration - (base_duration + 0.9)).abs() < 1e-12);
    assert_eq!(projection.timeline_projection.program_projections.len(), 2);
    let [
        StudioTimelineEditTransform::Insert {
            interval: inserted, ..
        },
        StudioTimelineEditTransform::Remove {
            interval: removed,
            wait_reductions,
            ..
        },
    ] = &projection.timeline_projection.transforms[..]
    else {
        panic!("duration projection must retain one wait and its trim")
    };
    assert!((inserted.start - 0.5).abs() < 1e-12);
    assert!((inserted.end - 1.5).abs() < 1e-12);
    assert!((removed.start - 1.0).abs() < 1e-12);
    assert!((removed.end - 1.5).abs() < 1e-12);
    assert_eq!(
        wait_reductions,
        &[super::super::timeline::StudioTimelineWaitReduction {
            operation_id: "duration-wait-operation".to_owned(),
            removed_duration: 0.5,
        }]
    );
    let resize = projection
        .mutations
        .iter()
        .find(|mutation| {
            matches!(
                mutation.kind,
                StudioCreationProjectedMutationKind::Resize { .. }
            )
        })
        .unwrap();
    assert!((resize.interval.start - 1.75).abs() < 1e-12);

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    assert!((result.bundle.scene.duration - (base_duration + 0.9)).abs() < 1e-12);
}

#[test]
fn normalized_creation_accepts_a_safe_trim_authored_after_later_source_content() {
    let bundle = static_imported_bundle();
    let base_duration = bundle.scene.duration;
    let mut command = studio_creation_command(&bundle);
    command.programs.insert(
        1,
        studio_creation_duration_wait_input("duration-wait", "duration-wait-operation", 0.25, 1.0),
    );
    command.programs.insert(
        2,
        studio_creation_duration_trim_input(
            "duration-trim",
            "duration-trim-operation",
            0.25,
            0.5,
            base_duration + 0.9,
            vec!["duration-wait-operation".to_owned()],
        ),
    );

    let projection = project_studio_creation_edits(base_duration, &command.programs).unwrap();
    assert_eq!(projection.insertions.len(), 2);
    assert_eq!(projection.insertions[0].transaction_id, "duration-wait");
    assert!((projection.insertions[0].at - 0.25).abs() < 1e-12);
    assert!((projection.insertions[0].duration - 0.5).abs() < 1e-12);
    assert_eq!(projection.insertions[1].transaction_id, "create");
    assert!((projection.insertions[1].at - 1.0).abs() < 1e-12);
    assert!((projection.insertions[1].duration - 0.4).abs() < 1e-12);
    assert!((projection.projected_duration - (base_duration + 0.9)).abs() < 1e-12);
    assert!(projection.duration_trim_barrier_operation_ids.is_empty());
    assert!((projection.entities[0].created_lifetime.start - 1.0).abs() < 1e-12);

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    assert!((result.bundle.scene.duration - (base_duration + 0.9)).abs() < 1e-12);
}

#[test]
fn normalized_creation_rejects_a_trim_that_would_cross_created_content_atomically() {
    let bundle = static_imported_bundle();
    let expected_scene = bundle.scene.clone();
    let base_duration = bundle.scene.duration;
    let mut command = studio_creation_command(&bundle);
    command.programs.insert(
        0,
        studio_creation_duration_wait_input("duration-wait", "duration-wait-operation", 0.5, 1.0),
    );
    command.programs.insert(
        2,
        studio_creation_duration_trim_input(
            "duration-trim",
            "duration-trim-operation",
            0.5,
            0.5,
            base_duration + 0.9,
            vec!["duration-wait-operation".to_owned()],
        ),
    );

    assert!(matches!(
        project_studio_creation_edits(base_duration, &command.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
    let mut session = EngineSessionV1::new(bundle).unwrap();
    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &expected_scene);
    assert_eq!(session.retained_index_stats().build_count, 1);
}

fn camera_view(center_x: f64, frame_width: f64) -> SceneCameraViewV1 {
    SceneCameraViewV1 {
        center: PointV1 {
            x: center_x,
            y: 0.0,
        },
        frame_height: frame_width * 9.0 / 16.0,
        frame_width,
    }
}

fn studio_camera_program(
    transaction_id: &str,
    operation_id: &str,
    start: f64,
    end: f64,
    from_view: SceneCameraViewV1,
    to_view: SceneCameraViewV1,
) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: start,
        anchor_resolved_seconds: start,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(start),
        },
        intent_count: 1,
        lowering_supported: false,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: None,
            id: operation_id.to_owned(),
            interval: IntervalV1 { end, start },
            kind: StudioCreationOperationKind::AnimateCamera {
                easing: StudioPropertyEasing::Smooth,
                from_view,
                to_view,
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Sequence,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Sequence,
        schedule_order: vec![operation_id.to_owned()],
        transaction_id: transaction_id.to_owned(),
    }
}

fn studio_camera_command(bundle: &SceneIrBundleV1) -> ApplyStudioCreationEditCommand {
    let base = bundle.scene.camera.view.clone();
    let focused = camera_view(4.0, 8.0);
    ApplyStudioCreationEditCommand {
        expected_base_revision: bundle.scene.source.revision_hash().to_owned(),
        frame: StudioAuthoringSize {
            height: base.frame_height,
            width: base.frame_width,
        },
        math_tex_outlines: vec![],
        next_revision: NEXT_REVISION.to_owned(),
        programs: vec![
            studio_camera_program(
                "camera-focus",
                "camera-focus",
                0.25,
                0.75,
                base.clone(),
                focused.clone(),
            ),
            studio_camera_program("camera-reset", "camera-reset", 1.0, 1.5, focused, base),
        ],
        segmented_math_tex_outlines: vec![],
        text_outlines: vec![],
        viewport: StudioAuthoringSize {
            height: 360.0,
            width: 640.0,
        },
    }
}

#[test]
fn camera_focus_and_reset_share_one_held_camera_channel() {
    let bundle = static_imported_bundle();
    let original_geometry = bundle
        .scene
        .entities
        .iter()
        .map(|entity| (entity.id.clone(), entity.geometry.clone()))
        .collect::<Vec<_>>();
    let command = studio_camera_command(&bundle);
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!((projection.projected_duration - 3.0).abs() < 1e-12);
    assert_eq!(projection.insertions.len(), 2);
    assert_eq!(projection.mutations.len(), 2);
    assert!(matches!(
        &projection.mutations[0],
        StudioCreationProjectedMutation {
            entity_id,
            interval: IntervalV1 { start: 0.25, end: 0.75 },
            kind: StudioCreationProjectedMutationKind::AnimateCamera {
                easing: EasingV1::ManimSmooth {},
                from_view,
                to_view,
            },
            operation_id,
            transaction_id,
        } if entity_id.is_empty()
            && from_view == &camera_view(0.0, 16.0)
            && to_view == &camera_view(4.0, 8.0)
            && operation_id == "camera-focus"
            && transaction_id == "camera-focus"
    ));
    assert_eq!(projection.mutations[1].interval.start, 1.5);
    assert_eq!(projection.mutations[1].interval.end, 2.0);

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    assert_eq!(result.bundle.scene.camera.view, camera_view(0.0, 16.0));
    assert_eq!(
        result
            .bundle
            .scene
            .entities
            .iter()
            .map(|entity| (entity.id.clone(), entity.geometry.clone()))
            .collect::<Vec<_>>(),
        original_geometry
    );
    let camera_channels = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .filter_map(|channel| match channel {
            AnimationChannelV1::Camera { keyframes, .. } => Some(keyframes),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(camera_channels.len(), 1);
    let keyframes = camera_channels[0];
    assert_eq!(keyframes.len(), 4);
    assert_eq!(keyframes[0].value, camera_view(0.0, 16.0));
    assert_eq!(keyframes[0].at, 0.25);
    assert_eq!(keyframes[1].value, camera_view(4.0, 8.0));
    assert_eq!(keyframes[1].at, 0.75);
    assert!(matches!(
        keyframes[1].easing_to_next,
        Some(EasingV1::Linear {})
    ));
    assert_eq!(keyframes[2].value, camera_view(4.0, 8.0));
    assert_eq!(keyframes[2].at, 1.5);
    assert_eq!(keyframes[3].value, camera_view(0.0, 16.0));
    assert_eq!(keyframes[3].at, 2.0);

    let sample = |at| {
        session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "studio-camera",
                sample_time: at,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap()
            .camera
    };
    let start = sample(0.25);
    assert!((start.left + 8.0).abs() < 1e-12);
    assert!((start.right - 8.0).abs() < 1e-12);
    let focus_midpoint = sample(0.5);
    assert!((focus_midpoint.left + 4.0).abs() < 1e-12);
    assert!((focus_midpoint.right - 8.0).abs() < 1e-12);
    let focused = sample(1.0);
    assert!(focused.left.abs() < 1e-12);
    assert!((focused.right - 8.0).abs() < 1e-12);
    let reset_midpoint = sample(1.75);
    assert!((reset_midpoint.left + 4.0).abs() < 1e-12);
    assert!((reset_midpoint.right - 8.0).abs() < 1e-12);
    let reset = sample(2.0);
    assert!((reset.left + 8.0).abs() < 1e-12);
    assert!((reset.right - 8.0).abs() < 1e-12);
}

#[test]
fn camera_animation_refuses_broken_chains_aspect_zoom_and_existing_channel() {
    let bundle = static_imported_bundle();
    let command = studio_camera_command(&bundle);

    let mut broken_chain = command.clone();
    let StudioCreationOperationKind::AnimateCamera { from_view, .. } =
        &mut broken_chain.programs[1].operations[0].kind
    else {
        unreachable!();
    };
    from_view.center.x += 0.25;
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &broken_chain.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut changed_aspect = command.clone();
    let StudioCreationOperationKind::AnimateCamera { to_view, .. } =
        &mut changed_aspect.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    to_view.frame_height = 5.0;
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &changed_aspect.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    for width in [0.5, 80.0] {
        let mut invalid_zoom = command.clone();
        let StudioCreationOperationKind::AnimateCamera { to_view, .. } =
            &mut invalid_zoom.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        *to_view = camera_view(4.0, width);
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &invalid_zoom.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }

    let mut same_source_anchor = command.clone();
    let second = &mut same_source_anchor.programs[1];
    second.anchor_captured_playhead = 0.5;
    second.anchor_resolved_seconds = 0.5;
    second.anchor_source = SceneEditAnchorSource::Playhead {
        reference_seconds: Some(0.5),
    };
    second.operations[0].interval = IntervalV1 {
        start: 0.5,
        end: 1.0,
    };
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &same_source_anchor.programs)
            .expect("timeline insertion order makes same-source camera clips non-overlapping");
    assert_eq!(
        projection.mutations[0].interval,
        IntervalV1 {
            start: 0.25,
            end: 0.75
        }
    );
    assert_eq!(
        projection.mutations[1].interval,
        IntervalV1 {
            start: 1.0,
            end: 1.5
        }
    );

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let mut second_command = studio_camera_command(&result.bundle);
    second_command.next_revision =
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".to_owned();
    assert!(matches!(
        session.apply_studio_creation_edit(second_command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
}

fn studio_draw_creation_command(bundle: &SceneIrBundleV1) -> ApplyStudioCreationEditCommand {
    let mut command = studio_creation_command(bundle);
    command.programs.truncate(1);
    let program = &mut command.programs[0];
    let draw = program
        .operations
        .iter_mut()
        .find(|operation| matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. }))
        .expect("creation fixture contains one fade-in");
    draw.id = "draw".to_owned();
    draw.interval.end = 1.25;
    draw.kind = StudioCreationOperationKind::DrawIn {
        easing: StudioPropertyEasing::Smooth,
        from: Some(0.0),
        to: Some(1.0),
    };
    program.schedule_order[2] = "draw".to_owned();
    command
}

fn studio_svg_path_creation_command(
    bundle: &SceneIrBundleV1,
    draw: bool,
) -> ApplyStudioCreationEditCommand {
    let mut command = if draw {
        studio_draw_creation_command(bundle)
    } else {
        let mut command = studio_creation_command(bundle);
        command.programs.truncate(1);
        command
    };
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.kind = StudioAuthoringEntityKind::SvgPath;
    entity.dimensions = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: Some(2.0),
        radius: None,
        sides: None,
        width: Some(3.0),
    };
    entity.svg = Some(StudioCreationSvgPathSpec {
            source: if draw {
                r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><path d="M10 70 L60 10 Q90 5 110 30 C100 60 80 75 10 70 Z" fill="none" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/></svg>"##
            } else {
                r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><path d="M10 70 L60 10 Q90 5 110 30 C100 60 80 75 10 70 Z M45 45 L60 25 L75 45 Z" fill="#38bdf8" fill-rule="evenodd" stroke="#ffffff" stroke-width="3" stroke-linejoin="round"/></svg>"##
            }
            .to_owned(),
        });
    command
}

fn studio_regular_polygon_creation_command(
    bundle: &SceneIrBundleV1,
    sides: u32,
    radius: f64,
) -> ApplyStudioCreationEditCommand {
    let mut command = studio_creation_command(bundle);
    command.programs.truncate(1);
    let program = &mut command.programs[0];
    for operation in &mut program.operations {
        if operation.entity_id.as_deref() == Some("tx:create/entity:circle") {
            operation.entity_id = Some("tx:create/entity:regular-polygon".to_owned());
        }
    }
    let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
        unreachable!();
    };
    entity.id = "tx:create/entity:regular-polygon".to_owned();
    entity.kind = StudioAuthoringEntityKind::RegularPolygon;
    entity.dimensions = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: None,
        radius: Some(radius),
        sides: Some(sides),
        width: None,
    };
    command
}

fn studio_path_creation_command(
    bundle: &SceneIrBundleV1,
    slug: &str,
    kind: StudioAuthoringEntityKind,
    dimensions: StudioAuthoringDimensions,
) -> ApplyStudioCreationEditCommand {
    let mut command = studio_creation_command(bundle);
    command.programs.truncate(1);
    let program = &mut command.programs[0];
    let entity_id = format!("tx:create/entity:{slug}");
    for operation in &mut program.operations {
        if operation.entity_id.as_deref() == Some("tx:create/entity:circle") {
            operation.entity_id = Some(entity_id.clone());
        }
    }
    let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
        unreachable!();
    };
    entity.id = entity_id;
    entity.kind = kind;
    entity.dimensions = dimensions;
    command
}

fn studio_data_plot_creation_command(
    bundle: &SceneIrBundleV1,
    dimensions: StudioAuthoringDimensions,
    series: StudioDataSeries,
) -> ApplyStudioCreationEditCommand {
    let mut command = studio_path_creation_command(
        bundle,
        "data-plot",
        StudioAuthoringEntityKind::DataPlot,
        dimensions,
    );
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.data_series = Some(series);
    command
}

fn studio_data_plot_dimensions(x_maximum: f64, x_step: f64) -> StudioAuthoringDimensions {
    StudioAuthoringDimensions {
        coordinate_system: Some(StudioAuthoringCoordinateSystem {
            x: StudioAuthoringCoordinateRange {
                maximum: x_maximum,
                minimum: 0.0,
                step: x_step,
            },
            y: Some(StudioAuthoringCoordinateRange {
                maximum: 2.0,
                minimum: -1.0,
                step: 1.0,
            }),
        }),
        height: Some(3.0),
        width: Some(6.0),
        ..StudioAuthoringDimensions::default()
    }
}

fn studio_math_tex_write_creation_command(
    bundle: &SceneIrBundleV1,
) -> ApplyStudioCreationEditCommand {
    let mut command = studio_creation_command(bundle);
    command.programs.truncate(1);
    let program = &mut command.programs[0];
    let entity_id = {
        let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
            unreachable!();
        };
        entity.kind = StudioAuthoringEntityKind::MathTex;
        entity.dimensions = StudioAuthoringDimensions::default();
        entity.tex_parts = Some(vec!["E".to_owned(), "=".to_owned(), "mc^2".to_owned()]);
        entity.id.clone()
    };
    let write = program
        .operations
        .iter_mut()
        .find(|operation| matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. }))
        .expect("creation fixture contains one fade-in");
    write.id = "write".to_owned();
    write.interval.end = 1.5;
    write.kind = StudioCreationOperationKind::WriteIn {
        easing: StudioPropertyEasing::Linear,
    };
    let StudioCreationOperationKind::Position {
        position: Some(position),
    } = &mut program.operations[1].kind
    else {
        unreachable!();
    };
    position.x = 400.0;
    program.schedule_order[2] = "write".to_owned();
    let white_paint = RgbaColorV1 {
        alpha: 1.0,
        blue: 1.0,
        green: 1.0,
        red: 1.0,
    };
    let source_end_byte = u32::try_from("E = mc^2".len()).unwrap();
    command.segmented_math_tex_outlines = vec![StudioCreationSegmentedMathTexOutline {
        entity_id,
        fragments: vec![
            StudioCreationSegmentedMathTexFragment {
                fill_entity_id: "fragment-0000:fill".to_owned(),
                fill_rule: FillRuleV1::NonZero,
                id: "fragment-0000".to_owned(),
                order: 0,
                outline_entity_id: "fragment-0000:outline".to_owned(),
                paint: white_paint.clone(),
                path: mathtex_fixture_path(),
                source_correlation: StudioCreationSegmentedMathTexSourceCorrelation {
                    kind: StudioCreationSegmentedMathTexSourceCorrelationKind::ExpressionByteRange,
                    source_end_byte,
                    source_start_byte: 0,
                },
            },
            StudioCreationSegmentedMathTexFragment {
                fill_entity_id: "fragment-0001:fill".to_owned(),
                fill_rule: FillRuleV1::NonZero,
                id: "fragment-0001".to_owned(),
                order: 1,
                outline_entity_id: "fragment-0001:outline".to_owned(),
                paint: white_paint,
                path: mathtex_fixture_path(),
                source_correlation: StudioCreationSegmentedMathTexSourceCorrelation {
                    kind: StudioCreationSegmentedMathTexSourceCorrelationKind::ExpressionByteRange,
                    source_end_byte,
                    source_start_byte: 0,
                },
            },
        ],
        source: "E = mc^2".to_owned(),
        write_plan: StudioCreationSegmentedMathTexWritePlan {
            fragment_lag_ratio: 0.2,
            outline_stroke_width: 2.0,
            phase_boundary: 0.5,
            representation:
                StudioCreationSegmentedMathTexRepresentation::SeparateOutlineAndFillEntities,
        },
    }];
    command
}

fn closed_polygon_path(points: &[PointV1]) -> CubicPathV1 {
    assert!(points.len() >= 3);
    let mut segments = points
        .windows(2)
        .map(|pair| straight_cubic_segment(&pair[0], pair[1].clone()))
        .collect::<Vec<_>>();
    segments.push(straight_cubic_segment(
        points.last().unwrap(),
        points[0].clone(),
    ));
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments,
            start: points[0].clone(),
        }],
    }
}

fn studio_math_tex_transform_program(
    transaction_id: &str,
    operation_id: &str,
    root_entity_id: &str,
    source_entity_id: &str,
    target_entity_id: &str,
    replacement: StudioMathTexContent,
) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: 0.5,
        anchor_resolved_seconds: 0.5,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(0.5),
        },
        intent_count: 1,
        lowering_supported: true,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(root_entity_id.to_owned()),
            id: operation_id.to_owned(),
            interval: IntervalV1 {
                end: 1.0,
                start: 0.5,
            },
            kind: StudioCreationOperationKind::TransformContent {
                easing: StudioPropertyEasing::Smooth,
                replacement,
                source_entity_id: source_entity_id.to_owned(),
                strategy: StudioMathTexTransformStrategy::ReplacementTransform,
                target_entity_id: target_entity_id.to_owned(),
                target_type: Some("MathTex".to_owned()),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Sequence,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Sequence,
        schedule_order: vec![operation_id.to_owned()],
        transaction_id: transaction_id.to_owned(),
    }
}

fn studio_math_tex_write_transform_chain_command(
    bundle: &SceneIrBundleV1,
) -> ApplyStudioCreationEditCommand {
    let mut command = studio_math_tex_write_creation_command(bundle);
    let root_id = "tx:create/entity:circle";
    let middle_id = "tx:transform-middle/entity:formula";
    let restored_id = "tx:transform-restored/entity:formula";
    let initial_content = StudioMathTexContent {
        display_lines: vec!["E = mc^2".to_owned()],
        label: Some("energy".to_owned()),
        tex_parts: vec!["E".to_owned(), "=".to_owned(), "mc^2".to_owned()],
    };
    let middle_content = StudioMathTexContent {
        display_lines: vec!["B".to_owned()],
        label: Some("middle".to_owned()),
        tex_parts: vec!["B".to_owned()],
    };
    let restored_content = StudioMathTexContent {
        display_lines: initial_content.display_lines.clone(),
        label: Some("restored".to_owned()),
        tex_parts: initial_content.tex_parts.clone(),
    };
    let initial_path = closed_polygon_path(&[
        PointV1 { x: -1.0, y: -0.5 },
        PointV1 { x: 1.0, y: -0.5 },
        PointV1 { x: 0.0, y: 1.0 },
    ]);
    let mut middle_path = closed_polygon_path(&[
        PointV1 { x: -1.0, y: -1.0 },
        PointV1 { x: 1.0, y: -1.0 },
        PointV1 { x: 1.0, y: 1.0 },
        PointV1 { x: -1.0, y: 1.0 },
    ]);
    middle_path.subpaths.push(
        closed_polygon_path(&[
            PointV1 { x: 1.5, y: -0.25 },
            PointV1 { x: 2.0, y: -0.25 },
            PointV1 { x: 1.75, y: 0.5 },
        ])
        .subpaths
        .remove(0),
    );
    command.math_tex_outlines = vec![
        StudioCreationMathTexOutline {
            entity_id: root_id.to_owned(),
            path: initial_path.clone(),
            tex_parts: initial_content.tex_parts,
        },
        StudioCreationMathTexOutline {
            entity_id: middle_id.to_owned(),
            path: middle_path,
            tex_parts: middle_content.tex_parts.clone(),
        },
        StudioCreationMathTexOutline {
            entity_id: restored_id.to_owned(),
            path: initial_path,
            tex_parts: restored_content.tex_parts.clone(),
        },
    ];
    command.programs.push(studio_math_tex_transform_program(
        "transform-middle",
        "transform-to-middle",
        root_id,
        root_id,
        middle_id,
        middle_content,
    ));
    command.programs.push(studio_math_tex_transform_program(
        "transform-restored",
        "transform-to-restored",
        root_id,
        middle_id,
        restored_id,
        restored_content,
    ));
    command
}

fn studio_shape_transform_program(
    transaction_id: &str,
    operation_id: &str,
    root_entity_id: &str,
    from_shape: StudioAuthoringEntityKind,
    from_dimensions: StudioAuthoringDimensions,
    to_shape: StudioAuthoringEntityKind,
    to_dimensions: StudioAuthoringDimensions,
) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: 0.9,
        anchor_resolved_seconds: 0.9,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(0.9),
        },
        intent_count: 1,
        lowering_supported: false,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(root_entity_id.to_owned()),
            id: operation_id.to_owned(),
            interval: IntervalV1 {
                end: 1.4,
                start: 0.9,
            },
            kind: StudioCreationOperationKind::TransformShape {
                easing: StudioPropertyEasing::Smooth,
                from_dimensions,
                from_shape,
                to_dimensions,
                to_shape,
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Sequence,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Sequence,
        schedule_order: vec![operation_id.to_owned()],
        transaction_id: transaction_id.to_owned(),
    }
}

fn studio_shape_transform_chain_command(
    bundle: &SceneIrBundleV1,
) -> ApplyStudioCreationEditCommand {
    let mut command = studio_creation_command(bundle);
    command.programs.truncate(1);
    let root_id = "tx:create/entity:shape";
    for operation in &mut command.programs[0].operations {
        if let Some(entity_id) = &mut operation.entity_id {
            *entity_id = root_id.to_owned();
        }
        if let StudioCreationOperationKind::Create { entity } = &mut operation.kind {
            entity.id = root_id.to_owned();
            entity.kind = StudioAuthoringEntityKind::Rectangle;
            entity.dimensions = StudioAuthoringDimensions {
                angles: None,
                coordinate_system: None,
                height: Some(2.0),
                radius: None,
                sides: None,
                width: Some(4.0),
            };
        }
    }
    let rectangle = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: Some(2.0),
        radius: None,
        sides: None,
        width: Some(4.0),
    };
    let ellipse = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: Some(1.5),
        radius: None,
        sides: None,
        width: Some(3.0),
    };
    let triangle = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: None,
        radius: Some(1.25),
        sides: Some(3),
        width: None,
    };
    let polygon = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: None,
        radius: Some(1.25),
        sides: Some(6),
        width: None,
    };
    let circle = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: None,
        radius: Some(1.0),
        sides: None,
        width: None,
    };
    command.programs.push(studio_shape_transform_program(
        "shape-to-ellipse",
        "shape-to-ellipse",
        root_id,
        StudioAuthoringEntityKind::Rectangle,
        rectangle,
        StudioAuthoringEntityKind::Ellipse,
        ellipse,
    ));
    command.programs.push(studio_shape_transform_program(
        "shape-to-triangle",
        "shape-to-triangle",
        root_id,
        StudioAuthoringEntityKind::Ellipse,
        ellipse,
        StudioAuthoringEntityKind::RegularPolygon,
        triangle,
    ));
    command.programs.push(studio_shape_transform_program(
        "shape-to-polygon",
        "shape-to-polygon",
        root_id,
        StudioAuthoringEntityKind::RegularPolygon,
        triangle,
        StudioAuthoringEntityKind::RegularPolygon,
        polygon,
    ));
    command.programs.push(studio_shape_transform_program(
        "shape-to-circle",
        "shape-to-circle",
        root_id,
        StudioAuthoringEntityKind::RegularPolygon,
        polygon,
        StudioAuthoringEntityKind::Circle,
        circle,
    ));
    command.programs.push(studio_shape_transform_program(
        "shape-to-rectangle",
        "shape-to-rectangle",
        root_id,
        StudioAuthoringEntityKind::Circle,
        circle,
        StudioAuthoringEntityKind::Rectangle,
        rectangle,
    ));
    command
}

fn studio_text_creation_command(
    bundle: &SceneIrBundleV1,
    text: &str,
) -> ApplyStudioCreationEditCommand {
    let mut command = studio_creation_command(bundle);
    let entity_id = {
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.kind = StudioAuthoringEntityKind::Text;
        entity.dimensions = StudioAuthoringDimensions::default();
        entity.layout = None;
        entity.text = Some(text.to_owned());
        entity.tex_parts = None;
        entity.id.clone()
    };
    command.text_outlines = vec![StudioCreationTextOutline {
        entity_id,
        layout: StudioTextLayout::default(),
        path: mathtex_fixture_path(),
        text: text.to_owned(),
    }];
    command
}

fn studio_image_creation_command(bundle: &SceneIrBundleV1) -> ApplyStudioCreationEditCommand {
    let asset = bundle
        .assets
        .assets
        .first()
        .expect("the PNG creation fixture must expose one manifest asset");
    let mut command = studio_creation_command(bundle);
    command.programs.truncate(1);
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.dimensions = StudioAuthoringDimensions::default();
    entity.image = Some(StudioCreationImageSpec {
        asset: AssetReferenceV1 {
            asset_id: asset.id.clone(),
            sha256: asset.sha256.clone(),
        },
        local_rect: ImageLocalRectV1 {
            bottom: -1.0,
            left: -1.5,
            right: 1.5,
            top: 1.0,
        },
        sampler: ImageSamplerV1::Linear,
    });
    entity.kind = StudioAuthoringEntityKind::Image;
    command
}

fn studio_created_motion_edit_input(target_entity_ids: Vec<String>) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: 1.0,
        anchor_resolved_seconds: 1.0,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(1.0),
        },
        intent_count: 1,
        lowering_supported: true,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: None,
            id: "move-created".to_owned(),
            interval: IntervalV1 {
                end: 2.0,
                start: 1.0,
            },
            kind: StudioCreationOperationKind::CreateMotion {
                control_offset: PointV1 { x: 0.0, y: -160.0 },
                delta: PointV1 { x: 240.0, y: -80.0 },
                easing: StudioMotionEasing::Smooth,
                orient_to_path: false,
                rotation_delta_radians: None,
                target_entity_ids,
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Sequence,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Sequence,
        schedule_order: vec!["move-created".to_owned()],
        transaction_id: "move-created".to_owned(),
    }
}

fn add_creation_opacity_segment(
    program: &mut StudioCreationEditInput,
    entity_id: &str,
    start: f64,
    end: f64,
) {
    for operation in &mut program.operations {
        operation.origin = StudioAuthoringOrigin::DirectManipulation;
    }
    program.origin = StudioAuthoringOrigin::DirectManipulation;
    program.requested_execution = SceneEditExecution::Sequence;
    program.schedule_mode = SceneEditScheduleMode::Sequence;
    program.operations.push(StudioCreationOperation {
        depends_on: vec![],
        entity_id: Some(entity_id.to_owned()),
        id: "opacity-segment".to_owned(),
        interval: IntervalV1 { end, start },
        kind: StudioCreationOperationKind::OpacityKeyframes {
            easing: StudioPropertyEasing::Linear,
            from: Some(1.0),
            to: Some(0.0),
        },
        origin: StudioAuthoringOrigin::DirectManipulation,
    });
    program.schedule_order.push("opacity-segment".to_owned());
    program.schedule_edge_count = 6;
}

fn add_creation_paint_color_segment(
    program: &mut StudioCreationEditInput,
    entity_id: &str,
    property: StudioPaintColorProperty,
    from: &str,
    to: &str,
    start: f64,
    end: f64,
) {
    for operation in &mut program.operations {
        operation.origin = StudioAuthoringOrigin::DirectManipulation;
    }
    program.origin = StudioAuthoringOrigin::DirectManipulation;
    program.requested_execution = SceneEditExecution::Sequence;
    program.schedule_mode = SceneEditScheduleMode::Sequence;
    let operation_id = format!("paint-color-segment-{}", program.operations.len());
    program.operations.push(StudioCreationOperation {
        depends_on: vec![],
        entity_id: Some(entity_id.to_owned()),
        id: operation_id.clone(),
        interval: IntervalV1 { end, start },
        kind: StudioCreationOperationKind::PaintColorKeyframes {
            easing: StudioPropertyEasing::Linear,
            from: Some(from.to_owned()),
            property,
            to: Some(to.to_owned()),
        },
        origin: StudioAuthoringOrigin::DirectManipulation,
    });
    program.schedule_order.push(operation_id);
    program.schedule_edge_count = 2 * (program.operations.len() - 1);
}

fn add_creation_material_parameter_segment(
    program: &mut StudioCreationEditInput,
    entity_id: &str,
    start: f64,
    end: f64,
) {
    for operation in &mut program.operations {
        operation.origin = StudioAuthoringOrigin::DirectManipulation;
    }
    program.origin = StudioAuthoringOrigin::DirectManipulation;
    program.requested_execution = SceneEditExecution::Sequence;
    program.schedule_mode = SceneEditScheduleMode::Sequence;
    program.operations.push(StudioCreationOperation {
        depends_on: vec![],
        entity_id: Some(entity_id.to_owned()),
        id: "material-segment".to_owned(),
        interval: IntervalV1 { end, start },
        kind: StudioCreationOperationKind::MaterialParameterKeyframes {
            easing: StudioPropertyEasing::Smooth,
            from: Some(0.35),
            material: FragmentMaterialV1 {
                parameters: vec![0.35, 8.0],
                revision: 1,
                shader_id: "project-wave".to_owned(),
                texture: None,
            },
            name: "amplitude".to_owned(),
            parameter_index: 0,
            to: Some(0.85),
        },
        origin: StudioAuthoringOrigin::DirectManipulation,
    });
    program.schedule_order.push("material-segment".to_owned());
    program.schedule_edge_count = 2 * (program.operations.len() - 1);
}

fn add_creation_uniform_scale_segment(
    program: &mut StudioCreationEditInput,
    entity_id: &str,
    start: f64,
    end: f64,
    to: f64,
) {
    for operation in &mut program.operations {
        operation.origin = StudioAuthoringOrigin::DirectManipulation;
    }
    program.origin = StudioAuthoringOrigin::DirectManipulation;
    program.requested_execution = SceneEditExecution::Sequence;
    program.schedule_mode = SceneEditScheduleMode::Sequence;
    program.operations.push(StudioCreationOperation {
        depends_on: vec![],
        entity_id: Some(entity_id.to_owned()),
        id: "scale-segment".to_owned(),
        interval: IntervalV1 { end, start },
        kind: StudioCreationOperationKind::UniformScaleKeyframes {
            easing: StudioPropertyEasing::EaseInOut,
            from: Some(1.0),
            to: Some(to),
        },
        origin: StudioAuthoringOrigin::DirectManipulation,
    });
    program.schedule_order.push("scale-segment".to_owned());
    program.schedule_edge_count = 2 * (program.operations.len() - 1);
}

fn add_creation_rotation_segment(
    program: &mut StudioCreationEditInput,
    entity_id: &str,
    start: f64,
    end: f64,
    to: f64,
) {
    for operation in &mut program.operations {
        operation.origin = StudioAuthoringOrigin::DirectManipulation;
    }
    program.origin = StudioAuthoringOrigin::DirectManipulation;
    program.requested_execution = SceneEditExecution::Sequence;
    program.schedule_mode = SceneEditScheduleMode::Sequence;
    program.operations.push(StudioCreationOperation {
        depends_on: vec![],
        entity_id: Some(entity_id.to_owned()),
        id: "rotation-segment".to_owned(),
        interval: IntervalV1 { end, start },
        kind: StudioCreationOperationKind::RotationKeyframes {
            easing: StudioPropertyEasing::Linear,
            from: Some(0.0),
            to: Some(to),
        },
        origin: StudioAuthoringOrigin::DirectManipulation,
    });
    program.schedule_order.push("rotation-segment".to_owned());
    program.schedule_edge_count = 2 * (program.operations.len() - 1);
}

fn sampled_material_parameter(session: &EngineSessionV1, entity_id: &str, sample_time: f64) -> f64 {
    let packet_id = format!("material-parameter-{sample_time}");
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: &packet_id,
            sample_time,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    packet
        .draws
        .iter()
        .find_map(|draw| match draw {
            poietra_scene_ir::RenderDrawV1::Path {
                entity_id: candidate,
                fill,
                stroke,
                ..
            } if candidate == entity_id => fill
                .as_ref()
                .and_then(|fill| fill.fragment_material.as_ref())
                .or_else(|| {
                    stroke
                        .as_ref()
                        .and_then(|stroke| stroke.fragment_material.as_ref())
                }),
            _ => None,
        })
        .unwrap()
        .parameters[0]
}

fn studio_created_appearance_edit_input(
    anchor: f64,
    entity_id: &str,
    operation_id: &str,
    kind: StudioCreationOperationKind,
) -> StudioCreationEditInput {
    StudioCreationEditInput {
        anchor_captured_playhead: anchor,
        anchor_resolved_seconds: anchor,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(anchor),
        },
        intent_count: 1,
        lowering_supported: true,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.to_owned()),
            id: operation_id.to_owned(),
            interval: IntervalV1 {
                end: anchor,
                start: anchor,
            },
            kind,
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Parallel,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order: vec![operation_id.to_owned()],
        transaction_id: operation_id.to_owned(),
    }
}

fn second_group_resize_creation(first: &StudioCreationEditInput) -> StudioCreationEditInput {
    let entity_id = "tx:second/entity:rectangle";
    let mut creation = first.clone();
    creation.transaction_id = "second".to_owned();
    for operation in &mut creation.operations {
        operation.id = format!("second-{}", operation.id);
        operation.depends_on = operation
            .depends_on
            .iter()
            .map(|dependency| format!("second-{dependency}"))
            .collect();
        if operation.entity_id.is_some() {
            operation.entity_id = Some(entity_id.to_owned());
        }
        match &mut operation.kind {
            StudioCreationOperationKind::Create { entity } => {
                entity.id = entity_id.to_owned();
                entity.kind = StudioAuthoringEntityKind::Rectangle;
                entity.dimensions = StudioAuthoringDimensions {
                    angles: None,
                    coordinate_system: None,
                    height: Some(1.0),
                    radius: None,
                    sides: None,
                    width: Some(2.0),
                };
            }
            StudioCreationOperationKind::Position { position } => {
                *position = Some(PointV1 { x: 480.0, y: 180.0 });
            }
            StudioCreationOperationKind::FadeIn { .. } => {}
            _ => unreachable!(),
        }
    }
    creation.schedule_order = creation
        .operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect();
    creation
}

fn studio_hierarchy_edit_input(
    transaction_id: &str,
    at: f64,
    kind: StudioCreationOperationKind,
) -> StudioCreationEditInput {
    let operation_id = format!("{transaction_id}-hierarchy");
    StudioCreationEditInput {
        anchor_captured_playhead: at,
        anchor_resolved_seconds: at,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(at),
        },
        intent_count: 1,
        lowering_supported: false,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: None,
            id: operation_id.clone(),
            interval: IntervalV1 { end: at, start: at },
            kind,
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Parallel,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order: vec![operation_id],
        transaction_id: transaction_id.to_owned(),
    }
}

fn bundle_contains_entity(bundle: &SceneIrBundleV1, entity_id: &str) -> bool {
    bundle
        .scene
        .entities
        .iter()
        .any(|entity| entity.id == entity_id)
}

fn studio_group_resize_edit_input(targets: &[(&str, PointV1)]) -> StudioCreationEditInput {
    let transform_at = 0.95;
    let mut operations = Vec::new();
    for (index, (entity_id, position)) in targets.iter().enumerate() {
        operations.push(StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some((*entity_id).to_owned()),
            id: format!("group-position-{index}"),
            interval: IntervalV1 {
                end: transform_at,
                start: transform_at,
            },
            kind: StudioCreationOperationKind::Position {
                position: Some(position.clone()),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        });
    }
    for (index, (entity_id, _)) in targets.iter().enumerate() {
        operations.push(StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some((*entity_id).to_owned()),
            id: format!("group-scale-{index}"),
            interval: IntervalV1 {
                end: transform_at,
                start: transform_at,
            },
            kind: StudioCreationOperationKind::UniformScale {
                control_present: false,
                from: Some(1.0),
                relative_factor: Some(1.5),
                to: Some(1.5),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        });
    }
    let schedule_order = operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect();
    StudioCreationEditInput {
        anchor_captured_playhead: transform_at,
        anchor_resolved_seconds: transform_at,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(transform_at),
        },
        intent_count: 1,
        lowering_supported: true,
        operations,
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Parallel,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order,
        transaction_id: "group-resize".to_owned(),
    }
}

fn studio_group_rotation_edit_input(
    targets: &[(&str, PointV1)],
    angle_radians: f64,
) -> StudioCreationEditInput {
    let transform_at = 0.95;
    let mut operations = Vec::new();
    for (index, (entity_id, position)) in targets.iter().enumerate() {
        operations.push(StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some((*entity_id).to_owned()),
            id: format!("group-position-{index}"),
            interval: IntervalV1 {
                end: transform_at,
                start: transform_at,
            },
            kind: StudioCreationOperationKind::Position {
                position: Some(position.clone()),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        });
    }
    for (index, (entity_id, _)) in targets.iter().enumerate() {
        operations.push(StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some((*entity_id).to_owned()),
            id: format!("group-rotation-{index}"),
            interval: IntervalV1 {
                end: transform_at,
                start: transform_at,
            },
            kind: StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(angle_radians),
                to: Some(angle_radians),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        });
    }
    let schedule_order = operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect();
    StudioCreationEditInput {
        anchor_captured_playhead: transform_at,
        anchor_resolved_seconds: transform_at,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(transform_at),
        },
        intent_count: 1,
        lowering_supported: true,
        operations,
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Parallel,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order,
        transaction_id: "group-rotation".to_owned(),
    }
}

fn assert_group_resize_transform(
    channels: &[AnimationChannelV1],
    entity_id: &str,
    expected: &PointV1,
) {
    let transform = channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::AffineTransform {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => keyframes.first().map(|keyframe| &keyframe.value),
            _ => None,
        })
        .unwrap();
    assert!((transform.m11 - 1.5).abs() < 1e-12);
    assert!((transform.m22 - 1.5).abs() < 1e-12);
    assert!((transform.tx - expected.x).abs() < 1e-12);
    assert!((transform.ty - expected.y).abs() < 1e-12);
}

fn assert_group_rotation_transform(
    channels: &[AnimationChannelV1],
    entity_id: &str,
    expected: &PointV1,
) {
    let transform = channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::AffineTransform {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => keyframes.first().map(|keyframe| &keyframe.value),
            _ => None,
        })
        .unwrap();
    assert!(transform.m11.abs() < 1e-12);
    assert!((transform.m12 + 1.0).abs() < 1e-12);
    assert!((transform.m21 - 1.0).abs() < 1e-12);
    assert!(transform.m22.abs() < 1e-12);
    assert!((transform.tx - expected.x).abs() < 1e-12);
    assert!((transform.ty - expected.y).abs() < 1e-12);
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one visible composition test pins ordered projection and the installed static Scene state"
)]
fn normalized_creation_composes_static_rotation_and_opacity() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    command.programs.extend([
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "rotate-first",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(std::f64::consts::FRAC_PI_2),
                to: Some(std::f64::consts::FRAC_PI_2),
            },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "opacity",
            StudioCreationOperationKind::Opacity { alpha: Some(0.25) },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "rotate-second",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(std::f64::consts::FRAC_PI_4),
                to: Some(std::f64::consts::FRAC_PI_4),
            },
        ),
    ]);
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();

    assert!(matches!(
        &projection.mutations[2].kind,
        StudioCreationProjectedMutationKind::Rotation { from, to }
            if from.abs() < 1e-12 && (*to - std::f64::consts::FRAC_PI_2).abs() < 1e-12
    ));
    assert!(matches!(
        &projection.mutations[3].kind,
        StudioCreationProjectedMutationKind::Opacity { value }
            if (*value - 0.25).abs() < 1e-12
    ));
    assert!(matches!(
        &projection.mutations[4].kind,
        StudioCreationProjectedMutationKind::Rotation { from, to }
            if (*from - std::f64::consts::FRAC_PI_2).abs() < 1e-12
                && (*to - 3.0 * std::f64::consts::FRAC_PI_4).abs() < 1e-12
    ));
    assert!(
        projection.mutations[2..]
            .iter()
            .all(|mutation| (mutation.interval.start - 0.9).abs() < 1e-12)
    );

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!((created.transform.m11 - 1.0).abs() < 1e-12);
    assert!(created.transform.m12.abs() < 1e-12);
    assert!(created.transform.m21.abs() < 1e-12);
    assert!((created.transform.m22 - 1.0).abs() < 1e-12);
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector { fill: None, stroke: Some(stroke), .. }
            if (stroke.color.alpha - 1.0).abs() < 1e-12
    ));
    let sample = |at| {
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "created-appearance-sample",
                sample_time: at,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let poietra_scene_ir::RenderDrawV1::Path {
            stroke: Some(stroke),
            transform,
            ..
        } = packet
            .draws
            .iter()
            .find(|draw| draw.entity_id() == entity_id)
            .unwrap()
        else {
            panic!("created circle must remain a stroked path");
        };
        (transform.clone(), stroke.color.alpha)
    };
    let (before_transform, before_alpha) = sample(0.899_999);
    assert!((before_transform.m11 - 1.0).abs() < 1e-12);
    assert!(before_transform.m12.abs() < 1e-12);
    assert!((before_alpha - 1.0).abs() < 1e-12);

    let (after_transform, after_alpha) = sample(0.9);
    let expected_cosine = (3.0 * std::f64::consts::FRAC_PI_4).cos();
    let expected_sine = (3.0 * std::f64::consts::FRAC_PI_4).sin();
    assert!((after_transform.m11 - expected_cosine).abs() < 1e-12);
    assert!((after_transform.m12 + expected_sine).abs() < 1e-12);
    assert!((after_transform.m21 - expected_sine).abs() < 1e-12);
    assert!((after_transform.m22 - expected_cosine).abs() < 1e-12);
    assert!((after_alpha - 0.25).abs() < 1e-12);

    let identity_bundle = static_imported_bundle();
    let mut identity_command = studio_creation_command(&identity_bundle);
    identity_command.programs.truncate(1);
    identity_command.programs.extend([
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "rotate-away",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(0.5),
                to: Some(0.5),
            },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "rotate-home",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(-0.5),
                to: Some(-0.5),
            },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "opacity-away",
            StudioCreationOperationKind::Opacity { alpha: Some(0.25) },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "opacity-home",
            StudioCreationOperationKind::Opacity { alpha: Some(1.0) },
        ),
    ]);
    let mut identity_session = EngineSessionV1::new(identity_bundle).unwrap();
    let identity_result = identity_session
        .apply_studio_creation_edit(identity_command)
        .unwrap();
    assert!(
        !identity_result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(channel,
                    AnimationChannelV1::AffineTransform { entity_id: animated, .. }
                    | AnimationChannelV1::VectorAppearance { entity_id: animated, .. }
                    if animated == entity_id
                )
            })
    );
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one temporal sample test pins the complete fill/stroke/opacity composition"
)]
fn normalized_creation_applies_shape_colors_only_from_the_appearance_anchor() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    command.programs.extend([
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "opacity-before-colors",
            StudioCreationOperationKind::Opacity { alpha: Some(0.25) },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "fill-color",
            StudioCreationOperationKind::FillColor {
                color: Some("#e07a5f".to_owned()),
            },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "stroke-color",
            StudioCreationOperationKind::StrokeColor {
                color: Some("#81b29a".to_owned()),
            },
        ),
    ]);
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!(matches!(
        &projection.mutations[2].kind,
        StudioCreationProjectedMutationKind::Opacity { value }
            if (*value - 0.25).abs() < 1e-12
    ));
    assert!(matches!(
        &projection.mutations[3].kind,
        StudioCreationProjectedMutationKind::FillColor { value } if value == "#e07a5f"
    ));
    assert!(matches!(
        &projection.mutations[4].kind,
        StudioCreationProjectedMutationKind::StrokeColor { value } if value == "#81b29a"
    ));
    assert!(
        projection.mutations[2..]
            .iter()
            .all(|mutation| (mutation.interval.start - 0.9).abs() < 1e-12)
    );

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector { fill: Some(fill), stroke: Some(stroke), .. }
            if fill.color.alpha.abs() < 1e-12
                && (stroke.color.red - 1.0).abs() < 1e-12
                && (stroke.color.green - 1.0).abs() < 1e-12
                && (stroke.color.blue - 1.0).abs() < 1e-12
                && (stroke.color.alpha - 1.0).abs() < 1e-12
    ));
    let sample = |at| {
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "created-color-sample",
                sample_time: at,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let poietra_scene_ir::RenderDrawV1::Path { fill, stroke, .. } = packet
            .draws
            .iter()
            .find(|draw| draw.entity_id() == entity_id)
            .unwrap()
        else {
            panic!("created circle must evaluate to one vector path");
        };
        (fill.clone(), stroke.clone().unwrap().color)
    };
    let (before_fill, before_stroke) = sample(0.899_999);
    assert!(before_fill.is_some_and(|fill| fill.color.alpha.abs() < 1e-12));
    assert!((before_stroke.red - 1.0).abs() < 1e-12);
    assert!((before_stroke.green - 1.0).abs() < 1e-12);
    assert!((before_stroke.blue - 1.0).abs() < 1e-12);
    assert!((before_stroke.alpha - 1.0).abs() < 1e-12);

    let (after_fill, after_stroke) = sample(0.9);
    let after_fill = after_fill.expect("fill color edit must enable the shape fill");
    assert!((after_fill.color.red - 224.0 / 255.0).abs() < 1e-12);
    assert!((after_fill.color.green - 122.0 / 255.0).abs() < 1e-12);
    assert!((after_fill.color.blue - 95.0 / 255.0).abs() < 1e-12);
    assert!((after_fill.color.alpha - 0.25).abs() < 1e-12);
    assert!((after_stroke.red - 129.0 / 255.0).abs() < 1e-12);
    assert!((after_stroke.green - 178.0 / 255.0).abs() < 1e-12);
    assert!((after_stroke.blue - 154.0 / 255.0).abs() < 1e-12);
    assert!((after_stroke.alpha - 0.25).abs() < 1e-12);
}

#[test]
fn normalized_creation_applies_persistent_canonical_paint_order() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        entity_id,
        "layer-order",
        StudioCreationOperationKind::SourceZIndex {
            document_static: false,
            from_source_z_index: None,
            source_z_index: Some(-10.0),
        },
    ));
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!(matches!(
        &projection.mutations[2].kind,
        StudioCreationProjectedMutationKind::SourceZIndex { source_z_index }
            if (*source_z_index + 10.0).abs() < 1e-12
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!((created.source_z_index + 10.0).abs() < f64::EPSILON);
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "created-order-sample",
            sample_time: 1.0,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert_eq!(
        packet
            .draws
            .first()
            .map(poietra_scene_ir::RenderDrawV1::entity_id),
        Some(entity_id)
    );
}

#[test]
#[allow(
    clippy::cast_precision_loss,
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one end-to-end logical-group paint-order regression scenario"
)]
fn normalized_creation_applies_late_group_paint_order_atomically() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command
        .programs
        .push(second_group_resize_creation(&command.programs[0]));
    let first_created_z = bundle
        .scene
        .entities
        .iter()
        .map(|entity| entity.source_z_index)
        .fold(-1.0_f64, f64::max)
        + 1.0;
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:circle",
        "prior-child-layer-order",
        StudioCreationOperationKind::SourceZIndex {
            document_static: false,
            from_source_z_index: None,
            source_z_index: Some(first_created_z),
        },
    ));
    let child_ids = vec![
        "tx:second/entity:rectangle".to_owned(),
        "tx:create/entity:circle".to_owned(),
    ];
    let group_id = "tx:ordered-group/entity:group".to_owned();
    command.programs.push(studio_hierarchy_edit_input(
        "ordered-group",
        1.0,
        StudioCreationOperationKind::Group {
            child_entity_ids: child_ids.clone(),
            group_id: group_id.clone(),
        },
    ));
    let command_without_order = command.clone();
    let operations = child_ids
        .iter()
        .rev()
        .enumerate()
        .map(|(index, entity_id)| StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.clone()),
            id: format!("order-group-child-{index}"),
            interval: IntervalV1 {
                end: 1.1,
                start: 1.1,
            },
            kind: StudioCreationOperationKind::SourceZIndex {
                document_static: true,
                from_source_z_index: Some(first_created_z + index as f64),
                source_z_index: Some(10.0 + index as f64),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        })
        .collect::<Vec<_>>();
    command.programs.push(StudioCreationEditInput {
        anchor_captured_playhead: 1.1,
        anchor_resolved_seconds: 1.1,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(1.1),
        },
        intent_count: 1,
        lowering_supported: false,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order: operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect(),
        operations,
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Parallel,
        transaction_id: "order-active-group".to_owned(),
    });

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    let group_order_mutations = projection
        .mutations
        .iter()
        .filter(|mutation| {
            matches!(
                mutation.kind,
                StudioCreationProjectedMutationKind::SourceZIndex { .. }
            ) && mutation.transaction_id == "order-active-group"
        })
        .collect::<Vec<_>>();
    assert_eq!(group_order_mutations.len(), 2);
    assert!(group_order_mutations.iter().all(|mutation| {
        projection.entities.iter().any(|entity| {
            entity.entity_id == mutation.entity_id
                && studio_timeline_semantic_values_match(
                    mutation.interval.start,
                    entity.created_lifetime.start,
                )
                && studio_timeline_semantic_values_match(
                    mutation.interval.end,
                    entity.created_lifetime.start,
                )
        })
    }));
    let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
    let result = session.apply_studio_creation_edit(command.clone()).unwrap();
    for child_id in &child_ids {
        let child = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == *child_id)
            .unwrap();
        let expected_z = if child_id == "tx:create/entity:circle" {
            10.0
        } else {
            11.0
        };
        assert_eq!(child.source_z_index, expected_z);
        assert_eq!(child.parent_id.as_deref(), Some(group_id.as_str()));
    }
    let undone = EngineSessionV1::new(bundle.clone())
        .unwrap()
        .apply_studio_creation_edit(command_without_order)
        .unwrap();
    for (index, child_id) in ["tx:create/entity:circle", "tx:second/entity:rectangle"]
        .iter()
        .enumerate()
    {
        assert_eq!(
            undone
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == *child_id)
                .unwrap()
                .source_z_index,
            first_created_z + index as f64
        );
    }
    let redone = EngineSessionV1::new(bundle.clone())
        .unwrap()
        .apply_studio_creation_edit(command.clone())
        .unwrap();
    assert_eq!(redone.bundle, result.bundle);
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "group-order-before-authoring-anchor",
            sample_time: 1.0,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert_eq!(
        packet
            .draws
            .iter()
            .map(poietra_scene_ir::RenderDrawV1::entity_id)
            .filter(|entity_id| child_ids.iter().any(|child_id| child_id == entity_id))
            .collect::<Vec<_>>(),
        vec!["tx:create/entity:circle", "tx:second/entity:rectangle"]
    );

    let mut wrong_from = command.clone();
    for operation in &mut wrong_from.programs.last_mut().unwrap().operations {
        let StudioCreationOperationKind::SourceZIndex {
            from_source_z_index,
            ..
        } = &mut operation.kind
        else {
            unreachable!();
        };
        *from_source_z_index = from_source_z_index.map(|value| value + 1.0);
    }
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &wrong_from.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut wrong_default = command.clone();
    let default_operation = wrong_default
        .programs
        .last_mut()
        .unwrap()
        .operations
        .iter_mut()
        .find(|operation| operation.entity_id.as_deref() == Some("tx:second/entity:rectangle"))
        .unwrap();
    let StudioCreationOperationKind::SourceZIndex {
        from_source_z_index,
        source_z_index,
        ..
    } = &mut default_operation.kind
    else {
        unreachable!();
    };
    *from_source_z_index = from_source_z_index.map(|value| value + 1.0);
    *source_z_index = source_z_index.map(|value| value + 1.0);
    assert!(project_studio_creation_edits(bundle.scene.duration, &wrong_default.programs).is_ok());
    assert!(matches!(
        EngineSessionV1::new(bundle.clone())
            .unwrap()
            .apply_studio_creation_edit(wrong_default),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));

    let mut wrong_contract = command.clone();
    let StudioCreationOperationKind::SourceZIndex {
        document_static, ..
    } = &mut wrong_contract.programs.last_mut().unwrap().operations[0].kind
    else {
        unreachable!();
    };
    *document_static = false;
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &wrong_contract.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut non_uniform = command.clone();
    let StudioCreationOperationKind::SourceZIndex { source_z_index, .. } =
        &mut non_uniform.programs.last_mut().unwrap().operations[0].kind
    else {
        unreachable!();
    };
    *source_z_index = source_z_index.map(|value| value + 0.25);
    assert!(project_studio_creation_edits(bundle.scene.duration, &non_uniform.programs).is_ok());
    assert!(
        EngineSessionV1::new(bundle.clone())
            .unwrap()
            .apply_studio_creation_edit(non_uniform)
            .is_ok()
    );

    let mut reversed = command.clone();
    let StudioCreationOperationKind::SourceZIndex { source_z_index, .. } =
        &mut reversed.programs.last_mut().unwrap().operations[0].kind
    else {
        unreachable!();
    };
    *source_z_index = source_z_index.map(|value| value + 2.0);
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &reversed.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut split = command.clone();
    for (index, operation) in split
        .programs
        .last_mut()
        .unwrap()
        .operations
        .iter_mut()
        .enumerate()
    {
        let StudioCreationOperationKind::SourceZIndex { source_z_index, .. } = &mut operation.kind
        else {
            unreachable!();
        };
        *source_z_index = Some(if index == 0 { -100.0 } else { 100.0 });
    }
    assert!(project_studio_creation_edits(bundle.scene.duration, &split.programs).is_ok());
    assert!(matches!(
        EngineSessionV1::new(bundle.clone())
            .unwrap()
            .apply_studio_creation_edit(split),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));

    command.programs.last_mut().unwrap().operations.pop();
    command.programs.last_mut().unwrap().schedule_order.pop();
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &command.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
}

#[test]
fn normalized_creation_applies_static_visibility_without_changing_lifetime_or_opacity() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        entity_id,
        "hide-layer",
        StudioCreationOperationKind::Visibility {
            visible: Some(false),
        },
    ));

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!(matches!(
        &projection.mutations[2].kind,
        StudioCreationProjectedMutationKind::Visibility { visible: false }
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!(!created.visible);
    assert_eq!(
        created.lifetimes,
        vec![IntervalV1 {
            end: result.bundle.scene.duration,
            start: 0.5
        }]
    );
    assert!(matches!(
        created.appearance,
        SceneAppearanceV1::Vector { opacity, .. } if (opacity - 1.0).abs() < f64::EPSILON
    ));
}

#[test]
fn normalized_creation_rejects_invalid_shape_color_edits() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut uppercase = studio_creation_command(&bundle);
    uppercase.programs.truncate(1);
    uppercase
        .programs
        .push(studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "uppercase-color",
            StudioCreationOperationKind::FillColor {
                color: Some("#E07A5F".to_owned()),
            },
        ));
    let mut missing_color = studio_creation_command(&bundle);
    missing_color.programs.truncate(1);
    missing_color
        .programs
        .push(studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "missing-color",
            StudioCreationOperationKind::FillColor { color: None },
        ));
    let mut wrong_anchor = studio_creation_command(&bundle);
    wrong_anchor.programs.truncate(1);
    wrong_anchor
        .programs
        .push(studio_created_appearance_edit_input(
            1.0,
            entity_id,
            "wrong-color-anchor",
            StudioCreationOperationKind::StrokeColor {
                color: Some("#81b29a".to_owned()),
            },
        ));

    for command in [uppercase, missing_color, wrong_anchor] {
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &command.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }
}

#[test]
#[allow(
    clippy::float_cmp,
    reason = "the normalized static transform batch stores exact authored values"
)]
fn normalized_creation_composes_single_resize_rotation_and_scale_at_one_anchor() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.push(studio_created_appearance_edit_input(
        0.85,
        entity_id,
        "rotation-after-resize",
        StudioCreationOperationKind::Rotation {
            control_present: false,
            from: Some(0.0),
            relative_delta: Some(std::f64::consts::FRAC_PI_2),
            to: Some(std::f64::consts::FRAC_PI_2),
        },
    ));
    command.programs.push(studio_created_appearance_edit_input(
        0.85,
        entity_id,
        "scale-after-rotation",
        StudioCreationOperationKind::UniformScale {
            control_present: false,
            from: Some(1.0),
            relative_factor: Some(1.5),
            to: Some(1.5),
        },
    ));
    command.programs.push(studio_created_appearance_edit_input(
        0.85,
        entity_id,
        "second-rotation",
        StudioCreationOperationKind::Rotation {
            control_present: false,
            from: Some(0.0),
            relative_delta: Some(std::f64::consts::FRAC_PI_2),
            to: Some(std::f64::consts::FRAC_PI_2),
        },
    ));

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!(matches!(
        projection.mutations.last().map(|mutation| &mutation.kind),
        Some(StudioCreationProjectedMutationKind::Rotation { from, to })
            if (*from - std::f64::consts::FRAC_PI_2).abs() < 1e-12
                && (*to - std::f64::consts::PI).abs() < 1e-12
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let transform = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::AffineTransform {
                entity_id: target,
                keyframes,
                ..
            } if target == entity_id => keyframes.first().map(|keyframe| &keyframe.value),
            _ => None,
        })
        .unwrap();
    assert!((transform.m11 + 3.0).abs() < 1e-12);
    assert!(transform.m12.abs() < 1e-12);
    assert!(transform.m21.abs() < 1e-12);
    assert!((transform.m22 + 3.0).abs() < 1e-12);
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[test]
fn normalized_creation_rejects_shape_resize_after_static_rotation_atomically() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:second/entity:rectangle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    command
        .programs
        .push(second_group_resize_creation(&command.programs[0]));
    command.programs.push(studio_created_appearance_edit_input(
        0.95,
        entity_id,
        "resize-before-rotation",
        StudioCreationOperationKind::Resize {
            from_dimensions: StudioAuthoringDimensions {
                angles: None,
                coordinate_system: None,
                height: Some(1.0),
                radius: None,
                sides: None,
                width: Some(2.0),
            },
            from_position: PointV1 { x: 480.0, y: 180.0 },
            from_scale: 1.0,
            shape: StudioAuthoringEntityKind::Rectangle,
            to_dimensions: StudioAuthoringDimensions {
                angles: None,
                coordinate_system: None,
                height: Some(1.5),
                radius: None,
                sides: None,
                width: Some(3.0),
            },
            to_position: PointV1 { x: 460.0, y: 180.0 },
        },
    ));
    command.programs.push(studio_created_appearance_edit_input(
        0.95,
        entity_id,
        "rotate-rectangle",
        StudioCreationOperationKind::Rotation {
            control_present: false,
            from: Some(0.0),
            relative_delta: Some(std::f64::consts::FRAC_PI_2),
            to: Some(std::f64::consts::FRAC_PI_2),
        },
    ));
    command.programs.push(studio_created_appearance_edit_input(
        0.95,
        entity_id,
        "resize-after-rotation",
        StudioCreationOperationKind::Resize {
            from_dimensions: StudioAuthoringDimensions {
                angles: None,
                coordinate_system: None,
                height: Some(1.5),
                radius: None,
                sides: None,
                width: Some(3.0),
            },
            from_position: PointV1 { x: 460.0, y: 180.0 },
            from_scale: 1.0,
            shape: StudioAuthoringEntityKind::Rectangle,
            to_dimensions: StudioAuthoringDimensions {
                angles: None,
                coordinate_system: None,
                height: Some(1.0),
                radius: None,
                sides: None,
                width: Some(4.0),
            },
            to_position: PointV1 { x: 440.0, y: 180.0 },
        },
    ));
    let expected_scene = bundle.scene.clone();
    let expected_assets = bundle.assets.clone();
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &expected_scene);
    assert_eq!(session.assets(), &expected_assets);
    assert_eq!(session.retained_index_stats().build_count, 1);
}

#[test]
#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one end-to-end test pins the complete static-transform-to-motion handoff"
)]
fn normalized_creation_moves_after_one_static_transform_anchor() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.insert(
        1,
        studio_created_appearance_edit_input(
            1.0,
            entity_id,
            "position-before-motion",
            StudioCreationOperationKind::Position {
                position: Some(PointV1 { x: 340.0, y: 180.0 }),
            },
        ),
    );
    let StudioCreationOperationKind::Resize { from_position, .. } =
        &mut command.programs[2].operations[0].kind
    else {
        panic!("the creation fixture must retain its shape resize");
    };
    *from_position = PointV1 { x: 340.0, y: 180.0 };
    command.programs[2].anchor_captured_playhead = 1.0;
    command.programs[2].anchor_resolved_seconds = 1.0;
    command.programs[2].anchor_source = SceneEditAnchorSource::Playhead {
        reference_seconds: Some(1.0),
    };
    command.programs[2].operations[0].interval = IntervalV1 {
        end: 1.0,
        start: 1.0,
    };
    command.programs.push(studio_created_appearance_edit_input(
        1.0,
        entity_id,
        "rotation-before-motion",
        StudioCreationOperationKind::Rotation {
            control_present: false,
            from: Some(0.0),
            relative_delta: Some(std::f64::consts::FRAC_PI_2),
            to: Some(std::f64::consts::FRAC_PI_2),
        },
    ));
    command.programs.push(studio_created_appearance_edit_input(
        1.0,
        entity_id,
        "scale-before-motion",
        StudioCreationOperationKind::UniformScale {
            control_present: false,
            from: Some(1.0),
            relative_factor: Some(1.5),
            to: Some(1.5),
        },
    ));
    command
        .programs
        .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(projection.motions.len(), 1);
    assert_eq!(projection.motions[0].from, PointV1 { x: 360.0, y: 180.0 });

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let motion_path = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::MotionPath {
                entity_id: target,
                path,
                ..
            } if target == entity_id => Some(path),
            _ => None,
        })
        .unwrap();
    assert_eq!(motion_path.subpaths[0].start, PointV1 { x: 1.0, y: 0.0 });
    assert_eq!(
        motion_path.subpaths[0].segments[0].end,
        PointV1 { x: 7.0, y: 2.0 }
    );

    let motion_interval = &projection.motions[0].interval;
    for (time, expected_position) in [
        (motion_interval.start, PointV1 { x: 1.0, y: 0.0 }),
        (
            f64::midpoint(motion_interval.start, motion_interval.end),
            PointV1 { x: 4.0, y: 3.0 },
        ),
        (motion_interval.end, PointV1 { x: 7.0, y: 2.0 }),
    ] {
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "static-transform-motion-sample",
                sample_time: time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let poietra_scene_ir::RenderDrawV1::Path { transform, .. } = packet
            .draws
            .iter()
            .find(|draw| draw.entity_id() == entity_id)
            .unwrap()
        else {
            panic!("created motion target must remain a path draw");
        };
        assert!(transform.m11.abs() < 1e-12, "time={time}");
        assert!((transform.m12 + 3.0).abs() < 1e-12, "time={time}");
        assert!((transform.m21 - 3.0).abs() < 1e-12, "time={time}");
        assert!(transform.m22.abs() < 1e-12, "time={time}");
        assert!(
            (transform.tx - expected_position.x).abs() < 1e-12,
            "time={time}"
        );
        assert!(
            (transform.ty - expected_position.y).abs() < 1e-12,
            "time={time}"
        );
    }
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "one end-to-end assertion pins both canonical channels and their composed samples"
)]
fn assert_normalized_creation_motion_spin(motion_program_first: bool) {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let mut motion = studio_created_motion_edit_input(vec![entity_id.to_owned()]);
    let StudioCreationOperationKind::CreateMotion {
        easing,
        rotation_delta_radians,
        ..
    } = &mut motion.operations[0].kind
    else {
        unreachable!();
    };
    *easing = StudioMotionEasing::Linear;
    *rotation_delta_radians = Some(2.0 * PI);
    if motion_program_first {
        command.programs.insert(0, motion);
    } else {
        command.programs.push(motion);
    }

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!(matches!(
        projection.mutations.last().map(|mutation| &mutation.kind),
        Some(StudioCreationProjectedMutationKind::RotationKeyframes {
            easing: EasingV1::Linear {},
            from: 0.0,
            to,
        }) if (*to - 2.0 * PI).abs() < 1e-12
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let (motion_keyframes, rotation_keyframes) =
        result.bundle.scene.animation_channels.iter().fold(
            (None, None),
            |(motion, rotation), channel| match channel {
                AnimationChannelV1::MotionPath {
                    entity_id: target,
                    keyframes,
                    ..
                } if target == entity_id => (Some(keyframes), rotation),
                AnimationChannelV1::Rotation {
                    entity_id: target,
                    keyframes,
                    ..
                } if target == entity_id => (motion, Some(keyframes)),
                _ => (motion, rotation),
            },
        );
    let motion_keyframes = motion_keyframes.unwrap();
    let rotation_keyframes = rotation_keyframes.unwrap();
    assert_eq!(motion_keyframes.len(), 2);
    assert_eq!(rotation_keyframes.len(), 2);
    assert_eq!(motion_keyframes[0].at, rotation_keyframes[0].at);
    assert_eq!(motion_keyframes[1].at, rotation_keyframes[1].at);
    assert_eq!(rotation_keyframes[0].value, 0.0);
    assert!((rotation_keyframes[1].value - 2.0 * PI).abs() < 1e-12);

    let start = motion_keyframes[0].at;
    let duration = motion_keyframes[1].at - start;
    for progress in [0.25, 0.5, 1.0] {
        let time = start + duration * progress;
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "motion-spin-sample",
                sample_time: time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let poietra_scene_ir::RenderDrawV1::Path { transform, .. } = packet
            .draws
            .iter()
            .find(|draw| draw.entity_id() == entity_id)
            .unwrap()
        else {
            panic!("the spinning motion target must remain a path draw");
        };
        let angle = 2.0 * PI * progress;
        assert!(
            (transform.m11 - angle.cos()).abs() < 1e-12,
            "progress={progress}"
        );
        assert!(
            (transform.m12 + angle.sin()).abs() < 1e-12,
            "progress={progress}"
        );
        assert!(
            (transform.m21 - angle.sin()).abs() < 1e-12,
            "progress={progress}"
        );
        assert!(
            (transform.m22 - angle.cos()).abs() < 1e-12,
            "progress={progress}"
        );
        assert!(
            (transform.tx - 6.0 * progress).abs() < 1e-12,
            "progress={progress}"
        );
        assert!(
            (transform.ty - (2.0 * progress + 8.0 * progress * (1.0 - progress))).abs() < 1e-12,
            "progress={progress}"
        );
    }
}

#[test]
fn normalized_creation_composes_motion_and_spin_after_creation() {
    assert_normalized_creation_motion_spin(false);
}

#[test]
fn normalized_creation_composes_motion_and_spin_before_creation_in_input() {
    assert_normalized_creation_motion_spin(true);
}

#[test]
fn normalized_creation_rejects_zero_or_multi_target_motion_spin_atomically() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    for (rotation_delta_radians, target_entity_ids, retain_static_transform) in [
        (Some(0.0), vec![entity_id.to_owned()], false),
        (Some(-0.0), vec![entity_id.to_owned()], false),
        (
            Some(2.0 * PI),
            vec![entity_id.to_owned(), entity_id.to_owned()],
            false,
        ),
        (Some(2.0 * PI), vec![entity_id.to_owned()], true),
    ] {
        let mut command = studio_creation_command(&bundle);
        if !retain_static_transform {
            command.programs.truncate(1);
        }
        let mut motion = studio_created_motion_edit_input(target_entity_ids);
        let StudioCreationOperationKind::CreateMotion {
            rotation_delta_radians: candidate,
            ..
        } = &mut motion.operations[0].kind
        else {
            unreachable!();
        };
        *candidate = rotation_delta_radians;
        command.programs.push(motion);
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &bundle.scene);
        assert_eq!(session.assets(), &bundle.assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }
}

#[test]
fn normalized_creation_rejects_position_or_resize_after_motion_atomically() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let position = studio_created_appearance_edit_input(
        2.2,
        entity_id,
        "position-after-motion",
        StudioCreationOperationKind::Position {
            position: Some(PointV1 { x: 400.0, y: 180.0 }),
        },
    );
    let mut resize = studio_creation_command(&bundle).programs.remove(1);
    resize.anchor_captured_playhead = 2.2;
    resize.anchor_resolved_seconds = 2.2;
    resize.anchor_source = SceneEditAnchorSource::Playhead {
        reference_seconds: Some(2.2),
    };
    resize.operations[0].interval = IntervalV1 {
        end: 2.2,
        start: 2.2,
    };

    for post_motion_transform in [position, resize] {
        let mut command = studio_creation_command(&bundle);
        command.programs.truncate(1);
        command
            .programs
            .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
        command.programs.push(post_motion_transform);
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &bundle.scene);
        assert_eq!(session.assets(), &bundle.assets);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }
}

#[test]
fn normalized_creation_rejects_invalid_or_animated_appearance_edits_atomically() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut stale_rotation = studio_creation_command(&bundle);
    stale_rotation.programs.truncate(1);
    stale_rotation
        .programs
        .push(studio_created_appearance_edit_input(
            1.0,
            entity_id,
            "stale-rotation",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.25),
                relative_delta: Some(0.5),
                to: Some(0.75),
            },
        ));
    let mut noop_opacity = studio_creation_command(&bundle);
    noop_opacity.programs.truncate(1);
    noop_opacity
        .programs
        .push(studio_created_appearance_edit_input(
            1.0,
            entity_id,
            "noop-opacity",
            StudioCreationOperationKind::Opacity { alpha: Some(1.0) },
        ));
    let mut rotation_at_a_different_static_anchor = studio_creation_command(&bundle);
    rotation_at_a_different_static_anchor
        .programs
        .push(studio_created_appearance_edit_input(
            1.2,
            entity_id,
            "rotation-at-a-different-static-anchor",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(0.5),
                to: Some(0.5),
            },
        ));
    let mut rotation_with_motion = studio_creation_command(&bundle);
    rotation_with_motion.programs.truncate(1);
    rotation_with_motion
        .programs
        .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
    rotation_with_motion
        .programs
        .push(studio_created_appearance_edit_input(
            1.2,
            entity_id,
            "rotation-with-motion",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(0.5),
                to: Some(0.5),
            },
        ));

    for command in [
        stale_rotation,
        noop_opacity,
        rotation_at_a_different_static_anchor,
        rotation_with_motion,
    ] {
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &bundle.scene);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }
}

#[test]
fn normalized_creation_projects_and_applies_a_regular_polygon_as_one_closed_cubic_path() {
    let bundle = static_imported_bundle();
    let mut command = studio_regular_polygon_creation_command(&bundle, 5, 2.0);
    let program = &mut command.programs[0];
    let draw = program
        .operations
        .iter_mut()
        .find(|operation| matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. }))
        .unwrap();
    draw.id = "draw".to_owned();
    draw.interval.end = 1.25;
    draw.kind = StudioCreationOperationKind::DrawIn {
        easing: StudioPropertyEasing::Smooth,
        from: Some(0.0),
        to: Some(1.0),
    };
    program.schedule_order[2] = "draw".to_owned();

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(projection.entities.len(), 1);
    assert_eq!(
        projection.entities[0].kind,
        StudioAuthoringEntityKind::RegularPolygon
    );
    assert_eq!(
        projection.entities[0].initial_dimensions,
        StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: Some(2.0),
            sides: Some(5),
            width: None,
        }
    );
    let projection_wire = serde_json::to_value(&projection).unwrap();
    assert_eq!(
        projection_wire["entities"][0]["kind"],
        serde_json::json!("regular-polygon")
    );
    assert_eq!(
        projection_wire["entities"][0]["initialDimensions"],
        serde_json::json!({ "radius": 2.0, "sides": 5 })
    );

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:regular-polygon")
        .unwrap();
    let SceneGeometryV1::CubicPath { path } = &created.geometry else {
        panic!("regular polygon must reuse cubic-path geometry");
    };
    assert_eq!(path.subpaths.len(), 1);
    let subpath = &path.subpaths[0];
    assert!(subpath.closed);
    assert_eq!(subpath.segments.len(), 5);
    assert!(subpath.start.x.abs() < 1.0e-12);
    let min_y = subpath
        .segments
        .iter()
        .map(|segment| segment.end.y)
        .fold(subpath.start.y, f64::min);
    assert!((min_y + subpath.start.y).abs() < 1.0e-12);
    let final_endpoint = &subpath.segments.last().unwrap().end;
    assert!((final_endpoint.x - subpath.start.x).abs() < 1.0e-12);
    assert!((final_endpoint.y - subpath.start.y).abs() < 1.0e-12);
    assert!(
        result
            .bundle
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::CubicPathGeometry)
    );
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::PathTrim { entity_id, .. }
                        if entity_id == "tx:create/entity:regular-polygon"
                )
            })
    );
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[test]
fn regular_polygon_path_matches_manim_even_and_odd_start_orientation() {
    let triangle = studio_regular_polygon_path(3, 1.5);
    let triangle_subpath = &triangle.subpaths[0];
    let triangle_points = std::iter::once(&triangle_subpath.start)
        .chain(triangle_subpath.segments.iter().map(|segment| &segment.end))
        .collect::<Vec<_>>();
    let triangle_min_y = triangle_points
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let triangle_max_y = triangle_points
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    assert!(triangle_subpath.start.x.abs() < 1.0e-12);
    assert!((triangle_subpath.start.y - triangle_max_y).abs() < 1.0e-12);
    assert!((triangle_min_y + triangle_max_y).abs() < 1.0e-12);

    let hexagon = studio_regular_polygon_path(6, 1.5);
    assert!((hexagon.subpaths[0].start.x - 1.5).abs() < 1.0e-12);
    assert!(hexagon.subpaths[0].start.y.abs() < 1.0e-12);
    assert_eq!(hexagon.subpaths[0].segments.len(), 6);
}

#[test]
fn normalized_creation_rejects_invalid_regular_polygon_payloads_atomically() {
    let bundle = static_imported_bundle();
    let valid = studio_regular_polygon_creation_command(&bundle, 6, 1.0);
    let mut invalid_dimensions = vec![
        StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: Some(1.0),
            sides: None,
            width: None,
        },
        StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: Some(1.0),
            sides: Some(2),
            width: None,
        },
        StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: Some(1.0),
            sides: Some(33),
            width: None,
        },
        StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: None,
            sides: Some(6),
            width: None,
        },
        StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: Some(0.0),
            sides: Some(6),
            width: None,
        },
        StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: Some(f64::INFINITY),
            sides: Some(6),
            width: None,
        },
        StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: None,
            radius: Some(1.0),
            sides: Some(6),
            width: Some(1.0),
        },
    ];
    invalid_dimensions.push(StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: None,
        radius: Some(f64::NAN),
        sides: Some(6),
        width: None,
    });

    for dimensions in invalid_dimensions {
        let mut command = valid.clone();
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.dimensions = dimensions;
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &command.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));

        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &bundle.scene);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one table pins all three bounded curve primitives through the same creation path"
)]
fn normalized_creation_projects_and_applies_curve_primitives_as_cubic_paths() {
    let bundle = static_imported_bundle();
    let cases = [
        (
            "ellipse",
            StudioAuthoringEntityKind::Ellipse,
            StudioAuthoringDimensions {
                height: Some(2.0),
                width: Some(4.0),
                ..StudioAuthoringDimensions::default()
            },
            true,
            4,
            PointV1 { x: 2.0, y: 0.0 },
            PointV1 { x: 0.0, y: 1.0 },
            PointV1 { x: 2.0, y: 0.0 },
        ),
        (
            "arc",
            StudioAuthoringEntityKind::Arc,
            StudioAuthoringDimensions {
                angles: Some(StudioAuthoringAngles {
                    start: FRAC_PI_2,
                    sweep: PI,
                }),
                radius: Some(2.0),
                ..StudioAuthoringDimensions::default()
            },
            false,
            2,
            PointV1 { x: 0.0, y: 2.0 },
            PointV1 { x: -2.0, y: 0.0 },
            PointV1 { x: 0.0, y: -2.0 },
        ),
        (
            "sector",
            StudioAuthoringEntityKind::Sector,
            StudioAuthoringDimensions {
                angles: Some(StudioAuthoringAngles {
                    start: 0.0,
                    sweep: FRAC_PI_2,
                }),
                radius: Some(2.0),
                ..StudioAuthoringDimensions::default()
            },
            true,
            3,
            PointV1 { x: 0.0, y: 0.0 },
            PointV1 { x: 2.0, y: 0.0 },
            PointV1 { x: 0.0, y: 0.0 },
        ),
    ];
    let point_is_near = |actual: &PointV1, expected: &PointV1| {
        (actual.x - expected.x).abs() < 1.0e-12 && (actual.y - expected.y).abs() < 1.0e-12
    };

    for (slug, kind, dimensions, closed, segment_count, start, first_end, end) in cases {
        let mut command = studio_path_creation_command(&bundle, slug, kind, dimensions);
        if kind == StudioAuthoringEntityKind::Arc {
            let program = &mut command.programs[0];
            let draw = program
                .operations
                .iter_mut()
                .find(|operation| {
                    matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. })
                })
                .unwrap();
            draw.id = "draw".to_owned();
            draw.interval.end = 1.25;
            draw.kind = StudioCreationOperationKind::DrawIn {
                easing: StudioPropertyEasing::Smooth,
                from: Some(0.0),
                to: Some(1.0),
            };
            program.schedule_order[2] = "draw".to_owned();
            add_creation_paint_color_segment(
                program,
                "tx:create/entity:arc",
                StudioPaintColorProperty::StrokeColor,
                "#ffffff",
                "#22c55e",
                1.5,
                2.0,
            );
        }

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(projection.entities[0].kind, kind);
        assert_eq!(projection.entities[0].initial_dimensions, dimensions);
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == format!("tx:create/entity:{slug}"))
            .unwrap();
        let SceneGeometryV1::CubicPath { path } = &created.geometry else {
            panic!("curve primitive must reuse cubic-path geometry");
        };
        let subpath = &path.subpaths[0];
        assert_eq!(subpath.closed, closed);
        assert_eq!(subpath.segments.len(), segment_count);
        assert!(point_is_near(&subpath.start, &start));
        assert!(point_is_near(&subpath.segments[0].end, &first_end));
        assert!(point_is_near(&subpath.segments.last().unwrap().end, &end));
        assert!(
            result
                .bundle
                .scene
                .required_capabilities
                .contains(&SceneCapabilityV1::CubicPathGeometry)
        );
        if kind == StudioAuthoringEntityKind::Arc {
            assert_eq!(
                projection.entities[0].stroke_color.as_deref(),
                Some("#ffffff")
            );
            assert_eq!(
                serde_json::to_value(&projection).unwrap()["entities"][0]["initialDimensions"],
                serde_json::json!({
                    "angles": { "start": FRAC_PI_2, "sweep": PI },
                    "radius": 2.0
                })
            );
            assert!(
                result
                    .bundle
                    .scene
                    .animation_channels
                    .iter()
                    .any(|channel| {
                        matches!(
                            channel,
                            AnimationChannelV1::PathTrim { entity_id, .. }
                                if entity_id == "tx:create/entity:arc"
                        )
                    })
            );
            assert!(
                result
                    .bundle
                    .scene
                    .animation_channels
                    .iter()
                    .any(|channel| {
                        matches!(
                            channel,
                            AnimationChannelV1::VectorAppearance {
                                entity_id,
                                keyframes,
                                ..
                            } if entity_id == "tx:create/entity:arc"
                                && keyframes.iter().all(|keyframe| matches!(
                                    &keyframe.value,
                                    VectorAppearanceValueV1 { fill: None, stroke: Some(_) }
                                ))
                        )
                    })
            );
        }
    }
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one table pins the three coordinate primitives through projection and retained Scene IR"
)]
fn normalized_creation_projects_and_applies_coordinate_system_primitives() {
    let bundle = static_imported_bundle();
    let x = StudioAuthoringCoordinateRange {
        maximum: 2.0,
        minimum: -2.0,
        step: 1.0,
    };
    let y = StudioAuthoringCoordinateRange {
        maximum: 1.0,
        minimum: -1.0,
        step: 1.0,
    };
    let cases = [
        (
            "number-line",
            StudioAuthoringEntityKind::NumberLine,
            StudioAuthoringDimensions {
                coordinate_system: Some(StudioAuthoringCoordinateSystem { x, y: None }),
                width: Some(6.0),
                ..StudioAuthoringDimensions::default()
            },
            6,
        ),
        (
            "axes",
            StudioAuthoringEntityKind::Axes,
            StudioAuthoringDimensions {
                coordinate_system: Some(StudioAuthoringCoordinateSystem { x, y: Some(y) }),
                height: Some(4.0),
                width: Some(6.0),
                ..StudioAuthoringDimensions::default()
            },
            10,
        ),
        (
            "number-plane",
            StudioAuthoringEntityKind::NumberPlane,
            StudioAuthoringDimensions {
                coordinate_system: Some(StudioAuthoringCoordinateSystem { x, y: Some(y) }),
                height: Some(4.0),
                width: Some(6.0),
                ..StudioAuthoringDimensions::default()
            },
            16,
        ),
    ];

    for (slug, kind, dimensions, expected_subpath_count) in cases {
        let mut command = studio_path_creation_command(&bundle, slug, kind, dimensions);
        if kind == StudioAuthoringEntityKind::NumberLine {
            let program = &mut command.programs[0];
            let draw = program
                .operations
                .iter_mut()
                .find(|operation| {
                    matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. })
                })
                .unwrap();
            draw.id = "draw".to_owned();
            draw.interval.end = 1.25;
            draw.kind = StudioCreationOperationKind::DrawIn {
                easing: StudioPropertyEasing::Smooth,
                from: Some(0.0),
                to: Some(1.0),
            };
            program.schedule_order[2] = "draw".to_owned();
        }

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(projection.entities[0].kind, kind);
        assert_eq!(projection.entities[0].initial_dimensions, dimensions);
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == format!("tx:create/entity:{slug}"))
            .unwrap();
        let SceneGeometryV1::CubicPath { path } = &created.geometry else {
            panic!("coordinate primitive must reuse cubic-path geometry");
        };
        assert_eq!(path.subpaths.len(), expected_subpath_count);
        assert!(
            path.subpaths
                .iter()
                .all(|subpath| { !subpath.closed && subpath.segments.len() == 1 })
        );
        assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector {
                fill: None,
                stroke: Some(_),
                ..
            }
        ));
        if kind == StudioAuthoringEntityKind::NumberLine {
            let axis = &path.subpaths[0];
            assert_eq!(axis.start, PointV1 { x: -3.0, y: 0.0 });
            assert_eq!(axis.segments[0].end, PointV1 { x: 3.0, y: 0.0 });
            assert!(
                result
                    .bundle
                    .scene
                    .animation_channels
                    .iter()
                    .any(|channel| {
                        matches!(
                            channel,
                            AnimationChannelV1::PathTrim { entity_id, .. }
                                if entity_id == "tx:create/entity:number-line"
                        )
                    })
            );
        }
        if kind == StudioAuthoringEntityKind::NumberPlane {
            assert_eq!(
                serde_json::to_value(&projection).unwrap()["entities"][0]["initialDimensions"],
                serde_json::json!({
                    "coordinateSystem": {
                        "x": { "maximum": 2.0, "minimum": -2.0, "step": 1.0 },
                        "y": { "maximum": 1.0, "minimum": -1.0, "step": 1.0 }
                    },
                    "height": 4.0,
                    "width": 6.0
                })
            );
        }
    }
}

#[test]
fn normalized_creation_rejects_invalid_coordinate_systems_atomically() {
    let bundle = static_imported_bundle();
    let range = |minimum, maximum, step| StudioAuthoringCoordinateRange {
        maximum,
        minimum,
        step,
    };
    let number_line = |coordinates| StudioAuthoringDimensions {
        coordinate_system: coordinates,
        width: Some(6.0),
        ..StudioAuthoringDimensions::default()
    };
    let axes = |coordinates, height| StudioAuthoringDimensions {
        coordinate_system: Some(coordinates),
        height,
        width: Some(6.0),
        ..StudioAuthoringDimensions::default()
    };
    let invalid = [
        (StudioAuthoringEntityKind::NumberLine, number_line(None)),
        (
            StudioAuthoringEntityKind::NumberLine,
            number_line(Some(StudioAuthoringCoordinateSystem {
                x: range(-2.0, 2.0, 1.0),
                y: Some(range(-1.0, 1.0, 1.0)),
            })),
        ),
        (
            StudioAuthoringEntityKind::Axes,
            axes(
                StudioAuthoringCoordinateSystem {
                    x: range(-2.0, 2.0, 1.0),
                    y: None,
                },
                Some(4.0),
            ),
        ),
        (
            StudioAuthoringEntityKind::Axes,
            axes(
                StudioAuthoringCoordinateSystem {
                    x: range(-2.0, 2.0, 1.0),
                    y: Some(range(-1.0, 1.0, 1.0)),
                },
                None,
            ),
        ),
        (
            StudioAuthoringEntityKind::NumberLine,
            number_line(Some(StudioAuthoringCoordinateSystem {
                x: range(1.0, 1.0, 1.0),
                y: None,
            })),
        ),
        (
            StudioAuthoringEntityKind::NumberLine,
            number_line(Some(StudioAuthoringCoordinateSystem {
                x: range(-2.0, 2.0, 0.0),
                y: None,
            })),
        ),
        (
            StudioAuthoringEntityKind::NumberLine,
            number_line(Some(StudioAuthoringCoordinateSystem {
                x: range(f64::NAN, 2.0, 1.0),
                y: None,
            })),
        ),
        (
            StudioAuthoringEntityKind::NumberLine,
            number_line(Some(StudioAuthoringCoordinateSystem {
                x: range(0.0, 128.0, 1.0),
                y: None,
            })),
        ),
        (
            StudioAuthoringEntityKind::NumberLine,
            StudioAuthoringDimensions {
                coordinate_system: Some(StudioAuthoringCoordinateSystem {
                    x: range(-2.0, 2.0, 1.0),
                    y: None,
                }),
                radius: Some(1.0),
                width: Some(6.0),
                ..StudioAuthoringDimensions::default()
            },
        ),
    ];

    for (kind, dimensions) in invalid {
        let command = studio_path_creation_command(&bundle, "invalid", kind, dimensions);
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &command.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &bundle.scene);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one table pins both admitted interpolation modes through projection and retained Scene IR"
)]
fn normalized_creation_projects_and_applies_static_data_plots() {
    let bundle = static_imported_bundle();
    let dimensions = studio_data_plot_dimensions(3.0, 1.0);
    let points = vec![
        PointV1 { x: 0.0, y: 0.0 },
        PointV1 { x: 1.0, y: 1.0 },
        PointV1 { x: 2.0, y: 0.0 },
        PointV1 { x: 3.0, y: 1.0 },
    ];
    let point_is_near = |actual: &PointV1, expected: &PointV1| {
        (actual.x - expected.x).abs() < 1.0e-12 && (actual.y - expected.y).abs() < 1.0e-12
    };

    for interpolation in [
        StudioDataPlotInterpolation::Linear,
        StudioDataPlotInterpolation::Smooth,
    ] {
        let series = StudioDataSeries {
            interpolation,
            points: points.clone(),
        };
        let mut command = studio_data_plot_creation_command(&bundle, dimensions, series.clone());
        if interpolation == StudioDataPlotInterpolation::Linear {
            let program = &mut command.programs[0];
            let draw = program
                .operations
                .iter_mut()
                .find(|operation| {
                    matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. })
                })
                .unwrap();
            draw.id = "draw".to_owned();
            draw.interval.end = 1.25;
            draw.kind = StudioCreationOperationKind::DrawIn {
                easing: StudioPropertyEasing::Smooth,
                from: Some(0.0),
                to: Some(1.0),
            };
            program.schedule_order[2] = "draw".to_owned();
        }

        let projection =
            project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
        assert_eq!(
            projection.entities[0].kind,
            StudioAuthoringEntityKind::DataPlot
        );
        assert_eq!(projection.entities[0].data_series.as_ref(), Some(&series));
        let projection_wire = serde_json::to_value(&projection).unwrap();
        assert_eq!(projection_wire["entities"][0]["kind"], "data-plot");
        assert_eq!(
            projection_wire["entities"][0]["dataSeries"],
            serde_json::to_value(&series).unwrap()
        );

        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        let created = result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "tx:create/entity:data-plot")
            .unwrap();
        let SceneGeometryV1::CubicPath { path } = &created.geometry else {
            panic!("data plot must reuse cubic-path geometry");
        };
        let subpath = &path.subpaths[0];
        assert_eq!(path.subpaths.len(), 1);
        assert!(!subpath.closed);
        assert_eq!(subpath.segments.len(), 3);
        assert!(point_is_near(&subpath.start, &PointV1 { x: -3.0, y: -0.5 }));
        assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector {
                fill: None,
                stroke: Some(_),
                ..
            }
        ));

        if interpolation == StudioDataPlotInterpolation::Linear {
            assert!(point_is_near(
                &subpath.segments[0].control1,
                &PointV1 {
                    x: -7.0 / 3.0,
                    y: -1.0 / 6.0,
                }
            ));
            assert!(
                result
                    .bundle
                    .scene
                    .animation_channels
                    .iter()
                    .any(|channel| {
                        matches!(
                            channel,
                            AnimationChannelV1::PathTrim { entity_id, .. }
                                if entity_id == "tx:create/entity:data-plot"
                        )
                    })
            );
        } else {
            assert!((subpath.segments[0].control2.y - subpath.segments[0].end.y).abs() < 1.0e-12);
            assert!((subpath.segments[1].control1.y - subpath.segments[0].end.y).abs() < 1.0e-12);
            assert!((subpath.segments[1].control2.y - subpath.segments[1].end.y).abs() < 1.0e-12);
            assert!((subpath.segments[2].control1.y - subpath.segments[1].end.y).abs() < 1.0e-12);
            for (index, segment) in subpath.segments.iter().enumerate() {
                let start_y = if index == 0 {
                    subpath.start.y
                } else {
                    subpath.segments[index - 1].end.y
                };
                let lower = start_y.min(segment.end.y);
                let upper = start_y.max(segment.end.y);
                assert!((lower..=upper).contains(&segment.control1.y));
                assert!((lower..=upper).contains(&segment.control2.y));
            }
        }
    }
}

#[test]
fn normalized_creation_rejects_invalid_static_data_plots_atomically() {
    let bundle = static_imported_bundle();
    let command = studio_data_plot_creation_command(
        &bundle,
        studio_data_plot_dimensions(3.0, 1.0),
        StudioDataSeries {
            interpolation: StudioDataPlotInterpolation::Smooth,
            points: vec![PointV1 { x: 1.0, y: 0.0 }, PointV1 { x: 1.0, y: 1.0 }],
        },
    );
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &command.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
    let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &bundle.scene);
    assert_eq!(session.retained_index_stats().build_count, 1);

    let mut cross_payload = studio_data_plot_creation_command(
        &bundle,
        studio_data_plot_dimensions(3.0, 1.0),
        StudioDataSeries {
            interpolation: StudioDataPlotInterpolation::Linear,
            points: vec![PointV1 { x: -1.0, y: 0.0 }, PointV1 { x: 1.0, y: 1.0 }],
        },
    );
    {
        let StudioCreationOperationKind::Create { entity } =
            &mut cross_payload.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.svg = Some(StudioCreationSvgPathSpec {
            source: r#"<svg viewBox="0 0 1 1"><path d="M0 0 L1 1"/></svg>"#.to_owned(),
        });
    }
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &cross_payload.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    {
        let StudioCreationOperationKind::Create { entity } =
            &mut cross_payload.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.svg = None;
        entity.cubic_bezier = Some(StudioCreationCubicBezierSpec {
            arrow_end: false,
            closed: false,
            control1: PointV1 { x: -0.5, y: 1.0 },
            control2: PointV1 { x: 0.5, y: -1.0 },
            continuation_segments: Vec::new(),
            end: PointV1 { x: 1.0, y: 0.0 },
            fill_color: None,
            start: PointV1 { x: -1.0, y: 0.0 },
            stroke_cap: StudioCubicBezierStrokeCap::Round,
            stroke_width: 0.04,
        });
    }
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &cross_payload.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
}

#[test]
fn normalized_creation_rejects_invalid_curve_dimensions_atomically() {
    let bundle = static_imported_bundle();
    let ellipse = |width, height| StudioAuthoringDimensions {
        height: Some(height),
        width: Some(width),
        ..StudioAuthoringDimensions::default()
    };
    let radial = |radius, start, sweep| StudioAuthoringDimensions {
        angles: Some(StudioAuthoringAngles { start, sweep }),
        radius: Some(radius),
        ..StudioAuthoringDimensions::default()
    };
    let invalid = [
        (StudioAuthoringEntityKind::Ellipse, ellipse(0.0, 2.0)),
        (
            StudioAuthoringEntityKind::Ellipse,
            ellipse(2.0, f64::INFINITY),
        ),
        (StudioAuthoringEntityKind::Arc, radial(1.0, 0.0, 0.0)),
        (
            StudioAuthoringEntityKind::Arc,
            radial(1.0, f64::NAN, FRAC_PI_2),
        ),
        (
            StudioAuthoringEntityKind::Sector,
            radial(1.0, 0.0, std::f64::consts::TAU + 1.0e-6),
        ),
        (
            StudioAuthoringEntityKind::Sector,
            StudioAuthoringDimensions {
                radius: Some(1.0),
                ..StudioAuthoringDimensions::default()
            },
        ),
    ];

    for (kind, dimensions) in invalid {
        let command = studio_path_creation_command(&bundle, "invalid", kind, dimensions);
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &command.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &bundle.scene);
    }
}

fn assert_studio_shape_paint_operation(
    bundle: &SceneIrBundleV1,
    kind: StudioAuthoringEntityKind,
    dimensions: StudioAuthoringDimensions,
    operation_id: &str,
    operation: StudioCreationOperationKind,
    accepted: bool,
) {
    let mut command = studio_path_creation_command(bundle, "shape", kind, dimensions);
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:shape",
        operation_id,
        operation,
    ));
    let projected = project_studio_creation_edits(bundle.scene.duration, &command.programs);
    assert_eq!(projected.is_ok(), accepted);
    if !accepted {
        return;
    }
    let result = EngineSessionV1::new(bundle.clone())
        .unwrap()
        .apply_studio_creation_edit(command)
        .unwrap();
    if !matches!(operation_id, "stroke-width" | "stroke-cap") {
        return;
    }
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:shape")
        .unwrap();
    match operation_id {
        "stroke-width" => assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector {
                stroke: Some(stroke),
                ..
            } if (stroke.width_world - 0.08).abs() < 1e-12
        )),
        "stroke-cap" => assert!(matches!(
            &created.appearance,
            SceneAppearanceV1::Vector {
                stroke: Some(stroke),
                ..
            } if stroke.cap == poietra_scene_ir::StrokeCapV1::Round
        )),
        _ => unreachable!(),
    }
}

#[test]
fn normalized_creation_limits_shape_paint_to_closed_fill_and_vector_stroke() {
    let bundle = static_imported_bundle();
    let dimensions = |kind| match kind {
        StudioAuthoringEntityKind::Circle => StudioAuthoringDimensions {
            radius: Some(1.0),
            ..StudioAuthoringDimensions::default()
        },
        StudioAuthoringEntityKind::Ellipse | StudioAuthoringEntityKind::Rectangle => {
            StudioAuthoringDimensions {
                height: Some(1.0),
                width: Some(2.0),
                ..StudioAuthoringDimensions::default()
            }
        }
        StudioAuthoringEntityKind::Arc | StudioAuthoringEntityKind::Sector => {
            StudioAuthoringDimensions {
                angles: Some(StudioAuthoringAngles {
                    start: 0.0,
                    sweep: PI,
                }),
                radius: Some(1.0),
                ..StudioAuthoringDimensions::default()
            }
        }
        StudioAuthoringEntityKind::RegularPolygon => StudioAuthoringDimensions {
            radius: Some(1.0),
            sides: Some(3),
            ..StudioAuthoringDimensions::default()
        },
        StudioAuthoringEntityKind::Arrow | StudioAuthoringEntityKind::Line => {
            StudioAuthoringDimensions::default()
        }
        _ => unreachable!(),
    };
    let cases = [
        (StudioAuthoringEntityKind::Arc, false, true),
        (StudioAuthoringEntityKind::Arrow, false, true),
        (StudioAuthoringEntityKind::Circle, true, true),
        (StudioAuthoringEntityKind::Ellipse, true, true),
        (StudioAuthoringEntityKind::Line, false, true),
        (StudioAuthoringEntityKind::Rectangle, true, true),
        (StudioAuthoringEntityKind::RegularPolygon, true, true),
        (StudioAuthoringEntityKind::Sector, true, true),
    ];

    for (kind, accepts_fill, accepts_stroke) in cases {
        for (operation_id, operation, accepted) in [
            (
                "fill",
                StudioCreationOperationKind::FillColor {
                    color: Some("#e07a5f".to_owned()),
                },
                accepts_fill,
            ),
            (
                "stroke",
                StudioCreationOperationKind::StrokeColor {
                    color: Some("#81b29a".to_owned()),
                },
                accepts_stroke,
            ),
            (
                "stroke-width",
                StudioCreationOperationKind::StrokeWidth {
                    width_world: Some(0.08),
                },
                matches!(
                    kind,
                    StudioAuthoringEntityKind::Arc
                        | StudioAuthoringEntityKind::Circle
                        | StudioAuthoringEntityKind::Ellipse
                        | StudioAuthoringEntityKind::Line
                        | StudioAuthoringEntityKind::Rectangle
                        | StudioAuthoringEntityKind::RegularPolygon
                ),
            ),
            (
                "stroke-cap",
                StudioCreationOperationKind::StrokeCap {
                    cap: Some(poietra_scene_ir::StrokeCapV1::Round),
                },
                matches!(
                    kind,
                    StudioAuthoringEntityKind::Arc | StudioAuthoringEntityKind::Line
                ),
            ),
        ] {
            assert_studio_shape_paint_operation(
                &bundle,
                kind,
                dimensions(kind),
                operation_id,
                operation,
                accepted,
            );
        }
    }
}
#[test]
fn normalized_creation_projects_and_applies_a_line() {
    let bundle = static_imported_bundle();
    let mut command = studio_draw_creation_command(&bundle);
    let program = &mut command.programs[0];
    for operation in &mut program.operations {
        if operation.entity_id.as_deref() == Some("tx:create/entity:circle") {
            operation.entity_id = Some("tx:create/entity:line".to_owned());
        }
    }
    let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
        panic!("creation fixture must start with CreateEntity");
    };
    entity.id = "tx:create/entity:line".to_owned();
    entity.kind = StudioAuthoringEntityKind::Line;
    entity.dimensions = StudioAuthoringDimensions::default();
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:line",
        "line-stroke-width",
        StudioCreationOperationKind::StrokeWidth {
            width_world: Some(0.08),
        },
    ));
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:line",
        "line-stroke-cap",
        StudioCreationOperationKind::StrokeCap {
            cap: Some(poietra_scene_ir::StrokeCapV1::Round),
        },
    ));
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:line",
        "line-stroke-dash",
        StudioCreationOperationKind::StrokeDash {
            dash_length_world: Some(0.4),
            gap_length_world: Some(0.2),
        },
    ));

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(projection.entities[0].kind, StudioAuthoringEntityKind::Line);
    assert!(projection.mutations.iter().any(|mutation| matches!(
        mutation,
        StudioCreationProjectedMutation {
            interval: IntervalV1 { start, end },
            kind: StudioCreationProjectedMutationKind::StrokeWidth { value },
            ..
        } if (*start - 0.5).abs() < 1e-12
            && (*end - 0.5).abs() < 1e-12
            && (*value - 0.08).abs() < 1e-12
    )));
    assert!(projection.mutations.iter().any(|mutation| matches!(
        mutation,
        StudioCreationProjectedMutation {
            interval: IntervalV1 { start, end },
            kind: StudioCreationProjectedMutationKind::StrokeDash {
                value: Some(StudioStrokeDash {
                    dash_length,
                    gap_length,
                }),
            },
            ..
        } if (*start - 0.5).abs() < 1e-12
            && (*end - 0.5).abs() < 1e-12
            && (*dash_length - 0.4).abs() < 1e-12
            && (*gap_length - 0.2).abs() < 1e-12
    )));
    assert!(projection.mutations.iter().any(|mutation| matches!(
        mutation,
        StudioCreationProjectedMutation {
            interval: IntervalV1 { start, end },
            kind: StudioCreationProjectedMutationKind::StrokeCap {
                value: poietra_scene_ir::StrokeCapV1::Round,
            },
            ..
        } if (*start - 0.5).abs() < 1e-12 && (*end - 0.5).abs() < 1e-12
    )));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:line")
        .unwrap();
    assert!(matches!(
        &created.geometry,
        SceneGeometryV1::Line {
            start: PointV1 { x: -1.0, y: 0.0 },
            end: PointV1 { x: 1.0, y: 0.0 },
        }
    ));
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            fill: None,
            stroke: Some(stroke),
            ..
        } if (stroke.width_world - 0.08).abs() < 1e-12
            && stroke.cap == poietra_scene_ir::StrokeCapV1::Round
            && stroke.dash_length_world == Some(0.4)
            && stroke.gap_length_world == Some(0.2)
    ));
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::PathTrim { entity_id, .. }
                    if entity_id == "tx:create/entity:line"
            ))
    );
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "line-stroke-style",
            sample_time: 0.75,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(packet.draws.iter().any(|draw| matches!(
        draw,
        poietra_scene_ir::RenderDrawV1::Path {
            entity_id,
            stroke: Some(stroke),
            ..
        } if entity_id == "tx:create/entity:line"
            && (stroke.width_world - 0.08).abs() < 1e-12
            && stroke.cap == poietra_scene_ir::StrokeCapV1::Round
            && stroke.dash_length_world == Some(0.4)
            && stroke.gap_length_world == Some(0.2)
    )));

    for width_world in [0.004, 0.501, f64::NAN] {
        let mut invalid = studio_path_creation_command(
            &static_imported_bundle(),
            "line",
            StudioAuthoringEntityKind::Line,
            StudioAuthoringDimensions::default(),
        );
        invalid.programs.push(studio_created_appearance_edit_input(
            0.5,
            "tx:create/entity:line",
            "invalid-line-stroke-width",
            StudioCreationOperationKind::StrokeWidth {
                width_world: Some(width_world),
            },
        ));
        assert!(matches!(
            project_studio_creation_edits(0.5, &invalid.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }

    let mut late = studio_path_creation_command(
        &static_imported_bundle(),
        "line",
        StudioAuthoringEntityKind::Line,
        StudioAuthoringDimensions::default(),
    );
    late.programs.push(studio_created_appearance_edit_input(
        0.75,
        "tx:create/entity:line",
        "late-line-stroke-width",
        StudioCreationOperationKind::StrokeWidth {
            width_world: Some(0.08),
        },
    ));
    assert!(matches!(
        project_studio_creation_edits(0.5, &late.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut animated = studio_path_creation_command(
        &static_imported_bundle(),
        "line",
        StudioAuthoringEntityKind::Line,
        StudioAuthoringDimensions::default(),
    );
    let mut animated_width = studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:line",
        "animated-line-stroke-width",
        StudioCreationOperationKind::StrokeWidth {
            width_world: Some(0.08),
        },
    );
    animated_width.operations[0].interval.end = 0.75;
    animated.programs.push(animated_width);
    assert!(matches!(
        project_studio_creation_edits(0.5, &animated.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let invalid_cap_cases = [
        (
            "missing-line-stroke-cap",
            StudioCreationOperationKind::StrokeCap { cap: None },
            0.5,
            0.5,
        ),
        (
            "late-line-stroke-cap",
            StudioCreationOperationKind::StrokeCap {
                cap: Some(poietra_scene_ir::StrokeCapV1::Square),
            },
            0.75,
            0.75,
        ),
        (
            "animated-line-stroke-cap",
            StudioCreationOperationKind::StrokeCap {
                cap: Some(poietra_scene_ir::StrokeCapV1::Square),
            },
            0.5,
            0.75,
        ),
    ];
    for (operation_id, operation, start, end) in invalid_cap_cases {
        let mut invalid = studio_path_creation_command(
            &static_imported_bundle(),
            "line",
            StudioAuthoringEntityKind::Line,
            StudioAuthoringDimensions::default(),
        );
        let mut edit = studio_created_appearance_edit_input(
            start,
            "tx:create/entity:line",
            operation_id,
            operation,
        );
        edit.operations[0].interval.end = end;
        invalid.programs.push(edit);
        assert!(matches!(
            project_studio_creation_edits(0.5, &invalid.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }
}

#[test]
fn normalized_creation_draw_emits_one_path_trim_channel() {
    let bundle = static_imported_bundle();
    let mut command = studio_draw_creation_command(&bundle);
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:circle",
        "initial-draw-stroke",
        StudioCreationOperationKind::StrokeColor {
            color: Some("#22c55e".to_owned()),
        },
    ));
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!((projection.projected_duration - (bundle.scene.duration + 0.75)).abs() < 1e-12);
    assert!(matches!(
        &projection.mutations[1].kind,
        StudioCreationProjectedMutationKind::DrawIn {
            easing: EasingV1::ManimSmooth {},
            from,
            to,
        } if from.abs() < 1e-12 && (*to - 1.0).abs() < 1e-12
    ));
    assert!(matches!(
        &projection.mutations[2],
        StudioCreationProjectedMutation {
            interval: IntervalV1 { start, end },
            kind: StudioCreationProjectedMutationKind::StrokeColor { value },
            ..
        } if (*start - 0.5).abs() < 1e-12
            && (*end - 0.5).abs() < 1e-12
            && value == "#22c55e"
    ));
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let scene = &result.bundle.scene;
    assert!(
        scene
            .required_capabilities
            .contains(&SceneCapabilityV1::PathTrimAnimation)
    );
    assert!(scene.animation_channels.iter().any(|channel| matches!(
        channel,
        AnimationChannelV1::PathTrim {
            entity_id,
            keyframes,
            parameterization: Some(PathTrimParameterizationV1::UniformCubicParameterV1),
            ..
        } if entity_id == "tx:create/entity:circle"
            && matches!(keyframes.as_slice(), [
                KeyframeV1 {
                    at: 0.5,
                    easing_to_next: Some(EasingV1::ManimSmooth {}),
                    value: 0.0,
                },
                KeyframeV1 {
                    at: 1.25,
                    easing_to_next: None,
                    value: 1.0,
                },
            ])
    )));
    assert!(!scene.animation_channels.iter().any(|channel| matches!(
        channel,
        AnimationChannelV1::VectorAppearance { entity_id, .. }
            if entity_id == "tx:create/entity:circle"
    )));
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "initial-draw-stroke",
            sample_time: 0.75,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(packet.draws.iter().any(|draw| matches!(
        draw,
        poietra_scene_ir::RenderDrawV1::Path {
            entity_id,
            stroke: Some(stroke),
            ..
        } if entity_id == "tx:create/entity:circle"
            && (stroke.color.red - 34.0 / 255.0).abs() < 1e-12
            && (stroke.color.green - 197.0 / 255.0).abs() < 1e-12
            && (stroke.color.blue - 94.0 / 255.0).abs() < 1e-12
    )));
    assert!(!scene.animation_channels.iter().any(|channel| matches!(
        channel,
        AnimationChannelV1::Opacity { entity_id, .. }
            if entity_id == "tx:create/entity:circle"
    )));
}

#[test]
fn normalized_svg_path_creation_uses_canonical_cubic_geometry_and_draw() {
    let bundle = static_imported_bundle();
    let command = studio_svg_path_creation_command(&bundle, false);
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(
        projection.entities[0].kind,
        StudioAuthoringEntityKind::SvgPath
    );
    assert_eq!(projection.entities[0].initial_dimensions.width, Some(3.0));
    assert_eq!(projection.entities[0].initial_dimensions.height, Some(2.0));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:circle")
        .unwrap();
    assert!(matches!(
        &created.geometry,
        SceneGeometryV1::CubicPath { path } if path.subpaths.len() == 2
    ));
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            fill: Some(fill),
            stroke: Some(_),
            ..
        } if fill.rule == FillRuleV1::EvenOdd
    ));
    assert!(
        !result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::PathTrim { entity_id, .. }
                    if entity_id == "tx:create/entity:circle"
            ))
    );

    let draw_bundle = static_imported_bundle();
    let draw_command = studio_svg_path_creation_command(&draw_bundle, true);
    let mut draw_session = EngineSessionV1::new(draw_bundle).unwrap();
    let draw_result = draw_session
        .apply_studio_creation_edit(draw_command)
        .unwrap();
    assert!(
        draw_result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::PathTrim { entity_id, .. }
                    if entity_id == "tx:create/entity:circle"
            ))
    );
}

#[test]
fn normalized_cubic_bezier_creation_keeps_connected_segments_arrow_and_draw() {
    let bundle = static_imported_bundle();
    let inspection =
        crate::authoring::inspect_studio_cubic_bezier(&StudioCreationCubicBezierSpec {
            arrow_end: true,
            closed: false,
            control1: PointV1 { x: -1.0, y: 1.5 },
            control2: PointV1 { x: 1.0, y: -1.5 },
            continuation_segments: vec![poietra_scene_ir::CubicSegmentV1 {
                control1: PointV1 { x: 2.5, y: 1.0 },
                control2: PointV1 { x: 3.5, y: 1.0 },
                end: PointV1 { x: 4.0, y: 0.0 },
            }],
            end: PointV1 { x: 2.0, y: 0.5 },
            fill_color: None,
            start: PointV1 { x: -2.0, y: -0.5 },
            stroke_cap: StudioCubicBezierStrokeCap::Square,
            stroke_width: 0.06,
        })
        .unwrap();
    let mut command = studio_draw_creation_command(&bundle);
    let program = &mut command.programs[0];
    let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
        unreachable!();
    };
    entity.kind = StudioAuthoringEntityKind::CubicBezier;
    entity.dimensions = inspection.dimensions;
    entity.cubic_bezier = Some(inspection.cubic_bezier.clone());
    add_creation_paint_color_segment(
        program,
        "tx:create/entity:circle",
        StudioPaintColorProperty::StrokeColor,
        "#ffffff",
        "#22c55e",
        1.5,
        2.0,
    );
    let renormalized = normalize_studio_cubic_bezier(&inspection.cubic_bezier).unwrap();
    assert!(studio_cubic_bezier_is_canonical(
        &inspection.cubic_bezier,
        &renormalized
    ));
    assert_eq!(inspection.dimensions, renormalized.dimensions);

    let mut dashed_arrow = command.clone();
    dashed_arrow
        .programs
        .push(studio_created_appearance_edit_input(
            0.5,
            "tx:create/entity:circle",
            "arrow-stroke-dash",
            StudioCreationOperationKind::StrokeDash {
                dash_length_world: Some(0.4),
                gap_length_world: Some(0.2),
            },
        ));
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &dashed_arrow.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut without_draw = command.clone();
    let plain = without_draw.programs[0]
        .operations
        .iter_mut()
        .find(|operation| matches!(operation.kind, StudioCreationOperationKind::DrawIn { .. }))
        .unwrap();
    plain.kind = StudioCreationOperationKind::FadeIn { persistent: true };
    project_studio_creation_edits(bundle.scene.duration, &without_draw.programs).unwrap();

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(
        projection.entities[0].cubic_bezier,
        Some(inspection.cubic_bezier)
    );
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:circle")
        .unwrap();
    assert!(matches!(
        &created.geometry,
        SceneGeometryV1::CubicPath { path }
            if path.subpaths[0].segments.len() == 2 && path.subpaths.len() == 2
    ));
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            fill: None,
            stroke: Some(poietra_scene_ir::StrokeStyleV1 {
                cap: poietra_scene_ir::StrokeCapV1::Square,
                width_world,
                ..
            }),
            ..
        } if (*width_world - 0.06).abs() < 1.0e-12
    ));
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
            channel,
            AnimationChannelV1::PathTrim { entity_id, .. }
                if entity_id == "tx:create/entity:circle"
                ))
    );
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::VectorAppearance {
                        entity_id,
                        keyframes,
                        ..
                    } if entity_id == "tx:create/entity:circle"
                        && keyframes.iter().all(|keyframe| matches!(
                            &keyframe.value,
                            VectorAppearanceValueV1 {
                                fill: None,
                                stroke: Some(poietra_scene_ir::StrokeStyleV1 {
                                    cap: poietra_scene_ir::StrokeCapV1::Square,
                                    width_world,
                                    ..
                                }),
                            } if (*width_world - 0.06).abs() < 1.0e-12
                        ))
                )
            })
    );
}

fn studio_closed_cubic_bezier_creation_command(
    bundle: &SceneIrBundleV1,
    draw: bool,
) -> ApplyStudioCreationEditCommand {
    let inspection =
        crate::authoring::inspect_studio_cubic_bezier(&StudioCreationCubicBezierSpec {
            arrow_end: false,
            closed: true,
            control1: PointV1 { x: -1.0, y: 1.5 },
            control2: PointV1 { x: 1.0, y: 1.5 },
            continuation_segments: Vec::new(),
            end: PointV1 { x: 2.0, y: -0.5 },
            fill_color: Some("#22c55e".to_owned()),
            start: PointV1 { x: -2.0, y: -0.5 },
            stroke_cap: StudioCubicBezierStrokeCap::Round,
            stroke_width: 0.04,
        })
        .unwrap();
    let mut command = studio_draw_creation_command(bundle);
    let program = &mut command.programs[0];
    let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
        unreachable!();
    };
    entity.kind = StudioAuthoringEntityKind::CubicBezier;
    entity.dimensions = inspection.dimensions;
    entity.cubic_bezier = Some(inspection.cubic_bezier);
    if !draw {
        let entrance = program
            .operations
            .iter_mut()
            .find(|operation| matches!(operation.kind, StudioCreationOperationKind::DrawIn { .. }))
            .unwrap();
        entrance.kind = StudioCreationOperationKind::FadeIn { persistent: true };
    }
    command
}

#[test]
fn multisegment_pen_applies_static_stroke_join_only_at_creation_anchor() {
    let bundle = static_imported_bundle();
    let mut base = studio_closed_cubic_bezier_creation_command(&bundle, false);
    let StudioCreationOperationKind::Create { entity } = &mut base.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    let mut spec = entity.cubic_bezier.take().unwrap();
    spec.continuation_segments
        .push(poietra_scene_ir::CubicSegmentV1 {
            control1: PointV1 { x: 2.5, y: -1.0 },
            control2: PointV1 { x: 3.5, y: 1.0 },
            end: PointV1 { x: 4.0, y: -0.5 },
        });
    let inspection = crate::authoring::inspect_studio_cubic_bezier(&spec).unwrap();
    entity.dimensions = inspection.dimensions;
    entity.cubic_bezier = Some(inspection.cubic_bezier);

    let mut command = base.clone();
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:circle",
        "pen-stroke-join",
        StudioCreationOperationKind::StrokeJoin {
            join: poietra_scene_ir::StrokeJoinV1::Bevel,
        },
    ));
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!(projection.mutations.iter().any(|mutation| matches!(
        mutation.kind,
        StudioCreationProjectedMutationKind::StrokeJoin {
            value: poietra_scene_ir::StrokeJoinV1::Bevel,
        }
    )));

    let result = EngineSessionV1::new(bundle.clone())
        .unwrap()
        .apply_studio_creation_edit(command)
        .unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:circle")
        .unwrap();
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            stroke: Some(stroke),
            ..
        } if stroke.join == poietra_scene_ir::StrokeJoinV1::Bevel
            && (stroke.miter_limit - 10.0).abs() < 1.0e-12
    ));

    let mut single_segment = studio_closed_cubic_bezier_creation_command(&bundle, false);
    single_segment
        .programs
        .push(studio_created_appearance_edit_input(
            0.5,
            "tx:create/entity:circle",
            "single-pen-stroke-join",
            StudioCreationOperationKind::StrokeJoin {
                join: poietra_scene_ir::StrokeJoinV1::Bevel,
            },
        ));
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &single_segment.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut line = studio_path_creation_command(
        &bundle,
        "line",
        StudioAuthoringEntityKind::Line,
        StudioAuthoringDimensions::default(),
    );
    line.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:line",
        "line-stroke-join",
        StudioCreationOperationKind::StrokeJoin {
            join: poietra_scene_ir::StrokeJoinV1::Bevel,
        },
    ));
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &line.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    base.programs.push(studio_created_appearance_edit_input(
        0.75,
        "tx:create/entity:circle",
        "late-pen-stroke-join",
        StudioCreationOperationKind::StrokeJoin {
            join: poietra_scene_ir::StrokeJoinV1::Miter,
        },
    ));
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &base.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
}

fn studio_path_morph_program(
    entity_id: &str,
    from_path: CubicSubpathV1,
    to_path: CubicSubpathV1,
) -> StudioCreationEditInput {
    let operation_id = "morph-pen-path";
    StudioCreationEditInput {
        anchor_captured_playhead: 1.5,
        anchor_resolved_seconds: 1.5,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(1.5),
        },
        intent_count: 1,
        lowering_supported: false,
        operations: vec![StudioCreationOperation {
            depends_on: Vec::new(),
            entity_id: Some(entity_id.to_owned()),
            id: operation_id.to_owned(),
            interval: IntervalV1 {
                end: 2.0,
                start: 1.5,
            },
            kind: StudioCreationOperationKind::PathMorph {
                easing: StudioPropertyEasing::Smooth,
                from_path,
                to_path,
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Sequence,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Sequence,
        schedule_order: vec![operation_id.to_owned()],
        transaction_id: "morph-pen-path".to_owned(),
    }
}

#[test]
fn normalized_closed_cubic_bezier_keeps_fill_and_rejects_draw() {
    let bundle = static_imported_bundle();
    let draw_command = studio_closed_cubic_bezier_creation_command(&bundle, true);

    let mut draw_session = EngineSessionV1::new(bundle.clone()).unwrap();
    assert!(matches!(
        draw_session.apply_studio_creation_edit(draw_command),
        Err(ApplyStudioCreationEditError::Create(
            CreateSceneEntitiesError::InvalidAppearanceEdit
        ))
    ));

    let command = studio_closed_cubic_bezier_creation_command(&bundle, false);
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(
        result.creation_projection.as_ref().unwrap().entities[0]
            .fill_color
            .as_deref(),
        Some("#22c55e")
    );
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:circle")
        .unwrap();
    assert!(matches!(
        &created.geometry,
        SceneGeometryV1::CubicPath { path }
            if path.subpaths.len() == 1 && path.subpaths[0].closed
    ));
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            fill: Some(FillStyleV1 {
                color: RgbaColorV1 { alpha, blue, green, red },
                rule: FillRuleV1::NonZero,
                ..
            }),
            stroke: Some(_),
            ..
        } if (*alpha - 1.0).abs() < 1.0e-12
            && (*red - 34.0 / 255.0).abs() < 1.0e-12
            && (*green - 197.0 / 255.0).abs() < 1.0e-12
            && (*blue - 94.0 / 255.0).abs() < 1.0e-12
    ));
}

#[test]
fn normalized_pen_path_morph_uses_the_existing_channel_and_preserves_appearance() {
    let bundle = static_imported_bundle();
    let mut command = studio_closed_cubic_bezier_creation_command(&bundle, false);
    let StudioCreationOperationKind::Create { entity } = &command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    let entity_id = entity.id.clone();
    let curve = normalize_studio_cubic_bezier(entity.cubic_bezier.as_ref().unwrap()).unwrap();
    let from_path = curve.path.subpaths[0].clone();
    let mut to_path = from_path.clone();
    to_path.segments[0].control1.y -= 0.75;
    to_path.segments[0].control2.x -= 0.5;
    command.programs.push(studio_path_morph_program(
        &entity_id,
        from_path.clone(),
        to_path.clone(),
    ));

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    let projected = projection
        .mutations
        .iter()
        .find(|mutation| {
            matches!(
                mutation.kind,
                StudioCreationProjectedMutationKind::PathMorph { .. }
            )
        })
        .unwrap();
    assert!(matches!(
        &projected.kind,
        StudioCreationProjectedMutationKind::PathMorph {
            easing: EasingV1::ManimSmooth {},
            from_path: projected_from,
            to_path: projected_to,
        } if projected_from == &from_path && projected_to == &to_path
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|candidate| candidate.id == entity_id)
        .unwrap();
    assert!(matches!(
        &created.geometry,
        SceneGeometryV1::CubicPath { path } if path.subpaths == [from_path.clone()]
    ));
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            fill: Some(FillStyleV1 {
                color: RgbaColorV1 { alpha, blue, green, red },
                rule: FillRuleV1::NonZero,
                ..
            }),
            stroke: Some(_),
            ..
        } if (*alpha - 1.0).abs() < 1.0e-12
            && (*red - 34.0 / 255.0).abs() < 1.0e-12
            && (*green - 197.0 / 255.0).abs() < 1.0e-12
            && (*blue - 94.0 / 255.0).abs() < 1.0e-12
    ));
    let keyframes = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::PathMorph {
                entity_id: target_id,
                keyframes,
                ..
            } if target_id == &entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(keyframes.len(), 2);
    assert_eq!(keyframes[0].value.subpaths, [from_path]);
    assert_eq!(keyframes[1].value.subpaths, [to_path]);
    assert!(
        result
            .bundle
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::PathMorphAnimation)
    );

    let sample_path = |sample_time| {
        session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "studio-pen-path-morph",
                sample_time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap()
            .draws
            .into_iter()
            .find_map(|draw| match draw {
                poietra_scene_ir::RenderDrawV1::Path {
                    entity_id: target_id,
                    path,
                    ..
                } if target_id == entity_id => Some(path),
                _ => None,
            })
            .unwrap()
    };
    let start = sample_path(keyframes[0].at);
    let midpoint = sample_path(f64::midpoint(keyframes[0].at, keyframes[1].at));
    let end = sample_path(keyframes[1].at);
    assert_ne!(start, midpoint);
    assert_ne!(midpoint, end);
    assert_ne!(start, end);
}

#[test]
fn normalized_pen_path_morph_accepts_an_editable_noop_target() {
    let bundle = static_imported_bundle();
    let mut command = studio_closed_cubic_bezier_creation_command(&bundle, false);
    let StudioCreationOperationKind::Create { entity } = &command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    let entity_id = entity.id.clone();
    let path = normalize_studio_cubic_bezier(entity.cubic_bezier.as_ref().unwrap())
        .unwrap()
        .path
        .subpaths
        .remove(0);
    command
        .programs
        .push(studio_path_morph_program(&entity_id, path.clone(), path));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let keyframes = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::PathMorph {
                entity_id: target_id,
                keyframes,
                ..
            } if target_id == &entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(keyframes.len(), 2);
    assert_eq!(keyframes[0].value, keyframes[1].value);

    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "studio-pen-noop-path-morph",
            sample_time: f64::midpoint(keyframes[0].at, keyframes[1].at),
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(packet.draws.iter().any(|draw| matches!(
        draw,
        poietra_scene_ir::RenderDrawV1::Path {
            entity_id: target_id,
            ..
        } if target_id == &entity_id
    )));
}

#[test]
fn normalized_pen_path_morph_rejects_stale_or_mismatched_topology() {
    let bundle = static_imported_bundle();
    let mut command = studio_closed_cubic_bezier_creation_command(&bundle, false);
    let StudioCreationOperationKind::Create { entity } = &command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    let curve = normalize_studio_cubic_bezier(entity.cubic_bezier.as_ref().unwrap()).unwrap();
    let from_path = curve.path.subpaths[0].clone();
    let mut to_path = from_path.clone();
    to_path.segments[0].control1.y -= 0.75;
    command
        .programs
        .push(studio_path_morph_program(&entity.id, from_path, to_path));

    let rejects = |candidate: &ApplyStudioCreationEditCommand| {
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &candidate.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    };

    let mut stale = command.clone();
    let StudioCreationOperationKind::PathMorph { from_path, .. } =
        &mut stale.programs[1].operations[0].kind
    else {
        unreachable!();
    };
    from_path.start.x += 0.25;
    rejects(&stale);

    let mut changed_closure = command.clone();
    let StudioCreationOperationKind::PathMorph { to_path, .. } =
        &mut changed_closure.programs[1].operations[0].kind
    else {
        unreachable!();
    };
    to_path.closed = !to_path.closed;
    rejects(&changed_closure);

    let mut changed_segment_count = command.clone();
    let StudioCreationOperationKind::PathMorph { to_path, .. } =
        &mut changed_segment_count.programs[1].operations[0].kind
    else {
        unreachable!();
    };
    to_path.segments.clear();
    rejects(&changed_segment_count);

    let mut non_finite = command;
    let StudioCreationOperationKind::PathMorph { to_path, .. } =
        &mut non_finite.programs[1].operations[0].kind
    else {
        unreachable!();
    };
    to_path.segments[0].control1.x = f64::NAN;
    rejects(&non_finite);
}

#[test]
fn closed_cubic_bezier_fill_track_uses_the_canonical_baseline_and_appearance_channel() {
    let bundle = static_imported_bundle();
    let mut command = studio_closed_cubic_bezier_creation_command(&bundle, false);

    for (property, baseline) in [
        (StudioPaintColorProperty::StrokeColor, "#ffffff"),
        (StudioPaintColorProperty::FillColor, "#ffffff"),
    ] {
        let mut rejected = command.clone();
        add_creation_paint_color_segment(
            &mut rejected.programs[0],
            "tx:create/entity:circle",
            property,
            baseline,
            "#0000ff",
            1.5,
            2.0,
        );
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &rejected.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }

    add_creation_paint_color_segment(
        &mut command.programs[0],
        "tx:create/entity:circle",
        StudioPaintColorProperty::FillColor,
        "#22c55e",
        "#0000ff",
        1.5,
        2.0,
    );
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let appearance_keyframes = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::VectorAppearance {
                entity_id,
                keyframes,
                ..
            } if entity_id == "tx:create/entity:circle" => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert!(
        appearance_keyframes
            .iter()
            .zip([(34.0 / 255.0, 197.0 / 255.0, 94.0 / 255.0), (0.0, 0.0, 1.0),])
            .all(|(keyframe, (red, green, blue))| matches!(
                &keyframe.value,
                VectorAppearanceValueV1 {
                    fill: Some(fill),
                    stroke: Some(stroke),
                } if (fill.color.red - red).abs() < 1.0e-12
                    && (fill.color.green - green).abs() < 1.0e-12
                    && (fill.color.blue - blue).abs() < 1.0e-12
                    && (stroke.width_world - 0.04).abs() < 1.0e-12
                    && stroke.cap == poietra_scene_ir::StrokeCapV1::Round
            ))
    );
}

#[test]
fn normalized_creation_rejects_invalid_draw_admission() {
    let bundle = static_imported_bundle();
    let mut command = studio_draw_creation_command(&bundle);
    let draw_index = command.programs[0]
        .operations
        .iter()
        .position(|operation| matches!(operation.kind, StudioCreationOperationKind::DrawIn { .. }))
        .unwrap();

    let mut unsupported_easing = command.clone();
    let StudioCreationOperationKind::DrawIn { easing, .. } =
        &mut unsupported_easing.programs[0].operations[draw_index].kind
    else {
        unreachable!();
    };
    *easing = StudioPropertyEasing::EaseIn;
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &unsupported_easing.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let program = &mut command.programs[0];
    program.operations.push(StudioCreationOperation {
        depends_on: vec!["draw".to_owned()],
        entity_id: Some("tx:create/entity:circle".to_owned()),
        id: "fade-too".to_owned(),
        interval: IntervalV1 {
            end: 1.25,
            start: 0.5,
        },
        kind: StudioCreationOperationKind::FadeIn { persistent: true },
        origin: StudioAuthoringOrigin::StudioDefault,
    });
    program.schedule_order.push("fade-too".to_owned());
    program.schedule_edge_count = 6;
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &command.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one vertical-slice test pins the root hierarchy, both Write phases, and sampling"
)]
fn normalized_math_tex_write_projects_and_appends_one_retained_subtree() {
    let bundle = static_imported_bundle();
    let mut command = studio_math_tex_write_creation_command(&bundle);
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        "tx:create/entity:circle",
        "math-tex-write-fill",
        StudioCreationOperationKind::FillColor {
            color: Some("#22c55e".to_owned()),
        },
    ));
    assert!(
        (command.segmented_math_tex_outlines[0]
            .write_plan
            .outline_stroke_width
            - 2.0)
            .abs()
            < 1e-12
    );
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!((projection.projected_duration - (bundle.scene.duration + 1.0)).abs() < 1e-12);
    assert!(matches!(
        &projection.mutations[1],
        StudioCreationProjectedMutation {
            entity_id,
            interval: IntervalV1 { start: 0.5, end: 1.5 },
            kind: StudioCreationProjectedMutationKind::WriteIn {
                easing: EasingV1::Linear {},
                from: 0.0,
                to: 1.0,
            },
            operation_id,
            transaction_id,
        } if entity_id == "tx:create/entity:circle"
            && operation_id == "write"
            && transaction_id == "create"
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    let scene = &result.bundle.scene;
    assert!(matches!(scene.fidelity, FidelityV1::Approximate { .. }));
    for capability in [
        SceneCapabilityV1::CubicPathGeometry,
        SceneCapabilityV1::LogicalGroup,
        SceneCapabilityV1::PathTrimAnimation,
        SceneCapabilityV1::VectorAppearanceAnimation,
    ] {
        assert!(scene.required_capabilities.contains(&capability));
    }

    let root_id = "tx:create/entity:circle";
    let root = scene
        .entities
        .iter()
        .find(|entity| entity.id == root_id)
        .unwrap();
    assert!(matches!(root.geometry, SceneGeometryV1::Group {}));
    assert!(root.parent_id.is_none());
    assert!(root.transform.tx > 0.0);
    let children = scene
        .entities
        .iter()
        .filter(|entity| entity.parent_id.as_deref() == Some(root_id))
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 4);
    assert!(
        children
            .iter()
            .all(|child| child.transform == AffineTransformV1::identity())
    );

    let outline_zero = format!("{root_id}/write/fragment-0000/outline");
    let fill_zero = format!("{root_id}/write/fragment-0000/fill");
    let outline_one = format!("{root_id}/write/fragment-0001/outline");
    let fill_one = format!("{root_id}/write/fragment-0001/fill");
    let outline_zero_entity = scene
        .entities
        .iter()
        .find(|entity| entity.id == outline_zero)
        .unwrap();
    let SceneAppearanceV1::Vector {
        stroke: Some(outline_stroke),
        ..
    } = &outline_zero_entity.appearance
    else {
        panic!("Write outline must retain its stroke appearance");
    };
    assert!((outline_stroke.width_world - 0.02).abs() < 1e-12);
    assert!((outline_stroke.color.green - 197.0 / 255.0).abs() < 1e-12);
    let path_trim_channels = scene
        .animation_channels
        .iter()
        .filter_map(|channel| match channel {
            AnimationChannelV1::PathTrim {
                entity_id,
                keyframes,
                ..
            } => Some((entity_id.as_str(), keyframes)),
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    let appearance_channels = scene
        .animation_channels
        .iter()
        .filter_map(|channel| match channel {
            AnimationChannelV1::VectorAppearance {
                entity_id,
                keyframes,
                ..
            } => Some((entity_id.as_str(), keyframes)),
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    assert_eq!(path_trim_channels.len(), 2);
    assert_eq!(appearance_channels.len(), 2);
    let outline_zero_keyframes = path_trim_channels[outline_zero.as_str()];
    assert!((outline_zero_keyframes[0].at - 0.5).abs() < 1e-12);
    assert!((outline_zero_keyframes[1].at - (0.5 + 0.5 / 1.2)).abs() < 1e-12);
    let fill_one_keyframes = appearance_channels[fill_one.as_str()];
    assert!((fill_one_keyframes[0].at - (0.5 + 0.7 / 1.2)).abs() < 1e-12);
    assert!((fill_one_keyframes[1].at - 1.5).abs() < 1e-12);
    assert!(matches!(
        &fill_one_keyframes[1].value,
        VectorAppearanceValueV1 {
            fill: Some(fill),
            stroke: Some(stroke),
            ..
        } if (fill.color.green - 197.0 / 255.0).abs() < 1e-12
            && (stroke.color.green - 197.0 / 255.0).abs() < 1e-12
            && stroke.color.alpha.to_bits() == 1.0_f64.to_bits()
            && stroke.width_world.to_bits() == 0.0_f64.to_bits()
    ));

    let sample = |session: &EngineSessionV1, sample_time| {
        session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "studio-math-tex-write",
                sample_time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap()
    };
    let early = sample(&session, 0.6);
    assert!(
        early
            .draws
            .iter()
            .any(|draw| draw.entity_id() == outline_zero)
    );
    assert!(early.draws.iter().all(|draw| {
        ![fill_zero.as_str(), outline_one.as_str(), fill_one.as_str()].contains(&draw.entity_id())
    }));
    let frame_grid_boundary = sample(&session, 40.0 / 30.0);
    assert!(frame_grid_boundary.draws.iter().any(|draw| {
        matches!(
            draw,
            poietra_scene_ir::RenderDrawV1::Path {
                entity_id,
                stroke: None,
                ..
            } if entity_id == &fill_zero
        )
    }));
    let complete = sample(&session, 1.5);
    assert!(
        complete
            .draws
            .iter()
            .any(|draw| draw.entity_id() == fill_zero)
    );
    assert!(
        complete
            .draws
            .iter()
            .any(|draw| draw.entity_id() == fill_one)
    );
    assert!(complete.draws.iter().any(|draw| matches!(
        draw,
        poietra_scene_ir::RenderDrawV1::Path {
            entity_id,
            fill: Some(fill),
            ..
        } if entity_id == &fill_one
            && (fill.color.green - 197.0 / 255.0).abs() < 1e-12
    )));
    assert!(complete.draws.iter().all(|draw| {
        ![root_id, outline_zero.as_str(), outline_one.as_str()].contains(&draw.entity_id())
    }));
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one vertical slice pins projection, Write handoff, morph topology, and evaluator samples"
)]
fn normalized_math_tex_write_switches_to_one_root_owned_a_b_a_path_morph() {
    let bundle = static_imported_bundle();
    let base_duration = bundle.scene.duration;
    let mut command = studio_math_tex_write_transform_chain_command(&bundle);
    let root_id = "tx:create/entity:circle";
    let middle_id = "tx:transform-middle/entity:formula";
    let restored_id = "tx:transform-restored/entity:formula";
    command.programs.insert(
        1,
        studio_created_appearance_edit_input(
            0.5,
            root_id,
            "math-tex-transform-fill",
            StudioCreationOperationKind::FillColor {
                color: Some("#22c55e".to_owned()),
            },
        ),
    );

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(projection.entities.len(), 1);
    assert_eq!(projection.entities[0].entity_id, root_id);
    assert!((projection.projected_duration - (base_duration + 2.0)).abs() < 1e-12);
    let transforms = projection
        .mutations
        .iter()
        .filter(|mutation| {
            matches!(
                mutation.kind,
                StudioCreationProjectedMutationKind::MathTexTransform { .. }
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(transforms.len(), 2);
    assert!(
        transforms
            .iter()
            .all(|mutation| mutation.entity_id == root_id)
    );
    assert!(matches!(
        &transforms[0].kind,
        StudioCreationProjectedMutationKind::MathTexTransform {
            source_entity_id,
            target_entity_id,
            ..
        } if source_entity_id == root_id && target_entity_id == middle_id
    ));
    assert!(matches!(
        &transforms[1].kind,
        StudioCreationProjectedMutationKind::MathTexTransform {
            source_entity_id,
            target_entity_id,
            ..
        } if source_entity_id == middle_id && target_entity_id == restored_id
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let scene = &result.bundle.scene;
    assert!(
        !scene
            .entities
            .iter()
            .any(|entity| { entity.id == middle_id || entity.id == restored_id })
    );
    let morph_id = format!("{root_id}/math-tex-morph");
    let morph_entity = scene
        .entities
        .iter()
        .find(|entity| entity.id == morph_id)
        .unwrap();
    assert_eq!(morph_entity.parent_id.as_deref(), Some(root_id));
    assert!((morph_entity.lifetimes[0].start - 1.5).abs() < 1e-12);
    assert!(matches!(
        &morph_entity.appearance,
        SceneAppearanceV1::Vector { fill: Some(fill), stroke: None, .. }
            if (fill.color.green - 197.0 / 255.0).abs() < 1e-12
                && (fill.color.alpha - 1.0).abs() < 1e-12
    ));
    assert!(
        scene
            .entities
            .iter()
            .filter(|entity| {
                entity.parent_id.as_deref() == Some(root_id) && entity.id.ends_with("/fill")
            })
            .all(|entity| (entity.lifetimes[0].end - 1.5).abs() < 1e-12)
    );
    assert!(
        scene
            .required_capabilities
            .contains(&SceneCapabilityV1::PathMorphAnimation)
    );
    let keyframes = scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::PathMorph {
                entity_id,
                keyframes,
                ..
            } if entity_id == &morph_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(keyframes.len(), 3);
    assert_eq!(
        keyframes
            .iter()
            .map(|keyframe| keyframe.at)
            .collect::<Vec<_>>(),
        [1.5, 2.0, 2.5]
    );
    assert_eq!(keyframes[0].value, keyframes[2].value);
    assert_ne!(keyframes[0].value, keyframes[1].value);
    assert!(keyframes.iter().all(|keyframe| {
        keyframe.value.subpaths.len() == 2
            && keyframe.value.subpaths[0].segments.len() == 4
            && keyframe.value.subpaths[1].segments.len() == 3
    }));

    let sample_path = |sample_time| {
        session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "studio-math-tex-write-transform",
                sample_time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap()
            .draws
            .into_iter()
            .find_map(|draw| match draw {
                poietra_scene_ir::RenderDrawV1::Path {
                    entity_id, path, ..
                } if entity_id == morph_id => Some(path),
                _ => None,
            })
            .unwrap()
    };
    let start = sample_path(1.5);
    let first_midpoint = sample_path(1.75);
    let middle = sample_path(2.0);
    let second_midpoint = sample_path(2.25);
    let restored = sample_path(2.5);
    assert_eq!(start, keyframes[0].value);
    assert_eq!(middle, keyframes[1].value);
    assert_eq!(restored, start);
    assert_ne!(first_midpoint, start);
    assert_ne!(first_midpoint, middle);
    assert_ne!(second_midpoint, middle);
    assert_ne!(second_midpoint, restored);
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one vertical slice pins root identity, shape-state admission, topology, and samples"
)]
fn normalized_closed_primitive_chain_uses_one_root_owned_path_morph() {
    let bundle = static_imported_bundle();
    let base_duration = bundle.scene.duration;
    let command = studio_shape_transform_chain_command(&bundle);
    let root_id = "tx:create/entity:shape";

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(projection.entities.len(), 1);
    assert_eq!(projection.entities[0].entity_id, root_id);
    assert!((projection.projected_duration - (base_duration + 2.9)).abs() < 1e-12);
    let transforms = projection
        .mutations
        .iter()
        .filter(|mutation| {
            matches!(
                mutation.kind,
                StudioCreationProjectedMutationKind::ShapeTransform { .. }
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(transforms.len(), 5);
    assert!(
        transforms
            .iter()
            .all(|mutation| mutation.entity_id == root_id)
    );
    assert!(matches!(
        &transforms[0].kind,
        StudioCreationProjectedMutationKind::ShapeTransform {
            easing: EasingV1::ManimSmooth {},
            from_shape: StudioAuthoringEntityKind::Rectangle,
            to_shape: StudioAuthoringEntityKind::Ellipse,
            ..
        }
    ));
    assert!(matches!(
        &transforms[1].kind,
        StudioCreationProjectedMutationKind::ShapeTransform {
            from_shape: StudioAuthoringEntityKind::Ellipse,
            to_shape: StudioAuthoringEntityKind::RegularPolygon,
            to_dimensions,
            ..
        } if to_dimensions.sides == Some(3)
    ));
    assert!(matches!(
        &transforms[2].kind,
        StudioCreationProjectedMutationKind::ShapeTransform {
            from_shape: StudioAuthoringEntityKind::RegularPolygon,
            from_dimensions,
            to_shape: StudioAuthoringEntityKind::RegularPolygon,
            to_dimensions,
            ..
        } if from_dimensions.sides == Some(3) && to_dimensions.sides == Some(6)
    ));
    assert!(matches!(
        &transforms[3].kind,
        StudioCreationProjectedMutationKind::ShapeTransform {
            from_shape: StudioAuthoringEntityKind::RegularPolygon,
            to_shape: StudioAuthoringEntityKind::Circle,
            ..
        }
    ));
    assert!(matches!(
        &transforms[4].kind,
        StudioCreationProjectedMutationKind::ShapeTransform {
            from_shape: StudioAuthoringEntityKind::Circle,
            to_shape: StudioAuthoringEntityKind::Rectangle,
            ..
        }
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    let scene = &result.bundle.scene;
    assert_eq!(
        scene
            .entities
            .iter()
            .filter(|entity| entity.id == root_id)
            .count(),
        1
    );
    let root = scene
        .entities
        .iter()
        .find(|entity| entity.id == root_id)
        .unwrap();
    assert!(root.parent_id.is_none());
    assert!(matches!(root.geometry, SceneGeometryV1::CubicPath { .. }));
    assert!(
        scene
            .required_capabilities
            .contains(&SceneCapabilityV1::PathMorphAnimation)
    );
    let keyframes = scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::PathMorph {
                entity_id,
                keyframes,
                ..
            } if entity_id == root_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(keyframes.len(), 6);
    assert!(
        keyframes
            .iter()
            .zip([1.3, 1.8, 2.3, 2.8, 3.3, 3.8])
            .all(|(keyframe, expected)| (keyframe.at - expected).abs() < 1e-12)
    );
    assert_eq!(keyframes[0].value, keyframes[5].value);
    assert!(
        keyframes
            .windows(2)
            .all(|pair| pair[0].value != pair[1].value)
    );
    assert!(keyframes.iter().all(|keyframe| {
        keyframe.value.subpaths.len() == 1
            && keyframe.value.subpaths[0].closed
            && keyframe.value.subpaths[0].segments.len() == 6
    }));

    let sample_path = |sample_time| {
        session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "studio-shape-transform",
                sample_time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap()
            .draws
            .into_iter()
            .find_map(|draw| match draw {
                poietra_scene_ir::RenderDrawV1::Path {
                    entity_id, path, ..
                } if entity_id == root_id => Some(path),
                _ => None,
            })
            .unwrap()
    };
    let start = sample_path(keyframes[0].at);
    let first_midpoint = sample_path((keyframes[0].at + keyframes[1].at) / 2.0);
    let ellipse = sample_path(keyframes[1].at);
    let triangle = sample_path(keyframes[2].at);
    let polygon = sample_path(keyframes[3].at);
    let circle = sample_path(keyframes[4].at);
    let restored = sample_path(keyframes[5].at);
    assert_eq!(start, keyframes[0].value);
    assert_eq!(ellipse, keyframes[1].value);
    assert_eq!(triangle, keyframes[2].value);
    assert_eq!(polygon, keyframes[3].value);
    assert_eq!(circle, keyframes[4].value);
    assert_eq!(restored, start);
    assert_ne!(first_midpoint, start);
    assert_ne!(first_midpoint, ellipse);

    let triangle_bundle = static_imported_bundle();
    let mut triangle_command = studio_shape_transform_chain_command(&triangle_bundle);
    triangle_command.programs.truncate(1);
    let StudioCreationOperationKind::Create { entity } =
        &mut triangle_command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    let triangle_dimensions = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: None,
        radius: Some(1.25),
        sides: Some(3),
        width: None,
    };
    entity.kind = StudioAuthoringEntityKind::RegularPolygon;
    entity.dimensions = triangle_dimensions;
    triangle_command
        .programs
        .push(studio_shape_transform_program(
            "triangle-to-ellipse",
            "triangle-to-ellipse",
            root_id,
            StudioAuthoringEntityKind::RegularPolygon,
            triangle_dimensions,
            StudioAuthoringEntityKind::Ellipse,
            StudioAuthoringDimensions {
                angles: None,
                coordinate_system: None,
                height: Some(1.5),
                radius: None,
                sides: None,
                width: Some(3.0),
            },
        ));
    let mut triangle_session = EngineSessionV1::new(triangle_bundle).unwrap();
    let triangle_scene = triangle_session
        .apply_studio_creation_edit(triangle_command)
        .unwrap()
        .bundle
        .scene;
    let initial_path = triangle_scene
        .entities
        .iter()
        .find_map(|entity| match &entity.geometry {
            SceneGeometryV1::CubicPath { path } if entity.id == root_id => Some(path),
            _ => None,
        })
        .unwrap();
    let first_morph_path = triangle_scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::PathMorph {
                entity_id,
                keyframes,
                ..
            } if entity_id == root_id => keyframes.first().map(|keyframe| &keyframe.value),
            _ => None,
        })
        .unwrap();
    assert_eq!(initial_path, first_morph_path);
    assert_eq!(initial_path.subpaths[0].segments.len(), 4);
}

#[test]
fn normalized_shape_transform_rejects_broken_state_or_unsupported_kind() {
    let bundle = static_imported_bundle();
    let command = studio_shape_transform_chain_command(&bundle);

    let mut broken_state = command.clone();
    let StudioCreationOperationKind::TransformShape {
        from_dimensions, ..
    } = &mut broken_state.programs[2].operations[0].kind
    else {
        unreachable!();
    };
    *from_dimensions = StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: None,
        radius: Some(2.0),
        sides: None,
        width: None,
    };
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &broken_state.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut unsupported_kind = command;
    let StudioCreationOperationKind::TransformShape { to_shape, .. } =
        &mut unsupported_kind.programs[1].operations[0].kind
    else {
        unreachable!();
    };
    *to_shape = StudioAuthoringEntityKind::Text;
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &unsupported_kind.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    for sides in [2, 33] {
        let mut invalid_polygon = studio_shape_transform_chain_command(&bundle);
        let StudioCreationOperationKind::TransformShape { to_dimensions, .. } =
            &mut invalid_polygon.programs[2].operations[0].kind
        else {
            unreachable!();
        };
        to_dimensions.sides = Some(sides);
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &invalid_polygon.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }
}

#[test]
fn normalized_shape_transform_allows_a_later_resize_on_the_logical_root() {
    let bundle = static_imported_bundle();
    let mut command = studio_shape_transform_chain_command(&bundle);
    let root_id = "tx:create/entity:shape";
    command.programs.push(StudioCreationEditInput {
        anchor_captured_playhead: 1.4,
        anchor_resolved_seconds: 1.4,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(1.4),
        },
        intent_count: 1,
        lowering_supported: false,
        operations: vec![StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(root_id.to_owned()),
            id: "resize-after-shape-transform".to_owned(),
            interval: IntervalV1 {
                end: 1.4,
                start: 1.4,
            },
            kind: StudioCreationOperationKind::Resize {
                from_dimensions: StudioAuthoringDimensions {
                    angles: None,
                    coordinate_system: None,
                    height: Some(2.0),
                    radius: None,
                    sides: None,
                    width: Some(4.0),
                },
                from_position: PointV1 { x: 320.0, y: 180.0 },
                from_scale: 1.0,
                shape: StudioAuthoringEntityKind::Rectangle,
                to_dimensions: StudioAuthoringDimensions {
                    angles: None,
                    coordinate_system: None,
                    height: Some(3.0),
                    radius: None,
                    sides: None,
                    width: Some(6.0),
                },
                to_position: PointV1 { x: 360.0, y: 180.0 },
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        }],
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Sequence,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Sequence,
        schedule_order: vec!["resize-after-shape-transform".to_owned()],
        transaction_id: "resize-after-shape-transform".to_owned(),
    });

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert!(projection.mutations.iter().any(|mutation| {
        mutation.entity_id == root_id
            && matches!(
                mutation.kind,
                StudioCreationProjectedMutationKind::Resize { .. }
            )
    }));
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let scene = session
        .apply_studio_creation_edit(command)
        .unwrap()
        .bundle
        .scene;
    assert!(scene.animation_channels.iter().any(|channel| {
        matches!(
            channel,
            AnimationChannelV1::PathMorph { entity_id, .. } if entity_id == root_id
        )
    }));
    let transform = scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::AffineTransform {
                entity_id,
                keyframes,
                ..
            } if entity_id == root_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert!((transform[0].value.m11 - 1.5).abs() < 1e-12);
    assert!((transform[0].value.m22 - 1.5).abs() < 1e-12);
}

#[test]
fn normalized_math_tex_transform_chain_rejects_non_replacement_or_broken_identity() {
    let bundle = static_imported_bundle();
    let command = studio_math_tex_write_transform_chain_command(&bundle);

    let mut matching = command.clone();
    let StudioCreationOperationKind::TransformContent { strategy, .. } =
        &mut matching.programs[1].operations[0].kind
    else {
        unreachable!();
    };
    *strategy = StudioMathTexTransformStrategy::TransformMatchingTex;
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &matching.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut broken_chain = command;
    let StudioCreationOperationKind::TransformContent {
        source_entity_id, ..
    } = &mut broken_chain.programs[2].operations[0].kind
    else {
        unreachable!();
    };
    *source_entity_id = "tx:create/entity:circle".to_owned();
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &broken_chain.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
}

#[test]
fn normalized_math_tex_transform_topology_failure_is_atomic() {
    let bundle = static_imported_bundle();
    let expected_scene = bundle.scene.clone();
    let expected_assets = bundle.assets.clone();
    let mut command = studio_math_tex_write_transform_chain_command(&bundle);
    command.math_tex_outlines[1].path.subpaths[0].closed = false;
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &expected_scene);
    assert_eq!(session.assets(), &expected_assets);
    assert_eq!(session.retained_index_stats().build_count, 1);
}

#[test]
fn normalized_math_tex_write_root_can_join_a_logical_group() {
    let bundle = static_imported_bundle();
    let mut command = studio_math_tex_write_creation_command(&bundle);
    let second = studio_creation_command(&bundle);
    command
        .programs
        .push(second_group_resize_creation(&second.programs[0]));
    let root_id = "tx:create/entity:circle";
    let sibling_id = "tx:second/entity:rectangle";
    let group_id = "tx:write-group/entity:group";
    command.programs.push(studio_hierarchy_edit_input(
        "write-group",
        1.5,
        StudioCreationOperationKind::Group {
            child_entity_ids: vec![root_id.to_owned(), sibling_id.to_owned()],
            group_id: group_id.to_owned(),
        },
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let scene = &result.bundle.scene;
    assert!(
        scene.entities.iter().any(|entity| {
            entity.id == root_id && entity.parent_id.as_deref() == Some(group_id)
        })
    );
    assert!(scene.entities.iter().any(|entity| {
        entity.id == sibling_id && entity.parent_id.as_deref() == Some(group_id)
    }));
    assert!(scene.entities.iter().any(|entity| {
        entity.id == format!("{root_id}/write/fragment-0000/fill")
            && entity.parent_id.as_deref() == Some(root_id)
    }));
}

#[test]
fn normalized_math_tex_write_rejects_wrong_artifacts_and_conflicting_entrances() {
    let bundle = static_imported_bundle();
    let command = studio_math_tex_write_creation_command(&bundle);

    let mut wrong_source = command.clone();
    wrong_source.segmented_math_tex_outlines[0].source = "E=mc^2".to_owned();
    let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
    assert!(matches!(
        session.apply_studio_creation_edit(wrong_source),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &bundle.scene);

    let mut wrong_order = command.clone();
    wrong_order.segmented_math_tex_outlines[0].fragments[1].order = 0;
    let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
    assert!(matches!(
        session.apply_studio_creation_edit(wrong_order),
        Err(ApplyStudioCreationEditError::Create(
            CreateSceneEntitiesError::InvalidAppearanceEdit
        ))
    ));
    assert_eq!(session.scene(), &bundle.scene);

    let mut unsupported_smooth = command.clone();
    let write = unsupported_smooth.programs[0]
        .operations
        .iter_mut()
        .find(|operation| matches!(operation.kind, StudioCreationOperationKind::WriteIn { .. }))
        .unwrap();
    write.kind = StudioCreationOperationKind::WriteIn {
        easing: StudioPropertyEasing::Smooth,
    };
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &unsupported_smooth.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let corruptions: [fn(&mut ApplyStudioCreationEditCommand); 4] = [
        |command: &mut ApplyStudioCreationEditCommand| {
            command.segmented_math_tex_outlines[0].fragments[0]
                .source_correlation
                .source_end_byte -= 1;
        },
        |command: &mut ApplyStudioCreationEditCommand| {
            command.segmented_math_tex_outlines[0].fragments[0]
                .path
                .subpaths[0]
                .closed = false;
        },
        |command: &mut ApplyStudioCreationEditCommand| {
            command.segmented_math_tex_outlines[0].fragments[0].outline_entity_id =
                "fragment-0000:wrong".to_owned();
        },
        |command: &mut ApplyStudioCreationEditCommand| {
            command.segmented_math_tex_outlines[0].fragments[0]
                .paint
                .red = 0.5;
        },
    ];
    for corrupt in corruptions {
        let mut malformed = command.clone();
        corrupt(&mut malformed);
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        assert!(matches!(
            session.apply_studio_creation_edit(malformed),
            Err(ApplyStudioCreationEditError::Create(
                CreateSceneEntitiesError::InvalidAppearanceEdit
            ))
        ));
        assert_eq!(session.scene(), &bundle.scene);
    }

    for conflicting_kind in [
        StudioCreationOperationKind::FadeIn { persistent: true },
        StudioCreationOperationKind::DrawIn {
            easing: StudioPropertyEasing::Linear,
            from: Some(0.0),
            to: Some(1.0),
        },
    ] {
        let mut conflict = command.clone();
        let program = &mut conflict.programs[0];
        program.operations.push(StudioCreationOperation {
            depends_on: vec!["write".to_owned()],
            entity_id: Some("tx:create/entity:circle".to_owned()),
            id: "conflicting-entrance".to_owned(),
            interval: IntervalV1 {
                end: 1.5,
                start: 0.5,
            },
            kind: conflicting_kind,
            origin: StudioAuthoringOrigin::StudioDefault,
        });
        program
            .schedule_order
            .push("conflicting-entrance".to_owned());
        program.schedule_edge_count = 6;
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &conflict.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }
}

#[test]
fn normalized_creation_projects_applies_and_animates_an_arrow() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let program = &mut command.programs[0];
    for operation in &mut program.operations {
        if operation.entity_id.as_deref() == Some("tx:create/entity:circle") {
            operation.entity_id = Some("tx:create/entity:arrow".to_owned());
        }
    }
    let StudioCreationOperationKind::Create { entity } = &mut program.operations[0].kind else {
        panic!("creation fixture must start with CreateEntity");
    };
    entity.id = "tx:create/entity:arrow".to_owned();
    entity.kind = StudioAuthoringEntityKind::Arrow;
    entity.dimensions = StudioAuthoringDimensions::default();
    let mut motion = studio_created_motion_edit_input(vec!["tx:create/entity:arrow".to_owned()]);
    let StudioCreationOperationKind::CreateMotion { orient_to_path, .. } =
        &mut motion.operations[0].kind
    else {
        unreachable!();
    };
    *orient_to_path = true;
    command.programs.push(motion);

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(
        projection.entities[0].kind,
        StudioAuthoringEntityKind::Arrow
    );
    assert_eq!(projection.motions.len(), 1);
    assert!(projection.motions[0].orient_to_path);

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:arrow")
        .unwrap();
    let SceneGeometryV1::CubicPath { path } = &created.geometry else {
        panic!("Studio Arrow must materialize one cubic-path entity");
    };
    assert_eq!(path.subpaths.len(), 1);
    assert!(path.subpaths[0].closed);
    assert_eq!(path.subpaths[0].start, PointV1 { x: -1.0, y: -0.02 });
    assert_eq!(path.subpaths[0].segments[2].end, PointV1 { x: 1.0, y: 0.0 });
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            fill: Some(_),
            stroke: Some(_),
            ..
        }
    ));
    assert!(
        result
            .bundle
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::CubicPathGeometry)
    );
    assert!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| {
                    matches!(
                        channel,
                        AnimationChannelV1::MotionPath {
                            entity_id,
                            orient_to_path: true,
                            parameterization: Some(
                                poietra_scene_ir::MotionPathParameterizationV1::ManimPointFromProportionV1
                            ),
                            ..
                        } if entity_id == "tx:create/entity:arrow"
                    )
                })
        );
}

#[test]
fn normalized_creation_rejects_stationary_path_orientation() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let mut motion = studio_created_motion_edit_input(vec![entity_id.to_owned()]);
    let StudioCreationOperationKind::CreateMotion {
        control_offset,
        delta,
        orient_to_path,
        ..
    } = &mut motion.operations[0].kind
    else {
        unreachable!();
    };
    *control_offset = PointV1 { x: 0.0, y: 0.0 };
    *delta = PointV1 { x: 0.0, y: 0.0 };
    *orient_to_path = true;
    command.programs.push(motion);

    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &command.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
}

#[test]
#[allow(
    clippy::float_cmp,
    reason = "exact authored intervals and endpoints verify the atomic creation motion"
)]
fn normalized_creation_applies_and_samples_a_later_motion() {
    let bundle = static_imported_bundle();
    let base_duration = bundle.scene.duration;
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    command
        .programs
        .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    assert!(result.static_root_projection.is_none());
    assert!(
        serde_json::to_value(&result)
            .unwrap()
            .get("staticRootProjection")
            .is_none()
    );
    let motion = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::MotionPath {
                entity_id: target,
                keyframes,
                path,
                ..
            } if target == entity_id => Some((keyframes, path)),
            _ => None,
        })
        .unwrap();

    assert_eq!(result.bundle.scene.duration, base_duration + 1.4);
    assert_eq!(
        motion
            .0
            .iter()
            .map(|keyframe| keyframe.at)
            .collect::<Vec<_>>(),
        vec![1.4, 2.4]
    );
    assert_eq!(motion.1.subpaths[0].start, PointV1 { x: 0.0, y: 0.0 });
    assert_eq!(
        motion.1.subpaths[0].segments[0].end,
        PointV1 { x: 6.0, y: 2.0 }
    );

    let sampled_position = |time| {
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "created-motion-sample",
                sample_time: time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        match packet
            .draws
            .iter()
            .find(|draw| draw.entity_id() == entity_id)
            .unwrap()
        {
            poietra_scene_ir::RenderDrawV1::Path { transform, .. } => PointV1 {
                x: transform.tx,
                y: transform.ty,
            },
            _ => panic!("created motion target must remain a path draw"),
        }
    };
    for (time, expected) in [
        (1.4, PointV1 { x: 0.0, y: 0.0 }),
        (1.9, PointV1 { x: 3.0, y: 3.0 }),
        (2.4, PointV1 { x: 6.0, y: 2.0 }),
    ] {
        let sampled = sampled_position(time);
        assert!((sampled.x - expected.x).abs() < 1e-10, "time={time}");
        assert!((sampled.y - expected.y).abs() < 1e-10, "time={time}");
    }
    assert_eq!(session.scene(), &result.bundle.scene);
    assert_eq!(session.retained_index_stats().build_count, 2);
}

#[test]
fn normalized_creation_rejects_a_later_mixed_motion_atomically() {
    let bundle = static_imported_bundle();
    let expected_scene = bundle.scene.clone();
    let expected_assets = bundle.assets.clone();
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    command.programs.push(studio_created_motion_edit_input(vec![
        "tx:create/entity:circle".to_owned(),
        "later".to_owned(),
    ]));
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &expected_scene);
    assert_eq!(session.assets(), &expected_assets);
    assert_eq!(session.retained_index_stats().build_count, 1);
}

#[test]
#[allow(
    clippy::float_cmp,
    reason = "the normalized batch produces exact stored timeline and transform values"
)]
fn normalized_arrow_creation_composes_motion_then_scale_and_remove() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        panic!("creation fixture must start with CreateEntity");
    };
    entity.kind = StudioAuthoringEntityKind::Arrow;
    entity.dimensions = StudioAuthoringDimensions::default();
    command.programs[1].operations[0].kind = StudioCreationOperationKind::UniformScale {
        control_present: false,
        from: Some(1.0),
        relative_factor: Some(1.5),
        to: Some(1.5),
    };
    let mut motion = studio_created_motion_edit_input(vec![entity_id.to_owned()]);
    motion.anchor_captured_playhead = 0.75;
    motion.anchor_resolved_seconds = 0.75;
    motion.anchor_source = SceneEditAnchorSource::Playhead {
        reference_seconds: Some(0.75),
    };
    motion.operations[0].interval = IntervalV1 {
        end: 1.75,
        start: 0.75,
    };
    command.programs.insert(1, motion);
    command
        .programs
        .push(studio_persistent_remove_edit_input(entity_id, 1.8, 2.0));
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    assert!(result.motion_projection.is_none());
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    assert_eq!(projection.motions.len(), 1);
    assert!(projection.mutations.iter().any(|mutation| matches!(
        mutation.kind,
        StudioCreationProjectedMutationKind::UniformScale {
            from: 1.0,
            to: 1.5,
            ..
        }
    )));
    assert_eq!(projection.removals.len(), 1);
    assert_eq!(
        result.persistent_remove_projection.removals,
        projection.removals
    );
    assert_eq!(result.bundle.scene.duration, 3.4);
    assert_eq!(result.persistent_remove_projection.removals.len(), 1);
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::MotionPath {
                        entity_id: target,
                        keyframes,
                        ..
                    } if target == entity_id
                        && keyframes[0].at == 1.15
                        && keyframes[1].at == 2.15
                )
            })
    );
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::AffineTransform {
                        entity_id: target,
                        keyframes,
                        ..
                    } if target == entity_id
                        && keyframes[0].at == 2.25
                        && keyframes[0].value.m11 == 1.5
                        && keyframes[0].value.m22 == 1.5
                )
            })
    );
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[test]
#[allow(
    clippy::float_cmp,
    reason = "the normalized command produces exact stored authoring values"
)]
fn normalized_creation_owns_timeline_and_followup_resize_semantics() {
    let bundle = static_imported_bundle();
    let base_duration = bundle.scene.duration;
    let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

    let result = session
        .apply_studio_creation_edit(studio_creation_command(&bundle))
        .unwrap();
    let result = result.bundle;

    assert_eq!(result.scene.duration, base_duration + 0.4);
    let created = result
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:circle")
        .unwrap();
    assert!(matches!(
        created.geometry,
        SceneGeometryV1::Circle { radius: 1.0, .. }
    ));
    assert_eq!(
        (
            created.transform.m11,
            created.transform.tx,
            created.transform.ty
        ),
        (1.0, 0.0, 0.0)
    );
    assert!(
        result
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::AffineTransform { entity_id, keyframes, .. }
                    if entity_id == "tx:create/entity:circle"
                        && keyframes[0].at == 1.25
                        && keyframes[0].value.m11 == 2.0
                && keyframes[0].value.m22 == 2.0
                && keyframes[0].value.tx == 1.0
                && keyframes[0].value.ty == 0.0
            ))
    );
    assert_eq!(session.scene(), &result.scene);
}

fn animated_shape_resize_command(
    bundle: &SceneIrBundleV1,
    shape: StudioAuthoringEntityKind,
    from_dimensions: StudioAuthoringDimensions,
    to_dimensions: StudioAuthoringDimensions,
) -> ApplyStudioCreationEditCommand {
    let mut command = studio_creation_command(bundle);
    let create = &mut command.programs[0];
    create.anchor_captured_playhead = 0.0;
    create.anchor_resolved_seconds = 0.0;
    create.anchor_source = SceneEditAnchorSource::Playhead {
        reference_seconds: Some(0.0),
    };
    for operation in &mut create.operations {
        operation.interval = match operation.kind {
            StudioCreationOperationKind::FadeIn { .. } => IntervalV1 {
                end: 0.4,
                start: 0.0,
            },
            _ => IntervalV1 {
                end: 0.0,
                start: 0.0,
            },
        };
    }
    let StudioCreationOperationKind::Create { entity } = &mut create.operations[0].kind else {
        unreachable!();
    };
    entity.kind = shape;
    entity.dimensions = from_dimensions;
    entity.lifetime_start = 0.0;

    let resize_program = &mut command.programs[1];
    resize_program.anchor_captured_playhead = 0.0;
    resize_program.anchor_resolved_seconds = 0.0;
    resize_program.anchor_source = SceneEditAnchorSource::Playhead {
        reference_seconds: Some(0.0),
    };
    let resize_operation = &mut resize_program.operations[0];
    resize_operation.interval = IntervalV1 {
        end: 1.5,
        start: 0.0,
    };
    let StudioCreationOperationKind::Resize {
        from_dimensions: operation_from,
        from_position,
        shape: operation_shape,
        to_dimensions: operation_to,
        to_position,
        ..
    } = &mut resize_operation.kind
    else {
        unreachable!();
    };
    *operation_shape = shape;
    *operation_from = from_dimensions;
    *operation_to = to_dimensions;
    *from_position = PointV1 { x: 320.0, y: 180.0 };
    *to_position = PointV1 { x: 360.0, y: 160.0 };
    command
}

fn assert_normalized_shape_resize(
    shape: StudioAuthoringEntityKind,
    from_dimensions: StudioAuthoringDimensions,
    to_dimensions: StudioAuthoringDimensions,
    expected_scale: (f64, f64),
) {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let command = animated_shape_resize_command(&bundle, shape, from_dimensions, to_dimensions);

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    let resize = projection
        .mutations
        .iter()
        .find(|mutation| mutation.operation_id == "resize")
        .unwrap();
    assert!((resize.interval.start - 0.4).abs() < 1e-12);
    assert!((resize.interval.end - 1.9).abs() < 1e-12);

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let scene = session
        .apply_studio_creation_edit(command)
        .unwrap()
        .bundle
        .scene;
    let keyframes = scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::AffineTransform {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(keyframes[0].easing_to_next, Some(EasingV1::ManimSmooth {}));
    let (to_scale_x, to_scale_y) = expected_scale;
    let close = |actual: f64, expected: f64| assert!((actual - expected).abs() < 1e-12);
    close(keyframes[0].value.m11, 1.0);
    close(keyframes[0].value.m22, 1.0);
    close(keyframes[1].value.m11, to_scale_x);
    close(keyframes[1].value.m22, to_scale_y);
    close(keyframes[1].value.tx, 1.0);
    close(keyframes[1].value.ty, 0.5);

    let midpoint = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "animated-shape-resize-midpoint",
            sample_time: 1.15,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap()
        .draws
        .into_iter()
        .find_map(|draw| match draw {
            poietra_scene_ir::RenderDrawV1::Path {
                entity_id: candidate,
                transform,
                ..
            } if candidate == entity_id => Some(transform),
            _ => None,
        })
        .unwrap();
    close(midpoint.m11, f64::midpoint(1.0, to_scale_x));
    close(midpoint.m22, f64::midpoint(1.0, to_scale_y));
    close(midpoint.tx, 0.5);
    close(midpoint.ty, 0.25);
}

#[test]
fn normalized_creation_animates_circle_and_rectangle_resize() {
    let dimensions = |radius, width, height| StudioAuthoringDimensions {
        height,
        radius,
        width,
        ..StudioAuthoringDimensions::default()
    };
    assert_normalized_shape_resize(
        StudioAuthoringEntityKind::Circle,
        dimensions(Some(1.0), None, None),
        dimensions(Some(2.0), None, None),
        (2.0, 2.0),
    );
    assert_normalized_shape_resize(
        StudioAuthoringEntityKind::Rectangle,
        dimensions(None, Some(2.0), Some(1.0)),
        dimensions(None, Some(4.0), Some(3.0)),
        (2.0, 3.0),
    );
}

#[test]
fn animated_shape_resize_spans_a_later_timeline_insertion() {
    let bundle = static_imported_bundle();
    let dimensions = StudioAuthoringDimensions {
        radius: Some(1.0),
        ..StudioAuthoringDimensions::default()
    };
    let mut command = animated_shape_resize_command(
        &bundle,
        StudioAuthoringEntityKind::Circle,
        dimensions,
        StudioAuthoringDimensions {
            radius: Some(2.0),
            ..StudioAuthoringDimensions::default()
        },
    );
    command.programs.push(studio_camera_program(
        "camera-after-resize",
        "camera-after-resize",
        0.75,
        1.0,
        bundle.scene.camera.view.clone(),
        camera_view(4.0, 8.0),
    ));

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    let resize = projection
        .mutations
        .iter()
        .find(|mutation| mutation.operation_id == "resize")
        .unwrap();
    assert!((resize.interval.start - 0.4).abs() < 1e-12);
    assert!((resize.interval.end - 2.15).abs() < 1e-12);

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let scene = session
        .apply_studio_creation_edit(command)
        .unwrap()
        .bundle
        .scene;
    let keyframes = scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::AffineTransform {
                entity_id,
                keyframes,
                ..
            } if entity_id == "tx:create/entity:circle" => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert!((keyframes[0].at - 0.4).abs() < 1e-12);
    assert!((keyframes[1].at - 2.15).abs() < 1e-12);
}

#[test]
fn source_lowering_metadata_does_not_gate_canonical_creation() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command.programs[0].lowering_supported = false;

    let mut session = EngineSessionV1::new(bundle).unwrap();
    assert!(session.apply_studio_creation_edit(command).is_ok());
}

#[test]
fn creation_opacity_track_uses_the_existing_timeline_without_inserting_time() {
    let bundle = static_imported_bundle();
    let base_duration = bundle.scene.duration;
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    add_creation_opacity_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();

    assert!((result.bundle.scene.duration - (base_duration + 0.4)).abs() < 1e-12);
    assert_eq!(
        result
            .creation_projection
            .as_ref()
            .unwrap()
            .insertions
            .len(),
        1
    );
    let opacity = result
        .creation_projection
        .as_ref()
        .unwrap()
        .mutations
        .iter()
        .find(|mutation| mutation.operation_id == "opacity-segment")
        .unwrap();
    assert!(
        (opacity.interval.start - 1.4).abs() < 1e-12,
        "projected opacity interval: {:?}",
        opacity.interval
    );
    assert!((opacity.interval.end - 1.8).abs() < 1e-12);
    assert!(matches!(
        opacity.kind,
        StudioCreationProjectedMutationKind::OpacityKeyframes {
            easing: EasingV1::Linear {},
            from: 1.0,
            to: 0.0,
        }
    ));
    let channel_keyframes = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::Opacity {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert!(
        channel_keyframes
            .iter()
            .zip([0.5, 0.9, 1.4, 1.8])
            .all(|(keyframe, expected)| (keyframe.at - expected).abs() < 1e-12)
    );
    assert_eq!(
        channel_keyframes[2].easing_to_next,
        Some(EasingV1::Linear {})
    );
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "opacity-track-midpoint",
            sample_time: 1.6,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    let alpha = packet
        .draws
        .iter()
        .find(|draw| draw.entity_id() == entity_id)
        .map(poietra_scene_ir::RenderDrawV1::opacity)
        .unwrap();
    assert!((alpha - 0.5).abs() < 1e-12, "sampled alpha: {alpha}");
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one vertical-slice test pins Triangle normalization, shape morph, appearance fusion, and sampling"
)]
fn creation_triangle_fill_color_track_uses_one_vector_appearance_channel() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:regular-polygon";
    let mut command = studio_regular_polygon_creation_command(&bundle, 3, 1.0);
    let program = &mut command.programs[0];
    add_creation_paint_color_segment(
        program,
        entity_id,
        StudioPaintColorProperty::FillColor,
        "#ff0000",
        "#0000ff",
        1.0,
        1.4,
    );
    add_creation_opacity_segment(program, entity_id, 1.0, 1.4);
    program.schedule_edge_count = 2 * (program.operations.len() - 1);
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        entity_id,
        "initial-fill-color",
        StudioCreationOperationKind::FillColor {
            color: Some("#ff0000".to_owned()),
        },
    ));
    command.programs.push(studio_shape_transform_program(
        "triangle-to-circle",
        "triangle-to-circle",
        entity_id,
        StudioAuthoringEntityKind::RegularPolygon,
        StudioAuthoringDimensions {
            radius: Some(1.0),
            sides: Some(3),
            ..StudioAuthoringDimensions::default()
        },
        StudioAuthoringEntityKind::Circle,
        StudioAuthoringDimensions {
            radius: Some(1.0),
            ..StudioAuthoringDimensions::default()
        },
    ));
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();

    let projection = result.creation_projection.as_ref().unwrap();
    let projected = projection
        .entities
        .iter()
        .find(|entity| entity.entity_id == entity_id)
        .unwrap();
    assert_eq!(projected.fill_color.as_deref(), Some("#ff0000"));
    assert!(projected.stroke_color.is_none());
    assert!(projection.mutations.iter().any(|mutation| matches!(
        &mutation.kind,
        StudioCreationProjectedMutationKind::PaintColorKeyframes {
            easing: EasingV1::Linear {},
            from,
            property: StudioPaintColorProperty::FillColor,
            to,
        } if from == "#ff0000" && to == "#0000ff"
    )));
    let appearance_channels = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .filter_map(|channel| match channel {
            AnimationChannelV1::VectorAppearance {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => Some(keyframes),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(appearance_channels.len(), 1);
    let keyframes = appearance_channels[0];
    assert_eq!(keyframes.len(), 3);
    assert!(keyframes.iter().all(|keyframe| matches!(
        &keyframe.value,
        VectorAppearanceValueV1 {
            fill: Some(fill),
            stroke: Some(stroke),
        } if (fill.color.alpha - 1.0).abs() < 1e-12
            && (stroke.color.red - 1.0).abs() < 1e-12
            && (stroke.color.green - 1.0).abs() < 1e-12
            && (stroke.color.blue - 1.0).abs() < 1e-12
    )));
    let sample_time = f64::midpoint(keyframes[1].at, keyframes[2].at);
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "fill-color-track-midpoint",
            sample_time,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(packet.draws.iter().any(|draw| matches!(
        draw,
        poietra_scene_ir::RenderDrawV1::Path {
            entity_id: candidate,
            fill: Some(fill),
            stroke: Some(stroke),
            ..
        } if candidate == entity_id
            && (fill.color.red - 0.5).abs() < 1e-12
            && fill.color.green.abs() < 1e-12
            && (fill.color.blue - 0.5).abs() < 1e-12
            && (stroke.color.red - 1.0).abs() < 1e-12
    )));
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::Opacity { entity_id: candidate, .. } if candidate == entity_id
            ))
    );
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::PathMorph { entity_id: candidate, .. }
                    if candidate == entity_id
            ))
    );
}

fn studio_glyph_fill_color_track_command(
    bundle: &SceneIrBundleV1,
    kind: StudioAuthoringEntityKind,
) -> ApplyStudioCreationEditCommand {
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_text_creation_command(bundle, "E = mc^2");
    command.programs.truncate(1);
    if kind == StudioAuthoringEntityKind::MathTex {
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.kind = kind;
        entity.text = None;
        entity.tex_parts = Some(vec!["E = mc^2".to_owned()]);
        command.text_outlines.clear();
        command.math_tex_outlines = [
            (entity_id, vec!["E = mc^2".to_owned()]),
            ("tx:math-transform/entity:formula", vec!["x^2".to_owned()]),
        ]
        .into_iter()
        .map(|(entity_id, tex_parts)| StudioCreationMathTexOutline {
            entity_id: entity_id.to_owned(),
            path: mathtex_fixture_path(),
            tex_parts,
        })
        .collect();
    }
    let program = &mut command.programs[0];
    add_creation_paint_color_segment(
        program,
        entity_id,
        StudioPaintColorProperty::FillColor,
        "#ff0000",
        "#0000ff",
        1.2,
        1.6,
    );
    program.schedule_edge_count = 2 * (program.operations.len() - 1);
    command.programs.push(studio_created_appearance_edit_input(
        0.5,
        entity_id,
        "initial-fill-color",
        StudioCreationOperationKind::FillColor {
            color: Some("#ff0000".to_owned()),
        },
    ));
    if kind == StudioAuthoringEntityKind::MathTex {
        command.programs.push(studio_math_tex_transform_program(
            "math-transform",
            "math-transform",
            entity_id,
            entity_id,
            "tx:math-transform/entity:formula",
            StudioMathTexContent {
                display_lines: vec!["x^2".to_owned()],
                label: None,
                tex_parts: vec!["x^2".to_owned()],
            },
        ));
    }
    command
}

#[test]
fn creation_text_and_math_tex_fill_color_tracks_keep_canonical_outline_channels() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    for kind in [
        StudioAuthoringEntityKind::Text,
        StudioAuthoringEntityKind::MathTex,
    ] {
        let command = studio_glyph_fill_color_track_command(&bundle, kind);
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        let result = session.apply_studio_creation_edit(command).unwrap();
        assert_eq!(
            result.creation_projection.as_ref().unwrap().entities[0]
                .fill_color
                .as_deref(),
            Some("#ff0000")
        );
        assert_eq!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .filter(|channel| matches!(
                    channel,
                    AnimationChannelV1::VectorAppearance { entity_id: candidate, .. }
                        if candidate == entity_id
                ))
                .count(),
            1
        );
        assert_eq!(
            result
                .bundle
                .scene
                .animation_channels
                .iter()
                .any(|channel| matches!(
                    channel,
                    AnimationChannelV1::PathMorph { entity_id: candidate, .. }
                        if candidate == entity_id
                )),
            kind == StudioAuthoringEntityKind::MathTex
        );
    }
}

#[test]
fn creation_line_stroke_color_track_preserves_draw_width_and_cap() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:line";
    let mut command = studio_path_creation_command(
        &bundle,
        "line",
        StudioAuthoringEntityKind::Line,
        StudioAuthoringDimensions::default(),
    );
    let program = &mut command.programs[0];
    let draw = program
        .operations
        .iter_mut()
        .find(|operation| matches!(operation.kind, StudioCreationOperationKind::FadeIn { .. }))
        .unwrap();
    draw.id = "draw".to_owned();
    draw.interval.end = 1.25;
    draw.kind = StudioCreationOperationKind::DrawIn {
        easing: StudioPropertyEasing::Smooth,
        from: Some(0.0),
        to: Some(1.0),
    };
    program.schedule_order[2] = "draw".to_owned();
    add_creation_paint_color_segment(
        program,
        entity_id,
        StudioPaintColorProperty::StrokeColor,
        "#ffffff",
        "#22c55e",
        1.5,
        2.0,
    );
    command.programs.extend([
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "line-stroke-width",
            StudioCreationOperationKind::StrokeWidth {
                width_world: Some(0.08),
            },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "line-stroke-cap",
            StudioCreationOperationKind::StrokeCap {
                cap: Some(poietra_scene_ir::StrokeCapV1::Round),
            },
        ),
    ]);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();

    let projected = result
        .creation_projection
        .as_ref()
        .unwrap()
        .entities
        .iter()
        .find(|entity| entity.entity_id == entity_id)
        .unwrap();
    assert!(projected.fill_color.is_none());
    assert_eq!(projected.stroke_color.as_deref(), Some("#ffffff"));
    let keyframes = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::VectorAppearance {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(keyframes.len(), 2);
    assert!(keyframes.iter().all(|keyframe| matches!(
        &keyframe.value,
        VectorAppearanceValueV1 {
            fill: None,
            stroke: Some(stroke),
        } if (stroke.width_world - 0.08).abs() < 1e-12
            && stroke.cap == poietra_scene_ir::StrokeCapV1::Round
    )));
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::PathTrim { entity_id: candidate, .. } if candidate == entity_id
            ))
    );
}

#[test]
fn creation_paint_color_track_rejects_missing_baselines_and_conflicts() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";

    let mut unfilled = studio_creation_command(&bundle);
    unfilled.programs.truncate(1);
    add_creation_paint_color_segment(
        &mut unfilled.programs[0],
        entity_id,
        StudioPaintColorProperty::FillColor,
        "#ffffff",
        "#0000ff",
        1.0,
        1.4,
    );
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &unfilled.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut conflicting = studio_creation_command(&bundle);
    conflicting.programs.truncate(1);
    let program = &mut conflicting.programs[0];
    add_creation_paint_color_segment(
        program,
        entity_id,
        StudioPaintColorProperty::FillColor,
        "#ff0000",
        "#0000ff",
        1.0,
        1.4,
    );
    add_creation_material_parameter_segment(program, entity_id, 1.0, 1.4);
    conflicting
        .programs
        .push(studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "initial-fill-color",
            StudioCreationOperationKind::FillColor {
                color: Some("#ff0000".to_owned()),
            },
        ));
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &conflicting.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));

    let mut write = studio_math_tex_write_creation_command(&bundle);
    let write_entity_id = "tx:create/entity:circle";
    add_creation_paint_color_segment(
        &mut write.programs[0],
        write_entity_id,
        StudioPaintColorProperty::FillColor,
        "#ff0000",
        "#0000ff",
        1.75,
        2.0,
    );
    write.programs.push(studio_created_appearance_edit_input(
        0.5,
        write_entity_id,
        "initial-fill-color",
        StudioCreationOperationKind::FillColor {
            color: Some("#ff0000".to_owned()),
        },
    ));
    assert!(matches!(
        project_studio_creation_edits(bundle.scene.duration, &write.programs),
        Err(ProjectStudioCreationEditError::Unsupported)
    ));
}

#[test]
fn creation_uniform_scale_track_uses_the_canonical_affine_evaluator() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    add_creation_uniform_scale_segment(&mut command.programs[0], entity_id, 1.0, 1.4, 2.0);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();

    let projection = result.creation_projection.as_ref().unwrap();
    let mutation = projection
        .mutations
        .iter()
        .find(|mutation| mutation.operation_id == "scale-segment")
        .unwrap();
    assert!(matches!(
        &mutation.kind,
        StudioCreationProjectedMutationKind::UniformScaleKeyframes {
            easing: EasingV1::CubicBezier {
                x1: 0.42,
                x2: 0.58,
                y1: 0.0,
                y2: 1.0,
            },
            from: 1.0,
            to: 2.0,
        }
    ));
    let channel = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::AffineTransform {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(channel.len(), 2);
    assert_eq!(
        channel[0].easing_to_next,
        Some(EasingV1::CubicBezier {
            x1: 0.42,
            x2: 0.58,
            y1: 0.0,
            y2: 1.0,
        })
    );
    assert!((channel[0].value.m11 - 1.0).abs() < 1e-12);
    assert!((channel[1].value.m11 - 2.0).abs() < 1e-12);

    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "scale-track-midpoint",
            sample_time: f64::midpoint(channel[0].at, channel[1].at),
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    let transform = packet
        .draws
        .iter()
        .find_map(|draw| match draw {
            poietra_scene_ir::RenderDrawV1::Path {
                entity_id: candidate,
                transform,
                ..
            } if candidate == entity_id => Some(transform),
            _ => None,
        })
        .unwrap();
    assert!((transform.m11 - 1.5).abs() < 1e-12);
    assert!((transform.m22 - 1.5).abs() < 1e-12);
}

#[test]
fn one_uniform_scale_marker_keeps_the_base_without_an_affine_channel() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    add_creation_uniform_scale_segment(&mut command.programs[0], entity_id, 1.0, 1.0, 1.0);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();

    assert!(
        !result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::AffineTransform {
                        entity_id: candidate,
                        ..
                    } if candidate == entity_id
                )
            })
    );
}

#[test]
fn creation_rotation_track_uses_scalar_angles_and_an_explicit_pivot() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    add_creation_rotation_segment(&mut command.programs[0], entity_id, 1.0, 1.4, 5.0 * PI);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let mutation = result
        .creation_projection
        .as_ref()
        .unwrap()
        .mutations
        .iter()
        .find(|mutation| mutation.operation_id == "rotation-segment")
        .unwrap();
    assert!(matches!(
        mutation.kind,
        StudioCreationProjectedMutationKind::RotationKeyframes {
            easing: EasingV1::Linear {},
            from: 0.0,
            to,
        } if (to - 5.0 * PI).abs() < 1e-12
    ));
    let entity = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    let (keyframes, pivot) = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::Rotation {
                entity_id: candidate,
                keyframes,
                pivot,
                ..
            } if candidate == entity_id => Some((keyframes, pivot)),
            _ => None,
        })
        .unwrap();
    assert_eq!(keyframes.len(), 2);
    assert_eq!(keyframes[0].easing_to_next, Some(EasingV1::Linear {}));
    assert!((pivot.x - entity.transform.tx).abs() < 1e-12);
    assert!((pivot.y - entity.transform.ty).abs() < 1e-12);

    let sample_time = keyframes[0].at + (keyframes[1].at - keyframes[0].at) * 0.25;
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "rotation-track-quarter",
            sample_time,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    let transform = packet
        .draws
        .iter()
        .find_map(|draw| match draw {
            poietra_scene_ir::RenderDrawV1::Path {
                entity_id: candidate,
                transform,
                ..
            } if candidate == entity_id => Some(transform),
            _ => None,
        })
        .unwrap();
    let expected = 1.25 * PI;
    assert!((transform.m11 - expected.cos()).abs() < 1e-12);
    assert!((transform.m12 + expected.sin()).abs() < 1e-12);
    assert!((transform.m21 - expected.sin()).abs() < 1e-12);
    assert!((transform.m22 - expected.cos()).abs() < 1e-12);
    assert!((transform.m11 * transform.m22 - transform.m12 * transform.m21 - 1.0).abs() < 1e-12);
}

#[test]
fn rotation_channel_rejects_an_invalid_pivot_or_competing_affine_channel() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    add_creation_rotation_segment(&mut command.programs[0], entity_id, 1.0, 1.4, 5.0 * PI);
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();

    let mut invalid = result.bundle.scene.clone();
    let pivot = invalid
        .animation_channels
        .iter_mut()
        .find_map(|channel| match channel {
            AnimationChannelV1::Rotation { pivot, .. } => Some(pivot),
            _ => None,
        })
        .expect("expected the rotation channel");
    pivot.x = f64::NAN;
    assert!(poietra_scene_ir::validate_scene_ir_v1(&invalid).is_err());

    let mut conflicting = result.bundle.scene.clone();
    let provenance_id = conflicting
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::Rotation { provenance_id, .. } => Some(provenance_id.clone()),
            _ => None,
        })
        .unwrap();
    conflicting
        .animation_channels
        .push(AnimationChannelV1::AffineTransform {
            entity_id: entity_id.to_owned(),
            id: "conflicting-affine".to_owned(),
            keyframes: vec![
                KeyframeV1 {
                    at: 1.0,
                    easing_to_next: Some(EasingV1::Linear {}),
                    value: AffineTransformV1::identity(),
                },
                KeyframeV1 {
                    at: 1.4,
                    easing_to_next: None,
                    value: AffineTransformV1::identity(),
                },
            ],
            provenance_id,
        });
    assert!(
        poietra_scene_ir::validate_scene_ir_v1(&conflicting)
            .unwrap_err()
            .contains_message("duplicate animation channel target")
    );
}

#[test]
fn one_rotation_marker_keeps_the_base_without_a_transform_channel() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    add_creation_rotation_segment(&mut command.programs[0], entity_id, 1.0, 1.0, 0.0);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();

    assert!(
        !result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::Rotation {
                        entity_id: candidate,
                        ..
                    } if candidate == entity_id
                )
            })
    );
}

#[test]
fn creation_rotation_and_scale_tracks_are_mutually_exclusive() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    add_creation_uniform_scale_segment(&mut command.programs[0], entity_id, 1.0, 1.4, 2.0);
    add_creation_rotation_segment(&mut command.programs[0], entity_id, 1.0, 1.4, FRAC_PI_2);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
}

#[test]
fn creation_material_parameter_track_emits_vector_appearance_and_coexists_with_opacity() {
    let mut bundle = static_imported_bundle();
    bundle.scene.compositing = poietra_scene_ir::RenderCompositingV1::LinearLight;
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.kind = StudioAuthoringEntityKind::Arrow;
    entity.dimensions = StudioAuthoringDimensions::default();
    add_creation_opacity_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
    add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let material_channel = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::VectorAppearance {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(material_channel.len(), 2);
    assert_eq!(
        material_channel[0].easing_to_next,
        Some(EasingV1::ManimSmooth {})
    );
    let first_material = material_channel[0]
        .value
        .fill
        .as_ref()
        .and_then(|fill| fill.fragment_material.as_ref())
        .unwrap();
    let final_material = material_channel[1]
        .value
        .fill
        .as_ref()
        .and_then(|fill| fill.fragment_material.as_ref())
        .unwrap();
    assert_eq!(first_material.shader_id, "project-wave");
    assert_eq!(first_material.parameters, vec![0.35, 8.0]);
    assert_eq!(final_material.parameters, vec![0.85, 8.0]);
    let packet = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "material-track-midpoint",
            sample_time: 1.6,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    let midpoint = packet
        .draws
        .iter()
        .find_map(|draw| match draw {
            poietra_scene_ir::RenderDrawV1::Path {
                entity_id: candidate,
                fill: Some(fill),
                ..
            } if candidate == entity_id => fill.fragment_material.as_ref(),
            _ => None,
        })
        .unwrap();
    assert!((midpoint.parameters[0] - 0.60).abs() < 1e-12);
    assert!(result.bundle.scene.animation_channels.iter().any(|channel| {
            matches!(channel, AnimationChannelV1::Opacity { entity_id: candidate, .. } if candidate == entity_id)
        }));
    assert!(matches!(
        result
            .creation_projection
            .as_ref()
            .unwrap()
            .mutations
            .iter()
            .find(|mutation| mutation.operation_id == "material-segment")
            .map(|mutation| &mutation.kind),
        Some(StudioCreationProjectedMutationKind::MaterialParameterKeyframes {
            easing: EasingV1::ManimSmooth {},
            name,
            parameter_index: 0,
            ..
        }) if name == "amplitude"
    ));
}

#[test]
fn creation_material_parameter_track_composes_static_opacity_and_rotation() {
    let mut bundle = static_imported_bundle();
    bundle.scene.compositing = poietra_scene_ir::RenderCompositingV1::LinearLight;
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.kind = StudioAuthoringEntityKind::Arrow;
    entity.dimensions = StudioAuthoringDimensions::default();
    add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
    command.programs.extend([
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "opacity",
            StudioCreationOperationKind::Opacity { alpha: Some(0.25) },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "rotation",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(FRAC_PI_2),
                to: Some(FRAC_PI_2),
            },
        ),
    ]);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            fill: Some(fill),
            stroke: Some(stroke),
            ..
        } if (fill.color.alpha - 0.25).abs() < 1e-12
            && (stroke.color.alpha - 0.25).abs() < 1e-12
            && fill.fragment_material.is_some()
    ));
    let appearance_channels = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .filter_map(|channel| match channel {
            AnimationChannelV1::VectorAppearance {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => Some(keyframes),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(appearance_channels.len(), 1);
    assert!(appearance_channels[0].iter().all(|keyframe| matches!(
        &keyframe.value,
        VectorAppearanceValueV1 {
            fill: Some(fill),
            stroke: Some(stroke),
        } if (fill.color.alpha - 0.25).abs() < 1e-12
            && (stroke.color.alpha - 0.25).abs() < 1e-12
    )));
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::AffineTransform { entity_id: candidate, .. }
                        if candidate == entity_id
                )
            })
    );
}

#[test]
fn one_material_parameter_marker_sets_the_base_without_an_animation_channel() {
    let mut bundle = static_imported_bundle();
    bundle.scene.compositing = poietra_scene_ir::RenderCompositingV1::LinearLight;
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.kind = StudioAuthoringEntityKind::Arrow;
    entity.dimensions = StudioAuthoringDimensions::default();
    add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
    let marker = command.programs[0].operations.last_mut().unwrap();
    marker.interval.end = marker.interval.start;
    let StudioCreationOperationKind::MaterialParameterKeyframes {
        from: Some(from),
        to,
        ..
    } = &mut marker.kind
    else {
        unreachable!();
    };
    *to = Some(*from);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    let SceneAppearanceV1::Vector {
        fill: Some(fill), ..
    } = &created.appearance
    else {
        panic!("created arrow must have a fill");
    };
    assert_eq!(
        fill.fragment_material.as_ref().unwrap().parameters,
        vec![0.35, 8.0]
    );
    assert!(
        !result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::VectorAppearance { entity_id: candidate, .. }
                        if candidate == entity_id
                )
            })
    );
    assert!(
        result
            .bundle
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::FragmentMaterial)
    );
    assert!((sampled_material_parameter(&session, entity_id, 0.95) - 0.35).abs() < 1e-12);
    assert!((sampled_material_parameter(&session, entity_id, 1.5) - 0.35).abs() < 1e-12);
}

#[test]
fn creation_material_parameter_track_rejects_a_fill_less_shape_without_panicking() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Create(
            CreateSceneEntitiesError::InvalidAppearanceEdit
        ))
    ));
}

#[test]
fn creation_material_parameter_track_targets_a_fillless_line_stroke() {
    let mut bundle = static_imported_bundle();
    bundle.scene.compositing = poietra_scene_ir::RenderCompositingV1::LinearLight;
    let entity_id = "tx:create/entity:line";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    for operation in &mut command.programs[0].operations {
        if operation.entity_id.as_deref() == Some("tx:create/entity:circle") {
            operation.entity_id = Some(entity_id.to_owned());
        }
    }
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.id = entity_id.to_owned();
    entity.kind = StudioAuthoringEntityKind::Line;
    entity.dimensions = StudioAuthoringDimensions::default();
    add_creation_material_parameter_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!(matches!(
        &created.appearance,
        SceneAppearanceV1::Vector {
            fill: None,
            stroke: Some(stroke),
            ..
        } if stroke.fragment_material.is_some()
    ));
    let keyframes = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::VectorAppearance {
                entity_id: candidate,
                keyframes,
                ..
            } if candidate == entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert!(keyframes.iter().all(|keyframe| {
        keyframe.value.fill.is_none()
            && keyframe
                .value
                .stroke
                .as_ref()
                .and_then(|stroke| stroke.fragment_material.as_ref())
                .is_some()
    }));
    assert!((sampled_material_parameter(&session, entity_id, 1.6) - 0.60).abs() < 1e-12);
}

#[test]
fn creation_opacity_track_rejects_a_mixed_non_creation_operation() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    let resize = command.programs[1].operations[0].clone();
    add_creation_opacity_segment(&mut command.programs[0], entity_id, 1.0, 1.4);
    command.programs[0].operations.push(resize);
    command.programs[0].schedule_order.push("resize".to_owned());
    command.programs[0].schedule_edge_count = 8;
    command.programs.truncate(1);
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
}

#[test]
#[allow(
    clippy::float_cmp,
    reason = "the normalized creation fixture stores exact authored keyframe values"
)]
fn normalized_creation_applies_transform_then_persistent_remove() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command
        .programs
        .push(studio_persistent_remove_edit_input(entity_id, 1.4, 1.6));
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();

    assert_eq!(created.lifetimes.last().unwrap().end, 2.0);
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::AffineTransform {
                        entity_id: channel_entity_id,
                        keyframes,
                        ..
                    } if channel_entity_id == entity_id && keyframes[0].at == 1.25
                )
            })
    );
    let opacity_keyframes = result
        .bundle
        .scene
        .animation_channels
        .iter()
        .find_map(|channel| match channel {
            AnimationChannelV1::Opacity {
                entity_id: channel_entity_id,
                keyframes,
                ..
            } if channel_entity_id == entity_id => Some(keyframes),
            _ => None,
        })
        .unwrap();
    assert_eq!(opacity_keyframes.len(), 4);
    assert_eq!(opacity_keyframes[1].at, 0.9);
    assert_eq!(
        opacity_keyframes[1].easing_to_next,
        Some(EasingV1::Linear {})
    );
    assert!((opacity_keyframes[2].at - 1.8).abs() < 1e-9);
    assert_eq!(opacity_keyframes[2].value, 1.0);
    assert_eq!(
        opacity_keyframes[2].easing_to_next,
        Some(EasingV1::Smooth {})
    );
    assert_eq!(opacity_keyframes[3].at, 2.0);
    assert_eq!(opacity_keyframes[3].value, 0.0);
    assert_eq!(result.persistent_remove_projection.removals.len(), 1);
    let projection = &result.persistent_remove_projection.removals[0];
    assert_eq!(projection.operation_id, "remove-created");
    assert_eq!(projection.studio_entity_id, entity_id);
    assert_eq!(projection.scene_entity_id, entity_id);
    let fade_interval = projection.fade_interval.as_ref().unwrap();
    assert!((fade_interval.start - 1.8).abs() < 1e-9);
    assert!((fade_interval.end - 2.0).abs() < 1e-9);
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the explicit second raw Program keeps same-anchor ordering and lifetime facts visible"
)]
fn normalized_creation_rebases_same_anchor_order_lifetimes_and_followup_time() {
    let bundle = static_imported_bundle();
    let base_duration = bundle.scene.duration;
    let mut command = studio_creation_command(&bundle);
    let second_id = "tx:second/entity:rectangle";
    command.programs.push(StudioCreationEditInput {
        anchor_captured_playhead: 0.5,
        anchor_resolved_seconds: 0.5,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(0.5),
        },
        intent_count: 1,
        lowering_supported: true,
        operations: vec![
            StudioCreationOperation {
                depends_on: vec![],
                entity_id: None,
                id: "second-create".to_owned(),
                interval: IntervalV1 {
                    end: 0.5,
                    start: 0.5,
                },
                kind: StudioCreationOperationKind::Create {
                    entity: StudioCreationEntitySpec {
                        cubic_bezier: None,
                        data_series: None,
                        dimensions: StudioAuthoringDimensions {
                            angles: None,
                            coordinate_system: None,
                            height: Some(1.0),
                            radius: None,
                            sides: None,
                            width: Some(2.0),
                        },
                        id: second_id.to_owned(),
                        image: None,
                        kind: StudioAuthoringEntityKind::Rectangle,
                        layout: None,
                        lifetime_end: Some(1.0),
                        lifetime_start: 0.5,
                        text: None,
                        tex_parts: None,
                        svg: None,
                    },
                },
                origin: StudioAuthoringOrigin::StudioDefault,
            },
            StudioCreationOperation {
                depends_on: vec!["second-create".to_owned()],
                entity_id: Some(second_id.to_owned()),
                id: "second-position".to_owned(),
                interval: IntervalV1 {
                    end: 0.5,
                    start: 0.5,
                },
                kind: StudioCreationOperationKind::Position {
                    position: Some(PointV1 { x: 280.0, y: 180.0 }),
                },
                origin: StudioAuthoringOrigin::StudioDefault,
            },
            StudioCreationOperation {
                depends_on: vec!["second-position".to_owned()],
                entity_id: Some(second_id.to_owned()),
                id: "second-fade".to_owned(),
                interval: IntervalV1 {
                    end: 0.7,
                    start: 0.5,
                },
                kind: StudioCreationOperationKind::FadeIn { persistent: true },
                origin: StudioAuthoringOrigin::StudioDefault,
            },
        ],
        origin: StudioAuthoringOrigin::StudioDefault,
        requested_execution: SceneEditExecution::Parallel,
        schedule_edge_count: 4,
        schedule_mode: SceneEditScheduleMode::DependencyDag,
        schedule_order: vec![
            "second-create".to_owned(),
            "second-position".to_owned(),
            "second-fade".to_owned(),
        ],
        transaction_id: "second".to_owned(),
    });
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let result = result.bundle;
    let first = result
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:circle")
        .unwrap();
    let second = result
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == second_id)
        .unwrap();

    assert!((result.scene.duration - (base_duration + 0.6)).abs() < 1e-9);
    assert_eq!(first.scene_order + 1, second.scene_order);
    assert!((first.lifetimes[0].end - (base_duration + 0.6)).abs() < 1e-9);
    assert!((second.lifetimes[0].start - 0.9).abs() < 1e-9);
    assert!((second.lifetimes[0].end - 1.6).abs() < 1e-9);
    assert!(
        result
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::AffineTransform { entity_id, keyframes, .. }
                    if entity_id == "tx:create/entity:circle"
                        && (keyframes[0].at - 1.45).abs() < 1e-9
            ))
    );
}

#[test]
fn normalized_creation_applies_one_group_position_and_scale_program() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let first_id = "tx:create/entity:circle";
    let second_id = "tx:second/entity:rectangle";
    let second_creation = second_group_resize_creation(&command.programs[0]);
    command.programs.push(second_creation);
    let targets = [
        (first_id, PointV1 { x: 240.0, y: 180.0 }),
        (second_id, PointV1 { x: 400.0, y: 180.0 }),
    ];
    command
        .programs
        .push(studio_group_resize_edit_input(&targets));
    let expected = targets.map(|(entity_id, position)| {
        (
            entity_id,
            studio_point_to_scene_point(
                &position,
                command.frame,
                command.viewport,
                &bundle.scene.camera.view.center,
            ),
        )
    });
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let projection = result.creation_projection.as_ref().unwrap();
    assert_eq!(
        projection
            .mutations
            .iter()
            .filter(|mutation| mutation.transaction_id == "group-resize")
            .count(),
        4
    );
    for (entity_id, expected) in expected {
        assert_group_resize_transform(
            &result.bundle.scene.animation_channels,
            entity_id,
            &expected,
        );
    }
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[test]
fn normalized_creation_applies_one_rigid_group_rotation_program() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let first_id = "tx:create/entity:circle";
    let second_id = "tx:second/entity:rectangle";
    let second_creation = second_group_resize_creation(&command.programs[0]);
    command.programs.push(second_creation);
    let targets = [
        (first_id, PointV1 { x: 400.0, y: 260.0 }),
        (second_id, PointV1 { x: 400.0, y: 100.0 }),
    ];
    command
        .programs
        .push(studio_group_rotation_edit_input(&targets, FRAC_PI_2));
    let expected = targets.map(|(entity_id, position)| {
        (
            entity_id,
            studio_point_to_scene_point(
                &position,
                command.frame,
                command.viewport,
                &bundle.scene.camera.view.center,
            ),
        )
    });
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let projection = result.creation_projection.as_ref().unwrap();
    assert_eq!(
        projection
            .mutations
            .iter()
            .filter(|mutation| mutation.transaction_id == "group-rotation")
            .count(),
        4
    );
    for (entity_id, expected) in expected {
        assert_group_rotation_transform(
            &result.bundle.scene.animation_channels,
            entity_id,
            &expected,
        );
    }
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[test]
#[allow(clippy::too_many_lines)] // One end-to-end transform/hierarchy regression scenario.
fn normalized_creation_reuses_one_rust_transform_for_group_resize_and_rotation() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let first_id = "tx:create/entity:circle";
    let second_id = "tx:second/entity:rectangle";
    command
        .programs
        .push(second_group_resize_creation(&command.programs[0]));

    let first_rotation_targets = [
        (first_id, PointV1 { x: 400.0, y: 260.0 }),
        (second_id, PointV1 { x: 400.0, y: 100.0 }),
    ];
    command.programs.push(studio_group_rotation_edit_input(
        &first_rotation_targets,
        FRAC_PI_2,
    ));

    let resize_targets = [
        (first_id, PointV1 { x: 400.0, y: 300.0 }),
        (second_id, PointV1 { x: 400.0, y: 60.0 }),
    ];
    let mut resize = studio_group_resize_edit_input(&resize_targets);
    for operation in &mut resize.operations {
        operation.id = format!("resize-{}", operation.id);
    }
    resize.schedule_order = resize
        .operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect();
    command.programs.push(resize);

    let final_targets = [
        (first_id, PointV1 { x: 520.0, y: 180.0 }),
        (second_id, PointV1 { x: 280.0, y: 180.0 }),
    ];
    let mut second_rotation = studio_group_rotation_edit_input(&final_targets, FRAC_PI_2);
    second_rotation.transaction_id = "group-rotation-2".to_owned();
    for operation in &mut second_rotation.operations {
        operation.id = format!("second-{}", operation.id);
    }
    second_rotation.schedule_order = second_rotation
        .operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect();
    command.programs.push(second_rotation);
    let group_id = "tx:transformed-group/entity:group";
    command.programs.push(studio_hierarchy_edit_input(
        "transformed-group",
        0.95,
        StudioCreationOperationKind::Group {
            child_entity_ids: vec![first_id.to_owned(), second_id.to_owned()],
            group_id: group_id.to_owned(),
        },
    ));

    let expected = final_targets.map(|(entity_id, position)| {
        (
            entity_id,
            studio_point_to_scene_point(
                &position,
                command.frame,
                command.viewport,
                &bundle.scene.camera.view.center,
            ),
        )
    });
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let projection = result.creation_projection.as_ref().unwrap();

    for (entity_id, expected) in expected {
        let transform = result
            .bundle
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::AffineTransform {
                    entity_id: candidate,
                    keyframes,
                    ..
                } if candidate == entity_id => keyframes.first().map(|keyframe| &keyframe.value),
                _ => None,
            })
            .unwrap();
        assert!((transform.m11 + 1.5).abs() < 1e-12);
        assert!(transform.m12.abs() < 1e-12);
        assert!(transform.m21.abs() < 1e-12);
        assert!((transform.m22 + 1.5).abs() < 1e-12);
        assert!((transform.tx - expected.x).abs() < 1e-12);
        assert!((transform.ty - expected.y).abs() < 1e-12);
        assert!(projection.mutations.iter().any(|mutation| {
            mutation.entity_id == entity_id
                && mutation.transaction_id == "group-rotation-2"
                && matches!(
                    mutation.kind,
                    StudioCreationProjectedMutationKind::Rotation { from, to }
                        if (from - FRAC_PI_2).abs() < 1e-12
                            && (to - std::f64::consts::PI).abs() < 1e-12
                )
        }));
    }
    let group = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == group_id)
        .unwrap();
    assert_eq!(group.transform, AffineTransformV1::identity());
    assert!(
        result.bundle.scene.entities.iter().any(|entity| {
            entity.id == first_id && entity.parent_id.as_deref() == Some(group_id)
        })
    );
    assert!(
        result.bundle.scene.entities.iter().any(|entity| {
            entity.id == second_id && entity.parent_id.as_deref() == Some(group_id)
        })
    );
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[test]
fn normalized_creation_replays_group_and_ungroup_history_across_reverse_playheads() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command
        .programs
        .push(second_group_resize_creation(&command.programs[0]));
    let child_ids = vec![
        "tx:create/entity:circle".to_owned(),
        "tx:second/entity:rectangle".to_owned(),
    ];
    let group_id = "tx:studio-group/entity:group".to_owned();
    command.programs.push(studio_hierarchy_edit_input(
        "studio-group",
        1.0,
        StudioCreationOperationKind::Group {
            child_entity_ids: child_ids.clone(),
            group_id: group_id.clone(),
        },
    ));
    let grouped_history = command.clone();

    let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
    let grouped = session.apply_studio_creation_edit(command.clone()).unwrap();
    let group = grouped
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == group_id)
        .unwrap();
    assert_eq!(group.geometry, SceneGeometryV1::Group {});
    assert_eq!(group.appearance, SceneAppearanceV1::Group { opacity: 1.0 });
    assert_eq!(group.transform, AffineTransformV1::identity());
    let maximum_child_end = child_ids
        .iter()
        .filter_map(|child_id| {
            grouped
                .bundle
                .scene
                .entities
                .iter()
                .find(|entity| entity.id == *child_id)
                .and_then(|entity| entity.lifetimes.last())
                .map(|lifetime| lifetime.end)
        })
        .fold(0.0_f64, f64::max);
    assert_eq!(
        group.lifetimes,
        vec![IntervalV1 {
            start: 0.5,
            end: maximum_child_end,
        }]
    );
    assert!(child_ids.iter().all(|child_id| {
        grouped
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == *child_id)
            .is_some_and(|entity| entity.parent_id.as_deref() == Some(group_id.as_str()))
    }));

    command.programs.push(studio_hierarchy_edit_input(
        "studio-ungroup",
        0.5,
        StudioCreationOperationKind::Ungroup {
            group_id: group_id.clone(),
        },
    ));
    let mut session = EngineSessionV1::new(bundle).unwrap();
    let ungrouped = session.apply_studio_creation_edit(command.clone()).unwrap();
    assert!(!bundle_contains_entity(&ungrouped.bundle, &group_id));
    assert!(child_ids.iter().all(|child_id| {
        ungrouped
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == *child_id)
            .is_some_and(|entity| entity.parent_id.is_none())
    }));

    let base = static_imported_bundle();
    let mut undo_session = EngineSessionV1::new(base.clone()).unwrap();
    let undo = undo_session
        .apply_studio_creation_edit(grouped_history)
        .unwrap();
    assert!(bundle_contains_entity(&undo.bundle, &group_id));

    let mut redo_session = EngineSessionV1::new(base).unwrap();
    let redo = redo_session.apply_studio_creation_edit(command).unwrap();
    assert!(!bundle_contains_entity(&redo.bundle, &group_id));
}

#[test]
fn normalized_creation_trims_one_logical_group_lifetime_atomically() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command
        .programs
        .push(second_group_resize_creation(&command.programs[0]));
    let child_ids = vec![
        "tx:create/entity:circle".to_owned(),
        "tx:second/entity:rectangle".to_owned(),
    ];
    let group_id = "tx:lifetime-group/entity:group".to_owned();
    command.programs.push(studio_hierarchy_edit_input(
        "lifetime-group",
        1.0,
        StudioCreationOperationKind::Group {
            child_entity_ids: child_ids.clone(),
            group_id: group_id.clone(),
        },
    ));
    let grouped_history = command.clone();
    command
        .programs
        .push(studio_group_lifetime_trim_edit_input(&child_ids, 1.5));

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(projection.removals.len(), 2);
    assert!(projection.removals.iter().all(|removal| {
        removal.transaction_id == "trim-group-lifetime"
            && child_ids.contains(&removal.studio_entity_id)
            && removal.fade_interval.is_none()
    }));

    let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
    let result = session.apply_studio_creation_edit(command.clone()).unwrap();
    let group = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == group_id)
        .unwrap();
    let lifetime_end = group.lifetimes[0].end;
    assert!(child_ids.iter().all(|child_id| {
        result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == *child_id)
            .is_some_and(|entity| {
                entity.parent_id.as_deref() == Some(group_id.as_str())
                    && entity.lifetimes[0].end == lifetime_end
            })
    }));
    let visible = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "group-before-lifetime-end",
            sample_time: lifetime_end - 1e-6,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(child_ids.iter().all(|child_id| {
        visible
            .draws
            .iter()
            .any(|draw| draw.entity_id() == child_id)
    }));
    let hidden = session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "group-at-lifetime-end",
            sample_time: lifetime_end,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(
        child_ids
            .iter()
            .all(|child_id| { hidden.draws.iter().all(|draw| draw.entity_id() != child_id) })
    );

    let untrimmed = EngineSessionV1::new(bundle.clone())
        .unwrap()
        .apply_studio_creation_edit(grouped_history)
        .unwrap();
    let untrimmed_group = untrimmed
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == group_id)
        .unwrap();
    assert!(untrimmed_group.lifetimes[0].end > lifetime_end);
    let redone = EngineSessionV1::new(bundle)
        .unwrap()
        .apply_studio_creation_edit(command)
        .unwrap();
    assert_eq!(redone.bundle, result.bundle);
}

#[test]
fn normalized_creation_keeps_group_hierarchy_when_a_later_program_hides_every_child() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command
        .programs
        .push(second_group_resize_creation(&command.programs[0]));
    let child_ids = vec![
        "tx:create/entity:circle".to_owned(),
        "tx:second/entity:rectangle".to_owned(),
    ];
    let group_id = "tx:visible-group/entity:group".to_owned();
    command.programs.push(studio_hierarchy_edit_input(
        "visible-group",
        1.0,
        StudioCreationOperationKind::Group {
            child_entity_ids: child_ids.clone(),
            group_id: group_id.clone(),
        },
    ));
    let operations = child_ids
        .iter()
        .enumerate()
        .map(|(index, entity_id)| StudioCreationOperation {
            depends_on: vec![],
            entity_id: Some(entity_id.clone()),
            id: format!("hide-group-child-{index}"),
            interval: IntervalV1 {
                end: 1.1,
                start: 1.1,
            },
            kind: StudioCreationOperationKind::Visibility {
                visible: Some(false),
            },
            origin: StudioAuthoringOrigin::DirectManipulation,
        })
        .collect::<Vec<_>>();
    command.programs.push(StudioCreationEditInput {
        anchor_captured_playhead: 1.1,
        anchor_resolved_seconds: 1.1,
        anchor_source: SceneEditAnchorSource::Playhead {
            reference_seconds: Some(1.1),
        },
        intent_count: 1,
        lowering_supported: false,
        schedule_edge_count: 0,
        schedule_mode: SceneEditScheduleMode::Parallel,
        schedule_order: operations
            .iter()
            .map(|operation| operation.id.clone())
            .collect(),
        operations,
        origin: StudioAuthoringOrigin::DirectManipulation,
        requested_execution: SceneEditExecution::Parallel,
        transaction_id: "hide-visible-group".to_owned(),
    });

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();

    assert!(bundle_contains_entity(&result.bundle, &group_id));
    assert!(child_ids.iter().all(|child_id| {
        result
            .bundle
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == *child_id)
            .is_some_and(|entity| {
                !entity.visible && entity.parent_id.as_deref() == Some(group_id.as_str())
            })
    }));
    assert_eq!(
        result
            .creation_projection
            .as_ref()
            .unwrap()
            .mutations
            .iter()
            .filter(|mutation| matches!(
                mutation.kind,
                StudioCreationProjectedMutationKind::Visibility { visible: false }
            ))
            .count(),
        2
    );
}

#[test]
fn normalized_creation_rejects_grouping_a_rotation_keyframe_target() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    add_creation_rotation_segment(
        &mut command.programs[0],
        "tx:create/entity:circle",
        1.0,
        1.2,
        FRAC_PI_2,
    );
    command.programs.push(second_group_resize_creation(
        &studio_creation_command(&bundle).programs[0],
    ));
    command.programs.push(studio_hierarchy_edit_input(
        "rotation-keyframe-group",
        1.3,
        StudioCreationOperationKind::Group {
            child_entity_ids: vec![
                "tx:create/entity:circle".to_owned(),
                "tx:second/entity:rectangle".to_owned(),
            ],
            group_id: "tx:rotation-keyframe-group/entity:group".to_owned(),
        },
    ));

    let mut session = EngineSessionV1::new(bundle).unwrap();
    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
}

#[test]
fn normalized_creation_rejects_a_non_rigid_or_partial_group_rotation() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    let first_id = "tx:create/entity:circle";
    let second_id = "tx:second/entity:rectangle";
    let second_creation = second_group_resize_creation(&command.programs[0]);
    command.programs.push(second_creation);
    command.programs.push(studio_group_rotation_edit_input(
        &[
            (first_id, PointV1 { x: 400.0, y: 260.0 }),
            (second_id, PointV1 { x: 401.0, y: 100.0 }),
        ],
        FRAC_PI_2,
    ));
    let mut partial = command.clone();
    let partial_rotation = partial.programs.last_mut().unwrap();
    partial_rotation
        .operations
        .retain(|operation| operation.entity_id.as_deref() == Some(first_id));
    partial_rotation.schedule_order = partial_rotation
        .operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect();
    let mut disjoint = command.clone();
    let disjoint_rotation = disjoint.programs.last_mut().unwrap();
    disjoint_rotation.anchor_captured_playhead = 0.5;
    disjoint_rotation.anchor_resolved_seconds = 0.5;
    disjoint_rotation.anchor_source = SceneEditAnchorSource::Playhead {
        reference_seconds: Some(0.5),
    };
    disjoint_rotation.operations.retain(|operation| {
        matches!(operation.kind, StudioCreationOperationKind::Position { .. })
            && operation.entity_id.as_deref() == Some(first_id)
            || matches!(operation.kind, StudioCreationOperationKind::Rotation { .. })
                && operation.entity_id.as_deref() == Some(second_id)
    });
    for operation in &mut disjoint_rotation.operations {
        operation.interval = IntervalV1 {
            end: 0.5,
            start: 0.5,
        };
    }
    disjoint_rotation.schedule_order = disjoint_rotation
        .operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect();
    let original = bundle.scene.clone();
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &original);
    assert!(matches!(
        session.apply_studio_creation_edit(partial),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &original);
    assert!(matches!(
        session.apply_studio_creation_edit(disjoint),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &original);
}

#[test]
#[allow(
    clippy::float_cmp,
    reason = "the normalized command produces exact stored authoring values"
)]
fn normalized_creation_accepts_compiled_mathtex_and_folds_uniform_scale() {
    let bundle = static_imported_bundle();
    let mut command = studio_creation_command(&bundle);
    let tex_parts = vec!["E = mc^2".to_owned()];
    let entity_id = {
        let StudioCreationOperationKind::Create { entity } =
            &mut command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.kind = StudioAuthoringEntityKind::MathTex;
        entity.dimensions = StudioAuthoringDimensions::default();
        entity.tex_parts = Some(tex_parts.clone());
        entity.id.clone()
    };
    command.programs[1].operations[0].kind = StudioCreationOperationKind::UniformScale {
        control_present: false,
        from: Some(2.0),
        relative_factor: Some(1.5),
        to: Some(3.0),
    };
    let SceneGeometryV1::CubicPath { path } =
        fixture_bundle("mathtex-nested-radical-fraction.json")
            .scene
            .entities
            .remove(0)
            .geometry
    else {
        panic!("MathTex fixture must contain cubic-path geometry");
    };
    command.math_tex_outlines = vec![StudioCreationMathTexOutline {
        entity_id,
        path,
        tex_parts,
    }];
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let result = result.bundle;

    let created = result
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == "tx:create/entity:circle")
        .unwrap();
    assert!(matches!(
        created.geometry,
        SceneGeometryV1::CubicPath { .. }
    ));
    assert!(
        result
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::AffineTransform { entity_id, keyframes, .. }
                    if entity_id == "tx:create/entity:circle"
                        && keyframes[0].value.m11 == 1.5
                        && keyframes[0].value.m22 == 1.5
            ))
    );
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "one Text vertical-slice test pins projection, geometry, scale, and rotation"
)]
fn normalized_creation_accepts_compiled_text_and_existing_instant_followups() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let text = "日本語で動画を作る\nこんにちは";

    let mut scale_command = studio_text_creation_command(&bundle, text);
    scale_command.programs[1].operations[0].kind = StudioCreationOperationKind::UniformScale {
        control_present: false,
        from: Some(1.0),
        relative_factor: Some(1.5),
        to: Some(1.5),
    };
    let scale_projection =
        project_studio_creation_edits(bundle.scene.duration, &scale_command.programs).unwrap();
    assert_eq!(scale_projection.entities[0].text.as_deref(), Some(text));
    assert!(scale_projection.entities[0].layout.is_none());
    assert!(scale_projection.entities[0].tex_parts.is_none());
    let serialized_projection = serde_json::to_value(&scale_projection).unwrap();
    assert_eq!(serialized_projection["entities"][0]["kind"], "text");
    assert_eq!(serialized_projection["entities"][0]["text"], text);
    assert!(
        serialized_projection["entities"][0]
            .get("texParts")
            .is_none()
    );
    assert!(matches!(
        scale_projection.mutations.last().map(|mutation| &mutation.kind),
        Some(StudioCreationProjectedMutationKind::UniformScale { from, to, .. })
            if (*from - 1.0).abs() < 1e-12 && (*to - 1.5).abs() < 1e-12
    ));
    let mut scale_session = EngineSessionV1::new(bundle.clone()).unwrap();
    let scale_result = scale_session
        .apply_studio_creation_edit(scale_command)
        .unwrap();
    let scaled = scale_result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!(matches!(scaled.geometry, SceneGeometryV1::CubicPath { .. }));
    assert!(matches!(
        scaled.appearance,
        SceneAppearanceV1::Vector {
            fill: Some(_),
            stroke: None,
            ..
        }
    ));
    assert!(
        scale_result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::AffineTransform { entity_id: target, keyframes, .. }
                        if target == entity_id
                            && (keyframes[0].value.m11 - 1.5).abs() < 1e-12
                            && (keyframes[0].value.m22 - 1.5).abs() < 1e-12
                )
            })
    );

    let mut color_command = studio_text_creation_command(&bundle, "Color me");
    color_command.programs.truncate(1);
    color_command.programs.extend([
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "text-fill-red",
            StudioCreationOperationKind::FillColor {
                color: Some("#ef4444".to_owned()),
            },
        ),
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "text-fill-green",
            StudioCreationOperationKind::FillColor {
                color: Some("#22c55e".to_owned()),
            },
        ),
    ]);
    let color_projection =
        project_studio_creation_edits(bundle.scene.duration, &color_command.programs).unwrap();
    assert!(color_projection.mutations[3..].iter().all(|mutation| {
        (mutation.interval.start - 0.5).abs() < 1e-12 && (mutation.interval.end - 0.5).abs() < 1e-12
    }));
    assert!(matches!(
        color_projection.mutations.last().map(|mutation| &mutation.kind),
        Some(StudioCreationProjectedMutationKind::FillColor { value })
            if value == "#22c55e"
    ));
    let mut color_session = EngineSessionV1::new(bundle.clone()).unwrap();
    let color_result = color_session
        .apply_studio_creation_edit(color_command)
        .unwrap();
    let colored = color_result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!(matches!(
        &colored.appearance,
        SceneAppearanceV1::Vector { fill: Some(fill), stroke: None, .. }
            if (fill.color.red - 34.0 / 255.0).abs() < 1e-12
                && (fill.color.green - 197.0 / 255.0).abs() < 1e-12
                && (fill.color.blue - 94.0 / 255.0).abs() < 1e-12
                && (fill.color.alpha - 1.0).abs() < 1e-12
    ));
    assert!(
        color_result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::Opacity { entity_id: target, .. } if target == entity_id
            ))
    );
    assert!(!color_result.bundle.scene.animation_channels.iter().any(|channel| matches!(
            channel,
            AnimationChannelV1::VectorAppearance { entity_id: target, .. } if target == entity_id
        )));
    let packet = color_session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "initial-text-fill",
            sample_time: 0.7,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(packet.draws.iter().any(|draw| matches!(
        draw,
        poietra_scene_ir::RenderDrawV1::Path {
            entity_id: target,
            fill: Some(fill),
            opacity,
            ..
        } if target == entity_id
            && (fill.color.red - 34.0 / 255.0).abs() < 1e-12
            && (fill.color.green - 197.0 / 255.0).abs() < 1e-12
            && (fill.color.blue - 94.0 / 255.0).abs() < 1e-12
            && *opacity > 0.0
            && *opacity < 1.0
    )));

    let mut rotation_command = studio_text_creation_command(&bundle, "Hello, Poietra");
    rotation_command.programs.truncate(1);
    rotation_command
        .programs
        .push(studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "text-fill-before-rotation",
            StudioCreationOperationKind::FillColor {
                color: Some("#22c55e".to_owned()),
            },
        ));
    rotation_command
        .programs
        .push(studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "rotate-text",
            StudioCreationOperationKind::Rotation {
                control_present: false,
                from: Some(0.0),
                relative_delta: Some(std::f64::consts::FRAC_PI_4),
                to: Some(std::f64::consts::FRAC_PI_4),
            },
        ));
    let mut rotation_session = EngineSessionV1::new(bundle.clone()).unwrap();
    let rotation_result = rotation_session
        .apply_studio_creation_edit(rotation_command)
        .unwrap();
    assert!(
        rotation_result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::AffineTransform { entity_id: target, .. }
                        if target == entity_id
                )
            })
    );
    let rotation_packet = rotation_session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "initial-text-fill-before-rotation",
            sample_time: 0.7,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(rotation_packet.draws.iter().any(|draw| matches!(
        draw,
        poietra_scene_ir::RenderDrawV1::Path {
            entity_id: target,
            fill: Some(fill),
            opacity,
            ..
        } if target == entity_id
            && (fill.color.green - 197.0 / 255.0).abs() < 1e-12
            && *opacity > 0.0
            && *opacity < 1.0
    )));

    let mut math_tex_command = studio_text_creation_command(&bundle, "E = mc^2");
    math_tex_command.programs.truncate(1);
    let StudioCreationOperationKind::Create { entity } =
        &mut math_tex_command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.kind = StudioAuthoringEntityKind::MathTex;
    entity.text = None;
    entity.tex_parts = Some(vec!["E = mc^2".to_owned()]);
    math_tex_command.text_outlines.clear();
    math_tex_command.math_tex_outlines = vec![StudioCreationMathTexOutline {
        entity_id: entity_id.to_owned(),
        path: mathtex_fixture_path(),
        tex_parts: vec!["E = mc^2".to_owned()],
    }];
    let base_math_tex_command = math_tex_command.clone();
    math_tex_command
        .programs
        .push(studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "math-tex-fill",
            StudioCreationOperationKind::FillColor {
                color: Some("#22c55e".to_owned()),
            },
        ));
    let mut math_tex_session = EngineSessionV1::new(bundle.clone()).unwrap();
    math_tex_session
        .apply_studio_creation_edit(math_tex_command)
        .unwrap();
    let packet = math_tex_session
        .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "initial-math-tex-fill",
            sample_time: 0.7,
            viewport: poietra_scene_ir::ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
    assert!(packet.draws.iter().any(|draw| matches!(
        draw,
        poietra_scene_ir::RenderDrawV1::Path {
            entity_id: target,
            fill: Some(fill),
            opacity,
            ..
        } if target == entity_id
            && (fill.color.green - 197.0 / 255.0).abs() < 1e-12
            && *opacity > 0.0
            && *opacity < 1.0
    )));

    for unsupported in [
        studio_created_appearance_edit_input(
            0.5,
            entity_id,
            "math-tex-stroke",
            StudioCreationOperationKind::StrokeColor {
                color: Some("#22c55e".to_owned()),
            },
        ),
        studio_created_appearance_edit_input(
            0.75,
            entity_id,
            "math-tex-late-fill",
            StudioCreationOperationKind::FillColor {
                color: Some("#22c55e".to_owned()),
            },
        ),
    ] {
        let mut command = base_math_tex_command.clone();
        command.programs.push(unsupported);
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &command.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }
}

#[test]
fn normalized_creation_applies_nondefault_text_layout_in_the_initial_entity() {
    let legacy_layout: StudioTextLayout =
        serde_json::from_str(r#"{"alignment":"left","lineHeight":1.2}"#).unwrap();
    assert_eq!(legacy_layout, StudioTextLayout::default());
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_text_creation_command(&bundle, "Before");
    command.programs.truncate(1);
    let creation_lifetime = project_studio_creation_edits(bundle.scene.duration, &command.programs)
        .unwrap()
        .entities[0]
        .created_lifetime
        .clone();
    let updated = StudioTextContent {
        layout: StudioTextLayout {
            alignment: StudioTextAlignment::Right,
            font_family: StudioTextFontFamily::Mono,
            font_size: 1.5,
            font_weight: StudioTextFontWeight::Bold,
            line_height: 1.8,
        },
        text: "Wide\ni".to_owned(),
    };
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.layout = Some(updated.layout);
    entity.text = Some(updated.text.clone());
    let updated_path = scale_cubic_path(&command.text_outlines[0].path, updated.layout.font_size);
    command.text_outlines[0].layout = updated.layout;
    command.text_outlines[0].text.clone_from(&updated.text);

    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(projection.entities[0].layout, Some(updated.layout));
    assert_eq!(
        projection.entities[0].text.as_deref(),
        Some(updated.text.as_str())
    );
    assert!(
        (projection.entities[0].created_lifetime.start - creation_lifetime.start).abs()
            < f64::EPSILON
    );
    assert!(
        (projection.entities[0].created_lifetime.end - creation_lifetime.end).abs() < f64::EPSILON
    );

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert_eq!(
        created.geometry,
        SceneGeometryV1::CubicPath { path: updated_path }
    );
    assert_eq!(
        created.lifetimes,
        vec![projection.entities[0].created_lifetime.clone()]
    );
}

#[test]
fn normalized_creation_keeps_text_motion_fade_and_delete_on_the_shared_planner() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_text_creation_command(&bundle, "Move me");
    command.programs.truncate(1);
    command
        .programs
        .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
    command
        .programs
        .push(studio_persistent_remove_edit_input(entity_id, 1.8, 2.0));
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();
    assert_eq!(projection.motions.len(), 1);
    assert_eq!(projection.removals.len(), 1);

    let mut session = EngineSessionV1::new(bundle).unwrap();
    let result = session.apply_studio_creation_edit(command).unwrap();
    assert_eq!(result.creation_projection.as_ref(), Some(&projection));
    let created = result
        .bundle
        .scene
        .entities
        .iter()
        .find(|entity| entity.id == entity_id)
        .unwrap();
    assert!(
        (created.lifetimes[0].end - projection.removals[0].resulting_lifetime_end).abs() < 1e-12
    );
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::MotionPath { entity_id: target, .. }
                        if target == entity_id
                )
            })
    );
    assert!(
        result
            .bundle
            .scene
            .animation_channels
            .iter()
            .any(|channel| {
                matches!(
                    channel,
                    AnimationChannelV1::Opacity { entity_id: target, .. }
                        if target == entity_id
                )
            })
    );
}

#[test]
fn normalized_creation_rejects_missing_mismatched_or_empty_text_payloads() {
    let bundle = static_imported_bundle();
    let mut missing_outline = studio_text_creation_command(&bundle, "Hello");
    missing_outline.programs.truncate(1);
    missing_outline.text_outlines.clear();
    let mut mismatched_outline = studio_text_creation_command(&bundle, "Hello");
    mismatched_outline.programs.truncate(1);
    mismatched_outline.text_outlines[0].text = "Goodbye".to_owned();
    for command in [missing_outline, mismatched_outline] {
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &bundle.scene);
    }

    for invalid_text in [
        String::new(),
        "   ".to_owned(),
        "two\r\nlines".to_owned(),
        "tab\tcharacter".to_owned(),
        "Cafe\u{301}".to_owned(),
        ["a"; 9].join("\n"),
        "a".repeat(129),
        "a".repeat(257),
    ] {
        let mut command = studio_text_creation_command(&bundle, &invalid_text);
        command.programs.truncate(1);
        assert!(matches!(
            project_studio_creation_edits(bundle.scene.duration, &command.programs),
            Err(ProjectStudioCreationEditError::Unsupported)
        ));
    }
    for valid_text in [
        "日本語で動画を作る".to_owned(),
        "Caf\u{e9}".to_owned(),
        "こんにちは\nPoietra".to_owned(),
        "a".repeat(128),
    ] {
        let mut command = studio_text_creation_command(&bundle, &valid_text);
        command.programs.truncate(1);
        assert!(project_studio_creation_edits(bundle.scene.duration, &command.programs).is_ok());
    }
}

#[test]
fn normalized_creation_rejects_hidden_and_malformed_edits_atomically() {
    let bundle = static_imported_bundle();
    let mut unsupported = studio_creation_command(&bundle);
    unsupported.programs[1].operations[0].kind = StudioCreationOperationKind::Unsupported;
    let mut malformed_schedule = studio_creation_command(&bundle);
    malformed_schedule.programs[0].schedule_order.swap(0, 1);
    let mut malformed_anchor = studio_creation_command(&bundle);
    malformed_anchor.programs[0].anchor_resolved_seconds = -0.5;
    let mut malformed_interval = studio_creation_command(&bundle);
    malformed_interval.programs[1].operations[0].interval.start -= 0.1;
    let mut missing_dependency = studio_creation_command(&bundle);
    missing_dependency.programs[0].operations[1].depends_on = vec!["missing".to_owned()];
    let mut duplicate_transaction = studio_creation_command(&bundle);
    duplicate_transaction.programs[1].transaction_id =
        duplicate_transaction.programs[0].transaction_id.clone();
    let mut scale_ratio_mismatch = studio_creation_command(&bundle);
    scale_ratio_mismatch.programs[1].operations[0].kind =
        StudioCreationOperationKind::UniformScale {
            control_present: false,
            from: Some(1.0),
            relative_factor: Some(1.5),
            to: Some(2.0),
        };
    let mut stale_resize_baseline = studio_creation_command(&bundle);
    let StudioCreationOperationKind::Resize { from_scale, .. } =
        &mut stale_resize_baseline.programs[1].operations[0].kind
    else {
        unreachable!();
    };
    *from_scale = 1.25;

    for command in [
        unsupported,
        malformed_schedule,
        malformed_anchor,
        malformed_interval,
        missing_dependency,
        duplicate_transaction,
        scale_ratio_mismatch,
        stale_resize_baseline,
    ] {
        let expected = bundle.scene.clone();
        let mut session = EngineSessionV1::new(bundle.clone()).unwrap();
        assert!(matches!(
            session.apply_studio_creation_edit(command),
            Err(ApplyStudioCreationEditError::Unsupported)
        ));
        assert_eq!(session.scene(), &expected);
        assert_eq!(session.retained_index_stats().build_count, 1);
    }
}

#[test]
#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "the command produces exact stored authoring values; one end-to-end assertion covers the atomic batch"
)]
fn creates_entities_after_applying_timeline_insertions_in_order() {
    let mut bundle = imported_bundle();
    let AnimationChannelV1::Opacity { id, .. } = &mut bundle.scene.animation_channels[0] else {
        panic!("imported fixture must contain an opacity channel");
    };
    *id = "studio-opacity-4".to_owned();
    let original_entities = bundle.scene.entities.clone();
    let original_assets = bundle.assets.clone();
    let command = create_command(&bundle);
    let first_scene_order = bundle
        .scene
        .entities
        .iter()
        .map(|entity| entity.scene_order)
        .max()
        .unwrap()
        + 1;
    let first_source_z = bundle
        .scene
        .entities
        .iter()
        .map(|entity| entity.source_z_index)
        .fold(-1.0_f64, f64::max)
        + 1.0;
    let mut session = EngineSessionV1::new(bundle).unwrap();

    let result = session.create_scene_entities(command.clone()).unwrap();
    let result = result.bundle;

    assert_eq!(result.assets, original_assets);
    for (actual, original) in result.scene.entities[..original_entities.len()]
        .iter()
        .zip(&original_entities)
    {
        let mut expected = original.clone();
        expected.lifetimes = vec![IntervalV1 {
            end: 2.5,
            start: 0.0,
        }];
        assert_eq!(actual, &expected);
    }
    assert_eq!(result.scene.duration, 2.5);
    assert!(matches!(
        &result.scene.fidelity,
        FidelityV1::Approximate { evidence } if !evidence.is_empty()
    ));
    assert!(matches!(
        &result.scene.animation_channels[0],
        AnimationChannelV1::Opacity { keyframes, .. }
            if keyframes[0].at == 0.0 && keyframes[1].at == 2.5
    ));
    let created = &result.scene.entities[original_entities.len()..];
    assert_eq!(created.len(), 3);
    assert_eq!(
        created[0].lifetimes,
        vec![command.entities[0].lifetime.clone()]
    );
    assert!(matches!(
        created[0].geometry,
        SceneGeometryV1::Circle { radius: 0.75, .. }
    ));
    assert!(matches!(
        created[1].geometry,
        SceneGeometryV1::Rectangle {
            height: 2.0,
            width: 3.0,
            corner_radius: 0.0,
            ..
        }
    ));
    assert!(matches!(
        created[2].geometry,
        SceneGeometryV1::CubicPath { .. }
    ));
    for (entity, (expected_order, expected_z)) in created.iter().zip([
        (first_scene_order, first_source_z),
        (first_scene_order + 1, first_source_z + 1.0),
        (first_scene_order + 2, first_source_z + 2.0),
    ]) {
        assert_eq!(entity.parent_id, None);
        assert_eq!(entity.provenance_id, command.provenance.id);
        assert_eq!(entity.scene_order, expected_order);
        assert_eq!(entity.source_z_index, expected_z);
    }
    assert_eq!(created[0].transform.m11, 1.25);
    assert_eq!(created[0].transform.tx, 2.0);
    assert_eq!(created[0].transform.ty, -1.0);
    assert!(matches!(
        created[0].appearance,
        SceneAppearanceV1::Vector {
            fill: None,
            stroke: Some(_),
            ..
        }
    ));
    assert!(matches!(
        created[2].appearance,
        SceneAppearanceV1::Vector {
            fill: Some(_),
            stroke: None,
            ..
        }
    ));
    assert!(
        result
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::Opacity {
                    entity_id,
                    id,
                    keyframes,
                    provenance_id,
                    ..
                } if entity_id == "tx:create/entity:rectangle"
                    && id == "studio-opacity-4-1"
                    && keyframes[0].at == 0.5
                    && keyframes[0].value == 0.0
                    && keyframes[1].at == 0.9
                    && keyframes[1].value == 1.0
                    && provenance_id == "studio-create"
            ))
    );
    assert!(
        result
            .scene
            .animation_channels
            .iter()
            .any(|channel| matches!(
                channel,
                AnimationChannelV1::AffineTransform {
                    entity_id,
                    keyframes,
                    ..
                } if entity_id == "tx:create/entity:rectangle"
                    && keyframes[0].at == 1.25
                    && keyframes[0].value.tx == -1.0
                    && keyframes[0].value.m11 == 0.75
                    && keyframes[0].value.m22 == 1.0
                    && keyframes[1].at == 2.5
                    && keyframes[1].value == keyframes[0].value
            ))
    );
    assert!(
        result
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::CubicPathGeometry)
    );
    assert!(
        result
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::OpacityAnimation)
    );
    assert!(
        result
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::AffineTransformAnimation)
    );
    assert_eq!(result.scene.provenance.last(), Some(&command.provenance));
    assert_eq!(
        result.scene.source,
        SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: NEXT_REVISION.to_owned(),
        }
    );
    assert_eq!(session.scene(), &result.scene);
    assert_eq!(session.retained_index_stats().build_count, 2);

    let sample_transform = |time| {
        let packet = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "instant-transform-sample",
                sample_time: time,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        let draw = packet
            .draws
            .iter()
            .find(|draw| draw.entity_id() == "tx:create/entity:rectangle")
            .unwrap();
        match draw {
            poietra_scene_ir::RenderDrawV1::Path { transform, .. } => transform.clone(),
            _ => panic!("created rectangle must remain a path draw"),
        }
    };
    let before = sample_transform(1.249_999);
    assert_eq!(
        (before.m11, before.m22, before.tx, before.ty),
        (0.5, 0.5, -2.0, 1.0)
    );
    let at = sample_transform(1.25);
    assert_eq!((at.m11, at.m22, at.tx, at.ty), (0.75, 1.0, -1.0, 0.5));
    assert_eq!(sample_transform(2.0), at);
}

#[test]
fn creates_one_manifest_backed_image_through_the_canonical_session() {
    let bundle = fixture_bundle("png-alpha-edge-camera.json");
    let command = studio_image_creation_command(&bundle);
    let expected_image = {
        let StudioCreationOperationKind::Create { entity } =
            &command.programs[0].operations[0].kind
        else {
            unreachable!();
        };
        entity.image.clone().unwrap()
    };
    let mut session = EngineSessionV1::new(bundle.clone()).unwrap();

    let result = session.apply_studio_creation_edit(command).unwrap();
    let created = result.bundle.scene.entities.last().unwrap();

    assert_eq!(result.bundle.assets, bundle.assets);
    assert!(
        result
            .bundle
            .scene
            .required_capabilities
            .contains(&SceneCapabilityV1::PngImage)
    );
    assert!(matches!(
        &created.geometry,
        SceneGeometryV1::Image { asset, local_rect, sampler }
            if asset == &expected_image.asset
                && local_rect == &expected_image.local_rect
                && sampler == &expected_image.sampler
    ));
    assert!(matches!(
        created.appearance,
        SceneAppearanceV1::Image { opacity: 1.0 }
    ));
    let projection = result.creation_projection.unwrap();
    assert_eq!(
        projection.entities[0].kind,
        StudioAuthoringEntityKind::Image
    );
    assert_eq!(projection.entities[0].image.as_ref(), Some(&expected_image));
    assert_eq!(session.scene(), &result.bundle.scene);
}

#[test]
fn rejects_an_image_reference_outside_the_installed_manifest_atomically() {
    let bundle = fixture_bundle("png-alpha-edge-camera.json");
    let mut command = studio_image_creation_command(&bundle);
    let StudioCreationOperationKind::Create { entity } =
        &mut command.programs[0].operations[0].kind
    else {
        unreachable!();
    };
    entity.image.as_mut().unwrap().asset.sha256 = "f".repeat(64);
    let expected = bundle.scene.clone();
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.apply_studio_creation_edit(command),
        Err(ApplyStudioCreationEditError::Unsupported)
    ));
    assert_eq!(session.scene(), &expected);
    assert_eq!(session.retained_index_stats().build_count, 1);
}

#[test]
fn invalid_timeline_insertion_preserves_the_retained_scene() {
    let bundle = imported_bundle();
    let expected_scene = bundle.scene.clone();
    let expected_assets = bundle.assets.clone();
    let mut command = create_command(&bundle);
    command.timeline_insertions[0].duration = f64::INFINITY;
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.create_scene_entities(command),
        Err(CreateSceneEntitiesError::InvalidTimelineInsertion)
    ));
    assert_eq!(session.scene(), &expected_scene);
    assert_eq!(session.assets(), &expected_assets);
    assert_eq!(session.retained_index_stats().build_count, 1);
}

#[test]
fn invalid_instant_transform_preserves_the_retained_scene() {
    let bundle = imported_bundle();
    let expected_scene = bundle.scene.clone();
    let mut command = create_command(&bundle);
    let lifetime_start = command.entities[1].lifetime.start;
    command.entities[1].instant_transform.as_mut().unwrap().at = lifetime_start;
    let mut session = EngineSessionV1::new(bundle).unwrap();

    assert!(matches!(
        session.create_scene_entities(command),
        Err(CreateSceneEntitiesError::InvalidInstantTransform)
    ));
    assert_eq!(session.scene(), &expected_scene);
    assert_eq!(session.retained_index_stats().build_count, 1);
}

#[test]
fn creation_projector_rebases_fade_and_motion_from_the_created_position() {
    let bundle = static_imported_bundle();
    let entity_id = "tx:create/entity:circle";
    let mut command = studio_creation_command(&bundle);
    command.programs.truncate(1);
    command
        .programs
        .push(studio_created_motion_edit_input(vec![entity_id.to_owned()]));
    let projection =
        project_studio_creation_edits(bundle.scene.duration, &command.programs).unwrap();

    assert_eq!(projection.insertions.len(), 2);
    assert_eq!(projection.motions.len(), 1);
    assert_eq!(projection.motions[0].from, PointV1 { x: 320.0, y: 180.0 });
    assert_eq!(
        projection.motions[0].interval,
        IntervalV1 {
            start: 1.4,
            end: 2.4
        }
    );
    assert!((projection.projected_duration - (bundle.scene.duration + 1.4)).abs() < f64::EPSILON);
}
