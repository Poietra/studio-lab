use std::str::FromStr;

use poietra_scene_ir::{
    CubicPathV1, CubicSegmentV1, CubicSubpathV1, FillRuleV1, FillStyleV1, RgbaColorV1,
    SceneAppearanceV1, StrokeCapV1, StrokeJoinV1, StrokeStyleV1, validate_cubic_path_v1,
};
use serde::Serialize;
use svgtypes::{Paint, PathParser, PathSegment, ViewBox};

use super::StudioAuthoringDimensions;

pub const MAX_STUDIO_SVG_SOURCE_BYTES: usize = 256 * 1024;
const MAX_STUDIO_SVG_SUBPATHS: usize = 128;
const MAX_STUDIO_SVG_SEGMENTS: usize = 8_192;
const NORMALIZED_SVG_LONG_EDGE: f64 = 3.0;
const SVG_NAMESPACE: &str = "http://www.w3.org/2000/svg";

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct NormalizedStudioSvgPathAsset {
    pub appearance: SceneAppearanceV1,
    pub dimensions: StudioAuthoringDimensions,
    pub path: CubicPathV1,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioSvgPathAssetInspection {
    pub dimensions: StudioAuthoringDimensions,
    pub has_fill: bool,
    pub has_stroke: bool,
    pub segment_count: usize,
    pub subpath_count: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum StudioSvgPathError {
    #[error("SVG source is empty")]
    EmptySource,
    #[error("SVG source exceeds the {MAX_STUDIO_SVG_SOURCE_BYTES}-byte limit")]
    SourceTooLarge,
    #[error("SVG XML is malformed: {0}")]
    MalformedXml(String),
    #[error("SVG processing instruction `{0}` is unsupported")]
    UnsupportedProcessingInstruction(String),
    #[error("the SVG root must be an <svg> element in the SVG namespace")]
    InvalidRoot,
    #[error("SVG root attribute `{0}` is unsupported by the path asset profile")]
    UnsupportedRootAttribute(String),
    #[error("SVG requires one finite, positive viewBox: {0}")]
    InvalidViewBox(String),
    #[error("SVG element <{0}> is unsupported; the path asset profile accepts exactly one <path>")]
    UnsupportedElement(String),
    #[error("SVG path asset profile requires exactly one <path>; found {0}")]
    ExpectedSinglePath(usize),
    #[error("SVG path attribute `{0}` is unsupported by the path asset profile")]
    UnsupportedPathAttribute(String),
    #[error("SVG path data is missing")]
    MissingPathData,
    #[error("SVG path data is malformed: {0}")]
    MalformedPath(String),
    #[error("SVG path command `{0}` is unsupported; use only M, L, Q, C, and Z")]
    UnsupportedPathCommand(char),
    #[error("SVG path commands must begin each subpath with M and may not continue after Z")]
    InvalidPathOrder,
    #[error("SVG path subpaths must contain at least one drawable segment")]
    EmptySubpath,
    #[error("SVG path exceeds the {MAX_STUDIO_SVG_SUBPATHS}-subpath limit")]
    TooManySubpaths,
    #[error("SVG path exceeds the {MAX_STUDIO_SVG_SEGMENTS}-segment limit")]
    TooManySegments,
    #[error("SVG path coordinates must be finite")]
    NonFiniteCoordinate,
    #[error("SVG `{attribute}` paint must be `none` or one solid CSS color")]
    UnsupportedPaint { attribute: &'static str },
    #[error("SVG `{attribute}` must be one finite number")]
    InvalidNumber { attribute: &'static str },
    #[error("SVG stroke-width must be non-negative and stroke-miterlimit must be at least 1")]
    InvalidStrokeGeometry,
    #[error("SVG fill-rule `{0}` is unsupported; use nonzero or evenodd")]
    UnsupportedFillRule(String),
    #[error("SVG stroke-linecap `{0}` is unsupported; use butt, round, or square")]
    UnsupportedStrokeCap(String),
    #[error("SVG stroke-linejoin `{0}` is unsupported; use miter, round, or bevel")]
    UnsupportedStrokeJoin(String),
    #[error("SVG path has neither a visible fill nor a visible stroke")]
    InvisiblePaint,
    #[error("normalized SVG geometry is outside the canonical CubicPath contract: {0}")]
    InvalidCanonicalPath(String),
}

#[derive(Clone, Copy)]
struct SourcePoint {
    x: f64,
    y: f64,
}

struct SourceSubpath {
    closed: bool,
    segments: Vec<(SourcePoint, SourcePoint, SourcePoint)>,
    start: SourcePoint,
}

fn finite_point(x: f64, y: f64) -> Result<SourcePoint, StudioSvgPathError> {
    if !x.is_finite() || !y.is_finite() {
        return Err(StudioSvgPathError::NonFiniteCoordinate);
    }
    Ok(SourcePoint { x, y })
}

fn resolved_point(
    current: SourcePoint,
    abs: bool,
    x: f64,
    y: f64,
) -> Result<SourcePoint, StudioSvgPathError> {
    finite_point(
        if abs { x } else { current.x + x },
        if abs { y } else { current.y + y },
    )
}

fn line_segment(start: SourcePoint, end: SourcePoint) -> (SourcePoint, SourcePoint, SourcePoint) {
    (
        SourcePoint {
            x: start.x + (end.x - start.x) / 3.0,
            y: start.y + (end.y - start.y) / 3.0,
        },
        SourcePoint {
            x: start.x + 2.0 * (end.x - start.x) / 3.0,
            y: start.y + 2.0 * (end.y - start.y) / 3.0,
        },
        end,
    )
}

fn push_segment(
    subpath: &mut SourceSubpath,
    segment: (SourcePoint, SourcePoint, SourcePoint),
    segment_count: &mut usize,
) -> Result<(), StudioSvgPathError> {
    *segment_count = segment_count.saturating_add(1);
    if *segment_count > MAX_STUDIO_SVG_SEGMENTS {
        return Err(StudioSvgPathError::TooManySegments);
    }
    subpath.segments.push(segment);
    Ok(())
}

fn finish_subpath(
    subpath: Option<SourceSubpath>,
    output: &mut Vec<SourceSubpath>,
) -> Result<(), StudioSvgPathError> {
    let Some(subpath) = subpath else {
        return Ok(());
    };
    if subpath.segments.is_empty() {
        return Err(StudioSvgPathError::EmptySubpath);
    }
    if output.len() >= MAX_STUDIO_SVG_SUBPATHS {
        return Err(StudioSvgPathError::TooManySubpaths);
    }
    output.push(subpath);
    Ok(())
}

#[allow(
    clippy::float_cmp,
    reason = "exact parsed endpoint equality avoids inventing a zero-length closing segment"
)]
fn parse_source_path(data: &str) -> Result<Vec<SourceSubpath>, StudioSvgPathError> {
    let mut output = Vec::new();
    let mut active: Option<SourceSubpath> = None;
    let mut current = SourcePoint { x: 0.0, y: 0.0 };
    let mut segment_count = 0usize;

    for parsed in PathParser::from(data) {
        let segment =
            parsed.map_err(|error| StudioSvgPathError::MalformedPath(error.to_string()))?;
        match segment {
            PathSegment::MoveTo { abs, x, y } => {
                finish_subpath(active.take(), &mut output)?;
                current = resolved_point(current, abs, x, y)?;
                active = Some(SourceSubpath {
                    closed: false,
                    segments: Vec::new(),
                    start: current,
                });
            }
            PathSegment::LineTo { abs, x, y } => {
                let subpath = active
                    .as_mut()
                    .ok_or(StudioSvgPathError::InvalidPathOrder)?;
                if subpath.closed {
                    return Err(StudioSvgPathError::InvalidPathOrder);
                }
                let end = resolved_point(current, abs, x, y)?;
                push_segment(subpath, line_segment(current, end), &mut segment_count)?;
                current = end;
            }
            PathSegment::Quadratic { abs, x1, y1, x, y } => {
                let subpath = active
                    .as_mut()
                    .ok_or(StudioSvgPathError::InvalidPathOrder)?;
                if subpath.closed {
                    return Err(StudioSvgPathError::InvalidPathOrder);
                }
                let control = resolved_point(current, abs, x1, y1)?;
                let end = resolved_point(current, abs, x, y)?;
                let control1 = SourcePoint {
                    x: current.x + 2.0 * (control.x - current.x) / 3.0,
                    y: current.y + 2.0 * (control.y - current.y) / 3.0,
                };
                let control2 = SourcePoint {
                    x: end.x + 2.0 * (control.x - end.x) / 3.0,
                    y: end.y + 2.0 * (control.y - end.y) / 3.0,
                };
                push_segment(subpath, (control1, control2, end), &mut segment_count)?;
                current = end;
            }
            PathSegment::CurveTo {
                abs,
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            } => {
                let subpath = active
                    .as_mut()
                    .ok_or(StudioSvgPathError::InvalidPathOrder)?;
                if subpath.closed {
                    return Err(StudioSvgPathError::InvalidPathOrder);
                }
                let control1 = resolved_point(current, abs, x1, y1)?;
                let control2 = resolved_point(current, abs, x2, y2)?;
                let end = resolved_point(current, abs, x, y)?;
                push_segment(subpath, (control1, control2, end), &mut segment_count)?;
                current = end;
            }
            PathSegment::ClosePath { .. } => {
                let subpath = active
                    .as_mut()
                    .ok_or(StudioSvgPathError::InvalidPathOrder)?;
                if subpath.closed || subpath.segments.is_empty() {
                    return Err(StudioSvgPathError::InvalidPathOrder);
                }
                if current.x != subpath.start.x || current.y != subpath.start.y {
                    push_segment(
                        subpath,
                        line_segment(current, subpath.start),
                        &mut segment_count,
                    )?;
                }
                subpath.closed = true;
                current = subpath.start;
            }
            unsupported => {
                return Err(StudioSvgPathError::UnsupportedPathCommand(char::from(
                    unsupported.command(),
                )));
            }
        }
    }
    finish_subpath(active, &mut output)?;
    if output.is_empty() {
        return Err(StudioSvgPathError::EmptySubpath);
    }
    Ok(output)
}

fn normalized_point(
    point: SourcePoint,
    view_box: ViewBox,
    scale: f64,
) -> poietra_scene_ir::PointV1 {
    poietra_scene_ir::PointV1 {
        x: (point.x - (view_box.x + view_box.w / 2.0)) * scale,
        y: -(point.y - (view_box.y + view_box.h / 2.0)) * scale,
    }
}

fn normalized_path(
    source: Vec<SourceSubpath>,
    view_box: ViewBox,
    scale: f64,
) -> Result<CubicPathV1, StudioSvgPathError> {
    let path = CubicPathV1 {
        subpaths: source
            .into_iter()
            .map(|subpath| CubicSubpathV1 {
                closed: subpath.closed,
                segments: subpath
                    .segments
                    .into_iter()
                    .map(|(control1, control2, end)| CubicSegmentV1 {
                        control1: normalized_point(control1, view_box, scale),
                        control2: normalized_point(control2, view_box, scale),
                        end: normalized_point(end, view_box, scale),
                    })
                    .collect(),
                start: normalized_point(subpath.start, view_box, scale),
            })
            .collect(),
    };
    validate_cubic_path_v1(&path)
        .map_err(|error| StudioSvgPathError::InvalidCanonicalPath(error.to_string()))?;
    Ok(path)
}

fn color(value: svgtypes::Color, opacity: f64) -> RgbaColorV1 {
    RgbaColorV1 {
        alpha: f64::from(value.alpha) / 255.0 * opacity,
        blue: f64::from(value.blue) / 255.0,
        green: f64::from(value.green) / 255.0,
        red: f64::from(value.red) / 255.0,
    }
}

fn paint(
    value: Option<&str>,
    default: Paint<'_>,
    opacity: f64,
    attribute: &'static str,
) -> Result<Option<RgbaColorV1>, StudioSvgPathError> {
    let parsed = value.map_or(Ok(default), |source| {
        Paint::from_str(source).map_err(|_| StudioSvgPathError::UnsupportedPaint { attribute })
    })?;
    match parsed {
        Paint::None => Ok(None),
        Paint::Color(value) => Ok(Some(color(value, opacity))),
        Paint::Inherit
        | Paint::CurrentColor
        | Paint::FuncIRI(..)
        | Paint::ContextFill
        | Paint::ContextStroke => Err(StudioSvgPathError::UnsupportedPaint { attribute }),
    }
}

fn number(
    node: roxmltree::Node<'_, '_>,
    attribute: &'static str,
    default: f64,
) -> Result<f64, StudioSvgPathError> {
    let value = node.attribute(attribute).map_or(Ok(default), |source| {
        source
            .parse::<f64>()
            .map_err(|_| StudioSvgPathError::InvalidNumber { attribute })
    })?;
    if !value.is_finite() {
        return Err(StudioSvgPathError::InvalidNumber { attribute });
    }
    Ok(value)
}

fn assert_attributes(
    node: roxmltree::Node<'_, '_>,
    allowed: &[&str],
    path: bool,
) -> Result<(), StudioSvgPathError> {
    for attribute in node.attributes() {
        if attribute.namespace().is_some() || !allowed.contains(&attribute.name()) {
            return if path {
                Err(StudioSvgPathError::UnsupportedPathAttribute(
                    attribute.name().to_owned(),
                ))
            } else {
                Err(StudioSvgPathError::UnsupportedRootAttribute(
                    attribute.name().to_owned(),
                ))
            };
        }
    }
    Ok(())
}

#[allow(
    clippy::too_many_lines,
    reason = "the single bounded SVG profile is kept together so accepted XML and paint syntax stay auditable"
)]
pub(crate) fn normalize_studio_svg_path_asset(
    source: &str,
) -> Result<NormalizedStudioSvgPathAsset, StudioSvgPathError> {
    if source.is_empty() {
        return Err(StudioSvgPathError::EmptySource);
    }
    if source.len() > MAX_STUDIO_SVG_SOURCE_BYTES {
        return Err(StudioSvgPathError::SourceTooLarge);
    }
    let document = roxmltree::Document::parse(source)
        .map_err(|error| StudioSvgPathError::MalformedXml(error.to_string()))?;
    if let Some(instruction) = document.descendants().find_map(|node| node.pi()) {
        return Err(StudioSvgPathError::UnsupportedProcessingInstruction(
            instruction.target.to_owned(),
        ));
    }
    let root = document.root_element();
    if root.tag_name().name() != "svg"
        || root
            .tag_name()
            .namespace()
            .is_some_and(|namespace| namespace != SVG_NAMESPACE)
    {
        return Err(StudioSvgPathError::InvalidRoot);
    }
    assert_attributes(
        root,
        &["height", "id", "version", "viewBox", "width"],
        false,
    )?;
    let view_box_source = root
        .attribute("viewBox")
        .ok_or_else(|| StudioSvgPathError::InvalidViewBox("attribute is missing".to_owned()))?;
    let view_box = ViewBox::from_str(view_box_source)
        .map_err(|error| StudioSvgPathError::InvalidViewBox(error.to_string()))?;
    if !view_box.x.is_finite()
        || !view_box.y.is_finite()
        || !view_box.w.is_finite()
        || !view_box.h.is_finite()
        || view_box.w <= 0.0
        || view_box.h <= 0.0
    {
        return Err(StudioSvgPathError::InvalidViewBox(
            "all values must be finite".to_owned(),
        ));
    }

    let elements = root
        .children()
        .filter(roxmltree::Node::is_element)
        .collect::<Vec<_>>();
    if elements.len() != 1 {
        return Err(StudioSvgPathError::ExpectedSinglePath(elements.len()));
    }
    if root
        .children()
        .any(|child| child.is_text() && child.text().is_some_and(|text| !text.trim().is_empty()))
    {
        return Err(StudioSvgPathError::UnsupportedElement(
            "root-text-content".to_owned(),
        ));
    }
    let path_node = elements[0];
    if path_node.tag_name().name() != "path"
        || path_node
            .tag_name()
            .namespace()
            .is_some_and(|namespace| namespace != SVG_NAMESPACE)
    {
        return Err(StudioSvgPathError::UnsupportedElement(
            path_node.tag_name().name().to_owned(),
        ));
    }
    if path_node
        .children()
        .any(|child| child.is_element() || child.text().is_some_and(|text| !text.trim().is_empty()))
    {
        return Err(StudioSvgPathError::UnsupportedElement(
            "nested-path-content".to_owned(),
        ));
    }
    assert_attributes(
        path_node,
        &[
            "d",
            "fill",
            "fill-opacity",
            "fill-rule",
            "id",
            "opacity",
            "stroke",
            "stroke-linecap",
            "stroke-linejoin",
            "stroke-miterlimit",
            "stroke-opacity",
            "stroke-width",
        ],
        true,
    )?;

    let source_path = parse_source_path(
        path_node
            .attribute("d")
            .ok_or(StudioSvgPathError::MissingPathData)?,
    )?;
    let scale = NORMALIZED_SVG_LONG_EDGE / view_box.w.max(view_box.h);
    let path = normalized_path(source_path, view_box, scale)?;
    let opacity = number(path_node, "opacity", 1.0)?;
    let fill_opacity = number(path_node, "fill-opacity", 1.0)?;
    let stroke_opacity = number(path_node, "stroke-opacity", 1.0)?;
    if !(0.0..=1.0).contains(&opacity)
        || !(0.0..=1.0).contains(&fill_opacity)
        || !(0.0..=1.0).contains(&stroke_opacity)
    {
        return Err(StudioSvgPathError::InvalidNumber {
            attribute: "opacity",
        });
    }
    let fill_color = paint(
        path_node.attribute("fill"),
        Paint::Color(svgtypes::Color::black()),
        fill_opacity,
        "fill",
    )?;
    let stroke_color = paint(
        path_node.attribute("stroke"),
        Paint::None,
        stroke_opacity,
        "stroke",
    )?;
    let stroke_width = number(path_node, "stroke-width", 1.0)?;
    let miter_limit = number(path_node, "stroke-miterlimit", 4.0)?;
    if stroke_width < 0.0 || miter_limit < 1.0 {
        return Err(StudioSvgPathError::InvalidStrokeGeometry);
    }
    let fill_rule = match path_node.attribute("fill-rule").unwrap_or("nonzero") {
        "nonzero" => FillRuleV1::NonZero,
        "evenodd" => FillRuleV1::EvenOdd,
        value => return Err(StudioSvgPathError::UnsupportedFillRule(value.to_owned())),
    };
    let stroke_cap = match path_node.attribute("stroke-linecap").unwrap_or("butt") {
        "butt" => StrokeCapV1::Butt,
        "round" => StrokeCapV1::Round,
        "square" => StrokeCapV1::Square,
        value => return Err(StudioSvgPathError::UnsupportedStrokeCap(value.to_owned())),
    };
    let stroke_join = match path_node.attribute("stroke-linejoin").unwrap_or("miter") {
        "miter" => StrokeJoinV1::Miter,
        "round" => StrokeJoinV1::Round,
        "bevel" => StrokeJoinV1::Bevel,
        value => return Err(StudioSvgPathError::UnsupportedStrokeJoin(value.to_owned())),
    };
    let fill = fill_color.map(|color| FillStyleV1 {
        color,
        fragment_material: None,
        rule: fill_rule,
    });
    let stroke = stroke_color.and_then(|color| {
        (stroke_width > 0.0).then_some(StrokeStyleV1 {
            cap: stroke_cap,
            color,
            join: stroke_join,
            miter_limit,
            width_world: stroke_width * scale,
        })
    });
    if fill.is_none() && stroke.is_none() {
        return Err(StudioSvgPathError::InvisiblePaint);
    }
    Ok(NormalizedStudioSvgPathAsset {
        appearance: SceneAppearanceV1::Vector {
            fill,
            opacity,
            stroke,
        },
        dimensions: StudioAuthoringDimensions {
            angles: None,
            coordinate_system: None,
            height: Some(view_box.h * scale),
            radius: None,
            sides: None,
            width: Some(view_box.w * scale),
        },
        path,
    })
}

/// Validates one bounded SVG path source and returns its Rust-owned placement metadata.
///
/// # Errors
///
/// Returns a reasoned profile error for malformed, unsupported, or over-limit input.
pub fn inspect_studio_svg_path_asset(
    source: &str,
) -> Result<StudioSvgPathAssetInspection, StudioSvgPathError> {
    let normalized = normalize_studio_svg_path_asset(source)?;
    let SceneAppearanceV1::Vector { fill, stroke, .. } = &normalized.appearance else {
        unreachable!("normalized SVG path appearance is vector-valued");
    };
    Ok(StudioSvgPathAssetInspection {
        dimensions: normalized.dimensions,
        has_fill: fill.is_some(),
        has_stroke: stroke.is_some(),
        segment_count: normalized
            .path
            .subpaths
            .iter()
            .map(|subpath| subpath.segments.len())
            .sum(),
        subpath_count: normalized.path.subpaths.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_commands_paint_and_multiple_subpaths() {
        let asset = normalize_studio_svg_path_asset(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M 0 0 L 100 0 Q 100 25 75 25 C 50 25 50 50 0 50 Z M 20 10 l 10 0 l 0 10 z" fill="#336699" fill-rule="evenodd" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="bevel"/></svg>"##,
        )
        .unwrap();

        assert_eq!(
            asset.dimensions,
            StudioAuthoringDimensions {
                angles: None,
                coordinate_system: None,
                height: Some(1.5),
                radius: None,
                sides: None,
                width: Some(3.0),
            }
        );
        assert_eq!(asset.path.subpaths.len(), 2);
        assert!(asset.path.subpaths.iter().all(|subpath| subpath.closed));
        assert_eq!(asset.path.subpaths[0].segments.len(), 4);
        assert_eq!(asset.path.subpaths[1].segments.len(), 3);
        assert!(matches!(
            asset.appearance,
            SceneAppearanceV1::Vector {
                fill: Some(FillStyleV1 { rule: FillRuleV1::EvenOdd, .. }),
                stroke: Some(StrokeStyleV1 { cap: StrokeCapV1::Round, join: StrokeJoinV1::Bevel, width_world, .. }),
                ..
            } if (width_world - 0.06).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn rejects_unsupported_svg_without_silent_fallback() {
        let cases = [
            (
                r#"<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>"#,
                "element <circle> is unsupported",
            ),
            (
                r#"<svg viewBox="0 0 10 10"><path d="M0 0 H10 Z"/></svg>"#,
                "command `H` is unsupported",
            ),
            (
                r#"<svg viewBox="0 0 10 10"><path d="M0 0 L10 0 Z" style="fill:red"/></svg>"#,
                "attribute `style` is unsupported",
            ),
            (
                r#"<svg viewBox="0 0 10 10"><path d="M0 0 L10 0 Z" fill="url(#paint)"/></svg>"#,
                "paint must be `none` or one solid CSS color",
            ),
            (
                r#"<?xml-stylesheet href="https://example.invalid/theme.css"?><svg viewBox="0 0 10 10"><path d="M0 0 L10 0 Z"/></svg>"#,
                "processing instruction `xml-stylesheet` is unsupported",
            ),
        ];
        for (source, expected) in cases {
            assert!(
                normalize_studio_svg_path_asset(source)
                    .unwrap_err()
                    .to_string()
                    .contains(expected),
                "expected {expected}"
            );
        }
    }

    #[test]
    fn rejects_malformed_and_invisible_assets() {
        assert!(matches!(
            normalize_studio_svg_path_asset("<svg>"),
            Err(StudioSvgPathError::MalformedXml(_))
        ));
        assert!(matches!(
            normalize_studio_svg_path_asset(
                r#"<svg viewBox="0 0 10 10"><path d="M0 0 L10 0" fill="none" stroke="none"/></svg>"#
            ),
            Err(StudioSvgPathError::InvisiblePaint)
        ));
        assert!(matches!(
            normalize_studio_svg_path_asset(
                r#"<svg viewBox="0 0 10 10"><path d="M0 0 L10 0"/><path d="M0 1 L10 1"/></svg>"#
            ),
            Err(StudioSvgPathError::ExpectedSinglePath(2))
        ));
        assert!(matches!(
            normalize_studio_svg_path_asset(
                r#"<svg viewBox="0 0 0 10"><path d="M0 0 L10 0"/></svg>"#
            ),
            Err(StudioSvgPathError::InvalidViewBox(_))
        ));
    }

    #[test]
    fn rejects_every_bounded_profile_limit() {
        assert!(matches!(
            normalize_studio_svg_path_asset(&" ".repeat(MAX_STUDIO_SVG_SOURCE_BYTES + 1)),
            Err(StudioSvgPathError::SourceTooLarge)
        ));

        let too_many_subpaths = format!(
            r#"<svg viewBox="0 0 10 10"><path d="{}"/></svg>"#,
            "M0 0 L1 1 ".repeat(MAX_STUDIO_SVG_SUBPATHS + 1)
        );
        assert!(matches!(
            normalize_studio_svg_path_asset(&too_many_subpaths),
            Err(StudioSvgPathError::TooManySubpaths)
        ));

        let too_many_segments = format!(
            r#"<svg viewBox="0 0 10 10"><path d="M0 0 {}"/></svg>"#,
            "L1 1 ".repeat(MAX_STUDIO_SVG_SEGMENTS + 1)
        );
        assert!(matches!(
            normalize_studio_svg_path_asset(&too_many_segments),
            Err(StudioSvgPathError::TooManySegments)
        ));
    }
}
