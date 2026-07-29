use poietra_scene_ir::{
    CubicPathV1, CubicSegmentV1, CubicSubpathV1, PointV1, validate_cubic_path_v1,
};
use ttf_parser::{GlyphId, OutlineBuilder};
use typst::layout::{Frame, FrameItem, Transform};
use typst::text::TextItem;
use typst::visualize::Paint;

use crate::MathTexOutlineBoundsV1;

const MAX_GLYPHS_V1: usize = 64;
const MAX_FRAME_DEPTH_V1: usize = 16;
const MAX_SUBPATHS_V1: usize = 512;
const MAX_CUBIC_SEGMENTS_V1: usize = 2_048;
const COORDINATE_QUANTUM_V1: f64 = 0.000_001;
const MIN_INK_HEIGHT_V1: f64 = 1.0e-12;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OutlineFailureV1 {
    UnsupportedFrameItem,
    Invalid,
    LimitExceeded,
}

#[derive(Clone, Copy, Debug)]
struct Affine {
    m11: f64,
    m12: f64,
    m21: f64,
    m22: f64,
    tx: f64,
    ty: f64,
}

impl Affine {
    const fn identity() -> Self {
        Self {
            m11: 1.0,
            m12: 0.0,
            m21: 0.0,
            m22: 1.0,
            tx: 0.0,
            ty: 0.0,
        }
    }

    const fn translate(tx: f64, ty: f64) -> Self {
        Self {
            tx,
            ty,
            ..Self::identity()
        }
    }

    const fn scale(x: f64, y: f64) -> Self {
        Self {
            m11: x,
            m22: y,
            ..Self::identity()
        }
    }

    fn from_typst(transform: Transform) -> Self {
        Self {
            m11: transform.sx.get(),
            m12: transform.kx.get(),
            m21: transform.ky.get(),
            m22: transform.sy.get(),
            tx: transform.tx.to_pt(),
            ty: transform.ty.to_pt(),
        }
    }

    /// Returns `self * inner`, applying `inner` before `self`.
    fn concat(self, inner: Self) -> Self {
        Self {
            m11: self.m11 * inner.m11 + self.m12 * inner.m21,
            m12: self.m11 * inner.m12 + self.m12 * inner.m22,
            m21: self.m21 * inner.m11 + self.m22 * inner.m21,
            m22: self.m21 * inner.m12 + self.m22 * inner.m22,
            tx: self.m11 * inner.tx + self.m12 * inner.ty + self.tx,
            ty: self.m21 * inner.tx + self.m22 * inner.ty + self.ty,
        }
    }

    fn point(self, x: f64, y: f64) -> PointV1 {
        PointV1 {
            x: self.m11 * x + self.m12 * y + self.tx,
            y: self.m21 * x + self.m22 * y + self.ty,
        }
    }
}

#[derive(Debug)]
struct OpenSubpath {
    start: PointV1,
    current: PointV1,
    segments: Vec<CubicSegmentV1>,
}

#[derive(Debug)]
struct GlyphOutlineBuilder {
    transform: Affine,
    subpaths: Vec<CubicSubpathV1>,
    current: Option<OpenSubpath>,
    invalid: bool,
    callback_count: usize,
    segment_count: usize,
}

impl GlyphOutlineBuilder {
    fn new(transform: Affine) -> Self {
        Self {
            transform,
            subpaths: Vec::new(),
            current: None,
            invalid: false,
            callback_count: 0,
            segment_count: 0,
        }
    }

    fn push_segment(&mut self, segment: CubicSegmentV1) {
        self.callback_count += 1;
        self.segment_count += 1;
        if self.segment_count > MAX_CUBIC_SEGMENTS_V1 {
            self.invalid = true;
            return;
        }
        let Some(current) = &mut self.current else {
            self.invalid = true;
            return;
        };
        current.current = segment.end.clone();
        current.segments.push(segment);
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
        self.callback_count += 1;
        if self.current.is_some() {
            self.invalid = true;
            return;
        }
        let start = self.transform.point(f64::from(x), f64::from(y));
        self.current = Some(OpenSubpath {
            current: start.clone(),
            start,
            segments: Vec::new(),
        });
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let Some(current) = &self.current else {
            self.invalid = true;
            return;
        };
        let start = current.current.clone();
        let end = self.transform.point(f64::from(x), f64::from(y));
        self.push_segment(CubicSegmentV1 {
            control1: lerp(&start, &end, 1.0 / 3.0),
            control2: lerp(&start, &end, 2.0 / 3.0),
            end,
        });
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let Some(current) = &self.current else {
            self.invalid = true;
            return;
        };
        let start = current.current.clone();
        let control = self.transform.point(f64::from(x1), f64::from(y1));
        let end = self.transform.point(f64::from(x), f64::from(y));
        self.push_segment(CubicSegmentV1 {
            control1: PointV1 {
                x: start.x + (2.0 / 3.0) * (control.x - start.x),
                y: start.y + (2.0 / 3.0) * (control.y - start.y),
            },
            control2: PointV1 {
                x: end.x + (2.0 / 3.0) * (control.x - end.x),
                y: end.y + (2.0 / 3.0) * (control.y - end.y),
            },
            end,
        });
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.push_segment(CubicSegmentV1 {
            control1: self.transform.point(f64::from(x1), f64::from(y1)),
            control2: self.transform.point(f64::from(x2), f64::from(y2)),
            end: self.transform.point(f64::from(x), f64::from(y)),
        });
    }

    fn close(&mut self) {
        self.callback_count += 1;
        let Some(current) = self.current.take() else {
            self.invalid = true;
            return;
        };
        if current.segments.is_empty() {
            self.invalid = true;
            return;
        }
        self.subpaths.push(CubicSubpathV1 {
            closed: true,
            segments: current.segments,
            start: current.start,
        });
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
    fn visit_frame(
        &mut self,
        frame: &Frame,
        parent: Affine,
        depth: usize,
    ) -> Result<(), OutlineFailureV1> {
        if depth > MAX_FRAME_DEPTH_V1 {
            return Err(OutlineFailureV1::LimitExceeded);
        }

        for (position, item) in frame.items() {
            let positioned =
                parent.concat(Affine::translate(position.x.to_pt(), position.y.to_pt()));
            match item {
                FrameItem::Group(group) => {
                    if group.clip.is_some() {
                        return Err(OutlineFailureV1::UnsupportedFrameItem);
                    }
                    self.visit_frame(
                        &group.frame,
                        positioned.concat(Affine::from_typst(group.transform)),
                        depth + 1,
                    )?;
                }
                FrameItem::Text(text) => self.visit_text(text, positioned)?,
                FrameItem::Tag(_) => {}
                FrameItem::Shape(_, _) | FrameItem::Image(_, _, _) | FrameItem::Link(_, _) => {
                    return Err(OutlineFailureV1::UnsupportedFrameItem);
                }
            }
        }
        Ok(())
    }

    fn visit_text(&mut self, text: &TextItem, positioned: Affine) -> Result<(), OutlineFailureV1> {
        if text.stroke.is_some() || !matches!(text.fill, Paint::Solid(_)) {
            return Err(OutlineFailureV1::UnsupportedFrameItem);
        }

        let font_scale = text.size.to_pt() / text.font.units_per_em();
        if !font_scale.is_finite() || font_scale <= 0.0 {
            return Err(OutlineFailureV1::Invalid);
        }

        let text_to_scene = positioned.concat(Affine::scale(1.0, -1.0));
        let mut cursor_x = 0.0;
        let mut cursor_y = 0.0;

        for glyph in &text.glyphs {
            self.glyph_count += 1;
            if self.glyph_count > MAX_GLYPHS_V1 {
                return Err(OutlineFailureV1::LimitExceeded);
            }

            let x_offset = glyph.x_offset.at(text.size).to_pt();
            let y_offset = glyph.y_offset.at(text.size).to_pt();
            let glyph_transform = text_to_scene
                .concat(Affine::translate(cursor_x + x_offset, cursor_y + y_offset))
                .concat(Affine::scale(font_scale, font_scale));
            let mut builder = GlyphOutlineBuilder::new(glyph_transform);
            let has_outline = text
                .font
                .ttf()
                .outline_glyph(GlyphId(glyph.id), &mut builder)
                .is_some();

            if has_outline {
                let subpaths = builder.finish()?;
                if subpaths.is_empty() {
                    return Err(OutlineFailureV1::Invalid);
                }
                let added_segments = subpaths
                    .iter()
                    .map(|subpath| subpath.segments.len())
                    .sum::<usize>();
                self.segment_count = self
                    .segment_count
                    .checked_add(added_segments)
                    .ok_or(OutlineFailureV1::LimitExceeded)?;
                if self.segment_count > MAX_CUBIC_SEGMENTS_V1
                    || self.subpaths.len() + subpaths.len() > MAX_SUBPATHS_V1
                {
                    return Err(OutlineFailureV1::LimitExceeded);
                }
                self.subpaths.extend(subpaths);
            } else if builder.callback_count > 0 {
                return Err(OutlineFailureV1::Invalid);
            }

            cursor_x += glyph.x_advance.at(text.size).to_pt();
            cursor_y += glyph.y_advance.at(text.size).to_pt();
        }
        Ok(())
    }
}

pub(crate) fn extract_normalized_outline_v1(
    frame: &Frame,
) -> Result<(CubicPathV1, MathTexOutlineBoundsV1), OutlineFailureV1> {
    let mut collector = OutlineCollector::default();
    // Typst frames use y-down coordinates. Poietra scene-local coordinates use y-up.
    collector.visit_frame(frame, Affine::scale(1.0, -1.0), 0)?;
    if collector.subpaths.is_empty() {
        return Err(OutlineFailureV1::Invalid);
    }

    let mut path = CubicPathV1 {
        subpaths: collector.subpaths,
    };
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
    Ok((path, bounds))
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
    use super::*;

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
}
