use crate::arena::GpuBufferArenaV1;
use crate::image_gpu::{
    ImageFrameGpuV1, ImagePipelineV1, ImageTextureCacheV1, build_image_geometry_upload_plan_v1,
    preflight_image_resources_v1, upload_image_frame_v1,
};
use crate::upload::VERTEX_ENCODED_SIZE_V1;
use crate::{
    GpuBufferArenaErrorV1, GpuUploadPlanErrorV1, ImageGpuUploadErrorV1,
    ImageTextureCacheFrameStatsV1, ImageTextureCacheLimitsV1, MANIM_CAIRO_SAMPLE_COUNT_V1,
    PreparedFrameV1, PreparedRenderCommandV1, build_gpu_upload_plan_v1,
};
use poietra_scene_ir::{MAX_VIEWPORT_PIXELS_V1, RenderCompositingV1};

const VERTEX_STRIDE: wgpu::BufferAddress = VERTEX_ENCODED_SIZE_V1 as wgpu::BufferAddress;
const RGBA8_BYTES_PER_SAMPLE_V1: u64 = 4;
const PORTABLE_AA_SCALE_V1: u32 = 2;

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

fn record_ordered_draws_v1(
    pass: &mut wgpu::RenderPass<'_>,
    paint_pipeline: &wgpu::RenderPipeline,
    paint_buffers: Option<(&wgpu::Buffer, &wgpu::Buffer)>,
    image_pipeline: &ImagePipelineV1,
    image_texture_cache: &ImageTextureCacheV1,
    image_frame: Option<&ImageFrameGpuV1>,
    frame: &PreparedFrameV1,
) -> Result<u64, GpuUploadPlanErrorV1> {
    let mut command_index = 0usize;
    let mut draw_calls = 0u64;
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
    image_pipeline: ImagePipelineV1,
    image_texture_cache: ImageTextureCacheV1,
    multisample_target: Option<MultisampleColorTargetV1>,
    pipeline: wgpu::RenderPipeline,
    portable_aa_bind_group_layout: wgpu::BindGroupLayout,
    portable_aa_pipeline: wgpu::RenderPipeline,
    portable_aa_target: Option<PortableAntialiasTargetV1>,
    target_format: wgpu::TextureFormat,
}

/// Exact logical byte counts for GPU resources retained by one renderer.
///
/// These values cover the grow-only vertex/index buffer arena, image textures
/// retained by the bounded LRU, and the active antialias color attachment. That
/// attachment is either the Manim/Cairo four-sample target or the linear-light
/// two-times portable target.
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

    /// Logical bytes retained by the active antialias color attachment.
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
    #[error("antialias color-target byte accounting overflowed")]
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
        Ok(Self {
            arena: GpuBufferArenaV1::default(),
            cairo_pipeline,
            cairo_target_format,
            image_pipeline: ImagePipelineV1::new(device, target_format),
            image_texture_cache: ImageTextureCacheV1::with_limits(image_texture_cache_limits),
            multisample_target: None,
            pipeline,
            portable_aa_bind_group_layout,
            portable_aa_pipeline,
            portable_aa_target: None,
            target_format,
        })
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

        let mut evidence = RenderStageEvidenceV1::empty();
        let has_geometry = !frame.indices().is_empty() || !frame.image_draws().is_empty();
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
            let image_resources = if image_upload.is_some() {
                Some(preflight_image_resources_v1(
                    frame.image_draws(),
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
            let (render_view, resolve_target, store) = if uses_multisample_target {
                let multisample_view = &self
                    .multisample_target
                    .as_ref()
                    .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                        "validated Cairo target extent did not retain a multisample attachment",
                    ))?
                    .view;
                (multisample_view, Some(target.view), wgpu::StoreOp::Discard)
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
            let attachments = [Some(wgpu::RenderPassColorAttachment {
                view: target.view,
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
}
