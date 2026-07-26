use std::cmp::Ordering;
use std::ops::Range;

use poietra_scene_ir::{
    AffineTransformV1, CubicSegmentV1, CubicSubpathV1, RenderCameraV1, RenderDrawV1,
    RenderPacketV1, RgbaColorV1, StrokeCapV1, StrokeStyleV1, ViewportV1, validate_render_packet_v1,
};

/// Maximum deviation between a cubic control hull and its emitted chord.
pub const FLATTEN_TOLERANCE_PIXELS_V1: f64 = 0.25;
/// Whole-frame vertex ceiling for the initial CPU tessellation slice.
pub const MAX_PREPARED_VERTICES_V1: usize = 1_000_000;
const MAX_FLATTEN_DEPTH_V1: u8 = 20;

/// A valid v1 draw feature not implemented by the bounded WGPU paint slice.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum UnsupportedDrawReasonV1 {
    #[error("image draws are not implemented")]
    Image,
    #[error("combined fill and stroke draws are not implemented")]
    FillAndStroke,
    #[error("path draws must contain a solid fill")]
    MissingFill,
    #[error("multiple subpaths are not implemented")]
    MultipleSubpaths,
    #[error("open subpaths are not implemented")]
    OpenSubpath,
    #[error("only non-degenerate convex subpaths are implemented")]
    NonConvexOrDegenerate,
    #[error("closed stroke subpaths are not implemented")]
    ClosedStrokeSubpath,
    #[error("the stroke slice requires exactly one cubic segment")]
    StrokeSegmentCount,
    #[error("the stroke slice accepts only a static, untrimmed canonical Line cubic")]
    CurvedStroke,
    #[error("the transformed stroke line is degenerate")]
    DegenerateStroke,
}

/// A `RenderPacketV1` cannot be prepared without inventing or dropping pixels.
#[derive(Debug, thiserror::Error)]
pub enum PrepareFrameErrorV1 {
    #[error("invalid RenderPacketV1: {0}")]
    InvalidPacket(String),
    #[error("draw {draw_id} is unsupported: {reason}")]
    Unsupported {
        draw_id: String,
        reason: UnsupportedDrawReasonV1,
    },
    #[error("{context} is non-finite or outside the finite f32 range")]
    NumericRange { context: String },
    #[error("prepared geometry exceeds the u32 indexed-draw range")]
    IndexRange,
    #[error("draw {draw_id} exceeded the adaptive tessellation vertex limit of {maximum_vertices}")]
    TessellationVertexLimit {
        draw_id: String,
        maximum_vertices: usize,
    },
    #[error(
        "draw {draw_id} exceeded the adaptive tessellation subdivision depth of {maximum_depth}"
    )]
    TessellationDepthLimit { draw_id: String, maximum_depth: u8 },
}

/// One GPU-ready vertex. Values are exposed read-only; construction remains inside
/// [`prepare_frame_v1`] so uploads cannot bypass the f64 boundary checks.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreparedVertexV1 {
    position: [f32; 2],
    premultiplied_linear_color: [f32; 4],
}

impl PreparedVertexV1 {
    #[must_use]
    pub const fn position(&self) -> [f32; 2] {
        self.position
    }

    #[must_use]
    pub const fn premultiplied_linear_color(&self) -> [f32; 4] {
        self.premultiplied_linear_color
    }
}

/// Indexed triangle range for one source draw, kept in packet paint order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedDrawV1 {
    draw_id: String,
    index_range: Range<u32>,
}

impl PreparedDrawV1 {
    #[must_use]
    pub fn draw_id(&self) -> &str {
        &self.draw_id
    }

    #[must_use]
    pub const fn index_range(&self) -> &Range<u32> {
        &self.index_range
    }
}

/// Complete, fail-closed CPU output consumed by [`crate::WgpuPaintRendererV1`].
#[derive(Debug, PartialEq)]
pub struct PreparedFrameV1 {
    clear_color: [f64; 4],
    draws: Vec<PreparedDrawV1>,
    indices: Vec<u32>,
    vertices: Vec<PreparedVertexV1>,
    viewport: [u32; 2],
}

impl PreparedFrameV1 {
    #[must_use]
    pub const fn clear_color(&self) -> [f64; 4] {
        self.clear_color
    }

    #[must_use]
    pub fn draws(&self) -> &[PreparedDrawV1] {
        &self.draws
    }

    #[must_use]
    pub fn indices(&self) -> &[u32] {
        &self.indices
    }

    #[must_use]
    pub fn vertices(&self) -> &[PreparedVertexV1] {
        &self.vertices
    }

    #[must_use]
    pub const fn viewport(&self) -> [u32; 2] {
        self.viewport
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PointF64 {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct CubicF64 {
    control1: PointF64,
    control2: PointF64,
    depth: u8,
    end: PointF64,
    start: PointF64,
}

fn numeric_error(draw_id: Option<&str>, component: &str) -> PrepareFrameErrorV1 {
    let context = draw_id.map_or_else(
        || component.to_owned(),
        |draw_id| format!("draw {draw_id} {component}"),
    );
    PrepareFrameErrorV1::NumericRange { context }
}

fn checked_f32(
    value: f64,
    draw_id: Option<&str>,
    component: &str,
) -> Result<f32, PrepareFrameErrorV1> {
    if !value.is_finite() || value < f64::from(f32::MIN) || value > f64::from(f32::MAX) {
        return Err(numeric_error(draw_id, component));
    }
    #[allow(clippy::cast_possible_truncation)]
    let converted = value as f32;
    if !converted.is_finite() {
        return Err(numeric_error(draw_id, component));
    }
    Ok(converted)
}

fn transform_to_world(
    point: &poietra_scene_ir::PointV1,
    transform: &AffineTransformV1,
    draw_id: &str,
) -> Result<PointF64, PrepareFrameErrorV1> {
    let world = PointF64 {
        x: transform.m11 * point.x + transform.m12 * point.y + transform.tx,
        y: transform.m21 * point.x + transform.m22 * point.y + transform.ty,
    };
    if !world.x.is_finite() || !world.y.is_finite() {
        return Err(numeric_error(Some(draw_id), "world position"));
    }
    Ok(world)
}

fn world_to_clip(
    world: PointF64,
    camera: &RenderCameraV1,
    draw_id: &str,
) -> Result<PointF64, PrepareFrameErrorV1> {
    let camera_width = camera.right - camera.left;
    let camera_height = camera.top - camera.bottom;
    let camera_center_x = camera.left + camera_width * 0.5;
    let camera_center_y = camera.bottom + camera_height * 0.5;
    let clip = PointF64 {
        x: (world.x - camera_center_x) * 2.0 / camera_width,
        y: (world.y - camera_center_y) * 2.0 / camera_height,
    };
    if !clip.x.is_finite() || !clip.y.is_finite() {
        return Err(numeric_error(Some(draw_id), "clip position"));
    }
    checked_f32(clip.x, Some(draw_id), "clip x")?;
    checked_f32(clip.y, Some(draw_id), "clip y")?;
    Ok(clip)
}

fn point_key(point: PointF64) -> (u64, u64) {
    let normalized_x = if point.x == 0.0 { 0.0 } else { point.x };
    let normalized_y = if point.y == 0.0 { 0.0 } else { point.y };
    (normalized_x.to_bits(), normalized_y.to_bits())
}

fn same_point(left: PointF64, right: PointF64) -> bool {
    point_key(left) == point_key(right)
}

fn compare_points(left: &PointF64, right: &PointF64) -> Ordering {
    let left_x = if left.x == 0.0 { 0.0 } else { left.x };
    let right_x = if right.x == 0.0 { 0.0 } else { right.x };
    let left_y = if left.y == 0.0 { 0.0 } else { left.y };
    let right_y = if right.y == 0.0 { 0.0 } else { right.y };
    left_x
        .total_cmp(&right_x)
        .then_with(|| left_y.total_cmp(&right_y))
}

fn turn(first: PointF64, second: PointF64, third: PointF64) -> Option<f64> {
    let cross =
        (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
    cross.is_finite().then_some(cross)
}

/// Returns every point in counter-clockwise convex-boundary order. Keeping
/// collinear boundary points makes the subsequent order comparison exact while
/// retaining O(n log n) complexity for contract-sized packets.
fn convex_boundary(points: &[PointF64]) -> Option<Vec<PointF64>> {
    let mut sorted = points.to_vec();
    sorted.sort_by(compare_points);
    if sorted.windows(2).any(|pair| same_point(pair[0], pair[1])) {
        return None;
    }

    let mut lower = Vec::with_capacity(sorted.len());
    for point in sorted.iter().copied() {
        while lower.len() >= 2 {
            let cross = turn(lower[lower.len() - 2], lower[lower.len() - 1], point)?;
            if cross >= 0.0 {
                break;
            }
            lower.pop();
        }
        lower.push(point);
    }

    let mut upper = Vec::with_capacity(sorted.len());
    for point in sorted.iter().rev().copied() {
        while upper.len() >= 2 {
            let cross = turn(upper[upper.len() - 2], upper[upper.len() - 1], point)?;
            if cross >= 0.0 {
                break;
            }
            upper.pop();
        }
        upper.push(point);
    }

    lower.pop();
    upper.pop();
    lower.extend(upper);
    Some(lower)
}

fn is_non_degenerate_convex(points: &[PointF64]) -> bool {
    if points.len() < 3 {
        return false;
    }
    let Some(hull) = convex_boundary(points) else {
        return false;
    };
    if hull.len() != points.len() {
        return false;
    }

    let Some(start) = hull.iter().position(|point| same_point(*point, points[0])) else {
        return false;
    };
    let forward = points
        .iter()
        .enumerate()
        .all(|(offset, point)| same_point(*point, hull[(start + offset) % hull.len()]));
    let reverse = points.iter().enumerate().all(|(offset, point)| {
        same_point(*point, hull[(start + hull.len() - offset) % hull.len()])
    });
    forward || reverse
}

fn midpoint(left: PointF64, right: PointF64) -> PointF64 {
    PointF64 {
        x: left.x + (right.x - left.x) * 0.5,
        y: left.y + (right.y - left.y) * 0.5,
    }
}

fn split_cubic(curve: CubicF64) -> (CubicF64, CubicF64) {
    let first = midpoint(curve.start, curve.control1);
    let second = midpoint(curve.control1, curve.control2);
    let third = midpoint(curve.control2, curve.end);
    let fourth = midpoint(first, second);
    let fifth = midpoint(second, third);
    let split = midpoint(fourth, fifth);
    let depth = curve.depth + 1;
    (
        CubicF64 {
            control1: first,
            control2: fourth,
            depth,
            end: split,
            start: curve.start,
        },
        CubicF64 {
            control1: fifth,
            control2: third,
            depth,
            end: curve.end,
            start: split,
        },
    )
}

fn distance_to_chord_segment(point: PointF64, start: PointF64, end: PointF64) -> f64 {
    let delta_x = end.x - start.x;
    let delta_y = end.y - start.y;
    let length_squared = delta_x * delta_x + delta_y * delta_y;
    if length_squared == 0.0 {
        return (point.x - start.x).hypot(point.y - start.y);
    }
    let projection = (((point.x - start.x) * delta_x + (point.y - start.y) * delta_y)
        / length_squared)
        .clamp(0.0, 1.0);
    let closest = PointF64 {
        x: start.x + projection * delta_x,
        y: start.y + projection * delta_y,
    };
    (point.x - closest.x).hypot(point.y - closest.y)
}

fn world_flatten_tolerance(camera: &RenderCameraV1, viewport: &ViewportV1) -> f64 {
    let world_units_per_pixel_x = (camera.right - camera.left) / f64::from(viewport.width_px);
    let world_units_per_pixel_y = (camera.top - camera.bottom) / f64::from(viewport.height_px);
    FLATTEN_TOLERANCE_PIXELS_V1 * world_units_per_pixel_x.min(world_units_per_pixel_y)
}

fn cubic_is_flat(
    curve: CubicF64,
    tolerance_world: f64,
    draw_id: &str,
) -> Result<bool, PrepareFrameErrorV1> {
    let maximum_distance = distance_to_chord_segment(curve.control1, curve.start, curve.end).max(
        distance_to_chord_segment(curve.control2, curve.start, curve.end),
    );
    if !maximum_distance.is_finite() {
        return Err(numeric_error(Some(draw_id), "world tessellation metric"));
    }
    Ok(maximum_distance <= tolerance_world)
}

fn append_point(
    points: &mut Vec<PointF64>,
    point: PointF64,
    maximum_vertices: usize,
    draw_id: &str,
) -> Result<(), PrepareFrameErrorV1> {
    if points
        .last()
        .is_some_and(|previous| same_point(*previous, point))
    {
        return Ok(());
    }
    if points.len() >= maximum_vertices {
        return Err(PrepareFrameErrorV1::TessellationVertexLimit {
            draw_id: draw_id.to_owned(),
            maximum_vertices: MAX_PREPARED_VERTICES_V1,
        });
    }
    points.push(point);
    Ok(())
}

fn world_curve(
    start: &poietra_scene_ir::PointV1,
    segment: &CubicSegmentV1,
    transform: &AffineTransformV1,
    draw_id: &str,
) -> Result<CubicF64, PrepareFrameErrorV1> {
    Ok(CubicF64 {
        control1: transform_to_world(&segment.control1, transform, draw_id)?,
        control2: transform_to_world(&segment.control2, transform, draw_id)?,
        depth: 0,
        end: transform_to_world(&segment.end, transform, draw_id)?,
        start: transform_to_world(start, transform, draw_id)?,
    })
}

fn flatten_subpath_world(
    subpath: &CubicSubpathV1,
    transform: &AffineTransformV1,
    camera: &RenderCameraV1,
    viewport: &ViewportV1,
    draw_id: &str,
    maximum_vertices: usize,
) -> Result<Vec<PointF64>, PrepareFrameErrorV1> {
    let initial_capacity = subpath
        .segments
        .len()
        .saturating_add(1)
        .min(maximum_vertices);
    let mut points = Vec::with_capacity(initial_capacity);
    append_point(
        &mut points,
        transform_to_world(&subpath.start, transform, draw_id)?,
        maximum_vertices,
        draw_id,
    )?;
    let tolerance_world = world_flatten_tolerance(camera, viewport);
    let mut start = &subpath.start;
    for segment in &subpath.segments {
        let mut stack = vec![world_curve(start, segment, transform, draw_id)?];
        while let Some(curve) = stack.pop() {
            if cubic_is_flat(curve, tolerance_world, draw_id)? {
                append_point(&mut points, curve.end, maximum_vertices, draw_id)?;
                continue;
            }
            if curve.depth >= MAX_FLATTEN_DEPTH_V1 {
                return Err(PrepareFrameErrorV1::TessellationDepthLimit {
                    draw_id: draw_id.to_owned(),
                    maximum_depth: MAX_FLATTEN_DEPTH_V1,
                });
            }
            let (left, right) = split_cubic(curve);
            stack.push(right);
            stack.push(left);
        }
        start = &segment.end;
    }
    if points.len() > 1 && same_point(points[0], *points.last().expect("length checked")) {
        points.pop();
    }
    Ok(points)
}

fn canonical_line_control(
    start: &poietra_scene_ir::PointV1,
    end: &poietra_scene_ir::PointV1,
    factor: f64,
) -> PointF64 {
    PointF64 {
        x: start.x + (end.x - start.x) * factor,
        y: start.y + (end.y - start.y) * factor,
    }
}

#[allow(clippy::float_cmp)] // Exact producer recognition; a tolerance could silently accept curves.
fn is_canonical_line_cubic(start: &poietra_scene_ir::PointV1, segment: &CubicSegmentV1) -> bool {
    let control1 = canonical_line_control(start, &segment.end, 1.0 / 3.0);
    let control2 = canonical_line_control(start, &segment.end, 2.0 / 3.0);
    segment.control1.x == control1.x
        && segment.control1.y == control1.y
        && segment.control2.x == control2.x
        && segment.control2.y == control2.y
}

fn append_prepared_vertex(
    vertices: &mut Vec<PreparedVertexV1>,
    world: PointF64,
    color: [f32; 4],
    camera: &RenderCameraV1,
    draw_id: &str,
) -> Result<u32, PrepareFrameErrorV1> {
    if vertices.len() >= MAX_PREPARED_VERTICES_V1 {
        return Err(PrepareFrameErrorV1::TessellationVertexLimit {
            draw_id: draw_id.to_owned(),
            maximum_vertices: MAX_PREPARED_VERTICES_V1,
        });
    }
    let clip = world_to_clip(world, camera, draw_id)?;
    let index = u32::try_from(vertices.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
    vertices.push(PreparedVertexV1 {
        position: [
            checked_f32(clip.x, Some(draw_id), "clip x")?,
            checked_f32(clip.y, Some(draw_id), "clip y")?,
        ],
        premultiplied_linear_color: color,
    });
    Ok(index)
}

fn append_stroke_quad(
    vertices: &mut Vec<PreparedVertexV1>,
    indices: &mut Vec<u32>,
    corners: [PointF64; 4],
    color: [f32; 4],
    camera: &RenderCameraV1,
    draw_id: &str,
) -> Result<(), PrepareFrameErrorV1> {
    let [start_left, start_right, end_left, end_right] = corners;
    let start_left = append_prepared_vertex(vertices, start_left, color, camera, draw_id)?;
    let start_right = append_prepared_vertex(vertices, start_right, color, camera, draw_id)?;
    let end_left = append_prepared_vertex(vertices, end_left, color, camera, draw_id)?;
    let end_right = append_prepared_vertex(vertices, end_right, color, camera, draw_id)?;
    indices.extend_from_slice(&[
        start_left,
        start_right,
        end_left,
        end_left,
        start_right,
        end_right,
    ]);
    Ok(())
}

fn round_cap_segments(
    radius: f64,
    tolerance_world: f64,
    draw_id: &str,
) -> Result<u32, PrepareFrameErrorV1> {
    let mut segments = 1u32;
    let mut depth = 0u8;
    while radius * (1.0 - (std::f64::consts::PI / (2.0 * f64::from(segments))).cos())
        > tolerance_world
    {
        if depth >= MAX_FLATTEN_DEPTH_V1 {
            return Err(PrepareFrameErrorV1::TessellationDepthLimit {
                draw_id: draw_id.to_owned(),
                maximum_depth: MAX_FLATTEN_DEPTH_V1,
            });
        }
        segments = segments.checked_mul(2).ok_or_else(|| {
            PrepareFrameErrorV1::TessellationVertexLimit {
                draw_id: draw_id.to_owned(),
                maximum_vertices: MAX_PREPARED_VERTICES_V1,
            }
        })?;
        depth += 1;
    }
    Ok(segments)
}

#[allow(clippy::too_many_arguments)]
fn append_round_cap(
    vertices: &mut Vec<PreparedVertexV1>,
    indices: &mut Vec<u32>,
    center: PointF64,
    first: PointF64,
    first_angle: f64,
    last: PointF64,
    radius: f64,
    segments: u32,
    color: [f32; 4],
    camera: &RenderCameraV1,
    draw_id: &str,
) -> Result<(), PrepareFrameErrorV1> {
    let center_index = append_prepared_vertex(vertices, center, color, camera, draw_id)?;
    let mut previous = append_prepared_vertex(vertices, first, color, camera, draw_id)?;
    for step in 1..=segments {
        let progress = f64::from(step) / f64::from(segments);
        let angle = first_angle + std::f64::consts::PI * progress;
        let point = if step == segments {
            last
        } else {
            PointF64 {
                x: center.x + radius * angle.cos(),
                y: center.y + radius * angle.sin(),
            }
        };
        let next = append_prepared_vertex(vertices, point, color, camera, draw_id)?;
        indices.extend_from_slice(&[center_index, previous, next]);
        previous = next;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_straight_stroke(
    vertices: &mut Vec<PreparedVertexV1>,
    indices: &mut Vec<u32>,
    start: PointF64,
    end: PointF64,
    stroke: &StrokeStyleV1,
    opacity: f64,
    camera: &RenderCameraV1,
    viewport: &ViewportV1,
    draw_id: &str,
) -> Result<(), PrepareFrameErrorV1> {
    let delta_x = end.x - start.x;
    let delta_y = end.y - start.y;
    let length = delta_x.hypot(delta_y);
    if !length.is_finite() {
        return Err(numeric_error(Some(draw_id), "stroke length"));
    }
    if length == 0.0 {
        return Err(PrepareFrameErrorV1::Unsupported {
            draw_id: draw_id.to_owned(),
            reason: UnsupportedDrawReasonV1::DegenerateStroke,
        });
    }

    let direction = PointF64 {
        x: delta_x / length,
        y: delta_y / length,
    };
    let normal = PointF64 {
        x: -direction.y,
        y: direction.x,
    };
    let radius = stroke.width_world * 0.5;
    let (start_center, end_center) = if stroke.cap == StrokeCapV1::Square {
        (
            PointF64 {
                x: start.x - direction.x * radius,
                y: start.y - direction.y * radius,
            },
            PointF64 {
                x: end.x + direction.x * radius,
                y: end.y + direction.y * radius,
            },
        )
    } else {
        (start, end)
    };
    let offset = PointF64 {
        x: normal.x * radius,
        y: normal.y * radius,
    };
    let corners = [
        PointF64 {
            x: start_center.x + offset.x,
            y: start_center.y + offset.y,
        },
        PointF64 {
            x: start_center.x - offset.x,
            y: start_center.y - offset.y,
        },
        PointF64 {
            x: end_center.x + offset.x,
            y: end_center.y + offset.y,
        },
        PointF64 {
            x: end_center.x - offset.x,
            y: end_center.y - offset.y,
        },
    ];
    let color = premultiplied_linear_color(&stroke.color, opacity, Some(draw_id))?;
    append_stroke_quad(vertices, indices, corners, color, camera, draw_id)?;

    if stroke.cap == StrokeCapV1::Round {
        let segments =
            round_cap_segments(radius, world_flatten_tolerance(camera, viewport), draw_id)?;
        let direction_angle = direction.y.atan2(direction.x);
        append_round_cap(
            vertices,
            indices,
            start,
            corners[0],
            direction_angle + std::f64::consts::FRAC_PI_2,
            corners[1],
            radius,
            segments,
            color,
            camera,
            draw_id,
        )?;
        append_round_cap(
            vertices,
            indices,
            end,
            corners[3],
            direction_angle - std::f64::consts::FRAC_PI_2,
            corners[2],
            radius,
            segments,
            color,
            camera,
            draw_id,
        )?;
    }
    Ok(())
}

fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.040_45 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

fn premultiplied_linear_color(
    color: &RgbaColorV1,
    opacity: f64,
    draw_id: Option<&str>,
) -> Result<[f32; 4], PrepareFrameErrorV1> {
    let alpha = color.alpha * opacity;
    Ok([
        checked_f32(srgb_to_linear(color.red) * alpha, draw_id, "red")?,
        checked_f32(srgb_to_linear(color.green) * alpha, draw_id, "green")?,
        checked_f32(srgb_to_linear(color.blue) * alpha, draw_id, "blue")?,
        checked_f32(alpha, draw_id, "alpha")?,
    ])
}

fn prepared_clear_color(color: &RgbaColorV1) -> Result<[f64; 4], PrepareFrameErrorV1> {
    let alpha = color.alpha;
    let result = [
        srgb_to_linear(color.red) * alpha,
        srgb_to_linear(color.green) * alpha,
        srgb_to_linear(color.blue) * alpha,
        alpha,
    ];
    for (index, value) in result.iter().enumerate() {
        checked_f32(
            *value,
            None,
            ["clear red", "clear green", "clear blue", "clear alpha"][index],
        )?;
    }
    Ok(result)
}

/// Validates and prepares a complete packet without accessing a GPU.
///
/// Local cubic sampling, affine transformation, camera-relative clip mapping,
/// and finite f32 range checks all run in f64. If one draw is unsupported, no
/// partial [`PreparedFrameV1`] is returned.
///
/// # Errors
///
/// Returns a structured validation, unsupported-feature, numeric, tessellation,
/// or index error.
#[allow(clippy::too_many_lines)]
pub fn prepare_frame_v1(packet: &RenderPacketV1) -> Result<PreparedFrameV1, PrepareFrameErrorV1> {
    validate_render_packet_v1(packet)
        .map_err(|error| PrepareFrameErrorV1::InvalidPacket(error.to_string()))?;

    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let mut draws = Vec::with_capacity(packet.draws.len());
    for draw in &packet.draws {
        let RenderDrawV1::Path {
            draw_id,
            fill,
            opacity,
            path,
            stroke,
            transform,
            ..
        } = draw
        else {
            return Err(PrepareFrameErrorV1::Unsupported {
                draw_id: draw.draw_id().to_owned(),
                reason: UnsupportedDrawReasonV1::Image,
            });
        };
        if fill.is_some() && stroke.is_some() {
            return Err(PrepareFrameErrorV1::Unsupported {
                draw_id: draw_id.clone(),
                reason: UnsupportedDrawReasonV1::FillAndStroke,
            });
        }
        let index_start =
            u32::try_from(indices.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
        if let Some(stroke) = stroke {
            if path.subpaths.len() != 1 {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw_id.clone(),
                    reason: UnsupportedDrawReasonV1::MultipleSubpaths,
                });
            }
            let subpath = &path.subpaths[0];
            if subpath.closed {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw_id.clone(),
                    reason: UnsupportedDrawReasonV1::ClosedStrokeSubpath,
                });
            }
            if subpath.segments.len() != 1 {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw_id.clone(),
                    reason: UnsupportedDrawReasonV1::StrokeSegmentCount,
                });
            }
            let segment = &subpath.segments[0];
            if !is_canonical_line_cubic(&subpath.start, segment) {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw_id.clone(),
                    reason: UnsupportedDrawReasonV1::CurvedStroke,
                });
            }
            append_straight_stroke(
                &mut vertices,
                &mut indices,
                transform_to_world(&subpath.start, transform, draw_id)?,
                transform_to_world(&segment.end, transform, draw_id)?,
                stroke,
                *opacity,
                &packet.camera,
                &packet.viewport,
                draw_id,
            )?;
        } else {
            let Some(fill) = fill else {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw_id.clone(),
                    reason: UnsupportedDrawReasonV1::MissingFill,
                });
            };
            if path.subpaths.len() != 1 {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw_id.clone(),
                    reason: UnsupportedDrawReasonV1::MultipleSubpaths,
                });
            }
            let subpath = &path.subpaths[0];
            if !subpath.closed {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw_id.clone(),
                    reason: UnsupportedDrawReasonV1::OpenSubpath,
                });
            }
            let remaining_vertices = MAX_PREPARED_VERTICES_V1
                .checked_sub(vertices.len())
                .ok_or_else(|| PrepareFrameErrorV1::TessellationVertexLimit {
                    draw_id: draw_id.clone(),
                    maximum_vertices: MAX_PREPARED_VERTICES_V1,
                })?;
            let world_points = flatten_subpath_world(
                subpath,
                transform,
                &packet.camera,
                &packet.viewport,
                draw_id,
                remaining_vertices,
            )?;
            if !is_non_degenerate_convex(&world_points) {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw_id.clone(),
                    reason: UnsupportedDrawReasonV1::NonConvexOrDegenerate,
                });
            }
            let points = world_points
                .into_iter()
                .map(|point| world_to_clip(point, &packet.camera, draw_id))
                .collect::<Result<Vec<_>, _>>()?;

            let color = premultiplied_linear_color(&fill.color, *opacity, Some(draw_id))?;
            let base_vertex =
                u32::try_from(vertices.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
            for point in &points {
                vertices.push(PreparedVertexV1 {
                    position: [
                        checked_f32(point.x, Some(draw_id), "clip x")?,
                        checked_f32(point.y, Some(draw_id), "clip y")?,
                    ],
                    premultiplied_linear_color: color,
                });
            }

            for offset in 1..(points.len() - 1) {
                let middle = u32::try_from(offset).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
                let end = u32::try_from(offset + 1).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
                indices.extend_from_slice(&[
                    base_vertex,
                    base_vertex
                        .checked_add(middle)
                        .ok_or(PrepareFrameErrorV1::IndexRange)?,
                    base_vertex
                        .checked_add(end)
                        .ok_or(PrepareFrameErrorV1::IndexRange)?,
                ]);
            }
        }
        let index_end =
            u32::try_from(indices.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
        draws.push(PreparedDrawV1 {
            draw_id: draw_id.clone(),
            index_range: index_start..index_end,
        });
    }

    Ok(PreparedFrameV1 {
        clear_color: prepared_clear_color(&packet.camera.clear_color)?,
        draws,
        indices,
        vertices,
        viewport: [packet.viewport.width_px, packet.viewport.height_px],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collinear_control_overshoot_is_not_flattened_to_the_endpoint_chord() {
        let curve = CubicF64 {
            control1: PointF64 { x: 2.0, y: 0.0 },
            control2: PointF64 { x: 2.0, y: 0.0 },
            depth: 0,
            end: PointF64 { x: 1.0, y: 0.0 },
            start: PointF64 { x: 0.0, y: 0.0 },
        };
        assert!(!cubic_is_flat(curve, 0.005, "draw:test").unwrap());
    }

    #[test]
    fn self_intersecting_pentagram_is_not_accepted_as_convex() {
        let outer = (0..5)
            .map(|index| {
                let angle =
                    std::f64::consts::FRAC_PI_2 + f64::from(index) * std::f64::consts::TAU / 5.0;
                PointF64 {
                    x: angle.cos(),
                    y: angle.sin(),
                }
            })
            .collect::<Vec<_>>();
        let pentagram = [outer[0], outer[2], outer[4], outer[1], outer[3]];

        assert!(!is_non_degenerate_convex(&pentagram));
    }

    #[test]
    fn convex_boundary_order_accepts_edge_points_and_rejects_concavity() {
        let convex_with_edge_point = [
            PointF64 { x: 0.0, y: 0.0 },
            PointF64 { x: 1.0, y: 0.0 },
            PointF64 { x: 2.0, y: 0.0 },
            PointF64 { x: 2.0, y: 1.0 },
            PointF64 { x: 0.0, y: 1.0 },
        ];
        let concave = [
            PointF64 { x: 0.0, y: 0.0 },
            PointF64 { x: 2.0, y: 0.0 },
            PointF64 { x: 1.0, y: 0.5 },
            PointF64 { x: 2.0, y: 1.0 },
            PointF64 { x: 0.0, y: 1.0 },
        ];
        let duplicate = [
            PointF64 { x: 0.0, y: 0.0 },
            PointF64 { x: 1.0, y: 0.0 },
            PointF64 { x: 1.0, y: 1.0 },
            PointF64 { x: 0.0, y: 0.0 },
        ];
        let all_collinear = [
            PointF64 { x: 0.0, y: 0.0 },
            PointF64 { x: 1.0, y: 0.0 },
            PointF64 { x: 2.0, y: 0.0 },
        ];

        assert!(is_non_degenerate_convex(&convex_with_edge_point));
        assert!(!is_non_degenerate_convex(&concave));
        assert!(!is_non_degenerate_convex(&duplicate));
        assert!(!is_non_degenerate_convex(&all_collinear));
    }

    #[test]
    fn cubic_subdivision_happens_after_the_local_curve_enters_world_space() {
        let start = poietra_scene_ir::PointV1 { x: 0.0, y: 1.0 };
        let segment = CubicSegmentV1 {
            control1: poietra_scene_ir::PointV1 { x: 1.0, y: 2.0 },
            control2: poietra_scene_ir::PointV1 { x: 2.0, y: 3.0 },
            end: poietra_scene_ir::PointV1 { x: 3.0, y: 4.0 },
        };
        let transform = AffineTransformV1 {
            m11: 2.0,
            m12: 3.0,
            m21: -1.0,
            m22: 4.0,
            tx: 5.0,
            ty: 6.0,
        };

        let curve = world_curve(&start, &segment, &transform, "draw:test").unwrap();
        assert_eq!(curve.start, PointF64 { x: 8.0, y: 10.0 });
        assert_eq!(curve.control1, PointF64 { x: 13.0, y: 13.0 });
        assert_eq!(curve.control2, PointF64 { x: 18.0, y: 16.0 });
        assert_eq!(curve.end, PointF64 { x: 23.0, y: 19.0 });

        let (left, right) = split_cubic(curve);
        assert_eq!(left.start, curve.start);
        assert_eq!(right.end, curve.end);
        assert_eq!(left.end, right.start);
    }
}
