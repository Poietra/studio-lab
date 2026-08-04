use poietra_scene_ir::{CubicPathV1, FillRuleV1, RgbaColorV1};
use ratex_layout::{LayoutOptions, layout, to_display_list};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::digest::toolchain_digest_v1;
use crate::outline::{
    NormalizedOutlineFragmentV1, OutlineFailureV1, OutlineFragmentKindV1,
    extract_segmented_normalized_outlines_v1,
};
use crate::{
    MATHTEX_FONT_DIGEST_V1, MathTexOutlineBoundsV1, MathTexOutlineRequestV1,
    MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1, compile_mathtex_outline_v1,
};

pub const SEGMENTED_TEX_OUTLINE_REQUEST_SCHEMA_V1: &str = "poietra.segmented-tex-outline-request";
pub const SEGMENTED_TEX_OUTLINE_RESPONSE_SCHEMA_V1: &str = "poietra.segmented-tex-outline-response";
pub const SEGMENTED_TEX_OUTLINE_VERSION_V1: u32 = 1;
pub const MAX_SEGMENTED_TEX_SOURCE_BYTES_V1: usize = 256;
pub const MAX_SEGMENTED_TEX_PAINT_MATCHES_V1: usize = 4;
pub const MAX_SEGMENTED_TEX_PAINT_LITERAL_BYTES_V1: usize = 64;
pub const MAX_SEGMENTED_TEX_FRAGMENTS_V1: usize = 128;
pub const MAX_SEGMENTED_TEX_ENTITIES_V1: usize = 256;
pub const MAX_SEGMENTED_TEX_CUBIC_SEGMENTS_V1: usize = 2_048;
pub const MAX_SEGMENTED_TEX_UNSUPPORTED_MESSAGE_BYTES_V1: usize = 512;

const DEFAULT_OUTLINE_STROKE_WIDTH_V1: f64 = 2.0;
const WRITE_PHASE_BOUNDARY_V1: f64 = 0.5;
const DEFAULT_WHITE_V1: RgbaColorV1 = RgbaColorV1 {
    alpha: 1.0,
    blue: 1.0,
    green: 1.0,
    red: 1.0,
};
const SEGMENTED_CONTENT_DOMAIN_V1: &[u8] = b"poietra.segmented-tex-outline.content.v1\0";
const SEGMENTED_TOOLCHAIN_DOMAIN_V1: &[u8] = b"poietra.segmented-tex-outline.toolchain.v1\0";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SegmentedTexOutlineRequestSchemaV1 {
    #[serde(rename = "poietra.segmented-tex-outline-request")]
    SegmentedTexOutlineRequest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SegmentedTexModeV1 {
    TexText,
    #[serde(rename = "mathtex-math")]
    MathTexMath,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SegmentedTexSourceKindV1 {
    Literal,
    Dynamic,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedTexPaintMatchV1 {
    pub literal: String,
    pub paint: RgbaColorV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedTexOutlineRequestV1 {
    pub schema: SegmentedTexOutlineRequestSchemaV1,
    pub version: u32,
    pub mode: SegmentedTexModeV1,
    pub source_kind: SegmentedTexSourceKindV1,
    pub source: String,
    pub paint_matches: Vec<SegmentedTexPaintMatchV1>,
}

impl SegmentedTexOutlineRequestV1 {
    #[must_use]
    pub fn literal(
        mode: SegmentedTexModeV1,
        source: impl Into<String>,
        paint_matches: Vec<SegmentedTexPaintMatchV1>,
    ) -> Self {
        Self {
            schema: SegmentedTexOutlineRequestSchemaV1::SegmentedTexOutlineRequest,
            version: SEGMENTED_TEX_OUTLINE_VERSION_V1,
            mode,
            source_kind: SegmentedTexSourceKindV1::Literal,
            source: source.into(),
            paint_matches,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SegmentedTexOutlineFragmentKindV1 {
    Glyph,
    Rule,
    Shape,
    Path,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SegmentedTexSourceCorrelationV1 {
    ExactByteRange {
        #[serde(rename = "sourceStartByte")]
        source_start_byte: u32,
        #[serde(rename = "sourceEndByte")]
        source_end_byte: u32,
    },
    ExpressionByteRange {
        #[serde(rename = "sourceStartByte")]
        source_start_byte: u32,
        #[serde(rename = "sourceEndByte")]
        source_end_byte: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedTexPaintSpanV1 {
    pub source_start_byte: u32,
    pub source_end_byte: u32,
    pub paint: RgbaColorV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedTexOutlineFragmentV1 {
    pub id: String,
    pub order: u32,
    pub kind: SegmentedTexOutlineFragmentKindV1,
    pub source_correlation: SegmentedTexSourceCorrelationV1,
    pub path: CubicPathV1,
    pub bounds: MathTexOutlineBoundsV1,
    pub fill_rule: FillRuleV1,
    pub paint: RgbaColorV1,
    pub outline_entity_id: String,
    pub fill_entity_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedTexWritePlanV1 {
    pub fragment_lag_ratio: f64,
    pub outline_stroke_width: f64,
    pub phase_boundary: f64,
    pub representation: SegmentedTexWriteRepresentationV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SegmentedTexWriteRepresentationV1 {
    #[serde(rename = "separate-outline-and-fill-entities")]
    SeparateOutlineAndFillEntities,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedTexOutlineArtifactV1 {
    pub mode: SegmentedTexModeV1,
    pub source: String,
    pub bounds: MathTexOutlineBoundsV1,
    pub fragments: Vec<SegmentedTexOutlineFragmentV1>,
    pub paint_spans: Vec<SegmentedTexPaintSpanV1>,
    pub write_plan: SegmentedTexWritePlanV1,
    pub content_digest: String,
    pub toolchain_digest: String,
    pub font_digest: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SegmentedTexOutlineUnsupportedCodeV1 {
    InvalidRequest,
    RequestTooLarge,
    DynamicSourceUnsupported,
    SyntaxUnsupported,
    OptionUnsupported,
    PaintPartitionAmbiguous,
    SourceCorrelationUnsupported,
    FrameItemUnsupported,
    OutlineInvalid,
    OutlineLimitExceeded,
    ResponseTooLarge,
    InternalFailure,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SegmentedTexOutlineUnsupportedV1 {
    pub code: SegmentedTexOutlineUnsupportedCodeV1,
    pub message: String,
}

impl SegmentedTexOutlineUnsupportedV1 {
    fn new(code: SegmentedTexOutlineUnsupportedCodeV1, message: impl Into<String>) -> Self {
        let mut message = message.into();
        if message.len() > MAX_SEGMENTED_TEX_UNSUPPORTED_MESSAGE_BYTES_V1 {
            let mut end = MAX_SEGMENTED_TEX_UNSUPPORTED_MESSAGE_BYTES_V1;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
        }
        Self { code, message }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SegmentedTexOutlineResultV1 {
    Compiled(SegmentedTexOutlineArtifactV1),
    Unsupported(SegmentedTexOutlineUnsupportedV1),
}

impl SegmentedTexOutlineResultV1 {
    #[must_use]
    pub fn unsupported(
        code: SegmentedTexOutlineUnsupportedCodeV1,
        message: impl Into<String>,
    ) -> Self {
        Self::Unsupported(SegmentedTexOutlineUnsupportedV1::new(code, message))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedTexWriteEntityStateV1 {
    pub visible: bool,
    pub fill_opacity: f64,
    pub path_trim_end: f64,
    pub stroke_opacity: f64,
    pub stroke_width: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedTexWriteSampleV1 {
    pub fragment_id: String,
    pub outline: SegmentedTexWriteEntityStateV1,
    pub fill: SegmentedTexWriteEntityStateV1,
}

#[derive(Clone, Copy, Debug)]
struct CompileFailureV1 {
    code: SegmentedTexOutlineUnsupportedCodeV1,
    message: &'static str,
}

impl CompileFailureV1 {
    const fn new(code: SegmentedTexOutlineUnsupportedCodeV1, message: &'static str) -> Self {
        Self { code, message }
    }
}

#[must_use]
pub fn compile_segmented_tex_outline_v1(
    request: &SegmentedTexOutlineRequestV1,
) -> SegmentedTexOutlineResultV1 {
    match compile_inner(request) {
        Ok(artifact) => SegmentedTexOutlineResultV1::Compiled(artifact),
        Err(failure) => SegmentedTexOutlineResultV1::unsupported(failure.code, failure.message),
    }
}

fn compile_inner(
    request: &SegmentedTexOutlineRequestV1,
) -> Result<SegmentedTexOutlineArtifactV1, CompileFailureV1> {
    validate_request(request)?;
    let paint_spans = resolve_paint_spans(request)?;
    let expression = match request.mode {
        SegmentedTexModeV1::TexText => format!(r"\text{{{}}}", request.source),
        SegmentedTexModeV1::MathTexMath => request.source.clone(),
    };
    let aggregate = compile_aggregate(&expression)?;
    let parsed = ratex_parser::parse(&expression).map_err(|_| {
        CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::SyntaxUnsupported,
            "The segmented Tex source is not supported by the pinned layout compiler",
        )
    })?;
    let display_list = to_display_list(&layout(&parsed, &LayoutOptions::default()));
    let normalized =
        extract_segmented_normalized_outlines_v1(&display_list).map_err(map_outline_failure)?;
    if normalized.len() > MAX_SEGMENTED_TEX_FRAGMENTS_V1
        || normalized
            .len()
            .checked_mul(2)
            .is_none_or(|entity_count| entity_count > MAX_SEGMENTED_TEX_ENTITIES_V1)
    {
        return Err(CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::OutlineLimitExceeded,
            "The segmented Tex result exceeds the fragment or entity limit",
        ));
    }
    let segment_count = normalized.iter().try_fold(0usize, |total, fragment| {
        fragment
            .path
            .subpaths
            .iter()
            .try_fold(total, |subtotal, subpath| {
                subtotal.checked_add(subpath.segments.len())
            })
    });
    if !matches!(segment_count, Some(1..=MAX_SEGMENTED_TEX_CUBIC_SEGMENTS_V1)) {
        return Err(CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::OutlineLimitExceeded,
            "The segmented Tex result exceeds the cubic geometry limit",
        ));
    }
    let fragments = correlate_fragments(request, &paint_spans, normalized)?;
    let fragment_count = u32::try_from(fragments.len()).map_err(|_| request_too_large())?;
    let fragment_lag_ratio = (4.0 / f64::from(fragment_count)).min(0.2);

    Ok(SegmentedTexOutlineArtifactV1 {
        mode: request.mode,
        source: request.source.clone(),
        bounds: aggregate.bounds,
        fragments,
        paint_spans,
        write_plan: SegmentedTexWritePlanV1 {
            fragment_lag_ratio,
            outline_stroke_width: DEFAULT_OUTLINE_STROKE_WIDTH_V1,
            phase_boundary: WRITE_PHASE_BOUNDARY_V1,
            representation: SegmentedTexWriteRepresentationV1::SeparateOutlineAndFillEntities,
        },
        content_digest: content_digest(request),
        toolchain_digest: segmented_toolchain_digest(),
        font_digest: MATHTEX_FONT_DIGEST_V1.to_owned(),
    })
}

fn validate_request(request: &SegmentedTexOutlineRequestV1) -> Result<(), CompileFailureV1> {
    if request.version != SEGMENTED_TEX_OUTLINE_VERSION_V1 || request.source.is_empty() {
        return Err(CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::InvalidRequest,
            "The segmented Tex request does not match the v1 contract",
        ));
    }
    if request.source_kind == SegmentedTexSourceKindV1::Dynamic {
        return Err(CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::DynamicSourceUnsupported,
            "Dynamic Tex source cannot be correlated to deterministic fragments",
        ));
    }
    if request.source.len() > MAX_SEGMENTED_TEX_SOURCE_BYTES_V1
        || request.paint_matches.len() > MAX_SEGMENTED_TEX_PAINT_MATCHES_V1
    {
        return Err(CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::RequestTooLarge,
            "The segmented Tex request exceeds the v1 source or paint limit",
        ));
    }
    if request.source.chars().any(|character| {
        character == '\0' || (character.is_control() && !character.is_ascii_whitespace())
    }) {
        return Err(CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::SyntaxUnsupported,
            "The segmented Tex source contains unsupported transport characters",
        ));
    }
    match request.mode {
        SegmentedTexModeV1::TexText => {
            if request.source.chars().any(|character| {
                !character.is_ascii()
                    || character.is_ascii_control()
                    || matches!(
                        character,
                        '\\' | '{' | '}' | '%' | '#' | '$' | '&' | '^' | '_' | '~'
                    )
            }) {
                return Err(CompileFailureV1::new(
                    SegmentedTexOutlineUnsupportedCodeV1::SourceCorrelationUnsupported,
                    "Tex text mode accepts only source that preserves one-to-one glyph correlation",
                ));
            }
        }
        SegmentedTexModeV1::MathTexMath if !request.paint_matches.is_empty() => {
            return Err(CompileFailureV1::new(
                SegmentedTexOutlineUnsupportedCodeV1::OptionUnsupported,
                "MathTex math mode does not accept source-correlated paint matches",
            ));
        }
        SegmentedTexModeV1::MathTexMath => {}
    }
    for paint_match in &request.paint_matches {
        if paint_match.literal.is_empty()
            || paint_match.literal.len() > MAX_SEGMENTED_TEX_PAINT_LITERAL_BYTES_V1
            || !opaque_finite_paint(&paint_match.paint)
        {
            return Err(CompileFailureV1::new(
                SegmentedTexOutlineUnsupportedCodeV1::OptionUnsupported,
                "Paint matches must use one bounded literal and one finite opaque color",
            ));
        }
    }
    Ok(())
}

fn opaque_finite_paint(paint: &RgbaColorV1) -> bool {
    [paint.red, paint.green, paint.blue, paint.alpha]
        .into_iter()
        .all(|component| component.is_finite() && (0.0..=1.0).contains(&component))
        && paint.alpha.to_bits() == 1.0f64.to_bits()
}

fn resolve_paint_spans(
    request: &SegmentedTexOutlineRequestV1,
) -> Result<Vec<SegmentedTexPaintSpanV1>, CompileFailureV1> {
    let mut spans = Vec::with_capacity(request.paint_matches.len());
    for paint_match in &request.paint_matches {
        let matches = request
            .source
            .match_indices(&paint_match.literal)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(CompileFailureV1::new(
                SegmentedTexOutlineUnsupportedCodeV1::PaintPartitionAmbiguous,
                "Every paint literal must identify exactly one source byte range",
            ));
        }
        let (start, literal) = matches[0];
        let end = start + literal.len();
        if spans.iter().any(|span: &SegmentedTexPaintSpanV1| {
            start < span.source_end_byte as usize && (span.source_start_byte as usize) < end
        }) {
            return Err(CompileFailureV1::new(
                SegmentedTexOutlineUnsupportedCodeV1::PaintPartitionAmbiguous,
                "Paint literal byte ranges must not overlap",
            ));
        }
        spans.push(SegmentedTexPaintSpanV1 {
            source_start_byte: u32::try_from(start).map_err(|_| request_too_large())?,
            source_end_byte: u32::try_from(end).map_err(|_| request_too_large())?,
            paint: paint_match.paint.clone(),
        });
    }
    spans.sort_by_key(|span| (span.source_start_byte, span.source_end_byte));
    Ok(spans)
}

fn compile_aggregate(
    expression: &str,
) -> Result<crate::MathTexOutlineArtifactV1, CompileFailureV1> {
    match compile_mathtex_outline_v1(&MathTexOutlineRequestV1::new(vec![expression.to_owned()])) {
        MathTexOutlineResultV1::Compiled(artifact) => Ok(artifact),
        MathTexOutlineResultV1::Unsupported(unsupported) => Err(CompileFailureV1::new(
            map_aggregate_code(unsupported.code),
            "The segmented Tex source is outside the frozen aggregate MathTex profile",
        )),
    }
}

const fn map_aggregate_code(
    code: MathTexOutlineUnsupportedCodeV1,
) -> SegmentedTexOutlineUnsupportedCodeV1 {
    match code {
        MathTexOutlineUnsupportedCodeV1::InvalidRequest => {
            SegmentedTexOutlineUnsupportedCodeV1::InvalidRequest
        }
        MathTexOutlineUnsupportedCodeV1::RequestTooLarge => {
            SegmentedTexOutlineUnsupportedCodeV1::RequestTooLarge
        }
        MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported
        | MathTexOutlineUnsupportedCodeV1::ConversionFailed
        | MathTexOutlineUnsupportedCodeV1::LayoutFailed => {
            SegmentedTexOutlineUnsupportedCodeV1::SyntaxUnsupported
        }
        MathTexOutlineUnsupportedCodeV1::FrameItemUnsupported => {
            SegmentedTexOutlineUnsupportedCodeV1::FrameItemUnsupported
        }
        MathTexOutlineUnsupportedCodeV1::OutlineInvalid => {
            SegmentedTexOutlineUnsupportedCodeV1::OutlineInvalid
        }
        MathTexOutlineUnsupportedCodeV1::OutlineLimitExceeded => {
            SegmentedTexOutlineUnsupportedCodeV1::OutlineLimitExceeded
        }
        MathTexOutlineUnsupportedCodeV1::ResponseTooLarge => {
            SegmentedTexOutlineUnsupportedCodeV1::ResponseTooLarge
        }
        MathTexOutlineUnsupportedCodeV1::InternalFailure => {
            SegmentedTexOutlineUnsupportedCodeV1::InternalFailure
        }
    }
}

const fn map_outline_failure(failure: OutlineFailureV1) -> CompileFailureV1 {
    match failure {
        OutlineFailureV1::UnsupportedFrameItem => CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::FrameItemUnsupported,
            "The segmented Tex layout contains an unsupported frame item",
        ),
        OutlineFailureV1::Invalid => CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::OutlineInvalid,
            "The segmented Tex layout did not produce valid cubic fragments",
        ),
        OutlineFailureV1::LimitExceeded => CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::OutlineLimitExceeded,
            "The segmented Tex layout exceeds the v1 geometry limit",
        ),
    }
}

fn correlate_fragments(
    request: &SegmentedTexOutlineRequestV1,
    paint_spans: &[SegmentedTexPaintSpanV1],
    normalized: Vec<NormalizedOutlineFragmentV1>,
) -> Result<Vec<SegmentedTexOutlineFragmentV1>, CompileFailureV1> {
    let exact_ranges = if request.mode == SegmentedTexModeV1::TexText {
        let source_glyphs = request
            .source
            .char_indices()
            .filter(|(_, character)| !character.is_whitespace())
            .map(|(start, character)| (start, start + character.len_utf8(), character))
            .collect::<Vec<_>>();
        if source_glyphs.len() != normalized.len()
            || normalized
                .iter()
                .zip(&source_glyphs)
                .any(|(fragment, (_, _, character))| fragment.character != Some(*character))
        {
            return Err(CompileFailureV1::new(
                SegmentedTexOutlineUnsupportedCodeV1::SourceCorrelationUnsupported,
                "Tex text glyphs cannot be correlated one-to-one with source byte ranges",
            ));
        }
        Some(source_glyphs)
    } else {
        None
    };

    let mut fragments = Vec::with_capacity(normalized.len());
    for (order, fragment) in normalized.into_iter().enumerate() {
        let id = format!("fragment-{order:04}");
        let (source_correlation, paint) = if let Some(exact_ranges) = &exact_ranges {
            let (start, end, _) = exact_ranges[order];
            let paint = paint_spans
                .iter()
                .find(|span| {
                    span.source_start_byte as usize <= start && end <= span.source_end_byte as usize
                })
                .map_or_else(|| DEFAULT_WHITE_V1.clone(), |span| span.paint.clone());
            (
                SegmentedTexSourceCorrelationV1::ExactByteRange {
                    source_start_byte: u32::try_from(start).map_err(|_| request_too_large())?,
                    source_end_byte: u32::try_from(end).map_err(|_| request_too_large())?,
                },
                paint,
            )
        } else {
            (
                SegmentedTexSourceCorrelationV1::ExpressionByteRange {
                    source_start_byte: 0,
                    source_end_byte: u32::try_from(request.source.len())
                        .map_err(|_| request_too_large())?,
                },
                DEFAULT_WHITE_V1.clone(),
            )
        };
        fragments.push(SegmentedTexOutlineFragmentV1 {
            outline_entity_id: format!("{id}:outline"),
            fill_entity_id: format!("{id}:fill"),
            id,
            order: u32::try_from(order).map_err(|_| request_too_large())?,
            kind: map_fragment_kind(fragment.kind),
            source_correlation,
            path: fragment.path,
            bounds: fragment.bounds,
            fill_rule: FillRuleV1::NonZero,
            paint,
        });
    }
    if request.mode == SegmentedTexModeV1::TexText
        && paint_spans.iter().any(|span| {
            !fragments.iter().any(|fragment| {
                matches!(
                    fragment.source_correlation,
                    SegmentedTexSourceCorrelationV1::ExactByteRange {
                        source_start_byte,
                        source_end_byte,
                    } if span.source_start_byte <= source_start_byte
                        && source_end_byte <= span.source_end_byte
                )
            })
        })
    {
        return Err(CompileFailureV1::new(
            SegmentedTexOutlineUnsupportedCodeV1::PaintPartitionAmbiguous,
            "Every paint byte range must contain at least one correlated glyph",
        ));
    }
    Ok(fragments)
}

const fn map_fragment_kind(kind: OutlineFragmentKindV1) -> SegmentedTexOutlineFragmentKindV1 {
    match kind {
        OutlineFragmentKindV1::Glyph => SegmentedTexOutlineFragmentKindV1::Glyph,
        OutlineFragmentKindV1::Line => SegmentedTexOutlineFragmentKindV1::Rule,
        OutlineFragmentKindV1::Rect => SegmentedTexOutlineFragmentKindV1::Shape,
        OutlineFragmentKindV1::Path => SegmentedTexOutlineFragmentKindV1::Path,
    }
}

const fn request_too_large() -> CompileFailureV1 {
    CompileFailureV1::new(
        SegmentedTexOutlineUnsupportedCodeV1::RequestTooLarge,
        "The segmented Tex request exceeds the v1 integer limits",
    )
}

fn content_digest(request: &SegmentedTexOutlineRequestV1) -> String {
    let mut digest = Sha256::new();
    digest.update(SEGMENTED_CONTENT_DOMAIN_V1);
    digest.update([match request.mode {
        SegmentedTexModeV1::TexText => 0,
        SegmentedTexModeV1::MathTexMath => 1,
    }]);
    update_frame(&mut digest, request.source.as_bytes());
    digest.update(
        u64::try_from(request.paint_matches.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for paint_match in &request.paint_matches {
        update_frame(&mut digest, paint_match.literal.as_bytes());
        for component in [
            paint_match.paint.red,
            paint_match.paint.green,
            paint_match.paint.blue,
            paint_match.paint.alpha,
        ] {
            digest.update(component.to_bits().to_be_bytes());
        }
    }
    format!("{:x}", digest.finalize())
}

fn segmented_toolchain_digest() -> String {
    let mut digest = Sha256::new();
    digest.update(SEGMENTED_TOOLCHAIN_DOMAIN_V1);
    update_frame(&mut digest, toolchain_digest_v1().as_bytes());
    update_frame(
        &mut digest,
        b"display-item-order;shared-unit-height;exact-text-byte-ranges;expression-math-range;separate-write-entities",
    );
    format!("{:x}", digest.finalize())
}

fn update_frame(digest: &mut Sha256, bytes: &[u8]) {
    digest.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    digest.update(bytes);
}

#[must_use]
pub fn evaluate_segmented_tex_write_v1(
    artifact: &SegmentedTexOutlineArtifactV1,
    progress: f64,
) -> Vec<SegmentedTexWriteSampleV1> {
    if !progress.is_finite() || artifact.fragments.is_empty() {
        return Vec::new();
    }
    let progress = progress.clamp(0.0, 1.0);
    let lag = artifact.write_plan.fragment_lag_ratio;
    let trailing_fragment_count =
        u32::try_from(artifact.fragments.len().saturating_sub(1)).unwrap_or(u32::MAX);
    let full_length = f64::from(trailing_fragment_count) * lag + 1.0;
    artifact
        .fragments
        .iter()
        .map(|fragment| {
            let raw = progress * full_length - f64::from(fragment.order) * lag;
            let local = raw.clamp(0.0, 1.0);
            let started = raw >= 0.0;
            let in_outline_phase = started && local < artifact.write_plan.phase_boundary;
            let fill_progress = ((local - artifact.write_plan.phase_boundary)
                / (1.0 - artifact.write_plan.phase_boundary))
                .clamp(0.0, 1.0);
            SegmentedTexWriteSampleV1 {
                fragment_id: fragment.id.clone(),
                outline: SegmentedTexWriteEntityStateV1 {
                    visible: in_outline_phase,
                    fill_opacity: 0.0,
                    path_trim_end: if in_outline_phase {
                        (local / artifact.write_plan.phase_boundary).clamp(0.0, 1.0)
                    } else {
                        1.0
                    },
                    stroke_opacity: 1.0,
                    stroke_width: artifact.write_plan.outline_stroke_width,
                },
                fill: SegmentedTexWriteEntityStateV1 {
                    visible: started && local >= artifact.write_plan.phase_boundary,
                    fill_opacity: fill_progress,
                    path_trim_end: 1.0,
                    stroke_opacity: 1.0 - fill_progress,
                    stroke_width: artifact.write_plan.outline_stroke_width,
                },
            }
        })
        .collect()
}
