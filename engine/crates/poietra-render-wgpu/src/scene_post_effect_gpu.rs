use std::borrow::Cow;

use poietra_scene_ir::{
    ImageSamplerV1, MAX_SCENE_POST_EFFECTS_V1, PROJECT_SCENE_POST_EFFECT_SHADER_ID,
    RGB_SPLIT_POST_EFFECT_SHADER_ID, RGB_SPLIT_POST_EFFECT_SHADER_REVISION, RenderCompositingV1,
};
use wgpu::util::DeviceExt;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::{JsCast, JsValue};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_futures::JsFuture;

use crate::PreparedScenePostEffectV1;
use crate::image_gpu::{ImagePipelineV1, ImageTextureCacheV1};
use crate::scene_post_effect_wgsl::validate_scene_post_effect_wgsl;

pub const MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1: usize = 16 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScenePostEffectSourceV1 {
    pub revision: u32,
    pub shader_id: String,
    pub source: String,
    pub texture_slot: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ScenePostEffectRegistryErrorV1 {
    #[error("Scene post-effect registry accepts at most {maximum} sources")]
    TooManySources { maximum: usize },
    #[error("Scene post-effect registry repeats {shader_id}@{revision}")]
    Duplicate { revision: u32, shader_id: String },
    #[error("Scene post effect {shader_id}@{revision} uses the reserved built-in identity")]
    Reserved { revision: u32, shader_id: String },
    #[error("project Scene post-effect shader ID must be {PROJECT_SCENE_POST_EFFECT_SHADER_ID}")]
    InvalidShaderId,
    #[error("project Scene post-effect revision must be positive")]
    InvalidRevision,
    #[error(
        "Scene post effect {shader_id}@{revision} source must contain 1 to {maximum} UTF-8 bytes"
    )]
    SourceSize {
        maximum: usize,
        revision: u32,
        shader_id: String,
    },
    #[error("Scene post effect {shader_id}@{revision} did not compile: {message}")]
    Compilation {
        message: String,
        revision: u32,
        shader_id: String,
    },
}

/// Validates one admitted project identity, source bound, WGSL resources,
/// entry point, and fragment interface without allocating GPU resources.
///
/// # Errors
///
/// Returns a specific registry or compilation diagnostic for any mismatch.
pub fn validate_scene_post_effect_source_v1(
    source: &ScenePostEffectSourceV1,
) -> Result<(), ScenePostEffectRegistryErrorV1> {
    if source.shader_id == RGB_SPLIT_POST_EFFECT_SHADER_ID {
        return Err(ScenePostEffectRegistryErrorV1::Reserved {
            revision: source.revision,
            shader_id: source.shader_id.clone(),
        });
    }
    if source.shader_id != PROJECT_SCENE_POST_EFFECT_SHADER_ID {
        return Err(ScenePostEffectRegistryErrorV1::InvalidShaderId);
    }
    if source.revision == 0 {
        return Err(ScenePostEffectRegistryErrorV1::InvalidRevision);
    }
    if source.source.is_empty() || source.source.len() > MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1 {
        return Err(ScenePostEffectRegistryErrorV1::SourceSize {
            maximum: MAX_SCENE_POST_EFFECT_SOURCE_BYTES_V1,
            revision: source.revision,
            shader_id: source.shader_id.clone(),
        });
    }
    validate_scene_post_effect_wgsl(&source.source, source.texture_slot).map_err(|message| {
        ScenePostEffectRegistryErrorV1::Compilation {
            message,
            revision: source.revision,
            shader_id: source.shader_id.clone(),
        }
    })
}

/// Validates the complete bounded source registry before GPU installation.
///
/// # Errors
///
/// Rejects oversized registries, duplicate identities, or any invalid source.
pub fn validate_scene_post_effect_sources_v1(
    sources: &[ScenePostEffectSourceV1],
) -> Result<(), ScenePostEffectRegistryErrorV1> {
    if sources.len() > MAX_SCENE_POST_EFFECTS_V1 {
        return Err(ScenePostEffectRegistryErrorV1::TooManySources {
            maximum: MAX_SCENE_POST_EFFECTS_V1,
        });
    }
    for (index, source) in sources.iter().enumerate() {
        validate_scene_post_effect_source_v1(source)?;
        if sources[..index].iter().any(|earlier| {
            earlier.shader_id == source.shader_id && earlier.revision == source.revision
        }) {
            return Err(ScenePostEffectRegistryErrorV1::Duplicate {
                revision: source.revision,
                shader_id: source.shader_id.clone(),
            });
        }
    }
    Ok(())
}

const HOST_UNIFORM_FLOATS: usize = 12;
const HOST_UNIFORM_BYTES: usize = 48;
const HOST_UNIFORM_BUFFER_SIZE: u64 = 48;
const RGBA8_BYTES_PER_PIXEL: u64 = 4;

#[derive(Debug)]
struct ScenePostEffectPipelines {
    cairo: wgpu::RenderPipeline,
    linear: wgpu::RenderPipeline,
}

impl ScenePostEffectPipelines {
    fn for_compositing(&self, compositing: RenderCompositingV1) -> &wgpu::RenderPipeline {
        match compositing {
            RenderCompositingV1::LinearLight => &self.linear,
            RenderCompositingV1::ManimCairoSrgb => &self.cairo,
        }
    }
}

#[derive(Debug)]
struct ProjectScenePostEffectPipelines {
    pipelines: ScenePostEffectPipelines,
    revision: u32,
    shader_id: String,
    texture_slot: bool,
}

#[derive(Debug)]
struct SceneColorTarget {
    bindings: Vec<wgpu::BindGroup>,
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
struct SceneColorTargets {
    first: SceneColorTarget,
    second: SceneColorTarget,
}

impl SceneColorTargets {
    fn matches(&self, format: wgpu::TextureFormat, width_px: u32, height_px: u32) -> bool {
        self.first.matches(format, width_px, height_px)
            && self.second.matches(format, width_px, height_px)
    }

    fn accounted_bytes(&self) -> Option<u64> {
        self.first
            .accounted_bytes()?
            .checked_add(self.second.accounted_bytes()?)
    }
}

fn create_scene_color_target(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    extent: [u32; 2],
    label: &str,
) -> SceneColorTarget {
    let [width_px, height_px] = extent;
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            depth_or_array_layers: 1,
            height: height_px,
            width: width_px,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    SceneColorTarget {
        bindings: Vec::new(),
        format,
        height_px,
        _texture: texture,
        view,
        width_px,
    }
}

#[allow(clippy::too_many_arguments)]
fn create_scene_post_effect_bindings(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    scene_sampler: &wgpu::Sampler,
    uniform_buffers: &[wgpu::Buffer],
    input_view: &wgpu::TextureView,
    image_pipeline: &ImagePipelineV1,
    image_texture_cache: &ImageTextureCacheV1,
    fallback_texture_view: &wgpu::TextureView,
    effects: &[PreparedScenePostEffectV1],
) -> Option<Vec<wgpu::BindGroup>> {
    effects
        .iter()
        .zip(uniform_buffers)
        .enumerate()
        .map(|(index, (effect, uniform_buffer))| {
            let (auxiliary_view, auxiliary_sampler) = if let Some(texture) = effect.texture() {
                (
                    image_texture_cache.texture_view(texture.asset())?,
                    image_pipeline.sampler(texture.sampler()),
                )
            } else {
                (
                    fallback_texture_view,
                    image_pipeline.sampler(ImageSamplerV1::Linear),
                )
            };
            Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(&format!("poietra Scene post-effect input binding {index}")),
                layout: bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(input_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(scene_sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(auxiliary_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        resource: wgpu::BindingResource::Sampler(auxiliary_sampler),
                    },
                ],
            }))
        })
        .collect()
}

fn create_scene_post_effect_pipeline(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    format: wgpu::TextureFormat,
    vertex_shader: &wgpu::ShaderModule,
    fragment_shader: &wgpu::ShaderModule,
    label: &str,
) -> wgpu::RenderPipeline {
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("poietra scene post-effect pipeline layout v1"),
        bind_group_layouts: &[Some(bind_group_layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: vertex_shader,
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
            module: fragment_shader,
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
}

fn create_project_scene_post_effect_pipelines_v1(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    linear_target_format: wgpu::TextureFormat,
    cairo_target_format: wgpu::TextureFormat,
    source: &ScenePostEffectSourceV1,
) -> ProjectScenePostEffectPipelines {
    let vertex_shader =
        device.create_shader_module(wgpu::include_wgsl!("scene_post_effect_host_vertex.wgsl"));
    let shader_label = format!(
        "poietra project Scene post effect {}@{}",
        source.shader_id, source.revision
    );
    let fragment_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(&shader_label),
        source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(&source.source)),
    });
    ProjectScenePostEffectPipelines {
        pipelines: ScenePostEffectPipelines {
            cairo: create_scene_post_effect_pipeline(
                device,
                bind_group_layout,
                cairo_target_format,
                &vertex_shader,
                &fragment_shader,
                &format!("{shader_label} Manim Cairo pipeline"),
            ),
            linear: create_scene_post_effect_pipeline(
                device,
                bind_group_layout,
                linear_target_format,
                &vertex_shader,
                &fragment_shader,
                &format!("{shader_label} linear-light pipeline"),
            ),
        },
        revision: source.revision,
        shader_id: source.shader_id.clone(),
        texture_slot: source.texture_slot,
    }
}

#[cfg(target_arch = "wasm32")]
async fn create_scoped_project_scene_post_effect_pipelines_v1(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    linear_target_format: wgpu::TextureFormat,
    cairo_target_format: wgpu::TextureFormat,
    source: &ScenePostEffectSourceV1,
) -> Result<ProjectScenePostEffectPipelines, String> {
    let raw_device: JsValue = device
        .as_webgpu()
        .ok_or_else(|| "WebGPU device handle is unavailable".to_owned())?
        .clone()
        .into();
    let push = js_sys::Reflect::get(&raw_device, &JsValue::from_str("pushErrorScope"))
        .and_then(JsCast::dyn_into::<js_sys::Function>)
        .map_err(|error| format!("could not access WebGPU error scopes: {error:?}"))?;
    let pop = js_sys::Reflect::get(&raw_device, &JsValue::from_str("popErrorScope"))
        .and_then(JsCast::dyn_into::<js_sys::Function>)
        .map_err(|error| format!("could not access WebGPU error scopes: {error:?}"))?;
    push.call1(&raw_device, &JsValue::from_str("validation"))
        .map_err(|error| format!("could not push WebGPU validation scope: {error:?}"))?;

    let pipelines = create_project_scene_post_effect_pipelines_v1(
        device,
        bind_group_layout,
        linear_target_format,
        cairo_target_format,
        source,
    );
    let promise = pop
        .call0(&raw_device)
        .and_then(JsCast::dyn_into::<js_sys::Promise>)
        .map_err(|error| format!("could not pop WebGPU validation scope: {error:?}"))?;
    let error = JsFuture::from(promise)
        .await
        .map_err(|error| format!("WebGPU validation scope promise rejected: {error:?}"))?;
    if !error.is_null() && !error.is_undefined() {
        return Err(js_sys::Reflect::get(&error, &JsValue::from_str("message"))
            .ok()
            .and_then(|value| value.as_string())
            .unwrap_or_else(|| format!("{error:?}")));
    }
    Ok(pipelines)
}

#[derive(Debug)]
pub(crate) struct ScenePostEffectGpu {
    bind_group_layout: wgpu::BindGroupLayout,
    builtin: ScenePostEffectPipelines,
    cairo_target_format: wgpu::TextureFormat,
    custom: Vec<ProjectScenePostEffectPipelines>,
    linear_clamp_sampler: wgpu::Sampler,
    linear_target_format: wgpu::TextureFormat,
    targets: Option<SceneColorTargets>,
    uniform_buffers: Vec<wgpu::Buffer>,
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
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("rgb_split_post_effect.wgsl"));
        let builtin = ScenePostEffectPipelines {
            cairo: create_scene_post_effect_pipeline(
                device,
                &bind_group_layout,
                cairo_target_format,
                &shader,
                &shader,
                "poietra Manim Cairo RGB split post-effect pipeline v1",
            ),
            linear: create_scene_post_effect_pipeline(
                device,
                &bind_group_layout,
                linear_target_format,
                &shader,
                &shader,
                "poietra linear-light RGB split post-effect pipeline v1",
            ),
        };
        let uniform_buffers = (0..MAX_SCENE_POST_EFFECTS_V1)
            .map(|index| {
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some(&format!("poietra Scene post-effect pass {index} uniform")),
                    contents: &[0; HOST_UNIFORM_BYTES],
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::UNIFORM,
                })
            })
            .collect();
        let linear_clamp_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("poietra Scene post-effect linear clamp sampler v1"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..wgpu::SamplerDescriptor::default()
        });
        Self {
            bind_group_layout,
            builtin,
            cairo_target_format,
            custom: Vec::new(),
            linear_clamp_sampler,
            linear_target_format,
            targets: None,
            uniform_buffers,
        }
    }

    pub(crate) async fn replace_sources(
        &mut self,
        device: &wgpu::Device,
        sources: &[ScenePostEffectSourceV1],
    ) -> Result<(), ScenePostEffectRegistryErrorV1> {
        validate_scene_post_effect_sources_v1(sources)?;
        let mut candidates = Vec::with_capacity(sources.len());
        for source in sources {
            #[cfg(not(target_arch = "wasm32"))]
            let candidate = {
                let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
                let candidate = create_project_scene_post_effect_pipelines_v1(
                    device,
                    &self.bind_group_layout,
                    self.linear_target_format,
                    self.cairo_target_format,
                    source,
                );
                if let Some(error) = validation_scope.pop().await {
                    return Err(ScenePostEffectRegistryErrorV1::Compilation {
                        message: error.to_string(),
                        revision: source.revision,
                        shader_id: source.shader_id.clone(),
                    });
                }
                candidate
            };
            #[cfg(target_arch = "wasm32")]
            let candidate = create_scoped_project_scene_post_effect_pipelines_v1(
                device,
                &self.bind_group_layout,
                self.linear_target_format,
                self.cairo_target_format,
                source,
            )
            .await
            .map_err(|message| ScenePostEffectRegistryErrorV1::Compilation {
                message,
                revision: source.revision,
                shader_id: source.shader_id.clone(),
            })?;
            candidates.push(candidate);
        }
        self.custom = candidates;
        Ok(())
    }

    pub(crate) fn supports(&self, shader_id: &str, revision: u32) -> bool {
        (shader_id == RGB_SPLIT_POST_EFFECT_SHADER_ID
            && revision == RGB_SPLIT_POST_EFFECT_SHADER_REVISION)
            || self
                .custom
                .iter()
                .any(|custom| custom.shader_id == shader_id && custom.revision == revision)
    }

    pub(crate) fn has_texture_slot(&self, shader_id: &str, revision: u32) -> bool {
        self.custom.iter().any(|custom| {
            custom.shader_id == shader_id && custom.revision == revision && custom.texture_slot
        })
    }

    pub(crate) fn clear_targets(&mut self) {
        self.targets = None;
    }

    #[allow(
        clippy::cast_precision_loss,
        clippy::too_many_arguments,
        reason = "keeps fixed pass resources explicit; the ABI exposes viewport dimensions as f32"
    )]
    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        viewport: [u32; 2],
        sample_time: f32,
        effects: &[PreparedScenePostEffectV1],
        image_pipeline: &ImagePipelineV1,
        image_texture_cache: &ImageTextureCacheV1,
        fallback_texture_view: &wgpu::TextureView,
    ) -> Option<()> {
        let [width_px, height_px] = viewport;
        let recreate_targets = self
            .targets
            .as_ref()
            .is_none_or(|targets| !targets.matches(format, width_px, height_px));
        if recreate_targets {
            self.targets = Some(SceneColorTargets {
                first: create_scene_color_target(
                    device,
                    format,
                    [width_px, height_px],
                    "poietra Scene post-effect ping target A",
                ),
                second: create_scene_color_target(
                    device,
                    format,
                    [width_px, height_px],
                    "poietra Scene post-effect pong target B",
                ),
            });
        }

        for (effect, uniform_buffer) in effects.iter().zip(&self.uniform_buffers) {
            let mut values = [0.0_f32; HOST_UNIFORM_FLOATS];
            values[0] = width_px as f32;
            values[1] = height_px as f32;
            values[2] = sample_time;
            values[4..].copy_from_slice(effect.parameters());
            let mut bytes = [0_u8; HOST_UNIFORM_BYTES];
            for (chunk, value) in bytes.chunks_exact_mut(4).zip(values) {
                chunk.copy_from_slice(&value.to_le_bytes());
            }
            queue.write_buffer(uniform_buffer, 0, &bytes);
        }
        let targets = self.targets.as_mut()?;
        targets.first.bindings = create_scene_post_effect_bindings(
            device,
            &self.bind_group_layout,
            &self.linear_clamp_sampler,
            &self.uniform_buffers,
            &targets.first.view,
            image_pipeline,
            image_texture_cache,
            fallback_texture_view,
            effects,
        )?;
        targets.second.bindings = create_scene_post_effect_bindings(
            device,
            &self.bind_group_layout,
            &self.linear_clamp_sampler,
            &self.uniform_buffers,
            &targets.second.view,
            image_pipeline,
            image_texture_cache,
            fallback_texture_view,
            effects,
        )?;
        Some(())
    }

    pub(crate) fn scene_view(&self) -> Option<&wgpu::TextureView> {
        self.targets.as_ref().map(|targets| &targets.first.view)
    }

    pub(crate) fn record(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target_view: &wgpu::TextureView,
        compositing: RenderCompositingV1,
        effects: &[PreparedScenePostEffectV1],
    ) -> Option<()> {
        let targets = self.targets.as_ref()?;
        for (index, effect) in effects.iter().enumerate() {
            let pipelines = if effect.shader_id() == RGB_SPLIT_POST_EFFECT_SHADER_ID
                && effect.revision() == RGB_SPLIT_POST_EFFECT_SHADER_REVISION
            {
                &self.builtin
            } else {
                &self
                    .custom
                    .iter()
                    .find(|custom| {
                        custom.shader_id == effect.shader_id()
                            && custom.revision == effect.revision()
                    })?
                    .pipelines
            };
            let (input, intermediate_output) = if index % 2 == 0 {
                (&targets.first, &targets.second.view)
            } else {
                (&targets.second, &targets.first.view)
            };
            let output = if index + 1 == effects.len() {
                target_view
            } else {
                intermediate_output
            };
            let attachments = [Some(wgpu::RenderPassColorAttachment {
                view: output,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("poietra Scene post-effect stack pass"),
                color_attachments: &attachments,
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(pipelines.for_compositing(compositing));
            pass.set_bind_group(0, input.bindings.get(index)?, &[]);
            pass.draw(0..3, 0..1);
        }
        Some(())
    }

    pub(crate) fn accounted_bytes(&self) -> Option<u64> {
        self.targets
            .as_ref()
            .map_or(Some(0), SceneColorTargets::accounted_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID: &str = r"
struct Host { viewport_and_time: vec4<f32>, parameters_0: vec4<f32>, parameters_1: vec4<f32> };
@group(0) @binding(0) var<uniform> host: Host;
@group(0) @binding(1) var scene_texture: texture_2d<f32>;
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    return textureLoad(scene_texture, vec2<i32>(position.xy), 0) + host.parameters_0;
}
";

    fn source(shader_id: &str, revision: u32, wgsl: &str) -> ScenePostEffectSourceV1 {
        ScenePostEffectSourceV1 {
            revision,
            shader_id: shader_id.to_owned(),
            source: wgsl.to_owned(),
            texture_slot: false,
        }
    }

    #[test]
    fn validates_the_bounded_project_source_registry() {
        assert!(
            validate_scene_post_effect_source_v1(&source(
                PROJECT_SCENE_POST_EFFECT_SHADER_ID,
                1,
                VALID,
            ))
            .is_ok()
        );
        assert!(matches!(
            validate_scene_post_effect_source_v1(&source(
                RGB_SPLIT_POST_EFFECT_SHADER_ID,
                1,
                VALID,
            )),
            Err(ScenePostEffectRegistryErrorV1::Reserved { .. })
        ));
        assert!(matches!(
            validate_scene_post_effect_source_v1(&source("another-effect", 1, VALID)),
            Err(ScenePostEffectRegistryErrorV1::InvalidShaderId)
        ));
        assert!(matches!(
            validate_scene_post_effect_source_v1(&source(
                PROJECT_SCENE_POST_EFFECT_SHADER_ID,
                0,
                VALID,
            )),
            Err(ScenePostEffectRegistryErrorV1::InvalidRevision)
        ));

        let four = (1..=MAX_SCENE_POST_EFFECTS_V1)
            .map(|revision| {
                source(
                    PROJECT_SCENE_POST_EFFECT_SHADER_ID,
                    u32::try_from(revision).unwrap(),
                    VALID,
                )
            })
            .collect::<Vec<_>>();
        assert!(validate_scene_post_effect_sources_v1(&four).is_ok());
        let mut five = four.clone();
        five.push(source(PROJECT_SCENE_POST_EFFECT_SHADER_ID, 5, VALID));
        assert!(matches!(
            validate_scene_post_effect_sources_v1(&five),
            Err(ScenePostEffectRegistryErrorV1::TooManySources { .. })
        ));
        assert!(matches!(
            validate_scene_post_effect_sources_v1(&[four[0].clone(), four[0].clone()]),
            Err(ScenePostEffectRegistryErrorV1::Duplicate { .. })
        ));
    }
}
