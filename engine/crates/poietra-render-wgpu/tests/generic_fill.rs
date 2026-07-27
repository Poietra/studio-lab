#[allow(dead_code)]
mod support;

use std::collections::HashSet;

use poietra_render_wgpu::{PrepareFrameErrorV1, UnsupportedDrawReasonV1, prepare_frame_v1};
use poietra_scene_ir::{
    AffineTransformV1, CubicPathV1, CubicSegmentV1, CubicSubpathV1, FillRuleV1, PointV1,
    RenderCapabilityV1, RenderDrawV1,
};

use support::{generic_fill_fixture, sampled_packet};

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

fn closed_subpath(points: &[(f64, f64)]) -> CubicSubpathV1 {
    assert!(points.len() >= 3);
    let start = point(points[0].0, points[0].1);
    let mut previous = start.clone();
    let mut segments = Vec::with_capacity(points.len() - 1);
    for &(x, y) in &points[1..] {
        let end = point(x, y);
        segments.push(line_segment(&previous, end.clone()));
        previous = end;
    }
    CubicSubpathV1 {
        closed: true,
        segments,
        start,
    }
}

fn set_fill_path(draw: &mut RenderDrawV1, contours: &[&[(f64, f64)]], rule: FillRuleV1) {
    let RenderDrawV1::Path {
        fill,
        path,
        stroke,
        transform,
        ..
    } = draw
    else {
        panic!("fixture draw must be a path");
    };
    fill.as_mut().expect("fixture draw must have a fill").rule = rule;
    *path = CubicPathV1 {
        subpaths: contours
            .iter()
            .map(|points| closed_subpath(points))
            .collect(),
    };
    *stroke = None;
    *transform = AffineTransformV1::identity();
}

fn fill_packet(contours: &[&[(f64, f64)]], rule: FillRuleV1) -> poietra_scene_ir::RenderPacketV1 {
    let mut packet = sampled_packet();
    packet.draws.truncate(1);
    set_fill_path(&mut packet.draws[0], contours, rule);
    packet.required_capabilities = vec![RenderCapabilityV1::CubicPathFill];
    packet
}

fn scalloped_subpath(source_cubics: usize) -> CubicSubpathV1 {
    let source_cubics_u32 = u32::try_from(source_cubics).expect("fixture count must fit u32");
    let angle_step = std::f64::consts::TAU / f64::from(source_cubics_u32);
    let radial_point = |radius: f64, angle: f64| point(radius * angle.cos(), radius * angle.sin());
    CubicSubpathV1 {
        closed: true,
        segments: (0..source_cubics)
            .map(|index| {
                let index = u32::try_from(index).expect("fixture index must fit u32");
                let start_angle = f64::from(index) * angle_step;
                CubicSegmentV1 {
                    control1: radial_point(1_000.0, start_angle + angle_step / 3.0),
                    control2: radial_point(1_000.0, start_angle + angle_step * (2.0 / 3.0)),
                    end: radial_point(0.5, start_angle + angle_step),
                }
            })
            .collect(),
        start: radial_point(0.5, 0.0),
    }
}

fn scalloped_packet(source_cubics: usize) -> poietra_scene_ir::RenderPacketV1 {
    let mut packet = sampled_packet();
    packet.draws.truncate(2);
    let RenderDrawV1::Path {
        path,
        stroke,
        transform,
        ..
    } = &mut packet.draws[1]
    else {
        unreachable!()
    };
    *path = CubicPathV1 {
        subpaths: vec![scalloped_subpath(source_cubics)],
    };
    *stroke = None;
    *transform = AffineTransformV1::identity();
    packet.camera.bottom = -1.0;
    packet.camera.left = -1.0;
    packet.camera.right = 1.0;
    packet.camera.top = 1.0;
    packet.viewport.height_px = 4_096;
    packet.viewport.width_px = 4_096;
    packet.required_capabilities = vec![RenderCapabilityV1::CubicPathFill];
    packet
}

fn use_square_view(packet: &mut poietra_scene_ir::RenderPacketV1, extent: f64) {
    packet.camera.bottom = -extent;
    packet.camera.left = -extent;
    packet.camera.right = extent;
    packet.camera.top = extent;
    packet.viewport.height_px = 100;
    packet.viewport.width_px = 100;
}

fn draw_area(frame: &poietra_render_wgpu::PreparedFrameV1, draw_index: usize) -> f64 {
    let range = frame.draws()[draw_index].index_range();
    frame.indices()[usize::try_from(range.start).unwrap()..usize::try_from(range.end).unwrap()]
        .chunks_exact(3)
        .map(|triangle| {
            let position = |index| {
                frame.geometry_plan().vertices()[usize::try_from(index).unwrap()].position()
            };
            let [a, b, c] = [
                position(triangle[0]),
                position(triangle[1]),
                position(triangle[2]),
            ];
            let cross = (f64::from(b[0]) - f64::from(a[0])) * (f64::from(c[1]) - f64::from(a[1]))
                - (f64::from(b[1]) - f64::from(a[1])) * (f64::from(c[0]) - f64::from(a[0]));
            cross.abs() * 0.5
        })
        .sum()
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 1.0e-5,
        "expected {expected}, received {actual}"
    );
}

#[test]
fn shared_generic_fixture_preserves_topology_and_packet_paint_order() {
    let (packet, reference) = generic_fill_fixture();
    assert!(reference.reason.contains("edge antialiasing"));

    let frame = prepare_frame_v1(&packet).expect("concave fill must tessellate");
    assert_eq!(frame.draws()[0].draw_id(), "draw:0");
    assert_eq!(frame.draws()[1].draw_id(), "draw:1");
    assert_eq!(
        frame.draws()[0].index_range().end,
        frame.draws()[1].index_range().start
    );
    assert_close(draw_area(&frame, 0), 671.0 / 900.0);
    assert_close(draw_area(&frame, 1), 4.0 / 9.0);
}

#[test]
fn fill_rules_cover_holes_and_disjoint_subpaths() {
    const OUTER: &[(f64, f64)] = &[(-4.0, -4.0), (4.0, -4.0), (4.0, 4.0), (-4.0, 4.0)];
    const INNER_CCW: &[(f64, f64)] = &[(-2.0, -2.0), (2.0, -2.0), (2.0, 2.0), (-2.0, 2.0)];
    const DISJOINT: &[(f64, f64)] = &[(4.5, -0.5), (5.5, -0.5), (5.5, 0.5), (4.5, 0.5)];

    let mut even_odd = fill_packet(&[OUTER, INNER_CCW, DISJOINT], FillRuleV1::EvenOdd);
    use_square_view(&mut even_odd, 6.0);
    let even_odd = prepare_frame_v1(&even_odd).unwrap();
    assert_close(draw_area(&even_odd, 0), 49.0 / 36.0);

    let mut non_zero = fill_packet(&[OUTER, INNER_CCW, DISJOINT], FillRuleV1::NonZero);
    use_square_view(&mut non_zero, 6.0);
    let non_zero = prepare_frame_v1(&non_zero).unwrap();
    assert_close(draw_area(&non_zero, 0), 65.0 / 36.0);

    let inner_cw = INNER_CCW.iter().copied().rev().collect::<Vec<_>>();
    let mut winding_hole = fill_packet(&[OUTER, &inner_cw, DISJOINT], FillRuleV1::NonZero);
    use_square_view(&mut winding_hole, 6.0);
    assert_close(
        draw_area(&prepare_frame_v1(&winding_hole).unwrap(), 0),
        49.0 / 36.0,
    );
}

#[test]
fn self_intersection_is_resolved_without_dropping_a_lobe() {
    const BOW_TIE: &[(f64, f64)] = &[(-2.0, -2.0), (2.0, 2.0), (-2.0, 2.0), (2.0, -2.0)];
    let mut packet = fill_packet(&[BOW_TIE], FillRuleV1::EvenOdd);
    use_square_view(&mut packet, 5.0);

    let frame = prepare_frame_v1(&packet).expect("self-intersection must tessellate");
    assert_close(draw_area(&frame, 0), 8.0 / 25.0);
    assert!(
        frame
            .geometry_plan()
            .vertices()
            .iter()
            .any(|vertex| vertex.position() == [0.0, 0.0])
    );
}

#[test]
fn degenerate_and_f32_collapsed_fills_fail_closed() {
    const COLLINEAR: &[(f64, f64)] = &[(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)];
    const SUBPIXEL: &[(f64, f64)] = &[
        (7.999_999_99, -1.0),
        (8.0, -1.0),
        (8.0, 1.0),
        (7.999_999_99, 1.0),
    ];
    assert!(matches!(
        prepare_frame_v1(&fill_packet(&[COLLINEAR], FillRuleV1::NonZero)),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::DegenerateFill,
            ..
        })
    ));

    assert!(matches!(
        prepare_frame_v1(&fill_packet(&[SUBPIXEL], FillRuleV1::NonZero)),
        Err(PrepareFrameErrorV1::FillPrecisionLoss { .. })
    ));
}

#[test]
fn camera_relative_f64_math_prevents_large_world_coordinate_collapse() {
    const SQUARE: &[(f64, f64)] = &[(-2.0, -2.0), (2.0, -2.0), (2.0, 2.0), (-2.0, 2.0)];
    let mut packet = fill_packet(&[SQUARE], FillRuleV1::NonZero);
    let RenderDrawV1::Path { transform, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    transform.tx = 999_999_000.0;
    packet.camera.left = 999_998_992.0;
    packet.camera.right = 999_999_008.0;

    let frame =
        prepare_frame_v1(&packet).expect("camera-relative f64 subtraction must preserve shape");
    let x_positions = frame
        .geometry_plan()
        .vertices()
        .iter()
        .map(|vertex| vertex.position()[0].to_bits())
        .collect::<HashSet<_>>();
    assert!(x_positions.len() >= 2);
    assert_close(draw_area(&frame, 0), 4.0 / 9.0);
}

#[test]
fn ten_thousand_scalloped_cubics_fail_at_the_source_cap_without_a_partial_frame() {
    assert!(matches!(
        prepare_frame_v1(&scalloped_packet(10_000)),
        Err(PrepareFrameErrorV1::FillSourceCubicLimit {
            maximum_cubics: 2_048,
            ..
        })
    ));
}

#[test]
fn two_thousand_scalloped_cubics_fail_at_the_flatten_cap_without_a_partial_frame() {
    assert!(matches!(
        prepare_frame_v1(&scalloped_packet(2_000)),
        Err(PrepareFrameErrorV1::TessellationVertexLimit {
            maximum_vertices: 32_768,
            ..
        })
    ));
}
