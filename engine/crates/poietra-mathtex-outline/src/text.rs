use poietra_scene_ir::{CubicPathV1, CubicSubpathV1, FillRuleV1};
use serde::{Deserialize, Serialize};
use ttf_parser::{Face, GlyphId};

use crate::MathTexOutlineBoundsV1;
use crate::outline::{OutlineFailureV1, glyph_outline_subpaths, normalize_outline_subpaths};

/// Exact request schema literal accepted by the plain-text compiler.
pub const TEXT_OUTLINE_REQUEST_SCHEMA_V1: &str = "poietra.text-outline-request";
/// Exact response schema literal emitted by the WASM boundary.
pub const TEXT_OUTLINE_RESPONSE_SCHEMA_V1: &str = "poietra.text-outline-response";
/// Contract version shared by the core and WASM wrapper.
pub const TEXT_OUTLINE_VERSION_V1: u32 = 1;
/// Maximum number of Unicode scalar values accepted after CRLF normalization.
pub const MAX_TEXT_CHARACTERS_V1: usize = 256;
/// Maximum number of lines accepted by the plain-text compiler.
pub const MAX_TEXT_LINES_V1: usize = 8;
/// Maximum number of Unicode scalar values accepted on one line.
pub const MAX_TEXT_LINE_CHARACTERS_V1: usize = 128;
/// Maximum number of cubic segments emitted for one text artifact.
pub const MAX_TEXT_CUBIC_SEGMENTS_V1: usize = 2_048;

const DEJAVU_SANS_REGULAR: &[u8] = include_bytes!("../assets/DejaVuSans.ttf");
const NOTO_SANS_CJK_JP_REGULAR_JOYO: &[u8] =
    include_bytes!("../assets/NotoSansCJKjp-Regular-Joyo.otf");
const TEXT_LINE_ADVANCE_EM: f64 = 1.2;

/// Literal request schema represented as a closed serde enum.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TextOutlineRequestSchemaV1 {
    #[serde(rename = "poietra.text-outline-request")]
    TextOutlineRequest,
}

/// One bounded plain-text outline request.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextOutlineRequestV1 {
    pub schema: TextOutlineRequestSchemaV1,
    pub version: u32,
    pub text: String,
}

impl TextOutlineRequestV1 {
    /// Creates a correctly versioned plain-text request.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            schema: TextOutlineRequestSchemaV1::TextOutlineRequest,
            version: TEXT_OUTLINE_VERSION_V1,
            text: text.into(),
        }
    }
}

/// Canonical centered unit-height ink bounds for a compiled text outline.
pub type TextOutlineBoundsV1 = MathTexOutlineBoundsV1;

/// Renderer-native output for one supported plain-text block.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextOutlineArtifactV1 {
    pub path: CubicPathV1,
    pub bounds: TextOutlineBoundsV1,
    pub fill_rule: FillRuleV1,
}

/// Stable reason code for a text request that cannot be rendered.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextOutlineUnsupportedCodeV1 {
    InvalidRequest,
    RequestTooLarge,
    CharacterUnsupported,
    GlyphMissing,
    OutlineInvalid,
    OutlineLimitExceeded,
    ResponseTooLarge,
    InternalFailure,
}

/// Unsupported result exposed across the browser boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextOutlineUnsupportedV1 {
    pub code: TextOutlineUnsupportedCodeV1,
    pub message: String,
}

/// Closed compilation result for the plain-text sibling ABI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TextOutlineResultV1 {
    Compiled(TextOutlineArtifactV1),
    Unsupported(TextOutlineUnsupportedV1),
}

impl TextOutlineResultV1 {
    /// Creates a structured unsupported result.
    pub fn unsupported(code: TextOutlineUnsupportedCodeV1, message: &'static str) -> Self {
        Self::Unsupported(TextOutlineUnsupportedV1 {
            code,
            message: message.to_owned(),
        })
    }
}

#[derive(Clone, Copy, Debug)]
struct CompileFailure {
    code: TextOutlineUnsupportedCodeV1,
    message: &'static str,
}

impl CompileFailure {
    const fn new(code: TextOutlineUnsupportedCodeV1, message: &'static str) -> Self {
        Self { code, message }
    }
}

/// Compiles bounded Unicode text with embedded, deterministic font faces.
///
/// Printable ASCII keeps the existing `DejaVu Sans Regular` subset. Text that
/// needs Japanese glyphs uses a `Noto Sans CJK JP` subset containing the 2,136
/// Joyo kanji, kana, Japanese punctuation, full-width forms, and Latin text.
/// Other scripts fail with `glyph-missing` instead of silently substituting a
/// browser or system font.
#[must_use]
pub fn compile_text_outline_v1(request: &TextOutlineRequestV1) -> TextOutlineResultV1 {
    match compile_inner(request) {
        Ok(artifact) => TextOutlineResultV1::Compiled(artifact),
        Err(failure) => TextOutlineResultV1::unsupported(failure.code, failure.message),
    }
}

fn compile_inner(request: &TextOutlineRequestV1) -> Result<TextOutlineArtifactV1, CompileFailure> {
    let text = validate_request(request)?;
    let dejavu = Face::parse(DEJAVU_SANS_REGULAR, 0).map_err(|_| {
        CompileFailure::new(
            TextOutlineUnsupportedCodeV1::InternalFailure,
            "The embedded DejaVu Sans font could not be parsed",
        )
    })?;
    let japanese = Face::parse(NOTO_SANS_CJK_JP_REGULAR_JOYO, 0).map_err(|_| {
        CompileFailure::new(
            TextOutlineUnsupportedCodeV1::InternalFailure,
            "The embedded Japanese text font could not be parsed",
        )
    })?;
    let face = if text
        .chars()
        .filter(|character| *character != '\n')
        .all(|character| dejavu.glyph_index(character).is_some())
    {
        &dejavu
    } else {
        &japanese
    };
    let mut subpaths = Vec::new();
    let mut segment_count = 0usize;

    for (line_index, line) in text.split('\n').enumerate() {
        let mut cursor_x = 0.0;
        let mut previous = None;
        let line_index = u32::try_from(line_index).map_err(|_| {
            CompileFailure::new(
                TextOutlineUnsupportedCodeV1::InternalFailure,
                "The bounded Text line index could not be represented",
            )
        })?;
        let baseline_y =
            -f64::from(line_index) * f64::from(face.units_per_em()) * TEXT_LINE_ADVANCE_EM;
        for character in line.chars() {
            let glyph = face.glyph_index(character).ok_or_else(|| {
                CompileFailure::new(
                    TextOutlineUnsupportedCodeV1::GlyphMissing,
                    "The embedded text fonts have no glyph for this Unicode scalar",
                )
            })?;
            if let Some(left) = previous {
                cursor_x += f64::from(horizontal_kerning(face, left, glyph));
            }
            append_glyph(
                face,
                glyph,
                character,
                cursor_x,
                baseline_y,
                &mut subpaths,
                &mut segment_count,
            )?;
            cursor_x += f64::from(face.glyph_hor_advance(glyph).ok_or_else(|| {
                CompileFailure::new(
                    TextOutlineUnsupportedCodeV1::OutlineInvalid,
                    "An embedded text glyph has no horizontal advance",
                )
            })?);
            previous = Some(glyph);
        }
    }

    let (path, bounds) = normalize_outline_subpaths(subpaths).map_err(map_outline_failure)?;
    Ok(TextOutlineArtifactV1 {
        path,
        bounds,
        fill_rule: FillRuleV1::NonZero,
    })
}

fn append_glyph(
    face: &Face<'_>,
    glyph: GlyphId,
    character: char,
    cursor_x: f64,
    baseline_y: f64,
    target: &mut Vec<CubicSubpathV1>,
    segment_count: &mut usize,
) -> Result<(), CompileFailure> {
    let Some(glyph_subpaths) = glyph_outline_subpaths(face, glyph, 1.0, 1.0, cursor_x, baseline_y)
        .map_err(map_outline_failure)?
    else {
        return if character.is_whitespace() {
            Ok(())
        } else {
            Err(CompileFailure::new(
                TextOutlineUnsupportedCodeV1::OutlineInvalid,
                "An embedded text glyph has no vector outline",
            ))
        };
    };
    let added_segments = glyph_subpaths
        .iter()
        .try_fold(0usize, |count, subpath| {
            count.checked_add(subpath.segments.len())
        })
        .ok_or_else(outline_limit_exceeded)?;
    *segment_count = segment_count
        .checked_add(added_segments)
        .ok_or_else(outline_limit_exceeded)?;
    if *segment_count > MAX_TEXT_CUBIC_SEGMENTS_V1 {
        return Err(outline_limit_exceeded());
    }
    target.extend(glyph_subpaths);
    Ok(())
}

fn validate_request(request: &TextOutlineRequestV1) -> Result<String, CompileFailure> {
    if request.version != TEXT_OUTLINE_VERSION_V1 || request.text.is_empty() {
        return Err(CompileFailure::new(
            TextOutlineUnsupportedCodeV1::InvalidRequest,
            "Text outline request does not match the v1 contract",
        ));
    }
    let mut normalized = String::with_capacity(request.text.len());
    let mut characters = request.text.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\r' {
            if characters.next_if_eq(&'\n').is_none() {
                return Err(CompileFailure::new(
                    TextOutlineUnsupportedCodeV1::CharacterUnsupported,
                    "Text accepts CR only as part of a CRLF line ending",
                ));
            }
            normalized.push('\n');
        } else if character.is_control() && character != '\n' {
            return Err(CompileFailure::new(
                TextOutlineUnsupportedCodeV1::CharacterUnsupported,
                "Text rejects control characters other than LF",
            ));
        } else {
            normalized.push(character);
        }
    }
    if normalized.chars().count() > MAX_TEXT_CHARACTERS_V1 {
        return Err(CompileFailure::new(
            TextOutlineUnsupportedCodeV1::RequestTooLarge,
            "Text outline requests accept at most 256 Unicode scalars",
        ));
    }
    let lines = normalized.split('\n').collect::<Vec<_>>();
    if lines.len() > MAX_TEXT_LINES_V1 {
        return Err(CompileFailure::new(
            TextOutlineUnsupportedCodeV1::RequestTooLarge,
            "Text outline requests accept at most 8 lines",
        ));
    }
    if lines
        .iter()
        .any(|line| line.chars().count() > MAX_TEXT_LINE_CHARACTERS_V1)
    {
        return Err(CompileFailure::new(
            TextOutlineUnsupportedCodeV1::RequestTooLarge,
            "Text outline requests accept at most 128 Unicode scalars per line",
        ));
    }
    if normalized.chars().all(char::is_whitespace) {
        return Err(CompileFailure::new(
            TextOutlineUnsupportedCodeV1::InvalidRequest,
            "Text outline requests must contain visible text",
        ));
    }
    Ok(normalized)
}

fn horizontal_kerning(face: &Face<'_>, left: GlyphId, right: GlyphId) -> i32 {
    let Some(table) = face.tables().kern else {
        return 0;
    };
    table
        .subtables
        .into_iter()
        .filter(|subtable| subtable.horizontal && !subtable.variable && !subtable.has_cross_stream)
        .filter_map(|subtable| subtable.glyphs_kerning(left, right))
        .map(i32::from)
        .sum()
}

const fn map_outline_failure(failure: OutlineFailureV1) -> CompileFailure {
    match failure {
        OutlineFailureV1::LimitExceeded => outline_limit_exceeded(),
        OutlineFailureV1::UnsupportedFrameItem | OutlineFailureV1::Invalid => CompileFailure::new(
            TextOutlineUnsupportedCodeV1::OutlineInvalid,
            "Plain-text outlines violate the cubic path contract",
        ),
    }
}

const fn outline_limit_exceeded() -> CompileFailure {
    CompileFailure::new(
        TextOutlineUnsupportedCodeV1::OutlineLimitExceeded,
        "Plain-text outlines exceed the cubic path limit",
    )
}

#[cfg(test)]
mod tests {
    use poietra_scene_ir::validate_cubic_path_v1;

    use super::*;

    fn compiled(text: &str) -> TextOutlineArtifactV1 {
        match compile_text_outline_v1(&TextOutlineRequestV1::new(text)) {
            TextOutlineResultV1::Compiled(artifact) => artifact,
            TextOutlineResultV1::Unsupported(unsupported) => {
                panic!("expected compiled text, got {unsupported:?}")
            }
        }
    }

    fn unsupported_code(text: &str) -> TextOutlineUnsupportedCodeV1 {
        match compile_text_outline_v1(&TextOutlineRequestV1::new(text)) {
            TextOutlineResultV1::Compiled(_) => panic!("expected unsupported text"),
            TextOutlineResultV1::Unsupported(unsupported) => unsupported.code,
        }
    }

    #[test]
    fn compiles_printable_ascii_to_centered_unit_height_cubics() {
        let artifact = compiled("Hello, Poietra!");
        assert_eq!(artifact.fill_rule, FillRuleV1::NonZero);
        assert!(artifact.path.subpaths.iter().all(|subpath| subpath.closed));
        assert!((artifact.bounds.top - artifact.bounds.bottom - 1.0).abs() <= 0.000_002);
        assert!((artifact.bounds.left + artifact.bounds.right).abs() <= 0.000_002);
        assert!((artifact.bounds.bottom + artifact.bounds.top).abs() <= 0.000_002);
        validate_cubic_path_v1(&artifact.path).expect("compiled text path must be valid");
    }

    #[test]
    fn compiles_joyo_japanese_and_multiline_text_to_one_centered_outline() {
        let japanese = compiled("日本語で動画を作る");
        assert!(!japanese.path.subpaths.is_empty());
        validate_cubic_path_v1(&japanese.path).expect("Japanese text path must be valid");

        let multiline = compiled("こんにちは\nPoietra");
        assert!(!multiline.path.subpaths.is_empty());
        assert!((multiline.bounds.top - multiline.bounds.bottom - 1.0).abs() <= 0.000_002);
        assert!((multiline.bounds.left + multiline.bounds.right).abs() <= 0.000_002);
        assert!((multiline.bounds.bottom + multiline.bounds.top).abs() <= 0.000_002);
        assert_eq!(multiline, compiled("こんにちは\r\nPoietra"));
        validate_cubic_path_v1(&multiline.path).expect("multiline text path must be valid");
    }

    #[test]
    fn output_is_deterministic_and_layout_applies_space_advance() {
        let compact = compiled("AA");
        let spaced = compiled("A A");
        assert_eq!(compact, compiled("AA"));
        assert!(spaced.bounds.right > compact.bounds.right);
    }

    #[test]
    fn embedded_font_covers_the_printable_ascii_profile() {
        let printable_ascii = (b' '..=b'~').map(char::from).collect::<String>();
        let artifact = compiled(&printable_ascii);
        assert!(!artifact.path.subpaths.is_empty());
    }

    #[test]
    fn embedded_font_exposes_pair_kerning() {
        let face = Face::parse(DEJAVU_SANS_REGULAR, 0).expect("embedded face must parse");
        let a = face.glyph_index('A').expect("A glyph");
        let v = face.glyph_index('V').expect("V glyph");
        assert!(horizontal_kerning(&face, a, v) < 0);
    }

    #[test]
    fn rejects_input_outside_the_closed_text_profile() {
        assert_eq!(
            unsupported_code(""),
            TextOutlineUnsupportedCodeV1::InvalidRequest
        );
        assert_eq!(
            unsupported_code("first\rsecond"),
            TextOutlineUnsupportedCodeV1::CharacterUnsupported
        );
        assert_eq!(
            unsupported_code("tab\tcharacter"),
            TextOutlineUnsupportedCodeV1::CharacterUnsupported
        );
        assert_eq!(
            unsupported_code("𠮷"),
            TextOutlineUnsupportedCodeV1::GlyphMissing
        );
        assert_eq!(
            unsupported_code(&"A".repeat(MAX_TEXT_CHARACTERS_V1 + 1)),
            TextOutlineUnsupportedCodeV1::RequestTooLarge
        );
        assert_eq!(
            unsupported_code("   "),
            TextOutlineUnsupportedCodeV1::InvalidRequest
        );
        assert_eq!(
            unsupported_code(&["A"; MAX_TEXT_LINES_V1 + 1].join("\n")),
            TextOutlineUnsupportedCodeV1::RequestTooLarge
        );
        assert_eq!(
            unsupported_code(&"A".repeat(MAX_TEXT_LINE_CHARACTERS_V1 + 1)),
            TextOutlineUnsupportedCodeV1::RequestTooLarge
        );
        assert_eq!(
            unsupported_code(&"@".repeat(MAX_TEXT_LINE_CHARACTERS_V1)),
            TextOutlineUnsupportedCodeV1::OutlineLimitExceeded
        );
    }
}
