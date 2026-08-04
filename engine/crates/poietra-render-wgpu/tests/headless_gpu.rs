#![cfg(not(target_arch = "wasm32"))]

mod support;

use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use poietra_eval::{EngineSessionV1, SampleEngineSessionOptionsV1};
use poietra_render_wgpu::{
    DecodedPngAssetResolverV1, ImageTextureCacheLimitsV1, PreparedFrameV1, RenderFrameErrorV1,
    WgpuPaintRendererV1, WgpuRenderTargetV1, build_gpu_upload_plan_v1, decode_verified_png_v1,
    prepare_frame_v1, prepare_frame_with_assets_v1,
};
use poietra_scene_ir::{
    AffineTransformV1, CubicSubpathV1, ImageLocalRectV1, ImageSamplerV1, RenderCameraKindV1,
    RenderCameraV1, RenderCapabilityV1, RenderCompositingV1, RenderDrawV1, RenderPacketV1,
    RgbaColorV1, SceneIrBundleV1, SceneSourceV1, SnapshotProfileVersionV1, StrokeCapV1,
    StrokeJoinV1, ViewportV1,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use support::{
    PixelReference, PixelReferenceSet, empty_render_packet, generic_fill_fixture,
    generic_stroke_fixture, image_draw, sampled_packet, solid_rectangle_draw,
    straight_stroke_packet, verified_rgba_png,
};

const BYTES_PER_PIXEL: u32 = 4;
const GPU_TIMEOUT: Duration = Duration::from_secs(10);
const TARGET_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
const MANIM_CAIRO_TARGET_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AdapterEvidence {
    backend: String,
    device: u32,
    device_type: String,
    driver: String,
    driver_info: String,
    fallback_requested: bool,
    name: String,
    vendor: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PixelEvidence {
    background: [u8; 4],
    blue_center: [u8; 4],
    green_cap_exterior: [u8; 4],
    green_round_cap: [u8; 4],
    green_stroke_center: [u8; 4],
    red_center: [u8; 4],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeEvidence {
    adapter: AdapterEvidence,
    format: String,
    padded_bytes_per_row: u32,
    pixels: PixelEvidence,
    status: &'static str,
    viewport: [u32; 2],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicFixture {
    assets: serde_json::Value,
    id: String,
    pixel_references: std::collections::BTreeMap<String, PixelReferenceSet>,
    samples: Vec<DynamicSample>,
    scene: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicSample {
    expected: DynamicExpected,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DynamicExpected {
    pixel_reference_id: String,
    semantic_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MathTexVisualParityFixture {
    assets: serde_json::Value,
    id: String,
    samples: Vec<MathTexVisualParitySample>,
    scene: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MathTexVisualParitySample {
    expected: MathTexVisualParityExpected,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MathTexVisualParityExpected {
    semantic_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RealSnapshotVisualParityFixture {
    assets: serde_json::Value,
    id: String,
    producer_reference: RealSnapshotProducerReference,
    samples: Vec<RealSnapshotVisualParitySample>,
    scene: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RealSnapshotProducerReference {
    engine_commit: String,
    fast_manim_commit: String,
    #[serde(default)]
    fast_manim_tree: Option<String>,
    kind: String,
    #[serde(default)]
    producer_snapshot_digest: Option<String>,
    snapshot_hash: String,
    source_path: String,
    source_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RealSnapshotVisualParitySample {
    expected: RealSnapshotVisualParityExpected,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RealSnapshotVisualParityExpected {
    semantic_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PngVisualParityFixture {
    analytic_references: std::collections::BTreeMap<String, AnalyticFullFrameReference>,
    asset_payloads: Vec<FixtureAssetPayload>,
    assets: serde_json::Value,
    id: String,
    samples: Vec<PngVisualParitySample>,
    scene: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FixtureAssetPayload {
    asset_id: String,
    encoded_bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AnalyticFullFrameReference {
    channel_order: String,
    color_domain: String,
    derivation: String,
    rgba: Vec<u8>,
    sha256: String,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PngVisualParitySample {
    expected: PngVisualParityExpected,
    id: String,
    packet_id: String,
    sample_time: f64,
    viewport: ViewportV1,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PngVisualParityExpected {
    analytic_reference_id: String,
    semantic_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VisualParityCorpus {
    default_thresholds: serde_json::Value,
    entries: Vec<VisualParityCorpusEntry>,
    metric_contract: serde_json::Value,
    schema: String,
    version: u32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VisualParityCorpusEntry {
    fixture: VisualParityFixtureIdentity,
    id: String,
    sample: VisualParitySampleIdentity,
    threshold_exception: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VisualParityFixtureIdentity {
    id: String,
    path: String,
    revision: VisualParityFixtureRevision,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VisualParityFixtureRevision {
    kind: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VisualParitySampleIdentity {
    id: String,
    sample_time: f64,
    semantic_digest: String,
    viewport: ViewportV1,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeVisualParityArtifact<'a> {
    adapter: AdapterEvidence,
    capture: NativeVisualParityCapture,
    corpus_entry_id: &'a str,
    fixture: NativeVisualParityFixture<'a>,
    rgba: NativeVisualParityRgba,
    schema: &'static str,
    target: NativeVisualParityTarget,
    version: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeVisualParityCapture {
    policy: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeVisualParityFixture<'a> {
    fixture_id: &'a str,
    fixture_path: &'a str,
    fixture_revision: &'a str,
    sample_id: &'a str,
    sample_time: f64,
    semantic_digest: &'a str,
    viewport: ViewportV1,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeVisualParityRgba {
    byte_length: usize,
    channel_order: &'static str,
    path: &'static str,
    row_order: &'static str,
    row_stride_bytes: u32,
    sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeVisualParityTarget {
    color_domain: &'static str,
    format: &'static str,
}

const VISUAL_PARITY_CORPUS_SCHEMA_V1: &str = "poietra.visual-parity-corpus";
const VISUAL_PARITY_ENTRY_V1: &str = "dynamic-affine-camera--a-first";
const PNG_VISUAL_PARITY_ENTRY_V1: &str = "png-alpha-edge-camera--midpoint";
const MATHTEX_VISUAL_PARITY_ENTRY_V1: &str = "mathtex-nested-radical-fraction--static";
const GENERIC_STROKE_VISUAL_PARITY_ENTRY_V1: &str = "generic-stroke-topology--sample";
const REAL_GENERIC_VMOBJECT_V6_ENTRY_V1: &str = "real-generic-vmobject-v6--static";
const REAL_GENERIC_VMOBJECT_V6_FIXTURE_ID: &str = "eng-v1-real-generic-vmobject-v6";
const REAL_GENERIC_VMOBJECT_V6_FIXTURE_PATH: &str =
    "fixtures/engine-v1/real-generic-vmobject-v6.json";
const REAL_GENERIC_VMOBJECT_V6_SOURCE_PATH: &str =
    "fixtures/real-preview-harness/scene_generic_vmobject.py";
const REAL_MATHTEX_MORPH_V5_FIXTURE_ID: &str = "eng-v1-real-mathtex-morph-v5";
const REAL_MATHTEX_MORPH_V5_FIXTURE_PATH: &str = "fixtures/engine-v1/real-mathtex-morph-v5.json";
const REAL_MATHTEX_MORPH_V5_SOURCE_PATH: &str =
    "fixtures/real-preview-harness/scene_mathtex_morph.py";
const REAL_MATHTEX_MORPH_V5_SOURCE_SHA256: &str =
    "f03e0c5eed2c2c35047e8d0ee9ef0aa3f0fc00cd5ecd83ce36c3cf21e46e9dd6";
const REAL_MATHTEX_MORPH_V5_ENGINE_COMMIT: &str = "be671c1ddcfc8466548c8822956e19579256e581";
const REAL_MATHTEX_MORPH_V5_FAST_MANIM_COMMIT: &str = "3083db9ed9a9a93c2808ee3f51189ceca92d230b";
const REAL_MATHTEX_MORPH_V5_SNAPSHOT_HASH: &str =
    "05c0318c662004e9b1898a4018eaedef3a11b0926be9a166daa621145f645cbf";
const REAL_MATHTEX_MORPH_V5_SAMPLES: [(&str, &str, f64); 5] = [
    ("real-mathtex-morph-v5--a-initial", "a-initial", 0.5),
    (
        "real-mathtex-morph-v5--outbound-midpoint",
        "outbound-midpoint",
        1.5,
    ),
    ("real-mathtex-morph-v5--maxwell-hold", "maxwell-hold", 2.25),
    (
        "real-mathtex-morph-v5--return-midpoint",
        "return-midpoint",
        3.5,
    ),
    ("real-mathtex-morph-v5--a-restored", "a-restored", 5.0),
];
const REAL_SQUARE_TO_CIRCLE_V8_FIXTURE_ID: &str = "eng-v1-real-square-to-circle-v8";
const REAL_SQUARE_TO_CIRCLE_V8_FIXTURE_PATH: &str =
    "fixtures/engine-v1/real-square-to-circle-v8.json";
const REAL_SQUARE_TO_CIRCLE_V8_SOURCE_PATH: &str =
    "fixtures/real-preview-harness/scene_square_to_circle.py";
const REAL_SQUARE_TO_CIRCLE_V8_SOURCE_SHA256: &str =
    "ef874f1ab5899aadf870956ec71ce71653d373366b23e40c2ee8b070ad193c40";
const REAL_SQUARE_TO_CIRCLE_V8_ENGINE_COMMIT: &str = "1f195ba48d4e2ea92dd45b3cac4928342da320c9";
const REAL_SQUARE_TO_CIRCLE_V8_FAST_MANIM_COMMIT: &str = "a1e886fb854268ad7d06b00168f9a5ce3339857d";
const REAL_SQUARE_TO_CIRCLE_V8_SNAPSHOT_HASH: &str =
    "de7db7be8e1c633bd5668ed13b4daf3c3e945026db107bddc70e5366b0af80f1";
const REAL_SQUARE_TO_CIRCLE_V8_SAMPLES: [(&str, &str, f64); 5] = [
    (
        "real-square-to-circle-v8--create-midpoint",
        "create-midpoint",
        0.5,
    ),
    ("real-square-to-circle-v8--square", "square", 1.0),
    (
        "real-square-to-circle-v8--analytic-winding-root",
        "analytic-winding-root",
        1.511_915_947_381_744_7,
    ),
    ("real-square-to-circle-v8--circle", "circle", 2.0),
    (
        "real-square-to-circle-v8--fade-midpoint",
        "fade-midpoint",
        2.5,
    ),
];
const REAL_WARP_SQUARE_V9_FIXTURE_ID: &str = "eng-v1-real-warp-square-v9";
const REAL_WARP_SQUARE_V9_FIXTURE_PATH: &str = "fixtures/engine-v1/real-warp-square-v9.json";
const REAL_WARP_SQUARE_V9_SOURCE_PATH: &str = "example_scenes/basic.py";
const REAL_WARP_SQUARE_V9_SOURCE_MIRROR_PATH: &str =
    "fixtures/real-preview-harness/example_scenes/basic.py";
const REAL_WARP_SQUARE_V9_SOURCE_SHA256: &str =
    "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const REAL_WARP_SQUARE_V9_ENGINE_COMMIT: &str = "0b331ce781411f38185dcabccdffdccee02d4376";
const REAL_WARP_SQUARE_V9_FAST_MANIM_COMMIT: &str = "2c1e56287193e3acddbe6779f6ecd4bd91094588";
const REAL_WARP_SQUARE_V9_SNAPSHOT_HASH: &str =
    "b8854f07baa588b01a2a5694d8ade2800601f1e26b6e12d626cc170ffa1be9ed";
const REAL_WARP_SQUARE_V9_SAMPLES: [(&str, &str, f64); 5] = [
    ("real-warp-square-v9--source", "source", 0.0),
    ("real-warp-square-v9--quarter", "quarter", 0.75),
    ("real-warp-square-v9--midpoint", "midpoint", 1.5),
    ("real-warp-square-v9--target", "target", 3.0),
    ("real-warp-square-v9--hold", "hold", 3.5),
];
const REAL_LINE_JOINTS_V10_ENTRY_V1: &str = "real-line-joints-v10--static";
const REAL_LINE_JOINTS_V10_FIXTURE_ID: &str = "eng-v1-real-line-joints-v10";
const REAL_LINE_JOINTS_V10_FIXTURE_PATH: &str = "fixtures/engine-v1/real-line-joints-v10.json";
const REAL_LINE_JOINTS_V10_SOURCE_PATH: &str = "example_scenes/basic.py";
const REAL_LINE_JOINTS_V10_SOURCE_MIRROR_PATH: &str =
    "fixtures/real-preview-harness/example_scenes/basic.py";
const REAL_LINE_JOINTS_V10_SOURCE_SHA256: &str =
    "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const REAL_LINE_JOINTS_V10_FAST_MANIM_COMMIT: &str = "29d21a2bd213df8ffeed0454278aa86289d190b8";
const REAL_LINE_JOINTS_V10_SNAPSHOT_HASH: &str =
    "53fd284f9fd30f8223f90dfc9c291d571bab25d61b55170d5e57cf346e1b2827";
const REAL_LINE_JOINTS_V10_EDITED_ENTRY_V1: &str = "real-line-joints-v10-edited--static";
const REAL_LINE_JOINTS_V10_EDITED_FIXTURE_ID: &str = "eng-v1-real-line-joints-v10-edited";
const REAL_LINE_JOINTS_V10_EDITED_FIXTURE_PATH: &str =
    "fixtures/engine-v1/real-line-joints-v10-edited.json";
const REAL_LINE_JOINTS_V10_EDITED_SOURCE_SHA256: &str =
    "d95608a27f48b4cc2b9d7a5201cf455d38c400a91bd975b4a0d62575cf6ab027";
const REAL_LINE_JOINTS_V10_EDITED_FAST_MANIM_COMMIT: &str =
    "cd0cb237606b240a3c795b1171d61eeb3cef5305";
const REAL_LINE_JOINTS_V10_EDITED_FAST_MANIM_TREE: &str =
    "8007d53a31d2918e81116c675c352edc761a6ef2";
const REAL_LINE_JOINTS_V10_EDITED_PRODUCER_SNAPSHOT_DIGEST: &str =
    "6262b10ed9af78be6ad939987f043ed52d6500b392c4d0007070937bc1abaac8";
const REAL_LINE_JOINTS_V10_EDITED_SNAPSHOT_HASH: &str =
    "3de97161c0f5ff210f2a0b7e461bc7067dcc8a0eb92c66f02d3a870dfbd27a7f";
const REAL_LINE_JOINTS_V10_EDIT_ANCHOR: &str =
    "        grp.set(width=config.frame_width - 1)\n\n        self.add(grp)";
const REAL_LINE_JOINTS_V10_EDIT_REPLACEMENT: &str = "        grp.set(width=config.frame_width - 1)\n        t2.move_to((1.25, -0.5, 0))\n        t2.scale(0.5)\n\n        self.add(grp)";
const REAL_SPIRAL_IN_V11_FIXTURE_ID: &str = "eng-v1-real-spiral-in-v11";
const REAL_SPIRAL_IN_V11_FIXTURE_PATH: &str = "fixtures/engine-v1/real-spiral-in-v11.json";
const REAL_SPIRAL_IN_V11_SOURCE_PATH: &str = "example_scenes/basic.py";
const REAL_SPIRAL_IN_V11_SOURCE_MIRROR_PATH: &str =
    "fixtures/real-preview-harness/example_scenes/basic.py";
const REAL_SPIRAL_IN_V11_SOURCE_SHA256: &str =
    "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f";
const REAL_SPIRAL_IN_V11_ENGINE_COMMIT: &str = "e5423a8cb79a8326d42337e204ed12784750cdf1";
const REAL_SPIRAL_IN_V11_FAST_MANIM_COMMIT: &str = "4a6eaf1b4085ed643698da5116dd23814411eb5b";
const REAL_SPIRAL_IN_V11_FAST_MANIM_TREE: &str = "6fad77addc72e1a97440265e27d02630cf5b37b4";
const REAL_SPIRAL_IN_V11_PRODUCER_SNAPSHOT_DIGEST: &str =
    "f10b64b47c0aa8d663a01dfb58a6d20057608a0c324f97b436a9c13becefcbea";
const REAL_SPIRAL_IN_V11_SNAPSHOT_HASH: &str =
    "fccc297be458cb3a066842d0f94f8d60575dd5492371c82d6d8be1e53b01d1e0";
const REAL_SPIRAL_IN_V11_SAMPLES: [(&str, &str, f64); 7] = [
    ("real-spiral-in-v11--start", "start", 0.0),
    ("real-spiral-in-v11--early-reveal", "early-reveal", 0.1),
    (
        "real-spiral-in-v11--spiral-midpoint",
        "spiral-midpoint",
        0.5,
    ),
    ("real-spiral-in-v11--spiral-end", "spiral-end", 1.0),
    ("real-spiral-in-v11--hold", "hold", 1.5),
    (
        "real-spiral-in-v11--group-fade-midpoint",
        "group-fade-midpoint",
        2.5,
    ),
    ("real-spiral-in-v11--end", "end", 3.0),
];

#[derive(Clone, Copy)]
struct RealLineJointsV10Contract {
    artifact_label: &'static str,
    edited: bool,
    entry_id: &'static str,
    fast_manim_commit: &'static str,
    fast_manim_tree: Option<&'static str>,
    fixture_id: &'static str,
    fixture_path: &'static str,
    producer_snapshot_digest: Option<&'static str>,
    snapshot_hash: &'static str,
    source_sha256: &'static str,
}

const REAL_LINE_JOINTS_V10_CONTRACT: RealLineJointsV10Contract = RealLineJointsV10Contract {
    artifact_label: "real-line-joints-v10",
    edited: false,
    entry_id: REAL_LINE_JOINTS_V10_ENTRY_V1,
    fast_manim_commit: REAL_LINE_JOINTS_V10_FAST_MANIM_COMMIT,
    fast_manim_tree: None,
    fixture_id: REAL_LINE_JOINTS_V10_FIXTURE_ID,
    fixture_path: REAL_LINE_JOINTS_V10_FIXTURE_PATH,
    producer_snapshot_digest: None,
    snapshot_hash: REAL_LINE_JOINTS_V10_SNAPSHOT_HASH,
    source_sha256: REAL_LINE_JOINTS_V10_SOURCE_SHA256,
};

const REAL_LINE_JOINTS_V10_EDITED_CONTRACT: RealLineJointsV10Contract = RealLineJointsV10Contract {
    artifact_label: "real-line-joints-v10-edited",
    edited: true,
    entry_id: REAL_LINE_JOINTS_V10_EDITED_ENTRY_V1,
    fast_manim_commit: REAL_LINE_JOINTS_V10_EDITED_FAST_MANIM_COMMIT,
    fast_manim_tree: Some(REAL_LINE_JOINTS_V10_EDITED_FAST_MANIM_TREE),
    fixture_id: REAL_LINE_JOINTS_V10_EDITED_FIXTURE_ID,
    fixture_path: REAL_LINE_JOINTS_V10_EDITED_FIXTURE_PATH,
    producer_snapshot_digest: Some(REAL_LINE_JOINTS_V10_EDITED_PRODUCER_SNAPSHOT_DIGEST),
    snapshot_hash: REAL_LINE_JOINTS_V10_EDITED_SNAPSHOT_HASH,
    source_sha256: REAL_LINE_JOINTS_V10_EDITED_SOURCE_SHA256,
};
const VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1: &str = "POIETRA_VISUAL_PARITY_NATIVE_ARTIFACT_DIR";
const SEMANTIC_NUMBER_SCALE: f64 = 1_000_000_000.0;

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn load_visual_parity_entry(entry_id: &str) -> VisualParityCorpusEntry {
    let path = repository_root().join("fixtures/visual-parity-v1/corpus.json");
    let corpus: VisualParityCorpus =
        serde_json::from_slice(&fs::read(path).expect("visual parity corpus must be readable"))
            .expect("visual parity corpus must match its strict native envelope");
    assert_eq!(corpus.schema, VISUAL_PARITY_CORPUS_SCHEMA_V1);
    assert_eq!(corpus.version, 1);
    assert_eq!(
        corpus.default_thresholds,
        serde_json::json!({
            "maximumPixelFractionAboveThreshold": 0.005,
            "minimumSsim": 0.995,
        })
    );
    assert_eq!(
        corpus
            .metric_contract
            .get("schema")
            .and_then(serde_json::Value::as_str),
        Some("poietra.visual-parity-metric")
    );
    assert_eq!(
        corpus
            .metric_contract
            .get("version")
            .and_then(serde_json::Value::as_u64),
        Some(1)
    );
    let entry = corpus
        .entries
        .into_iter()
        .find(|entry| entry.id == entry_id)
        .unwrap_or_else(|| panic!("visual parity corpus entry {entry_id} must exist"));
    assert!(
        entry.threshold_exception.is_null(),
        "the corpus item must use the v1 default gate"
    );
    entry
}

#[allow(clippy::cast_possible_truncation)]
fn normalize_semantic_numbers(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Number(number) => {
            let scaled = (number
                .as_f64()
                .expect("frame semantics must contain finite JSON numbers")
                * SEMANTIC_NUMBER_SCALE)
                .round() as i64;
            *number = scaled.into();
        }
        serde_json::Value::Array(entries) => {
            entries.iter_mut().for_each(normalize_semantic_numbers);
        }
        serde_json::Value::Object(entries) => {
            entries.values_mut().for_each(normalize_semantic_numbers);
        }
        serde_json::Value::Bool(_) | serde_json::Value::Null | serde_json::Value::String(_) => {}
    }
}

fn render_packet_semantic_digest(packet: &RenderPacketV1) -> String {
    let mut normalized = serde_json::json!({
        "camera": packet.camera,
        "draws": packet.draws,
    });
    if packet.compositing != RenderCompositingV1::LinearLight {
        normalized
            .as_object_mut()
            .expect("frame semantics must remain an object")
            .insert(
                "compositing".to_owned(),
                serde_json::to_value(packet.compositing)
                    .expect("render compositing semantics must serialize"),
            );
    }
    normalize_semantic_numbers(&mut normalized);
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&normalized).expect("normalized frame semantics must serialize")
        )
    )
}

fn adapter_evidence(adapter_info: &wgpu::AdapterInfo) -> AdapterEvidence {
    AdapterEvidence {
        backend: format!("{:?}", adapter_info.backend),
        device: adapter_info.device,
        device_type: format!("{:?}", adapter_info.device_type),
        driver: adapter_info.driver.clone(),
        driver_info: adapter_info.driver_info.clone(),
        fallback_requested: true,
        name: adapter_info.name.clone(),
        vendor: adapter_info.vendor,
    }
}

fn emit_native_visual_parity_artifact(
    entry: &VisualParityCorpusEntry,
    adapter_info: &wgpu::AdapterInfo,
    target_format: wgpu::TextureFormat,
    rgba: &[u8],
) -> bool {
    let Some(root) = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1) else {
        return false;
    };
    assert!(
        !entry.id.contains('/') && !entry.id.contains('\\'),
        "corpus entry id must be one safe artifact path component"
    );
    let expected_byte_length = usize::try_from(entry.sample.viewport.width_px)
        .expect("viewport width must fit usize")
        .checked_mul(
            usize::try_from(entry.sample.viewport.height_px)
                .expect("viewport height must fit usize"),
        )
        .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL as usize))
        .expect("visual parity RGBA size must fit usize");
    assert_eq!(
        rgba.len(),
        expected_byte_length,
        "native artifact must be unpadded RGBA"
    );
    let root = PathBuf::from(root);
    let output = if root.is_absolute() {
        root
    } else {
        repository_root().join(root)
    }
    .join(&entry.id);
    fs::create_dir_all(&output).expect("native visual parity artifact directory must be created");
    fs::write(output.join("expected.rgba"), rgba)
        .expect("native visual parity RGBA must be written");
    let metadata = NativeVisualParityArtifact {
        adapter: adapter_evidence(adapter_info),
        capture: NativeVisualParityCapture {
            policy: "final-readback-submit-after-render-return",
        },
        corpus_entry_id: &entry.id,
        fixture: NativeVisualParityFixture {
            fixture_id: &entry.fixture.id,
            fixture_path: &entry.fixture.path,
            fixture_revision: &entry.fixture.revision.sha256,
            sample_id: &entry.sample.id,
            sample_time: entry.sample.sample_time,
            semantic_digest: &entry.sample.semantic_digest,
            viewport: entry.sample.viewport.clone(),
        },
        rgba: NativeVisualParityRgba {
            byte_length: rgba.len(),
            channel_order: "rgba",
            path: "expected.rgba",
            row_order: "top-to-bottom",
            row_stride_bytes: entry
                .sample
                .viewport
                .width_px
                .checked_mul(BYTES_PER_PIXEL)
                .expect("native artifact row stride must fit u32"),
            sha256: format!("{:x}", Sha256::digest(rgba)),
        },
        schema: "poietra.visual-parity-native-artifact",
        target: NativeVisualParityTarget {
            color_domain: "srgb-u8",
            format: match target_format {
                wgpu::TextureFormat::Rgba8Unorm => "Rgba8Unorm",
                wgpu::TextureFormat::Rgba8UnormSrgb => "Rgba8UnormSrgb",
                _ => panic!("native visual parity artifacts require an RGBA8 target"),
            },
        },
        version: 1,
    };
    let mut metadata_bytes =
        serde_json::to_vec_pretty(&metadata).expect("native visual parity metadata must serialize");
    metadata_bytes.push(b'\n');
    fs::write(output.join("metadata.json"), metadata_bytes)
        .expect("native visual parity metadata must be written");
    println!("poietra-visual-parity-native-artifact={}", output.display());
    true
}

fn padded_bytes_per_row(width_px: u32) -> (u32, u32) {
    let unpadded = width_px
        .checked_mul(BYTES_PER_PIXEL)
        .expect("viewport row size must fit u32");
    let alignment = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let aligned_rows = unpadded
        .checked_add(alignment - 1)
        .expect("aligned row size must fit u32")
        / alignment;
    let padded = aligned_rows
        .checked_mul(alignment)
        .expect("padded row size must fit u32");
    (unpadded, padded)
}

fn pixel(rgba: &[u8], width_px: u32, x: u32, y: u32) -> [u8; 4] {
    assert!(x < width_px, "pixel x must be inside the viewport");
    let pixel_offset = y
        .checked_mul(width_px)
        .and_then(|offset| offset.checked_add(x))
        .and_then(|offset| offset.checked_mul(BYTES_PER_PIXEL))
        .and_then(|offset| usize::try_from(offset).ok())
        .expect("pixel offset must fit usize");
    let pixel_end = pixel_offset
        .checked_add(4)
        .expect("pixel end must fit usize");
    rgba.get(pixel_offset..pixel_end)
        .expect("pixel y must be inside the viewport")
        .try_into()
        .expect("RGBA8 pixel must contain four channels")
}

fn assert_pixel_close(actual: [u8; 4], expected: [u8; 4], tolerance: [u8; 4]) {
    for ((actual, expected), tolerance) in actual.into_iter().zip(expected).zip(tolerance) {
        assert!(
            actual.abs_diff(expected) <= tolerance,
            "expected channel {expected} +/- {tolerance}, received {actual}"
        );
    }
}

fn assert_no_gpu_error(kind: &str, error: Option<wgpu::Error>) {
    let Some(error) = error else {
        return;
    };
    panic!("{kind} GPU error: {error:?}");
}

fn request_fallback_adapter(instance: &wgpu::Instance) -> wgpu::Adapter {
    pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        apply_limit_buckets: false,
        compatible_surface: None,
        force_fallback_adapter: true,
        power_preference: wgpu::PowerPreference::None,
    }))
    .expect("a native fallback WGPU adapter is required for this proof")
}

fn assert_target_format_support(adapter: &wgpu::Adapter) {
    let required_texture_usages =
        wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT;
    for format in [TARGET_FORMAT, MANIM_CAIRO_TARGET_FORMAT] {
        let format_features = adapter.get_texture_format_features(format);
        assert!(
            format_features
                .allowed_usages
                .contains(required_texture_usages),
            "fallback adapter must support {format:?} as a copyable render attachment"
        );
    }
}

fn request_device(adapter: &wgpu::Adapter) -> (wgpu::Device, wgpu::Queue) {
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("poietra headless proof device"),
        memory_hints: wgpu::MemoryHints::MemoryUsage,
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_defaults(),
        ..Default::default()
    }))
    .expect("fallback adapter must create the proof device")
}

fn track_device_loss(
    device: &wgpu::Device,
) -> Arc<Mutex<Option<(wgpu::DeviceLostReason, String)>>> {
    let device_loss = Arc::new(Mutex::new(None));
    let reported_device_loss = Arc::clone(&device_loss);
    device.set_device_lost_callback(move |reason, message| {
        *reported_device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned") = Some((reason, message));
    });
    device_loss
}

fn render_packet(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &mut WgpuPaintRendererV1,
    packet: &RenderPacketV1,
) -> (wgpu::Texture, wgpu::Extent3d) {
    let prepared = prepare_frame_v1(packet).expect("packet must prepare");
    render_prepared(device, queue, renderer, &prepared)
}

fn render_packet_with_assets(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &mut WgpuPaintRendererV1,
    packet: &RenderPacketV1,
    assets: &dyn DecodedPngAssetResolverV1,
) -> (wgpu::Texture, wgpu::Extent3d) {
    let prepared = prepare_frame_with_assets_v1(packet, assets).expect("image packet must prepare");
    render_prepared(device, queue, renderer, &prepared)
}

fn render_prepared(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    renderer: &mut WgpuPaintRendererV1,
    prepared: &PreparedFrameV1,
) -> (wgpu::Texture, wgpu::Extent3d) {
    let [width_px, height_px] = prepared.viewport();
    let extent = wgpu::Extent3d {
        depth_or_array_layers: 1,
        height: height_px,
        width: width_px,
    };
    let target_format = match prepared.compositing() {
        RenderCompositingV1::LinearLight => TARGET_FORMAT,
        RenderCompositingV1::ManimCairoSrgb => MANIM_CAIRO_TARGET_FORMAT,
    };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("poietra headless proof target"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: target_format,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    renderer
        .render(
            device,
            queue,
            WgpuRenderTargetV1 {
                format: target_format,
                height_px,
                view: &view,
                width_px,
            },
            prepared,
        )
        .expect("prepared fixture must submit to the proof target");
    (texture, extent)
}

fn readback_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    extent: wgpu::Extent3d,
) -> (u32, Vec<u8>) {
    let (unpadded_bytes_per_row, padded_bytes_per_row) = padded_bytes_per_row(extent.width);
    let readback_size = u64::from(padded_bytes_per_row)
        .checked_mul(u64::from(extent.height))
        .expect("readback buffer size must fit u64");
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("poietra headless proof readback"),
        size: readback_size,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut copy_encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("poietra headless proof copy encoder"),
    });
    copy_encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(extent.height),
            },
        },
        extent,
    );
    let copy_submission = queue.submit([copy_encoder.finish()]);

    let (map_sender, map_receiver) = mpsc::sync_channel(1);
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            map_sender
                .send(result)
                .expect("map receiver must remain alive through device polling");
        });
    let poll_status = device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(copy_submission),
            timeout: Some(GPU_TIMEOUT),
        })
        .expect("GPU proof submission must finish before the timeout");
    assert!(poll_status.wait_finished(), "GPU proof wait must finish");
    map_receiver
        .recv_timeout(GPU_TIMEOUT)
        .expect("map callback must run during device polling")
        .expect("readback buffer must map successfully");

    let mapped = readback
        .slice(..)
        .get_mapped_range()
        .expect("mapped readback range must be available");
    let padded_row_size =
        usize::try_from(padded_bytes_per_row).expect("padded row size must fit usize");
    let unpadded_row_size =
        usize::try_from(unpadded_bytes_per_row).expect("unpadded row size must fit usize");
    let height = usize::try_from(extent.height).expect("viewport height must fit usize");
    let rgba_size = unpadded_row_size
        .checked_mul(height)
        .expect("unpadded image size must fit usize");
    assert_eq!(
        mapped.len(),
        padded_row_size
            .checked_mul(height)
            .expect("mapped image size must fit usize")
    );
    let mut rgba = Vec::with_capacity(rgba_size);
    for row in mapped.chunks_exact(padded_row_size) {
        rgba.extend_from_slice(&row[..unpadded_row_size]);
    }
    assert_eq!(rgba.len(), rgba_size);
    drop(mapped);
    readback.unmap();
    (padded_bytes_per_row, rgba)
}

fn record_and_assert_evidence(
    adapter_info: &wgpu::AdapterInfo,
    padded_bytes_per_row: u32,
    rgba: &[u8],
    viewport: [u32; 2],
) {
    let [width_px, _] = viewport;
    let pixels = PixelEvidence {
        background: pixel(rgba, width_px, 0, 0),
        blue_center: pixel(rgba, width_px, 90, 45),
        green_cap_exterior: pixel(rgba, width_px, 34, 25),
        green_round_cap: pixel(rgba, width_px, 36, 25),
        green_stroke_center: pixel(rgba, width_px, 50, 25),
        red_center: pixel(rgba, width_px, 70, 45),
    };
    let evidence = SmokeEvidence {
        adapter: adapter_evidence(adapter_info),
        format: format!("{TARGET_FORMAT:?}"),
        padded_bytes_per_row,
        pixels,
        status: "rendered",
        viewport,
    };
    println!(
        "poietra-wgpu-evidence={}",
        serde_json::to_string(&evidence).expect("adapter evidence must serialize")
    );

    assert_eq!(evidence.pixels.background, [0, 0, 0, 255]);
    assert_pixel_close(evidence.pixels.red_center, [188, 0, 0, 255], [1, 0, 0, 0]);
    assert_eq!(evidence.pixels.blue_center, [0, 0, 255, 255]);
    assert_eq!(evidence.pixels.green_cap_exterior, [0, 0, 0, 255]);
    assert_pixel_close(
        evidence.pixels.green_round_cap,
        [0, 188, 0, 255],
        [0, 1, 0, 0],
    );
    assert_pixel_close(
        evidence.pixels.green_stroke_center,
        [0, 188, 0, 255],
        [0, 1, 0, 0],
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_shared_fixture_with_fallback_adapter() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(
        adapter_info.device_type,
        wgpu::DeviceType::Cpu,
        "force_fallback_adapter must resolve to a CPU adapter"
    );
    assert_target_format_support(&adapter);

    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let (texture, extent) = render_packet(&device, &queue, &mut renderer, &sampled_packet());
    let (padded_bytes_per_row, rgba) = readback_texture(&device, &queue, &texture, extent);

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through readback"
    );
    record_and_assert_evidence(
        &adapter_info,
        padded_bytes_per_row,
        &rgba,
        [extent.width, extent.height],
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_manim_cairo_srgb_overlap_on_a_non_black_background() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let mut packet = empty_render_packet(
        ViewportV1 {
            height_px: 4,
            width_px: 8,
        },
        RenderCameraV1 {
            bottom: -1.0,
            clear_color: RgbaColorV1 {
                alpha: 1.0,
                blue: 0.6,
                green: 0.4,
                red: 0.2,
            },
            kind: RenderCameraKindV1::Orthographic2d,
            left: -2.0,
            right: 2.0,
            top: 1.0,
        },
    );
    packet.compositing = RenderCompositingV1::ManimCairoSrgb;
    packet.draws = vec![
        solid_rectangle_draw(
            "draw:cairo:red",
            "entity:cairo:red",
            &ImageLocalRectV1 {
                bottom: -1.0,
                left: -2.0,
                right: 0.75,
                top: 1.0,
            },
            RgbaColorV1 {
                alpha: 1.0,
                blue: 0.1,
                green: 0.2,
                red: 0.8,
            },
            0.5,
            0,
        ),
        solid_rectangle_draw(
            "draw:cairo:green",
            "entity:cairo:green",
            &ImageLocalRectV1 {
                bottom: -1.0,
                left: -0.75,
                right: 2.0,
                top: 1.0,
            },
            RgbaColorV1 {
                alpha: 1.0,
                blue: 0.3,
                green: 0.8,
                red: 0.1,
            },
            0.25,
            1,
        ),
    ];
    packet.required_capabilities = vec![RenderCapabilityV1::CubicPathFill];

    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT).unwrap();
    let (texture, extent) = render_packet(&device, &queue, &mut renderer, &packet);
    let (_, rgba) = readback_texture(&device, &queue, &texture, extent);

    assert_pixel_close(
        pixel(&rgba, extent.width, 1, 2),
        [128, 77, 89, 255],
        [2, 2, 2, 0],
    );
    assert_pixel_close(
        pixel(&rgba, extent.width, 3, 2),
        [102, 109, 86, 255],
        [2, 2, 2, 0],
    );
    assert_pixel_close(
        pixel(&rgba, extent.width, 6, 2),
        [45, 128, 134, 255],
        [2, 2, 2, 0],
    );
}

fn dynamic_fixture() -> (DynamicFixture, SceneIrBundleV1) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/engine-v1/dynamic-affine-camera.json");
    let fixture: DynamicFixture =
        serde_json::from_slice(&fs::read(path).expect("shared dynamic fixture must be readable"))
            .expect("shared dynamic fixture envelope must deserialize");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("shared dynamic fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn png_visual_parity_fixture() -> (PngVisualParityFixture, SceneIrBundleV1) {
    let path = repository_root().join("fixtures/engine-v1/png-alpha-edge-camera.json");
    let fixture: PngVisualParityFixture = serde_json::from_slice(
        &fs::read(path).expect("PNG visual parity fixture must be readable"),
    )
    .expect("PNG visual parity fixture envelope must deserialize");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("PNG visual parity fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn mathtex_visual_parity_fixture() -> (MathTexVisualParityFixture, SceneIrBundleV1) {
    let path = repository_root().join("fixtures/engine-v1/mathtex-nested-radical-fraction.json");
    let fixture: MathTexVisualParityFixture = serde_json::from_slice(
        &fs::read(path).expect("MathTex visual parity fixture must be readable"),
    )
    .expect("MathTex visual parity fixture envelope must deserialize");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("MathTex visual parity fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn real_mathtex_morph_v5_fixture() -> (RealSnapshotVisualParityFixture, SceneIrBundleV1) {
    let path = repository_root().join(REAL_MATHTEX_MORPH_V5_FIXTURE_PATH);
    let fixture: RealSnapshotVisualParityFixture = serde_json::from_slice(
        &fs::read(path).expect("real MathTex morph V5 fixture must be readable"),
    )
    .expect("real MathTex morph V5 fixture must match its strict native envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("real MathTex morph V5 fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn real_generic_vmobject_v6_fixture() -> (RealSnapshotVisualParityFixture, SceneIrBundleV1) {
    let path = repository_root().join(REAL_GENERIC_VMOBJECT_V6_FIXTURE_PATH);
    let fixture: RealSnapshotVisualParityFixture = serde_json::from_slice(
        &fs::read(path).expect("real generic VMobject V6 fixture must be readable"),
    )
    .expect("real generic VMobject V6 fixture must match its strict native envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("real generic VMobject V6 fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn real_square_to_circle_v8_fixture() -> (RealSnapshotVisualParityFixture, SceneIrBundleV1) {
    let path = repository_root().join(REAL_SQUARE_TO_CIRCLE_V8_FIXTURE_PATH);
    let fixture: RealSnapshotVisualParityFixture = serde_json::from_slice(
        &fs::read(path).expect("real SquareToCircle V8 fixture must be readable"),
    )
    .expect("real SquareToCircle V8 fixture must match its strict native envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("real SquareToCircle V8 fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn real_warp_square_v9_fixture() -> (RealSnapshotVisualParityFixture, SceneIrBundleV1) {
    let path = repository_root().join(REAL_WARP_SQUARE_V9_FIXTURE_PATH);
    let fixture: RealSnapshotVisualParityFixture = serde_json::from_slice(
        &fs::read(path).expect("real WarpSquare V9 fixture must be readable"),
    )
    .expect("real WarpSquare V9 fixture must match its strict native envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("real WarpSquare V9 fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn real_spiral_in_v11_fixture() -> (RealSnapshotVisualParityFixture, SceneIrBundleV1) {
    let path = repository_root().join(REAL_SPIRAL_IN_V11_FIXTURE_PATH);
    let fixture: RealSnapshotVisualParityFixture = serde_json::from_slice(
        &fs::read(path).expect("real SpiralIn V11 fixture must be readable"),
    )
    .expect("real SpiralIn V11 fixture must match its strict native envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("real SpiralIn V11 fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn real_line_joints_v10_fixture(
    contract: RealLineJointsV10Contract,
) -> (RealSnapshotVisualParityFixture, SceneIrBundleV1) {
    let path = repository_root().join(contract.fixture_path);
    let fixture: RealSnapshotVisualParityFixture = serde_json::from_slice(
        &fs::read(path).expect("real LineJoints V10 fixture must be readable"),
    )
    .expect("real LineJoints V10 fixture must match its strict native envelope");
    let bundle = serde_json::from_value(serde_json::json!({
        "assets": fixture.assets,
        "scene": fixture.scene,
    }))
    .expect("real LineJoints V10 fixture must contain a valid Scene bundle");
    (fixture, bundle)
}

fn non_background_bounds(rgba: &[u8], width_px: u32, height_px: u32) -> Option<[u32; 4]> {
    let background = pixel(rgba, width_px, 0, 0);
    let mut bounds: Option<[u32; 4]> = None;
    for y in 0..height_px {
        for x in 0..width_px {
            if pixel(rgba, width_px, x, y) == background {
                continue;
            }
            bounds = Some(bounds.map_or([x, y, x, y], |[left, top, right, bottom]| {
                [left.min(x), top.min(y), right.max(x), bottom.max(y)]
            }));
        }
    }
    bounds
}

fn closed_subpath_is_nonconvex(subpath: &CubicSubpathV1) -> bool {
    if !subpath.closed {
        return false;
    }
    let mut vertices = vec![&subpath.start];
    vertices.extend(subpath.segments.iter().map(|segment| &segment.end));
    if vertices.last() == vertices.first() {
        vertices.pop();
    }
    if vertices.len() < 4 {
        return false;
    }
    let mut positive_turn = false;
    let mut negative_turn = false;
    for index in 0..vertices.len() {
        let previous = vertices[(index + vertices.len() - 1) % vertices.len()];
        let current = vertices[index];
        let next = vertices[(index + 1) % vertices.len()];
        let cross = (current.x - previous.x) * (next.y - current.y)
            - (current.y - previous.y) * (next.x - current.x);
        positive_turn |= cross > 1.0e-9;
        negative_turn |= cross < -1.0e-9;
    }
    positive_turn && negative_turn
}

fn open_subpath_has_curve(subpath: &CubicSubpathV1) -> bool {
    if subpath.closed {
        return false;
    }
    let mut start = &subpath.start;
    for segment in &subpath.segments {
        let chord_x = segment.end.x - start.x;
        let chord_y = segment.end.y - start.y;
        for control in [&segment.control1, &segment.control2] {
            let cross = chord_x * (control.y - start.y) - chord_y * (control.x - start.x);
            if cross.abs() > 1.0e-9 {
                return true;
            }
        }
        start = &segment.end;
    }
    false
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
#[allow(clippy::too_many_lines)] // One dynamic GPU proof keeps shared probes and the opt-in artifact bound together.
fn renders_dynamic_affine_camera_samples_with_fallback_adapter() {
    let (fixture, bundle) = dynamic_fixture();
    let visual_parity_entry = load_visual_parity_entry(VISUAL_PARITY_ENTRY_V1);
    assert_eq!(visual_parity_entry.fixture.id, fixture.id);
    assert_eq!(
        visual_parity_entry.fixture.path,
        "fixtures/engine-v1/dynamic-affine-camera.json"
    );
    assert_eq!(
        visual_parity_entry.fixture.revision.kind,
        "studio-edit-program"
    );
    assert!(matches!(
        &bundle.scene.source,
        SceneSourceV1::StudioEditProgram { .. }
    ));
    assert_eq!(
        bundle.scene.source.revision_hash(),
        visual_parity_entry.fixture.revision.sha256
    );
    let selected_sample = fixture
        .samples
        .iter()
        .find(|sample| sample.id == visual_parity_entry.sample.id)
        .expect("visual parity sample must exist in the shared dynamic fixture");
    assert_eq!(
        selected_sample.sample_time.to_bits(),
        visual_parity_entry.sample.sample_time.to_bits()
    );
    assert_eq!(
        selected_sample.viewport,
        visual_parity_entry.sample.viewport
    );
    assert_eq!(
        selected_sample.expected.semantic_digest,
        visual_parity_entry.sample.semantic_digest
    );
    let session = EngineSessionV1::new(bundle).expect("dynamic fixture must install");
    let DynamicFixture {
        id,
        pixel_references,
        samples,
        ..
    } = fixture;
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(adapter_info.device_type, wgpu::DeviceType::Cpu);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");

    let mut frames_by_sample = std::collections::BTreeMap::new();
    let artifact_requested = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1).is_some();
    let mut artifact_emitted = false;
    for sample in samples {
        let reference = pixel_references
            .get(&sample.expected.pixel_reference_id)
            .unwrap_or_else(|| panic!("{} must select a pixel reference", sample.id));
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[id.clone(), sample.id.clone()],
                packet_id: &sample.packet_id,
                sample_time: sample.sample_time,
                viewport: sample.viewport,
            })
            .unwrap_or_else(|error| panic!("{} must sample: {error}", sample.id));
        let semantic_digest = render_packet_semantic_digest(&packet);
        assert_eq!(
            semantic_digest, sample.expected.semantic_digest,
            "{}",
            sample.id
        );
        let (texture, extent) = render_packet(&device, &queue, &mut renderer, &packet);
        let (_, rgba) = readback_texture(&device, &queue, &texture, extent);
        if sample.id == visual_parity_entry.sample.id {
            assert_eq!(semantic_digest, visual_parity_entry.sample.semantic_digest);
            assert!(
                !artifact_emitted,
                "visual parity artifact must be emitted once"
            );
            artifact_emitted = emit_native_visual_parity_artifact(
                &visual_parity_entry,
                &adapter_info,
                TARGET_FORMAT,
                &rgba,
            );
        }
        let bounds = non_background_bounds(&rgba, extent.width, extent.height);
        assert_eq!(
            bounds.is_none(),
            reference.clear_only,
            "{}: {}",
            sample.id,
            reference.reason
        );
        for (name, expected) in &reference.samples {
            let [x, y] = expected.at;
            assert!(
                x < extent.width && y < extent.height,
                "{name} must be in range"
            );
            assert_pixel_close(
                pixel(&rgba, extent.width, x, y),
                expected.rgba,
                [expected.tolerance; 4],
            );
        }
        println!(
            "poietra-dynamic-pixel-evidence={}:adapter={}:viewport={}x{}:bounds={bounds:?}:probes={}",
            sample.id,
            adapter_info.name,
            extent.width,
            extent.height,
            reference.samples.len(),
        );
        frames_by_sample.insert(sample.id, (bounds, rgba));
    }

    assert_eq!(frames_by_sample["a-repeat"], frames_by_sample["a-first"]);
    assert_eq!(frames_by_sample["a-after-end"], frames_by_sample["a-first"]);
    assert_eq!(
        artifact_emitted, artifact_requested,
        "an opt-in native artifact request must emit exactly one selected frame"
    );
    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through dynamic readback"
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
#[allow(clippy::too_many_lines)] // One scoped GPU proof keeps setup, 303 submissions, and error-pop evidence together.
fn retains_high_water_buffers_batches_and_writes_only_dirty_bytes() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let packet = sampled_packet();
    let prepared = prepare_frame_v1(&packet).unwrap();
    let [width_px, height_px] = prepared.viewport();
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("poietra retained arena proof target"),
        size: wgpu::Extent3d {
            depth_or_array_layers: 1,
            height: height_px,
            width: width_px,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TARGET_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let target = WgpuRenderTargetV1 {
        format: TARGET_FORMAT,
        height_px,
        view: &view,
        width_px,
    };
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT).unwrap();

    let mut small_packet = packet.clone();
    small_packet.draws.truncate(1);
    small_packet.required_capabilities = vec![RenderCapabilityV1::CubicPathFill];
    let small = prepare_frame_v1(&small_packet).unwrap();
    let (_, cold) = renderer
        .render_with_stage_evidence(&device, &queue, target, &small, None)
        .unwrap();
    assert_eq!(cold.buffer_creations, 2);
    assert_eq!(cold.draw_calls, 1);
    assert!(cold.upload_bytes > 0);

    let (_, growth) = renderer
        .render_with_stage_evidence(&device, &queue, target, &prepared, None)
        .unwrap();
    assert!(growth.buffer_creations > 0);
    assert_eq!(growth.draw_calls, 1);
    assert!(growth.upload_bytes > 0);

    for _ in 0..300 {
        let (_, warm) = renderer
            .render_with_stage_evidence(&device, &queue, target, &prepared, None)
            .unwrap();
        assert_eq!(warm.buffer_creations, 0);
        assert_eq!(warm.draw_calls, 1);
        assert_eq!(warm.upload_bytes, 0);
    }

    let mut material_packet = packet.clone();
    let RenderDrawV1::Path { opacity, .. } = &mut material_packet.draws[0] else {
        panic!("shared fixture first draw must be a path");
    };
    *opacity *= 0.5;
    let material_frame = prepare_frame_v1(&material_packet).unwrap();
    let (_, dirty) = renderer
        .render_with_stage_evidence(&device, &queue, target, &material_frame, None)
        .unwrap();
    assert_eq!(dirty.buffer_creations, 0);
    assert_eq!(dirty.draw_calls, 1);
    assert!(dirty.upload_bytes > 0);
    assert!(
        dirty.upload_bytes
            < build_gpu_upload_plan_v1(&material_frame)
                .unwrap()
                .upload_bytes() as u64
    );

    let mut empty_packet = packet;
    empty_packet.draws.clear();
    empty_packet.required_capabilities.clear();
    let empty = prepare_frame_v1(&empty_packet).unwrap();
    let (final_submission, empty_evidence) = renderer
        .render_with_stage_evidence(&device, &queue, target, &empty, None)
        .unwrap();
    assert_eq!(empty_evidence.buffer_creations, 0);
    assert_eq!(empty_evidence.draw_calls, 0);
    assert_eq!(empty_evidence.upload_bytes, 0);
    assert!(!empty_evidence.geometry_stages_executed);
    let poll_status = device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(final_submission),
            timeout: Some(GPU_TIMEOUT),
        })
        .expect("retained arena proof submission must finish");
    assert!(poll_status.wait_finished());
    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none()
    );
}

fn render_and_assert_shared_reference(
    packet: &RenderPacketV1,
    reference: PixelReferenceSet,
    evidence_name: &str,
    visual_parity_entry: Option<&VisualParityCorpusEntry>,
) {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let (texture, extent) = render_packet(&device, &queue, &mut renderer, packet);
    let (_, rgba) = readback_texture(&device, &queue, &texture, extent);
    assert_eq!(
        non_background_bounds(&rgba, extent.width, extent.height).is_none(),
        reference.clear_only,
        "{evidence_name}: {}",
        reference.reason
    );

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through {evidence_name} readback"
    );

    println!("poietra-{evidence_name}-reference={}", reference.reason);
    for (name, sample) in &reference.samples {
        let actual = pixel(&rgba, extent.width, sample.at[0], sample.at[1]);
        println!("poietra-{evidence_name}-pixel={name}:{actual:?}");
    }
    for (name, sample) in reference.samples {
        let actual = pixel(&rgba, extent.width, sample.at[0], sample.at[1]);
        assert_pixel_close(actual, sample.rgba, [sample.tolerance; 4]);
        println!("poietra-{evidence_name}-asserted={name}");
    }
    if let Some(entry) = visual_parity_entry {
        let artifact_requested = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1).is_some();
        assert_eq!(
            emit_native_visual_parity_artifact(entry, &adapter_info, TARGET_FORMAT, &rgba),
            artifact_requested,
            "the opt-in {evidence_name} native artifact must be emitted exactly once"
        );
    }
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_shared_generic_fill_fixture_with_fallback_adapter() {
    let (packet, reference) = generic_fill_fixture();
    render_and_assert_shared_reference(&packet, reference, "generic-fill", None);
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_shared_generic_stroke_fixture_with_fallback_adapter() {
    let (packet, reference) = generic_stroke_fixture();
    let visual_parity_entry = load_visual_parity_entry(GENERIC_STROKE_VISUAL_PARITY_ENTRY_V1);
    assert_eq!(
        visual_parity_entry.fixture.id,
        "eng-v1-generic-stroke-topology"
    );
    assert_eq!(
        visual_parity_entry.fixture.path,
        "fixtures/engine-v1/generic-stroke-topology.json"
    );
    assert_eq!(
        visual_parity_entry.fixture.revision.kind,
        "studio-edit-program"
    );

    let fixture: serde_json::Value = serde_json::from_slice(
        &fs::read(repository_root().join(&visual_parity_entry.fixture.path))
            .expect("generic stroke visual parity fixture must be readable"),
    )
    .expect("generic stroke visual parity fixture must be JSON");
    assert_eq!(
        fixture["id"].as_str(),
        Some(visual_parity_entry.fixture.id.as_str())
    );
    assert_eq!(
        fixture["scene"]["source"]["revisionHash"].as_str(),
        Some(visual_parity_entry.fixture.revision.sha256.as_str())
    );
    assert_eq!(
        fixture["sample"]["id"].as_str(),
        Some(visual_parity_entry.sample.id.as_str())
    );
    assert_eq!(
        fixture["sample"]["sampleTime"].as_f64().map(f64::to_bits),
        Some(visual_parity_entry.sample.sample_time.to_bits())
    );
    assert_eq!(
        packet.sample_time.to_bits(),
        visual_parity_entry.sample.sample_time.to_bits()
    );
    assert_eq!(
        packet.scene_revision_hash,
        visual_parity_entry.fixture.revision.sha256
    );
    assert_eq!(packet.viewport, visual_parity_entry.sample.viewport);
    assert_eq!(
        fixture["sample"]["expected"]["semanticDigest"].as_str(),
        Some(visual_parity_entry.sample.semantic_digest.as_str())
    );
    assert_eq!(
        render_packet_semantic_digest(&packet),
        visual_parity_entry.sample.semantic_digest
    );

    render_and_assert_shared_reference(
        &packet,
        reference,
        "generic-stroke",
        Some(&visual_parity_entry),
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
fn renders_round_capped_stroke_with_fallback_adapter() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let packet = straight_stroke_packet(StrokeCapV1::Round);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let (texture, extent) = render_packet(&device, &queue, &mut renderer, &packet);
    let (_, rgba) = readback_texture(&device, &queue, &texture, extent);

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through stroke readback"
    );

    assert_eq!(pixel(&rgba, extent.width, 54, 45), [0, 0, 0, 255]);
    assert_pixel_close(
        pixel(&rgba, extent.width, 56, 45),
        [0, 188, 0, 255],
        [0, 1, 0, 0],
    );
    assert_eq!(pixel(&rgba, extent.width, 56, 40), [0, 0, 0, 255]);
    assert_pixel_close(
        pixel(&rgba, extent.width, 80, 45),
        [0, 188, 0, 255],
        [0, 1, 0, 0],
    );
}

fn image_proof_camera(left: f64, right: f64, bottom: f64, top: f64) -> RenderCameraV1 {
    RenderCameraV1 {
        bottom,
        clear_color: RgbaColorV1 {
            alpha: 1.0,
            blue: 0.0,
            green: 0.0,
            red: 0.0,
        },
        kind: RenderCameraKindV1::Orthographic2d,
        left,
        right,
        top,
    }
}

fn assert_full_frame_close(actual: &[u8], expected: &[[u8; 4]], tolerance: u8) {
    assert_eq!(actual.len(), expected.len() * 4);
    for (index, (actual, expected)) in actual.chunks_exact(4).zip(expected).enumerate() {
        let actual: [u8; 4] = actual.try_into().expect("RGBA8 chunk must have four bytes");
        assert!(
            actual
                .into_iter()
                .zip(expected)
                .all(|(actual, expected)| actual.abs_diff(*expected) <= tolerance),
            "pixel {index}: expected {expected:?} +/- {tolerance}, received {actual:?}"
        );
    }
}

fn assert_full_rgba_bytes_close(actual: &[u8], expected: &[u8], tolerance: u8) {
    assert_eq!(actual.len(), expected.len(), "full RGBA frames must align");
    for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            actual.abs_diff(*expected) <= tolerance,
            "RGBA byte {index}: expected {expected} +/- {tolerance}, received {actual}"
        );
    }
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
fn renders_mathtex_nested_radical_fraction_with_fallback_adapter() {
    let (fixture, bundle) = mathtex_visual_parity_fixture();
    let visual_parity_entry = load_visual_parity_entry(MATHTEX_VISUAL_PARITY_ENTRY_V1);
    assert_eq!(visual_parity_entry.fixture.id, fixture.id);
    assert_eq!(
        visual_parity_entry.fixture.path,
        "fixtures/engine-v1/mathtex-nested-radical-fraction.json"
    );
    assert_eq!(
        visual_parity_entry.fixture.revision.kind,
        "studio-edit-program"
    );
    assert!(matches!(
        &bundle.scene.source,
        SceneSourceV1::StudioEditProgram { .. }
    ));
    assert_eq!(
        bundle.scene.source.revision_hash(),
        visual_parity_entry.fixture.revision.sha256
    );
    let sample = fixture
        .samples
        .iter()
        .find(|sample| sample.id == visual_parity_entry.sample.id)
        .expect("MathTex visual parity sample must exist");
    assert_eq!(
        sample.sample_time.to_bits(),
        visual_parity_entry.sample.sample_time.to_bits()
    );
    assert_eq!(sample.viewport, visual_parity_entry.sample.viewport);
    assert_eq!(
        sample.expected.semantic_digest,
        visual_parity_entry.sample.semantic_digest
    );

    let session = EngineSessionV1::new(bundle).expect("MathTex visual parity fixture must install");
    let packet = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[fixture.id.clone(), sample.id.clone()],
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            viewport: sample.viewport.clone(),
        })
        .expect("MathTex visual parity sample must compile");
    let semantic_digest = render_packet_semantic_digest(&packet);
    assert_eq!(semantic_digest, sample.expected.semantic_digest);
    let [RenderDrawV1::Path { path, .. }] = packet.draws.as_slice() else {
        panic!("MathTex visual parity sample must produce exactly one path draw");
    };
    assert_eq!(path.subpaths.len(), 10);

    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(adapter_info.device_type, wgpu::DeviceType::Cpu);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let (texture, extent) = render_packet(&device, &queue, &mut renderer, &packet);
    let (_, rgba) = readback_texture(&device, &queue, &texture, extent);
    assert_eq!(extent.width, sample.viewport.width_px);
    assert_eq!(extent.height, sample.viewport.height_px);
    assert!(
        non_background_bounds(&rgba, extent.width, extent.height).is_some(),
        "MathTex visual parity readback must contain visible ink"
    );

    let artifact_requested = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1).is_some();
    assert_eq!(
        emit_native_visual_parity_artifact(
            &visual_parity_entry,
            &adapter_info,
            TARGET_FORMAT,
            &rgba,
        ),
        artifact_requested,
        "the opt-in MathTex native artifact must be emitted exactly once"
    );
    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through MathTex visual parity readback"
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
#[allow(clippy::too_many_lines)] // One temporal proof intentionally shares one session, adapter, device, and renderer across all five samples.
fn renders_real_mathtex_morph_v5_samples_with_fallback_adapter() {
    let (fixture, bundle) = real_mathtex_morph_v5_fixture();
    assert_eq!(fixture.id, REAL_MATHTEX_MORPH_V5_FIXTURE_ID);
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v5"
    );
    assert_eq!(
        fixture.producer_reference.engine_commit,
        REAL_MATHTEX_MORPH_V5_ENGINE_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        REAL_MATHTEX_MORPH_V5_FAST_MANIM_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.snapshot_hash,
        REAL_MATHTEX_MORPH_V5_SNAPSHOT_HASH
    );
    assert_eq!(
        fixture.producer_reference.source_path,
        REAL_MATHTEX_MORPH_V5_SOURCE_PATH
    );
    assert_eq!(
        fixture.producer_reference.source_sha256,
        REAL_MATHTEX_MORPH_V5_SOURCE_SHA256
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(
                fs::read(repository_root().join(REAL_MATHTEX_MORPH_V5_SOURCE_PATH))
                    .expect("the real MathTex morph source must remain readable")
            )
        ),
        REAL_MATHTEX_MORPH_V5_SOURCE_SHA256,
        "the checked-in Python source must match the sealed producer provenance"
    );

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("real MathTex morph V5 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V5);
    assert_eq!(snapshot_hash, REAL_MATHTEX_MORPH_V5_SNAPSHOT_HASH);
    assert_eq!(source_hash, REAL_MATHTEX_MORPH_V5_SOURCE_SHA256);
    assert_eq!(
        bundle.scene.source.revision_hash(),
        REAL_MATHTEX_MORPH_V5_SNAPSHOT_HASH
    );
    assert_eq!(bundle.scene.duration.to_bits(), 5.5_f64.to_bits());
    assert_eq!(bundle.scene.entities.len(), 1);
    assert_eq!(bundle.scene.animation_channels.len(), 1);

    let visual_parity_entries =
        REAL_MATHTEX_MORPH_V5_SAMPLES.map(|(entry_id, _, _)| load_visual_parity_entry(entry_id));
    assert_eq!(fixture.samples.len(), REAL_MATHTEX_MORPH_V5_SAMPLES.len());
    let expected_viewport = ViewportV1 {
        height_px: 360,
        width_px: 640,
    };
    for (index, &(entry_id, sample_id, sample_time)) in
        REAL_MATHTEX_MORPH_V5_SAMPLES.iter().enumerate()
    {
        let entry = &visual_parity_entries[index];
        let sample = &fixture.samples[index];
        assert_eq!(entry.id, entry_id);
        assert_eq!(entry.fixture.id, REAL_MATHTEX_MORPH_V5_FIXTURE_ID);
        assert_eq!(entry.fixture.path, REAL_MATHTEX_MORPH_V5_FIXTURE_PATH);
        assert_eq!(
            entry.fixture.revision.kind,
            "imported-manim-server-snapshot"
        );
        assert_eq!(
            entry.fixture.revision.sha256,
            REAL_MATHTEX_MORPH_V5_SNAPSHOT_HASH
        );
        assert_eq!(entry.sample.id, sample_id);
        assert_eq!(entry.sample.sample_time.to_bits(), sample_time.to_bits());
        assert_eq!(entry.sample.viewport, expected_viewport);
        assert_eq!(sample.id, sample_id);
        assert_eq!(
            sample.packet_id,
            format!("real-mathtex-morph-v5:{sample_id}")
        );
        assert_eq!(sample.sample_time.to_bits(), sample_time.to_bits());
        assert_eq!(sample.viewport, expected_viewport);
        assert_eq!(
            sample.expected.semantic_digest, entry.sample.semantic_digest,
            "{sample_id} fixture and corpus semantics must stay pinned together"
        );
    }

    let session =
        EngineSessionV1::new(bundle).expect("real MathTex morph V5 fixture must install once");
    let sampled_packets = fixture
        .samples
        .iter()
        .map(|sample| {
            let packet = session
                .sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[fixture.id.clone(), sample.id.clone()],
                    packet_id: &sample.packet_id,
                    sample_time: sample.sample_time,
                    viewport: sample.viewport.clone(),
                })
                .unwrap_or_else(|error| panic!("{} must sample: {error}", sample.id));
            let semantic_digest = render_packet_semantic_digest(&packet);
            (packet, semantic_digest)
        })
        .collect::<Vec<_>>();
    for (index, (packet, semantic_digest)) in sampled_packets.iter().enumerate() {
        let sample = &fixture.samples[index];
        let entry = &visual_parity_entries[index];
        assert_eq!(packet.packet_id, sample.packet_id);
        assert_eq!(packet.sample_time.to_bits(), sample.sample_time.to_bits());
        assert_eq!(packet.viewport, sample.viewport);
        assert_eq!(
            packet.scene_revision_hash,
            REAL_MATHTEX_MORPH_V5_SNAPSHOT_HASH
        );
        assert_eq!(
            semantic_digest, &sample.expected.semantic_digest,
            "{} fixture semantic digest must match the native evaluator",
            sample.id
        );
        assert_eq!(
            semantic_digest, &entry.sample.semantic_digest,
            "{} corpus semantic digest must match the native evaluator",
            sample.id
        );
    }

    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(adapter_info.device_type, wgpu::DeviceType::Cpu);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let mut frames_by_sample = std::collections::BTreeMap::new();

    for (sample, (packet, _)) in fixture.samples.iter().zip(&sampled_packets) {
        let (texture, extent) = render_packet(&device, &queue, &mut renderer, packet);
        let (_, rgba) = readback_texture(&device, &queue, &texture, extent);
        assert_eq!(extent.width, sample.viewport.width_px);
        assert_eq!(extent.height, sample.viewport.height_px);
        assert!(
            non_background_bounds(&rgba, extent.width, extent.height).is_some(),
            "{} must retain visible MathTex ink",
            sample.id
        );
        assert!(
            frames_by_sample.insert(sample.id.clone(), rgba).is_none(),
            "real MathTex morph sample ids must be unique"
        );
    }

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through all five real MathTex morph readbacks"
    );
    assert_eq!(
        frames_by_sample["a-initial"], frames_by_sample["a-restored"],
        "the restored A frame must be byte-identical to the initial A frame"
    );
    assert_ne!(
        frames_by_sample["a-initial"], frames_by_sample["maxwell-hold"],
        "the Maxwell hold must differ from A"
    );
    assert_ne!(
        frames_by_sample["outbound-midpoint"], frames_by_sample["a-initial"],
        "the outbound midpoint must differ from its A endpoint"
    );
    assert_ne!(
        frames_by_sample["outbound-midpoint"], frames_by_sample["maxwell-hold"],
        "the outbound midpoint must differ from its Maxwell endpoint"
    );
    assert_ne!(
        frames_by_sample["return-midpoint"], frames_by_sample["maxwell-hold"],
        "the return midpoint must differ from its Maxwell endpoint"
    );
    assert_ne!(
        frames_by_sample["return-midpoint"], frames_by_sample["a-restored"],
        "the return midpoint must differ from its restored A endpoint"
    );

    let artifact_requested = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1).is_some();
    let artifact_count = visual_parity_entries
        .iter()
        .map(|entry| {
            usize::from(emit_native_visual_parity_artifact(
                entry,
                &adapter_info,
                TARGET_FORMAT,
                &frames_by_sample[&entry.sample.id],
            ))
        })
        .sum::<usize>();
    assert_eq!(
        artifact_count,
        if artifact_requested {
            REAL_MATHTEX_MORPH_V5_SAMPLES.len()
        } else {
            0
        },
        "an opt-in real MathTex morph artifact request must emit all five frames"
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
#[allow(clippy::too_many_lines)] // The single real-scene proof binds provenance, topology, one GPU readback, and one artifact.
fn renders_real_generic_vmobject_v6_static_with_fallback_adapter() {
    let (fixture, bundle) = real_generic_vmobject_v6_fixture();
    let entry = load_visual_parity_entry(REAL_GENERIC_VMOBJECT_V6_ENTRY_V1);
    assert_eq!(fixture.id, REAL_GENERIC_VMOBJECT_V6_FIXTURE_ID);
    assert_eq!(entry.fixture.id, fixture.id);
    assert_eq!(entry.fixture.path, REAL_GENERIC_VMOBJECT_V6_FIXTURE_PATH);
    assert_eq!(
        entry.fixture.revision.kind,
        "imported-manim-server-snapshot"
    );
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v6"
    );
    assert_eq!(
        fixture.producer_reference.source_path,
        REAL_GENERIC_VMOBJECT_V6_SOURCE_PATH
    );
    assert_eq!(
        fixture.producer_reference.snapshot_hash,
        entry.fixture.revision.sha256
    );
    for (label, commit) in [
        ("engine", &fixture.producer_reference.engine_commit),
        ("fast-manim", &fixture.producer_reference.fast_manim_commit),
    ] {
        assert!(
            commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "{label} producer commit must remain a full Git object ID"
        );
    }
    let source_sha256 = format!(
        "{:x}",
        Sha256::digest(
            fs::read(repository_root().join(REAL_GENERIC_VMOBJECT_V6_SOURCE_PATH))
                .expect("the real generic VMobject source must remain readable")
        )
    );
    assert_eq!(fixture.producer_reference.source_sha256, source_sha256);

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("real generic VMobject V6 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V6);
    assert_eq!(snapshot_hash, &entry.fixture.revision.sha256);
    assert_eq!(source_hash, &source_sha256);
    assert_eq!(bundle.scene.source.revision_hash(), snapshot_hash);
    assert_eq!(bundle.scene.animation_channels.len(), 0);
    assert_eq!(bundle.scene.entities.len(), 3);

    let [sample] = fixture.samples.as_slice() else {
        panic!("real generic VMobject V6 fixture must contain one static sample");
    };
    assert_eq!(sample.id, entry.sample.id);
    assert_eq!(
        sample.sample_time.to_bits(),
        entry.sample.sample_time.to_bits()
    );
    assert_eq!(sample.viewport, entry.sample.viewport);
    assert_eq!(
        sample.expected.semantic_digest,
        entry.sample.semantic_digest
    );
    let session =
        EngineSessionV1::new(bundle).expect("real generic VMobject V6 fixture must install");
    let packet = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[fixture.id.clone(), sample.id.clone()],
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            viewport: sample.viewport.clone(),
        })
        .expect("real generic VMobject V6 fixture must sample");
    assert_eq!(packet.scene_revision_hash, entry.fixture.revision.sha256);
    assert_eq!(
        render_packet_semantic_digest(&packet),
        sample.expected.semantic_digest
    );

    let path_draws = packet
        .draws
        .iter()
        .map(|draw| match draw {
            RenderDrawV1::Path {
                fill, path, stroke, ..
            } => (fill, path, stroke),
            _ => panic!("generic VMobject V6 must lower every leaf to a path draw"),
        })
        .collect::<Vec<_>>();
    assert_eq!(path_draws.len(), 3);
    assert!(
        path_draws.iter().any(|(fill, path, stroke)| {
            fill.is_some()
                && stroke.is_none()
                && path.subpaths.iter().any(closed_subpath_is_nonconvex)
        }),
        "the real scene must retain a nonconvex fill-only leaf"
    );
    assert!(
        path_draws.iter().any(|(fill, path, stroke)| {
            fill.is_none() && stroke.is_some() && path.subpaths.iter().any(open_subpath_has_curve)
        }),
        "the real scene must retain an open curved stroke-only leaf"
    );
    assert!(
        path_draws.iter().any(|(fill, path, stroke)| {
            fill.is_some() && stroke.is_some() && path.subpaths.iter().any(|subpath| subpath.closed)
        }),
        "the real scene must retain a closed fill-and-stroke leaf"
    );

    render_and_assert_shared_reference(
        &packet,
        PixelReferenceSet {
            clear_only: false,
            reason:
                "the real V6 scene must retain visible nonconvex, curved, and fill+stroke paint"
                    .to_owned(),
            samples: std::collections::BTreeMap::from([
                (
                    "nonconvex-fill".to_owned(),
                    PixelReference {
                        at: [160, 210],
                        rgba: [79, 177, 200, 255],
                        tolerance: 2,
                    },
                ),
                (
                    "curved-stroke".to_owned(),
                    PixelReference {
                        at: [292, 151],
                        rgba: [131, 193, 103, 255],
                        tolerance: 2,
                    },
                ),
                (
                    "fill-and-stroke".to_owned(),
                    PixelReference {
                        at: [450, 180],
                        rgba: [185, 70, 60, 255],
                        tolerance: 2,
                    },
                ),
            ]),
        },
        "real-generic-vmobject-v6",
        Some(&entry),
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
#[allow(clippy::too_many_lines)] // One temporal proof binds the sealed V8 fixture to five full-frame GPU artifacts.
fn renders_real_square_to_circle_v8_samples_with_fallback_adapter() {
    let (fixture, bundle) = real_square_to_circle_v8_fixture();
    assert_eq!(fixture.id, REAL_SQUARE_TO_CIRCLE_V8_FIXTURE_ID);
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v8"
    );
    assert_eq!(
        fixture.producer_reference.engine_commit,
        REAL_SQUARE_TO_CIRCLE_V8_ENGINE_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        REAL_SQUARE_TO_CIRCLE_V8_FAST_MANIM_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.snapshot_hash,
        REAL_SQUARE_TO_CIRCLE_V8_SNAPSHOT_HASH
    );
    assert_eq!(
        fixture.producer_reference.source_path,
        REAL_SQUARE_TO_CIRCLE_V8_SOURCE_PATH
    );
    assert_eq!(
        fixture.producer_reference.source_sha256,
        REAL_SQUARE_TO_CIRCLE_V8_SOURCE_SHA256
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(
                fs::read(repository_root().join(REAL_SQUARE_TO_CIRCLE_V8_SOURCE_PATH))
                    .expect("the real SquareToCircle source must remain readable")
            )
        ),
        REAL_SQUARE_TO_CIRCLE_V8_SOURCE_SHA256,
        "the checked-in Python source must match the sealed V8 provenance"
    );

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("real SquareToCircle V8 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V8);
    assert_eq!(snapshot_hash, REAL_SQUARE_TO_CIRCLE_V8_SNAPSHOT_HASH);
    assert_eq!(source_hash, REAL_SQUARE_TO_CIRCLE_V8_SOURCE_SHA256);
    assert_eq!(
        bundle.scene.source.revision_hash(),
        REAL_SQUARE_TO_CIRCLE_V8_SNAPSHOT_HASH
    );
    assert_eq!(bundle.scene.duration.to_bits(), 3.0_f64.to_bits());
    assert_eq!(bundle.scene.entities.len(), 1);
    assert_eq!(bundle.scene.animation_channels.len(), 4);

    let visual_parity_entries =
        REAL_SQUARE_TO_CIRCLE_V8_SAMPLES.map(|(entry_id, _, _)| load_visual_parity_entry(entry_id));
    assert_eq!(
        fixture.samples.len(),
        REAL_SQUARE_TO_CIRCLE_V8_SAMPLES.len()
    );
    let expected_viewport = ViewportV1 {
        height_px: 360,
        width_px: 640,
    };
    for (index, &(entry_id, sample_id, sample_time)) in
        REAL_SQUARE_TO_CIRCLE_V8_SAMPLES.iter().enumerate()
    {
        let entry = &visual_parity_entries[index];
        let sample = &fixture.samples[index];
        assert_eq!(entry.id, entry_id);
        assert_eq!(entry.fixture.id, REAL_SQUARE_TO_CIRCLE_V8_FIXTURE_ID);
        assert_eq!(entry.fixture.path, REAL_SQUARE_TO_CIRCLE_V8_FIXTURE_PATH);
        assert_eq!(
            entry.fixture.revision.kind,
            "imported-manim-server-snapshot"
        );
        assert_eq!(
            entry.fixture.revision.sha256,
            REAL_SQUARE_TO_CIRCLE_V8_SNAPSHOT_HASH
        );
        assert_eq!(entry.sample.id, sample_id);
        assert_eq!(entry.sample.sample_time.to_bits(), sample_time.to_bits());
        assert_eq!(entry.sample.viewport, expected_viewport);
        assert_eq!(sample.id, sample_id);
        assert_eq!(
            sample.packet_id,
            format!("real-square-to-circle-v8:{sample_id}")
        );
        assert_eq!(sample.sample_time.to_bits(), sample_time.to_bits());
        assert_eq!(sample.viewport, expected_viewport);
        assert_eq!(
            sample.expected.semantic_digest, entry.sample.semantic_digest,
            "{sample_id} fixture and corpus semantics must stay pinned together"
        );
    }

    let session =
        EngineSessionV1::new(bundle).expect("real SquareToCircle V8 fixture must install once");
    let sampled_packets = fixture
        .samples
        .iter()
        .map(|sample| {
            let packet = session
                .sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[fixture.id.clone(), sample.id.clone()],
                    packet_id: &sample.packet_id,
                    sample_time: sample.sample_time,
                    viewport: sample.viewport.clone(),
                })
                .unwrap_or_else(|error| panic!("{} must sample: {error}", sample.id));
            let semantic_digest = render_packet_semantic_digest(&packet);
            (packet, semantic_digest)
        })
        .collect::<Vec<_>>();
    for (index, (packet, semantic_digest)) in sampled_packets.iter().enumerate() {
        let sample = &fixture.samples[index];
        let entry = &visual_parity_entries[index];
        assert_eq!(packet.packet_id, sample.packet_id);
        assert_eq!(packet.sample_time.to_bits(), sample.sample_time.to_bits());
        assert_eq!(packet.viewport, sample.viewport);
        assert_eq!(
            packet.scene_revision_hash,
            REAL_SQUARE_TO_CIRCLE_V8_SNAPSHOT_HASH
        );
        assert_eq!(
            semantic_digest, &sample.expected.semantic_digest,
            "{} fixture semantic digest must match the native evaluator",
            sample.id
        );
        assert_eq!(
            semantic_digest, &entry.sample.semantic_digest,
            "{} corpus semantic digest must match the native evaluator",
            sample.id
        );
        assert!(matches!(
            packet.draws.as_slice(),
            [RenderDrawV1::Path { .. }]
        ));
    }
    let RenderDrawV1::Path {
        fill: Some(_),
        path,
        stroke: Some(_),
        ..
    } = &sampled_packets[2].0.draws[0]
    else {
        panic!("the analytic winding root must retain one fill-and-stroke path");
    };
    assert_eq!(path.subpaths[0].segments.len(), 8);

    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(adapter_info.device_type, wgpu::DeviceType::Cpu);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let mut frames_by_sample = std::collections::BTreeMap::new();

    for (sample, (packet, _)) in fixture.samples.iter().zip(&sampled_packets) {
        let (texture, extent) = render_packet(&device, &queue, &mut renderer, packet);
        let (_, rgba) = readback_texture(&device, &queue, &texture, extent);
        assert_eq!(extent.width, sample.viewport.width_px);
        assert_eq!(extent.height, sample.viewport.height_px);
        assert!(
            non_background_bounds(&rgba, extent.width, extent.height).is_some(),
            "{} must retain visible vector ink",
            sample.id
        );
        assert!(
            frames_by_sample.insert(sample.id.clone(), rgba).is_none(),
            "SquareToCircle V8 sample ids must be unique"
        );
    }

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through all five SquareToCircle V8 readbacks"
    );
    for (left, right) in [
        ("create-midpoint", "square"),
        ("square", "analytic-winding-root"),
        ("analytic-winding-root", "circle"),
        ("circle", "fade-midpoint"),
    ] {
        assert_ne!(
            frames_by_sample[left], frames_by_sample[right],
            "{left} and {right} must produce distinct full frames"
        );
    }

    let artifact_requested = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1).is_some();
    let artifact_count = visual_parity_entries
        .iter()
        .map(|entry| {
            usize::from(emit_native_visual_parity_artifact(
                entry,
                &adapter_info,
                TARGET_FORMAT,
                &frames_by_sample[&entry.sample.id],
            ))
        })
        .sum::<usize>();
    assert_eq!(
        artifact_count,
        if artifact_requested {
            REAL_SQUARE_TO_CIRCLE_V8_SAMPLES.len()
        } else {
            0
        },
        "an opt-in SquareToCircle V8 artifact request must emit all five frames"
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
#[allow(clippy::too_many_lines)] // One temporal proof binds the sealed V9 fixture to five full-frame GPU artifacts.
fn renders_real_warp_square_v9_samples_with_fallback_adapter() {
    let (fixture, bundle) = real_warp_square_v9_fixture();
    assert_eq!(fixture.id, REAL_WARP_SQUARE_V9_FIXTURE_ID);
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v9"
    );
    assert_eq!(
        fixture.producer_reference.engine_commit,
        REAL_WARP_SQUARE_V9_ENGINE_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        REAL_WARP_SQUARE_V9_FAST_MANIM_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.snapshot_hash,
        REAL_WARP_SQUARE_V9_SNAPSHOT_HASH
    );
    assert_eq!(
        fixture.producer_reference.source_path,
        REAL_WARP_SQUARE_V9_SOURCE_PATH
    );
    assert_eq!(
        fixture.producer_reference.source_sha256,
        REAL_WARP_SQUARE_V9_SOURCE_SHA256
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(
                fs::read(repository_root().join(REAL_WARP_SQUARE_V9_SOURCE_MIRROR_PATH))
                    .expect("the mirrored official WarpSquare source must remain readable")
            )
        ),
        REAL_WARP_SQUARE_V9_SOURCE_SHA256,
        "the mirrored Python source must match the sealed V9 provenance"
    );

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("real WarpSquare V9 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V9);
    assert_eq!(snapshot_hash, REAL_WARP_SQUARE_V9_SNAPSHOT_HASH);
    assert_eq!(source_hash, REAL_WARP_SQUARE_V9_SOURCE_SHA256);
    assert_eq!(
        bundle.scene.source.revision_hash(),
        REAL_WARP_SQUARE_V9_SNAPSHOT_HASH
    );
    assert_eq!(bundle.scene.duration.to_bits(), 4.0_f64.to_bits());
    assert_eq!(bundle.scene.entities.len(), 1);
    assert_eq!(bundle.scene.animation_channels.len(), 1);

    let visual_parity_entries =
        REAL_WARP_SQUARE_V9_SAMPLES.map(|(entry_id, _, _)| load_visual_parity_entry(entry_id));
    let expected_viewport = ViewportV1 {
        height_px: 360,
        width_px: 640,
    };
    for (index, &(entry_id, sample_id, sample_time)) in
        REAL_WARP_SQUARE_V9_SAMPLES.iter().enumerate()
    {
        let entry = &visual_parity_entries[index];
        let sample = fixture
            .samples
            .iter()
            .find(|sample| sample.id == sample_id)
            .unwrap_or_else(|| panic!("WarpSquare V9 sample {sample_id} must exist"));
        assert_eq!(entry.id, entry_id);
        assert_eq!(entry.fixture.id, REAL_WARP_SQUARE_V9_FIXTURE_ID);
        assert_eq!(entry.fixture.path, REAL_WARP_SQUARE_V9_FIXTURE_PATH);
        assert_eq!(
            entry.fixture.revision.kind,
            "imported-manim-server-snapshot"
        );
        assert_eq!(
            entry.fixture.revision.sha256,
            REAL_WARP_SQUARE_V9_SNAPSHOT_HASH
        );
        assert_eq!(entry.sample.id, sample_id);
        assert_eq!(entry.sample.sample_time.to_bits(), sample_time.to_bits());
        assert_eq!(entry.sample.viewport, expected_viewport);
        assert_eq!(sample.packet_id, format!("real-warp-square-v9:{sample_id}"));
        assert_eq!(sample.sample_time.to_bits(), sample_time.to_bits());
        assert_eq!(sample.viewport, expected_viewport);
        assert_eq!(
            sample.expected.semantic_digest, entry.sample.semantic_digest,
            "{sample_id} fixture and corpus semantics must stay pinned together"
        );
    }

    let session =
        EngineSessionV1::new(bundle).expect("real WarpSquare V9 fixture must install once");
    let sampled_packets = REAL_WARP_SQUARE_V9_SAMPLES
        .iter()
        .map(|&(_, sample_id, _)| {
            let sample = fixture
                .samples
                .iter()
                .find(|sample| sample.id == sample_id)
                .unwrap_or_else(|| panic!("WarpSquare V9 sample {sample_id} must exist"));
            let packet = session
                .sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[fixture.id.clone(), sample.id.clone()],
                    packet_id: &sample.packet_id,
                    sample_time: sample.sample_time,
                    viewport: sample.viewport.clone(),
                })
                .unwrap_or_else(|error| panic!("{} must sample: {error}", sample.id));
            let semantic_digest = render_packet_semantic_digest(&packet);
            assert_eq!(packet.packet_id, sample.packet_id);
            assert_eq!(packet.sample_time.to_bits(), sample.sample_time.to_bits());
            assert_eq!(packet.viewport, sample.viewport);
            assert_eq!(
                packet.scene_revision_hash,
                REAL_WARP_SQUARE_V9_SNAPSHOT_HASH
            );
            assert_eq!(
                semantic_digest, sample.expected.semantic_digest,
                "{} fixture semantic digest must match the native evaluator",
                sample.id
            );
            assert!(matches!(
                packet.draws.as_slice(),
                [RenderDrawV1::Path {
                    fill: None,
                    stroke: Some(_),
                    ..
                }]
            ));
            (sample, packet)
        })
        .collect::<Vec<_>>();

    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(adapter_info.device_type, wgpu::DeviceType::Cpu);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let mut frames_by_sample = std::collections::BTreeMap::new();

    for (sample, packet) in &sampled_packets {
        let (texture, extent) = render_packet(&device, &queue, &mut renderer, packet);
        let (_, rgba) = readback_texture(&device, &queue, &texture, extent);
        assert_eq!(extent.width, sample.viewport.width_px);
        assert_eq!(extent.height, sample.viewport.height_px);
        assert!(
            non_background_bounds(&rgba, extent.width, extent.height).is_some(),
            "{} must retain visible vector ink",
            sample.id
        );
        assert!(
            frames_by_sample.insert(sample.id.clone(), rgba).is_none(),
            "WarpSquare V9 parity sample ids must be unique"
        );
    }

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through all five WarpSquare V9 readbacks"
    );
    for (left, right) in [
        ("source", "quarter"),
        ("quarter", "midpoint"),
        ("midpoint", "target"),
    ] {
        assert_ne!(
            frames_by_sample[left], frames_by_sample[right],
            "{left} and {right} must produce distinct full frames"
        );
    }
    assert_eq!(
        frames_by_sample["target"], frames_by_sample["hold"],
        "the target must remain unchanged during the final one-second wait"
    );

    let artifact_requested = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1).is_some();
    let artifact_count = visual_parity_entries
        .iter()
        .map(|entry| {
            usize::from(emit_native_visual_parity_artifact(
                entry,
                &adapter_info,
                TARGET_FORMAT,
                &frames_by_sample[&entry.sample.id],
            ))
        })
        .sum::<usize>();
    assert_eq!(
        artifact_count,
        if artifact_requested {
            REAL_WARP_SQUARE_V9_SAMPLES.len()
        } else {
            0
        },
        "an opt-in WarpSquare V9 artifact request must emit all five frames"
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
#[allow(clippy::too_many_lines)] // One temporal proof binds the exact V11 producer to seven full-frame GPU artifacts.
fn renders_real_spiral_in_v11_samples_with_fallback_adapter() {
    let (fixture, bundle) = real_spiral_in_v11_fixture();
    assert_eq!(fixture.id, REAL_SPIRAL_IN_V11_FIXTURE_ID);
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v11"
    );
    assert_eq!(
        fixture.producer_reference.engine_commit,
        REAL_SPIRAL_IN_V11_ENGINE_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        REAL_SPIRAL_IN_V11_FAST_MANIM_COMMIT
    );
    assert_eq!(
        fixture.producer_reference.fast_manim_tree.as_deref(),
        Some(REAL_SPIRAL_IN_V11_FAST_MANIM_TREE)
    );
    assert_eq!(
        fixture
            .producer_reference
            .producer_snapshot_digest
            .as_deref(),
        Some(REAL_SPIRAL_IN_V11_PRODUCER_SNAPSHOT_DIGEST)
    );
    assert_eq!(
        fixture.producer_reference.snapshot_hash,
        REAL_SPIRAL_IN_V11_SNAPSHOT_HASH
    );
    assert_eq!(
        fixture.producer_reference.source_path,
        REAL_SPIRAL_IN_V11_SOURCE_PATH
    );
    assert_eq!(
        fixture.producer_reference.source_sha256,
        REAL_SPIRAL_IN_V11_SOURCE_SHA256
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(
                fs::read(repository_root().join(REAL_SPIRAL_IN_V11_SOURCE_MIRROR_PATH))
                    .expect("the mirrored official SpiralIn source must remain readable")
            )
        ),
        REAL_SPIRAL_IN_V11_SOURCE_SHA256,
        "the mirrored Python source must match the sealed V11 provenance"
    );

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("real SpiralIn V11 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V11);
    assert_eq!(snapshot_hash, REAL_SPIRAL_IN_V11_SNAPSHOT_HASH);
    assert_eq!(source_hash, REAL_SPIRAL_IN_V11_SOURCE_SHA256);
    assert_eq!(
        bundle.scene.source.revision_hash(),
        REAL_SPIRAL_IN_V11_SNAPSHOT_HASH
    );
    assert_eq!(bundle.scene.duration.to_bits(), 3.0_f64.to_bits());
    assert_eq!(bundle.scene.entities.len(), 6);
    assert_eq!(bundle.scene.animation_channels.len(), 11);

    let visual_parity_entries =
        REAL_SPIRAL_IN_V11_SAMPLES.map(|(entry_id, _, _)| load_visual_parity_entry(entry_id));
    let expected_viewport = ViewportV1 {
        height_px: 360,
        width_px: 640,
    };
    for (index, &(entry_id, sample_id, sample_time)) in
        REAL_SPIRAL_IN_V11_SAMPLES.iter().enumerate()
    {
        let entry = &visual_parity_entries[index];
        let sample = fixture
            .samples
            .iter()
            .find(|sample| sample.id == sample_id)
            .unwrap_or_else(|| panic!("SpiralIn V11 sample {sample_id} must exist"));
        assert_eq!(entry.id, entry_id);
        assert_eq!(entry.fixture.id, REAL_SPIRAL_IN_V11_FIXTURE_ID);
        assert_eq!(entry.fixture.path, REAL_SPIRAL_IN_V11_FIXTURE_PATH);
        assert_eq!(
            entry.fixture.revision.kind,
            "imported-manim-server-snapshot"
        );
        assert_eq!(
            entry.fixture.revision.sha256,
            REAL_SPIRAL_IN_V11_SNAPSHOT_HASH
        );
        assert_eq!(entry.sample.id, sample_id);
        assert_eq!(entry.sample.sample_time.to_bits(), sample_time.to_bits());
        assert_eq!(entry.sample.viewport, expected_viewport);
        assert_eq!(sample.packet_id, format!("real-spiral-in-v11:{sample_id}"));
        assert_eq!(sample.sample_time.to_bits(), sample_time.to_bits());
        assert_eq!(sample.viewport, expected_viewport);
        assert_eq!(
            sample.expected.semantic_digest, entry.sample.semantic_digest,
            "{sample_id} fixture and corpus semantics must stay pinned together"
        );
    }

    let session =
        EngineSessionV1::new(bundle).expect("real SpiralIn V11 fixture must install once");
    let sampled_packets = REAL_SPIRAL_IN_V11_SAMPLES
        .iter()
        .map(|&(_, sample_id, _)| {
            let sample = fixture
                .samples
                .iter()
                .find(|sample| sample.id == sample_id)
                .unwrap_or_else(|| panic!("SpiralIn V11 sample {sample_id} must exist"));
            let packet = session
                .sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[fixture.id.clone(), sample.id.clone()],
                    packet_id: &sample.packet_id,
                    sample_time: sample.sample_time,
                    viewport: sample.viewport.clone(),
                })
                .unwrap_or_else(|error| panic!("{} must sample: {error}", sample.id));
            assert_eq!(packet.packet_id, sample.packet_id);
            assert_eq!(packet.sample_time.to_bits(), sample.sample_time.to_bits());
            assert_eq!(packet.viewport, sample.viewport);
            assert_eq!(packet.scene_revision_hash, REAL_SPIRAL_IN_V11_SNAPSHOT_HASH);
            assert_eq!(packet.compositing, RenderCompositingV1::ManimCairoSrgb);
            assert_eq!(
                render_packet_semantic_digest(&packet),
                sample.expected.semantic_digest,
                "{} fixture semantic digest must match the native evaluator",
                sample.id
            );
            assert!(
                packet.draws.iter().all(|draw| matches!(
                    draw,
                    RenderDrawV1::Path {
                        fill: Some(_),
                        stroke: None,
                        ..
                    }
                )),
                "the logical VGroup must not draw and every SpiralIn leaf must stay fill-only"
            );
            (sample, packet)
        })
        .collect::<Vec<_>>();

    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(adapter_info.device_type, wgpu::DeviceType::Cpu);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let mut frames_by_sample = std::collections::BTreeMap::new();

    for (sample, packet) in &sampled_packets {
        let (texture, extent) = render_packet(&device, &queue, &mut renderer, packet);
        let (_, rgba) = readback_texture(&device, &queue, &texture, extent);
        assert_eq!(extent.width, sample.viewport.width_px);
        assert_eq!(extent.height, sample.viewport.height_px);
        assert!(
            frames_by_sample.insert(sample.id.clone(), rgba).is_none(),
            "SpiralIn V11 parity sample ids must be unique"
        );
    }

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through all seven SpiralIn V11 readbacks"
    );
    assert_eq!(
        frames_by_sample["start"], frames_by_sample["end"],
        "fully transparent start and completed FadeOut must both be clear"
    );
    assert_ne!(frames_by_sample["early-reveal"], frames_by_sample["start"]);
    assert_ne!(
        frames_by_sample["spiral-midpoint"],
        frames_by_sample["early-reveal"]
    );
    assert_ne!(
        frames_by_sample["spiral-end"],
        frames_by_sample["spiral-midpoint"]
    );
    assert_eq!(
        frames_by_sample["spiral-end"], frames_by_sample["hold"],
        "the completed SpiralIn frame must remain unchanged during the wait"
    );
    assert_ne!(
        frames_by_sample["group-fade-midpoint"],
        frames_by_sample["hold"]
    );
    assert_ne!(
        frames_by_sample["group-fade-midpoint"],
        frames_by_sample["end"]
    );

    let artifact_requested = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1).is_some();
    let artifact_count = visual_parity_entries
        .iter()
        .map(|entry| {
            usize::from(emit_native_visual_parity_artifact(
                entry,
                &adapter_info,
                MANIM_CAIRO_TARGET_FORMAT,
                &frames_by_sample[&entry.sample.id],
            ))
        })
        .sum::<usize>();
    assert_eq!(
        artifact_count,
        if artifact_requested {
            REAL_SPIRAL_IN_V11_SAMPLES.len()
        } else {
            0
        },
        "an opt-in SpiralIn V11 artifact request must emit all seven frames"
    );
}

#[allow(
    clippy::too_many_lines,
    reason = "one audited GPU proof binds the producer pins, join semantics, full-frame readback, and artifact"
)]
fn render_real_line_joints_v10_static_with_fallback_adapter(contract: RealLineJointsV10Contract) {
    let (fixture, bundle) = real_line_joints_v10_fixture(contract);
    let entry = load_visual_parity_entry(contract.entry_id);
    assert_eq!(fixture.id, contract.fixture_id);
    assert_eq!(entry.fixture.id, fixture.id);
    assert_eq!(entry.fixture.path, contract.fixture_path);
    assert_eq!(
        fixture.producer_reference.kind,
        "server-sealed-real-fast-manim-profile-v10"
    );
    assert_eq!(
        fixture.producer_reference.fast_manim_commit,
        contract.fast_manim_commit
    );
    assert_eq!(
        fixture.producer_reference.fast_manim_tree.as_deref(),
        contract.fast_manim_tree
    );
    assert_eq!(
        fixture
            .producer_reference
            .producer_snapshot_digest
            .as_deref(),
        contract.producer_snapshot_digest
    );
    assert_eq!(
        fixture.producer_reference.snapshot_hash,
        contract.snapshot_hash
    );
    assert_eq!(
        fixture.producer_reference.source_path,
        REAL_LINE_JOINTS_V10_SOURCE_PATH
    );
    assert_eq!(
        fixture.producer_reference.source_sha256,
        contract.source_sha256
    );

    let official_source =
        fs::read_to_string(repository_root().join(REAL_LINE_JOINTS_V10_SOURCE_MIRROR_PATH))
            .expect("the mirrored official LineJoints source must remain readable");
    let source = if contract.edited {
        assert_eq!(
            official_source
                .matches(REAL_LINE_JOINTS_V10_EDIT_ANCHOR)
                .count(),
            1,
            "the bounded LineJoints edit anchor must remain unique"
        );
        official_source.replacen(
            REAL_LINE_JOINTS_V10_EDIT_ANCHOR,
            REAL_LINE_JOINTS_V10_EDIT_REPLACEMENT,
            1,
        )
    } else {
        official_source
    };
    assert_eq!(
        format!("{:x}", Sha256::digest(source.as_bytes())),
        contract.source_sha256
    );

    let SceneSourceV1::ImportedManimServerSnapshot {
        snapshot_hash,
        snapshot_version,
        source_hash,
        ..
    } = &bundle.scene.source
    else {
        panic!("real LineJoints V10 must remain an imported server snapshot");
    };
    assert_eq!(*snapshot_version, SnapshotProfileVersionV1::V10);
    assert_eq!(snapshot_hash, contract.snapshot_hash);
    assert_eq!(source_hash, contract.source_sha256);
    assert_eq!(bundle.scene.entities.len(), 4);
    assert!(bundle.scene.animation_channels.is_empty());

    let [sample] = fixture.samples.as_slice() else {
        panic!("LineJoints V10 must contain one static visual-parity sample");
    };
    assert_eq!(sample.id, entry.sample.id);
    assert_eq!(
        sample.sample_time.to_bits(),
        entry.sample.sample_time.to_bits()
    );
    assert_eq!(sample.viewport, entry.sample.viewport);
    assert_eq!(
        sample.expected.semantic_digest,
        entry.sample.semantic_digest
    );
    assert_eq!(entry.fixture.revision.sha256, contract.snapshot_hash);

    let session = EngineSessionV1::new(bundle).expect("LineJoints V10 fixture must install");
    let packet = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[fixture.id.clone(), sample.id.clone()],
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            viewport: sample.viewport.clone(),
        })
        .expect("LineJoints V10 fixture must sample");
    assert_eq!(
        render_packet_semantic_digest(&packet),
        sample.expected.semantic_digest
    );
    let joins = packet
        .draws
        .iter()
        .map(|draw| match draw {
            RenderDrawV1::Path {
                fill: None,
                stroke: Some(stroke),
                ..
            } => stroke.join,
            _ => {
                panic!("the VGroup must not draw and all three Triangle leaves must be stroke-only")
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(
        joins,
        [
            StrokeJoinV1::Miter,
            StrokeJoinV1::Round,
            StrokeJoinV1::Bevel
        ]
    );
    render_and_assert_shared_reference(
        &packet,
        PixelReferenceSet {
            clear_only: false,
            reason: if contract.edited {
                "the producer-confirmed Studio edit must retain all three visible stroked Triangle leaves"
                    .to_owned()
            } else {
                "the official LineJoints V10 scene must retain all three visible stroked Triangle leaves"
                    .to_owned()
            },
            samples: std::collections::BTreeMap::new(),
        },
        contract.artifact_label,
        Some(&entry),
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
fn renders_real_line_joints_v10_static_with_fallback_adapter() {
    render_real_line_joints_v10_static_with_fallback_adapter(REAL_LINE_JOINTS_V10_CONTRACT);
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
fn renders_real_line_joints_v10_edited_static_with_fallback_adapter() {
    render_real_line_joints_v10_static_with_fallback_adapter(REAL_LINE_JOINTS_V10_EDITED_CONTRACT);
}

#[test]
#[ignore = "requires a native software WGPU adapter; the visual parity lane runs this proof"]
#[allow(clippy::too_many_lines)] // One full-frame proof keeps fixture, asset, GPU, and artifact evidence together.
fn renders_png_alpha_edge_camera_midpoint_with_fallback_adapter() {
    let (fixture, bundle) = png_visual_parity_fixture();
    assert_eq!(fixture.id, "eng-v1-png-alpha-edge-camera");
    let sample = fixture
        .samples
        .iter()
        .find(|sample| sample.id == "midpoint")
        .expect("PNG visual parity midpoint sample must exist");
    let reference = fixture
        .analytic_references
        .get(&sample.expected.analytic_reference_id)
        .expect("PNG visual parity sample must select an analytic reference");
    assert_eq!(reference.channel_order, "rgba");
    assert_eq!(reference.color_domain, "srgb-u8");
    assert!(
        reference.derivation.contains("premultiplied-linear"),
        "analytic reference must record the alpha-before-filter derivation"
    );
    assert_eq!(reference.viewport, sample.viewport);
    assert_eq!(
        reference.rgba.len(),
        usize::try_from(sample.viewport.width_px)
            .expect("fixture width must fit usize")
            .checked_mul(
                usize::try_from(sample.viewport.height_px).expect("fixture height must fit usize")
            )
            .and_then(|pixels| pixels.checked_mul(BYTES_PER_PIXEL as usize))
            .expect("fixture RGBA size must fit usize")
    );
    assert_eq!(
        format!("{:x}", Sha256::digest(&reference.rgba)),
        reference.sha256,
        "analytic RGBA digest must pin the independent full-frame reference"
    );

    let scene_revision_hash = bundle.scene.source.revision_hash().to_owned();
    let asset_metadata = bundle
        .assets
        .assets
        .iter()
        .find(|asset| asset.id == "asset:png-alpha-edge")
        .expect("PNG visual parity metadata must exist")
        .clone();
    let payload = fixture
        .asset_payloads
        .iter()
        .find(|payload| payload.asset_id == asset_metadata.id)
        .expect("PNG visual parity encoded payload must exist");
    assert_eq!(
        u64::try_from(payload.encoded_bytes.len()).expect("fixture payload length must fit u64"),
        asset_metadata.byte_length
    );
    let decoded = Arc::new(
        decode_verified_png_v1(&asset_metadata, &payload.encoded_bytes)
            .expect("PNG visual parity payload must match its immutable metadata"),
    );
    let session = EngineSessionV1::new(bundle).expect("PNG visual parity fixture must install");
    let packet = session
        .sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[fixture.id.clone(), sample.id.clone()],
            packet_id: &sample.packet_id,
            sample_time: sample.sample_time,
            viewport: sample.viewport.clone(),
        })
        .expect("PNG visual parity midpoint must sample");
    let semantic_digest = render_packet_semantic_digest(&packet);
    assert_eq!(semantic_digest, sample.expected.semantic_digest);
    assert_eq!(
        packet.camera,
        image_proof_camera(-3.0, 3.0, -1.5, 1.5),
        "the midpoint camera must include both pan and zoom"
    );
    let [
        RenderDrawV1::Image {
            sampler, transform, ..
        },
    ] = packet.draws.as_slice()
    else {
        panic!("PNG visual parity midpoint must produce exactly one image draw");
    };
    assert_eq!(*sampler, ImageSamplerV1::Linear);
    assert_eq!(
        *transform,
        AffineTransformV1 {
            m11: 3.0,
            m12: 0.0,
            m21: 0.0,
            m22: 3.0,
            tx: 0.0,
            ty: 0.0,
        },
        "the midpoint image must exercise non-identity affine interpolation"
    );

    let visual_parity_entry = load_visual_parity_entry(PNG_VISUAL_PARITY_ENTRY_V1);
    assert_eq!(visual_parity_entry.fixture.id, fixture.id);
    assert_eq!(
        visual_parity_entry.fixture.path,
        "fixtures/engine-v1/png-alpha-edge-camera.json"
    );
    assert_eq!(
        visual_parity_entry.fixture.revision.sha256,
        scene_revision_hash
    );
    assert_eq!(visual_parity_entry.sample.id, sample.id);
    assert_eq!(visual_parity_entry.sample.viewport, sample.viewport);
    assert_eq!(visual_parity_entry.sample.semantic_digest, semantic_digest);

    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    let adapter_info = adapter.get_info();
    assert_eq!(adapter_info.device_type, wgpu::DeviceType::Cpu);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");
    let resolver = |sha256: &str| (sha256 == asset_metadata.sha256).then(|| Arc::clone(&decoded));
    let (texture, extent) =
        render_packet_with_assets(&device, &queue, &mut renderer, &packet, &resolver);
    let (_, rgba) = readback_texture(&device, &queue, &texture, extent);
    assert_eq!(extent.width, sample.viewport.width_px);
    assert_eq!(extent.height, sample.viewport.height_px);
    assert_full_rgba_bytes_close(&rgba, &reference.rgba, 1);

    let artifact_requested = env::var_os(VISUAL_PARITY_NATIVE_ARTIFACT_ENV_V1).is_some();
    assert_eq!(
        emit_native_visual_parity_artifact(
            &visual_parity_entry,
            &adapter_info,
            TARGET_FORMAT,
            &rgba,
        ),
        artifact_requested,
        "the opt-in PNG native artifact must be emitted exactly once"
    );
    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through PNG visual parity readback"
    );
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
#[allow(clippy::too_many_lines)]
fn renders_verified_png_sampling_transforms_and_mixed_paint_order() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT)
        .expect("proof target format must be supported by the renderer");

    let (nearest_metadata, nearest_asset) = verified_rgba_png(
        "asset:nearest",
        2,
        2,
        &[
            255, 0, 0, 255, 0, 255, 0, 255, // PNG top row
            0, 0, 255, 255, 255, 255, 255, 255, // PNG bottom row
        ],
    );
    let mut nearest_packet = empty_render_packet(
        ViewportV1 {
            height_px: 4,
            width_px: 4,
        },
        image_proof_camera(-2.0, 2.0, -2.0, 2.0),
    );
    nearest_packet.draws.push(image_draw(
        &nearest_metadata,
        "draw:nearest",
        "entity:nearest",
        ImageLocalRectV1 {
            bottom: -1.0,
            left: -1.0,
            right: 1.0,
            top: 1.0,
        },
        1.0,
        0,
        ImageSamplerV1::Nearest,
        AffineTransformV1 {
            m11: 2.0,
            m12: 0.0,
            m21: 0.0,
            m22: 2.0,
            tx: 0.0,
            ty: 0.0,
        },
    ));
    nearest_packet.required_capabilities = vec![RenderCapabilityV1::PngImage];
    let nearest_resolver = |_digest: &str| Some(Arc::clone(&nearest_asset));
    let (texture, extent) = render_packet_with_assets(
        &device,
        &queue,
        &mut renderer,
        &nearest_packet,
        &nearest_resolver,
    );
    let (_, nearest_rgba) = readback_texture(&device, &queue, &texture, extent);
    let nearest_row_top = [
        [255, 0, 0, 255],
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 255, 0, 255],
    ];
    let nearest_row_bottom = [
        [0, 0, 255, 255],
        [0, 0, 255, 255],
        [255, 255, 255, 255],
        [255, 255, 255, 255],
    ];
    let nearest_expected = nearest_row_top
        .into_iter()
        .chain(nearest_row_top)
        .chain(nearest_row_bottom)
        .chain(nearest_row_bottom)
        .collect::<Vec<_>>();
    assert_full_frame_close(&nearest_rgba, &nearest_expected, 0);

    let (linear_metadata, linear_asset) =
        verified_rgba_png("asset:linear-alpha", 2, 1, &[255, 0, 0, 255, 0, 0, 255, 0]);
    let mut linear_packet = empty_render_packet(
        ViewportV1 {
            height_px: 1,
            width_px: 4,
        },
        image_proof_camera(-2.0, 2.0, -0.5, 0.5),
    );
    linear_packet.draws.push(image_draw(
        &linear_metadata,
        "draw:linear-alpha",
        "entity:linear-alpha",
        ImageLocalRectV1 {
            bottom: -0.5,
            left: -2.0,
            right: 2.0,
            top: 0.5,
        },
        1.0,
        0,
        ImageSamplerV1::Linear,
        AffineTransformV1::identity(),
    ));
    linear_packet.required_capabilities = vec![RenderCapabilityV1::PngImage];
    let linear_resolver = |_digest: &str| Some(Arc::clone(&linear_asset));
    let (texture, extent) = render_packet_with_assets(
        &device,
        &queue,
        &mut renderer,
        &linear_packet,
        &linear_resolver,
    );
    let (_, linear_rgba) = readback_texture(&device, &queue, &texture, extent);
    assert_full_frame_close(
        &linear_rgba,
        &[
            [255, 0, 0, 255],
            [225, 0, 0, 255],
            [137, 0, 0, 255],
            [0, 0, 0, 255],
        ],
        1,
    );

    let (mixed_metadata, mixed_asset) = verified_rgba_png("asset:mixed", 1, 1, &[0, 255, 0, 255]);
    let full_rect = ImageLocalRectV1 {
        bottom: -1.0,
        left: -2.0,
        right: 2.0,
        top: 1.0,
    };
    let mut mixed_packet = empty_render_packet(
        ViewportV1 {
            height_px: 2,
            width_px: 4,
        },
        image_proof_camera(-2.0, 2.0, -1.0, 1.0),
    );
    mixed_packet.draws = vec![
        solid_rectangle_draw(
            "draw:back",
            "entity:back",
            &full_rect,
            RgbaColorV1 {
                alpha: 1.0,
                blue: 0.0,
                green: 0.0,
                red: 1.0,
            },
            1.0,
            0,
        ),
        image_draw(
            &mixed_metadata,
            "draw:middle",
            "entity:middle",
            full_rect,
            0.5,
            1,
            ImageSamplerV1::Nearest,
            AffineTransformV1::identity(),
        ),
        solid_rectangle_draw(
            "draw:front",
            "entity:front",
            &ImageLocalRectV1 {
                bottom: -1.0,
                left: 0.0,
                right: 2.0,
                top: 1.0,
            },
            RgbaColorV1 {
                alpha: 1.0,
                blue: 1.0,
                green: 0.0,
                red: 0.0,
            },
            0.5,
            2,
        ),
    ];
    mixed_packet.required_capabilities = vec![
        RenderCapabilityV1::CubicPathFill,
        RenderCapabilityV1::PngImage,
    ];
    let mixed_resolver = |_digest: &str| Some(Arc::clone(&mixed_asset));
    let (texture, extent) = render_packet_with_assets(
        &device,
        &queue,
        &mut renderer,
        &mixed_packet,
        &mixed_resolver,
    );
    let (_, mixed_rgba) = readback_texture(&device, &queue, &texture, extent);
    let mixed_row = [
        [188, 188, 0, 255],
        [188, 188, 0, 255],
        [137, 137, 188, 255],
        [137, 137, 188, 255],
    ];
    let mixed_expected = mixed_row.into_iter().chain(mixed_row).collect::<Vec<_>>();
    assert_full_frame_close(&mixed_rgba, &mixed_expected, 2);

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none(),
        "device must remain available through image readback"
    );
}

fn retained_image_packet(
    assets: &[poietra_scene_ir::PngAssetV1],
    samplers: &[ImageSamplerV1],
) -> RenderPacketV1 {
    assert_eq!(assets.len(), samplers.len());
    let mut packet = empty_render_packet(
        ViewportV1 {
            height_px: 4,
            width_px: 4,
        },
        image_proof_camera(-2.0, 2.0, -2.0, 2.0),
    );
    packet.draws = assets
        .iter()
        .zip(samplers)
        .enumerate()
        .map(|(index, (asset, sampler))| {
            image_draw(
                asset,
                &format!("draw:cache:{index}"),
                &format!("entity:cache:{index}"),
                ImageLocalRectV1 {
                    bottom: -2.0,
                    left: -2.0,
                    right: 2.0,
                    top: 2.0,
                },
                1.0,
                u32::try_from(index).unwrap(),
                *sampler,
                AffineTransformV1::identity(),
            )
        })
        .collect();
    packet.required_capabilities = vec![RenderCapabilityV1::PngImage];
    packet
}

fn retained_image_target(device: &wgpu::Device) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("poietra retained image cache proof target"),
        size: wgpu::Extent3d {
            depth_or_array_layers: 1,
            height: 4,
            width: 4,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TARGET_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

#[test]
#[ignore = "requires a native software WGPU adapter; the dedicated CI step runs this proof"]
#[allow(clippy::too_many_lines)]
fn retains_image_textures_and_sampler_bindings_with_bounded_lru() {
    let instance =
        wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = request_fallback_adapter(&instance);
    assert_target_format_support(&adapter);
    let (device, queue) = request_device(&adapter);
    let device_loss = track_device_loss(&device);
    let out_of_memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

    let (red_metadata, red) = verified_rgba_png("asset:cache:red", 1, 1, &[255, 0, 0, 255]);
    let (green_metadata, green) = verified_rgba_png("asset:cache:green", 1, 1, &[0, 255, 0, 255]);
    let (blue_metadata, blue) = verified_rgba_png("asset:cache:blue", 1, 1, &[0, 0, 255, 255]);
    let asset_table = [
        (red_metadata.sha256.as_str(), Arc::clone(&red)),
        (green_metadata.sha256.as_str(), Arc::clone(&green)),
        (blue_metadata.sha256.as_str(), Arc::clone(&blue)),
    ];
    let resolver = |digest: &str| {
        asset_table
            .iter()
            .find(|(candidate, _)| *candidate == digest)
            .map(|(_, asset)| Arc::clone(asset))
    };

    let dual_sampler_packet = retained_image_packet(
        &[red_metadata.clone(), red_metadata.clone()],
        &[ImageSamplerV1::Nearest, ImageSamplerV1::Linear],
    );
    let dual_sampler = prepare_frame_with_assets_v1(&dual_sampler_packet, &resolver).unwrap();
    let (_texture, view) = retained_image_target(&device);
    let target = WgpuRenderTargetV1 {
        format: TARGET_FORMAT,
        height_px: 4,
        view: &view,
        width_px: 4,
    };
    let mut renderer = WgpuPaintRendererV1::new(&device, TARGET_FORMAT).unwrap();
    let (_, cold) = renderer
        .render_with_stage_evidence(&device, &queue, target, &dual_sampler, None)
        .unwrap();
    assert_eq!(cold.image_texture_cache.texture_uploads(), 1);
    assert_eq!(cold.image_texture_cache.texture_hits(), 0);
    assert_eq!(cold.image_texture_cache.sampler_binding_creations(), 2);
    assert_eq!(cold.image_texture_cache.sampler_binding_hits(), 0);
    assert_eq!(cold.image_texture_cache.texture_upload_bytes(), 4);

    for _ in 0..300 {
        let (_, warm) = renderer
            .render_with_stage_evidence(&device, &queue, target, &dual_sampler, None)
            .unwrap();
        assert_eq!(warm.image_texture_cache.texture_uploads(), 0);
        assert_eq!(warm.image_texture_cache.texture_hits(), 1);
        assert_eq!(warm.image_texture_cache.sampler_binding_creations(), 0);
        assert_eq!(warm.image_texture_cache.sampler_binding_hits(), 2);
        assert_eq!(warm.image_texture_cache.texture_upload_bytes(), 0);
    }

    // A recreated device and renderer rebuild directly from the already
    // verified Arc retained in the prepared frame; no PNG transfer or decode
    // occurs on this path.
    drop(renderer);
    let (recreated_device, recreated_queue) = request_device(&adapter);
    let (_recreated_texture, recreated_view) = retained_image_target(&recreated_device);
    let recreated_target = WgpuRenderTargetV1 {
        format: TARGET_FORMAT,
        height_px: 4,
        view: &recreated_view,
        width_px: 4,
    };
    let mut recreated_renderer =
        WgpuPaintRendererV1::new(&recreated_device, TARGET_FORMAT).unwrap();
    let (recreated_submission, recreated) = recreated_renderer
        .render_with_stage_evidence(
            &recreated_device,
            &recreated_queue,
            recreated_target,
            &dual_sampler,
            None,
        )
        .unwrap();
    assert_eq!(recreated.image_texture_cache.texture_uploads(), 1);
    assert_eq!(recreated.image_texture_cache.sampler_binding_creations(), 2);
    assert!(
        recreated_device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(recreated_submission),
                timeout: Some(GPU_TIMEOUT),
            })
            .unwrap()
            .wait_finished()
    );

    let limits = ImageTextureCacheLimitsV1 {
        decoded_cpu_bytes: 8,
        entries: 2,
        gpu_texture_bytes: 8,
    };
    let mut bounded =
        WgpuPaintRendererV1::new_with_image_texture_cache_limits(&device, TARGET_FORMAT, limits)
            .unwrap();
    let red_green_packet = retained_image_packet(
        &[red_metadata.clone(), green_metadata.clone()],
        &[ImageSamplerV1::Nearest, ImageSamplerV1::Nearest],
    );
    let red_green = prepare_frame_with_assets_v1(&red_green_packet, &resolver).unwrap();
    let (_, fill) = bounded
        .render_with_stage_evidence(&device, &queue, target, &red_green, None)
        .unwrap();
    assert_eq!(fill.image_texture_cache.texture_uploads(), 2);

    let red_blue_packet = retained_image_packet(
        &[red_metadata.clone(), blue_metadata.clone()],
        &[ImageSamplerV1::Nearest, ImageSamplerV1::Nearest],
    );
    let red_blue = prepare_frame_with_assets_v1(&red_blue_packet, &resolver).unwrap();
    let (_, eviction) = bounded
        .render_with_stage_evidence(&device, &queue, target, &red_blue, None)
        .unwrap();
    assert_eq!(eviction.image_texture_cache.texture_hits(), 1);
    assert_eq!(eviction.image_texture_cache.texture_uploads(), 1);
    assert_eq!(eviction.image_texture_cache.evictions(), 1);

    let green_packet = retained_image_packet(
        std::slice::from_ref(&green_metadata),
        &[ImageSamplerV1::Nearest],
    );
    let green_again = prepare_frame_with_assets_v1(&green_packet, &resolver).unwrap();
    let (_, regenerated) = bounded
        .render_with_stage_evidence(&device, &queue, target, &green_again, None)
        .unwrap();
    assert_eq!(regenerated.image_texture_cache.texture_hits(), 0);
    assert_eq!(regenerated.image_texture_cache.texture_uploads(), 1);
    assert_eq!(regenerated.image_texture_cache.evictions(), 1);
    assert_eq!(regenerated.image_texture_cache.texture_upload_bytes(), 4);

    let too_small = ImageTextureCacheLimitsV1 {
        decoded_cpu_bytes: 4,
        entries: 1,
        gpu_texture_bytes: 4,
    };
    let mut rejecting =
        WgpuPaintRendererV1::new_with_image_texture_cache_limits(&device, TARGET_FORMAT, too_small)
            .unwrap();
    assert!(matches!(
        rejecting.render_with_stage_evidence(&device, &queue, target, &red_green, None),
        Err(RenderFrameErrorV1::ImageUpload(
            poietra_render_wgpu::ImageGpuUploadErrorV1::RetainedEntryLimitExceeded {
                maximum_entries: 1,
                required_entries: 2,
            }
        ))
    ));

    assert_no_gpu_error("validation", pollster::block_on(validation_scope.pop()));
    assert_no_gpu_error("internal", pollster::block_on(internal_scope.pop()));
    assert_no_gpu_error(
        "out-of-memory",
        pollster::block_on(out_of_memory_scope.pop()),
    );
    assert!(
        device_loss
            .lock()
            .expect("device-loss evidence mutex must not be poisoned")
            .is_none()
    );
}
