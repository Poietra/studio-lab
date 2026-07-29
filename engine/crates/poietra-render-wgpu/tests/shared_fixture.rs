mod support;

use poietra_render_wgpu::{
    PrepareFrameErrorV1, PreparedGeometryCacheV1, UnsupportedDrawReasonV1,
    build_gpu_upload_plan_v1, prepare_frame_v1, prepare_frame_with_cache_v1,
    tessellate_validated_frame_v1, validate_frame_packet_v1,
};
use poietra_scene_ir::{
    CubicSegmentV1, PointV1, RenderDrawV1, RenderEmptyReasonV1, StrokeCapV1, StrokeJoinV1,
};
use sha2::{Digest, Sha256};

use support::{generic_stroke_packet_with_initial_trim, sampled_packet, straight_stroke_packet};

fn assert_close(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() <= 1.0e-6,
        "expected {expected}, received {actual}"
    );
}

fn assert_color_close(actual: [f32; 4], expected: [f32; 4]) {
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert_close(actual, expected);
    }
}

fn draw_color(frame: &poietra_render_wgpu::PreparedFrameV1, draw_index: usize) -> [f32; 4] {
    let material_index = usize::try_from(frame.draws()[draw_index].material_index())
        .expect("material index must fit usize");
    frame.material_plan().materials()[material_index].premultiplied_linear_color()
}

fn phase_bounds(frame: &poietra_render_wgpu::PreparedFrameV1, draw_index: usize) -> [f32; 4] {
    let range = frame.draws()[draw_index].vertex_range();
    let start = usize::try_from(range.start).unwrap();
    let end = usize::try_from(range.end).unwrap();
    frame.geometry_plan().vertices()[start..end]
        .iter()
        .map(poietra_render_wgpu::PreparedGeometryVertexV1::position)
        .fold(
            [
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
            ],
            |[min_x, min_y, max_x, max_y], [x, y]| {
                [min_x.min(x), min_y.min(y), max_x.max(x), max_y.max(y)]
            },
        )
}

fn assert_visual_frame_eq(
    actual: &poietra_render_wgpu::PreparedFrameV1,
    expected: &poietra_render_wgpu::PreparedFrameV1,
) {
    assert_eq!(actual.viewport(), expected.viewport());
    assert_eq!(actual.clear_color(), expected.clear_color());
    assert_eq!(actual.draws(), expected.draws());
    assert_eq!(actual.indices(), expected.indices());
    assert_eq!(
        actual.geometry_plan().vertices(),
        expected.geometry_plan().vertices()
    );
    assert_eq!(actual.material_plan(), expected.material_plan());
}

fn assert_cache_invalidation(
    baseline: &poietra_scene_ir::RenderPacketV1,
    changed: &poietra_scene_ir::RenderPacketV1,
    expected_misses: u64,
) {
    let mut cache = PreparedGeometryCacheV1::default();
    let cold = prepare_frame_with_cache_v1(baseline, &mut cache).unwrap();
    let phase_count = u64::try_from(cold.draws().len()).unwrap();
    assert_eq!(cold.tessellation_calls(), phase_count);

    let cached = prepare_frame_with_cache_v1(changed, &mut cache).unwrap();
    assert_eq!(cached.tessellation_calls(), expected_misses);
    assert_eq!(cache.frame_stats().misses(), expected_misses);
    assert_eq!(cache.frame_stats().hits(), phase_count - expected_misses);
    assert_visual_frame_eq(&cached, &prepare_frame_v1(changed).unwrap());
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn prepares_shared_fixture_as_ordered_solid_paint_triangles() {
    let prepared = prepare_frame_v1(&sampled_packet()).expect("shared fixture must prepare");
    assert_eq!(prepared.viewport(), [160, 90]);
    for (actual, expected) in prepared.clear_color().into_iter().zip([0.0, 0.0, 0.0, 1.0]) {
        assert!((actual - expected).abs() <= f64::EPSILON);
    }
    assert_eq!(prepared.draws()[0].draw_id(), "draw:0");
    assert_eq!(prepared.draws()[0].entity_id(), "earlier");
    assert_eq!(prepared.draws()[0].vertex_range().start, 0);
    assert!(!prepared.draws()[0].index_range().is_empty());
    assert_eq!(prepared.draws()[0].index_range().len() % 3, 0);
    let first_index_end = prepared.draws()[0].index_range().end;
    let first_vertex_end = prepared.draws()[0].vertex_range().end;
    assert_eq!(prepared.draws()[1].draw_id(), "draw:1");
    assert_eq!(prepared.draws()[1].entity_id(), "later");
    assert_eq!(prepared.draws()[1].index_range().start, first_index_end);
    assert_eq!(prepared.draws()[1].index_range().len() % 3, 0);
    assert_eq!(prepared.draws()[1].vertex_range().start, first_vertex_end);
    let second_vertex_end = prepared.draws()[1].vertex_range().end;
    let second_index_end = prepared.draws()[1].index_range().end;
    assert_eq!(prepared.draws()[2].draw_id(), "draw:2");
    assert_eq!(prepared.draws()[2].entity_id(), "stroke");
    assert_eq!(
        prepared.draws()[2].index_range(),
        &(second_index_end..second_index_end + 48)
    );
    let stroke_vertices = 18;
    assert_eq!(prepared.material_plan().materials().len(), 3);
    assert_eq!(
        prepared.geometry_plan().vertices().len(),
        usize::try_from(second_vertex_end).unwrap() + stroke_vertices
    );
    assert_eq!(
        prepared.indices().len(),
        usize::try_from(prepared.draws()[2].index_range().end).unwrap()
    );
    assert!(prepared.geometry_plan().vertices().iter().all(|vertex| {
        let [x, y] = vertex.position();
        x.is_finite() && y.is_finite()
    }));
    assert_color_close(draw_color(&prepared, 0), [0.5, 0.0, 0.0, 0.5]);
    assert_color_close(draw_color(&prepared, 1), [0.0, 0.0, 1.0, 1.0]);
    let stroke = prepared.geometry_plan().vertices()[usize::try_from(second_vertex_end).unwrap()];
    assert_close(stroke.position()[0], -0.25);
    assert_close(stroke.position()[1], 5.0 / 9.0);
    assert_color_close(draw_color(&prepared, 2), [0.0, 0.5, 0.0, 0.5]);
    assert!(prepared.clip_bounds_for_entity("missing").is_none());
}

#[test]
fn material_only_changes_leave_geometry_and_order_plans_unchanged() {
    let packet = sampled_packet();
    let baseline = prepare_frame_v1(&packet).unwrap();
    let mut recolored_packet = packet;
    let RenderDrawV1::Path {
        fill: Some(fill),
        opacity,
        ..
    } = &mut recolored_packet.draws[0]
    else {
        panic!("fixture first draw must be filled");
    };
    fill.color.green = 0.75;
    *opacity = 0.25;
    let recolored = prepare_frame_v1(&recolored_packet).unwrap();

    assert_eq!(baseline.geometry_plan(), recolored.geometry_plan());
    assert_eq!(baseline.ordered_draw_plan(), recolored.ordered_draw_plan());
    assert_ne!(baseline.material_plan(), recolored.material_plan());
}

#[test]
fn retained_geometry_cache_reuses_exact_phases_and_rejects_stale_draw_identity() {
    let packet = sampled_packet();
    let mut cache = PreparedGeometryCacheV1::default();

    let cold = prepare_frame_with_cache_v1(&packet, &mut cache).unwrap();
    assert_eq!(cold.tessellation_calls(), 3);
    assert_eq!(cache.frame_stats().hits(), 0);
    assert_eq!(cache.frame_stats().misses(), 3);
    assert_eq!(cache.entry_count(), 3);

    let warm = prepare_frame_with_cache_v1(&packet, &mut cache).unwrap();
    assert_eq!(warm.tessellation_calls(), 0);
    assert_eq!(cache.frame_stats().hits(), 3);
    assert_eq!(cache.frame_stats().misses(), 0);
    assert_visual_frame_eq(&warm, &prepare_frame_v1(&packet).unwrap());

    let mut material_only = packet.clone();
    let RenderDrawV1::Path {
        fill: Some(fill),
        opacity,
        ..
    } = &mut material_only.draws[0]
    else {
        panic!("fixture first draw must be filled");
    };
    fill.color.green = 0.75;
    *opacity = 0.25;
    let recolored = prepare_frame_with_cache_v1(&material_only, &mut cache).unwrap();
    assert_eq!(recolored.tessellation_calls(), 0);
    assert_eq!(cache.frame_stats().hits(), 3);
    assert_visual_frame_eq(&recolored, &prepare_frame_v1(&material_only).unwrap());

    let mut clear_color_only = material_only;
    clear_color_only.camera.clear_color.red = 0.125;
    let cleared = prepare_frame_with_cache_v1(&clear_color_only, &mut cache).unwrap();
    assert_eq!(cleared.tessellation_calls(), 0);
    assert_eq!(cache.frame_stats().hits(), 3);
    assert_visual_frame_eq(&cleared, &prepare_frame_v1(&clear_color_only).unwrap());

    let mut moved = clear_color_only;
    let RenderDrawV1::Path { transform, .. } = &mut moved.draws[0] else {
        panic!("fixture first draw must be a path");
    };
    transform.tx += 0.5;
    let stale_before = cache.stale_rejections();
    let moved_cached = prepare_frame_with_cache_v1(&moved, &mut cache).unwrap();
    assert_eq!(moved_cached.tessellation_calls(), 1);
    assert_eq!(cache.frame_stats().hits(), 2);
    assert_eq!(cache.frame_stats().misses(), 1);
    assert_eq!(cache.stale_rejections(), stale_before + 1);
    assert_visual_frame_eq(&moved_cached, &prepare_frame_v1(&moved).unwrap());

    let mut invalid = moved;
    invalid.viewport.width_px += 1;
    assert!(prepare_frame_with_cache_v1(&invalid, &mut cache).is_err());
    assert_eq!(cache.frame_stats().hits(), 0);
    assert_eq!(cache.frame_stats().misses(), 0);
}

#[test]
fn singular_affine_empty_is_draw_local_and_does_not_touch_geometry_cache() {
    let baseline_packet = sampled_packet();
    let mut cache = PreparedGeometryCacheV1::default();
    let baseline = prepare_frame_with_cache_v1(&baseline_packet, &mut cache).unwrap();
    assert_eq!(cache.frame_stats().misses(), 3);

    let mut singular_packet = baseline_packet.clone();
    let singular_draw = match &singular_packet.draws[1] {
        RenderDrawV1::Path {
            draw_id,
            entity_id,
            opacity,
            paint_order,
            source_z_index,
            transform,
            ..
        } => RenderDrawV1::Empty {
            draw_id: draw_id.clone(),
            entity_id: entity_id.clone(),
            opacity: *opacity,
            paint_order: *paint_order,
            reason: RenderEmptyReasonV1::SingularAffineSample,
            source_z_index: *source_z_index,
            transform: poietra_scene_ir::AffineTransformV1 {
                m11: 0.0,
                ..transform.clone()
            },
        },
        _ => panic!("fixture second draw must be a path"),
    };
    singular_packet.draws[1] = singular_draw;

    let singular = prepare_frame_with_cache_v1(&singular_packet, &mut cache).unwrap();
    assert_eq!(singular.tessellation_calls(), 0);
    assert_eq!(cache.frame_stats().hits(), 2);
    assert_eq!(cache.frame_stats().misses(), 0);
    assert_eq!(
        singular
            .draws()
            .iter()
            .map(poietra_render_wgpu::PreparedDrawV1::draw_id)
            .collect::<Vec<_>>(),
        ["draw:0", "draw:2"]
    );
    assert!(singular.clip_bounds_for_entity("earlier").is_some());
    assert!(singular.clip_bounds_for_entity("later").is_none());
    assert!(singular.clip_bounds_for_entity("stroke").is_some());
    assert_visual_frame_eq(&singular, &prepare_frame_v1(&singular_packet).unwrap());

    let mut reflected_packet = baseline_packet.clone();
    let RenderDrawV1::Path { transform, .. } = &mut reflected_packet.draws[1] else {
        unreachable!()
    };
    transform.m11 = -1.0;
    let reflected = prepare_frame_with_cache_v1(&reflected_packet, &mut cache).unwrap();
    assert_eq!(reflected.tessellation_calls(), 1);
    assert_eq!(cache.frame_stats().hits(), 2);
    assert_eq!(cache.frame_stats().misses(), 1);
    assert_eq!(
        reflected
            .draws()
            .iter()
            .map(poietra_render_wgpu::PreparedDrawV1::draw_id)
            .collect::<Vec<_>>(),
        ["draw:0", "draw:1", "draw:2"]
    );
    assert!(reflected.clip_bounds_for_entity("later").is_some());

    let identity_repeat = prepare_frame_with_cache_v1(&baseline_packet, &mut cache).unwrap();
    assert_eq!(identity_repeat.tessellation_calls(), 1);
    assert_eq!(cache.frame_stats().hits(), 2);
    assert_eq!(cache.frame_stats().misses(), 1);
    assert_visual_frame_eq(&identity_repeat, &baseline);

    let singular_repeat = prepare_frame_with_cache_v1(&singular_packet, &mut cache).unwrap();
    assert_eq!(singular_repeat.tessellation_calls(), 0);
    assert_eq!(cache.frame_stats().hits(), 2);
    assert_eq!(cache.frame_stats().misses(), 0);
    assert_visual_frame_eq(&singular_repeat, &singular);

    let mut unmarked_degenerate = baseline_packet;
    let RenderDrawV1::Path { transform, .. } = &mut unmarked_degenerate.draws[1] else {
        unreachable!()
    };
    transform.m11 = 0.0;
    assert!(matches!(
        prepare_frame_v1(&unmarked_degenerate),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::DegenerateFill,
            ..
        })
    ));
}

#[test]
fn retained_geometry_cache_invalidates_only_geometry_affecting_phases() {
    let baseline = sampled_packet();

    let mut camera = baseline.clone();
    camera.camera.left -= 0.25;
    camera.camera.right -= 0.25;
    assert_cache_invalidation(&baseline, &camera, 3);

    let mut viewport = baseline.clone();
    viewport.viewport.width_px += 16;
    viewport.viewport.height_px += 9;
    assert_cache_invalidation(&baseline, &viewport, 3);

    let mut morphed = baseline.clone();
    let RenderDrawV1::Path { path, .. } = &mut morphed.draws[0] else {
        panic!("fixture first draw must be a path");
    };
    path.subpaths[0].segments[0].control1.x += 0.125;
    assert_cache_invalidation(&baseline, &morphed, 1);

    let mut hierarchy_transform = baseline.clone();
    let RenderDrawV1::Path { transform, .. } = &mut hierarchy_transform.draws[1] else {
        panic!("fixture second draw must be a path");
    };
    // Parent transforms are composed into this world transform by the evaluator.
    transform.ty += 0.25;
    assert_cache_invalidation(&baseline, &hierarchy_transform, 1);

    let stroke = straight_stroke_packet(StrokeCapV1::Round);
    let mut wider_stroke = stroke.clone();
    let RenderDrawV1::Path {
        stroke: Some(style),
        ..
    } = &mut wider_stroke.draws[0]
    else {
        panic!("stroke fixture must contain a stroke");
    };
    style.width_world *= 1.25;
    assert_cache_invalidation(&stroke, &wider_stroke, 1);

    let trim_start = generic_stroke_packet_with_initial_trim(0.25);
    let trim_end = generic_stroke_packet_with_initial_trim(0.75);
    assert_cache_invalidation(&trim_start, &trim_end, 1);
}

#[test]
fn one_thousand_static_shapes_have_zero_warm_retessellation() {
    let mut packet = sampled_packet();
    let template = packet.draws[0].clone();
    packet.draws = (0..1_000)
        .map(|index| {
            let mut draw = template.clone();
            let RenderDrawV1::Path {
                draw_id,
                entity_id,
                paint_order,
                source_z_index,
                ..
            } = &mut draw
            else {
                panic!("fixture first draw must be a path");
            };
            *draw_id = format!("draw:static:{index}");
            *entity_id = format!("entity:static:{index}");
            *paint_order = index;
            *source_z_index = f64::from(index);
            draw
        })
        .collect();
    packet.required_capabilities = vec![poietra_scene_ir::RenderCapabilityV1::CubicPathFill];
    let mut cache = PreparedGeometryCacheV1::default();

    let cold = prepare_frame_with_cache_v1(&packet, &mut cache).unwrap();
    assert_eq!(cold.tessellation_calls(), 1_000);
    assert_eq!(cache.frame_stats().misses(), 1_000);
    let warm = prepare_frame_with_cache_v1(&packet, &mut cache).unwrap();
    assert_eq!(warm.tessellation_calls(), 0);
    assert_eq!(cache.frame_stats().hits(), 1_000);
    assert_eq!(cache.frame_stats().misses(), 0);
    assert_visual_frame_eq(&warm, &prepare_frame_v1(&packet).unwrap());
}

#[test]
fn retained_geometry_cache_is_bounded_evictable_and_clearable() {
    let packet = sampled_packet();
    let mut cache = PreparedGeometryCacheV1::with_limits(usize::MAX, 2);
    prepare_frame_with_cache_v1(&packet, &mut cache).unwrap();
    assert_eq!(cache.entry_count(), 2);
    assert_eq!(cache.evictions(), 1);
    assert!(cache.accounted_bytes() > 0);

    cache.clear();
    assert_eq!(cache.entry_count(), 0);
    assert_eq!(cache.accounted_bytes(), 0);
    assert_eq!(cache.frame_stats().hits(), 0);
    assert_eq!(cache.frame_stats().misses(), 0);

    let mut disabled = PreparedGeometryCacheV1::with_limits(1, 2);
    prepare_frame_with_cache_v1(&packet, &mut disabled).unwrap();
    assert_eq!(disabled.entry_count(), 0);
    assert!(disabled.accounted_bytes() <= 1);

    let mut first = sampled_packet();
    first.draws.truncate(1);
    first.required_capabilities = vec![poietra_scene_ir::RenderCapabilityV1::CubicPathFill];
    let mut sizing = PreparedGeometryCacheV1::with_limits(usize::MAX, usize::MAX);
    prepare_frame_with_cache_v1(&first, &mut sizing).unwrap();
    let one_phase_bytes = sizing.accounted_bytes();

    let mut byte_bounded = PreparedGeometryCacheV1::with_limits(one_phase_bytes, usize::MAX);
    prepare_frame_with_cache_v1(&first, &mut byte_bounded).unwrap();
    let mut second = first;
    let RenderDrawV1::Path { draw_id, .. } = &mut second.draws[0] else {
        unreachable!()
    };
    *draw_id = "draw:x".to_owned();
    prepare_frame_with_cache_v1(&second, &mut byte_bounded).unwrap();
    assert_eq!(byte_bounded.entry_count(), 1);
    assert_eq!(byte_bounded.evictions(), 1);
    assert!(byte_bounded.accounted_bytes() <= one_phase_bytes);
}

#[test]
fn retained_geometry_cache_evicts_the_least_recently_used_phase() {
    let packet_for = |suffix: &str| {
        let mut packet = sampled_packet();
        packet.draws.truncate(1);
        let RenderDrawV1::Path {
            draw_id, entity_id, ..
        } = &mut packet.draws[0]
        else {
            unreachable!()
        };
        *draw_id = format!("draw:lru:{suffix}");
        *entity_id = format!("entity:lru:{suffix}");
        packet.required_capabilities = vec![poietra_scene_ir::RenderCapabilityV1::CubicPathFill];
        packet
    };
    let [first, second, third] = [
        packet_for("first"),
        packet_for("second"),
        packet_for("third"),
    ];
    let mut cache = PreparedGeometryCacheV1::with_limits(usize::MAX, 2);

    prepare_frame_with_cache_v1(&first, &mut cache).unwrap();
    prepare_frame_with_cache_v1(&second, &mut cache).unwrap();
    prepare_frame_with_cache_v1(&first, &mut cache).unwrap();
    assert_eq!(cache.frame_stats().hits(), 1);
    prepare_frame_with_cache_v1(&third, &mut cache).unwrap();
    assert_eq!(cache.evictions(), 1);

    prepare_frame_with_cache_v1(&first, &mut cache).unwrap();
    assert_eq!(cache.frame_stats().hits(), 1);
    prepare_frame_with_cache_v1(&second, &mut cache).unwrap();
    assert_eq!(cache.frame_stats().misses(), 1);
}

#[test]
fn upload_bytes_pin_the_lyon_fill_and_stroke_layout() {
    let frame = prepare_frame_v1(&sampled_packet()).unwrap();
    let upload = build_gpu_upload_plan_v1(&frame).unwrap();

    assert_eq!(
        sha256(upload.vertex_bytes()),
        "ba828fe7f9d318922b4d01335606fb7b854ea25b4e8cb5e97674435f4918803f"
    );
    assert_eq!(
        sha256(upload.index_bytes()),
        "e3c20a1d80aca6fd3bad57d5a124681a7fc2029980b938ed22f38c4c17d532f5"
    );
}

#[test]
fn empty_frames_keep_all_plans_empty_and_need_no_upload() {
    let mut packet = sampled_packet();
    packet.draws.clear();
    packet.required_capabilities.clear();
    let frame = prepare_frame_v1(&packet).unwrap();

    assert!(frame.geometry_plan().vertices().is_empty());
    assert!(frame.geometry_plan().indices().is_empty());
    assert!(frame.material_plan().materials().is_empty());
    assert!(frame.ordered_draw_plan().draws().is_empty());
    assert!(build_gpu_upload_plan_v1(&frame).unwrap().is_empty());
}

#[test]
fn combined_paint_phases_do_not_hide_numeric_failure() {
    let mut packet = sampled_packet();
    let RenderDrawV1::Path {
        fill,
        stroke,
        transform,
        ..
    } = &mut packet.draws[1]
    else {
        panic!("fixture draw must be a path");
    };
    let color = fill.as_ref().unwrap().color.clone();
    *stroke = Some(poietra_scene_ir::StrokeStyleV1 {
        cap: StrokeCapV1::Butt,
        color,
        join: StrokeJoinV1::Miter,
        miter_limit: 4.0,
        width_world: 0.1,
    });
    transform.m11 = f64::MAX;
    packet.required_capabilities = vec![
        poietra_scene_ir::RenderCapabilityV1::CubicPathFill,
        poietra_scene_ir::RenderCapabilityV1::CubicPathStroke,
    ];

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::NumericRange { .. })
    ));
}

#[test]
fn fill_and_stroke_are_distinct_ordered_paint_phases() {
    let mut packet = sampled_packet();
    let RenderDrawV1::Path { fill, stroke, .. } = &mut packet.draws[1] else {
        panic!("fixture draw must be a path");
    };
    let mut color = fill
        .as_ref()
        .expect("fixture path must have a fill")
        .color
        .clone();
    color.red = 0.0;
    color.green = 1.0;
    color.blue = 0.0;
    *stroke = Some(poietra_scene_ir::StrokeStyleV1 {
        cap: poietra_scene_ir::StrokeCapV1::Butt,
        color,
        join: poietra_scene_ir::StrokeJoinV1::Miter,
        miter_limit: 4.0,
        width_world: 0.1,
    });
    packet.required_capabilities = vec![
        poietra_scene_ir::RenderCapabilityV1::CubicPathFill,
        poietra_scene_ir::RenderCapabilityV1::CubicPathStroke,
    ];

    let prepared = prepare_frame_v1(&packet).expect("combined paint must prepare");
    assert_eq!(prepared.draws().len(), 4);
    assert_eq!(prepared.tessellation_calls(), 4);
    assert_eq!(prepared.draws()[0].draw_id(), "draw:0");
    assert_eq!(prepared.draws()[1].draw_id(), "draw:1");
    assert_eq!(prepared.draws()[2].draw_id(), "draw:1");
    assert_eq!(prepared.draws()[1].entity_id(), "later");
    assert_eq!(prepared.draws()[2].entity_id(), "later");
    assert_eq!(prepared.draws()[3].draw_id(), "draw:2");
    assert_eq!(
        prepared.draws()[2].index_range().start,
        prepared.draws()[1].index_range().end
    );
    assert_eq!(
        prepared.draws()[3].index_range().start,
        prepared.draws()[2].index_range().end
    );
    assert_color_close(draw_color(&prepared, 1), [0.0, 0.0, 1.0, 1.0]);
    assert_color_close(draw_color(&prepared, 2), [0.0, 1.0, 0.0, 1.0]);

    let fill_bounds = phase_bounds(&prepared, 1);
    let stroke_bounds = phase_bounds(&prepared, 2);
    let expected_union = [
        fill_bounds[0].min(stroke_bounds[0]),
        fill_bounds[1].min(stroke_bounds[1]),
        fill_bounds[2].max(stroke_bounds[2]),
        fill_bounds[3].max(stroke_bounds[3]),
    ];
    assert_eq!(
        prepared.clip_bounds_for_entity("later"),
        Some(expected_union)
    );
    assert!(
        expected_union[0] < fill_bounds[0]
            || expected_union[1] < fill_bounds[1]
            || expected_union[2] > fill_bounds[2]
            || expected_union[3] > fill_bounds[3],
        "stroke geometry must expand the fill-only visual bounds"
    );
}

#[test]
fn prepares_world_space_butt_and_square_line_caps() {
    let butt = prepare_frame_v1(&straight_stroke_packet(StrokeCapV1::Butt)).unwrap();
    assert_eq!(butt.geometry_plan().vertices().len(), 4);
    assert_eq!(butt.indices().len(), 6);
    assert_eq!(butt.draws()[0].index_range(), &(0..6));
    assert_color_close(draw_color(&butt, 0), [0.0, 0.5, 0.0, 0.5]);
    let butt_positions = butt
        .geometry_plan()
        .vertices()
        .iter()
        .map(poietra_render_wgpu::PreparedGeometryVertexV1::position)
        .collect::<Vec<_>>();
    assert!(butt_positions.contains(&[-0.25, 1.0 / 9.0]));
    assert!(butt_positions.contains(&[-0.25, -1.0 / 9.0]));
    assert!(butt_positions.contains(&[0.25, 1.0 / 9.0]));
    assert!(butt_positions.contains(&[0.25, -1.0 / 9.0]));

    let square = prepare_frame_v1(&straight_stroke_packet(StrokeCapV1::Square)).unwrap();
    assert_eq!(square.geometry_plan().vertices().len(), 4);
    assert_eq!(square.indices().len(), 6);
    let x_extents = square
        .geometry_plan()
        .vertices()
        .iter()
        .map(|vertex| vertex.position()[0])
        .fold(
            [f32::INFINITY, f32::NEG_INFINITY],
            |[minimum, maximum], x| [minimum.min(x), maximum.max(x)],
        );
    assert_close(x_extents[0], -0.3125);
    assert_close(x_extents[1], 0.3125);

    let mut transformed_packet = straight_stroke_packet(StrokeCapV1::Butt);
    let RenderDrawV1::Path { transform, .. } = &mut transformed_packet.draws[0] else {
        unreachable!()
    };
    transform.m11 = 2.0;
    transform.m22 = 50.0;
    let transformed = prepare_frame_v1(&transformed_packet).unwrap();
    let y_extents = transformed
        .geometry_plan()
        .vertices()
        .iter()
        .map(|vertex| vertex.position()[1])
        .fold(
            [f32::INFINITY, f32::NEG_INFINITY],
            |[minimum, maximum], y| [minimum.min(y), maximum.max(y)],
        );
    assert_close(y_extents[0], -1.0 / 9.0);
    assert_close(y_extents[1], 1.0 / 9.0);
}

#[test]
fn prepares_round_caps_to_the_shared_pixel_tolerance() {
    let round = prepare_frame_v1(&straight_stroke_packet(StrokeCapV1::Round)).unwrap();
    assert_eq!(round.geometry_plan().vertices().len(), 18);
    assert_eq!(round.indices().len(), 48);
    let x_extents = round
        .geometry_plan()
        .vertices()
        .iter()
        .map(|vertex| vertex.position()[0])
        .fold(
            [f32::INFINITY, f32::NEG_INFINITY],
            |[minimum, maximum], x| [minimum.min(x), maximum.max(x)],
        );
    assert_close(x_extents[0], -0.3125);
    assert_close(x_extents[1], 0.3125);
}

#[test]
fn a_single_segment_has_no_join_or_miter_pixels() {
    let expected = prepare_frame_v1(&straight_stroke_packet(StrokeCapV1::Butt)).unwrap();
    for (join, miter_limit) in [
        (StrokeJoinV1::Bevel, 1.0),
        (StrokeJoinV1::Miter, 1_000.0),
        (StrokeJoinV1::Round, 4.0),
    ] {
        let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
        let RenderDrawV1::Path {
            stroke: Some(stroke),
            ..
        } = &mut packet.draws[0]
        else {
            panic!("stroke fixture must contain a stroke");
        };
        stroke.join = join;
        stroke.miter_limit = miter_limit;
        assert_eq!(prepare_frame_v1(&packet).unwrap(), expected);
    }
}

#[test]
fn general_stroke_accepts_closed_multi_segment_multi_subpath_and_curved_paths() {
    let cases = [
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            path.subpaths[0].closed = true;
            packet
        },
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            path.subpaths[0].segments.push(CubicSegmentV1 {
                control1: PointV1 {
                    x: 8.0 / 3.0,
                    y: 0.5,
                },
                control2: PointV1 {
                    x: 10.0 / 3.0,
                    y: 0.5,
                },
                end: PointV1 { x: 4.0, y: 0.0 },
            });
            packet
        },
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            path.subpaths.push(path.subpaths[0].clone());
            packet
        },
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            // The centerline stays within 0.25 px, but this vertical endpoint
            // tangent would rotate a width-1 butt cap by 90 degrees.
            path.subpaths[0].segments[0].control1 = PointV1 { x: -2.0, y: 0.02 };
            packet
        },
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            path.subpaths[0].segments[0].control1.x = -2.25;
            packet
        },
    ];

    for (case_index, packet) in cases.into_iter().enumerate() {
        let prepared = prepare_frame_v1(&packet)
            .unwrap_or_else(|error| panic!("general stroke topology case {case_index}: {error}"));
        assert_eq!(prepared.draws().len(), 1);
        assert!(!prepared.indices().is_empty());
    }
}

#[test]
fn a_fully_collapsed_stroke_segment_fails_closed() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    let start = path.subpaths[0].start.clone();
    let segment = &mut path.subpaths[0].segments[0];
    segment.control1 = start.clone();
    segment.control2 = start.clone();
    segment.end = start;

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::DegenerateStroke,
            ..
        })
    ));
}

#[test]
fn component_wise_morphed_line_is_prepared_by_general_stroke_tessellation() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    path.subpaths[0].start = PointV1 {
        x: -1.199_999_999_999_999_7,
        y: 0.0,
    };
    path.subpaths[0].segments[0] = CubicSegmentV1 {
        control1: PointV1 {
            x: -4.440_892_098_500_626e-16,
            y: 0.0,
        },
        control2: PointV1 {
            x: 1.199_999_999_999_999_7,
            y: 0.0,
        },
        end: PointV1 {
            x: 2.400_000_000_000_000_4,
            y: 0.0,
        },
    };

    let prepared = prepare_frame_v1(&packet).unwrap();
    assert_eq!(prepared.draws().len(), 1);
    assert_eq!(prepared.indices().len(), 6);
}

#[test]
fn non_degenerate_line_is_prepared_but_an_unmarked_collapsed_path_fails_closed() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    {
        let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
            unreachable!()
        };
        path.subpaths[0].start = PointV1 { x: -4.0, y: 0.0 };
        path.subpaths[0].segments[0] = CubicSegmentV1 {
            control1: PointV1 { x: -2.0, y: 0.0 },
            control2: PointV1 { x: 0.0, y: 0.0 },
            end: PointV1 { x: 2.0, y: 0.0 },
        };
    }
    assert!(prepare_frame_v1(&packet).is_ok());

    let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    path.subpaths[0].segments[0].control1 = path.subpaths[0].start.clone();
    path.subpaths[0].segments[0].control2 = path.subpaths[0].start.clone();
    path.subpaths[0].segments[0].end = path.subpaths[0].start.clone();
    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::DegenerateStroke,
            ..
        })
    ));
}

#[test]
fn explicit_zero_trim_keeps_other_draws_and_positive_trim_restores_geometry() {
    let empty_packet = generic_stroke_packet_with_initial_trim(0.0);
    assert!(matches!(
        empty_packet.draws.first(),
        Some(RenderDrawV1::Empty {
            reason: RenderEmptyReasonV1::PathTrimZero,
            ..
        })
    ));
    let empty_frame = prepare_frame_v1(&empty_packet).expect("explicit empty visual must prepare");
    assert!(empty_frame.clip_bounds_for_entity("curve").is_none());
    assert!(empty_frame.clip_bounds_for_entity("joined").is_some());
    assert!(!empty_frame.draws().is_empty());

    let positive_packet = generic_stroke_packet_with_initial_trim(0.001);
    assert!(matches!(
        positive_packet.draws.first(),
        Some(RenderDrawV1::Path { .. })
    ));
    let positive_frame =
        prepare_frame_v1(&positive_packet).expect("positive trim must produce renderable geometry");
    assert!(positive_frame.clip_bounds_for_entity("curve").is_some());
}

#[test]
fn large_world_coordinates_are_rebased_before_f32_stroke_tessellation() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    {
        let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
            unreachable!()
        };
        let start = PointV1 {
            x: 999_999_990.0,
            y: 0.0,
        };
        let end = PointV1 {
            x: 999_999_994.0,
            y: 0.0,
        };
        path.subpaths[0].start = start.clone();
        path.subpaths[0].segments[0] = CubicSegmentV1 {
            control1: PointV1 {
                x: start.x + (end.x - start.x) / 3.0,
                y: 0.000_01,
            },
            control2: PointV1 {
                x: start.x + (end.x - start.x) * (2.0 / 3.0),
                y: 0.000_01,
            },
            end,
        };
    }
    packet.camera.left = 999_999_984.0;
    packet.camera.right = 1_000_000_000.0;
    let prepared = prepare_frame_v1(&packet).expect("camera-relative stroke must preserve detail");
    assert_eq!(prepared.draws().len(), 1);
    assert!(!prepared.indices().is_empty());

    packet.camera.left = -8.0;
    packet.camera.right = 8.0;
    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::StrokePrecisionLoss { .. })
    ));
}

#[test]
fn tessellation_calls_count_actual_paint_phase_operations() {
    // The shared fixture holds three single-phase draws (two fills, one stroke).
    let prepared = prepare_frame_v1(&sampled_packet()).unwrap();
    assert_eq!(prepared.tessellation_calls(), 3);
    assert_eq!(prepared.tessellation_calls(), prepared.draws().len() as u64);

    let stroke = prepare_frame_v1(&straight_stroke_packet(StrokeCapV1::Butt)).unwrap();
    assert_eq!(stroke.tessellation_calls(), 1);
}

#[test]
fn split_prepare_phases_cannot_bypass_validation() {
    // The only path to `tessellate_validated_frame_v1` is the token returned
    // by `validate_frame_packet_v1`: `ValidatedRenderPacketV1` has a private
    // field and no public constructor, so an unvalidated packet cannot be
    // tessellated. This test pins the observable halves of that invariant.
    let packet = sampled_packet();
    let validated = validate_frame_packet_v1(&packet).expect("shared fixture must validate");
    let split = tessellate_validated_frame_v1(validated).expect("shared fixture must tessellate");
    let combined = prepare_frame_v1(&packet).expect("shared fixture must prepare");
    assert_eq!(split, combined);

    let mut invalid = sampled_packet();
    invalid.viewport.width_px = 0;
    assert!(matches!(
        validate_frame_packet_v1(&invalid),
        Err(PrepareFrameErrorV1::InvalidPacket(_))
    ));
    assert!(matches!(
        prepare_frame_v1(&invalid),
        Err(PrepareFrameErrorV1::InvalidPacket(_))
    ));
}

#[test]
fn transformed_coordinates_must_fit_f32_before_preparation_succeeds() {
    let mut packet = sampled_packet();
    let RenderDrawV1::Path { transform, .. } = &mut packet.draws[0] else {
        panic!("fixture draw must be a path");
    };
    transform.m11 = f64::MAX;

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::NumericRange { .. })
    ));
}
