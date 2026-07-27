use wgpu::util::DeviceExt;

use crate::PreparedFrameV1;

const VERTEX_STRIDE: wgpu::BufferAddress = 24;
const VERTEX_ENCODED_SIZE: usize = 24;
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
    /// Wall time for the two `create_buffer_init` calls, which create the
    /// vertex/index buffers and stage the encoded bytes into them. This is a
    /// CPU-side create-and-stage cost, not a GPU transfer measurement.
    pub buffer_create_and_stage_ms: Option<f64>,
    /// `create_buffer_init` calls issued for this frame (0 for empty frames).
    pub buffer_creations: u32,
    /// Wall time from command-encoder creation through `encoder.finish()`.
    /// This is a nested total: it INCLUDES the `draw_record_ms` interval.
    /// Command encoding and submission always execute, even for empty frames.
    pub command_encode_total_ms: Option<f64>,
    /// Indexed draw calls recorded into the render pass.
    pub draw_calls: u64,
    /// Wall time recording the per-draw `draw_indexed` loop; nested inside
    /// `command_encode_total_ms`.
    pub draw_record_ms: Option<f64>,
    /// Whether the geometry stages (`vertex_index_encode`,
    /// `buffer_create_and_stage`, `draw_record`) executed for this frame.
    /// They are skipped as a group exactly when the frame has no indices.
    pub geometry_stages_executed: bool,
    /// Wall time submitting the finished command buffer to the queue. Queue
    /// submission returning says nothing about GPU execution completion.
    pub submit_ms: Option<f64>,
    /// Vertex plus index bytes encoded and staged through buffer creation.
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

/// Browser/native WGPU pipeline for premultiplied solid-paint triangles.
///
/// The historical `Fill` name remains for API compatibility; new callers may
/// use the [`crate::WgpuPaintRendererV1`] alias.
#[derive(Debug)]
pub struct WgpuFillRendererV1 {
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
    /// Returns a format or extent mismatch before allocating or uploading frame buffers.
    pub fn render(
        &self,
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
    /// Returns the same format or extent mismatch errors as [`Self::render`].
    pub fn render_with_stage_evidence(
        &self,
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
        let buffers = if frame.indices().is_empty() {
            None
        } else {
            evidence.geometry_stages_executed = true;
            let vertex_index_encode_started = stage_started(clock);
            let vertex_bytes = encode_vertices(frame);
            let index_bytes = encode_indices(frame);
            evidence.vertex_index_encode_ms = stage_elapsed(clock, vertex_index_encode_started);
            evidence.buffer_creations = 2;
            evidence.upload_bytes = vertex_bytes.len() as u64 + index_bytes.len() as u64;
            let buffer_create_started = stage_started(clock);
            let created = (
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("poietra solid paint vertices v1"),
                    contents: &vertex_bytes,
                    usage: wgpu::BufferUsages::VERTEX,
                }),
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("poietra solid paint indices v1"),
                    contents: &index_bytes,
                    usage: wgpu::BufferUsages::INDEX,
                }),
            );
            evidence.buffer_create_and_stage_ms = stage_elapsed(clock, buffer_create_started);
            Some(created)
        };

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
            if let Some((vertex_buffer, index_buffer)) = &buffers {
                pass.set_pipeline(&self.pipeline);
                pass.set_vertex_buffer(0, vertex_buffer.slice(..));
                pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                let draw_record_started = stage_started(clock);
                for draw in frame.draws() {
                    pass.draw_indexed(draw.index_range().clone(), 0, 0..1);
                }
                draw_record_ms = stage_elapsed(clock, draw_record_started);
                evidence.draw_calls = frame.draws().len() as u64;
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

fn encode_vertices(frame: &PreparedFrameV1) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(frame.vertices().len() * VERTEX_ENCODED_SIZE);
    for vertex in frame.vertices() {
        for value in vertex
            .position()
            .into_iter()
            .chain(vertex.premultiplied_linear_color())
        {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }
    bytes
}

fn encode_indices(frame: &PreparedFrameV1) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(frame.indices()));
    for index in frame.indices() {
        bytes.extend_from_slice(&index.to_le_bytes());
    }
    bytes
}
