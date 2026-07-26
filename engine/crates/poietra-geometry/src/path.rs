#![allow(clippy::float_cmp)] // Exact zero is part of the validated v1 wire semantics.

use std::borrow::Cow;

use poietra_scene_ir::{CubicPathV1, CubicSegmentV1, CubicSubpathV1, PointV1, SceneGeometryV1};

use crate::GeometryError;

/// Number of equal-parameter chord intervals used for every v1 cubic.
pub const PATH_ARC_SUBDIVISIONS_V1: usize = 64;
const TANGENT_EPSILON_V1: f64 = 1.0e-12;

/// A position and, when one exists, the deterministic non-zero path tangent.
#[derive(Clone, Debug, PartialEq)]
pub struct PathSampleV1 {
    pub point: PointV1,
    pub tangent: Option<PointV1>,
}

fn add(left: &PointV1, right: &PointV1) -> PointV1 {
    PointV1 {
        x: left.x + right.x,
        y: left.y + right.y,
    }
}

fn subtract(left: &PointV1, right: &PointV1) -> PointV1 {
    PointV1 {
        x: left.x - right.x,
        y: left.y - right.y,
    }
}

fn scale(point: &PointV1, factor: f64) -> PointV1 {
    PointV1 {
        x: point.x * factor,
        y: point.y * factor,
    }
}

fn interpolate_point(left: &PointV1, right: &PointV1, progress: f64) -> PointV1 {
    add(left, &scale(&subtract(right, left), progress))
}

fn distance(left: &PointV1, right: &PointV1) -> f64 {
    (right.x - left.x).hypot(right.y - left.y)
}

fn line_segment(start: &PointV1, end: &PointV1) -> CubicSegmentV1 {
    let delta = subtract(end, start);
    CubicSegmentV1 {
        control1: add(start, &scale(&delta, 1.0 / 3.0)),
        control2: add(start, &scale(&delta, 2.0 / 3.0)),
        end: end.clone(),
    }
}

/// Samples one absolute cubic segment using f64 de Casteljau-equivalent math.
pub fn point_on_cubic_v1(start: &PointV1, segment: &CubicSegmentV1, parameter: f64) -> PointV1 {
    let inverse = 1.0 - parameter;
    PointV1 {
        x: inverse.powi(3) * start.x
            + 3.0 * inverse * inverse * parameter * segment.control1.x
            + 3.0 * inverse * parameter * parameter * segment.control2.x
            + parameter.powi(3) * segment.end.x,
        y: inverse.powi(3) * start.y
            + 3.0 * inverse * inverse * parameter * segment.control1.y
            + 3.0 * inverse * parameter * parameter * segment.control2.y
            + parameter.powi(3) * segment.end.y,
    }
}

fn tangent_on_cubic(start: &PointV1, segment: &CubicSegmentV1, parameter: f64) -> PointV1 {
    let inverse = 1.0 - parameter;
    PointV1 {
        x: 3.0 * inverse * inverse * (segment.control1.x - start.x)
            + 6.0 * inverse * parameter * (segment.control2.x - segment.control1.x)
            + 3.0 * parameter * parameter * (segment.end.x - segment.control2.x),
        y: 3.0 * inverse * inverse * (segment.control1.y - start.y)
            + 6.0 * inverse * parameter * (segment.control2.y - segment.control1.y)
            + 3.0 * parameter * parameter * (segment.end.y - segment.control2.y),
    }
}

fn split_cubic_prefix(start: &PointV1, segment: &CubicSegmentV1, parameter: f64) -> CubicSegmentV1 {
    let first = interpolate_point(start, &segment.control1, parameter);
    let second = interpolate_point(&segment.control1, &segment.control2, parameter);
    let third = interpolate_point(&segment.control2, &segment.end, parameter);
    let fourth = interpolate_point(&first, &second, parameter);
    let fifth = interpolate_point(&second, &third, parameter);
    CubicSegmentV1 {
        control1: first,
        control2: fourth.clone(),
        end: interpolate_point(&fourth, &fifth, parameter),
    }
}

#[derive(Clone, Debug)]
struct CubicMeasurement {
    length: f64,
    samples: [f64; PATH_ARC_SUBDIVISIONS_V1 + 1],
}

fn measure_cubic(start: &PointV1, segment: &CubicSegmentV1) -> CubicMeasurement {
    let mut samples = [0.0; PATH_ARC_SUBDIVISIONS_V1 + 1];
    let mut length = 0.0;
    let mut previous = start.clone();
    for (index, slot) in samples.iter_mut().enumerate().skip(1) {
        #[allow(clippy::cast_precision_loss)]
        let parameter = index as f64 / PATH_ARC_SUBDIVISIONS_V1 as f64;
        let point = point_on_cubic_v1(start, segment, parameter);
        length += distance(&previous, &point);
        *slot = length;
        previous = point;
    }
    CubicMeasurement { length, samples }
}

fn measure_cubic_length(start: &PointV1, segment: &CubicSegmentV1) -> f64 {
    let mut length = 0.0;
    let mut previous = start.clone();
    for index in 1..=PATH_ARC_SUBDIVISIONS_V1 {
        #[allow(clippy::cast_precision_loss)]
        let parameter = index as f64 / PATH_ARC_SUBDIVISIONS_V1 as f64;
        let point = point_on_cubic_v1(start, segment, parameter);
        length += distance(&previous, &point);
        previous = point;
    }
    length
}

fn parameter_at_length(measurement: &CubicMeasurement, target: f64) -> f64 {
    if measurement.length == 0.0 || target <= 0.0 {
        return 0.0;
    }
    if target >= measurement.length {
        return 1.0;
    }
    let upper_index = measurement
        .samples
        .partition_point(|length| *length < target)
        .max(1);
    let lower_length = measurement.samples[upper_index - 1];
    let upper_length = measurement.samples[upper_index];
    let local = if upper_length == lower_length {
        0.0
    } else {
        (target - lower_length) / (upper_length - lower_length)
    };
    #[allow(clippy::cast_precision_loss)]
    let parameter = (upper_index as f64 - 1.0 + local) / PATH_ARC_SUBDIVISIONS_V1 as f64;
    parameter
}

#[derive(Debug)]
struct SegmentEntry<'a> {
    closing: bool,
    length: f64,
    segment: Cow<'a, CubicSegmentV1>,
    start: &'a PointV1,
}

fn segment_entries_by_subpath(
    path: &CubicPathV1,
) -> Result<Vec<Vec<SegmentEntry<'_>>>, GeometryError> {
    if path.subpaths.is_empty()
        || path
            .subpaths
            .iter()
            .any(|subpath| subpath.segments.is_empty())
    {
        return Err(GeometryError::EmptyPath);
    }
    Ok(path
        .subpaths
        .iter()
        .map(|subpath| {
            let mut entries =
                Vec::with_capacity(subpath.segments.len() + usize::from(subpath.closed));
            let mut start = &subpath.start;
            for segment in &subpath.segments {
                entries.push(SegmentEntry {
                    closing: false,
                    length: measure_cubic_length(start, segment),
                    segment: Cow::Borrowed(segment),
                    start,
                });
                start = &segment.end;
            }
            if subpath.closed && distance(start, &subpath.start) > 0.0 {
                let segment = line_segment(start, &subpath.start);
                entries.push(SegmentEntry {
                    closing: true,
                    length: measure_cubic_length(start, &segment),
                    segment: Cow::Owned(segment),
                    start,
                });
            }
            entries
        })
        .collect())
}

fn degenerate_path(point: &PointV1) -> CubicPathV1 {
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: false,
            segments: vec![CubicSegmentV1 {
                control1: point.clone(),
                control2: point.clone(),
                end: point.clone(),
            }],
            start: point.clone(),
        }],
    }
}

/// Returns the visible arc-length prefix of a path.
///
/// # Errors
///
/// Returns [`GeometryError::EmptyPath`] when the input is not structurally valid
/// v1 cubic geometry.
pub fn trim_cubic_path_v1(path: &CubicPathV1, progress: f64) -> Result<CubicPathV1, GeometryError> {
    let first_point = path
        .subpaths
        .first()
        .ok_or(GeometryError::EmptyPath)?
        .start
        .clone();
    if progress >= 1.0 {
        return Ok(path.clone());
    }
    if progress <= 0.0 {
        return Ok(degenerate_path(&first_point));
    }

    let entries_by_subpath = segment_entries_by_subpath(path)?;
    let total_length: f64 = entries_by_subpath
        .iter()
        .flatten()
        .map(|entry| entry.length)
        .sum();
    if total_length == 0.0 {
        return Ok(degenerate_path(&first_point));
    }
    let mut remaining = total_length * progress;
    let mut output = Vec::with_capacity(path.subpaths.len());

    for (source_subpath, entries) in path.subpaths.iter().zip(entries_by_subpath) {
        let mut output_segments = Vec::with_capacity(source_subpath.segments.len());
        for entry in entries {
            if remaining >= entry.length {
                remaining -= entry.length;
                if !entry.closing {
                    output_segments.push(entry.segment.into_owned());
                }
                continue;
            }
            let measurement = measure_cubic(entry.start, entry.segment.as_ref());
            let parameter = parameter_at_length(&measurement, remaining);
            output_segments.push(split_cubic_prefix(
                entry.start,
                entry.segment.as_ref(),
                parameter,
            ));
            output.push(CubicSubpathV1 {
                closed: false,
                segments: output_segments,
                start: source_subpath.start.clone(),
            });
            return Ok(CubicPathV1 { subpaths: output });
        }
        output.push(CubicSubpathV1 {
            closed: source_subpath.closed,
            segments: output_segments,
            start: source_subpath.start.clone(),
        });
        if remaining <= 0.0 {
            return Ok(CubicPathV1 { subpaths: output });
        }
    }
    Ok(path.clone())
}

fn tangent_is_zero(tangent: &PointV1) -> bool {
    tangent.x.hypot(tangent.y) <= TANGENT_EPSILON_V1
}

/// Samples path position by fixed-subdivision arc length.
///
/// Tangent lookup searches backward first, then forward, matching ADR 0002's
/// cusp semantics. A wholly stationary path returns `None` instead of inventing
/// a direction.
///
/// # Errors
///
/// Returns [`GeometryError::EmptyPath`] when the input is not structurally valid
/// v1 cubic geometry.
pub fn sample_cubic_path_v1(
    path: &CubicPathV1,
    progress: f64,
) -> Result<PathSampleV1, GeometryError> {
    let entries: Vec<_> = segment_entries_by_subpath(path)?
        .into_iter()
        .flatten()
        .collect();
    let first_point = path
        .subpaths
        .first()
        .ok_or(GeometryError::EmptyPath)?
        .start
        .clone();
    let total_length: f64 = entries.iter().map(|entry| entry.length).sum();
    if total_length == 0.0 {
        return Ok(PathSampleV1 {
            point: first_point,
            tangent: None,
        });
    }

    let mut target = total_length * progress.clamp(0.0, 1.0);
    let mut selected_index = entries.len() - 1;
    for (index, entry) in entries.iter().enumerate() {
        selected_index = index;
        if target <= entry.length {
            break;
        }
        target -= entry.length;
    }
    let selected = &entries[selected_index];
    let measurement = measure_cubic(selected.start, selected.segment.as_ref());
    let parameter = parameter_at_length(&measurement, target);
    let point = point_on_cubic_v1(selected.start, selected.segment.as_ref(), parameter);
    let mut tangent = tangent_on_cubic(selected.start, selected.segment.as_ref(), parameter);

    for step in 1..=PATH_ARC_SUBDIVISIONS_V1 {
        if !tangent_is_zero(&tangent) {
            break;
        }
        #[allow(clippy::cast_precision_loss)]
        let prior_parameter = parameter * (1.0 - step as f64 / PATH_ARC_SUBDIVISIONS_V1 as f64);
        tangent = tangent_on_cubic(selected.start, selected.segment.as_ref(), prior_parameter);
    }
    for entry in entries[..selected_index].iter().rev() {
        for step in 0..=PATH_ARC_SUBDIVISIONS_V1 {
            if !tangent_is_zero(&tangent) {
                break;
            }
            #[allow(clippy::cast_precision_loss)]
            let prior_parameter = 1.0 - step as f64 / PATH_ARC_SUBDIVISIONS_V1 as f64;
            tangent = tangent_on_cubic(entry.start, entry.segment.as_ref(), prior_parameter);
        }
        if !tangent_is_zero(&tangent) {
            break;
        }
    }
    for step in 1..=PATH_ARC_SUBDIVISIONS_V1 {
        if !tangent_is_zero(&tangent) {
            break;
        }
        #[allow(clippy::cast_precision_loss)]
        let forward_parameter =
            parameter + (1.0 - parameter) * (step as f64 / PATH_ARC_SUBDIVISIONS_V1 as f64);
        tangent = tangent_on_cubic(selected.start, selected.segment.as_ref(), forward_parameter);
    }
    for entry in entries.iter().skip(selected_index + 1) {
        for step in 0..=PATH_ARC_SUBDIVISIONS_V1 {
            if !tangent_is_zero(&tangent) {
                break;
            }
            #[allow(clippy::cast_precision_loss)]
            let forward_parameter = step as f64 / PATH_ARC_SUBDIVISIONS_V1 as f64;
            tangent = tangent_on_cubic(entry.start, entry.segment.as_ref(), forward_parameter);
        }
        if !tangent_is_zero(&tangent) {
            break;
        }
    }

    Ok(PathSampleV1 {
        point,
        tangent: (!tangent_is_zero(&tangent)).then_some(tangent),
    })
}

/// Interpolates matching cubic path topology component-wise.
///
/// # Errors
///
/// Returns [`GeometryError::PathTopologyMismatch`] if subpath closure or segment
/// counts differ.
pub fn interpolate_cubic_path_v1(
    left: &CubicPathV1,
    right: &CubicPathV1,
    progress: f64,
) -> Result<CubicPathV1, GeometryError> {
    if left.subpaths.len() != right.subpaths.len()
        || left
            .subpaths
            .iter()
            .zip(&right.subpaths)
            .any(|(left, right)| {
                left.closed != right.closed || left.segments.len() != right.segments.len()
            })
    {
        return Err(GeometryError::PathTopologyMismatch);
    }
    Ok(CubicPathV1 {
        subpaths: left
            .subpaths
            .iter()
            .zip(&right.subpaths)
            .map(|(left, right)| CubicSubpathV1 {
                closed: left.closed,
                start: interpolate_point(&left.start, &right.start, progress),
                segments: left
                    .segments
                    .iter()
                    .zip(&right.segments)
                    .map(|(left, right)| CubicSegmentV1 {
                        control1: interpolate_point(&left.control1, &right.control1, progress),
                        control2: interpolate_point(&left.control2, &right.control2, progress),
                        end: interpolate_point(&left.end, &right.end, progress),
                    })
                    .collect(),
            })
            .collect(),
    })
}

fn circle_path(center: &PointV1, radius: f64) -> CubicPathV1 {
    let control = radius * (4.0 * (2.0_f64.sqrt() - 1.0) / 3.0);
    let right = PointV1 {
        x: center.x + radius,
        y: center.y,
    };
    let top = PointV1 {
        x: center.x,
        y: center.y + radius,
    };
    let left = PointV1 {
        x: center.x - radius,
        y: center.y,
    };
    let bottom = PointV1 {
        x: center.x,
        y: center.y - radius,
    };
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            start: right.clone(),
            segments: vec![
                CubicSegmentV1 {
                    control1: PointV1 {
                        x: right.x,
                        y: right.y + control,
                    },
                    control2: PointV1 {
                        x: top.x + control,
                        y: top.y,
                    },
                    end: top.clone(),
                },
                CubicSegmentV1 {
                    control1: PointV1 {
                        x: top.x - control,
                        y: top.y,
                    },
                    control2: PointV1 {
                        x: left.x,
                        y: left.y + control,
                    },
                    end: left.clone(),
                },
                CubicSegmentV1 {
                    control1: PointV1 {
                        x: left.x,
                        y: left.y - control,
                    },
                    control2: PointV1 {
                        x: bottom.x - control,
                        y: bottom.y,
                    },
                    end: bottom.clone(),
                },
                CubicSegmentV1 {
                    control1: PointV1 {
                        x: bottom.x + control,
                        y: bottom.y,
                    },
                    control2: PointV1 {
                        x: right.x,
                        y: right.y - control,
                    },
                    end: right,
                },
            ],
        }],
    }
}

#[allow(clippy::too_many_lines)] // Explicit corners keep canonical control order auditable.
fn rectangle_path(center: &PointV1, width: f64, height: f64, radius: f64) -> CubicPathV1 {
    let left = center.x - width / 2.0;
    let right = center.x + width / 2.0;
    let bottom = center.y - height / 2.0;
    let top = center.y + height / 2.0;
    let start = PointV1 {
        x: right - radius,
        y: bottom,
    };
    if radius == 0.0 {
        let points = [
            PointV1 { x: left, y: bottom },
            PointV1 { x: left, y: top },
            PointV1 { x: right, y: top },
            start.clone(),
        ];
        let mut prior = start.clone();
        let segments = points
            .iter()
            .map(|point| {
                let segment = line_segment(&prior, point);
                prior = point.clone();
                segment
            })
            .collect();
        return CubicPathV1 {
            subpaths: vec![CubicSubpathV1 {
                closed: true,
                segments,
                start,
            }],
        };
    }

    let control = radius * (4.0 * (2.0_f64.sqrt() - 1.0) / 3.0);
    let mut segments = Vec::with_capacity(8);
    let mut prior = start.clone();
    let line_to = |end: PointV1, prior: &mut PointV1, segments: &mut Vec<CubicSegmentV1>| {
        segments.push(line_segment(prior, &end));
        *prior = end;
    };
    let curve_to = |control1: PointV1,
                    control2: PointV1,
                    end: PointV1,
                    prior: &mut PointV1,
                    segments: &mut Vec<CubicSegmentV1>| {
        segments.push(CubicSegmentV1 {
            control1,
            control2,
            end: end.clone(),
        });
        *prior = end;
    };
    line_to(
        PointV1 {
            x: left + radius,
            y: bottom,
        },
        &mut prior,
        &mut segments,
    );
    curve_to(
        PointV1 {
            x: left + radius - control,
            y: bottom,
        },
        PointV1 {
            x: left,
            y: bottom + radius - control,
        },
        PointV1 {
            x: left,
            y: bottom + radius,
        },
        &mut prior,
        &mut segments,
    );
    line_to(
        PointV1 {
            x: left,
            y: top - radius,
        },
        &mut prior,
        &mut segments,
    );
    curve_to(
        PointV1 {
            x: left,
            y: top - radius + control,
        },
        PointV1 {
            x: left + radius - control,
            y: top,
        },
        PointV1 {
            x: left + radius,
            y: top,
        },
        &mut prior,
        &mut segments,
    );
    line_to(
        PointV1 {
            x: right - radius,
            y: top,
        },
        &mut prior,
        &mut segments,
    );
    curve_to(
        PointV1 {
            x: right - radius + control,
            y: top,
        },
        PointV1 {
            x: right,
            y: top - radius + control,
        },
        PointV1 {
            x: right,
            y: top - radius,
        },
        &mut prior,
        &mut segments,
    );
    line_to(
        PointV1 {
            x: right,
            y: bottom + radius,
        },
        &mut prior,
        &mut segments,
    );
    curve_to(
        PointV1 {
            x: right,
            y: bottom + radius - control,
        },
        PointV1 {
            x: right - radius + control,
            y: bottom,
        },
        start.clone(),
        &mut prior,
        &mut segments,
    );
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments,
            start,
        }],
    }
}

/// Lowers a v1 vector primitive to canonical absolute cubic paths.
///
/// # Errors
///
/// Returns [`GeometryError::ImageGeometry`] for image entities, which cross the
/// render boundary without path lowering.
pub fn scene_geometry_as_cubic_path_v1(
    geometry: &SceneGeometryV1,
) -> Result<CubicPathV1, GeometryError> {
    match geometry {
        SceneGeometryV1::Circle { center, radius } => Ok(circle_path(center, *radius)),
        SceneGeometryV1::Rectangle {
            center,
            corner_radius,
            height,
            width,
        } => Ok(rectangle_path(center, *width, *height, *corner_radius)),
        SceneGeometryV1::Line { end, start } => Ok(CubicPathV1 {
            subpaths: vec![CubicSubpathV1 {
                closed: false,
                segments: vec![line_segment(start, end)],
                start: start.clone(),
            }],
        }),
        SceneGeometryV1::CubicPath { path } => Ok(path.clone()),
        SceneGeometryV1::Image { .. } => Err(GeometryError::ImageGeometry),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_path(start: PointV1, end: &PointV1) -> CubicPathV1 {
        CubicPathV1 {
            subpaths: vec![CubicSubpathV1 {
                closed: false,
                segments: vec![line_segment(&start, end)],
                start,
            }],
        }
    }

    #[test]
    fn line_sampling_uses_arc_length() {
        let path = line_path(PointV1 { x: -2.0, y: 1.0 }, &PointV1 { x: 6.0, y: 5.0 });
        let sample = sample_cubic_path_v1(&path, 0.25).unwrap();
        assert!((sample.point.x - 0.0).abs() < 1.0e-12);
        assert!((sample.point.y - 2.0).abs() < 1.0e-12);
        assert!(sample.tangent.is_some());
    }

    #[test]
    fn trim_zero_emits_contract_valid_degenerate_segment() {
        let path = line_path(PointV1 { x: 2.0, y: 3.0 }, &PointV1 { x: 6.0, y: 3.0 });
        let trimmed = trim_cubic_path_v1(&path, 0.0).unwrap();
        assert_eq!(trimmed.subpaths.len(), 1);
        assert_eq!(trimmed.subpaths[0].segments.len(), 1);
        assert_eq!(
            trimmed.subpaths[0].segments[0].end,
            PointV1 { x: 2.0, y: 3.0 }
        );
    }

    #[test]
    fn trim_half_splits_with_de_casteljau() {
        let path = line_path(PointV1 { x: 0.0, y: 0.0 }, &PointV1 { x: 8.0, y: 0.0 });
        let trimmed = trim_cubic_path_v1(&path, 0.5).unwrap();
        let segment = &trimmed.subpaths[0].segments[0];
        assert!((segment.end.x - 4.0).abs() < 1.0e-12);
        assert!((segment.control1.x - 4.0 / 3.0).abs() < 1.0e-12);
        assert!((segment.control2.x - 8.0 / 3.0).abs() < 1.0e-12);
    }

    #[test]
    fn stationary_path_does_not_invent_a_tangent() {
        let point = PointV1 { x: 4.0, y: -2.0 };
        let path = CubicPathV1 {
            subpaths: vec![CubicSubpathV1 {
                closed: false,
                segments: vec![CubicSegmentV1 {
                    control1: point.clone(),
                    control2: point.clone(),
                    end: point.clone(),
                }],
                start: point.clone(),
            }],
        };
        assert_eq!(
            sample_cubic_path_v1(&path, 0.5).unwrap(),
            PathSampleV1 {
                point,
                tangent: None
            }
        );
    }

    #[test]
    fn primitive_lowering_has_fixed_segment_counts() {
        let circle = scene_geometry_as_cubic_path_v1(&SceneGeometryV1::Circle {
            center: PointV1 { x: 0.0, y: 0.0 },
            radius: 1.0,
        })
        .unwrap();
        let rounded = scene_geometry_as_cubic_path_v1(&SceneGeometryV1::Rectangle {
            center: PointV1 { x: 0.0, y: 0.0 },
            corner_radius: 0.25,
            height: 2.0,
            width: 4.0,
        })
        .unwrap();
        assert_eq!(circle.subpaths[0].segments.len(), 4);
        assert_eq!(rounded.subpaths[0].segments.len(), 8);
    }

    #[test]
    fn morph_rejects_mismatched_topology() {
        let one = line_path(PointV1 { x: 0.0, y: 0.0 }, &PointV1 { x: 1.0, y: 0.0 });
        let mut two = one.clone();
        let second_segment = two.subpaths[0].segments[0].clone();
        two.subpaths[0].segments.push(second_segment);
        assert_eq!(
            interpolate_cubic_path_v1(&one, &two, 0.5),
            Err(GeometryError::PathTopologyMismatch)
        );
    }
}
