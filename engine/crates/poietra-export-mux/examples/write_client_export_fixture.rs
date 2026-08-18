//! Writes the deterministic tiny client-export MP4 fixture consumed by the
//! TypeScript verification tests.
//!
//! Usage:
//!
//! ```text
//! cargo run --locked --manifest-path engine/Cargo.toml \
//!   --package poietra-export-mux --example write_client_export_fixture -- \
//!   fixtures/client-export/tiny-client-export.mp4
//! ```

use std::num::{NonZeroU16, NonZeroU32};
use std::path::Path;

use mp4_atom::{Avcc, Encode};
use poietra_export_mux::{
    ColorParametersV1, EncodedSampleV1, ExportMuxConfigV1, ExportMuxSessionV1, VideoParametersV1,
    verify_export_mp4_v1,
};

/// The canonical provenance payload. It must byte-match what the browser
/// export lane emits via `serde_json::to_vec(&ExportProvenanceV1 { .. })` for
/// the same values; this crate deliberately has no serde dependency, so the
/// compact JSON is written by hand in the same field order.
fn provenance_json() -> String {
    let export_profile_hash = "a".repeat(64);
    let scene_revision_hash = "b".repeat(64);
    format!(
        "{{\"engineAbiVersion\":27,\"exportProfileHash\":\"{export_profile_hash}\",\
         \"sceneId\":\"fixture-scene\",\"sceneRevisionHash\":\"{scene_revision_hash}\"}}"
    )
}

/// Raw `avcC` body bytes, as `WebCodecs` would report them in
/// `decoderConfig.description` (box payload without the 8-byte header). The
/// values mirror the crate's session tests.
fn synthetic_description() -> Vec<u8> {
    let avcc = Avcc {
        configuration_version: 1,
        avc_profile_indication: 0x64,
        profile_compatibility: 0,
        avc_level_indication: 0x1F,
        length_size: 4,
        sequence_parameter_sets: vec![vec![0x67, 0x64, 0x00, 0x1F, 0xAC, 0xD9, 0x40, 0x50]],
        picture_parameter_sets: vec![vec![0x68, 0xEB, 0xE3, 0xCB]],
        ext: None,
    };
    let mut encoded = Vec::new();
    avcc.encode(&mut encoded)
        .expect("the synthetic avcC encodes");
    encoded[8..].to_vec()
}

fn main() {
    let output_path = std::env::args()
        .nth(1)
        .expect("usage: write_client_export_fixture <output-path>");
    let config = ExportMuxConfigV1 {
        decoder_configuration: synthetic_description(),
        video: VideoParametersV1 {
            width_px: NonZeroU16::new(854).expect("854 is non-zero"),
            height_px: NonZeroU16::new(480).expect("480 is non-zero"),
            timescale: NonZeroU32::new(1_000_000).expect("the timescale is non-zero"),
            frames_per_second: NonZeroU32::new(30).expect("30 is non-zero"),
        },
        color: ColorParametersV1 {
            primaries: 1,
            transfer: 13,
            matrix: 1,
            full_range: false,
        },
        provenance: provenance_json().into_bytes(),
        max_sample_count: NonZeroU32::new(2).expect("2 is non-zero"),
    };
    let mut session =
        ExportMuxSessionV1::begin(config, Vec::new()).expect("the fixture session begins");
    session
        .append_sample(EncodedSampleV1 {
            bytes: &[0x11; 96],
            timestamp_us: 0,
            duration_us: 33_333,
            is_key: true,
        })
        .expect("the first fixture sample is accepted");
    session
        .append_sample(EncodedSampleV1 {
            bytes: &[0x22; 64],
            timestamp_us: 33_333,
            duration_us: 33_334,
            is_key: false,
        })
        .expect("the second fixture sample is accepted");
    let bytes = session.finish().expect("the fixture session finishes");
    let structure = verify_export_mp4_v1(&bytes).expect("the fixture passes its own verification");
    assert_eq!((structure.width_px, structure.height_px), (854, 480));
    assert_eq!(structure.sample_count, 2);
    assert_eq!(structure.provenance, provenance_json().into_bytes());

    let path = Path::new(&output_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("the fixture directory is creatable");
    }
    std::fs::write(path, &bytes).expect("the fixture file is writable");
    let byte_count = bytes.len();
    println!("wrote {byte_count} bytes to {}", path.display());
}
