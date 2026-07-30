use crate::arena::GpuBufferArenaV1;
use crate::image_gpu::{
    ImageFrameGpuV1, ImagePipelineV1, build_image_geometry_upload_plan_v1,
    preflight_image_resources_v1, upload_image_frame_v1,
};
use crate::upload::VERTEX_ENCODED_SIZE_V1;
use crate::{
    GpuBufferArenaErrorV1, GpuUploadPlanErrorV1, ImageGpuUploadErrorV1, PreparedFrameV1,
    PreparedRenderCommandV1, build_gpu_upload_plan_v1,
};

const VERTEX_STRIDE: wgpu::BufferAddress = VERTEX_ENCODED_SIZE_V1 as wgpu::BufferAddress;
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
    const fn empty() -> Self {
        Self {
            buffer_create_and_stage_ms: None,
            buffer_creations: 0,
            command_encode_total_ms: None,
            draw_calls: 0,
            draw_record_ms: None,
            geometry_stages_executed: false,
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
                let bind_group = image_frame.bind_group(image_index).ok_or(
                    GpuUploadPlanErrorV1::Inconsistent(
                        "image command references an unknown bind group",
                    ),
                )?;
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
    image_pipeline: ImagePipelineV1,
    pipeline: wgpu::RenderPipeline,
    target_format: wgpu::TextureFormat,
}

impl WgpuFillRendererV1 {
    /// Creates a single-sample pipeline for the caller's target format.
    ///
    /// # Errors
    ///
    /// Rejects non-sRGB or non-eight-bit targets before creating GPU resources.
    pub fn new(
        device: &wgpu::Device,
        target_format: wgpu::TextureFormat,
    ) -> Result<Self, CreateRendererErrorV1> {
        if !matches!(
            target_format,
            wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
        ) {
            return Err(CreateRendererErrorV1::UnsupportedTargetFormat {
                format: target_format,
            });
        }
        let shader = device.create_shader_module(wgpu::include_wgsl!("fill.wgsl"));
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("poietra solid paint pipeline v1"),
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
        Ok(Self {
            arena: GpuBufferArenaV1::default(),
            image_pipeline: ImagePipelineV1::new(device, target_format),
            pipeline,
            target_format,
        })
    }

    #[must_use]
    pub const fn target_format(&self) -> wgpu::TextureFormat {
        self.target_format
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
        if target.format != self.target_format {
            return Err(RenderFrameErrorV1::TargetFormatMismatch {
                actual: target.format,
                expected: self.target_format,
            });
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
            if let Some((vertex_bytes, index_bytes)) = path_upload {
                let arena_stats = self
                    .arena
                    .upload(device, queue, vertex_bytes, index_bytes)?;
                evidence.buffer_creations = arena_stats.buffer_creations;
                evidence.upload_bytes = arena_stats.upload_bytes;
                debug_assert!(arena_stats.capacity_bytes > 0);
            }
            if let Some((image_upload, image_resources)) = image_upload.zip(image_resources) {
                let uploaded = upload_image_frame_v1(
                    device,
                    queue,
                    &self.image_pipeline,
                    image_upload,
                    image_resources,
                )?;
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
            let attachments = [Some(wgpu::RenderPassColorAttachment {
                view: target.view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: clear[0],
                        g: clear[1],
                        b: clear[2],
                        a: clear[3],
                    }),
                    store: wgpu::StoreOp::Store,
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
                evidence.draw_calls = record_ordered_draws_v1(
                    &mut pass,
                    &self.pipeline,
                    paint_buffers(&self.arena, frame)?,
                    &self.image_pipeline,
                    image_frame.as_ref(),
                    frame,
                )?;
                draw_record_ms = stage_elapsed(clock, draw_record_started);
            }
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
