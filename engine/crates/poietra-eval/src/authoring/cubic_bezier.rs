use poietra_scene_ir::{CubicPathV1, CubicSegmentV1, CubicSubpathV1, MAX_COORDINATE_V1, PointV1};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::StudioAuthoringDimensions;

const MIN_STROKE_WIDTH_WORLD: f64 = 0.005;
const MAX_STROKE_WIDTH_WORLD: f64 = 0.5;
const MIN_CURVE_SPAN: f64 = 1.0e-6;
const CANONICAL_EPSILON: f64 = 1.0e-9;
const MAX_STUDIO_CUBIC_BEZIER_SEGMENTS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StudioCubicBezierStrokeCap {
    Butt,
    Round,
    Square,
}

/// One deliberately bounded cubic authoring path. The first four points retain
/// the original single-segment contract; continuations share the preceding
/// segment's endpoint as their implicit start.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioCreationCubicBezierSpec {
    pub arrow_end: bool,
    pub control1: PointV1,
    pub control2: PointV1,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub continuation_segments: Vec<CubicSegmentV1>,
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
    #[error("each cubic Bézier segment must span at least one Scene axis")]
    Degenerate,
    #[error("cubic Bézier paths accept at most 8 segments")]
    TooManySegments,
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

fn arrow_subpath(
    arrow_end: bool,
    segment_start: &PointV1,
    segment: &CubicSegmentV1,
    span: f64,
) -> Option<CubicSubpathV1> {
    if !arrow_end {
        return None;
    }
    let mut tangent = PointV1 {
        x: segment.end.x - segment.control2.x,
        y: segment.end.y - segment.control2.y,
    };
    let mut length = tangent.x.hypot(tangent.y);
    if length <= MIN_CURVE_SPAN {
        tangent = PointV1 {
            x: segment.end.x - segment.control1.x,
            y: segment.end.y - segment.control1.y,
        };
        length = tangent.x.hypot(tangent.y);
    }
    if length <= MIN_CURVE_SPAN {
        tangent = PointV1 {
            x: segment.end.x - segment_start.x,
            y: segment.end.y - segment_start.y,
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
        x: segment.end.x - unit.x * arrow_length,
        y: segment.end.y - unit.y * arrow_length,
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
            straight_segment(&left, segment.end.clone()),
            straight_segment(&segment.end, right),
        ],
        start: left,
    })
}

fn path_for_spec(
    spec: &StudioCreationCubicBezierSpec,
) -> Result<CubicPathV1, StudioCubicBezierError> {
    if spec.continuation_segments.len() + 1 > MAX_STUDIO_CUBIC_BEZIER_SEGMENTS {
        return Err(StudioCubicBezierError::TooManySegments);
    }
    if !spec.stroke_width.is_finite()
        || !(MIN_STROKE_WIDTH_WORLD..=MAX_STROKE_WIDTH_WORLD).contains(&spec.stroke_width)
    {
        return Err(StudioCubicBezierError::InvalidStrokeWidth);
    }
    let mut segments = Vec::with_capacity(spec.continuation_segments.len() + 1);
    segments.push(CubicSegmentV1 {
        control1: spec.control1.clone(),
        control2: spec.control2.clone(),
        end: spec.end.clone(),
    });
    segments.extend(spec.continuation_segments.iter().cloned());

    let mut bounds = Bounds::from_point(&spec.start);
    let mut segment_start = &spec.start;
    for segment in &segments {
        let points = [
            segment_start,
            &segment.control1,
            &segment.control2,
            &segment.end,
        ];
        if points.iter().any(|point| !valid_point(point)) {
            return Err(StudioCubicBezierError::InvalidPoint);
        }
        let mut segment_bounds = Bounds::from_point(segment_start);
        for point in points.iter().skip(1) {
            segment_bounds.include(point);
            bounds.include(point);
        }
        let segment_span = (segment_bounds.right - segment_bounds.left)
            .max(segment_bounds.top - segment_bounds.bottom);
        if !segment_span.is_finite() || segment_span <= MIN_CURVE_SPAN {
            return Err(StudioCubicBezierError::Degenerate);
        }
        segment_start = &segment.end;
    }

    let span = (bounds.right - bounds.left).max(bounds.top - bounds.bottom);
    let final_segment_start = if segments.len() == 1 {
        &spec.start
    } else {
        &segments[segments.len() - 2].end
    };
    let arrow = arrow_subpath(
        spec.arrow_end,
        final_segment_start,
        segments
            .last()
            .expect("a cubic path always has one segment"),
        span,
    );
    let mut subpaths = vec![CubicSubpathV1 {
        closed: false,
        segments,
        start: spec.start.clone(),
    }];
    if let Some(arrow) = arrow {
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

fn points_are_canonical(left: &PointV1, right: &PointV1) -> bool {
    (left.x - right.x).abs() <= CANONICAL_EPSILON && (left.y - right.y).abs() <= CANONICAL_EPSILON
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
    for segment in &mut cubic_bezier.continuation_segments {
        translate_point(&mut segment.control1, &center_offset);
        translate_point(&mut segment.control2, &center_offset);
        translate_point(&mut segment.end, &center_offset);
    }
    Ok(StudioCubicBezierInspection {
        center_offset,
        cubic_bezier,
        dimensions: dimensions_from_bounds(bounds),
    })
}

/// Appends one straight cubic segment to the requested endpoint, then returns
/// the same centered inspection used by initial curve authoring.
///
/// # Errors
///
/// Returns a bounded error when the source path or requested extension is invalid.
pub fn extend_studio_cubic_bezier(
    spec: &StudioCreationCubicBezierSpec,
    endpoint: &PointV1,
) -> Result<StudioCubicBezierInspection, StudioCubicBezierError> {
    let mut extended = spec.clone();
    let segment_start = extended
        .continuation_segments
        .last()
        .map_or_else(|| extended.end.clone(), |segment| segment.end.clone());
    extended
        .continuation_segments
        .push(straight_segment(&segment_start, endpoint.clone()));
    inspect_studio_cubic_bezier(&extended)
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
        .all(|(left, right)| points_are_canonical(left, right))
        && source.continuation_segments.len() == normalized.spec.continuation_segments.len()
        && source
            .continuation_segments
            .iter()
            .zip(&normalized.spec.continuation_segments)
            .all(|(left, right)| {
                [
                    (&left.control1, &right.control1),
                    (&left.control2, &right.control2),
                    (&left.end, &right.end),
                ]
                .iter()
                .all(|(left, right)| points_are_canonical(left, right))
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
            continuation_segments: Vec::new(),
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
    fn legacy_json_defaults_and_omits_empty_continuations() {
        let legacy = serde_json::json!({
            "arrowEnd": false,
            "control1": { "x": -1.0, "y": 1.0 },
            "control2": { "x": 1.0, "y": -1.0 },
            "end": { "x": 2.0, "y": 0.5 },
            "start": { "x": -2.0, "y": -0.5 },
            "strokeCap": "round",
            "strokeWidth": 0.04
        });
        let parsed: StudioCreationCubicBezierSpec = serde_json::from_value(legacy.clone()).unwrap();
        assert!(parsed.continuation_segments.is_empty());
        assert_eq!(serde_json::to_value(parsed).unwrap(), legacy);
    }

    #[test]
    fn normalizes_ordered_continuation_segments_as_one_open_subpath() {
        let mut candidate = curve(false);
        candidate.continuation_segments = vec![
            CubicSegmentV1 {
                control1: PointV1 { x: 2.5, y: 1.0 },
                control2: PointV1 { x: 3.5, y: 1.0 },
                end: PointV1 { x: 4.0, y: 0.0 },
            },
            CubicSegmentV1 {
                control1: PointV1 { x: 4.5, y: -1.0 },
                control2: PointV1 { x: 5.5, y: -1.0 },
                end: PointV1 { x: 6.0, y: 0.0 },
            },
        ];

        let inspection = inspect_studio_cubic_bezier(&candidate).unwrap();
        let normalized = normalize_studio_cubic_bezier(&inspection.cubic_bezier).unwrap();
        let subpath = &normalized.path.subpaths[0];
        assert_eq!(normalized.path.subpaths.len(), 1);
        assert!(!subpath.closed);
        assert_eq!(subpath.segments.len(), 3);
        assert_eq!(
            subpath.segments[1],
            inspection.cubic_bezier.continuation_segments[0]
        );
        assert_eq!(
            subpath.segments[2],
            inspection.cubic_bezier.continuation_segments[1]
        );
        assert_eq!(inspection.center_offset, PointV1 { x: 2.0, y: 0.0 });
        assert_eq!(inspection.dimensions.width, Some(8.0));
        assert_eq!(inspection.dimensions.height, Some(2.0));
        assert!(studio_cubic_bezier_is_canonical(
            &inspection.cubic_bezier,
            &normalized
        ));

        let mut changed = inspection.cubic_bezier.clone();
        changed.continuation_segments[1].end.x += 0.01;
        assert!(!studio_cubic_bezier_is_canonical(&changed, &normalized));
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
    fn arrow_uses_the_final_segment_tangent() {
        let mut candidate = curve(true);
        candidate.continuation_segments.push(CubicSegmentV1 {
            control1: PointV1 { x: 2.0, y: 1.0 },
            control2: PointV1 { x: 2.0, y: 2.0 },
            end: PointV1 { x: 2.0, y: 3.0 },
        });
        let inspection = inspect_studio_cubic_bezier(&candidate).unwrap();
        let normalized = normalize_studio_cubic_bezier(&inspection.cubic_bezier).unwrap();
        let arrow = &normalized.path.subpaths[1];
        let left = &arrow.start;
        let tip = &arrow.segments[0].end;
        let right = &arrow.segments[1].end;

        assert!((left.y - right.y).abs() <= CANONICAL_EPSILON);
        assert!(left.y < tip.y);
        assert!(left.x < tip.x && tip.x < right.x);
    }

    #[test]
    fn extends_with_straight_controls_owned_by_the_core() {
        let endpoint = PointV1 { x: 5.0, y: 2.0 };
        let inspection = extend_studio_cubic_bezier(&curve(false), &endpoint).unwrap();
        let spec = &inspection.cubic_bezier;
        let segment = &spec.continuation_segments[0];
        let expected_endpoint = PointV1 {
            x: endpoint.x - inspection.center_offset.x,
            y: endpoint.y - inspection.center_offset.y,
        };
        assert_eq!(segment.end, expected_endpoint);
        assert!(points_are_canonical(
            &segment.control1,
            &PointV1 {
                x: (2.0 * spec.end.x + segment.end.x) / 3.0,
                y: (2.0 * spec.end.y + segment.end.y) / 3.0,
            }
        ));
        assert!(points_are_canonical(
            &segment.control2,
            &PointV1 {
                x: (spec.end.x + 2.0 * segment.end.x) / 3.0,
                y: (spec.end.y + 2.0 * segment.end.y) / 3.0,
            }
        ));
    }

    #[test]
    fn enforces_segment_limit_and_rejects_degenerate_continuations() {
        let mut maximum = curve(false);
        let mut start = maximum.end.clone();
        for index in 0..7 {
            let end = PointV1 {
                x: 3.0 + f64::from(index),
                y: f64::from(index % 2),
            };
            maximum
                .continuation_segments
                .push(straight_segment(&start, end.clone()));
            start = end;
        }
        assert!(inspect_studio_cubic_bezier(&maximum).is_ok());

        let too_many = extend_studio_cubic_bezier(
            &maximum,
            &PointV1 {
                x: start.x + 1.0,
                y: start.y,
            },
        );
        assert_eq!(too_many, Err(StudioCubicBezierError::TooManySegments));

        let mut degenerate = curve(false);
        degenerate.continuation_segments.push(CubicSegmentV1 {
            control1: degenerate.end.clone(),
            control2: degenerate.end.clone(),
            end: degenerate.end.clone(),
        });
        assert_eq!(
            inspect_studio_cubic_bezier(&degenerate),
            Err(StudioCubicBezierError::Degenerate)
        );
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
        candidate.continuation_segments.push(CubicSegmentV1 {
            control1: PointV1 { x: 2.5, y: 0.5 },
            control2: PointV1 {
                x: f64::NAN,
                y: 0.5,
            },
            end: PointV1 { x: 3.0, y: 0.5 },
        });
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
            continuation_segments: Vec::new(),
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
