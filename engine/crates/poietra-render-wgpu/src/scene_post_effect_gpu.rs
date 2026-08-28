use wgpu::util::DeviceExt;

use poietra_scene_ir::RenderCompositingV1;

const HOST_UNIFORM_FLOATS: usize = 12;
const HOST_UNIFORM_BYTES: usize = 48;
const HOST_UNIFORM_BUFFER_SIZE: u64 = 48;
const RGBA8_BYTES_PER_PIXEL: u64 = 4;

#[derive(Debug)]
struct SceneColorTarget {
    binding: wgpu::BindGroup,
    format: wgpu::TextureFormat,
    height_px: u32,
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    width_px: u32,
}

impl SceneColorTarget {
    fn matches(&self, format: wgpu::TextureFormat, width_px: u32, height_px: u32) -> bool {
        self.format == format && self.width_px == width_px && self.height_px == height_px
    }

    fn accounted_bytes(&self) -> Option<u64> {
        u64::from(self.width_px)
            .checked_mul(u64::from(self.height_px))?
            .checked_mul(RGBA8_BYTES_PER_PIXEL)
    }
}

#[derive(Debug)]
pub(crate) struct ScenePostEffectGpu {
    bind_group_layout: wgpu::BindGroupLayout,
    cairo_pipeline: wgpu::RenderPipeline,
    linear_pipeline: wgpu::RenderPipeline,
    target: Option<SceneColorTarget>,
    uniform_buffer: wgpu::Buffer,
}

impl ScenePostEffectGpu {
    pub(crate) fn new(
        device: &wgpu::Device,
        linear_target_format: wgpu::TextureFormat,
        cairo_target_format: wgpu::TextureFormat,
    ) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("poietra scene post-effect host ABI layout v1"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(HOST_UNIFORM_BUFFER_SIZE),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("poietra scene post-effect pipeline layout v1"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("rgb_split_post_effect.wgsl"));
        let create_pipeline = |label, format| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[],
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..wgpu::PrimitiveState::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let linear_pipeline = create_pipeline(
            "poietra linear-light RGB split post-effect pipeline v1",
            linear_target_format,
        );
        let cairo_pipeline = create_pipeline(
            "poietra Manim Cairo RGB split post-effect pipeline v1",
            cairo_target_format,
        );
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("poietra scene post-effect host ABI uniform v1"),
            contents: &[0; HOST_UNIFORM_BYTES],
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::UNIFORM,
        });
        Self {
            bind_group_layout,
            cairo_pipeline,
            linear_pipeline,
            target: None,
            uniform_buffer,
        }
    }

    pub(crate) fn clear_target(&mut self) {
        self.target = None;
    }

    #[allow(
        clippy::cast_precision_loss,
        reason = "the fixed shader ABI exposes viewport dimensions as f32"
    )]
    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        viewport: [u32; 2],
        sample_time: f32,
        parameters: &[f32; 8],
    ) {
        let [width_px, height_px] = viewport;
        let recreate_target = self
            .target
            .as_ref()
            .is_none_or(|target| !target.matches(format, width_px, height_px));
        if recreate_target {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("poietra scene post-effect color target v1"),
                size: wgpu::Extent3d {
                    depth_or_array_layers: 1,
                    height: height_px,
                    width: width_px,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("poietra scene post-effect host ABI binding v1"),
                layout: &self.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                ],
            });
            self.target = Some(SceneColorTarget {
                binding,
                format,
                height_px,
                _texture: texture,
                view,
                width_px,
            });
        }

        let mut values = [0.0_f32; HOST_UNIFORM_FLOATS];
        values[0] = width_px as f32;
        values[1] = height_px as f32;
        values[2] = sample_time;
        values[4..].copy_from_slice(parameters);
        let mut bytes = [0_u8; HOST_UNIFORM_BYTES];
        for (chunk, value) in bytes.chunks_exact_mut(4).zip(values) {
            chunk.copy_from_slice(&value.to_le_bytes());
        }
        queue.write_buffer(&self.uniform_buffer, 0, &bytes);
    }

    pub(crate) fn scene_view(&self) -> Option<&wgpu::TextureView> {
        self.target.as_ref().map(|target| &target.view)
    }

    pub(crate) fn record(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target_view: &wgpu::TextureView,
        compositing: RenderCompositingV1,
    ) -> Option<()> {
        let target = self.target.as_ref()?;
        let attachments = [Some(wgpu::RenderPassColorAttachment {
            view: target_view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                store: wgpu::StoreOp::Store,
            },
        })];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("poietra scene post-effect pass v1"),
            color_attachments: &attachments,
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        let pipeline = match compositing {
            RenderCompositingV1::LinearLight => &self.linear_pipeline,
            RenderCompositingV1::ManimCairoSrgb => &self.cairo_pipeline,
        };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &target.binding, &[]);
        pass.draw(0..3, 0..1);
        Some(())
    }

    pub(crate) fn accounted_bytes(&self) -> Option<u64> {
        self.target
            .as_ref()
            .map_or(Some(0), SceneColorTarget::accounted_bytes)
    }
}
