use std::fs;
use std::path::PathBuf;

use poietra_eval::{
    CompileEngineFrameOptionsV1, EngineSessionV1, SampleEngineSessionOptionsV1,
    compile_render_packet_v1,
};
use poietra_geometry::apply_easing_v1;
use poietra_render_wgpu::{PreparedGeometryCacheV1, prepare_frame_v1, prepare_frame_with_cache_v1};
use poietra_scene_ir::{EasingV1, RenderCompositingV1, RenderDrawV1, SceneIrBundleV1, ViewportV1};
use serde_json::{Value, json};

const CUBIC_SIGNED_AREA_ROOT_PROGRESS: f64 = 0.530_158_360_440_676_8;
// This is Scene time, not raw morph progress: inverse Manim smooth maps its
// local time 0.511915... to the analytic signed-area root progress above.
const CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME: f64 = 1.511_915_947_381_744_7;

fn inverse_manim_smooth(progress: f64) -> f64 {
    let error = 1.0 / (1.0 + 5.0_f64.exp());
    let sigmoid = progress * (1.0 - 2.0 * error) + error;
    0.5 + (sigmoid / (1.0 - sigmoid)).ln() / 10.0
}

fn real_producer_bundle() -> SceneIrBundleV1 {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../server/test-fixtures/fast-manim-square-to-circle-v8-combined.json");
    let combined: Value = serde_json::from_slice(
        &fs::read(path).expect("the real fast-manim V8 combined fixture must be readable"),
    )
    .expect("the real fast-manim V8 combined fixture must be JSON");
    let snapshot_json = combined["snapshotJson"]
        .as_str()
        .expect("the combined fixture must carry its producer snapshot JSON");
    let snapshot: Value = serde_json::from_str(snapshot_json)
        .expect("the real fast-manim V8 producer snapshot must be JSON");
    let mut bundle = snapshot["bundle"].clone();
    bundle["scene"]["compositing"] = json!("manim-cairo-srgb");
    bundle["scene"]["stateSampling"] = json!({ "frameRate": null, "retainsTerminalState": false });
    serde_json::from_value(bundle)
        .expect("the real fast-manim V8 producer bundle must match Scene IR")
}

fn viewport() -> ViewportV1 {
    ViewportV1 {
        height_px: 360,
        width_px: 640,
    }
}

#[test]
#[allow(
    clippy::float_cmp,
    clippy::too_many_lines,
    reason = "the audited fixture enumerates exact boundary/root f64 values in one end-to-end assertion"
)]
fn real_v8_retained_sampling_and_wgpu_prepare_agree_through_the_winding_root() {
    let derived_root_sample_time = 1.0 + inverse_manim_smooth(CUBIC_SIGNED_AREA_ROOT_PROGRESS);
    assert!(
        (derived_root_sample_time - CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME).abs() <= 2.0e-15,
        "the inverse Manim-smooth root sample constant drifted"
    );
    let evaluated_progress = apply_easing_v1(
        &EasingV1::ManimSmooth {},
        CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME - 1.0,
    );
    assert!(
        (evaluated_progress - CUBIC_SIGNED_AREA_ROOT_PROGRESS).abs() <= 2.0e-15,
        "the evaluator no longer reaches the analytic root at the pinned sample time"
    );

    let bundle = real_producer_bundle();
    let session = EngineSessionV1::new(bundle.clone())
        .expect("the verified real-producer V8 bundle must install in the retained evaluator");
    let installed = session.retained_index_stats();
    let mut cache = PreparedGeometryCacheV1::default();

    let forward_samples = [
        0.0,
        0.5,
        1.0,
        1.5,
        CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME,
        2.0,
        2.5,
        3.0,
    ];
    let non_monotonic_samples = [
        2.5,
        0.5,
        CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME,
        1.0,
        2.0,
        0.0,
        1.5,
        3.0,
        CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME,
    ];
    for (seek_index, sample_time) in forward_samples
        .into_iter()
        .chain(non_monotonic_samples)
        .enumerate()
    {
        let packet_id = format!("square-to-circle-v8:{seek_index}:{sample_time}");
        let retained = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &["real fast-manim SquareToCircle V8".to_owned()],
                packet_id: &packet_id,
                sample_time,
                viewport: viewport(),
            })
            .unwrap_or_else(|error| panic!("retained V8 sample {sample_time} failed: {error}"));
        let reference = compile_render_packet_v1(CompileEngineFrameOptionsV1 {
            assets: &bundle.assets,
            evidence: &["real fast-manim SquareToCircle V8".to_owned()],
            packet_id: &packet_id,
            sample_time,
            scene: &bundle.scene,
            viewport: viewport(),
        })
        .unwrap_or_else(|error| panic!("reference V8 sample {sample_time} failed: {error}"));
        assert_eq!(
            retained, reference,
            "retained sample diverged at {sample_time}"
        );
        assert_eq!(retained.compositing, RenderCompositingV1::ManimCairoSrgb);

        let direct = prepare_frame_v1(&retained)
            .unwrap_or_else(|error| panic!("direct WGPU prepare failed at {sample_time}: {error}"));
        let cached = prepare_frame_with_cache_v1(&retained, &mut cache).unwrap_or_else(|error| {
            panic!("retained WGPU prepare failed at {sample_time}: {error}")
        });
        // Cache hits truthfully lower tessellation_calls, while all submitted
        // geometry/material/draw bytes must stay identical.
        assert_eq!(
            direct.indices(),
            cached.indices(),
            "cached indices diverged at {sample_time}"
        );
        assert_eq!(
            direct.geometry_plan().vertices(),
            cached.geometry_plan().vertices(),
            "cached vertices diverged at {sample_time}"
        );
        assert_eq!(direct.material_plan(), cached.material_plan());
        assert_eq!(direct.ordered_draw_plan(), cached.ordered_draw_plan());
        assert_eq!(direct.viewport(), cached.viewport());

        if sample_time == 0.0 {
            assert!(matches!(
                retained.draws.as_slice(),
                [RenderDrawV1::Empty { .. }]
            ));
            assert!(direct.draws().is_empty());
        } else if sample_time == 3.0 {
            assert!(retained.draws.is_empty());
            assert!(direct.draws().is_empty());
        } else {
            assert!(matches!(
                retained.draws.as_slice(),
                [RenderDrawV1::Path { .. }]
            ));
            assert!(
                !direct.indices().is_empty(),
                "sample {sample_time} must prepare GPU geometry"
            );
        }
        if sample_time == 1.5 || sample_time == CUBIC_SIGNED_AREA_ROOT_SAMPLE_TIME {
            let RenderDrawV1::Path {
                fill: Some(_),
                path,
                stroke: Some(_),
                ..
            } = &retained.draws[0]
            else {
                panic!("sample {sample_time} must retain one fill-and-stroke path");
            };
            assert_eq!(path.subpaths[0].segments.len(), 8);
            assert_eq!(
                direct.draws().len(),
                2,
                "fill and stroke must both prepare at {sample_time}"
            );
        }
        if sample_time == 2.5 {
            let RenderDrawV1::Path {
                fill: Some(fill),
                opacity,
                ..
            } = &retained.draws[0]
            else {
                panic!("Fade midpoint must retain one filled path");
            };
            assert_eq!(opacity.to_bits(), 0.5_f64.to_bits());
            assert_eq!(fill.color.alpha.to_bits(), 0.5_f64.to_bits());
            assert_eq!(
                direct.material_plan().materials()[0].premultiplied_srgb_color()[3].to_bits(),
                0.25_f32.to_bits(),
                "Cairo preparation must multiply fill alpha by animated opacity"
            );
        }
    }

    assert_eq!(session.retained_index_stats(), installed);
}
