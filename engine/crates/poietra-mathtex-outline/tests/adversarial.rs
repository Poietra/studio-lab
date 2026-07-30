use std::panic::{AssertUnwindSafe, catch_unwind};

use poietra_mathtex_outline::{
    MAX_MATHTEX_PARTS_V1, MAX_MATHTEX_SOURCE_BYTES_V1, MAX_MATHTEX_UNSUPPORTED_MESSAGE_BYTES_V1,
    MathTexOutlineRequestV1, MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1,
    compile_mathtex_outline_v1,
};
use poietra_scene_ir::PointV1;

// Mirrors the public WASM response ceiling without making the core test crate
// depend on its wrapper (which already depends on this crate).
const MAX_RESPONSE_JSON_BYTES_V1: usize = 1024 * 1024;

fn compile_without_panic(parts: Vec<String>) -> MathTexOutlineResultV1 {
    let request = MathTexOutlineRequestV1::new(parts);
    catch_unwind(AssertUnwindSafe(|| compile_mathtex_outline_v1(&request)))
        .expect("adversarial MathTex input must not panic")
}

fn compile_deterministically(parts: Vec<String>) -> MathTexOutlineResultV1 {
    let first = compile_without_panic(parts.clone());
    let second = compile_without_panic(parts);
    assert_eq!(
        first, second,
        "the same request must produce the same result"
    );
    assert_bounded_result(&first);
    first
}

fn assert_finite_point(point: &PointV1) {
    assert!(point.x.is_finite(), "outline x coordinate must be finite");
    assert!(point.y.is_finite(), "outline y coordinate must be finite");
}

fn assert_bounded_result(result: &MathTexOutlineResultV1) {
    let wire = serde_json::to_vec(result)
        .expect("a result containing only finite coordinates must serialize");
    assert!(
        wire.len() <= MAX_RESPONSE_JSON_BYTES_V1,
        "core result must fit the browser response ceiling"
    );

    match result {
        MathTexOutlineResultV1::Unsupported(unsupported) => {
            assert!(!unsupported.message.is_empty());
            assert!(unsupported.message.len() <= MAX_MATHTEX_UNSUPPORTED_MESSAGE_BYTES_V1);
        }
        MathTexOutlineResultV1::Compiled(artifact) => {
            for coordinate in [
                artifact.bounds.left,
                artifact.bounds.right,
                artifact.bounds.bottom,
                artifact.bounds.top,
            ] {
                assert!(coordinate.is_finite(), "outline bounds must be finite");
            }
            assert!(artifact.bounds.left <= artifact.bounds.right);
            assert!(artifact.bounds.bottom <= artifact.bounds.top);

            let mut segment_count = 0usize;
            for subpath in &artifact.path.subpaths {
                assert!(subpath.closed, "MathTex glyph contours must remain closed");
                assert_finite_point(&subpath.start);
                segment_count = segment_count
                    .checked_add(subpath.segments.len())
                    .expect("segment accounting must not overflow");
                for segment in &subpath.segments {
                    assert_finite_point(&segment.control1);
                    assert_finite_point(&segment.control2);
                    assert_finite_point(&segment.end);
                }
            }
            assert!(
                segment_count <= 2_048,
                "compiled geometry must remain hard bounded"
            );
        }
    }
}

fn assert_structured_fallback(parts: Vec<String>) -> MathTexOutlineUnsupportedCodeV1 {
    let MathTexOutlineResultV1::Unsupported(unsupported) = compile_deterministically(parts) else {
        panic!("adversarial MathTex input must fail closed");
    };
    unsupported.code
}

#[test]
fn parser_depth_macro_repetition_and_malformed_inputs_fail_closed() {
    // RaTeX's parser accepts at most 32 levels. Keep this at limit + 1 rather
    // than carrying an expensive stack-overflow-sized fixture in our suite.
    let nested = format!("{}x{}", "{".repeat(33), "}".repeat(33));
    let recursive_macro = r"\def\poietraLoop{\poietraLoop}\poietraLoop".to_owned();
    let repeated_glyphs = "x".repeat(65);

    for source in [
        nested,
        recursive_macro,
        repeated_glyphs,
        r"\poietraDefinitelyUnknown{x}".to_owned(),
        "{x".to_owned(),
        "x}".to_owned(),
    ] {
        assert_structured_fallback(vec![source]);
    }
}

#[test]
fn parameter_macro_amplifiers_are_rejected_before_expansion() {
    fn amplifier(parameter_copies: usize, argument_bytes: usize) -> String {
        format!(
            "\\def\\a#1{{{}}}\\a{{{}}}",
            "#1".repeat(parameter_copies),
            "x".repeat(argument_bytes)
        )
    }

    // An 864-byte request would otherwise substitute the 250-byte argument
    // 300 times, constructing 75,000 tokens in a single counted expansion.
    let reviewer_fixture = amplifier(300, 250);
    assert_eq!(reviewer_fixture.len(), 864);
    assert_eq!(
        assert_structured_fallback(vec![reviewer_fixture.clone()]),
        MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported
    );
    assert_eq!(
        assert_structured_fallback(vec![format!(r"\url{{{reviewer_fixture}}}")]),
        MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported,
        "URL string materialization must not execute the amplifier"
    );

    // Exercise the same shape close to the 2 KiB public source ceiling. This
    // would construct 300,000 tokens without consuming additional expansion
    // budget; the deterministic fallback proves it never reaches RaTeX.
    let near_limit_fixture = amplifier(600, 500);
    assert_eq!(near_limit_fixture.len(), 1_714);
    assert_eq!(
        assert_structured_fallback(vec![near_limit_fixture.clone()]),
        MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported
    );
    assert_eq!(
        assert_structured_fallback(vec![format!(r"\href{{{near_limit_fixture}}}{{x}}")]),
        MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported,
        "href URL materialization must not execute the amplifier"
    );
}

#[test]
fn source_and_part_limits_return_the_exact_bounded_failure() {
    let oversized_source = "x".repeat(MAX_MATHTEX_SOURCE_BYTES_V1 + 1);
    assert_eq!(
        assert_structured_fallback(vec![oversized_source]),
        MathTexOutlineUnsupportedCodeV1::RequestTooLarge
    );

    let too_many_parts = vec!["x".to_owned(); MAX_MATHTEX_PARTS_V1 + 1];
    assert_eq!(
        assert_structured_fallback(too_many_parts),
        MathTexOutlineUnsupportedCodeV1::RequestTooLarge
    );

    // The contract is UTF-8 bytes, not scalar-value count.
    let oversized_multibyte_source = "é".repeat(MAX_MATHTEX_SOURCE_BYTES_V1 / 2 + 1);
    assert_eq!(
        assert_structured_fallback(vec![oversized_multibyte_source]),
        MathTexOutlineUnsupportedCodeV1::RequestTooLarge
    );
}

#[test]
fn compiled_outline_coordinates_are_always_finite_and_deterministic() {
    let result = compile_deterministically(vec!["E = mc^2".to_owned()]);
    assert!(
        matches!(result, MathTexOutlineResultV1::Compiled(_)),
        "the finite-coordinate assertion must exercise an actual outline"
    );
}
