//! Deterministic geometry and easing operations for Poietra Engine v1.
//!
//! The algorithms in this crate intentionally mirror ADR 0002. In particular,
//! cubic arc length always uses 64 equal-parameter chord intervals. The explicit
//! Manim-compatible motion mode instead uses 10 points (9 chords) per serialized
//! cubic before applying a uniform local parameter. Neither is adaptive.

mod easing;
mod path;
mod transform;

pub use easing::apply_easing_v1;
pub use path::{
    MANIM_CURVE_LENGTH_SAMPLE_POINTS_V1, PATH_ARC_SUBDIVISIONS_V1, PathSampleV1,
    interpolate_cubic_path_v1, manim_cubic_chord_length_v1, point_on_cubic_v1,
    sample_cubic_path_manim_point_from_proportion_v1, sample_cubic_path_v1,
    scene_geometry_as_cubic_path_v1, trim_cubic_path_uniform_parameter_v1, trim_cubic_path_v1,
};
pub use transform::{
    apply_manim_motion_path_v1, apply_motion_path_v1, compose_affine_transforms_v1,
    interpolate_affine_transform_v1, rotate_affine_transform_v1,
};

/// A deterministic v1 geometry operation could not be evaluated truthfully.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum GeometryError {
    /// A path operation requires at least one subpath and segment.
    #[error("a cubic path requires at least one non-empty subpath")]
    EmptyPath,
    /// Both paths must have identical subpath/segment topology for morphing.
    #[error("path morph inputs must have matching v1 cubic topology")]
    PathTopologyMismatch,
    /// `orientToPath` cannot invent an orientation for a stationary path.
    #[error("orientToPath requires a motion path with a non-zero tangent")]
    UndefinedMotionTangent,
    /// Image geometry does not lower to a cubic path.
    #[error("image geometry cannot be lowered to a cubic path")]
    ImageGeometry,
    /// Logical groups carry hierarchy state but have no drawable path.
    #[error("logical group geometry cannot be lowered to a cubic path")]
    LogicalGroupGeometry,
}
