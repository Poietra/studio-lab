#[allow(dead_code)]
mod support;

use poietra_render_wgpu::{
    MAX_FRAGMENT_MATERIAL_DRAWS_PER_FRAME_V1, PrepareFrameErrorV1, PreparedRenderCommandV1,
    TIME_GRADIENT_SHADER_ID_V1, TIME_GRADIENT_SHADER_REVISION_V1, prepare_frame_v1,
};
use poietra_scene_ir::{RenderCapabilityV1, RenderDrawV1};
use support::time_gradient_paint_order_packet;

#[test]
fn reuses_fill_geometry_and_splits_solid_fragment_solid_paint_order() {
    let packet = time_gradient_paint_order_packet(0.25);
    let prepared = prepare_frame_v1(&packet).expect("time-gradient packet must prepare");

    assert_eq!(
        prepared.render_commands(),
        &[
            PreparedRenderCommandV1::Paint { draw_index: 0 },
            PreparedRenderCommandV1::FragmentMaterial { draw_index: 1 },
            PreparedRenderCommandV1::Paint { draw_index: 2 },
        ]
    );
    assert_eq!(prepared.sample_time().to_bits(), 0.25_f32.to_bits());
    let fragment = prepared.material_plan().materials()[1]
        .fragment_material()
        .expect("the middle fill must resolve its fragment material");
    let expected_parameters = [1.0_f32, 1.0, 0.0, 0.2, 0.0, 0.0, 0.0, 0.0];
    assert!(
        fragment
            .parameters()
            .iter()
            .zip(expected_parameters)
            .all(|(actual, expected)| actual.to_bits() == expected.to_bits())
    );

    let mut solid_packet = packet;
    let RenderDrawV1::Path {
        fill: Some(fill), ..
    } = &mut solid_packet.draws[1]
    else {
        unreachable!()
    };
    fill.fragment_material = None;
    solid_packet.required_capabilities = vec![RenderCapabilityV1::CubicPathFill];
    let solid = prepare_frame_v1(&solid_packet).expect("the equivalent solid packet must prepare");
    assert_eq!(prepared.geometry_plan(), solid.geometry_plan());
    assert_eq!(prepared.tessellation_calls(), solid.tessellation_calls());
}

#[test]
fn rejects_fragment_materials_outside_the_host_registry() {
    let mut packet = time_gradient_paint_order_packet(0.0);
    let RenderDrawV1::Path {
        fill: Some(fill), ..
    } = &mut packet.draws[1]
    else {
        unreachable!()
    };
    let material = fill.fragment_material.as_mut().unwrap();
    assert_eq!(material.shader_id, TIME_GRADIENT_SHADER_ID_V1);
    assert_eq!(material.revision, TIME_GRADIENT_SHADER_REVISION_V1);
    material.revision += 1;

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::UnsupportedFragmentMaterial {
            revision: 2,
            ref shader_id,
            ..
        }) if shader_id == TIME_GRADIENT_SHADER_ID_V1
    ));
}

#[test]
fn rejects_more_fragment_draws_than_the_per_frame_resource_bound() {
    let mut packet = time_gradient_paint_order_packet(0.0);
    let material_draw = packet.draws[1].clone();
    packet.draws.clear();
    for index in 0..=MAX_FRAGMENT_MATERIAL_DRAWS_PER_FRAME_V1 {
        let mut draw = material_draw.clone();
        let RenderDrawV1::Path {
            draw_id,
            entity_id,
            paint_order,
            source_z_index,
            ..
        } = &mut draw
        else {
            unreachable!()
        };
        *draw_id = format!("draw:fragment:{index}");
        *entity_id = format!("entity:fragment:{index}");
        let index_u32 = u32::try_from(index).unwrap();
        *paint_order = index_u32;
        *source_z_index = f64::from(index_u32);
        packet.draws.push(draw);
    }

    assert!(matches!(
        prepare_frame_v1(&packet),
        Err(PrepareFrameErrorV1::FragmentMaterialDrawLimit {
            ref draw_id,
            maximum_draws: MAX_FRAGMENT_MATERIAL_DRAWS_PER_FRAME_V1,
        }) if draw_id == "draw:fragment:64"
    ));
}
