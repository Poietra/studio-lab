use std::collections::BTreeSet;

use poietra_mathtex_outline::{
    MathTexOutlineRequestV1, MathTexOutlineResultV1, compile_mathtex_outline_v1,
    manim_default_source_profile_digest_v1,
};
use serde::Deserialize;

const SOURCE_PROFILE_JSON: &str =
    include_str!("../../../../fixtures/mathtex-manim-parity-v1/source-profile.json");
const EXPECTED_MANIM_IMAGE: &str =
    "manimcommunity/manim@sha256:f18f53f2e4eaf2ea41713437d34363fb3f5cc6008b03fd798676ac0359396c3b";
const EXPECTED_CASE_IDS: &[&str] = &[
    "aligned-inner-environment",
    "array-inner-environment",
    "bmatrix-inner-environment",
    "calculus-and-large-operators",
    "cases-inner-environment",
    "core-fonts-and-named-operator",
    "fractions-radicals-over-and-delimiters",
    "greek-lowercase-core",
    "greek-uppercase-core",
    "matrix-inner-environment",
    "pmatrix-inner-environment",
    "safe-control-symbol-escapes",
    "sets-relations-and-logic",
    "trigonometric-and-log-operators",
    "vector-fields-and-accents",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceProfileV1 {
    schema: String,
    version: u32,
    profile: String,
    reference_producer: ReferenceProducerV1,
    cases: Vec<SourceProfileCaseV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReferenceProducerV1 {
    kind: String,
    docker_image: String,
    manim_version: String,
    latex_version: String,
    dvisvgm_version: String,
    tex_compiler: String,
    tex_template_sha256: String,
    generation_command: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceProfileCaseV1 {
    id: String,
    tex_parts: Vec<String>,
    expected_outcome: ExpectedOutcomeV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
enum ExpectedOutcomeV1 {
    #[serde(rename = "latex-compile-success")]
    LatexCompileSuccess,
}

fn is_lower_hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[test]
fn pinned_manim_core_ams_profile_compiles_deterministically() {
    let fixture: SourceProfileV1 =
        serde_json::from_str(SOURCE_PROFILE_JSON).expect("source profile must be valid JSON");
    assert_eq!(fixture.schema, "poietra.mathtex-manim-source-profile");
    assert_eq!(fixture.version, 1);
    assert_eq!(fixture.profile, "core-ams");
    assert_eq!(
        fixture.reference_producer.kind,
        "manim-default-mathtex-compile"
    );
    assert_eq!(
        fixture.reference_producer.docker_image,
        EXPECTED_MANIM_IMAGE
    );
    assert_eq!(fixture.reference_producer.manim_version, "0.20.1");
    assert_eq!(
        fixture.reference_producer.latex_version,
        "pdfTeX 3.141592653-2.6-1.40.28 (TeX Live 2025)"
    );
    assert_eq!(fixture.reference_producer.dvisvgm_version, "dvisvgm 3.4.3");
    assert_eq!(fixture.reference_producer.tex_compiler, "latex");
    assert!(is_lower_hex_digest(
        &fixture.reference_producer.tex_template_sha256
    ));
    assert_eq!(
        fixture.reference_producer.generation_command,
        "node scripts/regenerate-mathtex-manim-parity.mjs"
    );
    assert!(is_lower_hex_digest(
        &manim_default_source_profile_digest_v1()
    ));

    let identifiers = fixture
        .cases
        .iter()
        .map(|case| case.id.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(
        identifiers,
        EXPECTED_CASE_IDS.iter().copied().collect::<BTreeSet<_>>()
    );

    for case in fixture.cases {
        assert_eq!(
            case.expected_outcome,
            ExpectedOutcomeV1::LatexCompileSuccess
        );
        assert!(
            !case.tex_parts.is_empty(),
            "{} has no source parts",
            case.id
        );
        assert!(
            case.tex_parts.iter().all(|part| !part.trim().is_empty()),
            "{} has an empty source part",
            case.id
        );
        let request = MathTexOutlineRequestV1::new(case.tex_parts);
        let first = compile_mathtex_outline_v1(&request);
        let second = compile_mathtex_outline_v1(&request);
        assert_eq!(first, second, "{} must compile deterministically", case.id);

        let MathTexOutlineResultV1::Compiled(artifact) = first else {
            panic!(
                "{} has Manim acceptance evidence but fell back: {first:?}",
                case.id
            );
        };
        assert!(artifact.bounds.left.is_finite());
        assert!(artifact.bounds.right.is_finite());
        assert!(artifact.bounds.bottom.is_finite());
        assert!(artifact.bounds.top.is_finite());
        assert!(artifact.bounds.left < artifact.bounds.right);
        assert!(artifact.bounds.bottom < artifact.bounds.top);
        let segment_count = artifact
            .path
            .subpaths
            .iter()
            .map(|subpath| subpath.segments.len())
            .sum::<usize>();
        assert!(
            (1..=2_048).contains(&segment_count),
            "{} emitted {segment_count} segments",
            case.id
        );
        assert!(
            artifact.path.subpaths.iter().all(|subpath| subpath.closed),
            "{} emitted an open contour",
            case.id
        );
    }
}
