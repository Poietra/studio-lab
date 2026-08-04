use std::mem::size_of;

use crate::{PreparedFrameV1, PreparedGeometryVertexV1};

const POSITION_COMPONENTS: usize = 2;
const MATERIAL_COMPONENTS: usize = 4;
const F32_BYTES: usize = size_of::<f32>();
pub(crate) const VERTEX_ENCODED_SIZE_V1: usize =
    (POSITION_COMPONENTS + MATERIAL_COMPONENTS) * F32_BYTES;

/// Hard ceiling for one transient vertex-plus-index upload plan.
///
/// `MAX_PREPARED_VERTICES_V1` keeps the currently supported geometry below
/// this value. The independent bound remains explicit so future geometry
/// expansion cannot silently grow a per-frame GPU upload without policy review.
pub const MAX_GPU_UPLOAD_PLAN_BYTES_V1: usize = 64 * 1024 * 1024;

/// Prepared geometry/material data could not become a bounded GPU upload.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum GpuUploadPlanErrorV1 {
    #[error("GPU upload plan byte accounting overflowed")]
    ByteAccountingOverflow,
    #[error("GPU upload plan requires {required_bytes} bytes; maximum is {maximum_bytes}")]
    ByteLimitExceeded {
        maximum_bytes: usize,
        required_bytes: usize,
    },
    #[error("GPU upload plan allocation failed")]
    AllocationFailed,
    #[error("prepared draw plan is internally inconsistent: {0}")]
    Inconsistent(&'static str),
}

/// Transient, bounded bytes consumed by the WGPU buffer-staging boundary.
///
/// Geometry positions and per-phase materials remain separate until this plan
/// interleaves the current shader's vertex layout. The plan is rebuilt for each
/// sampled frame and discarded after buffer staging; it is not a cache.
#[derive(Debug, Eq, PartialEq)]
pub struct GpuUploadPlanV1 {
    index_bytes: Vec<u8>,
    vertex_bytes: Vec<u8>,
}

impl GpuUploadPlanV1 {
    pub(crate) fn into_parts(self) -> (Vec<u8>, Vec<u8>) {
        (self.vertex_bytes, self.index_bytes)
    }

    #[must_use]
    pub fn index_bytes(&self) -> &[u8] {
        &self.index_bytes
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.index_bytes.is_empty()
    }

    #[must_use]
    pub fn upload_bytes(&self) -> usize {
        self.vertex_bytes.len() + self.index_bytes.len()
    }

    #[must_use]
    pub fn vertex_bytes(&self) -> &[u8] {
        &self.vertex_bytes
    }
}

/// Resolves separate geometry, material, and ordered-draw plans into the
/// current shader's bounded vertex/index byte layout.
///
/// # Errors
///
/// Returns a checked byte-limit/allocation error, or an internal-consistency
/// error if a privately constructed preparation plan does not cover each
/// geometry vertex exactly once.
pub fn build_gpu_upload_plan_v1(
    frame: &PreparedFrameV1,
) -> Result<GpuUploadPlanV1, GpuUploadPlanErrorV1> {
    build_gpu_upload_plan_with_limit(frame, MAX_GPU_UPLOAD_PLAN_BYTES_V1)
}

fn build_gpu_upload_plan_with_limit(
    frame: &PreparedFrameV1,
    maximum_bytes: usize,
) -> Result<GpuUploadPlanV1, GpuUploadPlanErrorV1> {
    let vertex_bytes_len = frame
        .geometry_plan()
        .vertices()
        .len()
        .checked_mul(VERTEX_ENCODED_SIZE_V1)
        .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)?;
    let index_bytes_len = frame
        .indices()
        .len()
        .checked_mul(size_of::<u32>())
        .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)?;
    let required_bytes = vertex_bytes_len
        .checked_add(index_bytes_len)
        .ok_or(GpuUploadPlanErrorV1::ByteAccountingOverflow)?;
    if required_bytes > maximum_bytes {
        return Err(GpuUploadPlanErrorV1::ByteLimitExceeded {
            maximum_bytes,
            required_bytes,
        });
    }

    let mut vertex_bytes = Vec::new();
    vertex_bytes
        .try_reserve_exact(vertex_bytes_len)
        .map_err(|_| GpuUploadPlanErrorV1::AllocationFailed)?;
    encode_ordered_vertices(frame, &mut vertex_bytes)?;
    if vertex_bytes.len() != vertex_bytes_len {
        return Err(GpuUploadPlanErrorV1::Inconsistent(
            "encoded vertex bytes do not match the accounted size",
        ));
    }

    let mut index_bytes = Vec::new();
    index_bytes
        .try_reserve_exact(index_bytes_len)
        .map_err(|_| GpuUploadPlanErrorV1::AllocationFailed)?;
    for index in frame.indices() {
        index_bytes.extend_from_slice(&index.to_le_bytes());
    }
    Ok(GpuUploadPlanV1 {
        index_bytes,
        vertex_bytes,
    })
}

fn encode_ordered_vertices(
    frame: &PreparedFrameV1,
    output: &mut Vec<u8>,
) -> Result<(), GpuUploadPlanErrorV1> {
    let mut next_vertex = 0usize;
    for draw in frame.draws() {
        let range = draw.vertex_range();
        let start = usize::try_from(range.start).map_err(|_| {
            GpuUploadPlanErrorV1::Inconsistent("draw vertex start does not fit usize")
        })?;
        let end = usize::try_from(range.end).map_err(|_| {
            GpuUploadPlanErrorV1::Inconsistent("draw vertex end does not fit usize")
        })?;
        if start != next_vertex || end < start || end > frame.geometry_plan().vertices().len() {
            return Err(GpuUploadPlanErrorV1::Inconsistent(
                "ordered draw vertex ranges are not contiguous",
            ));
        }
        let material = frame
            .material_for_draw(draw)
            .ok_or(GpuUploadPlanErrorV1::Inconsistent(
                "draw references an unknown material",
            ))?;
        for &vertex in &frame.geometry_plan().vertices()[start..end] {
            encode_vertex(
                vertex,
                material.color_for_compositing(frame.compositing()),
                output,
            );
        }
        next_vertex = end;
    }
    if next_vertex != frame.geometry_plan().vertices().len() {
        return Err(GpuUploadPlanErrorV1::Inconsistent(
            "ordered draw plan does not cover every geometry vertex",
        ));
    }
    Ok(())
}

fn encode_vertex(vertex: PreparedGeometryVertexV1, color: [f32; 4], output: &mut Vec<u8>) {
    for value in vertex.position().into_iter().chain(color) {
        output.extend_from_slice(&value.to_le_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleaves_geometry_and_material_with_a_checked_hard_limit() {
        let frame = PreparedFrameV1::triangle_for_upload_test();
        let required_bytes = 3 * VERTEX_ENCODED_SIZE_V1 + 3 * size_of::<u32>();
        let plan = build_gpu_upload_plan_with_limit(&frame, required_bytes).unwrap();
        assert_eq!(plan.upload_bytes(), required_bytes);
        assert_eq!(plan.index_bytes(), &[0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0]);
        let first = plan
            .vertex_bytes()
            .chunks_exact(F32_BYTES)
            .take(POSITION_COMPONENTS + MATERIAL_COMPONENTS)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(first, vec![-1.0, -1.0, 0.5, 0.25, 0.0, 0.5]);

        assert_eq!(
            build_gpu_upload_plan_with_limit(&frame, required_bytes - 1),
            Err(GpuUploadPlanErrorV1::ByteLimitExceeded {
                maximum_bytes: required_bytes - 1,
                required_bytes,
            })
        );
    }

    #[test]
    fn selects_material_bytes_from_the_explicit_compositing_contract() {
        let linear =
            build_gpu_upload_plan_v1(&PreparedFrameV1::triangle_for_upload_test_with_compositing(
                poietra_scene_ir::RenderCompositingV1::LinearLight,
            ))
            .unwrap();
        let cairo =
            build_gpu_upload_plan_v1(&PreparedFrameV1::triangle_for_upload_test_with_compositing(
                poietra_scene_ir::RenderCompositingV1::ManimCairoSrgb,
            ))
            .unwrap();
        let decode_first_color = |plan: &GpuUploadPlanV1| {
            plan.vertex_bytes()
                .chunks_exact(F32_BYTES)
                .skip(POSITION_COMPONENTS)
                .take(MATERIAL_COMPONENTS)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>()
        };

        assert_eq!(decode_first_color(&linear), vec![0.5, 0.25, 0.0, 0.5]);
        assert_eq!(decode_first_color(&cairo), vec![0.4, 0.3, 0.2, 0.5]);
    }
}
