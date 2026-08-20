use poietra_scene_ir::{CubicPathV1, CubicSubpathV1, FillRuleV1};
use serde::{Deserialize, Serialize};
use ttf_parser::{Face, GlyphId};
use unicode_normalization::UnicodeNormalization;

use crate::MathTexOutlineBoundsV1;
use crate::outline::{OutlineFailureV1, glyph_outline_subpaths, normalize_outline_subpaths};

/// Exact request schema literal accepted by the plain-text compiler.
pub const TEXT_OUTLINE_REQUEST_SCHEMA_V1: &str = "poietra.text-outline-request";
/// Exact response schema literal emitted by the WASM boundary.
pub const TEXT_OUTLINE_RESPONSE_SCHEMA_V1: &str = "poietra.text-outline-response";
/// Contract version shared by the core and WASM wrapper.
pub const TEXT_OUTLINE_VERSION_V1: u32 = 1;
/// Maximum number of Unicode scalar values accepted after CRLF and NFC normalization.
pub const MAX_TEXT_CHARACTERS_V1: usize = 256;
/// Maximum number of lines accepted by the plain-text compiler.
pub const MAX_TEXT_LINES_V1: usize = 8;
/// Maximum number of Unicode scalar values accepted on one line.
pub const MAX_TEXT_LINE_CHARACTERS_V1: usize = 128;
/// Maximum number of cubic segments emitted for one text artifact.
pub const MAX_TEXT_CUBIC_SEGMENTS_V1: usize = 2_048;

const DEJAVU_SANS_REGULAR: &[u8] = include_bytes!("../assets/DejaVuSans.ttf");
const DEJAVU_SANS_BOLD: &[u8] = include_bytes!("../assets/DejaVuSans-Bold.ttf");
const DEJAVU_SANS_MONO_REGULAR: &[u8] = include_bytes!("../assets/DejaVuSansMono.ttf");
const DEJAVU_SANS_MONO_BOLD: &[u8] = include_bytes!("../assets/DejaVuSansMono-Bold.ttf");
const NOTO_SANS_CJK_JP_REGULAR_JOYO: &[u8] =
    include_bytes!("../assets/NotoSansCJKjp-Regular-Joyo.otf");
const NOTO_SANS_CJK_JP_BOLD_JOYO: &[u8] = include_bytes!("../assets/NotoSansCJKjp-Bold-Joyo.otf");
pub const DEFAULT_TEXT_LINE_HEIGHT_EM: f64 = 1.2;

/// Horizontal alignment applied to each line inside the widest line box.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextAlignmentV1 {
    Center,
    #[default]
    Left,
    Right,
}

/// Real embedded font face selected for plain Text outlines.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextFontWeightV1 {
    Bold,
    #[default]
    Regular,
}

/// Closed embedded font family selected for plain Text outlines.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextFontFamilyV1 {
    Mono,
    #[default]
    Sans,
}

/// Bounded plain-text layout owned by the Rust outline compiler.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextOutlineLayoutV1 {
    pub alignment: TextAlignmentV1,
    #[serde(default)]
    pub font_family: TextFontFamilyV1,
    #[serde(default)]
    pub font_weight: TextFontWeightV1,
    pub line_height: f64,
}

impl Default for TextOutlineLayoutV1 {
    fn default() -> Self {
        Self {
            alignment: TextAlignmentV1::Left,
            font_family: TextFontFamilyV1::Sans,
            font_weight: TextFontWeightV1::Regular,
            line_height: DEFAULT_TEXT_LINE_HEIGHT_EM,
        }
    }
}

/// Literal request schema represented as a closed serde enum.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TextOutlineRequestSchemaV1 {
    #[serde(rename = "poietra.text-outline-request")]
    TextOutlineRequest,
}

/// One bounded plain-text outline request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextOutlineRequestV1 {
    #[serde(default)]
    pub layout: TextOutlineLayoutV1,
    pub schema: TextOutlineRequestSchemaV1,
    pub version: u32,
    pub text: String,
}

impl TextOutlineRequestV1 {
    /// Creates a correctly versioned plain-text request.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            layout: TextOutlineLayoutV1::default(),
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
/// Printable ASCII uses the requested `DejaVu Sans` or `DejaVu Sans Mono`
/// face. Scalars missing from that face use the embedded `Noto Sans CJK JP`
/// subset. Layout remains left-to-right, applies kerning only inside one font
/// run, and never consults browser or system fonts.
#[must_use]
pub fn compile_text_outline_v1(request: &TextOutlineRequestV1) -> TextOutlineResultV1 {
    match compile_inner(request) {
        Ok(artifact) => TextOutlineResultV1::Compiled(artifact),
        Err(failure) => TextOutlineResultV1::unsupported(failure.code, failure.message),
    }
}

fn compile_inner(request: &TextOutlineRequestV1) -> Result<TextOutlineArtifactV1, CompileFailure> {
    let text = validate_request(request)?;
    let faces = TextFaces::new(request.layout.font_family, request.layout.font_weight)?;
    let shaped_lines = text
        .split('\n')
        .map(|line| shape_ltr_line(&faces, line))
        .collect::<Result<Vec<_>, _>>()?;
    let maximum_line_width = shaped_lines
        .iter()
        .map(|line| line.advance)
        .fold(0.0_f64, f64::max);
    let mut subpaths = Vec::new();
    let mut segment_count = 0usize;

    for (line_index, line) in shaped_lines.into_iter().enumerate() {
        let line_offset_x = match request.layout.alignment {
            TextAlignmentV1::Left => 0.0,
            TextAlignmentV1::Center => (maximum_line_width - line.advance) / 2.0,
            TextAlignmentV1::Right => maximum_line_width - line.advance,
        };
        let line_index = u32::try_from(line_index).map_err(|_| {
            CompileFailure::new(
                TextOutlineUnsupportedCodeV1::InternalFailure,
                "The bounded Text line index could not be represented",
            )
        })?;
        let baseline_y = -f64::from(line_index) * faces.em_units * request.layout.line_height;
        for glyph in line.glyphs {
            append_glyph(
                &faces,
                glyph,
                line_offset_x,
                baseline_y,
                &mut subpaths,
                &mut segment_count,
            )?;
        }
    }

    let (path, bounds) = normalize_outline_subpaths(subpaths).map_err(map_outline_failure)?;
    Ok(TextOutlineArtifactV1 {
        path,
        bounds,
        fill_rule: FillRuleV1::NonZero,
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TextFaceSlot {
    JapaneseFallback,
    Primary,
}

#[derive(Debug)]
struct TextFaces {
    em_units: f64,
    japanese_fallback: Face<'static>,
    primary: Face<'static>,
}

impl TextFaces {
    fn new(family: TextFontFamilyV1, weight: TextFontWeightV1) -> Result<Self, CompileFailure> {
        let primary_bytes = match (family, weight) {
            (TextFontFamilyV1::Sans, TextFontWeightV1::Bold) => DEJAVU_SANS_BOLD,
            (TextFontFamilyV1::Sans, TextFontWeightV1::Regular) => DEJAVU_SANS_REGULAR,
            (TextFontFamilyV1::Mono, TextFontWeightV1::Bold) => DEJAVU_SANS_MONO_BOLD,
            (TextFontFamilyV1::Mono, TextFontWeightV1::Regular) => DEJAVU_SANS_MONO_REGULAR,
        };
        let japanese_bytes = match weight {
            TextFontWeightV1::Bold => NOTO_SANS_CJK_JP_BOLD_JOYO,
            TextFontWeightV1::Regular => NOTO_SANS_CJK_JP_REGULAR_JOYO,
        };
        let primary = Face::parse(primary_bytes, 0).map_err(|_| {
            CompileFailure::new(
                TextOutlineUnsupportedCodeV1::InternalFailure,
                "The selected embedded text font could not be parsed",
            )
        })?;
        let japanese_fallback = Face::parse(japanese_bytes, 0).map_err(|_| {
            CompileFailure::new(
                TextOutlineUnsupportedCodeV1::InternalFailure,
                "The embedded Japanese text font could not be parsed",
            )
        })?;
        Ok(Self {
            em_units: f64::from(primary.units_per_em()),
            japanese_fallback,
            primary,
        })
    }

    const fn face(&self, slot: TextFaceSlot) -> &Face<'static> {
        match slot {
            TextFaceSlot::JapaneseFallback => &self.japanese_fallback,
            TextFaceSlot::Primary => &self.primary,
        }
    }

    fn scale(&self, slot: TextFaceSlot) -> f64 {
        self.em_units / f64::from(self.face(slot).units_per_em())
    }

    fn glyph(&self, character: char) -> Result<(TextFaceSlot, GlyphId), CompileFailure> {
        if let Some(glyph) = self.primary.glyph_index(character) {
            return Ok((TextFaceSlot::Primary, glyph));
        }
        self.japanese_fallback
            .glyph_index(character)
            .map(|glyph| (TextFaceSlot::JapaneseFallback, glyph))
            .ok_or_else(|| {
                CompileFailure::new(
                    TextOutlineUnsupportedCodeV1::GlyphMissing,
                    "The embedded text fonts have no glyph for this Unicode scalar",
                )
            })
    }
}

#[derive(Clone, Copy, Debug)]
struct PositionedGlyph {
    character: char,
    face: TextFaceSlot,
    id: GlyphId,
    origin_x: f64,
}

#[derive(Debug)]
struct ShapedLine {
    advance: f64,
    glyphs: Vec<PositionedGlyph>,
}

fn shape_ltr_line(faces: &TextFaces, line: &str) -> Result<ShapedLine, CompileFailure> {
    let mut cursor_x = 0.0;
    let mut glyphs = Vec::with_capacity(line.chars().count());
    let mut previous = None;
    for character in line.chars() {
        let (slot, glyph) = faces.glyph(character)?;
        let face = faces.face(slot);
        let scale = faces.scale(slot);
        if let Some((previous_slot, left)) = previous
            && previous_slot == slot
        {
            cursor_x += f64::from(horizontal_kerning(face, left, glyph)) * scale;
        }
        glyphs.push(PositionedGlyph {
            character,
            face: slot,
            id: glyph,
            origin_x: cursor_x,
        });
        cursor_x += f64::from(face.glyph_hor_advance(glyph).ok_or_else(|| {
            CompileFailure::new(
                TextOutlineUnsupportedCodeV1::OutlineInvalid,
                "An embedded text glyph has no horizontal advance",
            )
        })?) * scale;
        previous = Some((slot, glyph));
    }
    Ok(ShapedLine {
        advance: cursor_x,
        glyphs,
    })
}

fn append_glyph(
    faces: &TextFaces,
    glyph: PositionedGlyph,
    line_offset_x: f64,
    baseline_y: f64,
    target: &mut Vec<CubicSubpathV1>,
    segment_count: &mut usize,
) -> Result<(), CompileFailure> {
    let face = faces.face(glyph.face);
    let scale = faces.scale(glyph.face);
    let Some(glyph_subpaths) = glyph_outline_subpaths(
        face,
        glyph.id,
        scale,
        scale,
        line_offset_x + glyph.origin_x,
        baseline_y,
    )
    .map_err(map_outline_failure)?
    else {
        return if glyph.character.is_whitespace() {
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
    if request.version != TEXT_OUTLINE_VERSION_V1
        || request.text.is_empty()
        || !request.layout.line_height.is_finite()
        || request.layout.line_height <= 0.0
    {
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
    let normalized = normalized.nfc().collect::<String>();
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

    fn compiled_with_layout(text: &str, layout: TextOutlineLayoutV1) -> TextOutlineArtifactV1 {
        let mut request = TextOutlineRequestV1::new(text);
        request.layout = layout;
        match compile_text_outline_v1(&request) {
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
    fn canonicalizes_decomposed_unicode_before_glyph_layout() {
        let composed = compiled("Caf\u{e9}");
        let decomposed = compiled("Cafe\u{301}");

        assert_eq!(decomposed, composed);
        validate_cubic_path_v1(&decomposed.path).expect("NFC-normalized Text path must be valid");
    }

    #[test]
    fn output_is_deterministic_and_layout_applies_space_advance() {
        let compact = compiled("AA");
        let spaced = compiled("A A");
        assert_eq!(compact, compiled("AA"));
        assert!(spaced.bounds.right > compact.bounds.right);
    }

    #[test]
    fn alignment_and_line_height_change_multiline_geometry_in_rust() {
        let left = compiled_with_layout("Wide\ni", TextOutlineLayoutV1::default());
        assert_eq!(left, compiled("Wide\ni"));
        let legacy: TextOutlineRequestV1 = serde_json::from_str(
            r#"{"schema":"poietra.text-outline-request","version":1,"text":"Wide\ni"}"#,
        )
        .unwrap();
        assert_eq!(legacy.layout, TextOutlineLayoutV1::default());
        assert_eq!(
            compile_text_outline_v1(&legacy),
            TextOutlineResultV1::Compiled(left.clone())
        );
        let center = compiled_with_layout(
            "Wide\ni",
            TextOutlineLayoutV1 {
                alignment: TextAlignmentV1::Center,
                font_family: TextFontFamilyV1::Sans,
                font_weight: TextFontWeightV1::Regular,
                line_height: DEFAULT_TEXT_LINE_HEIGHT_EM,
            },
        );
        let right = compiled_with_layout(
            "Wide\ni",
            TextOutlineLayoutV1 {
                alignment: TextAlignmentV1::Right,
                font_family: TextFontFamilyV1::Sans,
                font_weight: TextFontWeightV1::Regular,
                line_height: 2.0,
            },
        );
        assert_ne!(left.path, center.path);
        assert_ne!(center.path, right.path);
        assert_eq!(
            right,
            compiled_with_layout(
                "Wide\ni",
                TextOutlineLayoutV1 {
                    alignment: TextAlignmentV1::Right,
                    font_family: TextFontFamilyV1::Sans,
                    font_weight: TextFontWeightV1::Regular,
                    line_height: 2.0,
                },
            )
        );

        let mut overflowing = TextOutlineRequestV1::new("Wide\ni");
        overflowing.layout.line_height = f64::MAX;
        assert!(matches!(
            compile_text_outline_v1(&overflowing),
            TextOutlineResultV1::Unsupported(TextOutlineUnsupportedV1 {
                code: TextOutlineUnsupportedCodeV1::OutlineInvalid,
                ..
            })
        ));
    }

    #[test]
    fn regular_and_bold_use_distinct_real_faces_for_latin_and_japanese() {
        let regular = TextOutlineLayoutV1::default();
        let bold = TextOutlineLayoutV1 {
            font_weight: TextFontWeightV1::Bold,
            ..regular
        };
        for text in ["Bold text", "太字の日本語"] {
            let regular_artifact = compiled_with_layout(text, regular);
            let bold_artifact = compiled_with_layout(text, bold);
            assert_ne!(bold_artifact.path, regular_artifact.path);
            assert!(
                (bold_artifact.bounds.top - bold_artifact.bounds.bottom - 1.0).abs() <= 0.000_002
            );
            validate_cubic_path_v1(&bold_artifact.path).expect("bold Text path must be valid");
        }

        let mut missing = TextOutlineRequestV1::new("𠮷");
        missing.layout = bold;
        assert!(matches!(
            compile_text_outline_v1(&missing),
            TextOutlineResultV1::Unsupported(TextOutlineUnsupportedV1 {
                code: TextOutlineUnsupportedCodeV1::GlyphMissing,
                ..
            })
        ));
    }

    #[test]
    fn sans_and_mono_use_distinct_real_faces_for_regular_and_bold_ascii() {
        for font_weight in [TextFontWeightV1::Regular, TextFontWeightV1::Bold] {
            let sans = compiled_with_layout(
                "iiWW 0123",
                TextOutlineLayoutV1 {
                    font_family: TextFontFamilyV1::Sans,
                    font_weight,
                    ..TextOutlineLayoutV1::default()
                },
            );
            let mono = compiled_with_layout(
                "iiWW 0123",
                TextOutlineLayoutV1 {
                    font_family: TextFontFamilyV1::Mono,
                    font_weight,
                    ..TextOutlineLayoutV1::default()
                },
            );
            assert_ne!(sans.path, mono.path);
            validate_cubic_path_v1(&mono.path).expect("mono Text path must be valid");
        }

        let mono_mixed = compiled_with_layout(
            "Mono日本語",
            TextOutlineLayoutV1 {
                font_family: TextFontFamilyV1::Mono,
                ..TextOutlineLayoutV1::default()
            },
        );
        validate_cubic_path_v1(&mono_mixed.path).expect("Mono fallback path must be valid");
    }

    #[test]
    fn mixed_ltr_text_keeps_the_requested_latin_face_and_uses_japanese_fallback() {
        for family in [TextFontFamilyV1::Sans, TextFontFamilyV1::Mono] {
            let faces = TextFaces::new(family, TextFontWeightV1::Regular).unwrap();
            let shaped = shape_ltr_line(&faces, "AV日本語").unwrap();
            assert_eq!(
                shaped
                    .glyphs
                    .iter()
                    .map(|glyph| glyph.face)
                    .collect::<Vec<_>>(),
                [
                    TextFaceSlot::Primary,
                    TextFaceSlot::Primary,
                    TextFaceSlot::JapaneseFallback,
                    TextFaceSlot::JapaneseFallback,
                    TextFaceSlot::JapaneseFallback,
                ]
            );
            assert!(shaped.glyphs[0].origin_x.abs() <= f64::EPSILON);
            assert!(shaped.glyphs[1].origin_x > 0.0);
            assert!(faces.scale(TextFaceSlot::JapaneseFallback) > 1.0);

            let artifact = compiled_with_layout(
                "AV日本語",
                TextOutlineLayoutV1 {
                    font_family: family,
                    ..TextOutlineLayoutV1::default()
                },
            );
            assert_eq!(
                artifact,
                compiled_with_layout(
                    "AV日本語",
                    TextOutlineLayoutV1 {
                        font_family: family,
                        ..TextOutlineLayoutV1::default()
                    },
                )
            );
            validate_cubic_path_v1(&artifact.path).expect("mixed fallback path must be valid");
        }
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
