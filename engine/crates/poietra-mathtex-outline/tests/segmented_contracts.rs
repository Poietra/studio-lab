use poietra_mathtex_outline::{
    MAX_SEGMENTED_TEX_CUBIC_SEGMENTS_V1, MAX_SEGMENTED_TEX_ENTITIES_V1, SegmentedTexModeV1,
    SegmentedTexOutlineRequestV1, SegmentedTexOutlineResultV1,
    SegmentedTexOutlineUnsupportedCodeV1, SegmentedTexPaintMatchV1,
    SegmentedTexSourceCorrelationV1, SegmentedTexSourceKindV1, compile_segmented_tex_outline_v1,
    evaluate_segmented_tex_write_v1,
};
use poietra_scene_ir::RgbaColorV1;
use serde_json::Value;
use sha2::{Digest, Sha256};

const OFFICIAL_TEXT: &str = "This is a some text";
const OFFICIAL_FORMULA: &str = r"\sum_{k=1}^\infty {1 \over k^2} = {\pi^2 \over 6}";

fn white() -> RgbaColorV1 {
    RgbaColorV1 {
        alpha: 1.0,
        blue: 1.0,
        green: 1.0,
        red: 1.0,
    }
}

fn yellow() -> RgbaColorV1 {
    RgbaColorV1 {
        alpha: 1.0,
        blue: 0.0,
        green: 1.0,
        red: 1.0,
    }
}

fn assert_exact_float(actual: f64, expected: f64) {
    assert_eq!(actual.to_bits(), expected.to_bits());
}

fn text_request(
    source: &str,
    matches: Vec<SegmentedTexPaintMatchV1>,
) -> SegmentedTexOutlineRequestV1 {
    SegmentedTexOutlineRequestV1::literal(SegmentedTexModeV1::TexText, source, matches)
}

fn compile_text() -> poietra_mathtex_outline::SegmentedTexOutlineArtifactV1 {
    let request = text_request(
        OFFICIAL_TEXT,
        vec![SegmentedTexPaintMatchV1 {
            literal: "text".to_owned(),
            paint: yellow(),
        }],
    );
    let SegmentedTexOutlineResultV1::Compiled(artifact) =
        compile_segmented_tex_outline_v1(&request)
    else {
        panic!("official WriteStuff Tex must compile");
    };
    artifact
}

#[test]
fn official_write_stuff_text_has_ordered_exact_correlations_and_yellow_span() {
    let artifact = compile_text();
    assert_eq!(artifact.mode, SegmentedTexModeV1::TexText);
    assert_eq!(artifact.source, OFFICIAL_TEXT);
    assert_eq!(artifact.fragments.len(), 15);
    assert_eq!(artifact.paint_spans.len(), 1);
    assert_eq!(artifact.paint_spans[0].source_start_byte, 15);
    assert_eq!(artifact.paint_spans[0].source_end_byte, 19);

    let mut yellow_fragments = 0;
    let mut segment_count = 0;
    let mut prior_start = 0;
    for (order, fragment) in artifact.fragments.iter().enumerate() {
        assert_eq!(fragment.id, format!("fragment-{order:04}"));
        assert_eq!(fragment.order as usize, order);
        assert_eq!(
            fragment.outline_entity_id,
            format!("{}:outline", fragment.id)
        );
        assert_eq!(fragment.fill_entity_id, format!("{}:fill", fragment.id));
        let SegmentedTexSourceCorrelationV1::ExactByteRange {
            source_start_byte,
            source_end_byte,
        } = fragment.source_correlation
        else {
            panic!("Tex glyphs require exact byte ranges");
        };
        assert!(source_start_byte >= prior_start);
        assert!(OFFICIAL_TEXT.is_char_boundary(source_start_byte as usize));
        assert!(OFFICIAL_TEXT.is_char_boundary(source_end_byte as usize));
        prior_start = source_start_byte;
        if fragment.paint == yellow() {
            yellow_fragments += 1;
            assert!(source_start_byte >= 15 && source_end_byte <= 19);
        } else {
            assert_eq!(fragment.paint, white());
        }
        segment_count += fragment
            .path
            .subpaths
            .iter()
            .map(|subpath| subpath.segments.len())
            .sum::<usize>();
    }
    assert_eq!(yellow_fragments, 4);
    assert!((1..=MAX_SEGMENTED_TEX_CUBIC_SEGMENTS_V1).contains(&segment_count));
    assert_exact_float(artifact.write_plan.fragment_lag_ratio, 0.2);
    assert_exact_float(artifact.write_plan.phase_boundary, 0.5);
}

#[test]
fn official_write_stuff_math_uses_expression_correlation_without_fake_macro_ranges() {
    let request = SegmentedTexOutlineRequestV1::literal(
        SegmentedTexModeV1::MathTexMath,
        OFFICIAL_FORMULA,
        vec![],
    );
    let SegmentedTexOutlineResultV1::Compiled(artifact) =
        compile_segmented_tex_outline_v1(&request)
    else {
        panic!("official WriteStuff MathTex must compile");
    };
    assert!(!artifact.fragments.is_empty());
    assert!(artifact.fragments.iter().all(|fragment| {
        fragment.paint == white()
            && matches!(
                fragment.source_correlation,
                SegmentedTexSourceCorrelationV1::ExpressionByteRange {
                    source_start_byte: 0,
                    source_end_byte,
                } if source_end_byte as usize == OFFICIAL_FORMULA.len()
            )
    }));
    assert!(artifact.fragments.iter().any(|fragment| matches!(
        fragment.kind,
        poietra_mathtex_outline::SegmentedTexOutlineFragmentKindV1::Rule
    )));
}

#[test]
fn write_phase_boundary_is_visually_continuous_across_separate_entities() {
    let artifact = compile_text();
    let trailing_fragment_count =
        u32::try_from(artifact.fragments.len() - 1).expect("bounded fragment count");
    let full_length =
        f64::from(trailing_fragment_count) * artifact.write_plan.fragment_lag_ratio + 1.0;
    let boundary = artifact.write_plan.phase_boundary / full_length;

    let before = evaluate_segmented_tex_write_v1(&artifact, boundary - 1.0e-9);
    assert!(before[0].outline.visible);
    assert!(!before[0].fill.visible);
    assert!(before[0].outline.path_trim_end < 1.0);

    let at = evaluate_segmented_tex_write_v1(&artifact, boundary);
    assert!(!at[0].outline.visible);
    assert!(at[0].fill.visible);
    assert_exact_float(at[0].fill.fill_opacity, 0.0);
    assert_exact_float(
        at[0].fill.stroke_width,
        artifact.write_plan.outline_stroke_width,
    );
    assert!(
        !at[3].outline.visible,
        "a later lagged fragment has not started"
    );

    let second_half_midpoint = 0.75 / full_length;
    let midpoint = evaluate_segmented_tex_write_v1(&artifact, second_half_midpoint);
    assert_exact_float(midpoint[0].fill.fill_opacity, 0.5);
    assert_exact_float(midpoint[0].fill.stroke_opacity, 0.5);
    assert_exact_float(midpoint[0].fill.stroke_width, 2.0);

    let end = evaluate_segmented_tex_write_v1(&artifact, 1.0);
    assert!(end.iter().all(|sample| {
        !sample.outline.visible
            && sample.fill.visible
            && sample.fill.fill_opacity.to_bits() == 1.0f64.to_bits()
            && sample.fill.stroke_opacity.to_bits() == 0.0f64.to_bits()
            && sample.fill.stroke_width.to_bits() == 2.0f64.to_bits()
    }));
    assert!(evaluate_segmented_tex_write_v1(&artifact, f64::NAN).is_empty());
}

fn unsupported(request: &SegmentedTexOutlineRequestV1) -> SegmentedTexOutlineUnsupportedCodeV1 {
    let SegmentedTexOutlineResultV1::Unsupported(unsupported) =
        compile_segmented_tex_outline_v1(request)
    else {
        panic!("request must fail closed");
    };
    unsupported.code
}

#[test]
fn ambiguous_paint_dynamic_source_and_uncorrelated_text_fail_closed() {
    assert_eq!(
        unsupported(&text_request(
            "text and text",
            vec![SegmentedTexPaintMatchV1 {
                literal: "text".to_owned(),
                paint: yellow(),
            }],
        )),
        SegmentedTexOutlineUnsupportedCodeV1::PaintPartitionAmbiguous
    );
    assert_eq!(
        unsupported(&text_request(
            OFFICIAL_TEXT,
            vec![
                SegmentedTexPaintMatchV1 {
                    literal: "some text".to_owned(),
                    paint: yellow(),
                },
                SegmentedTexPaintMatchV1 {
                    literal: "text".to_owned(),
                    paint: white(),
                },
            ],
        )),
        SegmentedTexOutlineUnsupportedCodeV1::PaintPartitionAmbiguous
    );

    let mut dynamic = text_request(OFFICIAL_TEXT, vec![]);
    dynamic.source_kind = SegmentedTexSourceKindV1::Dynamic;
    assert_eq!(
        unsupported(&dynamic),
        SegmentedTexOutlineUnsupportedCodeV1::DynamicSourceUnsupported
    );
    assert_eq!(
        unsupported(&text_request("café", vec![])),
        SegmentedTexOutlineUnsupportedCodeV1::SourceCorrelationUnsupported
    );
    assert_eq!(
        unsupported(&text_request(r"\text{expanded}", vec![])),
        SegmentedTexOutlineUnsupportedCodeV1::SourceCorrelationUnsupported,
        "text macros must never receive fictitious exact glyph byte ranges"
    );
}

#[test]
fn unsupported_options_and_limits_are_structured() {
    let colored_math = SegmentedTexOutlineRequestV1::literal(
        SegmentedTexModeV1::MathTexMath,
        "x",
        vec![SegmentedTexPaintMatchV1 {
            literal: "x".to_owned(),
            paint: yellow(),
        }],
    );
    assert_eq!(
        unsupported(&colored_math),
        SegmentedTexOutlineUnsupportedCodeV1::OptionUnsupported
    );

    let oversized = "x".repeat(poietra_mathtex_outline::MAX_SEGMENTED_TEX_SOURCE_BYTES_V1 + 1);
    assert_eq!(
        unsupported(&text_request(&oversized, vec![])),
        SegmentedTexOutlineUnsupportedCodeV1::RequestTooLarge
    );
}

fn assert_phase_evidence(
    artifact: &poietra_mathtex_outline::SegmentedTexOutlineArtifactV1,
    case: &Value,
) {
    for sample in case["phaseSamples"].as_array().expect("phase samples") {
        let progress = sample["progress"].as_f64().expect("finite progress");
        let order = usize::try_from(sample["fragmentOrder"].as_u64().expect("fragment order"))
            .expect("bounded fragment order");
        let evaluated = evaluate_segmented_tex_write_v1(artifact, progress);
        let expected_sample: poietra_mathtex_outline::SegmentedTexWriteSampleV1 =
            serde_json::from_value(sample["expected"].clone()).unwrap();
        assert_eq!(
            evaluated[order], expected_sample,
            "{} / {}",
            case["id"], sample["id"]
        );
    }
}

#[test]
fn official_static_and_phase_evidence_is_reproducible() {
    let evidence: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/segmented-tex-outline-v1/official-write-stuff-evidence.json"
    ))
    .expect("official segmented evidence must be JSON");
    assert_eq!(evidence["schema"], "poietra.segmented-tex-outline-evidence");
    assert_eq!(evidence["version"], 1);
    let cases = evidence["cases"].as_array().expect("evidence cases");
    assert_eq!(cases.len(), 2);

    for case in cases {
        let request: SegmentedTexOutlineRequestV1 =
            serde_json::from_value(case["request"].clone()).expect("bounded request");
        let SegmentedTexOutlineResultV1::Compiled(artifact) =
            compile_segmented_tex_outline_v1(&request)
        else {
            panic!("{} must compile", case["id"]);
        };
        let expected = &case["expected"];
        assert_eq!(
            artifact.bounds,
            serde_json::from_value(expected["bounds"].clone()).unwrap()
        );
        assert_eq!(
            artifact.content_digest,
            expected["contentDigest"].as_str().unwrap()
        );
        assert_eq!(
            artifact.toolchain_digest,
            expected["toolchainDigest"].as_str().unwrap()
        );
        assert_eq!(
            artifact.font_digest,
            expected["fontDigest"].as_str().unwrap()
        );
        assert_eq!(
            artifact.fragments.len() as u64,
            expected["fragmentCount"].as_u64().unwrap()
        );
        assert_eq!(
            artifact.fragments.len() as u64 * 2,
            expected["entityCount"].as_u64().unwrap()
        );
        assert!(artifact.fragments.len() * 2 <= MAX_SEGMENTED_TEX_ENTITIES_V1);
        assert_eq!(
            artifact
                .fragments
                .iter()
                .map(|fragment| fragment.kind)
                .collect::<Vec<_>>(),
            serde_json::from_value::<
                Vec<poietra_mathtex_outline::SegmentedTexOutlineFragmentKindV1>,
            >(expected["fragmentKinds"].clone())
            .unwrap()
        );
        assert_eq!(
            artifact.paint_spans,
            serde_json::from_value::<Vec<poietra_mathtex_outline::SegmentedTexPaintSpanV1>>(
                expected["paintSpans"].clone(),
            )
            .unwrap()
        );
        let painted_orders = artifact
            .fragments
            .iter()
            .filter(|fragment| fragment.paint.blue == 0.0)
            .map(|fragment| fragment.order)
            .collect::<Vec<_>>();
        assert_eq!(
            painted_orders,
            serde_json::from_value::<Vec<u32>>(expected["paintedFragmentOrders"].clone()).unwrap()
        );
        let subpath_count = artifact
            .fragments
            .iter()
            .map(|fragment| fragment.path.subpaths.len())
            .sum::<usize>();
        let cubic_segment_count = artifact
            .fragments
            .iter()
            .flat_map(|fragment| &fragment.path.subpaths)
            .map(|subpath| subpath.segments.len())
            .sum::<usize>();
        assert_eq!(
            subpath_count as u64,
            expected["subpathCount"].as_u64().unwrap()
        );
        assert_eq!(
            cubic_segment_count as u64,
            expected["cubicSegmentCount"].as_u64().unwrap()
        );
        let fragment_wire = serde_json::to_vec(&artifact.fragments).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(fragment_wire)),
            expected["fragmentEvidenceSha256"].as_str().unwrap()
        );

        assert_phase_evidence(&artifact, case);
    }
}
