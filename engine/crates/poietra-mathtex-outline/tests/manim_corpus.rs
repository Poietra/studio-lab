use std::collections::BTreeSet;

use poietra_mathtex_outline::{
    MathTexOutlineRequestV1, MathTexOutlineResultV1, compile_mathtex_outline_v1,
};
use serde::Deserialize;

const CORPUS_JSON: &str = include_str!("../../../../fixtures/mathtex-v1/manim-corpus.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManimCorpusV1 {
    schema: String,
    version: u32,
    cases: Vec<ManimCorpusCaseV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManimCorpusCaseV1 {
    id: String,
    tex_parts: Vec<String>,
    provenance: String,
}

#[test]
fn representative_manim_mathtex_corpus_compiles_deterministically() {
    let corpus: ManimCorpusV1 =
        serde_json::from_str(CORPUS_JSON).expect("checked-in corpus must be valid JSON");
    assert_eq!(corpus.schema, "poietra.mathtex-manim-corpus");
    assert_eq!(corpus.version, 1);
    assert_eq!(
        corpus.cases.len(),
        25,
        "the acceptance corpus is intentionally fixed at 25 cases"
    );

    let mut identifiers = BTreeSet::new();
    for case in corpus.cases {
        assert!(!case.id.is_empty());
        assert!(
            !case.provenance.is_empty(),
            "{} must retain source provenance",
            case.id
        );
        assert!(
            identifiers.insert(case.id.clone()),
            "duplicate corpus id: {}",
            case.id
        );

        let request = MathTexOutlineRequestV1::new(case.tex_parts.clone());
        let first = compile_mathtex_outline_v1(&request);
        let second = compile_mathtex_outline_v1(&request);
        assert_eq!(
            first, second,
            "{} must compile byte-stably ({})",
            case.id, case.provenance
        );

        let MathTexOutlineResultV1::Compiled(artifact) = first else {
            panic!("{} must compile ({case:?})", case.id);
        };
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
        assert!(artifact.bounds.left.is_finite());
        assert!(artifact.bounds.right.is_finite());
        assert!(artifact.bounds.bottom.is_finite());
        assert!(artifact.bounds.top.is_finite());
        assert!((artifact.bounds.top - artifact.bounds.bottom - 1.0).abs() <= 2.0e-6);
    }
}
