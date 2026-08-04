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
const MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1: &str = "core-ams-v1";
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

/// Returns a canonical digest of the executable default-Manim source profile.
///
/// The allowlisted control sequences and environments are sorted and deduplicated before
/// length-framing, so source ordering does not affect the identity. This digest is kept separate
/// from the toolchain digest until the pending font/toolchain update is integrated once.
#[must_use]
pub fn manim_default_source_profile_digest_v1() -> String {
    source_profile_digest_v1(
        MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1,
        MANIM_DEFAULT_CONTROL_SEQUENCES_V1,
        MANIM_DEFAULT_ENVIRONMENTS_V1,
    )
}

fn source_profile_digest_v1(
    policy_revision: &str,
    control_sequences: &[&str],
    environments: &[&str],
) -> String {
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
    update_frame(&mut hasher, policy_revision.as_bytes());
    update_set(&mut hasher, control_sequences);
    update_set(&mut hasher, environments);
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
    let mut bare_line_break_end = None;
    loop {
        let token = lexer.lex();
        if token.is_eof() {
            return if environment_stack.is_empty() {
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
        } else if !token.text.is_ascii()
            || (token.text.starts_with('\\')
                && !MANIM_DEFAULT_CONTROL_SEQUENCES_V1.contains(&token.text.as_str()))
        {
            return Err(syntax_unsupported());
        }
        if token.text == r"\\" {
            bare_line_break_end = Some(token.loc.end);
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

    const MANIM_CALLSITE_CORPUS_JSON: &str =
        include_str!("../../../../fixtures/mathtex-v1/manim-corpus.json");
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
    fn every_allowlisted_profile_token_has_checked_in_manim_evidence() {
        let callsites: EvidenceCorpusV1 = serde_json::from_str(MANIM_CALLSITE_CORPUS_JSON)
            .expect("Manim call-site corpus must be valid JSON");
        let profile: EvidenceCorpusV1 = serde_json::from_str(MANIM_SOURCE_PROFILE_JSON)
            .expect("Manim source-profile evidence must be valid JSON");
        let mut control_sequences = BTreeSet::new();
        let mut environments = BTreeSet::new();
        for case in callsites.cases.into_iter().chain(profile.cases) {
            collect_evidenced_profile_tokens(
                &case.tex_parts.join(" "),
                &mut control_sequences,
                &mut environments,
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
    }

    #[test]
    fn source_profile_digest_tracks_policy_controls_and_environments_canonically() {
        let baseline = manim_default_source_profile_digest_v1();
        assert_eq!(baseline.len(), 64);
        assert!(baseline.bytes().all(|byte| byte.is_ascii_hexdigit()));

        let mut reordered_controls = MANIM_DEFAULT_CONTROL_SEQUENCES_V1.to_vec();
        reordered_controls.reverse();
        let mut reordered_environments = MANIM_DEFAULT_ENVIRONMENTS_V1.to_vec();
        reordered_environments.reverse();
        assert_eq!(
            baseline,
            source_profile_digest_v1(
                MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1,
                &reordered_controls,
                &reordered_environments,
            ),
            "source order is not part of the canonical profile identity"
        );

        let controls_without_last =
            &MANIM_DEFAULT_CONTROL_SEQUENCES_V1[..MANIM_DEFAULT_CONTROL_SEQUENCES_V1.len() - 1];
        assert_ne!(
            baseline,
            source_profile_digest_v1(
                MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1,
                controls_without_last,
                MANIM_DEFAULT_ENVIRONMENTS_V1,
            ),
            "removing a control sequence must invalidate the profile identity"
        );
        let mut controls_with_addition = MANIM_DEFAULT_CONTROL_SEQUENCES_V1.to_vec();
        controls_with_addition.push(r"\zeta");
        assert_ne!(
            baseline,
            source_profile_digest_v1(
                MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1,
                &controls_with_addition,
                MANIM_DEFAULT_ENVIRONMENTS_V1,
            ),
            "adding a control sequence must invalidate the profile identity"
        );

        let environments_without_last =
            &MANIM_DEFAULT_ENVIRONMENTS_V1[..MANIM_DEFAULT_ENVIRONMENTS_V1.len() - 1];
        assert_ne!(
            baseline,
            source_profile_digest_v1(
                MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1,
                MANIM_DEFAULT_CONTROL_SEQUENCES_V1,
                environments_without_last,
            ),
            "removing an environment must invalidate the profile identity"
        );
        let mut environments_with_addition = MANIM_DEFAULT_ENVIRONMENTS_V1.to_vec();
        environments_with_addition.push("gathered");
        assert_ne!(
            baseline,
            source_profile_digest_v1(
                MANIM_DEFAULT_SOURCE_PROFILE_REVISION_V1,
                MANIM_DEFAULT_CONTROL_SEQUENCES_V1,
                &environments_with_addition,
            ),
            "adding an environment must invalidate the profile identity"
        );
        assert_ne!(
            baseline,
            source_profile_digest_v1(
                "core-ams-v2",
                MANIM_DEFAULT_CONTROL_SEQUENCES_V1,
                MANIM_DEFAULT_ENVIRONMENTS_V1,
            ),
            "policy revision must invalidate the profile identity"
        );
    }
}
