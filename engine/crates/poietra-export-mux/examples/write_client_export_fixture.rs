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
        "{{\"engineAbiVersion\":44,\"exportProfileHash\":\"{export_profile_hash}\",\
         \"sceneId\":\"fixture-scene\",\"sceneRevisionHash\":\"{scene_revision_hash}\"}}"
    )
}

/// Real Constrained Baseline parameter sets for an 854x480 frame. They were
/// produced by x264 and are paired with [`valid_idr_sample`], making the
/// committed positive fixture independently probeable by ffprobe/ffmpeg.
fn decoder_description() -> Vec<u8> {
    let avcc = Avcc {
        configuration_version: 1,
        avc_profile_indication: 0x42,
        profile_compatibility: 0xC0,
        avc_level_indication: 0x1F,
        length_size: 4,
        sequence_parameter_sets: vec![vec![
            0x67, 0x42, 0xC0, 0x1F, 0xDA, 0x03, 0x60, 0xF7, 0x9B, 0xC0, 0x44, 0x00, 0x00, 0x03,
            0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xF2, 0x3C, 0x60, 0xCA, 0x80,
        ]],
        picture_parameter_sets: vec![vec![0x68, 0xCE, 0x01, 0x97, 0x20]],
        ext: None,
    };
    let mut encoded = Vec::new();
    avcc.encode(&mut encoded)
        .expect("the synthetic avcC encodes");
    encoded[8..].to_vec()
}

/// One valid AVCC length-prefixed IDR sample for the parameter sets above.
/// The compact construction preserves the byte-identical x264 output without
/// checking a generated binary blob into the source tree.
fn valid_idr_sample() -> Vec<u8> {
    let mut sample = 1_236u32.to_be_bytes().to_vec();
    sample.extend_from_slice(&[0x65, 0x88, 0x84, 0x3A, 0x26, 0x28, 0x00, 0x15]);
    sample.extend(std::iter::repeat_n(0x93, 53));
    for _ in 0..391 {
        sample.extend_from_slice(&[0xAE, 0xBA, 0xEB]);
    }
    sample.extend_from_slice(&[0xAE, 0xBC]);
    assert_eq!(sample.len(), 1_240);
    sample
}

fn main() {
    let output_path = std::env::args()
        .nth(1)
        .expect("usage: write_client_export_fixture <output-path>");
    let config = ExportMuxConfigV1 {
        decoder_configuration: decoder_description(),
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
        max_sample_count: NonZeroU32::new(1).expect("1 is non-zero"),
    };
    let mut session =
        ExportMuxSessionV1::begin(config, Vec::new()).expect("the fixture session begins");
    let sample = valid_idr_sample();
    session
        .append_sample(EncodedSampleV1 {
            bytes: &sample,
            timestamp_us: 0,
            duration_us: 33_333,
            is_key: true,
        })
        .expect("the fixture sample is accepted");
    let bytes = session.finish().expect("the fixture session finishes");
    let structure = verify_export_mp4_v1(&bytes).expect("the fixture passes its own verification");
    assert_eq!((structure.width_px, structure.height_px), (854, 480));
    assert_eq!(structure.sample_count, 1);
    assert_eq!(structure.frame_rate, 30);
    assert_eq!(structure.provenance, provenance_json().into_bytes());

    let path = Path::new(&output_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("the fixture directory is creatable");
    }
    std::fs::write(path, &bytes).expect("the fixture file is writable");
    let byte_count = bytes.len();
    println!("wrote {byte_count} bytes to {}", path.display());
}
