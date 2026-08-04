use poietra_scene_ir::FillRuleV1;
use ratex_layout::{LayoutOptions, layout, to_display_list};
use ratex_lexer::Lexer;
use sha2::{Digest, Sha256};

use crate::digest::{content_digest_v1, toolchain_digest_v1};
use crate::outline::{OutlineFailureV1, extract_normalized_outline_v1};
use crate::{
    MATHTEX_FONT_DIGEST_V1, MATHTEX_OUTLINE_VERSION_V1, MAX_MATHTEX_PARTS_V1,
    MAX_MATHTEX_SOURCE_BYTES_V1, MathTexOutlineArtifactV1, MathTexOutlineRequestV1,
    MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1,
};

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
    let parsed = ratex_parser::parse(&validated.expression).map_err(|_| {
        CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported,
            "This MathTex syntax is not supported by the v1 browser outline compiler",
        )
    })?;
    let layout_box = layout(&parsed, &LayoutOptions::default());
    let display_list = to_display_list(&layout_box);
    let (path, bounds) =
        extract_normalized_outline_v1(&display_list).map_err(map_outline_failure)?;

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

    // TeX whitespace and newlines are semantic (notably before `%` comments
    // and inside `\text{}`). Without a complete TeX canonicalizer, both the
    // parser and length-framed digest must consume the raw parts unchanged.
    if request.tex_parts.iter().any(|part| part.trim().is_empty()) {
        return Err(CompileFailureV1::new(
            MathTexOutlineUnsupportedCodeV1::InvalidRequest,
            "Each MathTex source part must contain an expression",
        ));
    }
    let digest_parts = request.tex_parts.clone();
    let expression = digest_parts.join(" ");
    validate_transport_characters(&expression)?;
    validate_manim_default_source_profile(&expression)?;
    Ok(ValidatedRequestV1 {
        expression,
        digest_parts,
    })
}

fn validate_transport_characters(source: &str) -> Result<(), CompileFailureV1> {
    for character in source.chars() {
        if character == '\0' || (character.is_control() && !character.is_ascii_whitespace()) {
            return Err(syntax_unsupported());
        }
    }
    Ok(())
}

// This is the executable source profile covered by the pinned default-Manim
// corpora. RaTeX intentionally accepts KaTeX and package extensions that the
// exported/default-template Manim source cannot compile. A positive raw-token
// profile prevents the browser from presenting those inputs as truthful. Grow
// this list only with pinned Manim acceptance evidence. Other than the raw TeX
// parameter/comment/math-delimiter markers rejected below, ASCII ordinary
// tokens and punctuation remain unrestricted and are validated by RaTeX
// itself. Raw non-ASCII math is excluded because the pinned pdfLaTeX template
// rejects it.
const MANIM_DEFAULT_SOURCE_PROFILE_DIGEST_DOMAIN_V1: &[u8] =
    b"poietra.mathtex-outline.manim-source-profile.v1\0";
pub(crate) const MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1: &str = "core-ams-v3";
const MANIM_DEFAULT_CONTROL_SEQUENCES_V1: &[&str] = &[
    r"\#",
    r"\$",
    r"\%",
    r"\&",
    r"\,",
    r"\;",
    r"\\",
    r"\Delta",
    r"\Gamma",
    r"\Lambda",
    r"\Leftrightarrow",
    r"\Omega",
    r"\Phi",
    r"\Psi",
    r"\Rightarrow",
    r"\Sigma",
    r"\Theta",
    r"\_",
    r"\{",
    r"\}",
    r"\alpha",
    r"\approx",
    r"\begin",
    r"\beta",
    r"\cap",
    r"\cdot",
    r"\circ",
    r"\cos",
    r"\cup",
    r"\delta",
    r"\end",
    r"\exists",
    r"\forall",
    r"\frac",
    r"\gamma",
    r"\geq",
    r"\hat",
    r"\in",
    r"\infty",
    r"\int",
    r"\lambda",
    r"\leq",
    r"\left",
    r"\lim",
    r"\ln",
    r"\log",
    r"\mapsto",
    r"\mathbb",
    r"\mathbf",
    r"\mathrm",
    r"\mu",
    r"\nabla",
    r"\neq",
    r"\notin",
    r"\omega",
    r"\oint",
    r"\operatorname",
    r"\over",
    r"\partial",
    r"\phi",
    r"\pi",
    r"\prod",
    r"\psi",
    r"\quad",
    r"\rho",
    r"\right",
    r"\sigma",
    r"\sin",
    r"\sqrt",
    r"\subseteq",
    r"\sum",
    r"\tau",
    r"\text",
    r"\textbf",
    r"\theta",
    r"\times",
    r"\to",
    r"\varepsilon",
    r"\vec",
];
const MANIM_DEFAULT_ENVIRONMENTS_V1: &[&str] =
    &["aligned", "array", "bmatrix", "cases", "matrix", "pmatrix"];
const MANIM_DEFAULT_DELIMITER_TOKENS_V1: &[&str] = &["(", ")", "[", "]", r"\{", r"\}"];
const MANIM_DEFAULT_ONE_BRACED_ARGUMENT_CONTROLS_V1: &[&str] =
    &[r"\hat", r"\sqrt", r"\text", r"\textbf", r"\vec"];
const MANIM_DEFAULT_TWO_BRACED_ARGUMENT_CONTROLS_V1: &[&str] = &[r"\frac"];
const MANIM_DEFAULT_ENVIRONMENT_FREE_ARGUMENT_CONTROLS_V1: &[&str] = &[r"\text", r"\textbf"];
const MANIM_DEFAULT_SCRIPT_PREFIX_TOKENS_V1: &[&str] = &["^", "_"];
const MANIM_DEFAULT_FORBIDDEN_SCRIPT_ARGUMENT_STARTS_V1: &[&str] = &["}", "&", r"\begin"];

// Returns the canonical identity consumed by the toolchain manifest. Sorting and deduplication
// make source ordering irrelevant while length framing keeps set membership unambiguous.
pub(crate) fn manim_default_source_profile_digest_v1() -> String {
    source_profile_digest_v1(default_source_profile_policy_v1())
}

#[derive(Clone, Copy)]
struct SourceProfilePolicyV1<'a> {
    revision: &'a str,
    control_sequences: &'a [&'a str],
    environments: &'a [&'a str],
    delimiter_tokens: &'a [&'a str],
    one_braced_argument_controls: &'a [&'a str],
    two_braced_argument_controls: &'a [&'a str],
    environment_free_argument_controls: &'a [&'a str],
    script_prefix_tokens: &'a [&'a str],
    forbidden_script_argument_starts: &'a [&'a str],
}

const fn default_source_profile_policy_v1() -> SourceProfilePolicyV1<'static> {
    SourceProfilePolicyV1 {
        revision: MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1,
        control_sequences: MANIM_DEFAULT_CONTROL_SEQUENCES_V1,
        environments: MANIM_DEFAULT_ENVIRONMENTS_V1,
        delimiter_tokens: MANIM_DEFAULT_DELIMITER_TOKENS_V1,
        one_braced_argument_controls: MANIM_DEFAULT_ONE_BRACED_ARGUMENT_CONTROLS_V1,
        two_braced_argument_controls: MANIM_DEFAULT_TWO_BRACED_ARGUMENT_CONTROLS_V1,
        environment_free_argument_controls: MANIM_DEFAULT_ENVIRONMENT_FREE_ARGUMENT_CONTROLS_V1,
        script_prefix_tokens: MANIM_DEFAULT_SCRIPT_PREFIX_TOKENS_V1,
        forbidden_script_argument_starts: MANIM_DEFAULT_FORBIDDEN_SCRIPT_ARGUMENT_STARTS_V1,
    }
}

fn source_profile_digest_v1(policy: SourceProfilePolicyV1<'_>) -> String {
    fn update_frame(hasher: &mut Sha256, value: &[u8]) {
        hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
        hasher.update(value);
    }

    fn update_set(hasher: &mut Sha256, values: &[&str]) {
        let mut canonical = values.to_vec();
        canonical.sort_unstable();
        canonical.dedup();
        hasher.update(
            u64::try_from(canonical.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        for value in canonical {
            update_frame(hasher, value.as_bytes());
        }
    }

    let mut hasher = Sha256::new();
    hasher.update(MANIM_DEFAULT_SOURCE_PROFILE_DIGEST_DOMAIN_V1);
    update_frame(&mut hasher, policy.revision.as_bytes());
    update_frame(&mut hasher, b"control-sequences");
    update_set(&mut hasher, policy.control_sequences);
    update_frame(&mut hasher, b"environments");
    update_set(&mut hasher, policy.environments);
    update_frame(&mut hasher, b"delimiter-tokens");
    update_set(&mut hasher, policy.delimiter_tokens);
    update_frame(&mut hasher, b"one-braced-argument-controls");
    update_set(&mut hasher, policy.one_braced_argument_controls);
    update_frame(&mut hasher, b"two-braced-argument-controls");
    update_set(&mut hasher, policy.two_braced_argument_controls);
    update_frame(&mut hasher, b"environment-free-argument-controls");
    update_set(&mut hasher, policy.environment_free_argument_controls);
    update_frame(&mut hasher, b"script-prefix-tokens");
    update_set(&mut hasher, policy.script_prefix_tokens);
    update_frame(&mut hasher, b"forbidden-script-argument-starts");
    update_set(&mut hasher, policy.forbidden_script_argument_starts);
    format!("{:x}", hasher.finalize())
}

fn validate_manim_default_source_profile(source: &str) -> Result<(), CompileFailureV1> {
    // Manim inserts each MathTex fragment before a same-line dvisvgm marker.
    // A raw `%` consumes that marker, while raw `#` is a TeX parameter token;
    // both fail in the pinned default template even when RaTeX accepts them.
    // Manim already wraps MathTex in a math environment, so raw `$` delimiters
    // fail there even though RaTeX strips them as a convenience.
    if contains_unescaped_template_marker(source) {
        return Err(syntax_unsupported());
    }
    let mut lexer = Lexer::new(source);
    let mut environment_stack = Vec::new();
    let mut left_environment_depths = Vec::new();
    let mut bare_line_break_end = None;
    loop {
        let token = lexer.lex();
        if token.is_eof() {
            return if environment_stack.is_empty() && left_environment_depths.is_empty() {
                Ok(())
            } else {
                Err(syntax_unsupported())
            };
        }
        // The pinned corpus covers only a bare `\\`. LaTeX consumes an
        // adjacent `*`, while RaTeX renders it, and the two implementations
        // disagree on accepted `[...]` dimensions. Keep those modifiers out
        // of the truthful-preview profile until they have parity evidence.
        if bare_line_break_end == Some(token.loc.start) && matches!(token.text.as_str(), "*" | "[")
        {
            return Err(syntax_unsupported());
        }
        bare_line_break_end = None;
        if matches!(token.text.as_str(), r"\begin" | r"\end") {
            let is_begin = token.text == r"\begin";
            let name = validate_manim_default_environment(&mut lexer, is_begin)?;
            if is_begin {
                environment_stack.push(name);
            } else if environment_stack.pop().as_deref() != Some(name.as_str()) {
                return Err(syntax_unsupported());
            }
        } else if MANIM_DEFAULT_ONE_BRACED_ARGUMENT_CONTROLS_V1.contains(&token.text.as_str()) {
            validate_required_braced_arguments(
                &source[token.loc.end..],
                1,
                MANIM_DEFAULT_ENVIRONMENT_FREE_ARGUMENT_CONTROLS_V1.contains(&token.text.as_str()),
            )?;
        } else if MANIM_DEFAULT_TWO_BRACED_ARGUMENT_CONTROLS_V1.contains(&token.text.as_str()) {
            validate_required_braced_arguments(&source[token.loc.end..], 2, false)?;
        } else if MANIM_DEFAULT_SCRIPT_PREFIX_TOKENS_V1.contains(&token.text.as_str()) {
            let mut argument_lexer = Lexer::new(&source[token.loc.end..]);
            let argument = next_non_space_token(&mut argument_lexer);
            if MANIM_DEFAULT_FORBIDDEN_SCRIPT_ARGUMENT_STARTS_V1.contains(&argument.text.as_str()) {
                return Err(syntax_unsupported());
            }
        } else if matches!(token.text.as_str(), r"\left" | r"\right") {
            validate_manim_default_delimiter(&source[token.loc.end..])?;
            if token.text == r"\left" {
                left_environment_depths.push(environment_stack.len());
            } else {
                let opening_environment_depth = left_environment_depths
                    .pop()
                    .ok_or_else(syntax_unsupported)?;
                if opening_environment_depth != environment_stack.len() {
                    return Err(syntax_unsupported());
                }
            }
        } else if !token.text.is_ascii()
            || (token.text.starts_with('\\')
                && !MANIM_DEFAULT_CONTROL_SEQUENCES_V1.contains(&token.text.as_str()))
        {
            return Err(syntax_unsupported());
        }
        if token.text == r"\\" {
            if left_environment_depths
                .last()
                .is_some_and(|depth| *depth == environment_stack.len())
            {
                return Err(syntax_unsupported());
            }
            bare_line_break_end = Some(token.loc.end);
        }
    }
}

fn validate_required_braced_arguments(
    source_after_command: &str,
    argument_count: usize,
    forbid_environments: bool,
) -> Result<(), CompileFailureV1> {
    let mut lexer = Lexer::new(source_after_command);
    for _ in 0..argument_count {
        if next_non_space_token(&mut lexer).text != "{" {
            return Err(syntax_unsupported());
        }
        let mut depth = 1usize;
        while depth > 0 {
            let token = lexer.lex();
            if token.is_eof()
                || token.text == r"\\"
                || (forbid_environments && matches!(token.text.as_str(), r"\begin" | r"\end"))
            {
                return Err(syntax_unsupported());
            }
            match token.text.as_str() {
                "{" => depth += 1,
                "}" => depth -= 1,
                _ => {}
            }
        }
    }
    Ok(())
}

fn validate_manim_default_delimiter(source_after_command: &str) -> Result<(), CompileFailureV1> {
    let mut lexer = Lexer::new(source_after_command);
    let delimiter = next_non_space_token(&mut lexer);
    if MANIM_DEFAULT_DELIMITER_TOKENS_V1.contains(&delimiter.text.as_str()) {
        Ok(())
    } else {
        Err(syntax_unsupported())
    }
}

fn next_non_space_token(lexer: &mut Lexer<'_>) -> ratex_lexer::Token {
    loop {
        let token = lexer.lex();
        if token.text != " " {
            return token;
        }
    }
}

fn contains_unescaped_template_marker(source: &str) -> bool {
    let mut preceding_backslashes = 0usize;
    for byte in source.bytes() {
        if byte == b'\\' {
            preceding_backslashes += 1;
            continue;
        }
        if matches!(byte, b'#' | b'%' | b'$') && preceding_backslashes.is_multiple_of(2) {
            return true;
        }
        preceding_backslashes = 0;
    }
    false
}

fn validate_manim_default_environment(
    lexer: &mut Lexer<'_>,
    is_begin: bool,
) -> Result<String, CompileFailureV1> {
    let open = lexer.lex();
    if open.text != "{" {
        return Err(syntax_unsupported());
    }

    let mut name = String::new();
    loop {
        let token = lexer.lex();
        if token.is_eof() {
            return Err(syntax_unsupported());
        }
        match token.text.as_str() {
            "}" => break,
            "{" => return Err(syntax_unsupported()),
            text if text.starts_with('\\') => return Err(syntax_unsupported()),
            text => name.push_str(text),
        }
    }
    if !MANIM_DEFAULT_ENVIRONMENTS_V1.contains(&name.as_str()) {
        return Err(syntax_unsupported());
    }
    if is_begin && name == "array" {
        validate_manim_default_array_columns(lexer)?;
    }
    Ok(name)
}

fn validate_manim_default_array_columns(lexer: &mut Lexer<'_>) -> Result<(), CompileFailureV1> {
    if lexer.lex().text != "{" {
        return Err(syntax_unsupported());
    }

    let mut column_count = 0usize;
    loop {
        let token = lexer.lex();
        match token.text.as_str() {
            "}" if column_count > 0 => return Ok(()),
            "l" | "c" | "r" => column_count += 1,
            "|" => {}
            _ => return Err(syntax_unsupported()),
        }
    }
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
            "MathTex layout contains an item unsupported by the v1 compiler",
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
    use std::collections::BTreeSet;

    use serde::Deserialize;

    use super::*;

    const MANIM_VISUAL_PARITY_CORPUS_JSON: &str =
        include_str!("../../../../fixtures/mathtex-manim-parity-v1/corpus.json");
    const MANIM_SOURCE_PROFILE_JSON: &str =
        include_str!("../../../../fixtures/mathtex-manim-parity-v1/source-profile.json");

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EvidenceCorpusV1 {
        cases: Vec<EvidenceCaseV1>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EvidenceCaseV1 {
        tex_parts: Vec<String>,
    }

    fn collect_evidenced_profile_tokens(
        source: &str,
        control_sequences: &mut BTreeSet<String>,
        environments: &mut BTreeSet<String>,
    ) {
        let mut lexer = Lexer::new(source);
        loop {
            let token = lexer.lex();
            if token.is_eof() {
                return;
            }
            if token.text.starts_with('\\') {
                control_sequences.insert(token.text.clone());
            }
            if matches!(token.text.as_str(), r"\begin" | r"\end") {
                assert_eq!(lexer.lex().text, "{", "evidence environment must open");
                let mut name = String::new();
                loop {
                    let name_token = lexer.lex();
                    assert!(!name_token.is_eof(), "evidence environment must close");
                    if name_token.text == "}" {
                        break;
                    }
                    name.push_str(&name_token.text);
                }
                environments.insert(name);
            }
        }
    }

    fn collect_evidenced_profile_grammar(
        source: &str,
        delimiters: &mut BTreeSet<String>,
        one_braced_argument_controls: &mut BTreeSet<String>,
        two_braced_argument_controls: &mut BTreeSet<String>,
        environment_free_argument_controls: &mut BTreeSet<String>,
        script_prefix_tokens: &mut BTreeSet<String>,
    ) {
        let mut lexer = Lexer::new(source);
        loop {
            let token = lexer.lex();
            if token.is_eof() {
                return;
            }
            if MANIM_DEFAULT_SCRIPT_PREFIX_TOKENS_V1.contains(&token.text.as_str()) {
                script_prefix_tokens.insert(token.text.clone());
            }
            if matches!(token.text.as_str(), r"\left" | r"\right") {
                let delimiter = next_non_space_token(&mut lexer);
                assert!(
                    !delimiter.is_eof(),
                    "evidence sized delimiter must have a delimiter token"
                );
                delimiters.insert(delimiter.text);
            } else if MANIM_DEFAULT_ONE_BRACED_ARGUMENT_CONTROLS_V1.contains(&token.text.as_str()) {
                let forbids_environments = MANIM_DEFAULT_ENVIRONMENT_FREE_ARGUMENT_CONTROLS_V1
                    .contains(&token.text.as_str());
                validate_required_braced_arguments(
                    &source[token.loc.end..],
                    1,
                    forbids_environments,
                )
                .expect("evidence must use the one-braced-argument profile shape");
                if forbids_environments {
                    environment_free_argument_controls.insert(token.text.clone());
                }
                one_braced_argument_controls.insert(token.text);
            } else if MANIM_DEFAULT_TWO_BRACED_ARGUMENT_CONTROLS_V1.contains(&token.text.as_str()) {
                validate_required_braced_arguments(&source[token.loc.end..], 2, false)
                    .expect("evidence must use the two-braced-argument profile shape");
                two_braced_argument_controls.insert(token.text);
            }
        }
    }

    #[test]
    fn raw_part_boundaries_and_whitespace_are_preserved_for_digesting() {
        let first = MathTexOutlineRequestV1::new(vec![" E ".to_owned(), "= mc^2  ".to_owned()]);
        let second = MathTexOutlineRequestV1::new(vec!["E = mc^2".to_owned()]);
        let first = validate_and_normalize_request(&first).expect("supported");
        let second = validate_and_normalize_request(&second).expect("supported");
        assert_ne!(first.expression, second.expression);
        assert_ne!(
            content_digest_v1(&first.digest_parts),
            content_digest_v1(&second.digest_parts)
        );
    }

    #[test]
    fn parser_input_and_digest_preserve_semantic_text_whitespace() {
        let compact = MathTexOutlineRequestV1::new(vec![r"\text{a b}".to_owned()]);
        let expanded = MathTexOutlineRequestV1::new(vec![r"\text{a  b}".to_owned()]);
        let compact = validate_and_normalize_request(&compact).expect("supported");
        let expanded = validate_and_normalize_request(&expanded).expect("supported");
        assert_eq!(compact.expression, r"\text{a b}");
        assert_eq!(expanded.expression, r"\text{a  b}");
        assert_ne!(
            content_digest_v1(&compact.digest_parts),
            content_digest_v1(&expanded.digest_parts)
        );
    }

    #[test]
    fn comments_at_a_part_boundary_fail_closed_under_the_manim_profile() {
        let request =
            MathTexOutlineRequestV1::new(vec!["x% comment\n".to_owned(), "+y".to_owned()]);
        let failure =
            validate_and_normalize_request(&request).expect_err("comments are out of profile");
        assert_eq!(
            failure.code,
            MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported
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

    #[test]
    fn transport_validation_does_not_reimplement_tex_lexing() {
        validate_transport_characters("x % } is a comment\n+ y")
            .expect("comments are the parser's responsibility");
        validate_transport_characters(r"\verb|{|").expect("verb is the parser's responsibility");
    }

    #[test]
    fn transport_validation_rejects_nul_and_non_whitespace_controls() {
        assert!(validate_transport_characters("x\0y").is_err());
        assert!(validate_transport_characters("x\u{0007}y").is_err());
        validate_transport_characters("x\n\ty").expect("ASCII whitespace is valid TeX input");
    }

    #[test]
    fn macro_namespace_mutation_and_indirection_controls_are_outside_the_source_profile() {
        for command in [
            r"\global",
            r"\long",
            r"\def",
            r"\gdef",
            r"\edef",
            r"\xdef",
            r"\let",
            r"\futurelet",
            r"\newcommand",
            r"\renewcommand",
            r"\providecommand",
            r"\csname",
            r"\endcsname",
            r"\catcode",
        ] {
            assert!(
                validate_manim_default_source_profile(&format!("x {command} y")).is_err(),
                "{command} must fail closed"
            );
        }
    }

    #[test]
    fn source_profile_respects_control_word_boundaries() {
        for source in [
            r"x + \\ + y",
            r"\frac{a}{b} + \sqrt{x} + \text{ordinary builtins remain}",
        ] {
            validate_manim_default_source_profile(source)
                .unwrap_or_else(|_| panic!("safe source was rejected: {source}"));
        }
        for source in [r"\alphabeta", r"\verb|x|", r"\definition"] {
            assert!(
                validate_manim_default_source_profile(source).is_err(),
                "unsupported control word must not match an allowed prefix: {source}"
            );
        }
    }

    #[test]
    fn ratex_extensions_outside_default_manim_fail_closed() {
        for source in [
            r"\htmlStyle{font-size:2em}{x}",
            r"\htmlClass{hero}{x}",
            r"\href{https://example.test}{x}",
            r"\url{https://example.test}",
            r"\ce{H2O}",
            r"\pu{123 kJ/mol}",
            r"\KaTeX",
        ] {
            assert!(
                validate_manim_default_source_profile(source).is_err(),
                "RaTeX-only source must not be presented as default-Manim-compatible: {source}"
            );
        }
    }

    #[test]
    fn raw_unicode_rejected_by_pinned_pdflatex_is_outside_the_source_profile() {
        for source in ["α", "∑", "√x", "é", "ℝ"] {
            assert!(
                validate_manim_default_source_profile(source).is_err(),
                "raw Unicode must not bypass the default-Manim source profile: {source}"
            );
        }
    }

    #[test]
    fn raw_tex_parameter_comment_and_math_markers_are_outside_the_source_profile() {
        for source in ["x#y", "x%y", "x % comment\n+y", "$x$", "$$x$$"] {
            assert!(validate_manim_default_source_profile(source).is_err());
        }
    }

    #[test]
    fn pinned_control_symbol_escapes_do_not_become_raw_template_markers() {
        validate_manim_default_source_profile(r"\#\;\%\;\$\;\_\;\&")
            .expect("pinned control-symbol escapes");
        for source in [r"\\#", r"\\%", r"\\$", r"\\\\#"] {
            assert!(
                validate_manim_default_source_profile(source).is_err(),
                "an even backslash run leaves a raw template marker: {source}"
            );
        }
    }

    #[test]
    fn only_bare_pinned_line_breaks_are_accepted() {
        validate_manim_default_source_profile(r"a\\b").expect("pinned bare line break");
        validate_manim_default_source_profile(r"a\\ *b")
            .expect("spaced star is ordinary visible syntax");
        for source in [r"a\\*b", r"a\\[1pt]b", r"a\\[1mu]b", r"a\\[20000pt]b"] {
            assert!(validate_manim_default_source_profile(source).is_err());
        }
    }

    #[test]
    fn only_pinned_inner_environments_are_accepted() {
        validate_manim_default_source_profile(r"\begin{array}{cc}a & b \\ c & d\end{array}")
            .expect("pinned array environment");
        validate_manim_default_source_profile(r"\begin{array}{|c|}a\end{array}")
            .expect("pinned ruled array columns");
        validate_manim_default_source_profile(r"\begin{bmatrix}a & b\end{bmatrix}")
            .expect("pinned bmatrix environment");
        validate_manim_default_source_profile(r"\begin{matrix}a & b\end{matrix}")
            .expect("pinned matrix environment");
        validate_manim_default_source_profile(r"\begin{pmatrix}a & b\end{pmatrix}")
            .expect("pinned pmatrix environment");
        validate_manim_default_source_profile(
            r"\begin{cases}x & \text{if }x>0\\-x & \text{if }x<0\end{cases}",
        )
        .expect("pinned cases environment");
        validate_manim_default_source_profile(r"\begin{aligned}x&=1\\y&=2\end{aligned}")
            .expect("pinned aligned environment");
        for source in [
            r"\begin{prooftree}\end{prooftree}",
            r"\begin{align}a=b\end{align}",
            r"\begin{array}{c}x\end{matrix}",
            r"\begin{array}{c:c}a & b\end{array}",
            r"\begin{array}{:}a\end{array}",
            r"\begin{array}{||}a\end{array}",
        ] {
            assert!(validate_manim_default_source_profile(source).is_err());
        }
    }

    #[test]
    fn sized_delimiters_rejected_by_pinned_manim_fail_closed() {
        for source in [
            r"\left x \right)",
            r"\left( x \right y",
            r"\left(x\\y\right)",
            r"\begin{matrix}\left(x\\y\right)\end{matrix}",
            r"\begin{array}{c}\left(x\\y\right)\end{array}",
            r"\left(x",
            r"x\right)",
            r"\left|x\right|",
        ] {
            assert!(
                validate_manim_default_source_profile(source).is_err(),
                "invalid command shape must fail closed: {source}"
            );
        }
        for source in [
            r"\left(x\right)",
            r"\left[ x \right]",
            r"\left\{x\right\}",
            r"\left[\begin{array}{cc}a&b\\c&d\end{array}\right]",
        ] {
            validate_manim_default_source_profile(source)
                .unwrap_or_else(|_| panic!("valid command shape was rejected: {source}"));
        }
    }

    #[test]
    fn evidenced_single_argument_commands_require_braces() {
        for source in [
            r"\hat\\",
            r"\hat{\\}",
            r"\vec\\",
            r"\vec{\\}",
            r"\sqrt}",
            r"\sqrt\begin{matrix}x\end{matrix}",
            r"\sqrt&",
            r"\sqrt{\\}",
        ] {
            assert!(
                validate_manim_default_source_profile(source).is_err(),
                "unbraced argument rejected by pinned Manim must fail closed: {source}"
            );
        }
        for source in [r"\hat{x}", r"\vec{v}", r"\sqrt{x}", r"\sqrt{\sqrt{x}}"] {
            validate_manim_default_source_profile(source)
                .unwrap_or_else(|_| panic!("evidenced braced argument was rejected: {source}"));
        }
    }

    #[test]
    fn evidenced_text_and_fraction_argument_shapes_fail_closed() {
        for source in [
            r"\text{\begin{matrix}x\end{matrix}}",
            r"\text{\begin{matrix}x\\y\end{matrix}}",
            r"\textbf{\begin{matrix}x\end{matrix}}",
            r"\textbf{\begin{matrix}x\\y\end{matrix}}",
            r"\frac{\\}{b}",
            r"\frac{a}{\\}",
        ] {
            assert!(
                validate_manim_default_source_profile(source).is_err(),
                "argument shape rejected by pinned Manim must fail closed: {source}"
            );
        }
        for source in [r"\text{plain text}", r"\textbf{bold}", r"\frac{a}{b}"] {
            validate_manim_default_source_profile(source)
                .unwrap_or_else(|_| panic!("evidenced argument shape was rejected: {source}"));
        }
    }

    #[test]
    fn invalid_script_argument_starts_fail_closed() {
        for source in [
            r"x^}",
            r"x_}",
            r"x^&",
            r"x_&",
            r"x^\begin{matrix}x\end{matrix}",
            r"x_\begin{matrix}x\end{matrix}",
            r"x^\begin{matrix}x\\y\end{matrix}",
            r"x_\begin{matrix}x\\y\end{matrix}",
        ] {
            assert!(
                validate_manim_default_source_profile(source).is_err(),
                "script shape rejected by pinned Manim must fail closed: {source}"
            );
        }
        for source in [r"x^2", r"x_i", r"x^{}", r"x^\&", r"x^{\frac{a}{b}}"] {
            validate_manim_default_source_profile(source)
                .unwrap_or_else(|_| panic!("valid script shape was rejected: {source}"));
        }
    }

    #[test]
    fn every_allowlisted_profile_token_has_checked_in_manim_evidence() {
        let visual_corpus: EvidenceCorpusV1 = serde_json::from_str(MANIM_VISUAL_PARITY_CORPUS_JSON)
            .expect("pinned Manim visual corpus must be valid JSON");
        let profile: EvidenceCorpusV1 = serde_json::from_str(MANIM_SOURCE_PROFILE_JSON)
            .expect("Manim source-profile evidence must be valid JSON");
        let mut control_sequences = BTreeSet::new();
        let mut environments = BTreeSet::new();
        let mut delimiters = BTreeSet::new();
        let mut one_braced_argument_controls = BTreeSet::new();
        let mut two_braced_argument_controls = BTreeSet::new();
        let mut environment_free_argument_controls = BTreeSet::new();
        let mut script_prefix_tokens = BTreeSet::new();
        for case in visual_corpus.cases.into_iter().chain(profile.cases) {
            let source = case.tex_parts.join(" ");
            collect_evidenced_profile_tokens(&source, &mut control_sequences, &mut environments);
            collect_evidenced_profile_grammar(
                &source,
                &mut delimiters,
                &mut one_braced_argument_controls,
                &mut two_braced_argument_controls,
                &mut environment_free_argument_controls,
                &mut script_prefix_tokens,
            );
        }

        let missing_controls = MANIM_DEFAULT_CONTROL_SEQUENCES_V1
            .iter()
            .copied()
            .filter(|control| !control_sequences.contains(*control))
            .collect::<Vec<_>>();
        assert!(
            missing_controls.is_empty(),
            "allowlisted controls without pinned Manim evidence: {missing_controls:?}"
        );
        let missing_environments = MANIM_DEFAULT_ENVIRONMENTS_V1
            .iter()
            .copied()
            .filter(|environment| !environments.contains(*environment))
            .collect::<Vec<_>>();
        assert!(
            missing_environments.is_empty(),
            "allowlisted environments without pinned Manim evidence: {missing_environments:?}"
        );
        let missing_delimiters = MANIM_DEFAULT_DELIMITER_TOKENS_V1
            .iter()
            .copied()
            .filter(|delimiter| !delimiters.contains(*delimiter))
            .collect::<Vec<_>>();
        assert!(
            missing_delimiters.is_empty(),
            "allowlisted sized delimiters without pinned Manim evidence: {missing_delimiters:?}"
        );
        let missing_one_braced_controls = MANIM_DEFAULT_ONE_BRACED_ARGUMENT_CONTROLS_V1
            .iter()
            .copied()
            .filter(|control| !one_braced_argument_controls.contains(*control))
            .collect::<Vec<_>>();
        assert!(
            missing_one_braced_controls.is_empty(),
            "one-braced-argument controls without pinned Manim evidence: {missing_one_braced_controls:?}"
        );
        let missing_two_braced_controls = MANIM_DEFAULT_TWO_BRACED_ARGUMENT_CONTROLS_V1
            .iter()
            .copied()
            .filter(|control| !two_braced_argument_controls.contains(*control))
            .collect::<Vec<_>>();
        assert!(
            missing_two_braced_controls.is_empty(),
            "two-braced-argument controls without pinned Manim evidence: {missing_two_braced_controls:?}"
        );
        let missing_environment_free_controls = MANIM_DEFAULT_ENVIRONMENT_FREE_ARGUMENT_CONTROLS_V1
            .iter()
            .copied()
            .filter(|control| !environment_free_argument_controls.contains(*control))
            .collect::<Vec<_>>();
        assert!(
            missing_environment_free_controls.is_empty(),
            "environment-free argument controls without pinned Manim evidence: {missing_environment_free_controls:?}"
        );
        let missing_script_prefixes = MANIM_DEFAULT_SCRIPT_PREFIX_TOKENS_V1
            .iter()
            .copied()
            .filter(|prefix| !script_prefix_tokens.contains(*prefix))
            .collect::<Vec<_>>();
        assert!(
            missing_script_prefixes.is_empty(),
            "script prefixes without pinned Manim evidence: {missing_script_prefixes:?}"
        );
    }

    fn assert_canonical_identity_set(
        values: &[&str],
        addition: &str,
        digest_for: impl Fn(&[&str]) -> String,
    ) {
        let baseline = manim_default_source_profile_digest_v1();
        let mut reordered = values.to_vec();
        reordered.reverse();
        assert_eq!(baseline, digest_for(&reordered));
        assert!(!values.is_empty());
        assert_ne!(baseline, digest_for(&values[..values.len() - 1]));
        let mut extended = values.to_vec();
        extended.push(addition);
        assert_ne!(baseline, digest_for(&extended));
    }

    #[test]
    fn source_profile_digest_is_canonical_and_tracks_top_level_sets() {
        let baseline = manim_default_source_profile_digest_v1();
        assert_eq!(baseline.len(), 64);
        assert!(baseline.bytes().all(|byte| byte.is_ascii_hexdigit()));

        assert_canonical_identity_set(MANIM_DEFAULT_CONTROL_SEQUENCES_V1, r"\zeta", |values| {
            source_profile_digest_v1(SourceProfilePolicyV1 {
                control_sequences: values,
                ..default_source_profile_policy_v1()
            })
        });
        assert_canonical_identity_set(MANIM_DEFAULT_ENVIRONMENTS_V1, "gathered", |values| {
            source_profile_digest_v1(SourceProfilePolicyV1 {
                environments: values,
                ..default_source_profile_policy_v1()
            })
        });
        assert_ne!(
            baseline,
            source_profile_digest_v1(SourceProfilePolicyV1 {
                revision: "core-ams-v4",
                ..default_source_profile_policy_v1()
            }),
            "policy revision must invalidate the profile identity"
        );
    }

    #[test]
    fn source_profile_digest_tracks_delimiter_and_argument_grammar() {
        assert_canonical_identity_set(MANIM_DEFAULT_DELIMITER_TOKENS_V1, "|", |values| {
            source_profile_digest_v1(SourceProfilePolicyV1 {
                delimiter_tokens: values,
                ..default_source_profile_policy_v1()
            })
        });
        assert_canonical_identity_set(
            MANIM_DEFAULT_ONE_BRACED_ARGUMENT_CONTROLS_V1,
            r"\mathrm",
            |values| {
                source_profile_digest_v1(SourceProfilePolicyV1 {
                    one_braced_argument_controls: values,
                    ..default_source_profile_policy_v1()
                })
            },
        );
        assert_canonical_identity_set(
            MANIM_DEFAULT_TWO_BRACED_ARGUMENT_CONTROLS_V1,
            r"\dfrac",
            |values| {
                source_profile_digest_v1(SourceProfilePolicyV1 {
                    two_braced_argument_controls: values,
                    ..default_source_profile_policy_v1()
                })
            },
        );
        assert_canonical_identity_set(
            MANIM_DEFAULT_ENVIRONMENT_FREE_ARGUMENT_CONTROLS_V1,
            r"\operatorname",
            |values| {
                source_profile_digest_v1(SourceProfilePolicyV1 {
                    environment_free_argument_controls: values,
                    ..default_source_profile_policy_v1()
                })
            },
        );
    }

    #[test]
    fn source_profile_digest_tracks_script_grammar() {
        assert_canonical_identity_set(MANIM_DEFAULT_SCRIPT_PREFIX_TOKENS_V1, "'", |values| {
            source_profile_digest_v1(SourceProfilePolicyV1 {
                script_prefix_tokens: values,
                ..default_source_profile_policy_v1()
            })
        });
        assert_canonical_identity_set(
            MANIM_DEFAULT_FORBIDDEN_SCRIPT_ARGUMENT_STARTS_V1,
            r"\end",
            |values| {
                source_profile_digest_v1(SourceProfilePolicyV1 {
                    forbidden_script_argument_starts: values,
                    ..default_source_profile_policy_v1()
                })
            },
        );
    }
}
