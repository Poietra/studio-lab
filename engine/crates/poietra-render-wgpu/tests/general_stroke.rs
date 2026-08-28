#[allow(dead_code)]
mod support;

use poietra_render_wgpu::{
    PrepareFrameErrorV1, PreparedGeometryCacheV1, PreparedRenderCommandV1,
    TIME_GRADIENT_SHADER_ID_V1, TIME_GRADIENT_SHADER_REVISION_V1, UnsupportedDrawReasonV1,
    prepare_frame_v1, prepare_frame_with_cache_v1,
};
use poietra_scene_ir::{
    CubicPathV1, CubicSegmentV1, CubicSubpathV1, FillRuleV1, FillStyleV1, FragmentMaterialV1,
    PointV1, RenderCapabilityV1, RenderCompositingV1, RenderDrawV1, RgbaColorV1, StrokeCapV1,
    StrokeJoinV1,
};

use support::{
    generic_stroke_fixture, generic_stroke_packet_with_initial_trim, straight_stroke_packet,
};

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

fn lerp_point(source: [f64; 2], target: [f64; 2], progress: f64) -> PointV1 {
    point(
        source[0] + (target[0] - source[0]) * progress,
        source[1] + (target[1] - source[1]) * progress,
    )
}

#[allow(clippy::approx_constant, clippy::too_many_lines)]
// Captured f64 values, including asymmetric roundoff, are the regression fixture.
fn manim_square_to_circle_path(progress: f64) -> CubicPathV1 {
    // Exact f64 control points produced by Manim 0.20.1 Transform.begin()
    // after aligning Square().flip(RIGHT).rotate(-3 * TAU / 8) and Circle()
    // to eight cubics. The flip intentionally preserves the opposite winding.
    const SOURCE_START: [f64; 2] = [-1.414_213_562_373_095_1, -2.220_446_049_250_313e-16];
    const TARGET_START: [f64; 2] = [1.0, 0.0];
    const SOURCE: [[[f64; 2]; 3]; 8] = [
        [
            [-1.178_511_301_977_579_3, 0.235_702_260_395_515_64],
            [-0.942_809_041_582_063_5, 0.471_404_520_791_031_57],
            [-0.707_106_781_186_547_7, 0.707_106_781_186_547_4],
        ],
        [
            [-0.471_404_520_791_031_9, 0.942_809_041_582_063_4],
            [-0.235_702_260_395_516_06, 1.178_511_301_977_579_3],
            [-2.220_446_049_250_313e-16, 1.414_213_562_373_095_1],
        ],
        [
            [0.235_702_260_395_515_64, 1.178_511_301_977_579_3],
            [0.471_404_520_791_031_57, 0.942_809_041_582_063_5],
            [0.707_106_781_186_547_4, 0.707_106_781_186_547_7],
        ],
        [
            [0.942_809_041_582_063_4, 0.471_404_520_791_031_9],
            [1.178_511_301_977_579_3, 0.235_702_260_395_516_06],
            [1.414_213_562_373_095_1, 2.220_446_049_250_313e-16],
        ],
        [
            [1.178_511_301_977_579_3, -0.235_702_260_395_515_64],
            [0.942_809_041_582_063_5, -0.471_404_520_791_031_57],
            [0.707_106_781_186_547_7, -0.707_106_781_186_547_4],
        ],
        [
            [0.471_404_520_791_031_9, -0.942_809_041_582_063_4],
            [0.235_702_260_395_516_06, -1.178_511_301_977_579_3],
            [2.220_446_049_250_313e-16, -1.414_213_562_373_095_1],
        ],
        [
            [-0.235_702_260_395_515_64, -1.178_511_301_977_579_3],
            [-0.471_404_520_791_031_57, -0.942_809_041_582_063_5],
            [-0.707_106_781_186_547_4, -0.707_106_781_186_547_7],
        ],
        [
            [-0.942_809_041_582_063_4, -0.471_404_520_791_031_9],
            [-1.178_511_301_977_579_3, -0.235_702_260_395_516_06],
            [-1.414_213_562_373_095_1, -2.220_446_049_250_313e-16],
        ],
    ];
    const TARGET: [[[f64; 2]; 3]; 8] = [
        [
            [1.0, 0.265_216_489_839_544],
            [0.894_643_159_634_582_2, 0.519_570_402_738_512_8],
            [0.707_106_781_186_547_6, 0.707_106_781_186_547_5],
        ],
        [
            [0.519_570_402_738_513, 0.894_643_159_634_582_1],
            [0.265_216_489_839_544_05, 1.0],
            [6.123_233_995_736_766e-17, 1.0],
        ],
        [
            [-0.265_216_489_839_543_93, 1.0],
            [-0.519_570_402_738_512_8, 0.894_643_159_634_582_2],
            [-0.707_106_781_186_547_5, 0.707_106_781_186_547_6],
        ],
        [
            [-0.894_643_159_634_582_1, 0.519_570_402_738_513],
            [-1.0, 0.265_216_489_839_544_1],
            [-1.0, 1.224_646_799_147_353_2e-16],
        ],
        [
            [-1.0, -0.265_216_489_839_543_9],
            [-0.894_643_159_634_582_3, -0.519_570_402_738_512_8],
            [-0.707_106_781_186_547_7, -0.707_106_781_186_547_5],
        ],
        [
            [-0.519_570_402_738_513_1, -0.894_643_159_634_582_1],
            [-0.265_216_489_839_544_16, -1.0],
            [-1.836_970_198_721_029_7e-16, -1.0],
        ],
        [
            [0.265_216_489_839_543_8, -1.0],
            [0.519_570_402_738_512_6, -0.894_643_159_634_582_3],
            [0.707_106_781_186_547_4, -0.707_106_781_186_547_7],
        ],
        [
            [0.894_643_159_634_582_1, -0.519_570_402_738_513_1],
            [0.999_999_999_999_999_9, -0.265_216_489_839_544_2],
            [1.0, -2.449_293_598_294_706_4e-16],
        ],
    ];

    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments: SOURCE
                .into_iter()
                .zip(TARGET)
                .map(|(source, target)| CubicSegmentV1 {
                    control1: lerp_point(source[0], target[0], progress),
                    control2: lerp_point(source[1], target[1], progress),
                    end: lerp_point(source[2], target[2], progress),
                })
                .collect(),
            start: lerp_point(SOURCE_START, TARGET_START, progress),
        }],
    }
}

fn manim_square_to_circle_packet(progress: f64) -> poietra_scene_ir::RenderPacketV1 {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    let RenderDrawV1::Path {
        fill,
        opacity,
        path,
        stroke,
        ..
    } = &mut packet.draws[0]
    else {
        unreachable!()
    };
    // The endpoint colors keep both material passes visible in this geometry
    // regression; paint color does not participate in path tessellation.
    *fill = Some(FillStyleV1 {
        color: RgbaColorV1 {
            alpha: 0.5,
            blue: 189.0 / 255.0,
            green: 71.0 / 255.0,
            red: 209.0 / 255.0,
        },
        fragment_material: None,
        rule: FillRuleV1::NonZero,
    });
    *opacity = 1.0;
    *path = manim_square_to_circle_path(progress);
    let stroke = stroke.as_mut().expect("fixture must retain its stroke");
    stroke.color = RgbaColorV1 {
        alpha: 1.0,
        blue: 1.0,
        green: 1.0,
        red: 1.0,
    };
    stroke.join = StrokeJoinV1::Miter;
    stroke.miter_limit = 10.0;
    stroke.width_world = 0.04;
    packet.viewport.height_px = 360;
    packet.viewport.width_px = 640;
    packet.required_capabilities = vec![
        RenderCapabilityV1::CubicPathFill,
        RenderCapabilityV1::CubicPathStroke,
    ];
    packet
}

#[test]
fn transparent_degenerate_fill_is_skipped_before_visible_stroke_tessellation() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    let RenderDrawV1::Path { fill, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    *fill = Some(FillStyleV1 {
        color: RgbaColorV1 {
            alpha: 0.0,
            blue: 1.0,
            green: 0.0,
            red: 1.0,
        },
        fragment_material: None,
        rule: FillRuleV1::NonZero,
    });
    packet.required_capabilities = vec![
        RenderCapabilityV1::CubicPathFill,
        RenderCapabilityV1::CubicPathStroke,
    ];

    let mut cache = PreparedGeometryCacheV1::default();
    let frame = prepare_frame_with_cache_v1(&packet, &mut cache)
        .expect("a transparent degenerate fill must not hide its visible stroke");

    assert_eq!(frame.draws().len(), 1);
    assert_eq!(frame.material_plan().materials().len(), 1);
    assert_eq!(frame.tessellation_calls(), 1);
    assert_eq!(cache.entry_count(), 1);
    assert_eq!(cache.frame_stats().misses(), 1);
}

#[test]
fn zero_draw_opacity_skips_all_path_paint_phases() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    let RenderDrawV1::Path { fill, opacity, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    *fill = Some(FillStyleV1 {
        color: RgbaColorV1 {
            alpha: 1.0,
            blue: 1.0,
            green: 0.0,
            red: 1.0,
        },
        fragment_material: None,
        rule: FillRuleV1::NonZero,
    });
    *opacity = 0.0;
    packet.required_capabilities = vec![
        RenderCapabilityV1::CubicPathFill,
        RenderCapabilityV1::CubicPathStroke,
    ];

    let mut cache = PreparedGeometryCacheV1::default();
    let frame = prepare_frame_with_cache_v1(&packet, &mut cache)
        .expect("a fully transparent path must not require usable paint geometry");

    assert!(frame.draws().is_empty());
    assert!(frame.material_plan().materials().is_empty());
    assert_eq!(frame.tessellation_calls(), 0);
    assert_eq!(cache.entry_count(), 0);
    assert_eq!(cache.frame_stats().misses(), 0);
}

#[test]
fn exact_point_stroke_is_skipped_only_when_cairo_has_no_cap_coverage() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Butt);
    packet.compositing = RenderCompositingV1::ManimCairoSrgb;
    let RenderDrawV1::Path { path, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    let subpath = &mut path.subpaths[0];
    let start = point(subpath.start.x, subpath.start.y);
    subpath.segments[0].control1 = point(start.x, start.y);
    subpath.segments[0].control2 = point(start.x, start.y);
    subpath.segments[0].end = start;
    subpath.closed = true;

    let mut cache = PreparedGeometryCacheV1::default();
    let frame = prepare_frame_with_cache_v1(&packet, &mut cache)
        .expect("a closed exact-point subpath has no Cairo stroke coverage");
    assert!(frame.draws().is_empty());
    assert_eq!(cache.entry_count(), 0);

    let RenderDrawV1::Path { stroke, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    stroke.as_mut().expect("stroke paint must exist").cap = StrokeCapV1::Square;
    assert!(
        prepare_frame_v1(&packet)
            .expect("a closed square-cap point has no Cairo stroke coverage")
            .draws()
            .is_empty()
    );

    let RenderDrawV1::Path { stroke, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    stroke.as_mut().expect("stroke paint must exist").cap = StrokeCapV1::Round;
    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::DegenerateStroke,
            ..
        })
    ));

    let RenderDrawV1::Path { path, stroke, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    path.subpaths[0].closed = false;
    stroke.as_mut().expect("stroke paint must exist").cap = StrokeCapV1::Butt;
    assert!(
        prepare_frame_v1(&packet)
            .expect("an open butt-cap point has no Cairo stroke coverage")
            .draws()
            .is_empty()
    );

    let RenderDrawV1::Path { stroke, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    stroke.as_mut().expect("stroke paint must exist").cap = StrokeCapV1::Square;
    assert!(
        prepare_frame_v1(&packet)
            .expect("an open square-cap point has no Cairo stroke coverage")
            .draws()
            .is_empty()
    );

    let RenderDrawV1::Path { stroke, .. } = &mut packet.draws[0] else {
        unreachable!()
    };
    stroke.as_mut().expect("stroke paint must exist").cap = StrokeCapV1::Round;
    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::Unsupported {
            reason: UnsupportedDrawReasonV1::DegenerateStroke,
            ..
        })
    ));
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
fn dashed_stroke_uses_the_evaluated_trimmed_curve() {
    let mut packet = generic_stroke_packet_with_initial_trim(0.55);
    let solid = prepare_frame_v1(&packet).expect("the evaluated trimmed curve must prepare solid");
    let RenderDrawV1::Path {
        path,
        stroke: Some(stroke),
        ..
    } = packet
        .draws
        .iter_mut()
        .find(|draw| matches!(draw, RenderDrawV1::Path { entity_id, .. } if entity_id == "curve"))
        .expect("the evaluated fixture must retain its open curve draw")
    else {
        unreachable!()
    };
    assert!(!path.subpaths[0].closed);
    assert_ne!(
        path.subpaths[0].segments[0].end,
        point(-2.0, -2.0),
        "the renderer must receive the already-trimmed path"
    );
    stroke.dash_length_world = Some(0.4);
    stroke.gap_length_world = Some(0.2);

    let dashed =
        prepare_frame_v1(&packet).expect("the evaluated trimmed curve must prepare dashed");
    assert_ne!(solid.geometry_plan(), dashed.geometry_plan());
    assert!(dashed.geometry_plan().vertices().len() > solid.geometry_plan().vertices().len());
}

#[test]
fn fragment_material_stroke_prepares_the_evaluated_trimmed_curve() {
    let mut packet = generic_stroke_packet_with_initial_trim(0.55);
    let solid = prepare_frame_v1(&packet).expect("the evaluated trimmed curve must prepare solid");
    let draw_index = packet
        .draws
        .iter()
        .position(
            |draw| matches!(draw, RenderDrawV1::Path { entity_id, .. } if entity_id == "curve"),
        )
        .unwrap();
    let RenderDrawV1::Path {
        path,
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[draw_index]
    else {
        unreachable!()
    };
    assert!(!path.subpaths[0].closed);
    stroke.fragment_material = Some(FragmentMaterialV1 {
        parameters: vec![0.25],
        revision: TIME_GRADIENT_SHADER_REVISION_V1,
        shader_id: TIME_GRADIENT_SHADER_ID_V1.to_owned(),
        texture: None,
    });
    packet
        .required_capabilities
        .push(RenderCapabilityV1::FragmentMaterial);
    packet.required_capabilities.sort_unstable();
    packet.required_capabilities.dedup();

    let material = prepare_frame_v1(&packet)
        .expect("the evaluated trimmed curve with a static material must prepare");
    assert_eq!(material.geometry_plan(), solid.geometry_plan());
    let prepared_draw_index = u32::try_from(draw_index).unwrap();
    assert!(
        material
            .render_commands()
            .contains(&PreparedRenderCommandV1::FragmentMaterial {
                draw_index: prepared_draw_index,
            })
    );
    assert!(
        material.material_plan().materials()[draw_index]
            .fragment_material()
            .is_some_and(|material| material.texture().is_none())
    );
}

#[test]
fn dashed_material_stroke_matches_cached_and_uncached_geometry() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Round);
    let RenderDrawV1::Path {
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[0]
    else {
        unreachable!()
    };
    stroke.dash_length_world = Some(0.5);
    stroke.gap_length_world = Some(0.25);
    stroke.fragment_material = Some(FragmentMaterialV1 {
        parameters: vec![0.25],
        revision: poietra_render_wgpu::TIME_GRADIENT_SHADER_REVISION_V1,
        shader_id: poietra_render_wgpu::TIME_GRADIENT_SHADER_ID_V1.to_owned(),
        texture: None,
    });
    packet
        .required_capabilities
        .push(RenderCapabilityV1::FragmentMaterial);
    packet.required_capabilities.sort_unstable();

    let direct = prepare_frame_v1(&packet).expect("dashed material stroke must prepare");
    let mut cache = PreparedGeometryCacheV1::default();
    let cold = prepare_frame_with_cache_v1(&packet, &mut cache).expect("cold dash must prepare");
    let warm = prepare_frame_with_cache_v1(&packet, &mut cache).expect("warm dash must prepare");

    assert_eq!(
        direct.geometry_plan().indices(),
        cold.geometry_plan().indices()
    );
    assert_eq!(
        direct.geometry_plan().vertices(),
        cold.geometry_plan().vertices()
    );
    assert_eq!(
        direct.geometry_plan().indices(),
        warm.geometry_plan().indices()
    );
    assert_eq!(
        direct.geometry_plan().vertices(),
        warm.geometry_plan().vertices()
    );
    assert_eq!(warm.tessellation_calls(), 0);
    assert!(
        direct.material_plan().materials()[0]
            .fragment_material()
            .is_some()
    );
}

#[test]
fn manim_aligned_square_to_circle_fill_and_stroke_prepare_through_winding_change() {
    const CUBIC_SIGNED_AREA_ROOT: f64 = 0.530_158_360_440_676_8;
    // At 0.5, two non-adjacent endpoints share one f32 upload point while
    // differing by only 1.0658e-14 physical pixels in this 640x360 fixture.
    let mut cache = PreparedGeometryCacheV1::default();
    for progress in [
        0.0,
        0.5,
        CUBIC_SIGNED_AREA_ROOT - 1.0e-6,
        CUBIC_SIGNED_AREA_ROOT,
        CUBIC_SIGNED_AREA_ROOT + 1.0e-6,
        0.75,
        1.0,
    ] {
        let packet = manim_square_to_circle_packet(progress);
        let direct = prepare_frame_v1(&packet)
            .unwrap_or_else(|error| panic!("Manim morph progress {progress} failed: {error}"));
        let retained = prepare_frame_with_cache_v1(&packet, &mut cache).unwrap_or_else(|error| {
            panic!("retained Manim morph progress {progress} failed: {error}")
        });
        assert_eq!(direct.draws().len(), 2, "progress={progress}");
        assert!(!direct.indices().is_empty(), "progress={progress}");
        assert_eq!(direct.geometry_plan(), retained.geometry_plan());
        assert_eq!(direct.indices(), retained.indices());
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
