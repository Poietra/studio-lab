use std::collections::HashMap;
use std::ops::Range;

use lyon_tessellation::geometry_builder::{
    FillGeometryBuilder, GeometryBuilder, StrokeGeometryBuilder,
};
use lyon_tessellation::math::{Point as LyonPoint, point as lyon_point};
use lyon_tessellation::{
    FillOptions, FillTessellator, FillVertex, GeometryBuilderError, LineCap, LineJoin,
    StrokeOptions, StrokeTessellator, StrokeVertex, TessellationError, VertexId,
};
use poietra_scene_ir::{
    AffineTransformV1, CubicSegmentV1, CubicSubpathV1, FillRuleV1, RenderCameraV1, RenderDrawV1,
    RenderPacketV1, RgbaColorV1, StrokeCapV1, StrokeJoinV1, StrokeStyleV1, ViewportV1,
    validate_render_packet_v1,
};

/// Maximum deviation between a cubic control hull and its emitted chord.
pub const FLATTEN_TOLERANCE_PIXELS_V1: f64 = 0.25;
/// Whole-frame vertex ceiling for the initial CPU tessellation slice.
pub const MAX_PREPARED_VERTICES_V1: usize = 1_000_000;
const MAX_FILL_SOURCE_CUBICS_PER_DRAW_V1: usize = 2_048;
const MAX_FILL_FLATTENED_POINTS_PER_DRAW_V1: usize = 32_768;
const MAX_FILL_OUTPUT_VERTICES_PER_DRAW_V1: usize = 65_536;
const MAX_STROKE_SOURCE_CUBICS_PER_DRAW_V1: usize = 2_048;
const MAX_STROKE_FLATTENED_SEGMENTS_PER_DRAW_V1: usize = 32_768;
const MAX_STROKE_OUTPUT_VERTICES_PER_DRAW_V1: usize = 65_536;
const MAX_STROKE_ARC_RECURSION_DEPTH_V1: u32 = 15;
const STROKE_INPUT_ULP_SAFETY_FACTOR_V1: f64 = 16.0;
const MAX_FLATTEN_DEPTH_V1: u8 = 20;

/// A valid v1 draw feature not implemented by the bounded WGPU paint slice.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum UnsupportedDrawReasonV1 {
    #[error("image draws are not implemented")]
    Image,
    #[error("path draws must contain a solid fill or stroke")]
    MissingPaint,
    #[error("open subpaths are not implemented")]
    OpenSubpath,
    #[error("the filled path is degenerate after bounded screen-space conversion")]
    DegenerateFill,
    #[error("the stroked path contains a degenerate cubic segment")]
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
    #[error(
        "draw {draw_id} loses more than {maximum_error_pixels} px or collapses when entering the f32 upload domain"
    )]
    FillPrecisionLoss {
        draw_id: String,
        maximum_error_pixels: f64,
    },
    #[error("draw {draw_id} fill tessellation failed: {reason}")]
    FillTessellation { draw_id: String, reason: String },
    #[error("draw {draw_id} exceeded the filled-path source limit of {maximum_cubics} cubics")]
    FillSourceCubicLimit {
        draw_id: String,
        maximum_cubics: usize,
    },
    #[error(
        "draw {draw_id} stroke cannot preserve the {maximum_error_pixels} px precision budget or collapses in the bounded f32 tessellation domain"
    )]
    StrokePrecisionLoss {
        draw_id: String,
        maximum_error_pixels: f64,
    },
    #[error("draw {draw_id} stroke tessellation failed: {reason}")]
    StrokeTessellation { draw_id: String, reason: String },
    #[error("draw {draw_id} exceeded the stroked-path source limit of {maximum_cubics} cubics")]
    StrokeSourceCubicLimit {
        draw_id: String,
        maximum_cubics: usize,
    },
    #[error(
        "draw {draw_id} exceeded the stroke flattening limit of {maximum_segments} line segments"
    )]
    StrokeFlatteningLimit {
        draw_id: String,
        maximum_segments: usize,
    },
    #[error("draw {draw_id} exceeded the round stroke arc recursion limit of {maximum_depth}")]
    StrokeArcComplexityLimit { draw_id: String, maximum_depth: u32 },
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

/// Position-only prepared geometry. Material interleaving is deferred to the
/// upload plan, so material-only changes do not change this value.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreparedGeometryVertexV1 {
    position: [f32; 2],
}

impl PreparedGeometryVertexV1 {
    #[must_use]
    pub const fn position(&self) -> [f32; 2] {
        self.position
    }
}

/// Premultiplied linear-light solid paint for one prepared paint phase.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreparedMaterialV1 {
    premultiplied_linear_color: [f32; 4],
}

impl PreparedMaterialV1 {
    #[must_use]
    pub const fn premultiplied_linear_color(&self) -> [f32; 4] {
        self.premultiplied_linear_color
    }
}

/// Indexed triangle range for one paint phase, kept in packet paint order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedDrawV1 {
    draw_id: String,
    entity_id: String,
    index_range: Range<u32>,
    material_index: u32,
    vertex_range: Range<u32>,
}

impl PreparedDrawV1 {
    #[must_use]
    pub fn draw_id(&self) -> &str {
        &self.draw_id
    }

    #[must_use]
    pub fn entity_id(&self) -> &str {
        &self.entity_id
    }

    #[must_use]
    pub const fn index_range(&self) -> &Range<u32> {
        &self.index_range
    }

    #[must_use]
    pub const fn material_index(&self) -> u32 {
        self.material_index
    }

    #[must_use]
    pub const fn vertex_range(&self) -> &Range<u32> {
        &self.vertex_range
    }
}

/// World/clip-space geometry derived for one sampled frame.
#[derive(Debug, PartialEq)]
pub struct PreparedGeometryPlanV1 {
    indices: Vec<u32>,
    tessellation_calls: u64,
    vertices: Vec<PreparedGeometryVertexV1>,
}

/// Material values kept separate from geometry until upload encoding.
#[derive(Debug, PartialEq)]
pub struct PreparedMaterialPlanV1 {
    clear_color: [f64; 4],
    materials: Vec<PreparedMaterialV1>,
}

/// Indexed draw ranges in the packet's stable translucent paint order.
#[derive(Debug, PartialEq)]
pub struct OrderedDrawPlanV1 {
    draws: Vec<PreparedDrawV1>,
}

/// Complete, fail-closed CPU output consumed by [`crate::WgpuPaintRendererV1`].
#[derive(Debug, PartialEq)]
pub struct PreparedFrameV1 {
    geometry: PreparedGeometryPlanV1,
    materials: PreparedMaterialPlanV1,
    ordered_draws: OrderedDrawPlanV1,
    viewport: [u32; 2],
}

impl PreparedFrameV1 {
    #[must_use]
    pub const fn clear_color(&self) -> [f64; 4] {
        self.materials.clear_color
    }

    #[must_use]
    pub fn draws(&self) -> &[PreparedDrawV1] {
        &self.ordered_draws.draws
    }

    #[must_use]
    pub fn indices(&self) -> &[u32] {
        &self.geometry.indices
    }

    /// Returns the visual AABB of every prepared paint phase for one runtime
    /// entity in clip space as `[min_x, min_y, max_x, max_y]`.
    ///
    /// The bounds are derived only from the final `f32` vertices used for GPU
    /// upload, so stroke width, camera projection, hierarchy, and sampled
    /// transforms are already reflected. Missing or internally inconsistent
    /// geometry returns `None` without exposing a panicking API.
    #[must_use]
    pub fn clip_bounds_for_entity(&self, entity_id: &str) -> Option<[f32; 4]> {
        let mut bounds: Option<[f32; 4]> = None;
        for draw in self
            .ordered_draws
            .draws
            .iter()
            .filter(|draw| draw.entity_id == entity_id)
        {
            let start = usize::try_from(draw.vertex_range.start).ok()?;
            let end = usize::try_from(draw.vertex_range.end).ok()?;
            let vertices = self.geometry.vertices.get(start..end)?;
            for vertex in vertices {
                let [x, y] = vertex.position;
                if !x.is_finite() || !y.is_finite() {
                    return None;
                }
                bounds = Some(bounds.map_or([x, y, x, y], |[min_x, min_y, max_x, max_y]| {
                    [min_x.min(x), min_y.min(y), max_x.max(x), max_y.max(y)]
                }));
            }
        }
        bounds
    }

    #[must_use]
    pub const fn geometry_plan(&self) -> &PreparedGeometryPlanV1 {
        &self.geometry
    }

    #[must_use]
    pub(crate) fn material_for_draw(&self, draw: &PreparedDrawV1) -> Option<&PreparedMaterialV1> {
        usize::try_from(draw.material_index)
            .ok()
            .and_then(|index| self.materials.materials.get(index))
    }

    #[must_use]
    pub const fn material_plan(&self) -> &PreparedMaterialPlanV1 {
        &self.materials
    }

    #[must_use]
    pub const fn ordered_draw_plan(&self) -> &OrderedDrawPlanV1 {
        &self.ordered_draws
    }

    /// Number of paint-phase tessellation operations that actually ran while
    /// preparing this frame. A path with both fill and stroke contributes two
    /// calls in fill-then-stroke order; the value is never inferred from
    /// vertex or index totals.
    #[must_use]
    pub const fn tessellation_calls(&self) -> u64 {
        self.geometry.tessellation_calls
    }

    #[must_use]
    pub const fn viewport(&self) -> [u32; 2] {
        self.viewport
    }

    #[cfg(test)]
    pub(crate) fn triangle_for_upload_test() -> Self {
        Self {
            geometry: PreparedGeometryPlanV1 {
                indices: vec![0, 1, 2],
                tessellation_calls: 1,
                vertices: vec![
                    PreparedGeometryVertexV1 {
                        position: [-1.0, -1.0],
                    },
                    PreparedGeometryVertexV1 {
                        position: [1.0, -1.0],
                    },
                    PreparedGeometryVertexV1 {
                        position: [0.0, 1.0],
                    },
                ],
            },
            materials: PreparedMaterialPlanV1 {
                clear_color: [0.0, 0.0, 0.0, 1.0],
                materials: vec![PreparedMaterialV1 {
                    premultiplied_linear_color: [0.5, 0.25, 0.0, 0.5],
                }],
            },
            ordered_draws: OrderedDrawPlanV1 {
                draws: vec![PreparedDrawV1 {
                    draw_id: "draw:test".to_owned(),
                    entity_id: "entity:test".to_owned(),
                    index_range: 0..3,
                    material_index: 0,
                    vertex_range: 0..3,
                }],
            },
            viewport: [160, 90],
        }
    }
}

impl PreparedGeometryPlanV1 {
    #[must_use]
    pub fn indices(&self) -> &[u32] {
        &self.indices
    }

    #[must_use]
    pub const fn tessellation_calls(&self) -> u64 {
        self.tessellation_calls
    }

    #[must_use]
    pub fn vertices(&self) -> &[PreparedGeometryVertexV1] {
        &self.vertices
    }
}

impl PreparedMaterialPlanV1 {
    #[must_use]
    pub const fn clear_color(&self) -> [f64; 4] {
        self.clear_color
    }

    #[must_use]
    pub fn materials(&self) -> &[PreparedMaterialV1] {
        &self.materials
    }
}

impl OrderedDrawPlanV1 {
    #[must_use]
    pub fn draws(&self) -> &[PreparedDrawV1] {
        &self.draws
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
    reported_maximum_vertices: usize,
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
            maximum_vertices: reported_maximum_vertices,
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
    reported_maximum_vertices: usize,
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
        reported_maximum_vertices,
        draw_id,
    )?;
    let tolerance_world = world_flatten_tolerance(camera, viewport);
    let mut start = &subpath.start;
    for segment in &subpath.segments {
        let mut stack = vec![world_curve(start, segment, transform, draw_id)?];
        while let Some(curve) = stack.pop() {
            if cubic_is_flat(curve, tolerance_world, draw_id)? {
                append_point(
                    &mut points,
                    curve.end,
                    maximum_vertices,
                    reported_maximum_vertices,
                    draw_id,
                )?;
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

fn normalized_f32_bits(value: f32) -> u32 {
    if value == 0.0 {
        0.0f32.to_bits()
    } else {
        value.to_bits()
    }
}

fn fill_point_key(point: LyonPoint) -> (u32, u32) {
    (normalized_f32_bits(point.x), normalized_f32_bits(point.y))
}

fn world_to_fill_point(
    world: PointF64,
    camera: &RenderCameraV1,
    viewport: &ViewportV1,
    draw_id: &str,
) -> Result<(LyonPoint, PointF64), PrepareFrameErrorV1> {
    let clip = world_to_clip(world, camera, draw_id)?;
    let clip_x = checked_f32(clip.x, Some(draw_id), "clip x")?;
    let clip_y = checked_f32(clip.y, Some(draw_id), "clip y")?;
    let error_pixels_x = (clip.x - f64::from(clip_x)).abs() * f64::from(viewport.width_px) * 0.5;
    let error_pixels_y = (clip.y - f64::from(clip_y)).abs() * f64::from(viewport.height_px) * 0.5;
    if error_pixels_x.hypot(error_pixels_y) > FLATTEN_TOLERANCE_PIXELS_V1 {
        return Err(PrepareFrameErrorV1::FillPrecisionLoss {
            draw_id: draw_id.to_owned(),
            maximum_error_pixels: FLATTEN_TOLERANCE_PIXELS_V1,
        });
    }
    Ok((lyon_point(clip_x, clip_y), clip))
}

#[derive(Debug, Default)]
struct FillContourTopologyV1 {
    first: Option<LyonPoint>,
    has_non_collinear_point: bool,
    second_distinct: Option<LyonPoint>,
}

impl FillContourTopologyV1 {
    fn observe(&mut self, point: LyonPoint) -> bool {
        let Some(first) = self.first else {
            self.first = Some(point);
            return true;
        };
        let Some(second) = self.second_distinct else {
            if fill_point_key(point) != fill_point_key(first) {
                self.second_distinct = Some(point);
            }
            return false;
        };
        let cross = (f64::from(second.x) - f64::from(first.x))
            * (f64::from(point.y) - f64::from(first.y))
            - (f64::from(second.y) - f64::from(first.y))
                * (f64::from(point.x) - f64::from(first.x));
        self.has_non_collinear_point |= cross != 0.0;
        false
    }

    const fn is_degenerate(&self) -> bool {
        !self.has_non_collinear_point
    }
}

#[derive(Debug)]
struct BoundedGeometryV1 {
    first_index: usize,
    first_vertex: usize,
    index_limit_exceeded: bool,
    indices: Vec<u32>,
    maximum_indices: usize,
    maximum_vertices: usize,
    vertices: Vec<LyonPoint>,
}

impl BoundedGeometryV1 {
    fn new(maximum_vertices: usize) -> Self {
        Self {
            first_index: 0,
            first_vertex: 0,
            index_limit_exceeded: false,
            indices: Vec::new(),
            maximum_indices: maximum_vertices.saturating_mul(6),
            maximum_vertices,
            vertices: Vec::new(),
        }
    }
}

impl GeometryBuilder for BoundedGeometryV1 {
    fn begin_geometry(&mut self) {
        self.first_index = self.indices.len();
        self.first_vertex = self.vertices.len();
        self.index_limit_exceeded = false;
    }

    fn add_triangle(&mut self, first: VertexId, second: VertexId, third: VertexId) {
        let Some(next_len) = self.indices.len().checked_add(3) else {
            self.index_limit_exceeded = true;
            return;
        };
        if next_len > self.maximum_indices {
            self.index_limit_exceeded = true;
            return;
        }
        self.indices
            .extend_from_slice(&[u32::from(first), u32::from(second), u32::from(third)]);
    }

    fn abort_geometry(&mut self) {
        self.vertices.truncate(self.first_vertex);
        self.indices.truncate(self.first_index);
        self.index_limit_exceeded = false;
    }
}

impl FillGeometryBuilder for BoundedGeometryV1 {
    fn add_fill_vertex(
        &mut self,
        vertex: FillVertex<'_>,
    ) -> Result<VertexId, GeometryBuilderError> {
        if self.vertices.len() >= self.maximum_vertices {
            return Err(GeometryBuilderError::TooManyVertices);
        }
        let position = vertex.position();
        if !position.x.is_finite() || !position.y.is_finite() {
            return Err(GeometryBuilderError::InvalidVertex);
        }
        let index = u32::try_from(self.vertices.len())
            .map_err(|_| GeometryBuilderError::TooManyVertices)?;
        self.vertices.push(position);
        Ok(VertexId(index))
    }
}

impl StrokeGeometryBuilder for BoundedGeometryV1 {
    fn add_stroke_vertex(
        &mut self,
        vertex: StrokeVertex<'_, '_>,
    ) -> Result<VertexId, GeometryBuilderError> {
        if self.vertices.len() >= self.maximum_vertices {
            return Err(GeometryBuilderError::TooManyVertices);
        }
        let position = vertex.position();
        if !position.x.is_finite() || !position.y.is_finite() {
            return Err(GeometryBuilderError::InvalidVertex);
        }
        let index = u32::try_from(self.vertices.len())
            .map_err(|_| GeometryBuilderError::TooManyVertices)?;
        self.vertices.push(position);
        Ok(VertexId(index))
    }
}

fn fill_tessellation_error(
    error: &TessellationError,
    draw_id: &str,
    maximum_vertices: usize,
) -> PrepareFrameErrorV1 {
    if matches!(
        error,
        TessellationError::GeometryBuilder(GeometryBuilderError::TooManyVertices)
    ) {
        return PrepareFrameErrorV1::TessellationVertexLimit {
            draw_id: draw_id.to_owned(),
            maximum_vertices,
        };
    }
    PrepareFrameErrorV1::FillTessellation {
        draw_id: draw_id.to_owned(),
        reason: error.to_string(),
    }
}

#[derive(Clone, Copy)]
enum GeometryPhaseV1 {
    Fill,
    Stroke,
}

impl GeometryPhaseV1 {
    fn error(self, draw_id: &str, reason: String) -> PrepareFrameErrorV1 {
        match self {
            Self::Fill => PrepareFrameErrorV1::FillTessellation {
                draw_id: draw_id.to_owned(),
                reason,
            },
            Self::Stroke => PrepareFrameErrorV1::StrokeTessellation {
                draw_id: draw_id.to_owned(),
                reason,
            },
        }
    }
}

fn validate_geometry_output(
    output: &BoundedGeometryV1,
    draw_id: &str,
    degenerate_reason: UnsupportedDrawReasonV1,
    phase: GeometryPhaseV1,
) -> Result<(), PrepareFrameErrorV1> {
    if output.index_limit_exceeded {
        return Err(phase.error(
            draw_id,
            "triangle index output exceeded the bounded planar-mesh limit".to_owned(),
        ));
    }
    if output.vertices.is_empty() || output.indices.is_empty() {
        return Err(PrepareFrameErrorV1::Unsupported {
            draw_id: draw_id.to_owned(),
            reason: degenerate_reason,
        });
    }
    if !output.indices.len().is_multiple_of(3) {
        return Err(phase.error(
            draw_id,
            "triangle index output is not divisible by three".to_owned(),
        ));
    }
    for triangle in output.indices.chunks_exact(3) {
        let [first, second, third] = [
            usize::try_from(triangle[0]).map_err(|_| PrepareFrameErrorV1::IndexRange)?,
            usize::try_from(triangle[1]).map_err(|_| PrepareFrameErrorV1::IndexRange)?,
            usize::try_from(triangle[2]).map_err(|_| PrepareFrameErrorV1::IndexRange)?,
        ];
        let Some((&first, &second, &third)) = output
            .vertices
            .get(first)
            .zip(output.vertices.get(second))
            .zip(output.vertices.get(third))
            .map(|((first, second), third)| (first, second, third))
        else {
            return Err(phase.error(draw_id, "triangle references an unknown vertex".to_owned()));
        };
        let doubled_area = (f64::from(second.x) - f64::from(first.x))
            * (f64::from(third.y) - f64::from(first.y))
            - (f64::from(second.y) - f64::from(first.y))
                * (f64::from(third.x) - f64::from(first.x));
        if doubled_area == 0.0 || !doubled_area.is_finite() {
            return Err(PrepareFrameErrorV1::Unsupported {
                draw_id: draw_id.to_owned(),
                reason: degenerate_reason,
            });
        }
    }
    Ok(())
}

fn world_to_camera_relative(
    world: PointF64,
    camera: &RenderCameraV1,
    draw_id: &str,
) -> Result<PointF64, PrepareFrameErrorV1> {
    let camera_center_x = camera.left + (camera.right - camera.left) * 0.5;
    let camera_center_y = camera.bottom + (camera.top - camera.bottom) * 0.5;
    let relative = PointF64 {
        x: world.x - camera_center_x,
        y: world.y - camera_center_y,
    };
    if !relative.x.is_finite() || !relative.y.is_finite() {
        return Err(numeric_error(
            Some(draw_id),
            "camera-relative stroke position",
        ));
    }
    Ok(relative)
}

fn stroke_precision_error(draw_id: &str) -> PrepareFrameErrorV1 {
    PrepareFrameErrorV1::StrokePrecisionLoss {
        draw_id: draw_id.to_owned(),
        maximum_error_pixels: FLATTEN_TOLERANCE_PIXELS_V1,
    }
}

fn stroke_pixels_per_world(
    camera: &RenderCameraV1,
    viewport: &ViewportV1,
    draw_id: &str,
) -> Result<f64, PrepareFrameErrorV1> {
    let pixels_per_world_x = f64::from(viewport.width_px) / (camera.right - camera.left);
    let pixels_per_world_y = f64::from(viewport.height_px) / (camera.top - camera.bottom);
    // Use the denser axis so a 0.25-unit Lyon deviation cannot exceed 0.25
    // physical pixels when camera and viewport aspect ratios differ.
    let scale = pixels_per_world_x.max(pixels_per_world_y);
    if !scale.is_finite() || scale <= 0.0 {
        return Err(numeric_error(Some(draw_id), "stroke pixel scale"));
    }
    Ok(scale)
}

fn world_to_stroke_point(
    world: PointF64,
    camera: &RenderCameraV1,
    pixels_per_world: f64,
    maximum_ulp_pixels: f64,
    draw_id: &str,
) -> Result<(LyonPoint, PointF64), PrepareFrameErrorV1> {
    let relative = world_to_camera_relative(world, camera, draw_id)?;
    let pixel = PointF64 {
        x: relative.x * pixels_per_world,
        y: relative.y * pixels_per_world,
    };
    let converted_x = checked_f32(pixel.x, Some(draw_id), "camera-relative stroke pixel x")?;
    let converted_y = checked_f32(pixel.y, Some(draw_id), "camera-relative stroke pixel y")?;
    let error_pixels_x = (pixel.x - f64::from(converted_x)).abs();
    let error_pixels_y = (pixel.y - f64::from(converted_y)).abs();
    if error_pixels_x.hypot(error_pixels_y) > FLATTEN_TOLERANCE_PIXELS_V1
        || f32_ulp(converted_x) > maximum_ulp_pixels
        || f32_ulp(converted_y) > maximum_ulp_pixels
    {
        return Err(stroke_precision_error(draw_id));
    }
    Ok((lyon_point(converted_x, converted_y), pixel))
}

fn f32_ulp(value: f32) -> f64 {
    let magnitude = value.abs();
    if magnitude == 0.0 {
        return f64::from(f32::from_bits(1));
    }
    let next = f32::from_bits(magnitude.to_bits().saturating_add(1));
    f64::from(next) - f64::from(magnitude)
}

fn stroke_scalar_to_f32(
    value: f64,
    visible_scale: f64,
    draw_id: &str,
    component: &str,
) -> Result<f32, PrepareFrameErrorV1> {
    let converted = checked_f32(value, Some(draw_id), component)?;
    let error_pixels = (value - f64::from(converted)).abs() * visible_scale;
    if converted <= 0.0 || !error_pixels.is_finite() || error_pixels > FLATTEN_TOLERANCE_PIXELS_V1 {
        return Err(stroke_precision_error(draw_id));
    }
    Ok(converted)
}

fn stroke_output_position(
    point: LyonPoint,
    camera: &RenderCameraV1,
    pixels_per_world: f64,
    viewport: &ViewportV1,
    draw_id: &str,
) -> Result<[f32; 2], PrepareFrameErrorV1> {
    let clip = PointF64 {
        x: f64::from(point.x) * 2.0 / ((camera.right - camera.left) * pixels_per_world),
        y: f64::from(point.y) * 2.0 / ((camera.top - camera.bottom) * pixels_per_world),
    };
    let converted_x = checked_f32(clip.x, Some(draw_id), "stroke clip x")?;
    let converted_y = checked_f32(clip.y, Some(draw_id), "stroke clip y")?;
    let error_pixels_x =
        (clip.x - f64::from(converted_x)).abs() * f64::from(viewport.width_px) * 0.5;
    let error_pixels_y =
        (clip.y - f64::from(converted_y)).abs() * f64::from(viewport.height_px) * 0.5;
    let ulp_pixels_x = f32_ulp(converted_x) * f64::from(viewport.width_px) * 0.5;
    let ulp_pixels_y = f32_ulp(converted_y) * f64::from(viewport.height_px) * 0.5;
    if error_pixels_x.hypot(error_pixels_y) > FLATTEN_TOLERANCE_PIXELS_V1
        || ulp_pixels_x > FLATTEN_TOLERANCE_PIXELS_V1
        || ulp_pixels_y > FLATTEN_TOLERANCE_PIXELS_V1
    {
        return Err(stroke_precision_error(draw_id));
    }
    Ok([converted_x, converted_y])
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

/// Unforgeable proof that a packet passed [`validate_frame_packet_v1`].
///
/// The field is private and there is no public constructor, so callers cannot
/// hand [`tessellate_validated_frame_v1`] an unvalidated packet: the only way
/// to obtain this token is through validation. This keeps the telemetry split
/// exactly as fail-closed as the combined [`prepare_frame_v1`] entry point.
#[derive(Clone, Copy, Debug)]
pub struct ValidatedRenderPacketV1<'a> {
    packet: &'a RenderPacketV1,
}

/// Validates a complete packet before tessellation without accessing a GPU.
///
/// This is the packet-validation half of [`prepare_frame_v1`], exposed so
/// opt-in telemetry can time validation and tessellation separately without
/// validating twice. The returned token is the only way to reach
/// [`tessellate_validated_frame_v1`].
///
/// # Errors
///
/// Returns a structured validation error.
pub fn validate_frame_packet_v1(
    packet: &RenderPacketV1,
) -> Result<ValidatedRenderPacketV1<'_>, PrepareFrameErrorV1> {
    validate_render_packet_v1(packet)
        .map_err(|error| PrepareFrameErrorV1::InvalidPacket(error.to_string()))?;
    Ok(ValidatedRenderPacketV1 { packet })
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
pub fn prepare_frame_v1(packet: &RenderPacketV1) -> Result<PreparedFrameV1, PrepareFrameErrorV1> {
    tessellate_validated_frame_v1(validate_frame_packet_v1(packet)?)
}

fn prepare_material(
    color: &RgbaColorV1,
    opacity: f64,
    draw_id: &str,
) -> Result<PreparedMaterialV1, PrepareFrameErrorV1> {
    Ok(PreparedMaterialV1 {
        premultiplied_linear_color: premultiplied_linear_color(color, opacity, Some(draw_id))?,
    })
}

#[derive(Clone, Copy)]
struct GeometryContextV1<'a> {
    camera: &'a RenderCameraV1,
    draw_id: &'a str,
    viewport: &'a ViewportV1,
}

fn validate_stroke_source_limits(
    path: &poietra_scene_ir::CubicPathV1,
    draw_id: &str,
) -> Result<(), PrepareFrameErrorV1> {
    let mut source_cubics = 0usize;
    for subpath in &path.subpaths {
        source_cubics = source_cubics.saturating_add(subpath.segments.len());
        if source_cubics > MAX_STROKE_SOURCE_CUBICS_PER_DRAW_V1 {
            return Err(PrepareFrameErrorV1::StrokeSourceCubicLimit {
                draw_id: draw_id.to_owned(),
                maximum_cubics: MAX_STROKE_SOURCE_CUBICS_PER_DRAW_V1,
            });
        }
    }
    Ok(())
}

fn stroke_options(
    stroke: &StrokeStyleV1,
    pixels_per_world: f64,
    context: GeometryContextV1<'_>,
) -> Result<StrokeOptions, PrepareFrameErrorV1> {
    let line_width_pixels = stroke.width_world * pixels_per_world;
    let width_error_scale = if matches!(stroke.join, StrokeJoinV1::Miter) {
        stroke.miter_limit * 0.5
    } else {
        0.5
    };
    let line_width = stroke_scalar_to_f32(
        line_width_pixels,
        width_error_scale,
        context.draw_id,
        "stroke width in pixel-normalized space",
    )?;
    let miter_limit = stroke_scalar_to_f32(
        stroke.miter_limit,
        line_width_pixels * 0.5,
        context.draw_id,
        "stroke miter limit",
    )?;
    let tolerance = stroke_scalar_to_f32(
        FLATTEN_TOLERANCE_PIXELS_V1,
        1.0,
        context.draw_id,
        "stroke tessellation tolerance",
    )?;
    let line_cap = match stroke.cap {
        StrokeCapV1::Butt => LineCap::Butt,
        StrokeCapV1::Round => LineCap::Round,
        StrokeCapV1::Square => LineCap::Square,
    };
    let line_join = match stroke.join {
        StrokeJoinV1::Bevel => LineJoin::Bevel,
        StrokeJoinV1::Miter => LineJoin::Miter,
        StrokeJoinV1::Round => LineJoin::Round,
    };
    Ok(StrokeOptions::default()
        .with_line_width(line_width)
        .with_line_cap(line_cap)
        .with_line_join(line_join)
        .with_miter_limit(miter_limit)
        .with_tolerance(tolerance))
}

#[derive(Clone, Copy)]
struct PreparedStrokeCubicV1 {
    control1: LyonPoint,
    control2: LyonPoint,
    end: LyonPoint,
}

struct PreparedStrokeSubpathV1 {
    closed: bool,
    segments: Vec<PreparedStrokeCubicV1>,
    start: LyonPoint,
}

fn maximum_stroke_input_ulp(stroke: &StrokeStyleV1) -> f64 {
    let amplification = if matches!(stroke.join, StrokeJoinV1::Miter) {
        stroke.miter_limit
    } else {
        1.0
    };
    FLATTEN_TOLERANCE_PIXELS_V1 / (STROKE_INPUT_ULP_SAFETY_FACTOR_V1 * amplification)
}

fn stroke_input_point(
    world: PointF64,
    context: GeometryContextV1<'_>,
    pixels_per_world: f64,
    maximum_ulp_pixels: f64,
    input_points: &mut HashMap<(u32, u32), (u64, u64)>,
) -> Result<LyonPoint, PrepareFrameErrorV1> {
    let (point, pixel) = world_to_stroke_point(
        world,
        context.camera,
        pixels_per_world,
        maximum_ulp_pixels,
        context.draw_id,
    )?;
    if input_points
        .insert(fill_point_key(point), point_key(pixel))
        .is_some_and(|previous| previous != point_key(pixel))
    {
        return Err(stroke_precision_error(context.draw_id));
    }
    Ok(point)
}

fn stroke_cubic_flattened_segments(
    start: LyonPoint,
    curve: PreparedStrokeCubicV1,
    tolerance: f32,
    draw_id: &str,
) -> Result<usize, PrepareFrameErrorV1> {
    // This mirrors lyon_geom's f32 Wang bound, but rounds upward and validates
    // it before Lyon enters its callback-only flattening loop.
    let first_x = (start.x - curve.control1.x * 2.0 + curve.control2.x) * 6.0;
    let first_y = (start.y - curve.control1.y * 2.0 + curve.control2.y) * 6.0;
    let second_x = (curve.control1.x - curve.control2.x * 2.0 + curve.end.x) * 6.0;
    let second_y = (curve.control1.y - curve.control2.y * 2.0 + curve.end.y) * 6.0;
    let length_squared =
        (first_x * first_x + first_y * first_y).max(second_x * second_x + second_y * second_y);
    let denominator = 8.0 * tolerance;
    let error_to_fourth = length_squared / (denominator * denominator);
    let Some(segments) = stroke_wang_segment_count(error_to_fourth) else {
        return Err(PrepareFrameErrorV1::StrokeFlatteningLimit {
            draw_id: draw_id.to_owned(),
            maximum_segments: MAX_STROKE_FLATTENED_SEGMENTS_PER_DRAW_V1,
        });
    };
    Ok(segments)
}

fn stroke_wang_segment_count(error_to_fourth: f32) -> Option<usize> {
    // lyon_geom uses this LUT before its square-root fallback. Repeating the
    // exact comparisons matters at a rounded i^4 boundary: sqrt(sqrt(x)) can
    // round back to i even when Lyon advances to i + 1.
    const FOURTH_POWERS: [f32; 24] = [
        1.0, 16.0, 81.0, 256.0, 625.0, 1_296.0, 2_401.0, 4_096.0, 6_561.0, 10_000.0, 14_641.0,
        20_736.0, 28_561.0, 38_416.0, 50_625.0, 65_536.0, 83_521.0, 104_976.0, 130_321.0,
        160_000.0, 194_481.0, 234_256.0, 279_841.0, 331_776.0,
    ];
    if !error_to_fourth.is_finite() {
        return None;
    }
    if let Some(index) = FOURTH_POWERS
        .iter()
        .position(|maximum| error_to_fourth <= *maximum)
    {
        return Some(index + 1);
    }
    let segments = error_to_fourth.sqrt().sqrt().ceil().max(1.0);
    if !segments.is_finite() || segments > 32_768.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(segments as usize)
}

fn validate_round_stroke_complexity(
    options: &StrokeOptions,
    draw_id: &str,
) -> Result<(), PrepareFrameErrorV1> {
    let round_cap =
        matches!(options.start_cap, LineCap::Round) || matches!(options.end_cap, LineCap::Round);
    let round_join = matches!(options.line_join, LineJoin::Round);
    if !round_cap && !round_join {
        return Ok(());
    }

    let radius = options.line_width * 0.5;
    let tolerance = options.tolerance.min(radius);
    let step = 2.0 * ((radius - tolerance) / radius).acos();
    let maximum_angle = if round_join {
        std::f32::consts::TAU
    } else {
        std::f32::consts::PI
    };
    let segments = (maximum_angle / step).ceil();
    let recursion_depth = segments.log2().round();
    if !step.is_finite() || step <= 0.0 || !recursion_depth.is_finite() || recursion_depth > 15.0 {
        return Err(PrepareFrameErrorV1::StrokeArcComplexityLimit {
            draw_id: draw_id.to_owned(),
            maximum_depth: MAX_STROKE_ARC_RECURSION_DEPTH_V1,
        });
    }
    Ok(())
}

fn prepare_stroke_path_input(
    path: &poietra_scene_ir::CubicPathV1,
    transform: &AffineTransformV1,
    stroke: &StrokeStyleV1,
    options: &StrokeOptions,
    pixels_per_world: f64,
    context: GeometryContextV1<'_>,
) -> Result<Vec<PreparedStrokeSubpathV1>, PrepareFrameErrorV1> {
    let maximum_ulp_pixels = maximum_stroke_input_ulp(stroke);
    let mut input_points = HashMap::new();
    let mut flattened_segments = 0usize;
    let mut prepared_subpaths = Vec::with_capacity(path.subpaths.len());

    for subpath in &path.subpaths {
        let start_world = transform_to_world(&subpath.start, transform, context.draw_id)?;
        let start = stroke_input_point(
            start_world,
            context,
            pixels_per_world,
            maximum_ulp_pixels,
            &mut input_points,
        )?;
        let mut prepared_segments = Vec::with_capacity(subpath.segments.len());
        let mut local_start = &subpath.start;
        let mut prepared_start = start;
        for segment in &subpath.segments {
            let curve = world_curve(local_start, segment, transform, context.draw_id)?;
            if same_point(curve.start, curve.control1)
                && same_point(curve.start, curve.control2)
                && same_point(curve.start, curve.end)
            {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: context.draw_id.to_owned(),
                    reason: UnsupportedDrawReasonV1::DegenerateStroke,
                });
            }
            let prepared_curve = PreparedStrokeCubicV1 {
                control1: stroke_input_point(
                    curve.control1,
                    context,
                    pixels_per_world,
                    maximum_ulp_pixels,
                    &mut input_points,
                )?,
                control2: stroke_input_point(
                    curve.control2,
                    context,
                    pixels_per_world,
                    maximum_ulp_pixels,
                    &mut input_points,
                )?,
                end: stroke_input_point(
                    curve.end,
                    context,
                    pixels_per_world,
                    maximum_ulp_pixels,
                    &mut input_points,
                )?,
            };
            let curve_segments = stroke_cubic_flattened_segments(
                prepared_start,
                prepared_curve,
                options.tolerance,
                context.draw_id,
            )?;
            flattened_segments =
                flattened_segments
                    .checked_add(curve_segments)
                    .ok_or_else(|| PrepareFrameErrorV1::StrokeFlatteningLimit {
                        draw_id: context.draw_id.to_owned(),
                        maximum_segments: MAX_STROKE_FLATTENED_SEGMENTS_PER_DRAW_V1,
                    })?;
            if flattened_segments > MAX_STROKE_FLATTENED_SEGMENTS_PER_DRAW_V1 {
                return Err(PrepareFrameErrorV1::StrokeFlatteningLimit {
                    draw_id: context.draw_id.to_owned(),
                    maximum_segments: MAX_STROKE_FLATTENED_SEGMENTS_PER_DRAW_V1,
                });
            }
            prepared_start = prepared_curve.end;
            prepared_segments.push(prepared_curve);
            local_start = &segment.end;
        }
        prepared_subpaths.push(PreparedStrokeSubpathV1 {
            closed: subpath.closed,
            segments: prepared_segments,
            start,
        });
    }
    Ok(prepared_subpaths)
}

fn stroke_tessellation_error(
    error: &TessellationError,
    draw_id: &str,
    maximum_vertices: usize,
) -> PrepareFrameErrorV1 {
    if matches!(
        error,
        TessellationError::GeometryBuilder(GeometryBuilderError::TooManyVertices)
    ) {
        PrepareFrameErrorV1::TessellationVertexLimit {
            draw_id: draw_id.to_owned(),
            maximum_vertices,
        }
    } else {
        PrepareFrameErrorV1::StrokeTessellation {
            draw_id: draw_id.to_owned(),
            reason: error.to_string(),
        }
    }
}

fn tessellate_stroke_path(
    path: &[PreparedStrokeSubpathV1],
    options: &StrokeOptions,
    maximum_output_vertices: usize,
    reported_output_limit: usize,
    draw_id: &str,
) -> Result<BoundedGeometryV1, PrepareFrameErrorV1> {
    let mut output = BoundedGeometryV1::new(maximum_output_vertices);
    let mut tessellator = StrokeTessellator::new();
    let mut builder = tessellator.builder(options, &mut output);
    for subpath in path {
        builder.begin(subpath.start);
        for curve in &subpath.segments {
            builder.cubic_bezier_to(curve.control1, curve.control2, curve.end);
        }
        builder.end(subpath.closed);
    }
    builder
        .build()
        .map_err(|error| stroke_tessellation_error(&error, draw_id, reported_output_limit))?;
    Ok(output)
}

fn append_stroke_output(
    output: BoundedGeometryV1,
    vertices: &mut Vec<PreparedGeometryVertexV1>,
    indices: &mut Vec<u32>,
    camera: &RenderCameraV1,
    pixels_per_world: f64,
    viewport: &ViewportV1,
    draw_id: &str,
) -> Result<(), PrepareFrameErrorV1> {
    let prepared_vertices = output
        .vertices
        .into_iter()
        .map(|point| {
            Ok(PreparedGeometryVertexV1 {
                position: stroke_output_position(
                    point,
                    camera,
                    pixels_per_world,
                    viewport,
                    draw_id,
                )?,
            })
        })
        .collect::<Result<Vec<_>, PrepareFrameErrorV1>>()?;
    let base_vertex = u32::try_from(vertices.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
    let prepared_indices = output
        .indices
        .into_iter()
        .map(|index| {
            base_vertex
                .checked_add(index)
                .ok_or(PrepareFrameErrorV1::IndexRange)
        })
        .collect::<Result<Vec<_>, PrepareFrameErrorV1>>()?;
    vertices.extend(prepared_vertices);
    indices.extend(prepared_indices);
    Ok(())
}

fn prepare_stroke_geometry(
    vertices: &mut Vec<PreparedGeometryVertexV1>,
    indices: &mut Vec<u32>,
    path: &poietra_scene_ir::CubicPathV1,
    transform: &AffineTransformV1,
    stroke: &StrokeStyleV1,
    context: GeometryContextV1<'_>,
) -> Result<(), PrepareFrameErrorV1> {
    validate_stroke_source_limits(path, context.draw_id)?;
    let (maximum_output_vertices, reported_output_limit) =
        stroke_output_limits(vertices.len(), context.draw_id)?;
    let pixels_per_world =
        stroke_pixels_per_world(context.camera, context.viewport, context.draw_id)?;
    let options = stroke_options(stroke, pixels_per_world, context)?;
    validate_round_stroke_complexity(&options, context.draw_id)?;
    let prepared_path =
        prepare_stroke_path_input(path, transform, stroke, &options, pixels_per_world, context)?;
    let output = tessellate_stroke_path(
        &prepared_path,
        &options,
        maximum_output_vertices,
        reported_output_limit,
        context.draw_id,
    )?;
    validate_geometry_output(
        &output,
        context.draw_id,
        UnsupportedDrawReasonV1::DegenerateStroke,
        GeometryPhaseV1::Stroke,
    )?;
    append_stroke_output(
        output,
        vertices,
        indices,
        context.camera,
        pixels_per_world,
        context.viewport,
        context.draw_id,
    )
}

fn validate_fill_source_limits(
    path: &poietra_scene_ir::CubicPathV1,
    draw_id: &str,
) -> Result<(), PrepareFrameErrorV1> {
    let mut source_cubics = 0usize;
    for subpath in &path.subpaths {
        if !subpath.closed {
            return Err(PrepareFrameErrorV1::Unsupported {
                draw_id: draw_id.to_owned(),
                reason: UnsupportedDrawReasonV1::OpenSubpath,
            });
        }
        source_cubics = source_cubics.saturating_add(subpath.segments.len());
        if source_cubics > MAX_FILL_SOURCE_CUBICS_PER_DRAW_V1 {
            return Err(PrepareFrameErrorV1::FillSourceCubicLimit {
                draw_id: draw_id.to_owned(),
                maximum_cubics: MAX_FILL_SOURCE_CUBICS_PER_DRAW_V1,
            });
        }
    }
    Ok(())
}

fn fill_output_limits(
    prepared_vertices: usize,
    draw_id: &str,
) -> Result<(usize, usize), PrepareFrameErrorV1> {
    geometry_output_limits(
        prepared_vertices,
        MAX_FILL_OUTPUT_VERTICES_PER_DRAW_V1,
        draw_id,
    )
}

fn stroke_output_limits(
    prepared_vertices: usize,
    draw_id: &str,
) -> Result<(usize, usize), PrepareFrameErrorV1> {
    geometry_output_limits(
        prepared_vertices,
        MAX_STROKE_OUTPUT_VERTICES_PER_DRAW_V1,
        draw_id,
    )
}

fn geometry_output_limits(
    prepared_vertices: usize,
    per_draw_limit: usize,
    draw_id: &str,
) -> Result<(usize, usize), PrepareFrameErrorV1> {
    let Some(remaining_vertices) = MAX_PREPARED_VERTICES_V1.checked_sub(prepared_vertices) else {
        return Err(PrepareFrameErrorV1::TessellationVertexLimit {
            draw_id: draw_id.to_owned(),
            maximum_vertices: MAX_PREPARED_VERTICES_V1,
        });
    };
    if remaining_vertices < 3 {
        return Err(PrepareFrameErrorV1::TessellationVertexLimit {
            draw_id: draw_id.to_owned(),
            maximum_vertices: MAX_PREPARED_VERTICES_V1,
        });
    }
    let maximum_output_vertices = remaining_vertices.min(per_draw_limit);
    let reported_output_limit = if remaining_vertices < per_draw_limit {
        MAX_PREPARED_VERTICES_V1
    } else {
        per_draw_limit
    };
    Ok((maximum_output_vertices, reported_output_limit))
}

fn prepare_fill_geometry(
    vertices: &mut Vec<PreparedGeometryVertexV1>,
    indices: &mut Vec<u32>,
    path: &poietra_scene_ir::CubicPathV1,
    transform: &AffineTransformV1,
    fill_rule: FillRuleV1,
    context: GeometryContextV1<'_>,
) -> Result<(), PrepareFrameErrorV1> {
    let draw_id = context.draw_id;
    validate_fill_source_limits(path, draw_id)?;
    let (maximum_output_vertices, reported_output_limit) =
        fill_output_limits(vertices.len(), draw_id)?;
    let mut flattened_vertices = 0usize;
    let mut upload_points = HashMap::new();
    let lyon_fill_rule = match fill_rule {
        FillRuleV1::EvenOdd => lyon_tessellation::FillRule::EvenOdd,
        FillRuleV1::NonZero => lyon_tessellation::FillRule::NonZero,
    };
    // Cubics have already been flattened in f64 world space. The smallest
    // positive tolerance keeps Lyon from adding another visible approximation
    // while retaining its intersection-safe fill sweep.
    let options = FillOptions::default()
        .with_fill_rule(lyon_fill_rule)
        .with_tolerance(f32::EPSILON);
    let mut output = BoundedGeometryV1::new(maximum_output_vertices);
    let mut tessellator = FillTessellator::new();
    let mut builder = tessellator.builder(&options, &mut output);
    for subpath in &path.subpaths {
        let available_for_subpath = MAX_FILL_FLATTENED_POINTS_PER_DRAW_V1
            .checked_sub(flattened_vertices)
            .ok_or_else(|| PrepareFrameErrorV1::TessellationVertexLimit {
                draw_id: draw_id.to_owned(),
                maximum_vertices: MAX_FILL_FLATTENED_POINTS_PER_DRAW_V1,
            })?;
        let world_points = flatten_subpath_world(
            subpath,
            transform,
            context.camera,
            context.viewport,
            draw_id,
            available_for_subpath,
            MAX_FILL_FLATTENED_POINTS_PER_DRAW_V1,
        )?;
        flattened_vertices = flattened_vertices
            .checked_add(world_points.len())
            .ok_or_else(|| PrepareFrameErrorV1::TessellationVertexLimit {
                draw_id: draw_id.to_owned(),
                maximum_vertices: MAX_FILL_FLATTENED_POINTS_PER_DRAW_V1,
            })?;
        let mut topology = FillContourTopologyV1::default();
        for world_point in world_points {
            let (fill_point, clip_point) =
                world_to_fill_point(world_point, context.camera, context.viewport, draw_id)?;
            let fill_key = fill_point_key(fill_point);
            if upload_points
                .insert(fill_key, point_key(clip_point))
                .is_some_and(|previous| previous != point_key(clip_point))
            {
                return Err(PrepareFrameErrorV1::FillPrecisionLoss {
                    draw_id: draw_id.to_owned(),
                    maximum_error_pixels: FLATTEN_TOLERANCE_PIXELS_V1,
                });
            }
            if topology.observe(fill_point) {
                builder.begin(fill_point);
            } else {
                builder.line_to(fill_point);
            }
        }
        if topology.is_degenerate() {
            return Err(PrepareFrameErrorV1::Unsupported {
                draw_id: draw_id.to_owned(),
                reason: UnsupportedDrawReasonV1::DegenerateFill,
            });
        }
        builder.end(true);
    }
    builder
        .build()
        .map_err(|error| fill_tessellation_error(&error, draw_id, reported_output_limit))?;
    validate_geometry_output(
        &output,
        draw_id,
        UnsupportedDrawReasonV1::DegenerateFill,
        GeometryPhaseV1::Fill,
    )?;

    let base_vertex = u32::try_from(vertices.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
    for point in output.vertices {
        vertices.push(PreparedGeometryVertexV1 {
            position: [point.x, point.y],
        });
    }
    for index in output.indices {
        indices.push(
            base_vertex
                .checked_add(index)
                .ok_or(PrepareFrameErrorV1::IndexRange)?,
        );
    }
    Ok(())
}

struct PreparedFrameAccumulatorV1 {
    draws: Vec<PreparedDrawV1>,
    indices: Vec<u32>,
    materials: Vec<PreparedMaterialV1>,
    tessellation_calls: u64,
    vertices: Vec<PreparedGeometryVertexV1>,
}

impl PreparedFrameAccumulatorV1 {
    fn with_phase_capacity(phase_capacity: usize) -> Self {
        Self {
            draws: Vec::with_capacity(phase_capacity),
            indices: Vec::new(),
            materials: Vec::with_capacity(phase_capacity),
            tessellation_calls: 0,
            vertices: Vec::new(),
        }
    }

    fn append_phase(
        &mut self,
        draw_id: &str,
        entity_id: &str,
        color: &RgbaColorV1,
        opacity: f64,
        prepare_geometry: impl FnOnce(
            &mut Vec<PreparedGeometryVertexV1>,
            &mut Vec<u32>,
        ) -> Result<(), PrepareFrameErrorV1>,
    ) -> Result<(), PrepareFrameErrorV1> {
        let material = prepare_material(color, opacity, draw_id)?;
        let index_start_len = self.indices.len();
        let vertex_start_len = self.vertices.len();
        let index_start =
            u32::try_from(index_start_len).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
        let vertex_start =
            u32::try_from(vertex_start_len).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
        if let Err(error) = prepare_geometry(&mut self.vertices, &mut self.indices) {
            self.vertices.truncate(vertex_start_len);
            self.indices.truncate(index_start_len);
            return Err(error);
        }
        let material_index =
            u32::try_from(self.materials.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
        self.materials.push(material);
        let index_end =
            u32::try_from(self.indices.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
        let vertex_end =
            u32::try_from(self.vertices.len()).map_err(|_| PrepareFrameErrorV1::IndexRange)?;
        self.draws.push(PreparedDrawV1 {
            draw_id: draw_id.to_owned(),
            entity_id: entity_id.to_owned(),
            index_range: index_start..index_end,
            material_index,
            vertex_range: vertex_start..vertex_end,
        });
        self.tessellation_calls = self
            .tessellation_calls
            .checked_add(1)
            .ok_or(PrepareFrameErrorV1::IndexRange)?;
        Ok(())
    }
}

/// Tessellates a packet that [`validate_frame_packet_v1`] has already accepted.
///
/// This is the tessellation half of [`prepare_frame_v1`]. The
/// [`ValidatedRenderPacketV1`] token proves validation happened; the split
/// exists so opt-in telemetry can time the phases separately without running
/// validation twice.
///
/// # Errors
///
/// Returns a structured unsupported-feature, numeric, tessellation, or index
/// error.
pub fn tessellate_validated_frame_v1(
    validated: ValidatedRenderPacketV1<'_>,
) -> Result<PreparedFrameV1, PrepareFrameErrorV1> {
    let packet = validated.packet;
    let phase_capacity = packet.draws.len().saturating_mul(2);
    let mut prepared = PreparedFrameAccumulatorV1::with_phase_capacity(phase_capacity);
    for draw in &packet.draws {
        let (draw_id, entity_id, fill, opacity, path, stroke, transform) = match draw {
            RenderDrawV1::Empty { .. } => continue,
            RenderDrawV1::Path {
                draw_id,
                entity_id,
                fill,
                opacity,
                path,
                stroke,
                transform,
                ..
            } => (draw_id, entity_id, fill, opacity, path, stroke, transform),
            RenderDrawV1::Image { .. } => {
                return Err(PrepareFrameErrorV1::Unsupported {
                    draw_id: draw.draw_id().to_owned(),
                    reason: UnsupportedDrawReasonV1::Image,
                });
            }
        };
        if fill.is_none() && stroke.is_none() {
            return Err(PrepareFrameErrorV1::Unsupported {
                draw_id: draw_id.clone(),
                reason: UnsupportedDrawReasonV1::MissingPaint,
            });
        }
        let context = GeometryContextV1 {
            camera: &packet.camera,
            draw_id,
            viewport: &packet.viewport,
        };
        if let Some(fill) = fill {
            prepared.append_phase(
                draw_id,
                entity_id,
                &fill.color,
                *opacity,
                |vertices, indices| {
                    prepare_fill_geometry(vertices, indices, path, transform, fill.rule, context)
                },
            )?;
        }
        if let Some(stroke) = stroke {
            prepared.append_phase(
                draw_id,
                entity_id,
                &stroke.color,
                *opacity,
                |vertices, indices| {
                    prepare_stroke_geometry(vertices, indices, path, transform, stroke, context)
                },
            )?;
        }
    }

    Ok(PreparedFrameV1 {
        geometry: PreparedGeometryPlanV1 {
            indices: prepared.indices,
            tessellation_calls: prepared.tessellation_calls,
            vertices: prepared.vertices,
        },
        materials: PreparedMaterialPlanV1 {
            clear_color: prepared_clear_color(&packet.camera.clear_color)?,
            materials: prepared.materials,
        },
        ordered_draws: OrderedDrawPlanV1 {
            draws: prepared.draws,
        },
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
    fn pathological_cubic_is_rejected_by_constant_time_wang_preflight() {
        let curve = PreparedStrokeCubicV1 {
            control1: lyon_point(1.0e30, -1.0e30),
            control2: lyon_point(-1.0e30, 1.0e30),
            end: lyon_point(1.0, 0.0),
        };
        assert!(matches!(
            stroke_cubic_flattened_segments(lyon_point(0.0, 0.0), curve, 0.25, "draw:pathological",),
            Err(PrepareFrameErrorV1::StrokeFlatteningLimit {
                maximum_segments: MAX_STROKE_FLATTENED_SEGMENTS_PER_DRAW_V1,
                ..
            })
        ));
    }

    #[test]
    fn wang_preflight_matches_lyons_lookup_table_boundary() {
        let exact_tenth_boundary = 10_000.0_f32;
        let immediately_after = f32::from_bits(exact_tenth_boundary.to_bits() + 1);
        assert_eq!(stroke_wang_segment_count(exact_tenth_boundary), Some(10));
        assert_eq!(stroke_wang_segment_count(immediately_after), Some(11));
    }

    #[test]
    fn stroke_pixel_domain_uses_the_denser_viewport_axis() {
        let camera = RenderCameraV1 {
            bottom: -8.0,
            clear_color: RgbaColorV1 {
                alpha: 1.0,
                blue: 0.0,
                green: 0.0,
                red: 0.0,
            },
            kind: poietra_scene_ir::RenderCameraKindV1::Orthographic2d,
            left: -8.0,
            right: 8.0,
            top: 8.0,
        };
        let viewport = ViewportV1 {
            height_px: 90,
            width_px: 160,
        };
        let scale = stroke_pixels_per_world(&camera, &viewport, "draw:aspect").unwrap();
        assert!((scale - 10.0).abs() <= f64::EPSILON);
    }

    #[test]
    fn fill_flattening_reports_the_supplied_point_limit() {
        let start = poietra_scene_ir::PointV1 { x: 0.0, y: 0.0 };
        let middle = poietra_scene_ir::PointV1 { x: 1.0, y: 0.0 };
        let end = poietra_scene_ir::PointV1 { x: 2.0, y: 0.0 };
        let subpath = CubicSubpathV1 {
            closed: true,
            segments: vec![
                CubicSegmentV1 {
                    control1: poietra_scene_ir::PointV1 {
                        x: 1.0 / 3.0,
                        y: 0.0,
                    },
                    control2: poietra_scene_ir::PointV1 {
                        x: 2.0 / 3.0,
                        y: 0.0,
                    },
                    end: middle,
                },
                CubicSegmentV1 {
                    control1: poietra_scene_ir::PointV1 {
                        x: 4.0 / 3.0,
                        y: 0.0,
                    },
                    control2: poietra_scene_ir::PointV1 {
                        x: 5.0 / 3.0,
                        y: 0.0,
                    },
                    end,
                },
            ],
            start,
        };
        let camera = RenderCameraV1 {
            bottom: -4.5,
            clear_color: RgbaColorV1 {
                alpha: 1.0,
                blue: 0.0,
                green: 0.0,
                red: 0.0,
            },
            kind: poietra_scene_ir::RenderCameraKindV1::Orthographic2d,
            left: -8.0,
            right: 8.0,
            top: 4.5,
        };
        let viewport = ViewportV1 {
            height_px: 90,
            width_px: 160,
        };

        assert!(matches!(
            flatten_subpath_world(
                &subpath,
                &AffineTransformV1::identity(),
                &camera,
                &viewport,
                "draw:limit",
                2,
                2,
            ),
            Err(PrepareFrameErrorV1::TessellationVertexLimit {
                maximum_vertices: 2,
                ..
            })
        ));
    }

    #[test]
    fn bounded_fill_builder_aborts_without_partial_output() {
        assert_eq!(MAX_FILL_OUTPUT_VERTICES_PER_DRAW_V1, 65_536);
        let retained_vertex = lyon_point(9.0, 9.0);
        let retained_indices = [0, 0, 0];
        let mut output = BoundedGeometryV1::new(5);
        output.vertices.push(retained_vertex);
        output.indices.extend_from_slice(&retained_indices);
        output.index_limit_exceeded = true;
        let mut tessellator = FillTessellator::new();
        let options = FillOptions::even_odd().with_tolerance(f32::EPSILON);
        let mut builder = tessellator.builder(&options, &mut output);
        builder.begin(lyon_point(-1.0, -1.0));
        builder.line_to(lyon_point(1.0, 1.0));
        builder.line_to(lyon_point(-1.0, 1.0));
        builder.line_to(lyon_point(1.0, -1.0));
        builder.end(true);

        let build_error = builder
            .build()
            .expect_err("fixture must hit the output cap");
        assert!(matches!(
            &build_error,
            TessellationError::GeometryBuilder(GeometryBuilderError::TooManyVertices)
        ));
        assert!(matches!(
            fill_tessellation_error(
                &build_error,
                "draw:output-limit",
                MAX_FILL_OUTPUT_VERTICES_PER_DRAW_V1,
            ),
            PrepareFrameErrorV1::TessellationVertexLimit {
                draw_id,
                maximum_vertices: MAX_FILL_OUTPUT_VERTICES_PER_DRAW_V1,
            } if draw_id == "draw:output-limit"
        ));
        assert_eq!(output.vertices, [retained_vertex]);
        assert_eq!(output.indices, retained_indices);
        assert!(!output.index_limit_exceeded);

        output.maximum_vertices = 8;
        let mut retry = tessellator.builder(&options, &mut output);
        retry.begin(lyon_point(0.0, 0.0));
        retry.line_to(lyon_point(1.0, 0.0));
        retry.line_to(lyon_point(0.0, 1.0));
        retry.end(true);
        retry.build().expect("builder must be reusable after abort");
        assert_eq!(output.vertices.len(), 4);
        assert_eq!(output.indices.len(), 6);
    }

    #[test]
    fn bounded_stroke_builder_aborts_without_partial_output() {
        assert_eq!(MAX_STROKE_OUTPUT_VERTICES_PER_DRAW_V1, 65_536);
        let retained_vertex = lyon_point(9.0, 9.0);
        let retained_indices = [0, 0, 0];
        let mut output = BoundedGeometryV1::new(4);
        output.vertices.push(retained_vertex);
        output.indices.extend_from_slice(&retained_indices);
        output.index_limit_exceeded = true;
        let mut tessellator = StrokeTessellator::new();
        let options = StrokeOptions::default()
            .with_line_width(1.0)
            .with_line_cap(LineCap::Butt);
        let mut builder = tessellator.builder(&options, &mut output);
        builder.begin(lyon_point(-1.0, 0.0));
        builder.line_to(lyon_point(1.0, 0.0));
        builder.end(false);

        let build_error = builder
            .build()
            .expect_err("fixture must hit the stroke output cap");
        assert!(matches!(
            &build_error,
            TessellationError::GeometryBuilder(GeometryBuilderError::TooManyVertices)
        ));
        assert_eq!(output.vertices, [retained_vertex]);
        assert_eq!(output.indices, retained_indices);
        assert!(!output.index_limit_exceeded);

        output.maximum_vertices = 5;
        let mut retry = tessellator.builder(&options, &mut output);
        retry.begin(lyon_point(-1.0, 0.0));
        retry.line_to(lyon_point(1.0, 0.0));
        retry.end(false);
        retry
            .build()
            .expect("stroke builder must be reusable after abort");
        assert_eq!(output.vertices.len(), 5);
        assert_eq!(output.indices.len(), 9);
    }

    #[test]
    fn prepared_phase_rolls_back_geometry_when_tessellation_fails() {
        let mut prepared = PreparedFrameAccumulatorV1::with_phase_capacity(1);
        let error = prepared.append_phase(
            "draw:rollback",
            "entity:rollback",
            &RgbaColorV1 {
                alpha: 1.0,
                blue: 0.0,
                green: 0.0,
                red: 1.0,
            },
            1.0,
            |vertices, indices| {
                vertices.push(PreparedGeometryVertexV1 {
                    position: [0.0, 0.0],
                });
                indices.push(0);
                Err(PrepareFrameErrorV1::NumericRange {
                    context: "injected phase failure".to_owned(),
                })
            },
        );

        assert!(matches!(
            error,
            Err(PrepareFrameErrorV1::NumericRange { .. })
        ));
        assert!(prepared.vertices.is_empty());
        assert!(prepared.indices.is_empty());
        assert!(prepared.materials.is_empty());
        assert!(prepared.draws.is_empty());
        assert_eq!(prepared.tessellation_calls, 0);
    }

    #[test]
    fn phase_output_limits_preserve_one_triangle_or_report_the_global_cap() {
        assert_eq!(
            fill_output_limits(MAX_PREPARED_VERTICES_V1 - 3, "draw:limit")
                .expect("one triangle must fit"),
            (3, MAX_PREPARED_VERTICES_V1),
        );
        assert_eq!(
            stroke_output_limits(MAX_PREPARED_VERTICES_V1 - 3, "draw:limit")
                .expect("one stroke triangle must fit"),
            (3, MAX_PREPARED_VERTICES_V1),
        );
        for prepared_vertices in [
            MAX_PREPARED_VERTICES_V1 - 2,
            MAX_PREPARED_VERTICES_V1 - 1,
            MAX_PREPARED_VERTICES_V1,
            MAX_PREPARED_VERTICES_V1 + 1,
        ] {
            assert!(matches!(
                fill_output_limits(prepared_vertices, "draw:limit"),
                Err(PrepareFrameErrorV1::TessellationVertexLimit {
                    maximum_vertices: MAX_PREPARED_VERTICES_V1,
                    ..
                })
            ));
            assert!(matches!(
                stroke_output_limits(prepared_vertices, "draw:limit"),
                Err(PrepareFrameErrorV1::TessellationVertexLimit {
                    maximum_vertices: MAX_PREPARED_VERTICES_V1,
                    ..
                })
            ));
        }
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
