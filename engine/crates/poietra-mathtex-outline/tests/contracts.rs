use poietra_mathtex_outline::{
    MATHTEX_FONT_DIGEST_V1, MathTexOutlineRequestV1, MathTexOutlineResultV1,
    MathTexOutlineUnsupportedCodeV1, compile_mathtex_outline_v1,
};
use poietra_scene_ir::FillRuleV1;

fn compile(tex_parts: &[&str]) -> MathTexOutlineResultV1 {
    compile_mathtex_outline_v1(&MathTexOutlineRequestV1::new(
        tex_parts.iter().map(|part| (*part).to_owned()).collect(),
    ))
}

fn assert_sha256(digest: &str) {
    assert_eq!(digest.len(), 64);
    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
}

#[test]
fn representative_mathtex_compiles_to_a_centered_bounded_outline() {
    let MathTexOutlineResultV1::Compiled(artifact) = compile(&["E", "=", "m", "c^2"]) else {
        panic!("representative MathTex expression must compile");
    };

    assert_eq!(artifact.fill_rule, FillRuleV1::NonZero);
    assert_eq!(artifact.font_digest, MATHTEX_FONT_DIGEST_V1);
    assert!(
        artifact.path.subpaths.len() > 5,
        "glyph counters remain separate contours"
    );
    let segment_count = artifact
        .path
        .subpaths
        .iter()
        .map(|subpath| subpath.segments.len())
        .sum::<usize>();
    assert!((1..=2_048).contains(&segment_count));
    assert!(artifact.path.subpaths.iter().all(|subpath| subpath.closed));
    assert!((artifact.bounds.top - artifact.bounds.bottom - 1.0).abs() <= 2.0e-6);
    assert!((artifact.bounds.left + artifact.bounds.right).abs() <= 2.0e-6);
    assert!((artifact.bounds.bottom + artifact.bounds.top).abs() <= 2.0e-6);
    assert_sha256(&artifact.content_digest);
    assert_sha256(&artifact.toolchain_digest);
    assert_sha256(&artifact.font_digest);

    let wire = serde_json::to_value(MathTexOutlineResultV1::Compiled(artifact))
        .expect("result must serialize");
    assert_eq!(wire["kind"], "compiled");
    assert_eq!(wire["fillRule"], "nonzero");
    assert!(
        wire.get("artifact").is_none(),
        "compiled payload stays flat"
    );
}

#[test]
fn content_edit_changes_the_retained_outline_and_revision_digest() {
    let MathTexOutlineResultV1::Compiled(two) = compile(&["E = mc^2"]) else {
        panic!("representative MathTex expression must compile");
    };
    let MathTexOutlineResultV1::Compiled(three) = compile(&["E = mc^3"]) else {
        panic!("edited MathTex expression must compile");
    };
    assert_ne!(two.content_digest, three.content_digest);
    assert_ne!(two.path, three.path);
    assert_eq!(two.toolchain_digest, three.toolchain_digest);
    assert_eq!(two.font_digest, three.font_digest);
}

#[test]
fn unsupported_mathtex_returns_a_small_structured_fallback() {
    let MathTexOutlineResultV1::Unsupported(unsupported) = compile(&[r"\frac{1}{2}"]) else {
        panic!("out-of-scope syntax must not compile");
    };
    assert_eq!(
        unsupported.code,
        MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported
    );
    assert!(unsupported.message.len() <= 512);
    let wire = serde_json::to_value(MathTexOutlineResultV1::Unsupported(unsupported))
        .expect("fallback must serialize");
    assert_eq!(wire["kind"], "unsupported");
    assert!(wire.get("path").is_none());
}
