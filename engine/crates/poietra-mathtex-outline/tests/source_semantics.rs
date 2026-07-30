use poietra_mathtex_outline::{
    MathTexOutlineRequestV1, MathTexOutlineResultV1, MathTexOutlineUnsupportedCodeV1,
    compile_mathtex_outline_v1,
};

fn compiled(tex_parts: &[&str]) -> poietra_scene_ir::CubicPathV1 {
    let request =
        MathTexOutlineRequestV1::new(tex_parts.iter().map(|part| (*part).to_owned()).collect());
    let MathTexOutlineResultV1::Compiled(artifact) = compile_mathtex_outline_v1(&request) else {
        panic!("representative source must compile: {tex_parts:?}");
    };
    artifact.path
}

#[test]
fn raw_template_markers_fail_closed_like_pinned_manim() {
    for parts in [
        vec!["x%y"],
        vec!["x% comment\n", "+y"],
        vec!["x#y"],
        vec!["$x$"],
    ] {
        let request = MathTexOutlineRequestV1::new(parts.into_iter().map(str::to_owned).collect());
        let MathTexOutlineResultV1::Unsupported(unsupported) = compile_mathtex_outline_v1(&request)
        else {
            panic!("raw TeX marker must not compile");
        };
        assert_eq!(
            unsupported.code,
            MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported
        );
    }
}

#[test]
fn unevidenced_line_break_modifiers_fail_closed() {
    assert!(!compiled(&[r"a\\b"]).subpaths.is_empty());
    for source in [r"a\\*b", r"a\\[1pt]b", r"a\\[1mu]b"] {
        let request = MathTexOutlineRequestV1::new(vec![source.to_owned()]);
        let MathTexOutlineResultV1::Unsupported(unsupported) = compile_mathtex_outline_v1(&request)
        else {
            panic!("line-break modifier must remain outside the pinned profile: {source}");
        };
        assert_eq!(
            unsupported.code,
            MathTexOutlineUnsupportedCodeV1::SyntaxUnsupported
        );
    }
}

#[test]
fn escaped_braces_and_part_spanning_groups_remain_valid_mathtex() {
    assert!(!compiled(&[r"\left\{x\right\}"]).subpaths.is_empty());
    assert!(!compiled(&["e^{i", r"\tau} = 1"]).subpaths.is_empty());
}
