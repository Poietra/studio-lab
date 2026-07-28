use std::ops::Range;

use crate::MAX_GPU_UPLOAD_PLAN_BYTES_V1;

const COPY_ALIGNMENT_BYTES: usize = 4;

/// The retained vertex and index capacities may each round up, but their
/// combined high-water mark may never exceed twice one bounded upload plan.
pub const MAX_GPU_BUFFER_ARENA_BYTES_V1: u64 =
    (MAX_GPU_UPLOAD_PLAN_BYTES_V1 as u64).saturating_mul(2);

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum GpuBufferArenaErrorV1 {
    #[error("GPU buffer arena capacity accounting overflowed")]
    CapacityOverflow,
    #[error("GPU buffer arena requires {required_bytes} bytes; maximum is {maximum_bytes}")]
    ByteLimitExceeded {
        maximum_bytes: u64,
        required_bytes: u64,
    },
    #[error(
        "{buffer_kind} GPU buffer requires {required_bytes} bytes; device maximum is {maximum_bytes}"
    )]
    DeviceLimitExceeded {
        buffer_kind: &'static str,
        maximum_bytes: u64,
        required_bytes: u64,
    },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct GpuBufferArenaFrameStatsV1 {
    pub(crate) buffer_creations: u32,
    pub(crate) capacity_bytes: u64,
    pub(crate) upload_bytes: u64,
}

#[derive(Debug)]
struct GpuBufferSlotV1 {
    buffer: Option<wgpu::Buffer>,
    capacity: u64,
    label: &'static str,
    uploaded: Vec<u8>,
    usage: wgpu::BufferUsages,
}

impl GpuBufferSlotV1 {
    fn new(label: &'static str, usage: wgpu::BufferUsages) -> Self {
        Self {
            buffer: None,
            capacity: 0,
            label,
            uploaded: Vec::new(),
            usage,
        }
    }

    fn replace_buffer(&mut self, device: &wgpu::Device, capacity: u64) {
        self.buffer = Some(device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(self.label),
            size: capacity,
            usage: self.usage | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        }));
        self.capacity = capacity;
    }

    fn write(&mut self, queue: &wgpu::Queue, bytes: Vec<u8>, replaced: bool) -> u64 {
        let dirty = if replaced {
            Some(0..bytes.len())
        } else {
            dirty_aligned_range(&self.uploaded, &bytes)
        };
        if let Some(range) = &dirty {
            let buffer = self
                .buffer
                .as_ref()
                .expect("a non-empty upload must have a retained GPU buffer");
            queue.write_buffer(buffer, range.start as u64, &bytes[range.clone()]);
        }
        self.uploaded = bytes;
        dirty.map_or(0, |range| range.len() as u64)
    }
}

/// Per-renderer high-water vertex/index buffers and exact last-upload bytes.
///
/// Buffers grow to powers of two and are never recreated while a frame stays
/// within their retained capacities. Exact byte comparison makes a warm,
/// unchanged frame issue no queue writes; a changed frame writes one bounded,
/// four-byte-aligned dirty span per buffer.
#[derive(Debug)]
pub(crate) struct GpuBufferArenaV1 {
    index: GpuBufferSlotV1,
    vertex: GpuBufferSlotV1,
}

impl Default for GpuBufferArenaV1 {
    fn default() -> Self {
        Self {
            index: GpuBufferSlotV1::new(
                "poietra retained solid paint indices v1",
                wgpu::BufferUsages::INDEX,
            ),
            vertex: GpuBufferSlotV1::new(
                "poietra retained solid paint vertices v1",
                wgpu::BufferUsages::VERTEX,
            ),
        }
    }
}

impl GpuBufferArenaV1 {
    pub(crate) fn buffers(&self) -> Option<(&wgpu::Buffer, &wgpu::Buffer)> {
        Some((self.vertex.buffer.as_ref()?, self.index.buffer.as_ref()?))
    }

    pub(crate) fn upload(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        vertex_bytes: Vec<u8>,
        index_bytes: Vec<u8>,
    ) -> Result<GpuBufferArenaFrameStatsV1, GpuBufferArenaErrorV1> {
        let vertex_required = vertex_bytes.len() as u64;
        let index_required = index_bytes.len() as u64;
        let vertex_capacity = growth_capacity(self.vertex.capacity, vertex_required)?;
        let index_capacity = growth_capacity(self.index.capacity, index_required)?;
        let total_capacity = vertex_capacity
            .checked_add(index_capacity)
            .ok_or(GpuBufferArenaErrorV1::CapacityOverflow)?;
        if total_capacity > MAX_GPU_BUFFER_ARENA_BYTES_V1 {
            return Err(GpuBufferArenaErrorV1::ByteLimitExceeded {
                maximum_bytes: MAX_GPU_BUFFER_ARENA_BYTES_V1,
                required_bytes: total_capacity,
            });
        }
        let device_limit = device.limits().max_buffer_size;
        for (kind, capacity) in [("vertex", vertex_capacity), ("index", index_capacity)] {
            if capacity > device_limit {
                return Err(GpuBufferArenaErrorV1::DeviceLimitExceeded {
                    buffer_kind: kind,
                    maximum_bytes: device_limit,
                    required_bytes: capacity,
                });
            }
        }

        let replace_vertex = vertex_capacity != self.vertex.capacity;
        let replace_index = index_capacity != self.index.capacity;
        if replace_vertex {
            self.vertex.replace_buffer(device, vertex_capacity);
        }
        if replace_index {
            self.index.replace_buffer(device, index_capacity);
        }
        let upload_bytes = self
            .vertex
            .write(queue, vertex_bytes, replace_vertex)
            .saturating_add(self.index.write(queue, index_bytes, replace_index));
        Ok(GpuBufferArenaFrameStatsV1 {
            buffer_creations: u32::from(replace_vertex) + u32::from(replace_index),
            capacity_bytes: total_capacity,
            upload_bytes,
        })
    }
}

fn growth_capacity(current: u64, required: u64) -> Result<u64, GpuBufferArenaErrorV1> {
    if current >= required {
        return Ok(current);
    }
    required
        .checked_next_power_of_two()
        .ok_or(GpuBufferArenaErrorV1::CapacityOverflow)
}

fn dirty_aligned_range(previous: &[u8], current: &[u8]) -> Option<Range<usize>> {
    debug_assert_eq!(wgpu::COPY_BUFFER_ALIGNMENT, 4);
    debug_assert_eq!(previous.len() % COPY_ALIGNMENT_BYTES, 0);
    debug_assert_eq!(current.len() % COPY_ALIGNMENT_BYTES, 0);
    let common = previous.len().min(current.len());
    let first = previous[..common]
        .iter()
        .zip(&current[..common])
        .position(|(left, right)| left != right)
        .unwrap_or(common);
    if first == common && current.len() <= previous.len() {
        return None;
    }
    let start = first / COPY_ALIGNMENT_BYTES * COPY_ALIGNMENT_BYTES;
    if previous.len() != current.len() {
        return Some(start..current.len());
    }
    let trailing_equal = previous[first..]
        .iter()
        .rev()
        .zip(current[first..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let last_changed = current.len() - trailing_equal;
    let end = last_changed.div_ceil(COPY_ALIGNMENT_BYTES) * COPY_ALIGNMENT_BYTES;
    Some(start..end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_grows_geometrically_and_never_past_twice_the_trigger() {
        let mut retained = 0;
        for required in [4, 8, 12, 17, 1_025, 65_535] {
            let next = growth_capacity(retained, required).unwrap();
            if next != retained {
                assert!(next >= required);
                assert!(next < required.saturating_mul(2));
                assert!(next.is_power_of_two());
                retained = next;
            }
        }
        assert_eq!(growth_capacity(retained, 4).unwrap(), retained);
    }

    #[test]
    fn dirty_range_is_aligned_bounded_and_ignores_unused_old_tail() {
        assert_eq!(dirty_aligned_range(&[0; 12], &[0; 12]), None);
        assert_eq!(dirty_aligned_range(&[0; 12], &[0; 8]), None);
        assert_eq!(dirty_aligned_range(&[0; 8], &[0; 12]), Some(8..12));

        let mut changed = [0; 12];
        changed[5] = 1;
        assert_eq!(dirty_aligned_range(&[0; 12], &changed), Some(4..8));
    }
}
