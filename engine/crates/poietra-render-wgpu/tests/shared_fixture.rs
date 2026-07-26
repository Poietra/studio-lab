mod support;

use poietra_render_wgpu::{PrepareFrameErrorV1, UnsupportedDrawReasonV1, prepare_frame_v1};
use poietra_scene_ir::{RenderDrawV1, StrokeCapV1, StrokeJoinV1};

use support::{sampled_packet, straight_stroke_packet};

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

#[test]
fn prepares_shared_fixture_as_ordered_solid_paint_triangles() {
    let prepared = prepare_frame_v1(&sampled_packet()).expect("shared fixture must prepare");
    assert_eq!(prepared.viewport(), [160, 90]);
    for (actual, expected) in prepared.clear_color().into_iter().zip([0.0, 0.0, 0.0, 1.0]) {
        assert!((actual - expected).abs() <= f64::EPSILON);
    }
    assert_eq!(prepared.draws()[0].draw_id(), "draw:0");
    let first_index_end = prepared.draws()[0].index_range().end;
    let first_vertices =
        usize::try_from(first_index_end / 3 + 2).expect("fixture vertices must fit usize");
    assert_eq!(prepared.draws()[0].index_range(), &(0..first_index_end));
    assert_eq!(prepared.draws()[1].draw_id(), "draw:1");
    assert_eq!(prepared.draws()[1].index_range().start, first_index_end);
    let second_indices = prepared.draws()[1].index_range().len();
    let second_vertices = second_indices / 3 + 2;
    let second_index_end = prepared.draws()[1].index_range().end;
    assert_eq!(prepared.draws()[2].draw_id(), "draw:2");
    assert_eq!(
        prepared.draws()[2].index_range(),
        &(second_index_end..second_index_end + 54)
    );
    let stroke_vertices = 24;
    assert_eq!(
        prepared.vertices().len(),
        first_vertices + second_vertices + stroke_vertices
    );
    assert_eq!(
        prepared.indices().len(),
        usize::try_from(prepared.draws()[2].index_range().end).unwrap()
    );

    let first = prepared.vertices()[0];
    assert_close(first.position()[0], 0.0);
    assert_close(first.position()[1], 0.0);
    assert_color_close(first.premultiplied_linear_color(), [0.5, 0.0, 0.0, 0.5]);
    let later = prepared.vertices()[first_vertices];
    assert_close(later.position()[0], 0.1875);
    assert_close(later.position()[1], 0.0);
    assert_color_close(later.premultiplied_linear_color(), [0.0, 0.0, 1.0, 1.0]);
    let stroke = prepared.vertices()[first_vertices + second_vertices];
    assert_close(stroke.position()[0], -0.5);
    assert_close(stroke.position()[1], 5.0 / 9.0);
    assert_color_close(stroke.premultiplied_linear_color(), [0.0, 0.5, 0.0, 0.5]);
}

#[test]
fn one_unsupported_draw_rejects_the_complete_packet() {
    let mut packet = sampled_packet();
    let RenderDrawV1::Path { fill, stroke, .. } = &mut packet.draws[1] else {
        panic!("fixture draw must be a path");
    };
    let color = fill
        .as_ref()
        .expect("fixture path must have a fill")
        .color
        .clone();
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

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::FillAndStroke,
            ..
        })
    ));
}

#[test]
fn prepares_world_space_butt_and_square_line_caps() {
    let butt = prepare_frame_v1(&straight_stroke_packet(StrokeCapV1::Butt)).unwrap();
    assert_eq!(butt.vertices().len(), 4);
    assert_eq!(butt.indices().len(), 6);
    assert_eq!(butt.draws()[0].index_range(), &(0..6));
    assert_color_close(
        butt.vertices()[0].premultiplied_linear_color(),
        [0.0, 0.5, 0.0, 0.5],
    );
    let butt_positions = butt
        .vertices()
        .iter()
        .map(poietra_render_wgpu::PreparedVertexV1::position)
        .collect::<Vec<_>>();
    assert_eq!(
        butt_positions,
        vec![
            [-0.25, 1.0 / 9.0],
            [-0.25, -1.0 / 9.0],
            [0.25, 1.0 / 9.0],
            [0.25, -1.0 / 9.0],
        ]
    );

    let square = prepare_frame_v1(&straight_stroke_packet(StrokeCapV1::Square)).unwrap();
    assert_eq!(square.vertices().len(), 4);
    assert_eq!(square.indices().len(), 6);
    let x_extents = square
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
#[allow(clippy::float_cmp)] // Shared cap/body edges must be bit-identical after clip conversion.
fn prepares_round_caps_to_the_shared_pixel_tolerance() {
    let round = prepare_frame_v1(&straight_stroke_packet(StrokeCapV1::Round)).unwrap();
    assert_eq!(round.vertices().len(), 24);
    assert_eq!(round.indices().len(), 54);
    assert_eq!(
        round.vertices()[0].position(),
        round.vertices()[5].position()
    );
    assert_eq!(
        round.vertices()[1].position(),
        round.vertices()[13].position()
    );
    assert_eq!(
        round.vertices()[3].position(),
        round.vertices()[15].position()
    );
    assert_eq!(
        round.vertices()[2].position(),
        round.vertices()[23].position()
    );
    let x_extents = round
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
fn unsupported_stroke_topologies_fail_closed_with_specific_reasons() {
    let cases = [
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            path.subpaths[0].closed = true;
            (packet, UnsupportedDrawReasonV1::ClosedStrokeSubpath)
        },
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            let second_segment = path.subpaths[0].segments[0].clone();
            path.subpaths[0].segments.push(second_segment);
            (packet, UnsupportedDrawReasonV1::StrokeSegmentCount)
        },
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            path.subpaths.push(path.subpaths[0].clone());
            (packet, UnsupportedDrawReasonV1::MultipleSubpaths)
        },
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            path.subpaths[0].segments[0].control1.y = 0.25;
            (packet, UnsupportedDrawReasonV1::CurvedStroke)
        },
        {
            let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
            let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
                unreachable!()
            };
            let start = path.subpaths[0].start.clone();
            let segment = &mut path.subpaths[0].segments[0];
            segment.control1 = start.clone();
            segment.control2 = start.clone();
            segment.end = start;
            (packet, UnsupportedDrawReasonV1::DegenerateStroke)
        },
    ];

    for (packet, expected_reason) in cases {
        assert!(matches!(
            prepare_frame_v1(&packet),
            Err(PrepareFrameErrorV1::Unsupported { reason, .. }) if reason == expected_reason
        ));
    }
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
