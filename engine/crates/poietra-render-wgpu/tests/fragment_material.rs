#[allow(dead_code)]
mod support;

use poietra_render_wgpu::{
    DecodedPngAssetResolverV1, FragmentMaterialRegistryErrorV1, FragmentMaterialSourceV1,
    FragmentMaterialSupportV1, MAX_FRAGMENT_MATERIAL_DRAWS_PER_FRAME_V1, PrepareFrameErrorV1,
    PreparedGeometryCacheV1, PreparedRenderCommandV1, TIME_GRADIENT_SHADER_ID_V1,
    TIME_GRADIENT_SHADER_REVISION_V1, WgpuFillRendererV1, WgpuRenderTargetV1,
    compile_fragment_material_glsl, prepare_frame_v1,
    prepare_frame_with_cache_assets_and_fragment_materials_v1,
};
use poietra_scene_ir::{
    AssetReferenceV1, FragmentMaterialTextureV1, FragmentMaterialV1, ImageSamplerV1,
    RenderCapabilityV1, RenderDrawV1, StrokeCapV1,
};
use support::{straight_stroke_packet, time_gradient_paint_order_packet, verified_rgba_png};

#[test]
fn applies_fragment_material_to_fillless_stroke_without_changing_geometry() {
    let mut packet = straight_stroke_packet(StrokeCapV1::Round);
    let RenderDrawV1::Path {
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[0]
    else {
        unreachable!()
    };
    stroke.fragment_material = Some(FragmentMaterialV1 {
        parameters: vec![0.25],
        revision: TIME_GRADIENT_SHADER_REVISION_V1,
        shader_id: TIME_GRADIENT_SHADER_ID_V1.to_owned(),
        texture: None,
    });
    packet
        .required_capabilities
        .push(RenderCapabilityV1::FragmentMaterial);

    let prepared = prepare_frame_v1(&packet).expect("fill-less stroke material must prepare");
    assert_eq!(
        prepared.render_commands(),
        &[PreparedRenderCommandV1::FragmentMaterial { draw_index: 0 }]
    );
    assert!(
        prepared.material_plan().materials()[0]
            .fragment_material()
            .is_some()
    );

    let RenderDrawV1::Path {
        stroke: Some(stroke),
        ..
    } = &mut packet.draws[0]
    else {
        unreachable!()
    };
    stroke.fragment_material = None;
    packet.required_capabilities = vec![RenderCapabilityV1::CubicPathStroke];
    let solid = prepare_frame_v1(&packet).expect("equivalent solid stroke must prepare");
    assert_eq!(prepared.geometry_plan(), solid.geometry_plan());
}

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

struct TextureMaterialSupport;

impl FragmentMaterialSupportV1 for TextureMaterialSupport {
    fn supports_fragment_material(&self, shader_id: &str, revision: u32) -> bool {
        shader_id == "project-screen-texture" && revision == 1
    }

    fn has_fragment_material_texture_slot(&self, shader_id: &str, revision: u32) -> bool {
        self.supports_fragment_material(shader_id, revision)
    }
}

#[test]
fn resolves_each_fragment_material_draws_own_texture_and_sampler() {
    let (red_metadata, red) = verified_rgba_png("asset:red", 1, 1, &[255, 0, 0, 255]);
    let (green_metadata, green) = verified_rgba_png("asset:green", 1, 1, &[0, 255, 0, 255]);
    let resolver = |sha256: &str| match sha256 {
        digest if digest == red_metadata.sha256 => Some(std::sync::Arc::clone(&red)),
        digest if digest == green_metadata.sha256 => Some(std::sync::Arc::clone(&green)),
        _ => None,
    };
    let mut packet = time_gradient_paint_order_packet(0.0);
    let mut first = packet.draws[1].clone();
    let mut second = first.clone();
    for (draw, metadata, sampler, suffix, order) in [
        (&mut first, &red_metadata, ImageSamplerV1::Nearest, "red", 0),
        (
            &mut second,
            &green_metadata,
            ImageSamplerV1::Linear,
            "green",
            1,
        ),
    ] {
        let RenderDrawV1::Path {
            draw_id,
            entity_id,
            fill: Some(fill),
            paint_order,
            source_z_index,
            ..
        } = draw
        else {
            unreachable!()
        };
        *draw_id = format!("draw:{suffix}");
        *entity_id = format!("entity:{suffix}");
        *paint_order = order;
        *source_z_index = f64::from(order);
        fill.fragment_material = Some(FragmentMaterialV1 {
            parameters: Vec::new(),
            revision: 1,
            shader_id: "project-screen-texture".to_owned(),
            texture: Some(Box::new(FragmentMaterialTextureV1 {
                asset: AssetReferenceV1 {
                    asset_id: metadata.id.clone(),
                    sha256: metadata.sha256.clone(),
                },
                sampler,
            })),
        });
    }
    packet.draws = vec![first, second];
    packet.required_capabilities = vec![
        RenderCapabilityV1::CubicPathFill,
        RenderCapabilityV1::FragmentMaterial,
        RenderCapabilityV1::PngImage,
    ];

    let prepared = prepare_frame_with_cache_assets_and_fragment_materials_v1(
        &packet,
        &mut PreparedGeometryCacheV1::default(),
        &resolver,
        &TextureMaterialSupport,
    )
    .expect("both per-object material textures must resolve");
    let textures = prepared
        .material_plan()
        .materials()
        .iter()
        .map(|material| {
            let texture = material
                .fragment_material()
                .and_then(|material| material.texture())
                .expect("each draw must retain its own texture binding");
            (texture.asset().sha256(), texture.sampler())
        })
        .collect::<Vec<_>>();
    assert_eq!(
        textures,
        vec![
            (red_metadata.sha256.as_str(), ImageSamplerV1::Nearest),
            (green_metadata.sha256.as_str(), ImageSamplerV1::Linear),
        ]
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated GPU lane runs this proof"]
fn compiled_glsl_renders_and_invalid_replacement_preserves_the_active_registry() {
    const SHADER_ID: &str = "project-custom-proof";
    const SOURCE: &str = r"#version 450
layout(location = 0) in vec4 base_color;
layout(location = 1) in vec2 screen_position;
layout(location = 0) out vec4 output_color;

void main() {
    output_color = vec4(base_color.rgb * vec3(0.5, 1.0, 0.75), base_color.a);
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
    let wgsl = compile_fragment_material_glsl(SOURCE, "main")
        .expect("the supported GLSL fixture must compile to the host ABI");
    pollster::block_on(renderer.replace_fragment_material_sources(
        &device,
        &[FragmentMaterialSourceV1 {
            revision: 1,
            shader_id: SHADER_ID.to_owned(),
            source: wgsl,
            texture_slot: false,
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
        texture: None,
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
            texture_slot: false,
        }],
    ));
    assert!(matches!(
        rejected,
        Err(FragmentMaterialRegistryErrorV1::Compilation { .. })
    ));
    assert!(renderer.supports_fragment_material(SHADER_ID, 1));
}
