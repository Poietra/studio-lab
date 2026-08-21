use poietra_scene_ir::{CubicPathV1, CubicSegmentV1, CubicSubpathV1, MAX_COORDINATE_V1, PointV1};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::StudioAuthoringDimensions;

const MIN_STROKE_WIDTH_WORLD: f64 = 0.005;
const MAX_STROKE_WIDTH_WORLD: f64 = 0.5;
const MIN_CURVE_SPAN: f64 = 1.0e-6;
const CANONICAL_EPSILON: f64 = 1.0e-9;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioCubicBezierStrokeCap {
    Butt,
    Round,
    Square,
}

/// One deliberately bounded cubic authoring primitive. The four points are
/// local Scene coordinates and must be centered by the Rust normalizer before
/// they enter a canonical creation Program.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationCubicBezierSpec {
    pub arrow_end: bool,
    pub control1: PointV1,
    pub control2: PointV1,
    pub end: PointV1,
    pub start: PointV1,
    pub stroke_cap: StudioCubicBezierStrokeCap,
    pub stroke_width: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct NormalizedStudioCubicBezier {
    pub(super) dimensions: StudioAuthoringDimensions,
    pub(super) path: CubicPathV1,
    pub(super) spec: StudioCreationCubicBezierSpec,
}

/// Result returned to the browser after Rust has centered and bounded the
/// authoring points. `center_offset` is the Scene-space displacement that the
/// interaction adapter adds to the object's placement.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioCubicBezierInspection {
    pub center_offset: PointV1,
    pub cubic_bezier: StudioCreationCubicBezierSpec,
    pub dimensions: StudioAuthoringDimensions,
}

#[derive(Clone, Debug, Error, PartialEq)]
pub enum StudioCubicBezierError {
    #[error("cubic Bézier points must be finite and remain inside the Scene coordinate bound")]
    InvalidPoint,
    #[error("cubic Bézier geometry must span at least one Scene axis")]
    Degenerate,
    #[error("cubic Bézier stroke width must be between 0.005 and 0.5 Scene units")]
    InvalidStrokeWidth,
}

#[derive(Clone, Copy)]
struct Bounds {
    bottom: f64,
    left: f64,
    right: f64,
    top: f64,
}

impl Bounds {
    fn from_point(point: &PointV1) -> Self {
        Self {
            bottom: point.y,
            left: point.x,
            right: point.x,
            top: point.y,
        }
    }

    fn include(&mut self, point: &PointV1) {
        self.bottom = self.bottom.min(point.y);
        self.left = self.left.min(point.x);
        self.right = self.right.max(point.x);
        self.top = self.top.max(point.y);
    }
}

fn valid_point(point: &PointV1) -> bool {
    point.x.is_finite()
        && point.y.is_finite()
        && point.x.abs() <= MAX_COORDINATE_V1
        && point.y.abs() <= MAX_COORDINATE_V1
}

fn straight_segment(start: &PointV1, end: PointV1) -> CubicSegmentV1 {
    CubicSegmentV1 {
        control1: PointV1 {
            x: (2.0 * start.x + end.x) / 3.0,
            y: (2.0 * start.y + end.y) / 3.0,
        },
        control2: PointV1 {
            x: (start.x + 2.0 * end.x) / 3.0,
            y: (start.y + 2.0 * end.y) / 3.0,
        },
        end,
    }
}

fn arrow_subpath(spec: &StudioCreationCubicBezierSpec, span: f64) -> Option<CubicSubpathV1> {
    if !spec.arrow_end {
        return None;
    }
    let mut tangent = PointV1 {
        x: spec.end.x - spec.control2.x,
        y: spec.end.y - spec.control2.y,
    };
    let mut length = tangent.x.hypot(tangent.y);
    if length <= MIN_CURVE_SPAN {
        tangent = PointV1 {
            x: spec.end.x - spec.control1.x,
            y: spec.end.y - spec.control1.y,
        };
        length = tangent.x.hypot(tangent.y);
    }
    if length <= MIN_CURVE_SPAN {
        tangent = PointV1 {
            x: spec.end.x - spec.start.x,
            y: spec.end.y - spec.start.y,
        };
        length = tangent.x.hypot(tangent.y);
    }
    if length <= MIN_CURVE_SPAN {
        return None;
    }
    let unit = PointV1 {
        x: tangent.x / length,
        y: tangent.y / length,
    };
    let arrow_length = (span * 0.12).clamp(0.08, 0.35);
    let arrow_half_width = arrow_length * 0.48;
    let base = PointV1 {
        x: spec.end.x - unit.x * arrow_length,
        y: spec.end.y - unit.y * arrow_length,
    };
    let perpendicular = PointV1 {
        x: -unit.y,
        y: unit.x,
    };
    let left = PointV1 {
        x: base.x + perpendicular.x * arrow_half_width,
        y: base.y + perpendicular.y * arrow_half_width,
    };
    let right = PointV1 {
        x: base.x - perpendicular.x * arrow_half_width,
        y: base.y - perpendicular.y * arrow_half_width,
    };
    Some(CubicSubpathV1 {
        closed: false,
        segments: vec![
            straight_segment(&left, spec.end.clone()),
            straight_segment(&spec.end, right),
        ],
        start: left,
    })
}

fn path_for_spec(
    spec: &StudioCreationCubicBezierSpec,
) -> Result<CubicPathV1, StudioCubicBezierError> {
    let points = [&spec.start, &spec.control1, &spec.control2, &spec.end];
    if points.iter().any(|point| !valid_point(point)) {
        return Err(StudioCubicBezierError::InvalidPoint);
    }
    if !spec.stroke_width.is_finite()
        || !(MIN_STROKE_WIDTH_WORLD..=MAX_STROKE_WIDTH_WORLD).contains(&spec.stroke_width)
    {
        return Err(StudioCubicBezierError::InvalidStrokeWidth);
    }
    let mut bounds = Bounds::from_point(&spec.start);
    for point in points.iter().skip(1) {
        bounds.include(point);
    }
    let span = (bounds.right - bounds.left).max(bounds.top - bounds.bottom);
    if !span.is_finite() || span <= MIN_CURVE_SPAN {
        return Err(StudioCubicBezierError::Degenerate);
    }
    let mut subpaths = vec![CubicSubpathV1 {
        closed: false,
        segments: vec![CubicSegmentV1 {
            control1: spec.control1.clone(),
            control2: spec.control2.clone(),
            end: spec.end.clone(),
        }],
        start: spec.start.clone(),
    }];
    if let Some(arrow) = arrow_subpath(spec, span) {
        subpaths.push(arrow);
    }
    Ok(CubicPathV1 { subpaths })
}

fn path_bounds(path: &CubicPathV1) -> Option<Bounds> {
    let mut bounds = Bounds::from_point(&path.subpaths.first()?.start);
    for subpath in &path.subpaths {
        bounds.include(&subpath.start);
        for segment in &subpath.segments {
            bounds.include(&segment.control1);
            bounds.include(&segment.control2);
            bounds.include(&segment.end);
        }
    }
    Some(bounds)
}

fn translate_point(point: &mut PointV1, offset: &PointV1) {
    point.x -= offset.x;
    point.y -= offset.y;
}

fn translate_path(path: &mut CubicPathV1, offset: &PointV1) {
    for subpath in &mut path.subpaths {
        translate_point(&mut subpath.start, offset);
        for segment in &mut subpath.segments {
            translate_point(&mut segment.control1, offset);
            translate_point(&mut segment.control2, offset);
            translate_point(&mut segment.end, offset);
        }
    }
}

fn dimensions_from_bounds(bounds: Bounds) -> StudioAuthoringDimensions {
    let width = bounds.right - bounds.left;
    let height = bounds.top - bounds.bottom;
    StudioAuthoringDimensions {
        angles: None,
        coordinate_system: None,
        height: (height > MIN_CURVE_SPAN).then_some(height),
        radius: None,
        sides: None,
        width: (width > MIN_CURVE_SPAN).then_some(width),
    }
}

/// Centers arbitrary local authoring points and returns the one canonical path.
///
/// # Errors
///
/// Returns a bounded error for invalid points, a degenerate curve, or an invalid stroke.
pub fn inspect_studio_cubic_bezier(
    spec: &StudioCreationCubicBezierSpec,
) -> Result<StudioCubicBezierInspection, StudioCubicBezierError> {
    let mut path = path_for_spec(spec)?;
    let bounds = path_bounds(&path).ok_or(StudioCubicBezierError::Degenerate)?;
    let center_offset = PointV1 {
        x: f64::midpoint(bounds.left, bounds.right),
        y: f64::midpoint(bounds.bottom, bounds.top),
    };
    translate_path(&mut path, &center_offset);
    let mut cubic_bezier = spec.clone();
    for point in [
        &mut cubic_bezier.start,
        &mut cubic_bezier.control1,
        &mut cubic_bezier.control2,
        &mut cubic_bezier.end,
    ] {
        translate_point(point, &center_offset);
    }
    Ok(StudioCubicBezierInspection {
        center_offset,
        cubic_bezier,
        dimensions: dimensions_from_bounds(bounds),
    })
}

pub(super) fn normalize_studio_cubic_bezier(
    spec: &StudioCreationCubicBezierSpec,
) -> Result<NormalizedStudioCubicBezier, StudioCubicBezierError> {
    let inspection = inspect_studio_cubic_bezier(spec)?;
    let path = path_for_spec(&inspection.cubic_bezier)?;
    Ok(NormalizedStudioCubicBezier {
        dimensions: inspection.dimensions,
        path,
        spec: inspection.cubic_bezier,
    })
}

pub(super) fn studio_cubic_bezier_is_canonical(
    source: &StudioCreationCubicBezierSpec,
    normalized: &NormalizedStudioCubicBezier,
) -> bool {
    source.arrow_end == normalized.spec.arrow_end
        && source.stroke_cap == normalized.spec.stroke_cap
        && (source.stroke_width - normalized.spec.stroke_width).abs() <= CANONICAL_EPSILON
        && [
            (&source.start, &normalized.spec.start),
            (&source.control1, &normalized.spec.control1),
            (&source.control2, &normalized.spec.control2),
            (&source.end, &normalized.spec.end),
        ]
        .iter()
        .all(|(left, right)| {
            (left.x - right.x).abs() <= CANONICAL_EPSILON
                && (left.y - right.y).abs() <= CANONICAL_EPSILON
        })
}

pub(super) fn studio_cubic_bezier_dimensions_are_canonical(
    source: StudioAuthoringDimensions,
    normalized: StudioAuthoringDimensions,
) -> bool {
    let optional_value_matches = |left: Option<f64>, right: Option<f64>| match (left, right) {
        (Some(left), Some(right)) => (left - right).abs() <= CANONICAL_EPSILON,
        (None, None) => true,
        (Some(_), None) | (None, Some(_)) => false,
    };
    source.angles.is_none()
        && source.coordinate_system.is_none()
        && source.radius.is_none()
        && source.sides.is_none()
        && optional_value_matches(source.height, normalized.height)
        && optional_value_matches(source.width, normalized.width)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve(arrow_end: bool) -> StudioCreationCubicBezierSpec {
        StudioCreationCubicBezierSpec {
            arrow_end,
            control1: PointV1 { x: -1.0, y: 1.0 },
            control2: PointV1 { x: 1.0, y: -1.0 },
            end: PointV1 { x: 2.0, y: 0.5 },
            start: PointV1 { x: -2.0, y: -0.5 },
            stroke_cap: StudioCubicBezierStrokeCap::Round,
            stroke_width: 0.04,
        }
    }

    #[test]
    fn centers_one_cubic_segment_without_sampling_it() {
        let inspection = inspect_studio_cubic_bezier(&curve(false)).unwrap();
        let normalized = normalize_studio_cubic_bezier(&inspection.cubic_bezier).unwrap();
        assert_eq!(normalized.path.subpaths.len(), 1);
        assert_eq!(normalized.path.subpaths[0].segments.len(), 1);
        assert!(studio_cubic_bezier_is_canonical(
            &inspection.cubic_bezier,
            &normalized
        ));
        assert_eq!(inspection.dimensions.width, Some(4.0));
        assert_eq!(inspection.dimensions.height, Some(2.0));
    }

    #[test]
    fn arrow_adds_only_one_stroked_tip_subpath() {
        let inspection = inspect_studio_cubic_bezier(&curve(true)).unwrap();
        let normalized = normalize_studio_cubic_bezier(&inspection.cubic_bezier).unwrap();
        assert_eq!(normalized.path.subpaths.len(), 2);
        assert_eq!(normalized.path.subpaths[0].segments.len(), 1);
        assert_eq!(normalized.path.subpaths[1].segments.len(), 2);
        assert!(!normalized.path.subpaths[1].closed);
    }

    #[test]
    fn rejects_degenerate_nonfinite_and_unbounded_input() {
        let mut candidate = curve(false);
        candidate.control1 = candidate.start.clone();
        candidate.control2 = candidate.start.clone();
        candidate.end = candidate.start.clone();
        assert_eq!(
            inspect_studio_cubic_bezier(&candidate),
            Err(StudioCubicBezierError::Degenerate)
        );

        candidate = curve(false);
        candidate.end.x = f64::NAN;
        assert_eq!(
            inspect_studio_cubic_bezier(&candidate),
            Err(StudioCubicBezierError::InvalidPoint)
        );

        candidate = curve(false);
        candidate.end.x = MAX_COORDINATE_V1 + 1.0;
        assert_eq!(
            inspect_studio_cubic_bezier(&candidate),
            Err(StudioCubicBezierError::InvalidPoint)
        );
    }

    #[test]
    fn rejects_stroke_width_outside_the_closed_profile() {
        let mut candidate = curve(false);
        candidate.stroke_width = 0.0;
        assert_eq!(
            inspect_studio_cubic_bezier(&candidate),
            Err(StudioCubicBezierError::InvalidStrokeWidth)
        );
        candidate.stroke_width = MAX_STROKE_WIDTH_WORLD + f64::EPSILON;
        assert_eq!(
            inspect_studio_cubic_bezier(&candidate),
            Err(StudioCubicBezierError::InvalidStrokeWidth)
        );
    }

    #[test]
    fn accepts_json_round_trip_dimensions_from_the_browser_inspector() {
        let source = StudioCreationCubicBezierSpec {
            arrow_end: false,
            control1: PointV1 {
                x: -1.176_779_616_495_929,
                y: 1.681_113_737_851_326_6,
            },
            control2: PointV1 {
                x: 1.176_779_616_495_927_9,
                y: -1.681_113_737_851_326_6,
            },
            end: PointV1 {
                x: 1.849_225_111_636_459_3,
                y: 0.672_445_495_140_530_9,
            },
            start: PointV1 {
                x: -1.849_225_111_636_459_5,
                y: -0.672_445_495_140_530_4,
            },
            stroke_cap: StudioCubicBezierStrokeCap::Round,
            stroke_width: 0.04,
        };
        let normalized = normalize_studio_cubic_bezier(&source).unwrap();
        assert!(studio_cubic_bezier_is_canonical(&source, &normalized));
        assert!(studio_cubic_bezier_dimensions_are_canonical(
            StudioAuthoringDimensions {
                height: Some(3.362_227_475_702_653),
                width: Some(3.698_450_223_272_919),
                ..StudioAuthoringDimensions::default()
            },
            normalized.dimensions,
        ));
    }
}
