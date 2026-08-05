use std::collections::{HashMap, HashSet};
use std::mem::size_of;
use std::ops::Range;
use std::sync::Arc;

use poietra_scene_ir::{ImageSamplerV1, MAX_ASSETS_V1};

use crate::{DecodedPngAssetV1, PreparedImageDrawV1, RENDER_SAMPLE_COUNT_V1};

const IMAGE_VERTICES_PER_DRAW_V1: usize = 4;
const IMAGE_INDICES_PER_DRAW_V1: usize = 6;
const IMAGE_VERTEX_COMPONENTS_V1: usize = 5;
const IMAGE_VERTEX_SIZE_V1: usize = IMAGE_VERTEX_COMPONENTS_V1 * size_of::<f32>();
const IMAGE_INDEX_PATTERN_V1: [u32; IMAGE_INDICES_PER_DRAW_V1] = [0, 2, 1, 1, 2, 3];
const MAX_IMAGE_GEOMETRY_UPLOAD_BYTES_V1: usize = 64 * 1024 * 1024;
const PREMULTIPLIED_LINEAR_RGBA8_DECODE_VERSION_V1: u8 = 1;

/// Hard ceiling for unique decoded texture bytes uploaded by one frame.
pub const MAX_IMAGE_TEXTURE_UPLOAD_BYTES_V1: usize = 256 * 1024 * 1024;
/// Hard ceiling for unique image textures referenced by one frame.
pub const MAX_IMAGE_TEXTURES_PER_FRAME_V1: usize = MAX_ASSETS_V1;
/// Each unique image can have at most one nearest and one linear binding.
pub const MAX_IMAGE_BIND_GROUPS_PER_FRAME_V1: usize = MAX_IMAGE_TEXTURES_PER_FRAME_V1 * 2;
/// Maximum decoded CPU bytes kept alive by one renderer's texture cache.
pub const MAX_RETAINED_IMAGE_TEXTURE_CPU_BYTES_V1: usize = 128 * 1024 * 1024;
/// Maximum logical RGBA8 bytes resident in one renderer's GPU texture cache.
pub const MAX_RETAINED_IMAGE_TEXTURE_GPU_BYTES_V1: usize = 256 * 1024 * 1024;
/// Maximum unique immutable textures retained by one renderer.
pub const MAX_RETAINED_IMAGE_TEXTURE_ENTRIES_V1: usize = MAX_ASSETS_V1;

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
    #[error(
        "image frame references {required_textures} unique textures; maximum is {maximum_textures}"
    )]
    TextureCountLimitExceeded {
        maximum_textures: usize,
        required_textures: usize,
    },
    #[error(
        "image frame requires {required_bind_groups} texture/sampler bindings; maximum is {maximum_bind_groups}"
    )]
    BindGroupCountLimitExceeded {
        maximum_bind_groups: usize,
        required_bind_groups: usize,
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
    #[error(
        "current image frame requires {required_bytes} decoded CPU bytes; retained cache maximum is {maximum_bytes}"
    )]
    RetainedCpuByteLimitExceeded {
        maximum_bytes: usize,
        required_bytes: usize,
    },
    #[error(
        "current image frame requires {required_bytes} estimated GPU texture bytes; retained cache maximum is {maximum_bytes}"
    )]
    RetainedGpuByteLimitExceeded {
        maximum_bytes: usize,
        required_bytes: usize,
    },
    #[error(
        "current image frame requires {required_entries} retained textures; cache maximum is {maximum_entries}"
    )]
    RetainedEntryLimitExceeded {
        maximum_entries: usize,
        required_entries: usize,
    },
}

/// Logical budgets for the device-bound retained image texture cache.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageTextureCacheLimitsV1 {
    pub decoded_cpu_bytes: usize,
    pub entries: usize,
    pub gpu_texture_bytes: usize,
}

impl Default for ImageTextureCacheLimitsV1 {
    fn default() -> Self {
        Self {
            decoded_cpu_bytes: MAX_RETAINED_IMAGE_TEXTURE_CPU_BYTES_V1,
            entries: MAX_RETAINED_IMAGE_TEXTURE_ENTRIES_V1,
            gpu_texture_bytes: MAX_RETAINED_IMAGE_TEXTURE_GPU_BYTES_V1,
        }
    }
}

/// Per-frame retained image resource evidence.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ImageTextureCacheFrameStatsV1 {
    evictions: u64,
    sampler_binding_creations: u64,
    sampler_binding_hits: u64,
    texture_hits: u64,
    texture_upload_bytes: u64,
    texture_uploads: u64,
}

impl ImageTextureCacheFrameStatsV1 {
    #[must_use]
    pub const fn evictions(self) -> u64 {
        self.evictions
    }

    #[must_use]
    pub const fn sampler_binding_creations(self) -> u64 {
        self.sampler_binding_creations
    }

    #[must_use]
    pub const fn sampler_binding_hits(self) -> u64 {
        self.sampler_binding_hits
    }

    #[must_use]
    pub const fn texture_hits(self) -> u64 {
        self.texture_hits
    }

    #[must_use]
    pub const fn texture_upload_bytes(self) -> u64 {
        self.texture_upload_bytes
    }

    #[must_use]
    pub const fn texture_uploads(self) -> u64 {
        self.texture_uploads
    }
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
            multisample: wgpu::MultisampleState {
                count: RENDER_SAMPLE_COUNT_V1,
                ..wgpu::MultisampleState::default()
            },
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
    bind_group_keys: Vec<ImageBindGroupCacheKeyV1>,
    bind_group_indices: Vec<usize>,
    index_buffer: wgpu::Buffer,
    index_ranges: Vec<Range<u32>>,
    upload_bytes: u64,
    vertex_buffer: wgpu::Buffer,
}

#[derive(Debug)]
pub(crate) struct ImageGeometryUploadPlanV1 {
    index_bytes: Vec<u8>,
    index_ranges: Vec<Range<u32>>,
    vertex_bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
struct ImageTextureUploadV1 {
    asset: Arc<DecodedPngAssetV1>,
    bytes_per_row: u32,
    extent: wgpu::Extent3d,
    key: ImageTextureCacheKeyV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ImageBindGroupUploadV1 {
    sampler: ImageSamplerV1,
    texture_index: usize,
}

#[derive(Debug)]
pub(crate) struct ImageResourceUploadPlanV1 {
    bind_group_indices: Vec<usize>,
    bind_groups: Vec<ImageBindGroupUploadV1>,
    texture_upload_bytes: usize,
    textures: Vec<ImageTextureUploadV1>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ImageTextureCacheKeyV1 {
    decode_version: u8,
    height: u32,
    sha256: String,
    width: u32,
}

impl ImageTextureCacheKeyV1 {
    fn from_asset(asset: &DecodedPngAssetV1) -> Self {
        Self {
            decode_version: PREMULTIPLIED_LINEAR_RGBA8_DECODE_VERSION_V1,
            height: asset.height(),
            sha256: asset.sha256().to_owned(),
            width: asset.width(),
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ImageBindGroupCacheKeyV1 {
    sampler: u8,
    texture: ImageTextureCacheKeyV1,
}

#[derive(Debug)]
struct CachedImageTextureV1 {
    asset: Arc<DecodedPngAssetV1>,
    last_used: u64,
    linear_binding: Option<wgpu::BindGroup>,
    nearest_binding: Option<wgpu::BindGroup>,
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
}

impl CachedImageTextureV1 {
    fn binding(&self, sampler: u8) -> Option<&wgpu::BindGroup> {
        match sampler {
            0 => self.linear_binding.as_ref(),
            1 => self.nearest_binding.as_ref(),
            _ => None,
        }
    }

    fn binding_slot(&mut self, sampler: u8) -> Option<&mut Option<wgpu::BindGroup>> {
        match sampler {
            0 => Some(&mut self.linear_binding),
            1 => Some(&mut self.nearest_binding),
            _ => None,
        }
    }

    fn decoded_bytes(&self) -> usize {
        self.asset.premultiplied_linear_rgba8().len()
    }
}

/// Device-bound LRU. Verified decoded bytes remain shared with the caller's
/// registry, so an evicted or recreated GPU resource never needs page I/O.
#[derive(Debug)]
pub(crate) struct ImageTextureCacheV1 {
    accounted_cpu_bytes: usize,
    accounted_gpu_bytes: usize,
    entries: HashMap<ImageTextureCacheKeyV1, CachedImageTextureV1>,
    limits: ImageTextureCacheLimitsV1,
    use_clock: u64,
}

impl ImageTextureCacheV1 {
    pub(crate) fn with_limits(limits: ImageTextureCacheLimitsV1) -> Self {
        Self {
            accounted_cpu_bytes: 0,
            accounted_gpu_bytes: 0,
            entries: HashMap::new(),
            limits,
            use_clock: 0,
        }
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.accounted_cpu_bytes = 0;
        self.accounted_gpu_bytes = 0;
        self.use_clock = 0;
    }

    pub(crate) const fn accounted_gpu_bytes(&self) -> usize {
        self.accounted_gpu_bytes
    }

    fn binding(&self, key: &ImageBindGroupCacheKeyV1) -> Option<&wgpu::BindGroup> {
        self.entries
            .get(&key.texture)
            .and_then(|entry| entry.binding(key.sampler))
    }

    fn remove(&mut self, key: &ImageTextureCacheKeyV1) -> bool {
        let Some(entry) = self.entries.remove(key) else {
            return false;
        };
        let bytes = entry.decoded_bytes();
        self.accounted_cpu_bytes = self.accounted_cpu_bytes.saturating_sub(bytes);
        self.accounted_gpu_bytes = self.accounted_gpu_bytes.saturating_sub(bytes);
        true
    }

    fn evict_until_fits(
        &mut self,
        protected: &HashSet<ImageTextureCacheKeyV1>,
        missing_bytes: usize,
        missing_entries: usize,
        stats: &mut ImageTextureCacheFrameStatsV1,
    ) -> Result<(), ImageGpuUploadErrorV1> {
        loop {
            let required_entries = self
                .entries
                .len()
                .checked_add(missing_entries)
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
            let required_decoded_bytes = self
                .accounted_cpu_bytes
                .checked_add(missing_bytes)
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
            let required_texture_bytes = self
                .accounted_gpu_bytes
                .checked_add(missing_bytes)
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
            if required_entries <= self.limits.entries
                && required_decoded_bytes <= self.limits.decoded_cpu_bytes
                && required_texture_bytes <= self.limits.gpu_texture_bytes
            {
                return Ok(());
            }
            let candidate = self
                .entries
                .iter()
                .filter(|(key, _)| !protected.contains(*key))
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
                .ok_or(ImageGpuUploadErrorV1::InconsistentDrawPlan)?;
            if !self.remove(&candidate) {
                return Err(ImageGpuUploadErrorV1::InconsistentDrawPlan);
            }
            stats.evictions = stats.evictions.saturating_add(1);
        }
    }

    #[allow(clippy::too_many_lines)] // One cache transaction keeps protected-set eviction and GPU creation atomic.
    pub(crate) fn prepare_frame(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pipeline: &ImagePipelineV1,
        plan: &ImageResourceUploadPlanV1,
    ) -> Result<ImageTextureCacheFrameStatsV1, ImageGpuUploadErrorV1> {
        let mut stats = ImageTextureCacheFrameStatsV1::default();
        let required_entries = plan.textures.len();
        if required_entries > self.limits.entries {
            return Err(ImageGpuUploadErrorV1::RetainedEntryLimitExceeded {
                maximum_entries: self.limits.entries,
                required_entries,
            });
        }
        if plan.texture_upload_bytes > self.limits.decoded_cpu_bytes {
            return Err(ImageGpuUploadErrorV1::RetainedCpuByteLimitExceeded {
                maximum_bytes: self.limits.decoded_cpu_bytes,
                required_bytes: plan.texture_upload_bytes,
            });
        }
        if plan.texture_upload_bytes > self.limits.gpu_texture_bytes {
            return Err(ImageGpuUploadErrorV1::RetainedGpuByteLimitExceeded {
                maximum_bytes: self.limits.gpu_texture_bytes,
                required_bytes: plan.texture_upload_bytes,
            });
        }

        let protected: HashSet<_> = plan
            .textures
            .iter()
            .map(|texture| texture.key.clone())
            .collect();
        let missing: Vec<_> = plan
            .textures
            .iter()
            .filter(|texture| !self.entries.contains_key(&texture.key))
            .collect();
        let missing_bytes = missing.iter().try_fold(0usize, |total, texture| {
            total
                .checked_add(texture.asset.premultiplied_linear_rgba8().len())
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)
        })?;
        self.entries
            .try_reserve(missing.len())
            .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
        self.evict_until_fits(&protected, missing_bytes, missing.len(), &mut stats)?;

        self.use_clock = self.use_clock.saturating_add(1);
        let used = self.use_clock;
        for upload in &plan.textures {
            if let Some(entry) = self.entries.get_mut(&upload.key) {
                entry.last_used = used;
                stats.texture_hits = stats.texture_hits.saturating_add(1);
                continue;
            }
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("poietra retained premultiplied linear image texture v1"),
                size: upload.extent,
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
                upload.asset.premultiplied_linear_rgba8(),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(upload.bytes_per_row),
                    rows_per_image: Some(upload.extent.height),
                },
                upload.extent,
            );
            let bytes = upload.asset.premultiplied_linear_rgba8().len();
            self.accounted_cpu_bytes = self
                .accounted_cpu_bytes
                .checked_add(bytes)
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
            self.accounted_gpu_bytes = self
                .accounted_gpu_bytes
                .checked_add(bytes)
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
            stats.texture_upload_bytes = stats
                .texture_upload_bytes
                .checked_add(
                    u64::try_from(bytes)
                        .map_err(|_| ImageGpuUploadErrorV1::ByteAccountingOverflow)?,
                )
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
            stats.texture_uploads = stats.texture_uploads.saturating_add(1);
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.entries.insert(
                upload.key.clone(),
                CachedImageTextureV1 {
                    asset: Arc::clone(&upload.asset),
                    last_used: used,
                    linear_binding: None,
                    nearest_binding: None,
                    _texture: texture,
                    view,
                },
            );
        }

        for upload in &plan.bind_groups {
            let texture = plan
                .textures
                .get(upload.texture_index)
                .ok_or(ImageGpuUploadErrorV1::InconsistentDrawPlan)?;
            let entry = self
                .entries
                .get_mut(&texture.key)
                .ok_or(ImageGpuUploadErrorV1::InconsistentDrawPlan)?;
            let sampler_key = image_sampler_key(upload.sampler);
            if entry.binding(sampler_key).is_some() {
                stats.sampler_binding_hits = stats.sampler_binding_hits.saturating_add(1);
                continue;
            }
            let binding = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("poietra retained image bind group v1"),
                layout: &pipeline.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&entry.view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(pipeline.sampler(upload.sampler)),
                    },
                ],
            });
            *entry
                .binding_slot(sampler_key)
                .ok_or(ImageGpuUploadErrorV1::InconsistentDrawPlan)? = Some(binding);
            stats.sampler_binding_creations = stats.sampler_binding_creations.saturating_add(1);
        }
        Ok(stats)
    }
}

impl ImageFrameGpuV1 {
    pub(crate) const BUFFER_CREATIONS: u32 = 2;

    pub(crate) fn bind_group<'a>(
        &self,
        draw_index: usize,
        cache: &'a ImageTextureCacheV1,
    ) -> Option<&'a wgpu::BindGroup> {
        self.bind_group_indices
            .get(draw_index)
            .and_then(|index| self.bind_group_keys.get(*index))
            .and_then(|key| cache.binding(key))
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

const fn image_sampler_key(sampler: ImageSamplerV1) -> u8 {
    match sampler {
        ImageSamplerV1::Linear => 0,
        ImageSamplerV1::Nearest => 1,
    }
}

fn preflight_texture_upload_v1(
    asset: &Arc<DecodedPngAssetV1>,
    maximum_dimension: u32,
    prior_upload_bytes: usize,
) -> Result<(ImageTextureUploadV1, usize), ImageGpuUploadErrorV1> {
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
        .zip(usize::try_from(asset.height()).ok())
        .and_then(|(width, height)| width.checked_mul(height))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    if asset.premultiplied_linear_rgba8().len() != expected_bytes {
        return Err(ImageGpuUploadErrorV1::InconsistentDecodedBytes {
            sha256: asset.sha256().to_owned(),
        });
    }
    let texture_upload_bytes = prior_upload_bytes
        .checked_add(expected_bytes)
        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    if texture_upload_bytes > MAX_IMAGE_TEXTURE_UPLOAD_BYTES_V1 {
        return Err(ImageGpuUploadErrorV1::TextureByteLimitExceeded {
            maximum_bytes: MAX_IMAGE_TEXTURE_UPLOAD_BYTES_V1,
            required_bytes: texture_upload_bytes,
        });
    }
    let bytes_per_row = asset
        .width()
        .checked_mul(4)
        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    Ok((
        ImageTextureUploadV1 {
            asset: Arc::clone(asset),
            bytes_per_row,
            extent: wgpu::Extent3d {
                depth_or_array_layers: 1,
                height: asset.height(),
                width: asset.width(),
            },
            key: ImageTextureCacheKeyV1::from_asset(asset),
        },
        texture_upload_bytes,
    ))
}

pub(crate) fn preflight_image_resources_v1(
    draws: &[PreparedImageDrawV1],
    maximum_dimension: u32,
) -> Result<ImageResourceUploadPlanV1, ImageGpuUploadErrorV1> {
    let texture_capacity = draws.len().min(MAX_IMAGE_TEXTURES_PER_FRAME_V1);
    let bind_group_capacity = draws.len().min(MAX_IMAGE_BIND_GROUPS_PER_FRAME_V1);
    let mut texture_by_digest = HashMap::<&str, usize>::new();
    texture_by_digest
        .try_reserve(texture_capacity)
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    let mut bind_group_by_resource = HashMap::<(usize, u8), usize>::new();
    bind_group_by_resource
        .try_reserve(bind_group_capacity)
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    let mut textures = Vec::new();
    textures
        .try_reserve_exact(texture_capacity)
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    let mut bind_groups = Vec::new();
    bind_groups
        .try_reserve_exact(bind_group_capacity)
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    let mut bind_group_indices = Vec::new();
    bind_group_indices
        .try_reserve_exact(draws.len())
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    let mut texture_upload_bytes = 0usize;

    for draw in draws {
        let asset = draw.asset();
        let texture_index = if let Some(index) = texture_by_digest.get(asset.sha256()).copied() {
            index
        } else {
            let required_textures = textures
                .len()
                .checked_add(1)
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
            if required_textures > MAX_IMAGE_TEXTURES_PER_FRAME_V1 {
                return Err(ImageGpuUploadErrorV1::TextureCountLimitExceeded {
                    maximum_textures: MAX_IMAGE_TEXTURES_PER_FRAME_V1,
                    required_textures,
                });
            }
            let (texture, next_upload_bytes) =
                preflight_texture_upload_v1(asset, maximum_dimension, texture_upload_bytes)?;
            texture_upload_bytes = next_upload_bytes;
            let index = textures.len();
            textures.push(texture);
            texture_by_digest.insert(asset.sha256(), index);
            index
        };

        let binding_key = (texture_index, image_sampler_key(draw.sampler()));
        let bind_group_index = if let Some(index) = bind_group_by_resource.get(&binding_key) {
            *index
        } else {
            let required_bind_groups = bind_groups
                .len()
                .checked_add(1)
                .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
            if required_bind_groups > MAX_IMAGE_BIND_GROUPS_PER_FRAME_V1 {
                return Err(ImageGpuUploadErrorV1::BindGroupCountLimitExceeded {
                    maximum_bind_groups: MAX_IMAGE_BIND_GROUPS_PER_FRAME_V1,
                    required_bind_groups,
                });
            }
            let index = bind_groups.len();
            bind_groups.push(ImageBindGroupUploadV1 {
                sampler: draw.sampler(),
                texture_index,
            });
            bind_group_by_resource.insert(binding_key, index);
            index
        };
        bind_group_indices.push(bind_group_index);
    }

    if bind_group_indices.len() != draws.len() {
        return Err(ImageGpuUploadErrorV1::InconsistentDrawPlan);
    }
    Ok(ImageResourceUploadPlanV1 {
        bind_group_indices,
        bind_groups,
        texture_upload_bytes,
        textures,
    })
}

#[allow(clippy::too_many_lines)] // One bounded upload transaction owns all temporary GPU handles.
pub(crate) fn upload_image_frame_v1(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    geometry_plan: ImageGeometryUploadPlanV1,
    resource_plan: ImageResourceUploadPlanV1,
) -> Result<ImageFrameGpuV1, ImageGpuUploadErrorV1> {
    let ImageGeometryUploadPlanV1 {
        index_bytes,
        index_ranges,
        vertex_bytes,
    } = geometry_plan;
    let upload_bytes = vertex_bytes
        .len()
        .checked_add(index_bytes.len())
        .and_then(|bytes| u64::try_from(bytes).ok())
        .ok_or(ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    let vertex_buffer_size = u64::try_from(vertex_bytes.len())
        .map_err(|_| ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    let index_buffer_size = u64::try_from(index_bytes.len())
        .map_err(|_| ImageGpuUploadErrorV1::ByteAccountingOverflow)?;
    let mut bind_group_keys = Vec::new();
    bind_group_keys
        .try_reserve_exact(resource_plan.bind_groups.len())
        .map_err(|_| ImageGpuUploadErrorV1::AllocationFailed)?;
    let ImageResourceUploadPlanV1 {
        bind_group_indices,
        bind_groups: bind_group_uploads,
        texture_upload_bytes: _,
        textures,
    } = resource_plan;

    // The caller constructs the complete resource plan before staging either
    // path or image GPU data; all remaining host allocations were reserved above.
    let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poietra image vertex buffer v1"),
        size: vertex_buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::VERTEX,
        mapped_at_creation: false,
    });
    let index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poietra image index buffer v1"),
        size: index_buffer_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::INDEX,
        mapped_at_creation: false,
    });
    queue.write_buffer(&vertex_buffer, 0, &vertex_bytes);
    queue.write_buffer(&index_buffer, 0, &index_bytes);

    for upload in bind_group_uploads {
        let texture = textures
            .get(upload.texture_index)
            .ok_or(ImageGpuUploadErrorV1::InconsistentDrawPlan)?;
        bind_group_keys.push(ImageBindGroupCacheKeyV1 {
            sampler: image_sampler_key(upload.sampler),
            texture: texture.key.clone(),
        });
    }
    Ok(ImageFrameGpuV1 {
        bind_group_keys,
        bind_group_indices,
        index_buffer,
        index_ranges,
        upload_bytes,
        vertex_buffer,
    })
}
