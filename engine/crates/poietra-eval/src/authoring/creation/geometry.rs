//! Pure geometry and base-appearance construction for Studio-created entities.

use poietra_scene_ir::{
    CubicPathV1, CubicSegmentV1, CubicSubpathV1, PointV1, RgbaColorV1, SceneAppearanceV1,
    SceneCapabilityV1, SceneGeometryV1,
};

use super::{
    CreateSceneEntityGeometry, StudioAuthoringAngles, StudioAuthoringCoordinateRange,
    StudioAuthoringCoordinateSystem, StudioAuthoringDimensions, StudioAuthoringEntityKind,
    StudioCreationCubicBezierSpec, StudioCubicBezierStrokeCap, StudioDataPlotInterpolation,
    StudioDataSeries, studio_arrow_appearance, studio_math_tex_appearance, studio_shape_appearance,
};

pub(super) fn straight_cubic_segment(start: &PointV1, end: PointV1) -> CubicSegmentV1 {
    CubicSegmentV1 {
        control1: PointV1 {
            x: start.x + (end.x - start.x) / 3.0,
            y: start.y + (end.y - start.y) / 3.0,
        },
        control2: PointV1 {
            x: start.x + (end.x - start.x) * 2.0 / 3.0,
            y: start.y + (end.y - start.y) * 2.0 / 3.0,
        },
        end,
    }
}

const STUDIO_REGULAR_POLYGON_MIN_SIDES: u32 = 3;
const STUDIO_REGULAR_POLYGON_MAX_SIDES: u32 = 32;
const STUDIO_CURVE_MIN_SWEEP_RADIANS: f64 = 1.0e-6;
const STUDIO_COORDINATE_SYSTEM_MAX_MARKS: u32 = 128;
const STUDIO_COORDINATE_TICK_HALF_LENGTH_RATIO: f64 = 0.025;
const STUDIO_DATA_PLOT_MAX_POINTS: usize = 256;

pub(super) fn studio_regular_polygon_parameters(
    dimensions: StudioAuthoringDimensions,
) -> Option<(u32, f64)> {
    match (
        dimensions.angles,
        dimensions.coordinate_system,
        dimensions.height,
        dimensions.radius,
        dimensions.sides,
        dimensions.width,
    ) {
        (None, None, None, Some(radius), Some(sides), None)
            if radius.is_finite()
                && radius > 0.0
                && (STUDIO_REGULAR_POLYGON_MIN_SIDES..=STUDIO_REGULAR_POLYGON_MAX_SIDES)
                    .contains(&sides) =>
        {
            Some((sides, radius))
        }
        _ => None,
    }
}

pub(super) fn studio_ellipse_parameters(
    dimensions: StudioAuthoringDimensions,
) -> Option<(f64, f64)> {
    match (
        dimensions.angles,
        dimensions.coordinate_system,
        dimensions.height,
        dimensions.radius,
        dimensions.sides,
        dimensions.width,
    ) {
        (None, None, Some(height), None, None, Some(width))
            if height.is_finite() && height > 0.0 && width.is_finite() && width > 0.0 =>
        {
            Some((width, height))
        }
        _ => None,
    }
}

pub(super) fn studio_arc_parameters(
    dimensions: StudioAuthoringDimensions,
) -> Option<(f64, StudioAuthoringAngles)> {
    match (
        dimensions.angles,
        dimensions.coordinate_system,
        dimensions.height,
        dimensions.radius,
        dimensions.sides,
        dimensions.width,
    ) {
        (Some(angles), None, None, Some(radius), None, None)
            if radius.is_finite()
                && radius > 0.0
                && angles.start.is_finite()
                && angles.sweep.is_finite()
                && angles.sweep.abs() >= STUDIO_CURVE_MIN_SWEEP_RADIANS
                && angles.sweep.abs() <= std::f64::consts::TAU =>
        {
            Some((radius, angles))
        }
        _ => None,
    }
}

fn studio_coordinate_marks(range: StudioAuthoringCoordinateRange) -> Option<Vec<f64>> {
    let span = range.maximum - range.minimum;
    if !range.minimum.is_finite()
        || !range.maximum.is_finite()
        || !range.step.is_finite()
        || range.minimum >= range.maximum
        || range.step <= 0.0
        || !span.is_finite()
    {
        return None;
    }
    let mut marks = Vec::new();
    for index in 0..STUDIO_COORDINATE_SYSTEM_MAX_MARKS {
        let value = range.minimum + range.step * f64::from(index);
        if !value.is_finite() || value > range.maximum {
            return Some(marks);
        }
        marks.push(value);
    }
    let next = range.minimum + range.step * f64::from(STUDIO_COORDINATE_SYSTEM_MAX_MARKS);
    (!next.is_finite() || next > range.maximum).then_some(marks)
}

pub(super) fn studio_coordinate_system_parameters(
    kind: StudioAuthoringEntityKind,
    dimensions: StudioAuthoringDimensions,
) -> Option<(f64, Option<f64>, StudioAuthoringCoordinateSystem)> {
    let (width, height, coordinates) = match (
        kind,
        dimensions.angles,
        dimensions.coordinate_system,
        dimensions.height,
        dimensions.radius,
        dimensions.sides,
        dimensions.width,
    ) {
        (
            StudioAuthoringEntityKind::NumberLine,
            None,
            Some(coordinates @ StudioAuthoringCoordinateSystem { y: None, .. }),
            None,
            None,
            None,
            Some(width),
        ) if width.is_finite() && width > 0.0 => (width, None, coordinates),
        (
            StudioAuthoringEntityKind::Axes
            | StudioAuthoringEntityKind::DataPlot
            | StudioAuthoringEntityKind::NumberPlane,
            None,
            Some(coordinates @ StudioAuthoringCoordinateSystem { y: Some(_), .. }),
            Some(height),
            None,
            None,
            Some(width),
        ) if width.is_finite() && width > 0.0 && height.is_finite() && height > 0.0 => {
            (width, Some(height), coordinates)
        }
        _ => return None,
    };
    let x_mark_count = studio_coordinate_marks(coordinates.x)?.len();
    let y_mark_count = match coordinates.y {
        Some(range) => studio_coordinate_marks(range)?.len(),
        None => 0,
    };
    (x_mark_count + y_mark_count <= STUDIO_COORDINATE_SYSTEM_MAX_MARKS as usize).then_some((
        width,
        height,
        coordinates,
    ))
}

fn studio_coordinate_to_local(
    value: f64,
    range: StudioAuthoringCoordinateRange,
    length: f64,
) -> f64 {
    -length / 2.0 + (value - range.minimum) / (range.maximum - range.minimum) * length
}

fn push_studio_coordinate_line(
    subpaths: &mut Vec<CubicSubpathV1>,
    start: PointV1,
    end: PointV1,
) -> Option<()> {
    if ![start.x, start.y, end.x, end.y]
        .into_iter()
        .all(f64::is_finite)
    {
        return None;
    }
    subpaths.push(CubicSubpathV1 {
        closed: false,
        segments: vec![straight_cubic_segment(&start, end)],
        start,
    });
    Some(())
}

fn push_studio_horizontal_line(
    subpaths: &mut Vec<CubicSubpathV1>,
    y: f64,
    left: f64,
    right: f64,
) -> Option<()> {
    push_studio_coordinate_line(subpaths, PointV1 { x: left, y }, PointV1 { x: right, y })
}

fn push_studio_vertical_line(
    subpaths: &mut Vec<CubicSubpathV1>,
    x: f64,
    bottom: f64,
    top: f64,
) -> Option<()> {
    push_studio_coordinate_line(subpaths, PointV1 { x, y: bottom }, PointV1 { x, y: top })
}

pub(super) fn studio_coordinate_system_path(
    kind: StudioAuthoringEntityKind,
    width: f64,
    height: Option<f64>,
    coordinates: StudioAuthoringCoordinateSystem,
) -> Option<CubicPathV1> {
    let x_marks = studio_coordinate_marks(coordinates.x)?;
    let y_range = coordinates.y;
    let height = height.unwrap_or(width);
    let tick_half_length = width.min(height) * STUDIO_COORDINATE_TICK_HALF_LENGTH_RATIO;
    let axis_x = studio_coordinate_to_local(0.0, coordinates.x, width);
    let axis_y = y_range.map_or(0.0, |range| studio_coordinate_to_local(0.0, range, height));
    let mut subpaths = Vec::new();
    push_studio_horizontal_line(&mut subpaths, axis_y, -width / 2.0, width / 2.0)?;
    let has_y_axis = match kind {
        StudioAuthoringEntityKind::NumberLine => false,
        StudioAuthoringEntityKind::Axes | StudioAuthoringEntityKind::NumberPlane => true,
        _ => return None,
    };
    if has_y_axis {
        push_studio_vertical_line(&mut subpaths, axis_x, -height / 2.0, height / 2.0)?;
    }
    for value in x_marks {
        let x = studio_coordinate_to_local(value, coordinates.x, width);
        push_studio_vertical_line(
            &mut subpaths,
            x,
            axis_y - tick_half_length,
            axis_y + tick_half_length,
        )?;
        if kind == StudioAuthoringEntityKind::NumberPlane && value.abs() > 1.0e-12 {
            push_studio_vertical_line(&mut subpaths, x, -height / 2.0, height / 2.0)?;
        }
    }
    if let Some(y_range) = y_range {
        for value in studio_coordinate_marks(y_range)? {
            let y = studio_coordinate_to_local(value, y_range, height);
            push_studio_horizontal_line(
                &mut subpaths,
                y,
                axis_x - tick_half_length,
                axis_x + tick_half_length,
            )?;
            if kind == StudioAuthoringEntityKind::NumberPlane && value.abs() > 1.0e-12 {
                push_studio_horizontal_line(&mut subpaths, y, -width / 2.0, width / 2.0)?;
            }
        }
    }
    Some(CubicPathV1 { subpaths })
}

pub(super) fn studio_data_series_is_valid(
    series: &StudioDataSeries,
    dimensions: StudioAuthoringDimensions,
) -> bool {
    let Some((_, Some(_), coordinates)) =
        studio_coordinate_system_parameters(StudioAuthoringEntityKind::DataPlot, dimensions)
    else {
        return false;
    };
    let Some(y_range) = coordinates.y else {
        return false;
    };
    (2..=STUDIO_DATA_PLOT_MAX_POINTS).contains(&series.points.len())
        && series.points.iter().all(|point| {
            point.x.is_finite()
                && point.y.is_finite()
                && (coordinates.x.minimum..=coordinates.x.maximum).contains(&point.x)
                && (y_range.minimum..=y_range.maximum).contains(&point.y)
        })
        && series.points.windows(2).all(|pair| pair[0].x < pair[1].x)
}

fn studio_monotone_tangent(left_slope: f64, right_slope: f64) -> f64 {
    if !left_slope.is_finite()
        || !right_slope.is_finite()
        || left_slope == 0.0
        || right_slope == 0.0
        || left_slope.is_sign_positive() != right_slope.is_sign_positive()
    {
        return 0.0;
    }
    let smaller = left_slope.abs().min(right_slope.abs());
    let larger = left_slope.abs().max(right_slope.abs());
    left_slope.signum() * smaller * (2.0 / (1.0 + smaller / larger))
}

pub(super) fn studio_data_plot_path(
    dimensions: StudioAuthoringDimensions,
    series: &StudioDataSeries,
) -> Option<CubicPathV1> {
    if !studio_data_series_is_valid(series, dimensions) {
        return None;
    }
    let (width, Some(height), coordinates) =
        studio_coordinate_system_parameters(StudioAuthoringEntityKind::DataPlot, dimensions)?
    else {
        return None;
    };
    let y_range = coordinates.y?;
    let map_point = |point: &PointV1| PointV1 {
        x: studio_coordinate_to_local(point.x, coordinates.x, width),
        y: studio_coordinate_to_local(point.y, y_range, height),
    };
    let slopes = series
        .points
        .windows(2)
        .map(|pair| (pair[1].y - pair[0].y) / (pair[1].x - pair[0].x))
        .collect::<Vec<_>>();
    let mut tangents = vec![0.0; series.points.len()];
    if series.interpolation == StudioDataPlotInterpolation::Smooth {
        tangents[0] = if slopes[0].is_finite() {
            slopes[0]
        } else {
            0.0
        };
        for index in 1..series.points.len() - 1 {
            tangents[index] = studio_monotone_tangent(slopes[index - 1], slopes[index]);
        }
        let last = slopes[slopes.len() - 1];
        tangents[series.points.len() - 1] = if last.is_finite() { last } else { 0.0 };
    }
    let start = map_point(&series.points[0]);
    let segments = series
        .points
        .windows(2)
        .enumerate()
        .map(|(index, pair)| {
            let from = &pair[0];
            let to = &pair[1];
            if series.interpolation == StudioDataPlotInterpolation::Linear {
                return straight_cubic_segment(&map_point(from), map_point(to));
            }
            let delta_x = to.x - from.x;
            let minimum_y = from.y.min(to.y);
            let maximum_y = from.y.max(to.y);
            let first_y = (from.y + tangents[index] * delta_x / 3.0).clamp(minimum_y, maximum_y);
            let second_y = (to.y - tangents[index + 1] * delta_x / 3.0).clamp(minimum_y, maximum_y);
            CubicSegmentV1 {
                control1: map_point(&PointV1 {
                    x: from.x + delta_x / 3.0,
                    y: if first_y.is_finite() { first_y } else { from.y },
                }),
                control2: map_point(&PointV1 {
                    x: from.x + delta_x * 2.0 / 3.0,
                    y: if second_y.is_finite() { second_y } else { to.y },
                }),
                end: map_point(to),
            }
        })
        .collect::<Vec<_>>();
    let path = CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: false,
            segments,
            start,
        }],
    };
    let path_is_finite = path.subpaths[0]
        .segments
        .iter()
        .flat_map(|segment| [&segment.control1, &segment.control2, &segment.end])
        .chain(std::iter::once(&path.subpaths[0].start))
        .all(|point| point.x.is_finite() && point.y.is_finite());
    path_is_finite.then_some(path)
}

fn studio_elliptic_arc(
    radius_x: f64,
    radius_y: f64,
    start: f64,
    sweep: f64,
) -> (PointV1, Vec<CubicSegmentV1>) {
    let quarter_turns = sweep.abs() / std::f64::consts::FRAC_PI_2;
    let segment_count = if quarter_turns <= 1.0 {
        1
    } else if quarter_turns <= 2.0 {
        2
    } else if quarter_turns <= 3.0 {
        3
    } else {
        4
    };
    let step = sweep / f64::from(segment_count);
    let start_point = PointV1 {
        x: radius_x * start.cos(),
        y: radius_y * start.sin(),
    };
    let segments = (0..segment_count)
        .map(|index| {
            let from_angle = start + step * f64::from(index);
            let to_angle = from_angle + step;
            let tangent_factor = 4.0 / 3.0 * (step / 4.0).tan();
            let from = PointV1 {
                x: radius_x * from_angle.cos(),
                y: radius_y * from_angle.sin(),
            };
            let to = PointV1 {
                x: radius_x * to_angle.cos(),
                y: radius_y * to_angle.sin(),
            };
            CubicSegmentV1 {
                control1: PointV1 {
                    x: from.x - tangent_factor * radius_x * from_angle.sin(),
                    y: from.y + tangent_factor * radius_y * from_angle.cos(),
                },
                control2: PointV1 {
                    x: to.x + tangent_factor * radius_x * to_angle.sin(),
                    y: to.y - tangent_factor * radius_y * to_angle.cos(),
                },
                end: to,
            }
        })
        .collect();
    (start_point, segments)
}

pub(super) fn studio_ellipse_path(width: f64, height: f64) -> CubicPathV1 {
    let (start, mut segments) =
        studio_elliptic_arc(width / 2.0, height / 2.0, 0.0, std::f64::consts::TAU);
    if let Some(last) = segments.last_mut() {
        last.end = start.clone();
    }
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments,
            start,
        }],
    }
}

pub(super) fn studio_arc_path(radius: f64, angles: StudioAuthoringAngles) -> CubicPathV1 {
    let (start, segments) = studio_elliptic_arc(radius, radius, angles.start, angles.sweep);
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: false,
            segments,
            start,
        }],
    }
}

pub(super) fn studio_sector_path(radius: f64, angles: StudioAuthoringAngles) -> CubicPathV1 {
    let center = PointV1 { x: 0.0, y: 0.0 };
    let (arc_start, mut segments) = studio_elliptic_arc(radius, radius, angles.start, angles.sweep);
    let arc_end = segments
        .last()
        .map_or_else(|| arc_start.clone(), |segment| segment.end.clone());
    segments.insert(0, straight_cubic_segment(&center, arc_start));
    segments.push(straight_cubic_segment(&arc_end, center.clone()));
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments,
            start: center,
        }],
    }
}

pub(super) fn studio_regular_polygon_path(sides: u32, radius: f64) -> CubicPathV1 {
    let start_angle = if sides & 1 == 0 {
        0.0
    } else {
        std::f64::consts::FRAC_PI_2
    };
    let mut points = (0..sides)
        .map(|index| {
            let angle = start_angle + std::f64::consts::TAU * f64::from(index) / f64::from(sides);
            PointV1 {
                x: radius * angle.cos(),
                y: radius * angle.sin(),
            }
        })
        .collect::<Vec<_>>();
    let (min_x, max_x, min_y, max_y) = points.iter().fold(
        (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ),
        |(min_x, max_x, min_y, max_y), point| {
            (
                min_x.min(point.x),
                max_x.max(point.x),
                min_y.min(point.y),
                max_y.max(point.y),
            )
        },
    );
    let center_x = f64::midpoint(min_x, max_x);
    let center_y = f64::midpoint(min_y, max_y);
    for point in &mut points {
        point.x -= center_x;
        point.y -= center_y;
    }
    let segments = points
        .iter()
        .enumerate()
        .map(|(index, start)| {
            straight_cubic_segment(start, points[(index + 1) % points.len()].clone())
        })
        .collect();
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments,
            start: points[0].clone(),
        }],
    }
}

pub(super) fn scale_cubic_path(path: &CubicPathV1, factor: f64) -> CubicPathV1 {
    let scale = |point: &mut PointV1| {
        point.x *= factor;
        point.y *= factor;
    };
    let mut scaled = path.clone();
    for subpath in &mut scaled.subpaths {
        scale(&mut subpath.start);
        for segment in &mut subpath.segments {
            scale(&mut segment.control1);
            scale(&mut segment.control2);
            scale(&mut segment.end);
        }
    }
    scaled
}

fn studio_arrow_path() -> CubicPathV1 {
    let points = [
        PointV1 { x: -1.0, y: -0.02 },
        PointV1 { x: 0.65, y: -0.02 },
        PointV1 { x: 0.65, y: -0.175 },
        PointV1 { x: 1.0, y: 0.0 },
        PointV1 { x: 0.65, y: 0.175 },
        PointV1 { x: 0.65, y: 0.02 },
        PointV1 { x: -1.0, y: 0.02 },
    ];
    let mut segments = Vec::with_capacity(points.len() - 1);
    for pair in points.windows(2) {
        segments.push(straight_cubic_segment(&pair[0], pair[1].clone()));
    }
    CubicPathV1 {
        subpaths: vec![CubicSubpathV1 {
            closed: true,
            segments,
            start: points[0].clone(),
        }],
    }
}

pub(super) fn studio_cubic_bezier_appearance(
    spec: &StudioCreationCubicBezierSpec,
) -> SceneAppearanceV1 {
    let cap = match spec.stroke_cap {
        StudioCubicBezierStrokeCap::Butt => poietra_scene_ir::StrokeCapV1::Butt,
        StudioCubicBezierStrokeCap::Round => poietra_scene_ir::StrokeCapV1::Round,
        StudioCubicBezierStrokeCap::Square => poietra_scene_ir::StrokeCapV1::Square,
    };
    SceneAppearanceV1::Vector {
        fill: None,
        opacity: 1.0,
        stroke: Some(poietra_scene_ir::StrokeStyleV1 {
            cap,
            color: RgbaColorV1 {
                alpha: 1.0,
                blue: 1.0,
                green: 1.0,
                red: 1.0,
            },
            join: poietra_scene_ir::StrokeJoinV1::Round,
            miter_limit: 10.0,
            width_world: spec.stroke_width,
        }),
    }
}

pub(super) fn created_geometry_and_appearance(
    geometry: CreateSceneEntityGeometry,
) -> (SceneGeometryV1, SceneAppearanceV1, SceneCapabilityV1) {
    match geometry {
        CreateSceneEntityGeometry::Arrow => (
            SceneGeometryV1::CubicPath {
                path: studio_arrow_path(),
            },
            studio_arrow_appearance(),
            SceneCapabilityV1::CubicPathGeometry,
        ),
        CreateSceneEntityGeometry::Circle { radius } => (
            SceneGeometryV1::Circle {
                center: PointV1 { x: 0.0, y: 0.0 },
                radius,
            },
            studio_shape_appearance(),
            SceneCapabilityV1::ShapePrimitives,
        ),
        CreateSceneEntityGeometry::CubicBezier { appearance, path }
        | CreateSceneEntityGeometry::SvgPath { appearance, path } => (
            SceneGeometryV1::CubicPath { path },
            appearance,
            SceneCapabilityV1::CubicPathGeometry,
        ),
        CreateSceneEntityGeometry::Image {
            asset,
            local_rect,
            sampler,
        } => (
            SceneGeometryV1::Image {
                asset,
                local_rect,
                sampler,
            },
            SceneAppearanceV1::Image { opacity: 1.0 },
            SceneCapabilityV1::PngImage,
        ),
        CreateSceneEntityGeometry::Line => (
            SceneGeometryV1::Line {
                end: PointV1 { x: 1.0, y: 0.0 },
                start: PointV1 { x: -1.0, y: 0.0 },
            },
            studio_shape_appearance(),
            SceneCapabilityV1::ShapePrimitives,
        ),
        CreateSceneEntityGeometry::Rectangle { height, width } => (
            SceneGeometryV1::Rectangle {
                center: PointV1 { x: 0.0, y: 0.0 },
                corner_radius: 0.0,
                height,
                width,
            },
            studio_shape_appearance(),
            SceneCapabilityV1::ShapePrimitives,
        ),
        CreateSceneEntityGeometry::CubicOutline { path }
        | CreateSceneEntityGeometry::TextOutline { path } => (
            SceneGeometryV1::CubicPath { path },
            studio_math_tex_appearance(),
            SceneCapabilityV1::CubicPathGeometry,
        ),
        CreateSceneEntityGeometry::ShapeOutline { path } => (
            SceneGeometryV1::CubicPath { path },
            studio_shape_appearance(),
            SceneCapabilityV1::CubicPathGeometry,
        ),
        CreateSceneEntityGeometry::LogicalGroup => (
            SceneGeometryV1::Group {},
            SceneAppearanceV1::Group { opacity: 1.0 },
            SceneCapabilityV1::LogicalGroup,
        ),
    }
}
