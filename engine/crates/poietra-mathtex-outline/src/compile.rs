use poietra_scene_ir::FillRuleV1;
use typst_layout::PagedDocument;

use crate::digest::{content_digest_v1, toolchain_digest_v1};
use crate::outline::{OutlineFailureV1, extract_normalized_outline_v1};
use crate::world::HermeticMathWorldV1;
use crate::{
    MATHTEX_FONT_DIGEST_V1, MATHTEX_OUTLINE_VERSION_V1, MAX_MATHTEX_PARTS_V1,
    MAX_MATHTEX_SOURCE_BYTES_V1, MathTexOutlineArtifactV1, MathTexOutlineRequestV1,
    MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1,
};

const MAX_BRACE_DEPTH_V1: usize = 8;
const MAX_CONVERTED_SOURCE_BYTES_V1: usize = 4_096;

#[derive(Clone, Copy, Debug)]
struct CompileFailureV1 {
    code: MathTexOutlineUnsupportedCodeV1,
    message: &'static str,
}

impl CompileFailureV1 {
    const fn new(code: MathTexOutlineUnsupportedCodeV1, message: &'static str) -> Self {
        Self { code, message }
    }
}

/// Compiles a bounded v1 request into a renderer-native path or structured fallback.
#[must_use]
pub fn compile_mathtex_outline_v1(request: &MathTexOutlineRequestV1) -> MathTexOutlineResultV1 {
    match compile_inner(request) {
        Ok(artifact) => MathTexOutlineResultV1::Compiled(artifact),
        Err(failure) => MathTexOutlineResultV1::unsupported(failure.code, failure.message),
    }
}

fn compile_inner(
    request: &MathTexOutlineRequestV1,
) -> Result<MathTexOutlineArtifactV1, CompileFailureV1> {
    let validated = validate_and_normalize_request(request)?;
    let converted = mitex::convert_math(&validated.expression, None).map_err(|_| {
        CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::ConversionFailed,
            "MathTex conversion failed for this expression",
        )
    })?;
    if converted.len() > MAX_CONVERTED_SOURCE_BYTES_V1 || !converted_source_is_safe(&converted) {
        return Err(CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::ConversionFailed,
            "MathTex conversion produced an unsupported expression",
        ));
    }

    let typst_source = format!(
        concat!(
            "#set page(width: 32pt, height: 8pt, margin: 0pt, fill: none)\n",
            "#set text(font: \"New Computer Modern Math\", size: 1pt)\n",
            "#align(center + horizon)[${}$]"
        ),
        converted
    );
    let world = HermeticMathWorldV1::new(typst_source).ok_or_else(|| {
        CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::InternalFailure,
            "The embedded MathTex font could not be initialized",
        )
    })?;
    let warned = typst::compile::<PagedDocument>(&world);
    let has_warnings = !warned.warnings.is_empty();
    let output = warned.output;
    typst::comemo::evict(0);
    if has_warnings {
        return Err(CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::LayoutFailed,
            "MathTex layout produced a warning and was rejected",
        ));
    }
    let document = output.map_err(|_| {
        CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::LayoutFailed,
            "MathTex layout failed for this expression",
        )
    })?;
    let [page] = document.pages() else {
        return Err(CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::LayoutFailed,
            "MathTex layout must produce exactly one page",
        ));
    };
    let (path, bounds) = extract_normalized_outline_v1(&page.frame).map_err(map_outline_failure)?;

    Ok(MathTexOutlineArtifactV1 {
        path,
        bounds,
        fill_rule: FillRuleV1::NonZero,
        content_digest: content_digest_v1(&validated.digest_parts),
        toolchain_digest: toolchain_digest_v1(),
        font_digest: MATHTEX_FONT_DIGEST_V1.to_owned(),
    })
}

#[derive(Debug)]
struct ValidatedRequestV1 {
    expression: String,
    digest_parts: Vec<String>,
}

fn validate_and_normalize_request(
    request: &MathTexOutlineRequestV1,
) -> Result<ValidatedRequestV1, CompileFailureV1> {
    if request.version != MATHTEX_OUTLINE_VERSION_V1 || request.tex_parts.is_empty() {
        return Err(CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::InvalidRequest,
            "MathTex outline request does not match the v1 contract",
        ));
    }
    if request.tex_parts.len() > MAX_MATHTEX_PARTS_V1 {
        return Err(CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::RequestTooLarge,
            "MathTex outline request contains too many source parts",
        ));
    }
    let source_bytes = request
        .tex_parts
        .iter()
        .try_fold(0usize, |total, part| total.checked_add(part.len()))
        .ok_or_else(|| {
            CompileFailureV1::new(
                MathTexOutlineUnsupportedCodeV1::RequestTooLarge,
                "MathTex outline request exceeds the source limit",
            )
        })?;
    if source_bytes > MAX_MATHTEX_SOURCE_BYTES_V1 {
        return Err(CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::RequestTooLarge,
            "MathTex outline request exceeds the source limit",
        ));
    }

    let digest_parts = request
        .tex_parts
        .iter()
        .map(|part| part.split_ascii_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>();
    if digest_parts.iter().any(String::is_empty) {
        return Err(CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::InvalidRequest,
            "Each MathTex source part must contain an expression",
        ));
    }
    let expression = digest_parts.join(" ");
    validate_supported_syntax(&expression)?;
    Ok(ValidatedRequestV1 {
        expression,
        digest_parts,
    })
}

fn validate_supported_syntax(source: &str) -> Result<(), CompileFailureV1> {
    let mut brace_depth = 0usize;
    for character in source.chars() {
        if !(character.is_ascii_alphanumeric()
            || character.is_ascii_whitespace()
            || matches!(character, '=' | '+' | '-' | '^' | '_' | '{' | '}'))
        {
            return Err(syntax_unsupported());
        }
        match character {
            '{' => {
                brace_depth += 1;
                if brace_depth > MAX_BRACE_DEPTH_V1 {
                    return Err(syntax_unsupported());
                }
            }
            '}' => {
                brace_depth = brace_depth.checked_sub(1).ok_or_else(syntax_unsupported)?;
            }
            _ => {}
        }
    }
    if brace_depth != 0 {
        return Err(syntax_unsupported());
    }
    Ok(())
}

fn converted_source_is_safe(source: &str) -> bool {
    source.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || character.is_ascii_whitespace()
            || matches!(
                character,
                '=' | '+' | '-' | '^' | '_' | '{' | '}' | '(' | ')' | ',' | '.'
            )
    })
}

const fn syntax_unsupported() -> CompileFailureV1 {
    CompileFailureV1::new(
        MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported,
        "This MathTex syntax is not supported by the v1 browser outline compiler",
    )
}

fn map_outline_failure(failure: OutlineFailureV1) -> CompileFailureV1 {
    match failure {
        OutlineFailureV1::UnsupportedFrameItem => CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::FrameItemUnsupported,
            "MathTex layout contains a frame item unsupported by the v1 compiler",
        ),
        OutlineFailureV1::Invalid => CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::OutlineInvalid,
            "MathTex layout did not produce a valid closed cubic outline",
        ),
        OutlineFailureV1::LimitExceeded => CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::OutlineLimitExceeded,
            "MathTex outline exceeds the v1 geometry limit",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalization_normalizes_spacing_but_preserves_part_boundaries_for_digesting() {
        let first = MathTexOutlineRequestV1::new(vec![" E ".to_owned(), "=   mc^2".to_owned()]);
        let second = MathTexOutlineRequestV1::new(vec!["E = mc^2".to_owned()]);
        let first = validate_and_normalize_request(&first).expect("supported");
        let second = validate_and_normalize_request(&second).expect("supported");
        assert_eq!(first.expression, second.expression);
        assert_ne!(
            content_digest_v1(&first.digest_parts),
            content_digest_v1(&second.digest_parts)
        );
    }

    #[test]
    fn empty_source_parts_are_rejected_at_the_core_boundary() {
        let request = MathTexOutlineRequestV1::new(vec!["E".to_owned(), "   ".to_owned()]);
        let failure = validate_and_normalize_request(&request).expect_err("part must be non-empty");
        assert_eq!(
            failure.code,
            MathTexOutlineUnsupportedCodeV1::InvalidRequest
        );
    }
}
