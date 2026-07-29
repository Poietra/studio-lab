use poietra_scene_ir::{AffineTransformV1, CubicPathV1};

use crate::{
    GeometryError, sample_cubic_path_manim_point_from_proportion_v1, sample_cubic_path_v1,
};

/// Interpolates all six affine components independently.
pub fn interpolate_affine_transform_v1(
    left: &AffineTransformV1,
    right: &AffineTransformV1,
    progress: f64,
) -> AffineTransformV1 {
    AffineTransformV1 {
        m11: left.m11 + (right.m11 - left.m11) * progress,
        m12: left.m12 + (right.m12 - left.m12) * progress,
        m21: left.m21 + (right.m21 - left.m21) * progress,
        m22: left.m22 + (right.m22 - left.m22) * progress,
        tx: left.tx + (right.tx - left.tx) * progress,
        ty: left.ty + (right.ty - left.ty) * progress,
    }
}

/// Returns `outer * inner` using the v1 column-vector affine convention.
pub fn compose_affine_transforms_v1(
    outer: &AffineTransformV1,
    inner: &AffineTransformV1,
) -> AffineTransformV1 {
    AffineTransformV1 {
        m11: outer.m11 * inner.m11 + outer.m12 * inner.m21,
        m12: outer.m11 * inner.m12 + outer.m12 * inner.m22,
        m21: outer.m21 * inner.m11 + outer.m22 * inner.m21,
        m22: outer.m21 * inner.m12 + outer.m22 * inner.m22,
        tx: outer.m11 * inner.tx + outer.m12 * inner.ty + outer.tx,
        ty: outer.m21 * inner.tx + outer.m22 * inner.ty + outer.ty,
    }
}

/// Replaces translation with the sampled motion-path point and optionally
/// pre-rotates the sampled linear part to the path tangent.
///
/// # Errors
///
/// Returns a geometry error for invalid path data or when orientation is
/// requested but the entire path has no non-zero tangent.
pub fn apply_motion_path_v1(
    transform: &AffineTransformV1,
    path: &CubicPathV1,
    progress: f64,
    orient_to_path: bool,
) -> Result<AffineTransformV1, GeometryError> {
    let sample = sample_cubic_path_v1(path, progress)?;
    if !orient_to_path {
        return Ok(AffineTransformV1 {
            tx: sample.point.x,
            ty: sample.point.y,
            ..transform.clone()
        });
    }
    let tangent = sample
        .tangent
        .ok_or(GeometryError::UndefinedMotionTangent)?;
    let angle = tangent.y.atan2(tangent.x);
    let cosine = angle.cos();
    let sine = angle.sin();
    Ok(AffineTransformV1 {
        m11: cosine * transform.m11 - sine * transform.m21,
        m12: cosine * transform.m12 - sine * transform.m22,
        m21: sine * transform.m11 + cosine * transform.m21,
        m22: sine * transform.m12 + cosine * transform.m22,
        tx: sample.point.x,
        ty: sample.point.y,
    })
}

/// Applies the non-orienting pose used by Manim's `MoveAlongPath`.
///
/// # Errors
///
/// Returns a geometry error for invalid path data.
pub fn apply_manim_motion_path_v1(
    transform: &AffineTransformV1,
    path: &CubicPathV1,
    progress: f64,
) -> Result<AffineTransformV1, GeometryError> {
    let point = sample_cubic_path_manim_point_from_proportion_v1(path, progress)?;
    Ok(AffineTransformV1 {
        tx: point.x,
        ty: point.y,
        ..transform.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use poietra_scene_ir::{CubicSegmentV1, CubicSubpathV1, PointV1};

    fn affine(values: [f64; 6]) -> AffineTransformV1 {
        AffineTransformV1 {
            m11: values[0],
            m12: values[1],
            m21: values[2],
            m22: values[3],
            tx: values[4],
            ty: values[5],
        }
    }

    #[test]
    fn composition_includes_parent_linear_transform_for_translation() {
        let outer = affine([0.0, -2.0, 3.0, 0.0, 10.0, 20.0]);
        let inner = affine([1.0, 0.0, 0.0, 1.0, 4.0, 5.0]);
        assert_eq!(
            compose_affine_transforms_v1(&outer, &inner),
            affine([0.0, -2.0, 3.0, 0.0, 0.0, 32.0])
        );
    }

    #[test]
    fn motion_orientation_pre_rotates_non_diagonal_linear_part() {
        let path = CubicPathV1 {
            subpaths: vec![CubicSubpathV1 {
                start: PointV1 { x: 0.0, y: 0.0 },
                segments: vec![CubicSegmentV1 {
                    control1: PointV1 { x: 0.0, y: 1.0 },
                    control2: PointV1 { x: 0.0, y: 2.0 },
                    end: PointV1 { x: 0.0, y: 3.0 },
                }],
                closed: false,
            }],
        };
        let transformed = apply_motion_path_v1(
            &affine([2.0, 1.0, 0.5, 3.0, 100.0, 100.0]),
            &path,
            0.5,
            true,
        )
        .unwrap();
        assert!((transformed.m11 + 0.5).abs() < 1.0e-12);
        assert!((transformed.m12 + 3.0).abs() < 1.0e-12);
        assert!((transformed.m21 - 2.0).abs() < 1.0e-12);
        assert!((transformed.m22 - 1.0).abs() < 1.0e-12);
        assert!((transformed.tx - 0.0).abs() < 1.0e-12);
        assert!((transformed.ty - 1.5).abs() < 1.0e-12);
    }
}
