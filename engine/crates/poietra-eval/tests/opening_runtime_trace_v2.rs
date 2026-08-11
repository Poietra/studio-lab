use std::fs;
use std::io::Read;
use std::path::PathBuf;

use flate2::read::GzDecoder;
use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_scene_ir::{
    RenderDrawV1, RenderEmptyReasonV1, RuntimeTraceVersionV1, SceneSourceV1, ViewportV1,
    parse_scene_ir_bundle_json_v1,
};

const EXPECTED_SAMPLES: [(f64, usize, usize); 25] = [
    (0.0, 44, 29),
    (0.5, 44, 34),
    (1.0, 44, 39),
    (2.0, 44, 44),
    (179.0 / 60.0, 44, 44),
    (3.0, 36, 36),
    (3.5, 35, 35),
    (4.0, 21, 21),
    (299.0 / 60.0, 21, 21),
    (5.0, 56, 32),
    (5.5, 56, 38),
    (6.5, 56, 49),
    (479.0 / 60.0, 56, 56),
    (8.0, 35, 35),
    (539.0 / 60.0, 35, 35),
    (9.0, 35, 35),
    (10.5, 35, 35),
    (719.0 / 60.0, 35, 35),
    (12.0, 35, 35),
    (779.0 / 60.0, 35, 35),
    (13.0, 66, 66),
    (13.5, 66, 66),
    (839.0 / 60.0, 66, 66),
    (14.0, 66, 66),
    (899.0 / 60.0, 66, 66),
];

fn fixture_bytes() -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/real-opening-runtime-v2.json.gz");
    let compressed = fs::read(path).expect("OpeningManim V2 fixture must be readable");
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut bytes = Vec::new();
    decoder
        .read_to_end(&mut bytes)
        .expect("OpeningManim V2 fixture must be valid gzip");
    bytes
}

fn sample(session: &EngineSessionV1, sample_time: f64, suffix: &str) -> Vec<RenderDrawV1> {
    let evidence = ["real OpeningManim Runtime Trace V2 lowering".to_owned()];
    let packet_id = format!("opening-runtime-trace-v2:{sample_time}:{suffix}");
    session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &evidence,
            packet_id: &packet_id,
            sample_time,
            viewport: ViewportV1 {
                height_px: 720,
                width_px: 1_280,
            },
        })
        .unwrap_or_else(|error| panic!("OpeningManim V2 sample {sample_time} failed: {error}"))
        .draws
}

#[test]
fn canonical_evaluator_samples_the_actual_opening_manim_v2_lowering() {
    let bundle = parse_scene_ir_bundle_json_v1(&fixture_bytes())
        .expect("OpeningManim V2 lowering must remain valid Scene IR");
    assert!(matches!(
        bundle.scene.source,
        SceneSourceV1::ImportedManimRuntimeTrace {
            trace_version: RuntimeTraceVersionV1::V2,
            ..
        }
    ));
    let session = EngineSessionV1::new(bundle).expect("OpeningManim V2 session must install");
    let mut forward_zero = None;
    let mut forward_half = None;

    for (sample_index, (sample_time, expected_draws, expected_paths)) in
        EXPECTED_SAMPLES.into_iter().enumerate()
    {
        let draws = sample(&session, sample_time, "forward");
        let path_count = draws
            .iter()
            .filter(|draw| matches!(draw, RenderDrawV1::Path { .. }))
            .count();
        assert_eq!(draws.len(), expected_draws, "draw count at {sample_time}");
        assert_eq!(path_count, expected_paths, "path count at {sample_time}");
        match sample_index {
            0 => forward_zero = Some(draws.clone()),
            1 => forward_half = Some(draws),
            _ => {}
        }
    }

    let backward_zero = sample(&session, 0.0, "backward-zero");
    assert_eq!(
        backward_zero,
        forward_zero.expect("the forward samples must include time zero"),
        "backward seeking must not retain state from the final sample"
    );
    assert!(backward_zero.iter().any(|draw| matches!(
        draw,
        RenderDrawV1::Empty {
            reason: RenderEmptyReasonV1::PathTrimZero,
            ..
        }
    )));
    let backward_half = sample(&session, 0.5, "backward-half");
    assert_eq!(
        backward_half,
        forward_half.expect("the forward samples must include time 0.5"),
        "backward seeking must reproduce the original forward sample"
    );
    assert_eq!(
        backward_half,
        sample(&session, 0.5, "repeat-seek"),
        "packet correlation must not alter sampled Scene semantics"
    );
}
