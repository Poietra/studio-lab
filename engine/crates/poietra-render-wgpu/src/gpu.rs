use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

use crate::arena::GpuBufferArenaV1;
use crate::fragment_material_wgsl::validate_fragment_material_wgsl_resources;
use crate::image_gpu::{
    ImageFrameGpuV1, ImagePipelineV1, ImageTextureCacheV1, build_image_geometry_upload_plan_v1,
    preflight_image_and_material_resources_v1, upload_image_frame_v1,
};
use crate::scene_post_effect_gpu::ScenePostEffectGpu;
use crate::upload::VERTEX_ENCODED_SIZE_V1;
use crate::{
    FragmentMaterialSupportV1, GpuBufferArenaErrorV1, GpuUploadPlanErrorV1, ImageGpuUploadErrorV1,
    ImageTextureCacheFrameStatsV1, ImageTextureCacheLimitsV1, MANIM_CAIRO_SAMPLE_COUNT_V1,
    PreparedFrameV1, PreparedRenderCommandV1, build_gpu_upload_plan_v1,
};
use poietra_scene_ir::{ImageSamplerV1, MAX_VIEWPORT_PIXELS_V1, RenderCompositingV1};
use wgpu::util::DeviceExt;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::{JsCast, JsValue};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_futures::JsFuture;

const VERTEX_STRIDE: wgpu::BufferAddress = VERTEX_ENCODED_SIZE_V1 as wgpu::BufferAddress;
const RGBA8_BYTES_PER_SAMPLE_V1: u64 = 4;
const PORTABLE_AA_SCALE_V1: u32 = 2;
const FRAGMENT_MATERIAL_UNIFORM_FLOATS_V1: usize = 20;
const FRAGMENT_MATERIAL_UNIFORM_BYTES_V1: u64 = 80;
pub const MAX_PROJECT_FRAGMENT_MATERIALS_V1: usize = 8;
pub const MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1: usize = 16 * 1024;

/// Maximum logical bytes for either retained antialias color attachment under
/// the Scene IR viewport-pixel limit.
pub const MAX_MULTISAMPLE_COLOR_TARGET_BYTES_V1: u64 =
    MAX_VIEWPORT_PIXELS_V1 * MANIM_CAIRO_SAMPLE_COUNT_V1 as u64 * RGBA8_BYTES_PER_SAMPLE_V1;
const VERTEX_ATTRIBUTES: [wgpu::VertexAttribute; 2] = [
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x2,
        offset: 0,
        shader_location: 0,
    },
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x4,
        offset: 8,
        shader_location: 1,
    },
];

const PREMULTIPLIED_ALPHA_BLEND: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
};

fn cairo_target_format_for_linear_view(
    target_format: wgpu::TextureFormat,
) -> Option<wgpu::TextureFormat> {
    matches!(
        target_format,
        wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
    )
    .then(|| target_format.remove_srgb_suffix())
}

const fn paint_sample_count_v1(compositing: RenderCompositingV1) -> u32 {
    match compositing {
        RenderCompositingV1::LinearLight => 1,
        RenderCompositingV1::ManimCairoSrgb => MANIM_CAIRO_SAMPLE_COUNT_V1,
    }
}

fn multisample_color_texture_descriptor_v1(
    format: wgpu::TextureFormat,
    width_px: u32,
    height_px: u32,
) -> wgpu::TextureDescriptor<'static> {
    wgpu::TextureDescriptor {
        label: Some("poietra multisample paint target v1"),
        size: wgpu::Extent3d {
            depth_or_array_layers: 1,
            height: height_px,
            width: width_px,
        },
        mip_level_count: 1,
        sample_count: MANIM_CAIRO_SAMPLE_COUNT_V1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    }
}

fn portable_aa_texture_descriptor_v1(
    format: wgpu::TextureFormat,
    width_px: u32,
    height_px: u32,
) -> wgpu::TextureDescriptor<'static> {
    wgpu::TextureDescriptor {
        label: Some("poietra portable antialias target v1"),
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
    }
}

fn portable_aa_extent_v1(
    width_px: u32,
    height_px: u32,
    maximum_dimension: u32,
) -> Option<[u32; 2]> {
    let width_px = width_px.checked_mul(PORTABLE_AA_SCALE_V1)?;
    let height_px = height_px.checked_mul(PORTABLE_AA_SCALE_V1)?;
    (width_px <= maximum_dimension && height_px <= maximum_dimension)
        .then_some([width_px, height_px])
}

/// Target view plus caller-provided format and extent evidence. WGPU does not
/// expose these properties from a `TextureView`, so the renderer verifies the
/// evidence before uploading the frame.
#[derive(Clone, Copy, Debug)]
pub struct WgpuRenderTargetV1<'a> {
    pub format: wgpu::TextureFormat,
    pub height_px: u32,
    pub view: &'a wgpu::TextureView,
    pub width_px: u32,
}

#[derive(Debug)]
struct MultisampleColorTargetV1 {
    format: wgpu::TextureFormat,
    height_px: u32,
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    width_px: u32,
}

impl MultisampleColorTargetV1 {
    fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        width_px: u32,
        height_px: u32,
    ) -> Self {
        let texture = device.create_texture(&multisample_color_texture_descriptor_v1(
            format, width_px, height_px,
        ));
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            format,
            height_px,
            _texture: texture,
            view,
            width_px,
        }
    }

    fn matches(&self, format: wgpu::TextureFormat, width_px: u32, height_px: u32) -> bool {
        self.format == format && self.width_px == width_px && self.height_px == height_px
    }

    fn accounted_bytes(&self) -> Result<u64, RendererMemorySnapshotErrorV1> {
        multisample_color_target_bytes_v1(self.width_px, self.height_px)
    }
}

#[derive(Debug)]
struct PortableAntialiasTargetV1 {
    format: wgpu::TextureFormat,
    height_px: u32,
    resolve_binding: wgpu::BindGroup,
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    width_px: u32,
}

impl PortableAntialiasTargetV1 {
    fn new(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        format: wgpu::TextureFormat,
        width_px: u32,
        height_px: u32,
    ) -> Self {
        let texture = device.create_texture(&portable_aa_texture_descriptor_v1(
            format, width_px, height_px,
        ));
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let resolve_binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("poietra portable antialias resolve binding v1"),
            layout: bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(&view),
            }],
        });
        Self {
            format,
            height_px,
            resolve_binding,
            _texture: texture,
            view,
            width_px,
        }
    }

    fn matches(&self, format: wgpu::TextureFormat, width_px: u32, height_px: u32) -> bool {
        self.format == format && self.width_px == width_px && self.height_px == height_px
    }

    fn accounted_bytes(&self) -> Result<u64, RendererMemorySnapshotErrorV1> {
        u64::from(self.width_px)
            .checked_mul(u64::from(self.height_px))
            .and_then(|pixels| pixels.checked_mul(RGBA8_BYTES_PER_SAMPLE_V1))
            .ok_or(RendererMemorySnapshotErrorV1::MultisampleColorTargetByteAccounting)
    }
}

fn create_portable_antialias_pipeline_v1(
    device: &wgpu::Device,
    target_format: wgpu::TextureFormat,
) -> (wgpu::BindGroupLayout, wgpu::RenderPipeline) {
    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("poietra portable antialias bind group layout v1"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                multisampled: false,
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
            },
            count: None,
        }],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("poietra portable antialias pipeline layout v1"),
        bind_group_layouts: &[Some(&bind_group_layout)],
        immediate_size: 0,
    });
    let shader = device.create_shader_module(wgpu::include_wgsl!("portable_aa_resolve.wgsl"));
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("poietra portable antialias resolve pipeline v1"),
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
                format: target_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });
    (bind_group_layout, pipeline)
}

fn create_fragment_material_pipeline_v1(
    device: &wgpu::Device,
    target_format: wgpu::TextureFormat,
) -> (wgpu::BindGroupLayout, wgpu::RenderPipeline) {
    let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("poietra fragment material host ABI layout v1"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(FRAGMENT_MATERIAL_UNIFORM_BYTES_V1),
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
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("poietra fragment material pipeline layout v1"),
        bind_group_layouts: &[Some(&bind_group_layout)],
        immediate_size: 0,
    });
    let shader = device.create_shader_module(wgpu::include_wgsl!("time_gradient.wgsl"));
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("poietra time-gradient fragment material pipeline v1"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: VERTEX_STRIDE,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &VERTEX_ATTRIBUTES,
            })],
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
                format: target_format,
                blend: Some(PREMULTIPLIED_ALPHA_BLEND),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });
    (bind_group_layout, pipeline)
}

fn create_project_fragment_material_pipeline_v1(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    target_format: wgpu::TextureFormat,
    material: &FragmentMaterialSourceV1,
) -> wgpu::RenderPipeline {
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("poietra project fragment material pipeline layout v1"),
        bind_group_layouts: &[Some(bind_group_layout)],
        immediate_size: 0,
    });
    let vertex_shader =
        device.create_shader_module(wgpu::include_wgsl!("fragment_material_host_vertex.wgsl"));
    let shader_label = format!(
        "poietra project fragment material {}@{}",
        material.shader_id, material.revision
    );
    let fragment_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(&shader_label),
        source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(&material.source)),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(&shader_label),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &vertex_shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: VERTEX_STRIDE,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &VERTEX_ATTRIBUTES,
            })],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            cull_mode: None,
            ..wgpu::PrimitiveState::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &fragment_shader,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: target_format,
                blend: Some(PREMULTIPLIED_ALPHA_BLEND),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

#[cfg(target_arch = "wasm32")]
async fn create_scoped_project_fragment_material_pipeline_v1(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    target_format: wgpu::TextureFormat,
    material: &FragmentMaterialSourceV1,
) -> Result<wgpu::RenderPipeline, String> {
    // wgpu 30's browser error converter panics on GPUInternalError. Keep the
    // same raw WebGPU scope boundary used by the canvas runtime.
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

    let pipeline = create_project_fragment_material_pipeline_v1(
        device,
        bind_group_layout,
        target_format,
        material,
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
    Ok(pipeline)
}

fn multisample_color_target_bytes_v1(
    width_px: u32,
    height_px: u32,
) -> Result<u64, RendererMemorySnapshotErrorV1> {
    u64::from(width_px)
        .checked_mul(u64::from(height_px))
        .and_then(|pixels| pixels.checked_mul(u64::from(MANIM_CAIRO_SAMPLE_COUNT_V1)))
        .and_then(|samples| samples.checked_mul(RGBA8_BYTES_PER_SAMPLE_V1))
        .ok_or(RendererMemorySnapshotErrorV1::MultisampleColorTargetByteAccounting)
}

/// A prepared frame cannot be submitted truthfully to the supplied target.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RenderFrameErrorV1 {
    #[error(transparent)]
    UploadPlan(#[from] GpuUploadPlanErrorV1),
    #[error(transparent)]
    BufferArena(#[from] GpuBufferArenaErrorV1),
    #[error(transparent)]
    ImageUpload(#[from] ImageGpuUploadErrorV1),
    #[error("target format {actual:?} does not match renderer format {expected:?}")]
    TargetFormatMismatch {
        actual: wgpu::TextureFormat,
        expected: wgpu::TextureFormat,
    },
    #[error(
        "target extent {actual_width}x{actual_height} does not match packet viewport {expected_width}x{expected_height}"
    )]
    TargetExtentMismatch {
        actual_height: u32,
        actual_width: u32,
        expected_height: u32,
        expected_width: u32,
    },
    #[error("manim-cairo-srgb compositing does not support image draws")]
    ManimCairoSrgbImagesUnsupported,
    #[error(
        "portable antialias target {width_px}x{height_px} exceeds the device texture limit {maximum_dimension}"
    )]
    PortableAntialiasExtentUnsupported {
        height_px: u32,
        maximum_dimension: u32,
        width_px: u32,
    },
}

/// A target format cannot preserve the initial renderer's linear-light output.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CreateRendererErrorV1 {
    #[error("target format {format:?} is unsupported; expected RGBA8 or BGRA8 sRGB")]
    UnsupportedTargetFormat { format: wgpu::TextureFormat },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FragmentMaterialSourceV1 {
    pub revision: u32,
    pub shader_id: String,
    pub source: String,
    pub texture_slot: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum FragmentMaterialRegistryErrorV1 {
    #[error("fragment material registry accepts at most {maximum} project materials")]
    MaterialLimit { maximum: usize },
    #[error("fragment material {shader_id}@{revision} is duplicated")]
    Duplicate { revision: u32, shader_id: String },
    #[error("fragment material {shader_id}@{revision} uses the reserved built-in identity")]
    Reserved { revision: u32, shader_id: String },
    #[error("fragment material shader ID must use 1 to 240 portable ASCII characters")]
    InvalidShaderId,
    #[error("fragment material revision must be positive")]
    InvalidRevision,
    #[error(
        "fragment material {shader_id}@{revision} source must contain 1 to {maximum} UTF-8 bytes"
    )]
    SourceSize {
        maximum: usize,
        revision: u32,
        shader_id: String,
    },
    #[error("fragment material {shader_id}@{revision} did not compile: {message}")]
    Compilation {
        message: String,
        revision: u32,
        shader_id: String,
    },
}

fn portable_fragment_material_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    value.len() <= 240
        && first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
        })
}

fn validate_fragment_material_sources_v1(
    sources: &[FragmentMaterialSourceV1],
) -> Result<(), FragmentMaterialRegistryErrorV1> {
    if sources.len() > MAX_PROJECT_FRAGMENT_MATERIALS_V1 {
        return Err(FragmentMaterialRegistryErrorV1::MaterialLimit {
            maximum: MAX_PROJECT_FRAGMENT_MATERIALS_V1,
        });
    }
    let mut identities = BTreeSet::new();
    for material in sources {
        if !portable_fragment_material_id(&material.shader_id) {
            return Err(FragmentMaterialRegistryErrorV1::InvalidShaderId);
        }
        if material.revision == 0 {
            return Err(FragmentMaterialRegistryErrorV1::InvalidRevision);
        }
        if material.shader_id == crate::TIME_GRADIENT_SHADER_ID_V1 {
            return Err(FragmentMaterialRegistryErrorV1::Reserved {
                revision: material.revision,
                shader_id: material.shader_id.clone(),
            });
        }
        if material.source.is_empty()
            || material.source.len() > MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1
        {
            return Err(FragmentMaterialRegistryErrorV1::SourceSize {
                maximum: MAX_FRAGMENT_MATERIAL_SOURCE_BYTES_V1,
                revision: material.revision,
                shader_id: material.shader_id.clone(),
            });
        }
        if !identities.insert((material.shader_id.clone(), material.revision)) {
            return Err(FragmentMaterialRegistryErrorV1::Duplicate {
                revision: material.revision,
                shader_id: material.shader_id.clone(),
            });
        }
        validate_fragment_material_wgsl_resources(&material.source, material.texture_slot)
            .map_err(|message| FragmentMaterialRegistryErrorV1::Compilation {
                message,
                revision: material.revision,
                shader_id: material.shader_id.clone(),
            })?;
    }
    Ok(())
}

/// CPU-side stage evidence recorded while submitting one prepared frame.
///
/// Timings are raw wall-clock differences in milliseconds observed on the
/// calling thread around each named CPU interval. They measure command
/// recording and resource-creation cost, never GPU execution or transfer.
/// A timing of `None` means the interval could not be observed (no clock, or
/// a clock probe returned nothing); it never means the stage did not run —
/// `geometry_stages_executed` states that separately, so consumers can tell
/// "executed but unmeasurable" apart from "did not execute".
/// Raw differences are NOT sanitized here: a non-monotonic or non-finite
/// clock can surface as a negative or non-finite value, and consumers must
/// reject such intervals rather than report them as healthy timings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RenderStageEvidenceV1 {
    /// Wall time for retained-buffer growth, dirty-range comparison, and
    /// queue writes. This is CPU-side staging cost, not GPU transfer time.
    pub buffer_create_and_stage_ms: Option<f64>,
    /// Vertex/index buffers created by arena growth or transient image staging.
    pub buffer_creations: u32,
    /// Wall time from command-encoder creation through `encoder.finish()`.
    /// This is a nested total: it INCLUDES the `draw_record_ms` interval.
    /// Command encoding and submission always execute, even for empty frames.
    pub command_encode_total_ms: Option<f64>,
    /// Indexed draw calls recorded into the render pass.
    pub draw_calls: u64,
    /// Wall time recording ordered compatible `draw_indexed` batches; nested
    /// inside `command_encode_total_ms`.
    pub draw_record_ms: Option<f64>,
    /// Whether the geometry stages (`vertex_index_encode`,
    /// `buffer_create_and_stage`, `draw_record`) executed for this frame.
    /// They are skipped as a group exactly when the frame has no drawable geometry.
    pub geometry_stages_executed: bool,
    /// Retained texture and sampler-binding work performed for this frame.
    pub image_texture_cache: ImageTextureCacheFrameStatsV1,
    /// Wall time submitting the finished command buffer to the queue. Queue
    /// submission returning says nothing about GPU execution completion.
    pub submit_ms: Option<f64>,
    /// Vertex, index, and unique decoded texture bytes staged for this frame.
    pub upload_bytes: u64,
    /// Wall time encoding vertices/indices into little-endian byte vectors on
    /// the CPU, before any buffer exists.
    pub vertex_index_encode_ms: Option<f64>,
}

impl RenderStageEvidenceV1 {
    fn empty() -> Self {
        Self {
            buffer_create_and_stage_ms: None,
            buffer_creations: 0,
            command_encode_total_ms: None,
            draw_calls: 0,
            draw_record_ms: None,
            geometry_stages_executed: false,
            image_texture_cache: ImageTextureCacheFrameStatsV1::default(),
            submit_ms: None,
            upload_bytes: 0,
            vertex_index_encode_ms: None,
        }
    }
}

type StageClock<'a> = Option<&'a dyn Fn() -> Option<f64>>;

fn stage_elapsed(clock: StageClock<'_>, started: Option<f64>) -> Option<f64> {
    let ended = clock.and_then(|now| now())?;
    Some(ended - started?)
}

fn stage_started(clock: StageClock<'_>) -> Option<f64> {
    clock.and_then(|now| now())
}

fn paint_buffers<'arena>(
    arena: &'arena GpuBufferArenaV1,
    frame: &PreparedFrameV1,
) -> Result<Option<(&'arena wgpu::Buffer, &'arena wgpu::Buffer)>, GpuUploadPlanErrorV1> {
    if frame.indices().is_empty() {
        return Ok(None);
    }
    arena
        .buffers()
        .map(Some)
        .ok_or(GpuUploadPlanErrorV1::Inconsistent(
            "successful non-empty upload did not retain both GPU buffers",
        ))
}

#[derive(Debug)]
struct FragmentMaterialFrameGpuV1 {
    bind_groups: Vec<wgpu::BindGroup>,
    draw_indices: Vec<u32>,
    uniform_buffers: Vec<wgpu::Buffer>,
}

impl FragmentMaterialFrameGpuV1 {
    #[allow(
        clippy::cast_precision_loss,
        reason = "the fixed shader ABI exposes viewport dimensions as f32"
    )]
    fn prepare(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        frame: &PreparedFrameV1,
        image_pipeline: &ImagePipelineV1,
        image_texture_cache: &ImageTextureCacheV1,
        fallback_texture_view: &wgpu::TextureView,
    ) -> Result<Self, GpuUploadPlanErrorV1> {
        let mut bind_groups = Vec::new();
        let mut draw_indices = Vec::new();
        let mut uniform_buffers = Vec::new();
        for command in frame.render_commands() {
            let PreparedRenderCommandV1::FragmentMaterial { draw_index } = *command else {
                continue;
            };
            let draw = frame
                .draws()
                .get(usize::try_from(draw_index).map_err(|_| {
                    GpuUploadPlanErrorV1::Inconsistent(
                        "fragment material draw index does not fit usize",
                    )
                })?)
                .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                    "fragment material command references an unknown draw",
                ))?;
            let material = frame
                .material_for_draw(draw)
                .and_then(|material| material.fragment_material())
                .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                    "fragment material command references a solid material",
                ))?;
            let [width_px, height_px] = frame.viewport();
            let mut values = [0.0_f32; FRAGMENT_MATERIAL_UNIFORM_FLOATS_V1];
            values[0] = width_px as f32;
            values[1] = height_px as f32;
            values[2] = frame.sample_time();
            values[4..12].copy_from_slice(material.parameters());
            let object_uv_from_screen =
                draw.object_uv_from_screen()
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "fragment material draw has no object-local UV affine",
                    ))?;
            values[12..].copy_from_slice(&object_uv_from_screen);
            let mut bytes = Vec::with_capacity(FRAGMENT_MATERIAL_UNIFORM_FLOATS_V1 * 4);
            for value in values {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("poietra fragment material host ABI uniform v1"),
                contents: &bytes,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let (texture_view, sampler) = if let Some(texture) = material.texture() {
                (
                    image_texture_cache.texture_view(texture.asset()).ok_or(
                        GpuUploadPlanErrorV1::Inconsistent(
                            "fragment material texture was not retained by the image cache",
                        ),
                    )?,
                    image_pipeline.sampler(texture.sampler()),
                )
            } else {
                (
                    fallback_texture_view,
                    image_pipeline.sampler(ImageSamplerV1::Linear),
                )
            };
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("poietra fragment material host ABI binding v1"),
                layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(texture_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(sampler),
                    },
                ],
            });
            uniform_buffers.push(buffer);
            bind_groups.push(bind_group);
            draw_indices.push(draw_index);
        }
        Ok(Self {
            bind_groups,
            draw_indices,
            uniform_buffers,
        })
    }

    fn bind_group(&self, index: usize, draw_index: u32) -> Option<&wgpu::BindGroup> {
        (self.draw_indices.get(index) == Some(&draw_index))
            .then(|| self.bind_groups.get(index))
            .flatten()
    }

    fn buffer_creations(&self) -> Result<u32, GpuUploadPlanErrorV1> {
        u32::try_from(self.uniform_buffers.len()).map_err(|_| {
            GpuUploadPlanErrorV1::Inconsistent("fragment material buffer count exceeds u32")
        })
    }

    fn upload_bytes(&self) -> Result<u64, GpuUploadPlanErrorV1> {
        u64::try_from(self.uniform_buffers.len())
            .ok()
            .and_then(|count| count.checked_mul(FRAGMENT_MATERIAL_UNIFORM_BYTES_V1))
            .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)
    }
}

#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "one ordered pass switches among solid, fragment-material, and image pipelines"
)]
fn record_ordered_draws_v1(
    pass: &mut wgpu::RenderPass<'_>,
    paint_pipeline: &wgpu::RenderPipeline,
    fragment_material_pipeline: &wgpu::RenderPipeline,
    project_fragment_material_pipelines: &BTreeMap<(String, u32), wgpu::RenderPipeline>,
    fragment_material_frame: &FragmentMaterialFrameGpuV1,
    paint_buffers: Option<(&wgpu::Buffer, &wgpu::Buffer)>,
    image_pipeline: &ImagePipelineV1,
    image_texture_cache: &ImageTextureCacheV1,
    image_frame: Option<&ImageFrameGpuV1>,
    frame: &PreparedFrameV1,
) -> Result<u64, GpuUploadPlanErrorV1> {
    let mut command_index = 0usize;
    let mut draw_calls = 0u64;
    let mut fragment_material_index = 0usize;
    while let Some(command) = frame.render_commands().get(command_index) {
        match *command {
            PreparedRenderCommandV1::Paint { draw_index } => {
                let (vertex_buffer, index_buffer) = paint_buffers.ok_or(
                    GpuUploadPlanErrorV1::Inconsistent("paint command has no staged path buffers"),
                )?;
                let draw_index = usize::try_from(draw_index).map_err(|_| {
                    GpuUploadPlanErrorV1::Inconsistent("paint draw index does not fit usize")
                })?;
                let first_draw =
                    frame
                        .draws()
                        .get(draw_index)
                        .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                            "paint command references an unknown draw",
                        ))?;
                let index_start = first_draw.index_range().start;
                let mut index_end = first_draw.index_range().end;
                let mut next_draw_index = draw_index + 1;
                command_index += 1;
                while let Some(PreparedRenderCommandV1::Paint { draw_index }) =
                    frame.render_commands().get(command_index)
                {
                    let candidate_index = usize::try_from(*draw_index).map_err(|_| {
                        GpuUploadPlanErrorV1::Inconsistent("paint draw index does not fit usize")
                    })?;
                    if candidate_index != next_draw_index {
                        return Err(GpuUploadPlanErrorV1::Inconsistent(
                            "ordered paint commands do not reference consecutive draws",
                        ));
                    }
                    let candidate = frame.draws().get(candidate_index).ok_or(
                        GpuUploadPlanErrorV1::Inconsistent(
                            "paint command references an unknown draw",
                        ),
                    )?;
                    if candidate.index_range().start != index_end {
                        return Err(GpuUploadPlanErrorV1::Inconsistent(
                            "consecutive paint draw index ranges are not contiguous",
                        ));
                    }
                    index_end = candidate.index_range().end;
                    next_draw_index += 1;
                    command_index += 1;
                }
                pass.set_pipeline(paint_pipeline);
                pass.set_vertex_buffer(0, vertex_buffer.slice(..));
                pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(index_start..index_end, 0, 0..1);
                draw_calls =
                    draw_calls
                        .checked_add(1)
                        .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                            "GPU draw-call count overflowed",
                        ))?;
            }
            PreparedRenderCommandV1::Image { image_index } => {
                let image_frame = image_frame.ok_or(GpuUploadPlanErrorV1::Inconsistent(
                    "image command has no staged image resources",
                ))?;
                let image_index = usize::try_from(image_index).map_err(|_| {
                    GpuUploadPlanErrorV1::Inconsistent("image draw index does not fit usize")
                })?;
                let bind_group = image_frame
                    .bind_group(image_index, image_texture_cache)
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "image command references an unknown bind group",
                    ))?;
                let index_range = image_frame.index_range(image_index).ok_or(
                    GpuUploadPlanErrorV1::Inconsistent(
                        "image command references an unknown index range",
                    ),
                )?;
                pass.set_pipeline(image_pipeline.pipeline());
                pass.set_vertex_buffer(0, image_frame.vertex_buffer().slice(..));
                pass.set_index_buffer(
                    image_frame.index_buffer().slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                pass.set_bind_group(0, bind_group, &[]);
                pass.draw_indexed(index_range, 0, 0..1);
                draw_calls =
                    draw_calls
                        .checked_add(1)
                        .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                            "GPU draw-call count overflowed",
                        ))?;
                command_index += 1;
            }
            PreparedRenderCommandV1::FragmentMaterial { draw_index } => {
                let (vertex_buffer, index_buffer) =
                    paint_buffers.ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "fragment material command has no staged path buffers",
                    ))?;
                let draw = frame
                    .draws()
                    .get(usize::try_from(draw_index).map_err(|_| {
                        GpuUploadPlanErrorV1::Inconsistent(
                            "fragment material draw index does not fit usize",
                        )
                    })?)
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "fragment material command references an unknown draw",
                    ))?;
                let bind_group = fragment_material_frame
                    .bind_group(fragment_material_index, draw_index)
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "fragment material command has no matching host ABI binding",
                    ))?;
                let material = frame
                    .material_for_draw(draw)
                    .and_then(|material| material.fragment_material())
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "fragment material command references a solid material",
                    ))?;
                let pipeline = if material.shader_id() == crate::TIME_GRADIENT_SHADER_ID_V1
                    && material.revision() == crate::TIME_GRADIENT_SHADER_REVISION_V1
                {
                    fragment_material_pipeline
                } else {
                    project_fragment_material_pipelines
                        .get(&(material.shader_id().to_owned(), material.revision()))
                        .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                            "prepared fragment material has no installed GPU pipeline",
                        ))?
                };
                pass.set_pipeline(pipeline);
                pass.set_vertex_buffer(0, vertex_buffer.slice(..));
                pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                pass.set_bind_group(0, bind_group, &[]);
                pass.draw_indexed(draw.index_range().clone(), 0, 0..1);
                fragment_material_index += 1;
                command_index += 1;
                draw_calls =
                    draw_calls
                        .checked_add(1)
                        .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                            "GPU draw-call count overflowed",
                        ))?;
            }
        }
    }
    Ok(draw_calls)
}

/// Browser/native WGPU pipeline for premultiplied solid-paint triangles.
///
/// The historical `Fill` name remains for API compatibility; new callers may
/// use the [`crate::WgpuPaintRendererV1`] alias.
#[derive(Debug)]
pub struct WgpuFillRendererV1 {
    arena: GpuBufferArenaV1,
    cairo_pipeline: wgpu::RenderPipeline,
    cairo_target_format: wgpu::TextureFormat,
    fragment_material_bind_group_layout: wgpu::BindGroupLayout,
    fragment_material_fallback_initialized: bool,
    fragment_material_fallback_texture: wgpu::Texture,
    fragment_material_fallback_texture_view: wgpu::TextureView,
    fragment_material_pipeline: wgpu::RenderPipeline,
    image_pipeline: ImagePipelineV1,
    image_texture_cache: ImageTextureCacheV1,
    multisample_target: Option<MultisampleColorTargetV1>,
    pipeline: wgpu::RenderPipeline,
    portable_aa_bind_group_layout: wgpu::BindGroupLayout,
    portable_aa_pipeline: wgpu::RenderPipeline,
    portable_aa_target: Option<PortableAntialiasTargetV1>,
    project_fragment_material_pipelines: BTreeMap<(String, u32), wgpu::RenderPipeline>,
    project_fragment_material_texture_slots: BTreeSet<(String, u32)>,
    scene_post_effect_gpu: ScenePostEffectGpu,
    target_format: wgpu::TextureFormat,
}

impl FragmentMaterialSupportV1 for WgpuFillRendererV1 {
    fn supports_fragment_material(&self, shader_id: &str, revision: u32) -> bool {
        (shader_id == crate::TIME_GRADIENT_SHADER_ID_V1
            && revision == crate::TIME_GRADIENT_SHADER_REVISION_V1)
            || self
                .project_fragment_material_pipelines
                .contains_key(&(shader_id.to_owned(), revision))
    }

    fn has_fragment_material_texture_slot(&self, shader_id: &str, revision: u32) -> bool {
        self.project_fragment_material_texture_slots
            .contains(&(shader_id.to_owned(), revision))
    }
}

/// Exact logical byte counts for GPU resources retained by one renderer.
///
/// These values cover the grow-only vertex/index buffer arena, image textures
/// retained by the bounded LRU, the active antialias color attachment, and an
/// active Scene post-effect input. The antialias attachment is either the
/// Manim/Cairo four-sample target or the linear-light two-times portable target.
/// They intentionally exclude backend-owned pipeline/surface allocation
/// overhead, so they are not a browser-process RSS claim.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RendererMemorySnapshotV1 {
    geometry_buffer_arena: u64,
    multisample_color_target: u64,
    retained_image_texture: u64,
}

impl RendererMemorySnapshotV1 {
    #[must_use]
    pub const fn geometry_buffer_arena_bytes(self) -> u64 {
        self.geometry_buffer_arena
    }

    /// Logical bytes retained by active antialias and post-effect color attachments.
    ///
    /// The method keeps its historical name for API compatibility.
    #[must_use]
    pub const fn multisample_color_target_bytes(self) -> u64 {
        self.multisample_color_target
    }

    #[must_use]
    pub const fn retained_image_texture_bytes(self) -> u64 {
        self.retained_image_texture
    }
}

/// A retained renderer byte count could not be represented exactly.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RendererMemorySnapshotErrorV1 {
    #[error(transparent)]
    BufferArena(#[from] GpuBufferArenaErrorV1),
    #[error("retained image texture byte accounting is not representable as u64")]
    ImageTextureByteConversion,
    #[error("retained color-target byte accounting overflowed")]
    MultisampleColorTargetByteAccounting,
}

impl WgpuFillRendererV1 {
    /// Creates a portable linear-light pipeline and a four-sample Manim/Cairo
    /// pipeline for the sRGB view's base Unorm format. Both share the retained
    /// geometry arena and image cache. Cairo frames lazily retain and resolve a
    /// multisample attachment into the caller's target; linear frames render at
    /// twice the target extent and explicitly average four linear-light samples.
    ///
    /// # Errors
    ///
    /// Rejects non-sRGB or non-eight-bit targets before creating GPU resources.
    pub fn new(
        device: &wgpu::Device,
        target_format: wgpu::TextureFormat,
    ) -> Result<Self, CreateRendererErrorV1> {
        Self::new_with_image_texture_cache_limits(
            device,
            target_format,
            ImageTextureCacheLimitsV1::default(),
        )
    }

    /// Creates a renderer with explicit logical image-cache budgets.
    ///
    /// This is primarily useful to test deterministic eviction policy; normal
    /// callers should use [`Self::new`].
    ///
    /// # Errors
    ///
    /// Rejects the same unsupported target formats as [`Self::new`].
    pub fn new_with_image_texture_cache_limits(
        device: &wgpu::Device,
        target_format: wgpu::TextureFormat,
        image_texture_cache_limits: ImageTextureCacheLimitsV1,
    ) -> Result<Self, CreateRendererErrorV1> {
        let cairo_target_format = cairo_target_format_for_linear_view(target_format).ok_or(
            CreateRendererErrorV1::UnsupportedTargetFormat {
                format: target_format,
            },
        )?;
        let (portable_aa_bind_group_layout, portable_aa_pipeline) =
            create_portable_antialias_pipeline_v1(device, target_format);
        let (fragment_material_bind_group_layout, fragment_material_pipeline) =
            create_fragment_material_pipeline_v1(device, target_format);
        let fragment_material_fallback_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("poietra fragment material white fallback texture v1"),
            size: wgpu::Extent3d {
                depth_or_array_layers: 1,
                height: 1,
                width: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let fragment_material_fallback_texture_view =
            fragment_material_fallback_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let shader = device.create_shader_module(wgpu::include_wgsl!("fill.wgsl"));
        let create_paint_pipeline = |label, format, sample_count| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: None,
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    buffers: &[Some(wgpu::VertexBufferLayout {
                        array_stride: VERTEX_STRIDE,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &VERTEX_ATTRIBUTES,
                    })],
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..wgpu::PrimitiveState::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState {
                    count: sample_count,
                    ..wgpu::MultisampleState::default()
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: Some(PREMULTIPLIED_ALPHA_BLEND),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            })
        };
        let pipeline = create_paint_pipeline(
            "poietra linear-light paint pipeline v1",
            target_format,
            paint_sample_count_v1(RenderCompositingV1::LinearLight),
        );
        let cairo_pipeline = create_paint_pipeline(
            "poietra Manim Cairo sRGB paint pipeline v1",
            cairo_target_format,
            paint_sample_count_v1(RenderCompositingV1::ManimCairoSrgb),
        );
        let scene_post_effect_gpu =
            ScenePostEffectGpu::new(device, target_format, cairo_target_format);
        Ok(Self {
            arena: GpuBufferArenaV1::default(),
            cairo_pipeline,
            cairo_target_format,
            fragment_material_bind_group_layout,
            fragment_material_fallback_initialized: false,
            fragment_material_fallback_texture,
            fragment_material_fallback_texture_view,
            fragment_material_pipeline,
            image_pipeline: ImagePipelineV1::new(device, target_format),
            image_texture_cache: ImageTextureCacheV1::with_limits(image_texture_cache_limits),
            multisample_target: None,
            pipeline,
            portable_aa_bind_group_layout,
            portable_aa_pipeline,
            portable_aa_target: None,
            project_fragment_material_pipelines: BTreeMap::new(),
            project_fragment_material_texture_slots: BTreeSet::new(),
            scene_post_effect_gpu,
            target_format,
        })
    }

    /// Compiles and atomically installs one bounded project-local fragment
    /// registry. The existing registry remains active when any source fails.
    ///
    /// # Errors
    ///
    /// Returns an error when the registry is invalid or a shader does not compile.
    pub async fn replace_fragment_material_sources(
        &mut self,
        device: &wgpu::Device,
        sources: &[FragmentMaterialSourceV1],
    ) -> Result<(), FragmentMaterialRegistryErrorV1> {
        validate_fragment_material_sources_v1(sources)?;
        let mut candidate = BTreeMap::new();
        let mut candidate_texture_slots = BTreeSet::new();
        for material in sources {
            #[cfg(not(target_arch = "wasm32"))]
            let pipeline = {
                let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
                let pipeline = create_project_fragment_material_pipeline_v1(
                    device,
                    &self.fragment_material_bind_group_layout,
                    self.target_format,
                    material,
                );
                if let Some(error) = validation_scope.pop().await {
                    return Err(FragmentMaterialRegistryErrorV1::Compilation {
                        message: error.to_string(),
                        revision: material.revision,
                        shader_id: material.shader_id.clone(),
                    });
                }
                pipeline
            };
            #[cfg(target_arch = "wasm32")]
            let pipeline = create_scoped_project_fragment_material_pipeline_v1(
                device,
                &self.fragment_material_bind_group_layout,
                self.target_format,
                material,
            )
            .await
            .map_err(|message| FragmentMaterialRegistryErrorV1::Compilation {
                message,
                revision: material.revision,
                shader_id: material.shader_id.clone(),
            })?;
            candidate.insert((material.shader_id.clone(), material.revision), pipeline);
            if material.texture_slot {
                candidate_texture_slots.insert((material.shader_id.clone(), material.revision));
            }
        }
        self.project_fragment_material_pipelines = candidate;
        self.project_fragment_material_texture_slots = candidate_texture_slots;
        Ok(())
    }

    /// Drops all device-bound image resources. Future frames rebuild them
    /// from the verified decoded assets retained by their resolver/session.
    pub fn clear_image_texture_cache(&mut self) {
        self.image_texture_cache.clear();
    }

    /// Reports exact logical capacity for the GPU resources retained by this
    /// renderer at the call boundary.
    ///
    /// # Errors
    ///
    /// Returns an error instead of saturating if any retained byte count is
    /// not representable.
    pub fn memory_snapshot(
        &self,
    ) -> Result<RendererMemorySnapshotV1, RendererMemorySnapshotErrorV1> {
        let retained_image_texture = u64::try_from(self.image_texture_cache.accounted_gpu_bytes())
            .map_err(|_| RendererMemorySnapshotErrorV1::ImageTextureByteConversion)?;
        Ok(RendererMemorySnapshotV1 {
            geometry_buffer_arena: self.arena.capacity_bytes()?,
            multisample_color_target: self
                .multisample_target
                .as_ref()
                .map(MultisampleColorTargetV1::accounted_bytes)
                .transpose()?
                .unwrap_or(0)
                .checked_add(
                    self.portable_aa_target
                        .as_ref()
                        .map(PortableAntialiasTargetV1::accounted_bytes)
                        .transpose()?
                        .unwrap_or(0),
                )
                .and_then(|bytes| {
                    self.scene_post_effect_gpu
                        .accounted_bytes()
                        .and_then(|post_effect_bytes| bytes.checked_add(post_effect_bytes))
                })
                .ok_or(RendererMemorySnapshotErrorV1::MultisampleColorTargetByteAccounting)?,
            retained_image_texture,
        })
    }

    #[must_use]
    pub const fn target_format(&self) -> wgpu::TextureFormat {
        self.target_format
    }

    /// Returns the texture-view format required by one prepared frame's
    /// explicit compositing contract.
    #[must_use]
    pub const fn target_format_for_compositing(
        &self,
        compositing: RenderCompositingV1,
    ) -> wgpu::TextureFormat {
        match compositing {
            RenderCompositingV1::LinearLight => self.target_format,
            RenderCompositingV1::ManimCairoSrgb => self.cairo_target_format,
        }
    }

    /// Clears the target and submits all indexed triangle ranges in packet paint order.
    ///
    /// The target must be single-sampled, render-attachable, and use the format
    /// supplied to [`Self::new`]. WGPU reports violations through its normal device
    /// error mechanism.
    ///
    /// # Errors
    ///
    /// Returns a format or extent mismatch before uploading, an
    /// [`RenderFrameErrorV1::UploadPlan`] when bounded vertex/index encoding
    /// fails, or [`RenderFrameErrorV1::BufferArena`] when retained capacity
    /// overflows or exceeds the renderer/device limit.
    pub fn render(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: WgpuRenderTargetV1<'_>,
        frame: &PreparedFrameV1,
    ) -> Result<wgpu::SubmissionIndex, RenderFrameErrorV1> {
        self.render_with_stage_evidence(device, queue, target, frame, None)
            .map(|(submission, _)| submission)
    }

    /// Renders exactly like [`Self::render`] while recording CPU-side stage
    /// evidence for opt-in telemetry.
    ///
    /// The optional `clock` returns wall-clock milliseconds; when it is absent
    /// or returns `None`, counts are still recorded and every timing is `None`.
    ///
    /// # Errors
    ///
    /// Returns the same format, extent, upload-plan, or retained-buffer errors
    /// as [`Self::render`].
    #[allow(clippy::too_many_lines)] // Keeps one frame's measured stage boundaries contiguous.
    pub fn render_with_stage_evidence(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        target: WgpuRenderTargetV1<'_>,
        frame: &PreparedFrameV1,
        clock: Option<&dyn Fn() -> Option<f64>>,
    ) -> Result<(wgpu::SubmissionIndex, RenderStageEvidenceV1), RenderFrameErrorV1> {
        let [expected_width, expected_height] = frame.viewport();
        if target.width_px != expected_width || target.height_px != expected_height {
            return Err(RenderFrameErrorV1::TargetExtentMismatch {
                actual_height: target.height_px,
                actual_width: target.width_px,
                expected_height,
                expected_width,
            });
        }
        let expected_target_format = self.target_format_for_compositing(frame.compositing());
        if target.format != expected_target_format {
            return Err(RenderFrameErrorV1::TargetFormatMismatch {
                actual: target.format,
                expected: expected_target_format,
            });
        }
        if frame.compositing() == RenderCompositingV1::ManimCairoSrgb
            && !frame.image_draws().is_empty()
        {
            return Err(RenderFrameErrorV1::ManimCairoSrgbImagesUnsupported);
        }

        let uses_multisample_target = paint_sample_count_v1(frame.compositing()) > 1;
        if uses_multisample_target {
            self.portable_aa_target = None;
            let recreate_multisample_target =
                self.multisample_target
                    .as_ref()
                    .is_none_or(|multisample_target| {
                        !multisample_target.matches(
                            expected_target_format,
                            target.width_px,
                            target.height_px,
                        )
                    });
            if recreate_multisample_target {
                self.multisample_target = Some(MultisampleColorTargetV1::new(
                    device,
                    expected_target_format,
                    target.width_px,
                    target.height_px,
                ));
            }
        } else {
            self.multisample_target = None;
            let maximum_dimension = device.limits().max_texture_dimension_2d;
            let Some([supersample_width, supersample_height]) =
                portable_aa_extent_v1(target.width_px, target.height_px, maximum_dimension)
            else {
                return Err(RenderFrameErrorV1::PortableAntialiasExtentUnsupported {
                    height_px: target.height_px.saturating_mul(PORTABLE_AA_SCALE_V1),
                    maximum_dimension,
                    width_px: target.width_px.saturating_mul(PORTABLE_AA_SCALE_V1),
                });
            };
            let recreate_portable_aa_target =
                self.portable_aa_target
                    .as_ref()
                    .is_none_or(|portable_aa_target| {
                        !portable_aa_target.matches(
                            expected_target_format,
                            supersample_width,
                            supersample_height,
                        )
                    });
            if recreate_portable_aa_target {
                self.portable_aa_target = Some(PortableAntialiasTargetV1::new(
                    device,
                    &self.portable_aa_bind_group_layout,
                    expected_target_format,
                    supersample_width,
                    supersample_height,
                ));
            }
        }

        if let Some(effect) = frame.scene_post_effect() {
            self.scene_post_effect_gpu.prepare(
                device,
                queue,
                expected_target_format,
                [target.width_px, target.height_px],
                frame.sample_time(),
                effect.parameters(),
            );
        } else {
            self.scene_post_effect_gpu.clear_target();
        }

        let mut evidence = RenderStageEvidenceV1::empty();
        let has_geometry = !frame.indices().is_empty() || !frame.image_draws().is_empty();
        let mut fragment_material_frame = None;
        let mut image_frame = None;
        if has_geometry {
            evidence.geometry_stages_executed = true;
            let vertex_index_encode_started = stage_started(clock);
            let path_upload = if frame.indices().is_empty() {
                None
            } else {
                Some(build_gpu_upload_plan_v1(frame)?.into_parts())
            };
            let image_upload = build_image_geometry_upload_plan_v1(frame.image_draws())?;
            let material_textures = frame
                .material_plan()
                .materials()
                .iter()
                .filter_map(|material| material.fragment_material()?.texture())
                .collect::<Vec<_>>();
            let image_resources = if image_upload.is_some() || !material_textures.is_empty() {
                Some(preflight_image_and_material_resources_v1(
                    frame.image_draws(),
                    &material_textures,
                    device.limits().max_texture_dimension_2d,
                )?)
            } else {
                None
            };
            evidence.vertex_index_encode_ms = stage_elapsed(clock, vertex_index_encode_started);
            let buffer_create_started = stage_started(clock);
            if let Some(image_resources) = image_resources.as_ref() {
                evidence.image_texture_cache = self.image_texture_cache.prepare_frame(
                    device,
                    queue,
                    &self.image_pipeline,
                    image_resources,
                )?;
                evidence.upload_bytes = evidence
                    .upload_bytes
                    .checked_add(evidence.image_texture_cache.texture_upload_bytes())
                    .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)?;
            }
            if let Some((vertex_bytes, index_bytes)) = path_upload {
                let arena_stats = self
                    .arena
                    .upload(device, queue, vertex_bytes, index_bytes)?;
                evidence.buffer_creations = arena_stats.buffer_creations;
                evidence.upload_bytes = evidence
                    .upload_bytes
                    .checked_add(arena_stats.upload_bytes)
                    .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)?;
                debug_assert!(arena_stats.capacity_bytes > 0);
            }
            if !self.fragment_material_fallback_initialized
                && frame.material_plan().materials().iter().any(|material| {
                    material
                        .fragment_material()
                        .is_some_and(|material| material.texture().is_none())
                })
            {
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.fragment_material_fallback_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &[255, 255, 255, 255],
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(4),
                        rows_per_image: Some(1),
                    },
                    wgpu::Extent3d {
                        depth_or_array_layers: 1,
                        height: 1,
                        width: 1,
                    },
                );
                self.fragment_material_fallback_initialized = true;
            }
            let prepared_fragment_material_frame = FragmentMaterialFrameGpuV1::prepare(
                device,
                &self.fragment_material_bind_group_layout,
                frame,
                &self.image_pipeline,
                &self.image_texture_cache,
                &self.fragment_material_fallback_texture_view,
            )?;
            evidence.buffer_creations = evidence
                .buffer_creations
                .checked_add(prepared_fragment_material_frame.buffer_creations()?)
                .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)?;
            evidence.upload_bytes = evidence
                .upload_bytes
                .checked_add(prepared_fragment_material_frame.upload_bytes()?)
                .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)?;
            fragment_material_frame = Some(prepared_fragment_material_frame);
            if let Some((image_upload, image_resources)) = image_upload.zip(image_resources) {
                let uploaded = upload_image_frame_v1(device, queue, image_upload, image_resources)?;
                evidence.buffer_creations = evidence
                    .buffer_creations
                    .checked_add(ImageFrameGpuV1::BUFFER_CREATIONS)
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "GPU buffer creation count overflowed",
                    ))?;
                evidence.upload_bytes = evidence
                    .upload_bytes
                    .checked_add(uploaded.upload_bytes())
                    .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)?;
                image_frame = Some(uploaded);
            }
            evidence.buffer_create_and_stage_ms = stage_elapsed(clock, buffer_create_started);
        }

        let command_encode_started = stage_started(clock);
        let mut draw_record_ms = None;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("poietra solid paint encoder v1"),
        });
        {
            let clear = frame.clear_color();
            let scene_output_view = self
                .scene_post_effect_gpu
                .scene_view()
                .unwrap_or(target.view);
            let (render_view, resolve_target, store) = if uses_multisample_target {
                let multisample_view = &self
                    .multisample_target
                    .as_ref()
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "validated Cairo target extent did not retain a multisample attachment",
                    ))?
                    .view;
                (
                    multisample_view,
                    Some(scene_output_view),
                    wgpu::StoreOp::Discard,
                )
            } else {
                let portable_aa_view = &self
                    .portable_aa_target
                    .as_ref()
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "validated linear target extent did not retain a portable antialias attachment",
                    ))?
                    .view;
                (portable_aa_view, None, wgpu::StoreOp::Store)
            };
            let attachments = [Some(wgpu::RenderPassColorAttachment {
                view: render_view,
                depth_slice: None,
                resolve_target,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: clear[0],
                        g: clear[1],
                        b: clear[2],
                        a: clear[3],
                    }),
                    store,
                },
            })];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("poietra solid paint pass v1"),
                color_attachments: &attachments,
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if has_geometry {
                let draw_record_started = stage_started(clock);
                let paint_pipeline = match frame.compositing() {
                    RenderCompositingV1::LinearLight => &self.pipeline,
                    RenderCompositingV1::ManimCairoSrgb => &self.cairo_pipeline,
                };
                evidence.draw_calls = record_ordered_draws_v1(
                    &mut pass,
                    paint_pipeline,
                    &self.fragment_material_pipeline,
                    &self.project_fragment_material_pipelines,
                    fragment_material_frame
                        .as_ref()
                        .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                            "drawable frame has no fragment material binding plan",
                        ))?,
                    paint_buffers(&self.arena, frame)?,
                    &self.image_pipeline,
                    &self.image_texture_cache,
                    image_frame.as_ref(),
                    frame,
                )?;
                draw_record_ms = stage_elapsed(clock, draw_record_started);
            }
        }
        if !uses_multisample_target {
            let portable_aa_target = self.portable_aa_target.as_ref().ok_or(
                GpuUploadPlanErrorV1::Inconsistent(
                    "validated linear target extent did not retain a portable antialias attachment",
                ),
            )?;
            let scene_output_view = self
                .scene_post_effect_gpu
                .scene_view()
                .unwrap_or(target.view);
            let attachments = [Some(wgpu::RenderPassColorAttachment {
                view: scene_output_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })];
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("poietra portable antialias resolve pass v1"),
                color_attachments: &attachments,
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.portable_aa_pipeline);
            pass.set_bind_group(0, &portable_aa_target.resolve_binding, &[]);
            pass.draw(0..3, 0..1);
        }
        if frame.scene_post_effect().is_some() {
            self.scene_post_effect_gpu
                .record(&mut encoder, target.view, frame.compositing())
                .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                    "prepared Scene post effect has no retained color target",
                ))?;
        }
        let command_buffer = encoder.finish();
        evidence.draw_record_ms = draw_record_ms;
        // Labeled nested total: includes the draw-record interval above.
        evidence.command_encode_total_ms = stage_elapsed(clock, command_encode_started);
        let submit_started = stage_started(clock);
        let submission = queue.submit([command_buffer]);
        evidence.submit_ms = stage_elapsed(clock, submit_started);
        Ok((submission, evidence))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_supported_srgb_views_to_their_exact_base_unorm_format() {
        assert_eq!(
            cairo_target_format_for_linear_view(wgpu::TextureFormat::Rgba8UnormSrgb),
            Some(wgpu::TextureFormat::Rgba8Unorm)
        );
        assert_eq!(
            cairo_target_format_for_linear_view(wgpu::TextureFormat::Bgra8UnormSrgb),
            Some(wgpu::TextureFormat::Bgra8Unorm)
        );
        assert_eq!(
            cairo_target_format_for_linear_view(wgpu::TextureFormat::Rgba8Unorm),
            None
        );
    }

    #[test]
    fn multisample_attachment_resolves_four_samples_without_copy_or_sampling_usage() {
        let descriptor =
            multisample_color_texture_descriptor_v1(wgpu::TextureFormat::Rgba8Unorm, 640, 360);
        assert_eq!(descriptor.sample_count, 4);
        assert_eq!(descriptor.mip_level_count, 1);
        assert_eq!(descriptor.dimension, wgpu::TextureDimension::D2);
        assert_eq!(descriptor.format, wgpu::TextureFormat::Rgba8Unorm);
        assert_eq!(
            descriptor.size,
            wgpu::Extent3d {
                width: 640,
                height: 360,
                depth_or_array_layers: 1,
            }
        );
        assert_eq!(descriptor.usage, wgpu::TextureUsages::RENDER_ATTACHMENT);
        assert_eq!(
            multisample_color_target_bytes_v1(3_840, 2_160),
            Ok(132_710_400)
        );
        assert_eq!(multisample_color_target_bytes_v1(640, 360), Ok(3_686_400));
        assert_eq!(MAX_MULTISAMPLE_COLOR_TARGET_BYTES_V1, 536_870_912);
    }

    #[test]
    fn only_manim_cairo_frames_use_backend_multisampling() {
        assert_eq!(paint_sample_count_v1(RenderCompositingV1::LinearLight), 1);
        assert_eq!(
            paint_sample_count_v1(RenderCompositingV1::ManimCairoSrgb),
            4
        );
    }

    #[test]
    fn portable_antialias_extent_is_bounded_by_the_device_limit() {
        assert_eq!(
            portable_aa_extent_v1(1_920, 1_080, 8_192),
            Some([3_840, 2_160])
        );
        assert_eq!(portable_aa_extent_v1(4_097, 1, 8_192), None);
        assert_eq!(portable_aa_extent_v1(u32::MAX, 1, u32::MAX), None);
    }

    #[test]
    fn reserves_the_builtin_shader_id_at_every_revision() {
        assert!(matches!(
            validate_fragment_material_sources_v1(&[FragmentMaterialSourceV1 {
                revision: crate::TIME_GRADIENT_SHADER_REVISION_V1 + 1,
                shader_id: crate::TIME_GRADIENT_SHADER_ID_V1.to_owned(),
                source: "validity is checked after identity admission".to_owned(),
                texture_slot: false,
            }]),
            Err(FragmentMaterialRegistryErrorV1::Reserved { revision: 2, .. })
        ));
    }
}
