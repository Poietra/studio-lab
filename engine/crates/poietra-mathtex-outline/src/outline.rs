use kurbo::{BezPath, Cap, Join, PathEl, Shape, Stroke, StrokeOpts};
use poietra_scene_ir::{
    CubicPathV1, CubicSegmentV1, CubicSubpathV1, PointV1, validate_cubic_path_v1,
};
use ratex_font::FontId;
use ratex_types::{Color, DisplayItem, DisplayList, PathCommand};
use ttf_parser::OutlineBuilder;

use crate::fonts::katex_font_bytes;

use crate::MathTexOutlineBoundsV1;

const MAX_DISPLAY_ITEMS_V1: usize = 1_024;
const MAX_GLYPHS_V1: usize = 64;
const MAX_PATH_COMMANDS_V1: usize = 2_048;
const MAX_SUBPATHS_V1: usize = 512;
const MAX_CUBIC_SEGMENTS_V1: usize = 2_048;
const COORDINATE_QUANTUM_V1: f64 = 0.000_001;
const MIN_INK_HEIGHT_V1: f64 = 1.0e-12;
// Match the pinned RaTeX raster renderer's 1.5px stroke at its canonical
// 40px/em layout scale (the SVG default currently has the same ratio).
const PATH_STROKE_WIDTH_EM_V1: f64 = 1.5 / 40.0;
const PATH_STROKE_TOLERANCE_V1: f64 = 0.000_1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OutlineFailureV1 {
    UnsupportedFrameItem,
    Invalid,
    LimitExceeded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OutlineFragmentKindV1 {
    Glyph,
    Line,
    Rect,
    Path,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct NormalizedOutlineFragmentV1 {
    pub bounds: MathTexOutlineBoundsV1,
    pub character: Option<char>,
    pub kind: OutlineFragmentKindV1,
    pub path: CubicPathV1,
}

#[derive(Clone, Copy, Debug)]
struct Affine {
    scale_x: f64,
    scale_y: f64,
    translate_x: f64,
    translate_y: f64,
}

impl Affine {
    const fn new(scale_x: f64, scale_y: f64, translate_x: f64, translate_y: f64) -> Self {
        Self {
            scale_x,
            scale_y,
            translate_x,
            translate_y,
        }
    }

    fn point(self, x: f64, y: f64) -> PointV1 {
        PointV1 {
            x: self.translate_x + x * self.scale_x,
            y: self.translate_y + y * self.scale_y,
        }
    }
}

#[derive(Debug)]
struct OpenSubpath {
    start: PointV1,
    current: PointV1,
    segments: Vec<CubicSegmentV1>,
}

impl OpenSubpath {
    fn new(start: PointV1) -> Self {
        Self {
            current: start.clone(),
            start,
            segments: Vec::new(),
        }
    }

    fn line_to(&mut self, end: PointV1) {
        let start = self.current.clone();
        self.segments.push(CubicSegmentV1 {
            control1: lerp(&start, &end, 1.0 / 3.0),
            control2: lerp(&start, &end, 2.0 / 3.0),
            end: end.clone(),
        });
        self.current = end;
    }

    fn quad_to(&mut self, control: &PointV1, end: PointV1) {
        let start = self.current.clone();
        self.segments.push(CubicSegmentV1 {
            control1: PointV1 {
                x: start.x + (2.0 / 3.0) * (control.x - start.x),
                y: start.y + (2.0 / 3.0) * (control.y - start.y),
            },
            control2: PointV1 {
                x: end.x + (2.0 / 3.0) * (control.x - end.x),
                y: end.y + (2.0 / 3.0) * (control.y - end.y),
            },
            end: end.clone(),
        });
        self.current = end;
    }

    fn curve_to(&mut self, control1: PointV1, control2: PointV1, end: PointV1) {
        self.segments.push(CubicSegmentV1 {
            control1,
            control2,
            end: end.clone(),
        });
        self.current = end;
    }

    fn finish(self) -> Result<CubicSubpathV1, OutlineFailureV1> {
        if self.segments.is_empty() {
            return Err(OutlineFailureV1::Invalid);
        }
        Ok(CubicSubpathV1 {
            closed: true,
            segments: self.segments,
            start: self.start,
        })
    }
}

#[derive(Debug)]
struct GlyphOutlineBuilder {
    transform: Affine,
    subpaths: Vec<CubicSubpathV1>,
    current: Option<OpenSubpath>,
    invalid: bool,
    segment_count: usize,
}

impl GlyphOutlineBuilder {
    fn new(transform: Affine) -> Self {
        Self {
            transform,
            subpaths: Vec::new(),
            current: None,
            invalid: false,
            segment_count: 0,
        }
    }

    fn account_segment(&mut self) {
        self.segment_count += 1;
        if self.segment_count > MAX_CUBIC_SEGMENTS_V1 {
            self.invalid = true;
        }
    }

    fn finish(self) -> Result<Vec<CubicSubpathV1>, OutlineFailureV1> {
        if self.invalid || self.current.is_some() {
            return Err(OutlineFailureV1::Invalid);
        }
        if self.subpaths.len() > MAX_SUBPATHS_V1 || self.segment_count > MAX_CUBIC_SEGMENTS_V1 {
            return Err(OutlineFailureV1::LimitExceeded);
        }
        Ok(self.subpaths)
    }
}

impl OutlineBuilder for GlyphOutlineBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        if self.current.is_some() {
            self.invalid = true;
            return;
        }
        self.current = Some(OpenSubpath::new(
            self.transform.point(f64::from(x), f64::from(y)),
        ));
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let end = self.transform.point(f64::from(x), f64::from(y));
        let Some(current) = &mut self.current else {
            self.invalid = true;
            return;
        };
        current.line_to(end);
        self.account_segment();
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let control = self.transform.point(f64::from(x1), f64::from(y1));
        let end = self.transform.point(f64::from(x), f64::from(y));
        let Some(current) = &mut self.current else {
            self.invalid = true;
            return;
        };
        current.quad_to(&control, end);
        self.account_segment();
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let control1 = self.transform.point(f64::from(x1), f64::from(y1));
        let control2 = self.transform.point(f64::from(x2), f64::from(y2));
        let end = self.transform.point(f64::from(x), f64::from(y));
        let Some(current) = &mut self.current else {
            self.invalid = true;
            return;
        };
        current.curve_to(control1, control2, end);
        self.account_segment();
    }

    fn close(&mut self) {
        let Some(current) = self.current.take() else {
            self.invalid = true;
            return;
        };
        match current.finish() {
            Ok(subpath) => self.subpaths.push(subpath),
            Err(_) => self.invalid = true,
        }
    }
}

fn lerp(start: &PointV1, end: &PointV1, amount: f64) -> PointV1 {
    PointV1 {
        x: start.x + (end.x - start.x) * amount,
        y: start.y + (end.y - start.y) * amount,
    }
}

#[derive(Debug, Default)]
struct OutlineCollector {
    subpaths: Vec<CubicSubpathV1>,
    glyph_count: usize,
    segment_count: usize,
}

impl OutlineCollector {
    fn visit_display_list(&mut self, list: &DisplayList) -> Result<(), OutlineFailureV1> {
        if list.items.len() > MAX_DISPLAY_ITEMS_V1 {
            return Err(OutlineFailureV1::LimitExceeded);
        }
        ensure_finite(&[list.width, list.height, list.depth])?;
        if list.width < 0.0 || list.height < 0.0 || list.depth < 0.0 {
            return Err(OutlineFailureV1::Invalid);
        }

        for item in &list.items {
            self.visit_item(item)?;
        }
        Ok(())
    }

    fn visit_item(&mut self, item: &DisplayItem) -> Result<(), OutlineFailureV1> {
        match item {
            DisplayItem::GlyphPath {
                x,
                y,
                scale,
                font,
                char_code,
                color,
            } => {
                ensure_finite(&[*x, *y, *scale])?;
                if *scale <= 0.0 {
                    return Err(OutlineFailureV1::Invalid);
                }
                if !Self::accept_color(*color)? {
                    return Ok(());
                }
                self.visit_glyph(*x, *y, *scale, font, *char_code)
            }
            DisplayItem::Line {
                x,
                y,
                width,
                thickness,
                color,
                dashed,
            } => {
                ensure_nonnegative_rect(&[*x, *y], *width, *thickness)?;
                if *width == 0.0 || *thickness == 0.0 || !Self::accept_color(*color)? {
                    return Ok(());
                }
                self.visit_line(*x, *y, *width, *thickness, *dashed)
            }
            DisplayItem::Rect {
                x,
                y,
                width,
                height,
                color,
            } => {
                ensure_nonnegative_rect(&[*x, *y], *width, *height)?;
                if *width == 0.0 || *height == 0.0 || !Self::accept_color(*color)? {
                    return Ok(());
                }
                self.push_subpaths(vec![rectangle_subpath(*x, -*y, *width, *height)?])
            }
            DisplayItem::Path {
                x,
                y,
                commands,
                fill,
                color,
            } => {
                ensure_finite(&[*x, *y])?;
                if commands.len() > MAX_PATH_COMMANDS_V1 {
                    return Err(OutlineFailureV1::LimitExceeded);
                }
                if commands.is_empty() || !Self::accept_color(*color)? {
                    return Ok(());
                }
                self.visit_path(*x, *y, commands, *fill)
            }
        }
    }

    fn accept_color(color: Color) -> Result<bool, OutlineFailureV1> {
        let components = [color.r, color.g, color.b, color.a];
        if !components
            .into_iter()
            .all(|component| component.is_finite() && (0.0..=1.0).contains(&component))
        {
            return Err(OutlineFailureV1::Invalid);
        }
        if color.a == 0.0 {
            return Ok(false);
        }
        // The v1 outline ABI carries geometry but no paint. Studio applies its
        // fixed Manim-white appearance downstream, so accepting any visible
        // RaTeX color other than the parser default would silently recolor the
        // expression. Preserve truthful preview by falling back until paint is
        // represented explicitly in the ABI.
        if color != Color::BLACK {
            return Err(OutlineFailureV1::UnsupportedFrameItem);
        }
        Ok(true)
    }

    fn visit_glyph(
        &mut self,
        x: f64,
        y: f64,
        scale: f64,
        font_name: &str,
        char_code: u32,
    ) -> Result<(), OutlineFailureV1> {
        self.glyph_count += 1;
        if self.glyph_count > MAX_GLYPHS_V1 {
            return Err(OutlineFailureV1::LimitExceeded);
        }

        let font_id = FontId::parse(font_name).ok_or(OutlineFailureV1::UnsupportedFrameItem)?;
        let bytes = katex_font_bytes(font_id).ok_or(OutlineFailureV1::UnsupportedFrameItem)?;
        let face = ttf_parser::Face::parse(bytes, 0).map_err(|_| OutlineFailureV1::Invalid)?;
        let character = ratex_font::katex_ttf_glyph_char(font_id, char_code);
        let Some(glyph_id) = face.glyph_index(character) else {
            return if character.is_whitespace() {
                Ok(())
            } else {
                Err(OutlineFailureV1::UnsupportedFrameItem)
            };
        };
        let units_per_em = f64::from(face.units_per_em());
        if units_per_em <= 0.0 {
            return Err(OutlineFailureV1::Invalid);
        }
        let glyph_scale = scale / units_per_em;
        let Some(subpaths) =
            glyph_outline_subpaths(&face, glyph_id, glyph_scale, glyph_scale, x, -y)?
        else {
            return if character.is_whitespace() {
                Ok(())
            } else {
                Err(OutlineFailureV1::UnsupportedFrameItem)
            };
        };
        self.push_subpaths(subpaths)
    }

    fn visit_line(
        &mut self,
        x: f64,
        y: f64,
        width: f64,
        thickness: f64,
        dashed: bool,
    ) -> Result<(), OutlineFailureV1> {
        if !dashed {
            return self.push_subpaths(vec![rectangle_subpath(
                x,
                -y + thickness / 2.0,
                width,
                thickness,
            )?]);
        }

        // Canonicalize to the pinned RaTeX raster backend: 4t ink followed by
        // a 4t gap. Its SVG backend currently differs (3t/3t), so this choice
        // is covered by a focused regression test below.
        let dash_length = 4.0 * thickness;
        let period = 2.0 * dash_length;
        if !dash_length.is_finite() || dash_length <= 0.0 {
            return Err(OutlineFailureV1::Invalid);
        }
        let mut cursor = 0.0;
        let mut dash_subpaths = Vec::new();
        while cursor < width {
            let dash_width = dash_length.min(width - cursor);
            dash_subpaths.push(rectangle_subpath(
                x + cursor,
                -y + thickness / 2.0,
                dash_width,
                thickness,
            )?);
            if dash_subpaths.len() > MAX_SUBPATHS_V1 {
                return Err(OutlineFailureV1::LimitExceeded);
            }
            cursor += period;
        }
        self.push_subpaths(dash_subpaths)
    }

    fn visit_path(
        &mut self,
        x: f64,
        y: f64,
        commands: &[PathCommand],
        fill: bool,
    ) -> Result<(), OutlineFailureV1> {
        let transform = Affine::new(1.0, -1.0, x, -y);
        if fill {
            let mut subpaths = filled_path_subpaths(commands, transform)?;
            // RaTeX fills every MoveTo-delimited component independently. A
            // single NonZero path must give all independent components the
            // same outer winding so overlaps cannot cancel. Clockwise matches
            // the embedded TrueType outlines and rectangle primitives.
            for subpath in &mut subpaths {
                if signed_area(subpath) > 0.0 {
                    reverse_subpath(subpath);
                }
            }
            return self.push_subpaths(subpaths);
        }

        let source = path_commands_to_kurbo(commands, x, y)?;
        let style = Stroke::new(PATH_STROKE_WIDTH_EM_V1)
            .with_caps(Cap::Round)
            .with_join(Join::Round);
        let stroked = kurbo::stroke(
            source.elements().iter().copied(),
            &style,
            &StrokeOpts::default(),
            PATH_STROKE_TOLERANCE_V1,
        );
        let mut subpaths = kurbo_to_cubic_subpaths(&stroked, Affine::new(1.0, -1.0, 0.0, 0.0))?;
        orient_contour_group_clockwise(&mut subpaths);
        self.push_subpaths(subpaths)
    }

    fn push_subpaths(&mut self, subpaths: Vec<CubicSubpathV1>) -> Result<(), OutlineFailureV1> {
        let added_segments = subpaths
            .iter()
            .try_fold(0usize, |total, subpath| {
                total.checked_add(subpath.segments.len())
            })
            .ok_or(OutlineFailureV1::LimitExceeded)?;
        if self.subpaths.len() + subpaths.len() > MAX_SUBPATHS_V1
            || self.segment_count + added_segments > MAX_CUBIC_SEGMENTS_V1
        {
            return Err(OutlineFailureV1::LimitExceeded);
        }
        self.segment_count += added_segments;
        self.subpaths.extend(subpaths);
        Ok(())
    }
}

fn ensure_finite(values: &[f64]) -> Result<(), OutlineFailureV1> {
    if values.iter().copied().all(f64::is_finite) {
        Ok(())
    } else {
        Err(OutlineFailureV1::Invalid)
    }
}

fn ensure_nonnegative_rect(
    origin: &[f64; 2],
    width: f64,
    height: f64,
) -> Result<(), OutlineFailureV1> {
    ensure_finite(&[origin[0], origin[1], width, height])?;
    if width < 0.0 || height < 0.0 {
        Err(OutlineFailureV1::Invalid)
    } else {
        Ok(())
    }
}

fn rectangle_subpath(
    left: f64,
    top: f64,
    width: f64,
    height: f64,
) -> Result<CubicSubpathV1, OutlineFailureV1> {
    ensure_nonnegative_rect(&[left, top], width, height)?;
    if width == 0.0 || height == 0.0 {
        return Err(OutlineFailureV1::Invalid);
    }
    let mut open = OpenSubpath::new(PointV1 { x: left, y: top });
    open.line_to(PointV1 {
        x: left + width,
        y: top,
    });
    open.line_to(PointV1 {
        x: left + width,
        y: top - height,
    });
    open.line_to(PointV1 {
        x: left,
        y: top - height,
    });
    open.finish()
}

fn filled_path_subpaths(
    commands: &[PathCommand],
    transform: Affine,
) -> Result<Vec<CubicSubpathV1>, OutlineFailureV1> {
    let mut subpaths = Vec::new();
    let mut current: Option<OpenSubpath> = None;
    for command in commands {
        match *command {
            PathCommand::MoveTo { x, y } => {
                ensure_finite(&[x, y])?;
                if let Some(open) = current.take() {
                    subpaths.push(open.finish()?);
                }
                current = Some(OpenSubpath::new(transform.point(x, y)));
            }
            PathCommand::LineTo { x, y } => {
                ensure_finite(&[x, y])?;
                current
                    .as_mut()
                    .ok_or(OutlineFailureV1::Invalid)?
                    .line_to(transform.point(x, y));
            }
            PathCommand::QuadTo { x1, y1, x, y } => {
                ensure_finite(&[x1, y1, x, y])?;
                current
                    .as_mut()
                    .ok_or(OutlineFailureV1::Invalid)?
                    .quad_to(&transform.point(x1, y1), transform.point(x, y));
            }
            PathCommand::CubicTo {
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            } => {
                ensure_finite(&[x1, y1, x2, y2, x, y])?;
                current.as_mut().ok_or(OutlineFailureV1::Invalid)?.curve_to(
                    transform.point(x1, y1),
                    transform.point(x2, y2),
                    transform.point(x, y),
                );
            }
            PathCommand::Close => {
                let open = current.take().ok_or(OutlineFailureV1::Invalid)?;
                subpaths.push(open.finish()?);
            }
        }
    }
    if let Some(open) = current {
        // SVG fills implicitly close an unterminated final subpath.
        subpaths.push(open.finish()?);
    }
    if subpaths.is_empty() {
        return Err(OutlineFailureV1::Invalid);
    }
    Ok(subpaths)
}

fn path_commands_to_kurbo(
    commands: &[PathCommand],
    origin_x: f64,
    origin_y: f64,
) -> Result<BezPath, OutlineFailureV1> {
    let mut path = BezPath::new();
    let mut has_move = false;
    for command in commands {
        match *command {
            PathCommand::MoveTo { x, y } => {
                ensure_finite(&[x, y])?;
                path.move_to((origin_x + x, origin_y + y));
                has_move = true;
            }
            PathCommand::LineTo { x, y } => {
                ensure_finite(&[x, y])?;
                if !has_move {
                    return Err(OutlineFailureV1::Invalid);
                }
                path.line_to((origin_x + x, origin_y + y));
            }
            PathCommand::QuadTo { x1, y1, x, y } => {
                ensure_finite(&[x1, y1, x, y])?;
                if !has_move {
                    return Err(OutlineFailureV1::Invalid);
                }
                path.quad_to((origin_x + x1, origin_y + y1), (origin_x + x, origin_y + y));
            }
            PathCommand::CubicTo {
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            } => {
                ensure_finite(&[x1, y1, x2, y2, x, y])?;
                if !has_move {
                    return Err(OutlineFailureV1::Invalid);
                }
                path.curve_to(
                    (origin_x + x1, origin_y + y1),
                    (origin_x + x2, origin_y + y2),
                    (origin_x + x, origin_y + y),
                );
            }
            PathCommand::Close => {
                if !has_move {
                    return Err(OutlineFailureV1::Invalid);
                }
                path.close_path();
            }
        }
    }
    if !has_move {
        return Err(OutlineFailureV1::Invalid);
    }
    Ok(path)
}

fn kurbo_to_cubic_subpaths(
    path: &BezPath,
    transform: Affine,
) -> Result<Vec<CubicSubpathV1>, OutlineFailureV1> {
    let mut subpaths = Vec::new();
    let mut current: Option<OpenSubpath> = None;
    for element in path.elements() {
        match *element {
            PathEl::MoveTo(point) => {
                if let Some(open) = current.take() {
                    subpaths.push(open.finish()?);
                }
                current = Some(OpenSubpath::new(transform.point(point.x, point.y)));
            }
            PathEl::LineTo(point) => current
                .as_mut()
                .ok_or(OutlineFailureV1::Invalid)?
                .line_to(transform.point(point.x, point.y)),
            PathEl::QuadTo(control, end) => {
                current.as_mut().ok_or(OutlineFailureV1::Invalid)?.quad_to(
                    &transform.point(control.x, control.y),
                    transform.point(end.x, end.y),
                );
            }
            PathEl::CurveTo(control1, control2, end) => {
                current.as_mut().ok_or(OutlineFailureV1::Invalid)?.curve_to(
                    transform.point(control1.x, control1.y),
                    transform.point(control2.x, control2.y),
                    transform.point(end.x, end.y),
                );
            }
            PathEl::ClosePath => {
                let open = current.take().ok_or(OutlineFailureV1::Invalid)?;
                subpaths.push(open.finish()?);
            }
        }
    }
    if let Some(open) = current {
        subpaths.push(open.finish()?);
    }
    if subpaths.is_empty() {
        Err(OutlineFailureV1::Invalid)
    } else {
        Ok(subpaths)
    }
}

fn signed_area(subpath: &CubicSubpathV1) -> f64 {
    let mut path = BezPath::new();
    path.move_to((subpath.start.x, subpath.start.y));
    for segment in &subpath.segments {
        path.curve_to(
            (segment.control1.x, segment.control1.y),
            (segment.control2.x, segment.control2.y),
            (segment.end.x, segment.end.y),
        );
    }
    path.close_path();
    path.area()
}

fn orient_contour_group_clockwise(subpaths: &mut [CubicSubpathV1]) {
    let representative_area = subpaths
        .iter()
        .map(signed_area)
        .max_by(|left, right| left.abs().total_cmp(&right.abs()));
    if representative_area.is_some_and(|area| area > 0.0) {
        // Reverse the whole group so counter contours retain the opposite
        // winding required for glyph and stroke holes.
        for subpath in subpaths {
            reverse_subpath(subpath);
        }
    }
}

fn reverse_subpath(subpath: &mut CubicSubpathV1) {
    let previous_starts = std::iter::once(subpath.start.clone())
        .chain(
            subpath
                .segments
                .iter()
                .take(subpath.segments.len().saturating_sub(1))
                .map(|segment| segment.end.clone()),
        )
        .collect::<Vec<_>>();
    let new_start = subpath
        .segments
        .last()
        .map_or_else(|| subpath.start.clone(), |segment| segment.end.clone());
    let reversed = subpath
        .segments
        .iter()
        .zip(previous_starts)
        .rev()
        .map(|(segment, end)| CubicSegmentV1 {
            control1: segment.control2.clone(),
            control2: segment.control1.clone(),
            end,
        })
        .collect();
    subpath.start = new_start;
    subpath.segments = reversed;
}

pub(crate) fn glyph_outline_subpaths(
    face: &ttf_parser::Face<'_>,
    glyph_id: ttf_parser::GlyphId,
    scale_x: f64,
    scale_y: f64,
    translate_x: f64,
    translate_y: f64,
) -> Result<Option<Vec<CubicSubpathV1>>, OutlineFailureV1> {
    let mut builder =
        GlyphOutlineBuilder::new(Affine::new(scale_x, scale_y, translate_x, translate_y));
    if face.outline_glyph(glyph_id, &mut builder).is_none() {
        return Ok(None);
    }
    let mut subpaths = builder.finish()?;
    if subpaths.is_empty() {
        return Err(OutlineFailureV1::Invalid);
    }
    orient_contour_group_clockwise(&mut subpaths);
    Ok(Some(subpaths))
}

fn normalize_outline_subpaths_with_evidence(
    subpaths: Vec<CubicSubpathV1>,
) -> Result<(CubicPathV1, MathTexOutlineBoundsV1, f64, f64), OutlineFailureV1> {
    if subpaths.is_empty() {
        return Err(OutlineFailureV1::Invalid);
    }
    let mut path = CubicPathV1 { subpaths };
    let raw_bounds = tight_bounds(&path).ok_or(OutlineFailureV1::Invalid)?;
    let height = raw_bounds.top - raw_bounds.bottom;
    if !height.is_finite() || height <= MIN_INK_HEIGHT_V1 {
        return Err(OutlineFailureV1::Invalid);
    }
    let center_x = raw_bounds.left.midpoint(raw_bounds.right);
    let center_y = raw_bounds.bottom.midpoint(raw_bounds.top);

    for subpath in &mut path.subpaths {
        normalize_point(&mut subpath.start, center_x, center_y, height)?;
        for segment in &mut subpath.segments {
            normalize_point(&mut segment.control1, center_x, center_y, height)?;
            normalize_point(&mut segment.control2, center_x, center_y, height)?;
            normalize_point(&mut segment.end, center_x, center_y, height)?;
        }
    }

    validate_cubic_path_v1(&path).map_err(|_| OutlineFailureV1::Invalid)?;
    let bounds = quantize_bounds(tight_bounds(&path).ok_or(OutlineFailureV1::Invalid)?)?;
    if (bounds.top - bounds.bottom - 1.0).abs() > 2.0 * COORDINATE_QUANTUM_V1
        || (bounds.left + bounds.right).abs() > 2.0 * COORDINATE_QUANTUM_V1
        || (bounds.bottom + bounds.top).abs() > 2.0 * COORDINATE_QUANTUM_V1
    {
        return Err(OutlineFailureV1::Invalid);
    }
    Ok((path, bounds, center_y, height))
}

pub(crate) fn normalize_outline_subpaths(
    subpaths: Vec<CubicSubpathV1>,
) -> Result<(CubicPathV1, MathTexOutlineBoundsV1), OutlineFailureV1> {
    let (path, bounds, _) = normalize_outline_subpaths_with_raw_height(subpaths)?;
    Ok((path, bounds))
}

pub(crate) fn normalize_outline_subpaths_with_raw_height(
    subpaths: Vec<CubicSubpathV1>,
) -> Result<(CubicPathV1, MathTexOutlineBoundsV1, f64), OutlineFailureV1> {
    let (path, bounds, _, raw_height) = normalize_outline_subpaths_with_evidence(subpaths)?;
    Ok((path, bounds, raw_height))
}

fn extract_normalized_outline_evidence_v1(
    display_list: &DisplayList,
) -> Result<(CubicPathV1, MathTexOutlineBoundsV1, f64), OutlineFailureV1> {
    let mut collector = OutlineCollector::default();
    collector.visit_display_list(display_list)?;
    if collector.subpaths.is_empty() {
        return Err(OutlineFailureV1::Invalid);
    }

    let raw_baseline_y = -display_list.height;
    let (path, bounds, center_y, height) =
        normalize_outline_subpaths_with_evidence(collector.subpaths)?;
    let baseline_y = quantize((raw_baseline_y - center_y) / height)?;
    Ok((path, bounds, baseline_y))
}

pub(crate) fn extract_normalized_outline_v1(
    display_list: &DisplayList,
) -> Result<(CubicPathV1, MathTexOutlineBoundsV1), OutlineFailureV1> {
    let (path, bounds, _) = extract_normalized_outline_evidence_v1(display_list)?;
    Ok((path, bounds))
}

pub(crate) fn extract_segmented_normalized_outlines_v1(
    display_list: &DisplayList,
) -> Result<Vec<NormalizedOutlineFragmentV1>, OutlineFailureV1> {
    let mut aggregate = OutlineCollector::default();
    aggregate.visit_display_list(display_list)?;
    if aggregate.subpaths.is_empty() {
        return Err(OutlineFailureV1::Invalid);
    }
    let aggregate_path = CubicPathV1 {
        subpaths: aggregate.subpaths,
    };
    let aggregate_bounds = tight_bounds(&aggregate_path).ok_or(OutlineFailureV1::Invalid)?;
    let height = aggregate_bounds.top - aggregate_bounds.bottom;
    if !height.is_finite() || height <= MIN_INK_HEIGHT_V1 {
        return Err(OutlineFailureV1::Invalid);
    }
    let center_x = aggregate_bounds.left.midpoint(aggregate_bounds.right);
    let center_y = aggregate_bounds.bottom.midpoint(aggregate_bounds.top);

    let mut fragments = Vec::with_capacity(display_list.items.len());
    for item in &display_list.items {
        let mut collector = OutlineCollector::default();
        collector.visit_item(item)?;
        if collector.subpaths.is_empty() {
            continue;
        }
        let mut path = CubicPathV1 {
            subpaths: collector.subpaths,
        };
        for subpath in &mut path.subpaths {
            normalize_point(&mut subpath.start, center_x, center_y, height)?;
            for segment in &mut subpath.segments {
                normalize_point(&mut segment.control1, center_x, center_y, height)?;
                normalize_point(&mut segment.control2, center_x, center_y, height)?;
                normalize_point(&mut segment.end, center_x, center_y, height)?;
            }
        }
        validate_cubic_path_v1(&path).map_err(|_| OutlineFailureV1::Invalid)?;
        let bounds = quantize_bounds(tight_bounds(&path).ok_or(OutlineFailureV1::Invalid)?)?;
        let (kind, character) = match item {
            DisplayItem::GlyphPath {
                font, char_code, ..
            } => {
                let font_id = FontId::parse(font).ok_or(OutlineFailureV1::UnsupportedFrameItem)?;
                (
                    OutlineFragmentKindV1::Glyph,
                    Some(ratex_font::katex_ttf_glyph_char(font_id, *char_code)),
                )
            }
            DisplayItem::Line { .. } => (OutlineFragmentKindV1::Line, None),
            DisplayItem::Rect { .. } => (OutlineFragmentKindV1::Rect, None),
            DisplayItem::Path { .. } => (OutlineFragmentKindV1::Path, None),
        };
        fragments.push(NormalizedOutlineFragmentV1 {
            bounds,
            character,
            kind,
            path,
        });
    }
    if fragments.is_empty() {
        return Err(OutlineFailureV1::Invalid);
    }
    Ok(fragments)
}

fn quantize_bounds(
    bounds: MathTexOutlineBoundsV1,
) -> Result<MathTexOutlineBoundsV1, OutlineFailureV1> {
    Ok(MathTexOutlineBoundsV1 {
        left: quantize(bounds.left)?,
        right: quantize(bounds.right)?,
        bottom: quantize(bounds.bottom)?,
        top: quantize(bounds.top)?,
    })
}

fn normalize_point(
    point: &mut PointV1,
    center_x: f64,
    center_y: f64,
    height: f64,
) -> Result<(), OutlineFailureV1> {
    point.x = quantize((point.x - center_x) / height)?;
    point.y = quantize((point.y - center_y) / height)?;
    Ok(())
}

fn quantize(value: f64) -> Result<f64, OutlineFailureV1> {
    if !value.is_finite() {
        return Err(OutlineFailureV1::Invalid);
    }
    let quantized = (value / COORDINATE_QUANTUM_V1).round() * COORDINATE_QUANTUM_V1;
    if quantized == 0.0 {
        Ok(0.0)
    } else if quantized.is_finite() {
        Ok(quantized)
    } else {
        Err(OutlineFailureV1::Invalid)
    }
}

fn tight_bounds(path: &CubicPathV1) -> Option<MathTexOutlineBoundsV1> {
    let mut bounds = BoundsAccumulator::default();
    for subpath in &path.subpaths {
        let mut start = &subpath.start;
        bounds.include(start);
        for segment in &subpath.segments {
            bounds.include_cubic(start, segment);
            start = &segment.end;
        }
    }
    bounds.finish()
}

#[derive(Debug)]
struct BoundsAccumulator {
    left: f64,
    right: f64,
    bottom: f64,
    top: f64,
    valid: bool,
}

impl Default for BoundsAccumulator {
    fn default() -> Self {
        Self {
            left: f64::INFINITY,
            right: f64::NEG_INFINITY,
            bottom: f64::INFINITY,
            top: f64::NEG_INFINITY,
            valid: true,
        }
    }
}

impl BoundsAccumulator {
    fn include(&mut self, point: &PointV1) {
        if !point.x.is_finite() || !point.y.is_finite() {
            self.valid = false;
            return;
        }
        self.left = self.left.min(point.x);
        self.right = self.right.max(point.x);
        self.bottom = self.bottom.min(point.y);
        self.top = self.top.max(point.y);
    }

    fn include_cubic(&mut self, start: &PointV1, segment: &CubicSegmentV1) {
        self.include(start);
        self.include(&segment.end);
        for root in derivative_roots(
            start.x,
            segment.control1.x,
            segment.control2.x,
            segment.end.x,
        ) {
            self.include(&evaluate_cubic(start, segment, root));
        }
        for root in derivative_roots(
            start.y,
            segment.control1.y,
            segment.control2.y,
            segment.end.y,
        ) {
            self.include(&evaluate_cubic(start, segment, root));
        }
    }

    fn finish(self) -> Option<MathTexOutlineBoundsV1> {
        (self.valid
            && self.left.is_finite()
            && self.right.is_finite()
            && self.bottom.is_finite()
            && self.top.is_finite())
        .then_some(MathTexOutlineBoundsV1 {
            left: self.left,
            right: self.right,
            bottom: self.bottom,
            top: self.top,
        })
    }
}

fn derivative_roots(p0: f64, p1: f64, p2: f64, p3: f64) -> Vec<f64> {
    let a = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
    let b = 2.0 * (p0 - 2.0 * p1 + p2);
    let c = p1 - p0;
    let scale = p0.abs().max(p1.abs()).max(p2.abs()).max(p3.abs()).max(1.0);
    let epsilon = f64::EPSILON * scale * 32.0;
    let mut roots = Vec::with_capacity(2);

    if a.abs() <= epsilon {
        if b.abs() > epsilon {
            push_interior_root(&mut roots, -c / b);
        }
        return roots;
    }

    // Avoid target-dependent fused multiply-add behavior: native and WASM must
    // land on the same coordinate lattice for byte-identical responses.
    let discriminant = b * b - 4.0 * a * c;
    if discriminant < -epsilon {
        return roots;
    }
    let sqrt = discriminant.max(0.0).sqrt();
    push_interior_root(&mut roots, (-b + sqrt) / (2.0 * a));
    if sqrt > epsilon {
        push_interior_root(&mut roots, (-b - sqrt) / (2.0 * a));
    }
    roots
}

fn push_interior_root(roots: &mut Vec<f64>, root: f64) {
    if root.is_finite() && root > 0.0 && root < 1.0 {
        roots.push(root);
    }
}

fn evaluate_cubic(start: &PointV1, segment: &CubicSegmentV1, amount: f64) -> PointV1 {
    let inverse = 1.0 - amount;
    let start_weight = inverse * inverse * inverse;
    let control1_weight = 3.0 * inverse * inverse * amount;
    let control2_weight = 3.0 * inverse * amount * amount;
    let end_weight = amount * amount * amount;
    PointV1 {
        x: start_weight * start.x
            + control1_weight * segment.control1.x
            + control2_weight * segment.control2.x
            + end_weight * segment.end.x,
        y: start_weight * start.y
            + control1_weight * segment.control1.y
            + control2_weight * segment.control2.y
            + end_weight * segment.end.y,
    }
}

#[cfg(test)]
mod tests {
    use ratex_layout::{LayoutOptions, layout, to_display_list};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    use super::*;
    use crate::MATHTEX_FONT_DIGEST_V1;

    const MANIM_PARITY_CORPUS_JSON: &str =
        include_str!("../../../../fixtures/mathtex-manim-parity-v1/corpus.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BaselineCorpus {
        comparison: BaselineComparison,
        cases: Vec<BaselineCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BaselineComparison {
        maximum_baseline_absolute_delta: f64,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BaselineCase {
        id: String,
        tex_parts: Vec<String>,
        svg_view_box: BaselineViewBox,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BaselineViewBox {
        baseline_y: f64,
    }

    #[test]
    fn embedded_font_digest_covers_every_shipped_face_in_basename_order() {
        use crate::fonts::REACHABLE_KATEX_FONT_ASSETS_V1;

        let mut digest = Sha256::new();
        digest.update(b"poietra.mathtex-outline.fonts.v1\0");
        digest.update((REACHABLE_KATEX_FONT_ASSETS_V1.len() as u64).to_be_bytes());
        for &(_, filename, bytes) in REACHABLE_KATEX_FONT_ASSETS_V1 {
            digest.update((filename.len() as u64).to_be_bytes());
            digest.update(filename.as_bytes());
            digest.update((bytes.len() as u64).to_be_bytes());
            digest.update(bytes);
        }
        assert_eq!(format!("{:x}", digest.finalize()), MATHTEX_FONT_DIGEST_V1);
    }

    #[test]
    fn normalized_baselines_match_pinned_real_manim_references() {
        let corpus: BaselineCorpus =
            serde_json::from_str(MANIM_PARITY_CORPUS_JSON).expect("parity corpus must deserialize");
        assert!(corpus.comparison.maximum_baseline_absolute_delta >= 0.0);

        for case in corpus.cases {
            let expression = case.tex_parts.join(" ");
            let parsed = ratex_parser::parse(&expression).unwrap_or_else(|error| {
                panic!("{} must parse for baseline evidence: {error}", case.id)
            });
            let display_list = to_display_list(&layout(&parsed, &LayoutOptions::default()));
            let (_, _, baseline_y) = extract_normalized_outline_evidence_v1(&display_list)
                .unwrap_or_else(|error| {
                    panic!("{} must lower for baseline evidence: {error:?}", case.id)
                });
            let baseline_delta = (baseline_y - case.svg_view_box.baseline_y).abs();
            println!(
                "{}: RaTeX baseline={baseline_y:.6}, Manim baseline={:.6}, delta={baseline_delta:.6}",
                case.id, case.svg_view_box.baseline_y
            );
            assert!(
                baseline_delta <= corpus.comparison.maximum_baseline_absolute_delta,
                "{}: RaTeX/Manim baseline delta {baseline_delta:.6} exceeds {:.6}",
                case.id,
                corpus.comparison.maximum_baseline_absolute_delta
            );
        }
    }

    #[test]
    fn tight_bounds_include_cubic_extrema() {
        let path = CubicPathV1 {
            subpaths: vec![CubicSubpathV1 {
                closed: true,
                start: PointV1 { x: 0.0, y: 0.0 },
                segments: vec![CubicSegmentV1 {
                    control1: PointV1 { x: 0.0, y: 2.0 },
                    control2: PointV1 { x: 1.0, y: 2.0 },
                    end: PointV1 { x: 1.0, y: 0.0 },
                }],
            }],
        };
        let bounds = tight_bounds(&path).expect("finite path has bounds");
        assert!(bounds.left.abs() < f64::EPSILON);
        assert!((bounds.right - 1.0).abs() < f64::EPSILON);
        assert!((bounds.top - 1.5).abs() < 1.0e-12);
        assert!(bounds.bottom.abs() < f64::EPSILON);
    }

    #[test]
    fn filled_path_components_are_oriented_for_union_semantics() {
        let commands = [
            PathCommand::MoveTo { x: 0.0, y: 0.0 },
            PathCommand::LineTo { x: 1.0, y: 0.0 },
            PathCommand::LineTo { x: 1.0, y: 1.0 },
            PathCommand::Close,
            PathCommand::MoveTo { x: 0.0, y: 0.0 },
            PathCommand::LineTo { x: 1.0, y: 1.0 },
            PathCommand::LineTo { x: 0.0, y: 1.0 },
            PathCommand::Close,
        ];
        let mut subpaths = filled_path_subpaths(&commands, Affine::new(1.0, -1.0, 0.0, 0.0))
            .expect("valid components");
        for subpath in &mut subpaths {
            if signed_area(subpath) > 0.0 {
                reverse_subpath(subpath);
            }
        }
        assert_eq!(subpaths.len(), 2);
        assert!(subpaths.iter().all(|subpath| signed_area(subpath) < 0.0));
    }

    #[test]
    fn all_display_item_kinds_lower_to_closed_cubics() {
        let list = DisplayList {
            items: vec![
                DisplayItem::GlyphPath {
                    x: 0.0,
                    y: 1.0,
                    scale: 1.0,
                    font: "Main-Regular".to_owned(),
                    char_code: u32::from('x'),
                    color: Color::BLACK,
                },
                DisplayItem::Line {
                    x: 1.0,
                    y: 0.5,
                    width: 1.0,
                    thickness: 0.05,
                    color: Color::BLACK,
                    dashed: true,
                },
                DisplayItem::Rect {
                    x: 2.0,
                    y: 0.0,
                    width: 0.5,
                    height: 0.5,
                    color: Color::BLACK,
                },
                DisplayItem::Path {
                    x: 3.0,
                    y: 0.0,
                    commands: vec![
                        PathCommand::MoveTo { x: 0.0, y: 0.0 },
                        PathCommand::CubicTo {
                            x1: 0.2,
                            y1: 0.6,
                            x2: 0.8,
                            y2: 0.6,
                            x: 1.0,
                            y: 0.0,
                        },
                    ],
                    fill: false,
                    color: Color::BLACK,
                },
            ],
            width: 4.0,
            height: 1.0,
            depth: 0.0,
        };
        let (path, _) = extract_normalized_outline_v1(&list).expect("all items lower");
        assert!(!path.subpaths.is_empty());
        assert!(path.subpaths.iter().all(|subpath| subpath.closed));
    }

    #[test]
    fn dashed_lines_follow_the_canonical_raster_four_thickness_pattern() {
        let mut collector = OutlineCollector::default();
        collector
            .visit_line(0.0, 0.0, 1.0, 0.1, true)
            .expect("bounded dashed line");
        assert_eq!(collector.subpaths.len(), 2);

        let first = tight_bounds(&CubicPathV1 {
            subpaths: vec![collector.subpaths[0].clone()],
        })
        .expect("first dash bounds");
        let second = tight_bounds(&CubicPathV1 {
            subpaths: vec![collector.subpaths[1].clone()],
        })
        .expect("second dash bounds");
        assert!((first.left - 0.0).abs() < f64::EPSILON);
        assert!((first.right - 0.4).abs() < 1.0e-12);
        assert!((second.left - 0.8).abs() < 1.0e-12);
        assert!((second.right - 1.0).abs() < 1.0e-12);
    }

    #[test]
    fn non_default_visible_colors_fail_closed() {
        for items in [
            vec![DisplayItem::Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
                color: Color::rgb(1.0, 0.0, 0.0),
            }],
            vec![
                DisplayItem::Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                    color: Color::BLACK,
                },
                DisplayItem::Rect {
                    x: 1.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                    color: Color::WHITE,
                },
            ],
        ] {
            let list = DisplayList {
                items,
                width: 2.0,
                height: 1.0,
                depth: 0.0,
            };
            assert_eq!(
                extract_normalized_outline_v1(&list),
                Err(OutlineFailureV1::UnsupportedFrameItem)
            );
        }
    }
}
