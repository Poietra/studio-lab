use std::collections::BTreeSet;

use poietra_mathtex_outline::{
    MathTexOutlineRequestV1, MathTexOutlineResultV1, compile_mathtex_outline_v1,
};
use serde::Deserialize;

const CORPUS_JSON: &str =
    include_str!("../../../../fixtures/mathtex-v1/fast-manim-callsite-corpus.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CorpusV1 {
    schema: String,
    version: u32,
    repository: String,
    source_commit: String,
    extraction_command: String,
    extraction_rule: String,
    cases: Vec<CorpusCaseV1>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CorpusCaseV1 {
    id: String,
    tex_parts: Vec<String>,
    provenance: String,
    #[serde(default)]
    requires_custom_tex_template: bool,
}

#[test]
fn literal_fast_manim_callsites_meet_the_support_floor() {
    let corpus: CorpusV1 =
        serde_json::from_str(CORPUS_JSON).expect("checked-in corpus must be valid JSON");
    assert_eq!(corpus.schema, "poietra.mathtex-fast-manim-callsite-corpus");
    assert_eq!(corpus.version, 1);
    assert_eq!(corpus.repository, "https://github.com/Poietra/fast-manim");
    assert_eq!(
        corpus.source_commit,
        "499148963dd629057c4bbbafc7e1f82bdcf51e7a"
    );
    assert_eq!(
        corpus.extraction_command,
        "python3 scripts/verify-fast-manim-mathtex-callsite-corpus.py --repository ../fast-manim"
    );
    assert!(
        corpus
            .extraction_rule
            .contains("Duplicate expressions remain")
    );
    assert_eq!(
        corpus.cases.len(),
        31,
        "the pinned call-site census changed"
    );

    let mut identifiers = BTreeSet::new();
    let mut compiled = 0usize;
    let mut custom_template_fallbacks = 0usize;
    for case in &corpus.cases {
        assert!(identifiers.insert(&case.id), "duplicate id: {}", case.id);
        assert!(!case.provenance.is_empty(), "{} lacks provenance", case.id);
        let result =
            compile_mathtex_outline_v1(&MathTexOutlineRequestV1::new(case.tex_parts.clone()));
        match result {
            MathTexOutlineResultV1::Compiled(_) => compiled += 1,
            MathTexOutlineResultV1::Unsupported(unsupported) => {
                assert!(
                    case.requires_custom_tex_template,
                    "default-template call {} unexpectedly fell back: {unsupported:?}",
                    case.id
                );
                custom_template_fallbacks += 1;
            }
        }
    }

    assert_eq!(custom_template_fallbacks, 1);
    assert!(
        compiled * 100 >= corpus.cases.len() * 95,
        "support was {compiled}/{}; required at least 95%",
        corpus.cases.len()
    );
}
