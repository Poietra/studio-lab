use std::collections::HashMap;
use std::mem::size_of;
use std::ops::Range;

use poietra_scene_ir::ImageSamplerV1;

use crate::PreparedImageDrawV1;

const IMAGE_VERTICES_PER_DRAW_V1: usize = 4;
const IMAGE_INDICES_PER_DRAW_V1: usize = 6;
const IMAGE_VERTEX_COMPONENTS_V1: usize = 5;
const IMAGE_VERTEX_SIZE_V1: usize = IMAGE_VERTEX_COMPONENTS_V1 * size_of::<f32>();
const IMAGE_INDEX_PATTERN_V1: [u32; IMAGE_INDICES_PER_DRAW_V1] = [0, 2, 1, 1, 2, 3];
const MAX_IMAGE_GEOMETRY_UPLOAD_BYTES_V1: usize = 64 * 1024 * 1024;

/// Hard ceiling for unique decoded texture bytes uploaded by one frame.
pub const MAX_IMAGE_TEXTURE_UPLOAD_BYTES_V1: usize = 256 * 1024 * 1024;

const IMAGE_VERTEX_ATTRIBUTES_V1: [wgpu::VertexAttribute; 3] = [
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x2,
        offset: 0,
        shader_location: 0,
    },
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32x2,
        offset: 8,
        shader_location: 1,
    },
    wgpu::VertexAttribute {
        format: wgpu::VertexFormat::Float32,
        offset: 16,
        shader_location: 2,
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

/// A prepared image frame cannot be staged within checked GPU limits.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ImageGpuUploadErrorV1 {
    #[error("image GPU upload byte accounting overflowed")]
    ByteAccountingOverflow,
    #[error("image geometry upload requires {required_bytes} bytes; maximum is {maximum_bytes}")]
    GeometryByteLimitExceeded {
        maximum_bytes: usize,
        required_bytes: usize,
    },
    #[error("image texture upload requires {required_bytes} bytes; maximum is {maximum_bytes}")]
    TextureByteLimitExceeded {
        maximum_bytes: usize,
        required_bytes: usize,
    },
    #[error("image upload allocation failed")]
    AllocationFailed,
    #[error("image draw count exceeds the u32 indexed-draw range")]
    IndexRange,
    #[error(
        "image digest {sha256} dimensions {width}x{height} exceed device limit {maximum_dimension}"
    )]
    DeviceDimensionLimit {
        height: u32,
        maximum_dimension: u32,
        sha256: String,
        width: u32,
    },
    #[error("decoded image digest {sha256} has an inconsistent RGBA8 byte length")]
    InconsistentDecodedBytes { sha256: String },
    #[error("prepared image draw plan is internally inconsistent")]
    InconsistentDrawPlan,
}

#[derive(Debug)]
pub(crate) struct ImagePipelineV1 {
    bind_group_layout: wgpu::BindGroupLayout,
    linear_sampler: wgpu::Sampler,
    nearest_sampler: wgpu::Sampler,
    pipeline: wgpu::RenderPipeline,
}

impl ImagePipelineV1 {
    pub(crate) fn new(device: &wgpu::Device, target_format: wgpu::TextureFormat) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("poietra image bind group layout v1"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        multisampled: false,
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("poietra image pipeline layout v1"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::include_wgsl!("image.wgsl"));
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("poietra premultiplied image pipeline v1"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: IMAGE_VERTEX_SIZE_V1 as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &IMAGE_VERTEX_ATTRIBUTES_V1,
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
        let sampler = |label, filter| {
            let mipmap_filter = match filter {
                wgpu::FilterMode::Linear => wgpu::MipmapFilterMode::Linear,
                wgpu::FilterMode::Nearest => wgpu::MipmapFilterMode::Nearest,
            };
            device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some(label),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: filter,
                min_filter: filter,
                mipmap_filter,
                ..wgpu::SamplerDescriptor::default()
            })
        };
        Self {
            bind_group_layout,
            linear_sampler: sampler("poietra linear clamp sampler v1", wgpu::FilterMode::Linear),
            nearest_sampler: sampler(
                "poietra nearest clamp sampler v1",
                wgpu::FilterMode::Nearest,
            ),
            pipeline,
        }
    }

    pub(crate) const fn pipeline(&self) -> &wgpu::RenderPipeline {
        &self.pipeline
    }

    fn sampler(&self, sampler: ImageSamplerV1) -> &wgpu::Sampler {
        match sampler {
            ImageSamplerV1::Linear => &self.linear_sampler,
            ImageSamplerV1::Nearest => &self.nearest_sampler,
        }
    }
}

#[derive(Debug)]
pub(crate) struct ImageFrameGpuV1 {
    bind_groups: Vec<wgpu::BindGroup>,
    index_buffer: wgpu::Buffer,
    index_ranges: Vec<Range<u32>>,
    _textures: Vec<wgpu::Texture>,
    _texture_views: Vec<wgpu::TextureView>,
    upload_bytes: u64,
    vertex_buffer: wgpu::Buffer,
}

#[derive(Debug)]
pub(crate) struct ImageGeometryUploadPlanV1 {
    index_bytes: Vec<u8>,
    index_ranges: Vec<Range<u32>>,
    vertex_bytes: Vec<u8>,
}

impl ImageFrameGpuV1 {
    pub(crate) const BUFFER_CREATIONS: u32 = 2;

    pub(crate) fn bind_group(&self, index: usize) -> Option<&wgpu::BindGroup> {
        self.bind_groups.get(index)
    }

    pub(crate) const fn index_buffer(&self) -> &wgpu::Buffer {
        &self.index_buffer
    }

    pub(crate) fn index_range(&self, index: usize) -> Option<Range<u32>> {
        self.index_ranges.get(index).cloned()
    }

    pub(crate) const fn upload_bytes(&self) -> u64 {
        self.upload_bytes
    }

    pub(crate) const fn vertex_buffer(&self) -> &wgpu::Buffer {
        &self.vertex_buffer
    }
}

fn checked_image_geometry_lengths(
    draw_count: usize,
) -> Result<(usize, usize), ImageGpuUploadErrorV1> {
    let vertex_bytes = draw_count
        .checked_mul(IMAGE_VERTICES_PER_DRAW_V1)
        .and_then(|count| count.checked_mul(IMAGE_VERTEX_SIZE_V1))
        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    let index_bytes = draw_count
        .checked_mul(IMAGE_INDICES_PER_DRAW_V1)
        .and_then(|count| count.checked_mul(size_of::<u32>()))
        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    let required_bytes = vertex_bytes
        .checked_add(index_bytes)
        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    if required_bytes > MAX_IMAGE_GEOMETRY_UPLOAD_BYTES_V1 {
        return Err(ImageGpuUploadErrorV1::GeometryByteLimitExceeded {
            maximum_bytes: MAX_IMAGE_GEOMETRY_UPLOAD_BYTES_V1,
            required_bytes,
        });
    }
    Ok((vertex_bytes, index_bytes))
}

pub(crate) fn build_image_geometry_upload_plan_v1(
    draws: &[PreparedImageDrawV1],
) -> Result<Option<ImageGeometryUploadPlanV1>, ImageGpuUploadErrorV1> {
    if draws.is_empty() {
        return Ok(None);
    }
    let (vertex_bytes_len, index_bytes_len) = checked_image_geometry_lengths(draws.len())?;
    let mut vertex_bytes = Vec::new();
    vertex_bytes
        .try_reserve_exact(vertex_bytes_len)
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    let mut index_bytes = Vec::new();
    index_bytes
        .try_reserve_exact(index_bytes_len)
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    let mut index_ranges = Vec::new();
    index_ranges
        .try_reserve_exact(draws.len())
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    for (draw_index, draw) in draws.iter().enumerate() {
        for vertex in draw.vertices() {
            for value in vertex
                .position()
                .into_iter()
                .chain(vertex.uv())
                .chain([draw.opacity()])
            {
                vertex_bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        let base_vertex = draw_index
            .checked_mul(IMAGE_VERTICES_PER_DRAW_V1)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(ImageGpuUploadErrorV1::IndexRange)?;
        let index_start = draw_index
            .checked_mul(IMAGE_INDICES_PER_DRAW_V1)
            .and_then(|value| u32::try_from(value).ok())
            .ok_or(ImageGpuUploadErrorV1::IndexRange)?;
        for local_index in IMAGE_INDEX_PATTERN_V1 {
            index_bytes.extend_from_slice(
                &base_vertex
                    .checked_add(local_index)
                    .ok_or(ImageGpuUploadErrorV1::IndexRange)?
                    .to_le_bytes(),
            );
        }
        index_ranges.push(
            index_start
                ..index_start
                    .checked_add(
                        u32::try_from(IMAGE_INDICES_PER_DRAW_V1)
                            .map_err(|_| ImageGpuUploadErrorV1::IndexRange)?,
                    )
                    .ok_or(ImageGpuUploadErrorV1::IndexRange)?,
        );
    }
    if vertex_bytes.len() != vertex_bytes_len || index_bytes.len() != index_bytes_len {
        return Err(ImageGpuUploadErrorV1::InconsistentDrawPlan);
    }
    Ok(Some(ImageGeometryUploadPlanV1 {
        index_bytes,
        index_ranges,
        vertex_bytes,
    }))
}

#[allow(clippy::too_many_lines)] // One bounded upload transaction owns all temporary GPU handles.
pub(crate) fn upload_image_frame_v1(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipeline: &ImagePipelineV1,
    draws: &[PreparedImageDrawV1],
    plan: ImageGeometryUploadPlanV1,
) -> Result<ImageFrameGpuV1, ImageGpuUploadErrorV1> {
    let ImageGeometryUploadPlanV1 {
        index_bytes,
        index_ranges,
        vertex_bytes,
    } = plan;
    let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poietra image vertex buffer v1"),
        size: u64::try_from(vertex_bytes.len())
            .map_err(|_| ImageGpuUploadErrorV1::ByteAccountingOverflow)?,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::VERTEX,
        mapped_at_creation: false,
    });
    let index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poietra image index buffer v1"),
        size: u64::try_from(index_bytes.len())
            .map_err(|_| ImageGpuUploadErrorV1::ByteAccountingOverflow)?,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::INDEX,
        mapped_at_creation: false,
    });
    queue.write_buffer(&vertex_buffer, 0, &vertex_bytes);
    queue.write_buffer(&index_buffer, 0, &index_bytes);

    let maximum_dimension = device.limits().max_texture_dimension_2d;
    let mut textures = Vec::new();
    let mut texture_views = Vec::new();
    let mut resource_by_digest = HashMap::new();
    let mut texture_upload_bytes = 0usize;
    for draw in draws {
        let asset = draw.asset();
        if resource_by_digest.contains_key(asset.sha256()) {
            continue;
        }
        if asset.width() > maximum_dimension || asset.height() > maximum_dimension {
            return Err(ImageGpuUploadErrorV1::DeviceDimensionLimit {
                height: asset.height(),
                maximum_dimension,
                sha256: asset.sha256().to_owned(),
                width: asset.width(),
            });
        }
        let expected_bytes = usize::try_from(asset.width())
            .ok()
            .and_then(|width| {
                usize::try_from(asset.height())
                    .ok()
                    .map(|height| (width, height))
            })
            .and_then(|(width, height)| width.checked_mul(height))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
        if asset.premultiplied_linear_rgba8().len() != expected_bytes {
            return Err(ImageGpuUploadErrorV1::InconsistentDecodedBytes {
                sha256: asset.sha256().to_owned(),
            });
        }
        texture_upload_bytes = texture_upload_bytes
            .checked_add(expected_bytes)
            .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
        if texture_upload_bytes > MAX_IMAGE_TEXTURE_UPLOAD_BYTES_V1 {
            return Err(ImageGpuUploadErrorV1::TextureByteLimitExceeded {
                maximum_bytes: MAX_IMAGE_TEXTURE_UPLOAD_BYTES_V1,
                required_bytes: texture_upload_bytes,
            });
        }
        let extent = wgpu::Extent3d {
            depth_or_array_layers: 1,
            height: asset.height(),
            width: asset.width(),
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("poietra premultiplied linear image texture v1"),
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            asset.premultiplied_linear_rgba8(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(
                    asset
                        .width()
                        .checked_mul(4)
                        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?,
                ),
                rows_per_image: Some(asset.height()),
            },
            extent,
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let resource_index = texture_views.len();
        textures.push(texture);
        texture_views.push(view);
        resource_by_digest.insert(asset.sha256().to_owned(), resource_index);
    }

    let mut bind_groups = Vec::new();
    bind_groups
        .try_reserve_exact(draws.len())
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    for draw in draws {
        let resource_index = resource_by_digest
            .get(draw.asset().sha256())
            .copied()
            .ok_or(ImageGpuUploadErrorV1::InconsistentDrawPlan)?;
        let view = texture_views
            .get(resource_index)
            .ok_or(ImageGpuUploadErrorV1::InconsistentDrawPlan)?;
        bind_groups.push(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("poietra image bind group v1"),
            layout: &pipeline.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(pipeline.sampler(draw.sampler())),
                },
            ],
        }));
    }
    let upload_bytes = vertex_bytes
        .len()
        .checked_add(index_bytes.len())
        .and_then(|bytes| bytes.checked_add(texture_upload_bytes))
        .and_then(|bytes| u64::try_from(bytes).ok())
        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    Ok(ImageFrameGpuV1 {
        bind_groups,
        index_buffer,
        index_ranges,
        _textures: textures,
        _texture_views: texture_views,
        upload_bytes,
        vertex_buffer,
    })
}
