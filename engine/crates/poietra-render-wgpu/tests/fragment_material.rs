#[allow(dead_code)]
mod support;

use poietra_render_wgpu::{
    DecodedPngAssetResolverV1, FragmentMaterialRegistryErrorV1, FragmentMaterialSourceV1,
    FragmentMaterialSupportV1, MAX_FRAGMENT_MATERIAL_DRAWS_PER_FRAME_V1, PrepareFrameErrorV1,
    PreparedGeometryCacheV1, PreparedRenderCommandV1, TIME_GRADIENT_SHADER_ID_V1,
    TIME_GRADIENT_SHADER_REVISION_V1, WgpuFillRendererV1, WgpuRenderTargetV1, prepare_frame_v1,
    prepare_frame_with_cache_assets_and_fragment_materials_v1,
};
use poietra_scene_ir::{FragmentMaterialV1, RenderCapabilityV1, RenderDrawV1};
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

struct NoAssets;

impl DecodedPngAssetResolverV1 for NoAssets {
    fn resolve_png_asset_v1(
        &self,
        _sha256: &str,
    ) -> Option<std::sync::Arc<poietra_render_wgpu::DecodedPngAssetV1>> {
        None
    }
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated GPU lane runs this proof"]
fn custom_wgsl_renders_and_invalid_replacement_preserves_the_active_registry() {
    const SHADER_ID: &str = "project-custom-proof";
    const SOURCE: &str = r"
struct FragmentInput {
    @builtin(position) position: vec4<f32>,
    @location(0) base_color: vec4<f32>,
    @location(1) screen_position: vec2<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    return vec4<f32>(input.base_color.rgb * vec3<f32>(0.5, 1.0, 0.75), input.base_color.a);
}
";
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        apply_limit_buckets: false,
        compatible_surface: None,
        force_fallback_adapter: true,
        power_preference: wgpu::PowerPreference::None,
    }))
    .expect("a fallback adapter is required for the project material proof");
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("poietra project fragment material proof device"),
        memory_hints: wgpu::MemoryHints::MemoryUsage,
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_defaults(),
        ..Default::default()
    }))
    .expect("the fallback adapter must create a proof device");
    let format = wgpu::TextureFormat::Rgba8UnormSrgb;
    let mut renderer = WgpuFillRendererV1::new(&device, format).unwrap();
    pollster::block_on(renderer.replace_fragment_material_sources(
        &device,
        &[FragmentMaterialSourceV1 {
            revision: 1,
            shader_id: SHADER_ID.to_owned(),
            source: SOURCE.to_owned(),
        }],
    ))
    .expect("the custom fragment source must compile");

    let mut packet = time_gradient_paint_order_packet(0.25);
    let RenderDrawV1::Path {
        fill: Some(fill), ..
    } = &mut packet.draws[1]
    else {
        unreachable!()
    };
    fill.fragment_material = Some(FragmentMaterialV1 {
        parameters: vec![0.25],
        revision: 1,
        shader_id: SHADER_ID.to_owned(),
    });
    let mut cache = PreparedGeometryCacheV1::default();
    let prepared = prepare_frame_with_cache_assets_and_fragment_materials_v1(
        &packet, &mut cache, &NoAssets, &renderer,
    )
    .expect("the packet must resolve the active custom registry");
    let [width_px, height_px] = prepared.viewport();
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("poietra custom fragment proof target"),
        size: wgpu::Extent3d {
            width: width_px,
            height: height_px,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&wgpu::TextureViewDescriptor::default());
    renderer
        .render(
            &device,
            &queue,
            WgpuRenderTargetV1 {
                format,
                height_px,
                view: &view,
                width_px,
            },
            &prepared,
        )
        .expect("the custom fragment material must submit one frame");

    let rejected = pollster::block_on(renderer.replace_fragment_material_sources(
        &device,
        &[FragmentMaterialSourceV1 {
            revision: 2,
            shader_id: "project-invalid-proof".to_owned(),
            source: "this is not valid WGSL".to_owned(),
        }],
    ));
    assert!(matches!(
        rejected,
        Err(FragmentMaterialRegistryErrorV1::Compilation { .. })
    ));
    assert!(renderer.supports_fragment_material(SHADER_ID, 1));
}
