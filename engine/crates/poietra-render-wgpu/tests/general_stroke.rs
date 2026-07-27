#[allow(dead_code)]
mod support;

use poietra_render_wgpu::{PrepareFrameErrorV1, prepare_frame_v1};
use poietra_scene_ir::{
    CubicSegmentV1, PointV1, RenderCapabilityV1, RenderDrawV1, StrokeCapV1, StrokeJoinV1,
};

use support::{generic_stroke_fixture, straight_stroke_packet};

fn point(x: f64, y: f64) -> PointV1 {
    PointV1 { x, y }
}

fn line_segment(start: &PointV1, end: PointV1) -> CubicSegmentV1 {
    CubicSegmentV1 {
        control1: point(
            start.x + (end.x - start.x) / 3.0,
            start.y + (end.y - start.y) / 3.0,
        ),
        control2: point(
            start.x + (end.x - start.x) * (2.0 / 3.0),
            start.y + (end.y - start.y) * (2.0 / 3.0),
        ),
        end,
    }
}

fn clip_extents(frame: &poietra_render_wgpu::PreparedFrameV1) -> [f32; 4] {
    frame.geometry_plan().vertices().iter().fold(
        [
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
        ],
        |[minimum_x, maximum_x, minimum_y, maximum_y], vertex| {
            let [x, y] = vertex.position();
            [
                minimum_x.min(x),
                maximum_x.max(x),
                minimum_y.min(y),
                maximum_y.max(y),
            ]
        },
    )
}

fn set_join(packet: &mut poietra_scene_ir::RenderPacketV1, join: StrokeJoinV1, miter_limit: f64) {
    let RenderDrawV1::Path {
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[0]
    else {
        panic!("stroke fixture must be a path");
    };
    stroke.join = join;
    stroke.miter_limit = miter_limit;
}

#[test]
fn shared_fixture_samples_trim_morph_and_motion_before_general_stroke_paint() {
    let (packet, reference) = generic_stroke_fixture();
    assert!(
        reference
            .reason
            .contains("fill-before-translucent-stroke composition")
    );
    assert_eq!(
        packet.required_capabilities,
        vec![
            RenderCapabilityV1::CubicPathFill,
            RenderCapabilityV1::CubicPathStroke,
        ]
    );
    let RenderDrawV1::Path {
        path, transform, ..
    } = &packet.draws[0]
    else {
        panic!("animated curve must lower to a path");
    };
    assert_eq!(path.subpaths.len(), 1);
    assert_eq!(path.subpaths[0].segments.len(), 1);
    assert_ne!(
        path.subpaths[0].segments[0].end,
        point(-2.0, -2.0),
        "nonzero trim must emit a strict path prefix"
    );
    let sampled_control = &path.subpaths[0].segments[0].control1;
    assert!((sampled_control.x - -5.830_990_880_087_814).abs() <= 1.0e-12);
    assert!((sampled_control.y - 1.042_164_158_419_352).abs() <= 1.0e-12);
    assert!(
        transform.tx > 0.0,
        "nonzero motion sampling must translate the entity"
    );

    let frame = prepare_frame_v1(&packet).expect("sampled general stroke fixture must prepare");
    assert_eq!(
        frame
            .draws()
            .iter()
            .map(poietra_render_wgpu::PreparedDrawV1::draw_id)
            .collect::<Vec<_>>(),
        ["draw:0", "draw:1", "draw:2", "draw:2", "draw:3", "draw:4"]
    );
    assert_eq!(frame.tessellation_calls(), 6);
    for phases in frame.draws().windows(2) {
        assert_eq!(phases[0].index_range().end, phases[1].index_range().start);
        assert_eq!(phases[0].vertex_range().end, phases[1].vertex_range().start);
    }
}

#[test]
fn cap_join_and_miter_limit_variants_produce_bounded_distinct_meshes() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Round);
    {
        let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
            panic!("stroke fixture must be a path");
        };
        let start = point(-2.0, -2.0);
        let join = point(0.0, 2.0);
        let end = point(0.5, -2.0);
        path.subpaths[0].start = start.clone();
        path.subpaths[0].segments =
            vec![line_segment(&start, join.clone()), line_segment(&join, end)];
    }

    set_join(&mut packet, StrokeJoinV1::Miter, 8.0);
    let high_miter = prepare_frame_v1(&packet).expect("high miter limit must prepare");
    set_join(&mut packet, StrokeJoinV1::Miter, 1.0);
    let clipped_miter = prepare_frame_v1(&packet).expect("low miter limit must bevel safely");
    assert_ne!(high_miter.geometry_plan(), clipped_miter.geometry_plan());

    set_join(&mut packet, StrokeJoinV1::Bevel, 4.0);
    let bevel = prepare_frame_v1(&packet).expect("bevel join must prepare");
    set_join(&mut packet, StrokeJoinV1::Round, 4.0);
    let round = prepare_frame_v1(&packet).expect("round join must prepare");
    assert_ne!(bevel.geometry_plan(), round.geometry_plan());
    assert!(
        [high_miter, clipped_miter, bevel, round]
            .iter()
            .all(|frame| frame.geometry_plan().vertices().len() < 128)
    );
}

#[test]
fn world_stroke_width_tracks_camera_zoom_instead_of_object_scale() {
    let baseline_packet = straight_stroke_packet(StrokeCapV1::Butt);
    let baseline = prepare_frame_v1(&baseline_packet).unwrap();
    let baseline_height = clip_extents(&baseline)[3] - clip_extents(&baseline)[2];

    let mut zoomed_out_packet = baseline_packet.clone();
    zoomed_out_packet.camera.bottom = -9.0;
    zoomed_out_packet.camera.left = -16.0;
    zoomed_out_packet.camera.right = 16.0;
    zoomed_out_packet.camera.top = 9.0;
    let zoomed_out = prepare_frame_v1(&zoomed_out_packet).unwrap();
    let zoomed_out_height = clip_extents(&zoomed_out)[3] - clip_extents(&zoomed_out)[2];
    assert!((zoomed_out_height * 2.0 - baseline_height).abs() <= 1.0e-6);

    let mut object_scaled_packet = baseline_packet;
    let RenderDrawV1::Path { transform, .. } = &mut object_scaled_packet.draws[0] else {
        unreachable!()
    };
    transform.m22 = 100.0;
    let object_scaled = prepare_frame_v1(&object_scaled_packet).unwrap();
    let object_scaled_height = clip_extents(&object_scaled)[3] - clip_extents(&object_scaled)[2];
    assert!((object_scaled_height - baseline_height).abs() <= 1.0e-6);
}

#[test]
fn excessive_source_cubics_fail_before_stroke_tessellation() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    let mut start = point(-1.0, 0.0);
    let mut segments = Vec::with_capacity(2_049);
    for index in 0..2_049 {
        let direction = if index % 2 == 0 { 1.0 } else { -1.0 };
        let end = point(start.x + direction * 0.001, start.y + 0.001);
        segments.push(line_segment(&start, end.clone()));
        start = end;
    }
    path.subpaths[0].segments = segments;

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::StrokeSourceCubicLimit {
            maximum_cubics: 2_048,
            ..
        })
    ));
}

#[test]
fn summed_curve_complexity_fails_before_lyons_callback_flattening_loop() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    let RenderDrawV1::Path {
        path,
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[0]
    else {
        unreachable!()
    };
    stroke.join = StrokeJoinV1::Bevel;
    path.subpaths[0].start = point(0.0, 0.0);
    path.subpaths[0].segments = (0..43)
        .map(|_| CubicSegmentV1 {
            control1: point(6_553.6, 0.0),
            control2: point(-6_553.6, 0.0),
            end: point(0.0, 0.0),
        })
        .collect();

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::StrokeFlatteningLimit {
            maximum_segments: 32_768,
            ..
        })
    ));
}

#[test]
fn pixel_normalization_preserves_a_five_pixel_segment_at_extreme_zoom() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    packet.camera.bottom = -0.000_45;
    packet.camera.left = -0.000_8;
    packet.camera.right = 0.000_8;
    packet.camera.top = 0.000_45;
    let start = point(-0.000_025, 0.0);
    let end = point(0.000_025, 0.0);
    let RenderDrawV1::Path {
        path,
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[0]
    else {
        unreachable!()
    };
    path.subpaths[0].start = start.clone();
    path.subpaths[0].segments = vec![line_segment(&start, end)];
    stroke.width_world = 0.000_01;

    let frame = prepare_frame_v1(&packet).expect("five visible pixels must not collapse");
    let extents = clip_extents(&frame);
    let width_pixels = (extents[1] - extents[0]) * 160.0 * 0.5;
    assert!((width_pixels - 5.0).abs() <= 1.0e-4, "width={width_pixels}");
}

#[test]
fn huge_exact_f32_coordinates_fail_the_pixel_resolution_guard() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    let start = point(107_374_182.4, 0.0);
    let end = point(107_374_195.2, 0.0);
    let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    path.subpaths[0].start = start.clone();
    path.subpaths[0].segments = vec![CubicSegmentV1 {
        control1: start,
        control2: end.clone(),
        end,
    }];

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::StrokePrecisionLoss { .. })
    ));
}

#[test]
fn huge_round_stroke_fails_before_recursive_arc_tessellation() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Round);
    let RenderDrawV1::Path {
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[0]
    else {
        unreachable!()
    };
    stroke.width_world = 1_000_000_000.0;

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::StrokeArcComplexityLimit {
            maximum_depth: 15,
            ..
        })
    ));
}

#[test]
fn huge_square_stroke_fails_the_output_resolution_guard() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Square);
    let RenderDrawV1::Path {
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[0]
    else {
        unreachable!()
    };
    stroke.join = StrokeJoinV1::Bevel;
    stroke.width_world = 1_000_000_000.0;

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::StrokePrecisionLoss { .. })
    ));
}

#[test]
fn closed_multi_segment_strokes_ignore_open_path_caps() {
    let mut butt_packet = straight_stroke_packet(StrokeCapV1::Butt);
    let start = point(-1.0, -1.0);
    let right = point(1.0, -1.0);
    let top = point(0.0, 1.0);
    let RenderDrawV1::Path { path, .. } = &mut butt_packet.draws[0] else {
        unreachable!()
    };
    path.subpaths[0].closed = true;
    path.subpaths[0].start = start.clone();
    path.subpaths[0].segments = vec![
        line_segment(&start, right.clone()),
        line_segment(&right, top),
    ];

    let mut round_packet = butt_packet.clone();
    let RenderDrawV1::Path {
        stroke: Some(stroke),
        ..
    } = &mut round_packet.draws[0]
    else {
        unreachable!()
    };
    stroke.cap = StrokeCapV1::Round;

    let butt = prepare_frame_v1(&butt_packet).expect("closed butt fixture must prepare");
    let round = prepare_frame_v1(&round_packet).expect("closed round fixture must prepare");
    assert_eq!(butt.geometry_plan(), round.geometry_plan());
}
