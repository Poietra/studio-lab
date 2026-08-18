use mp4_atom::{Atom, Avc1, Codec, Colr, Decode, FourCC, Ftyp, Moov, StscEntry, StszSamples, Trak};

use crate::MAX_SAMPLE_TABLE_ENTRIES_V1;
use crate::session::{ColorParametersV1, MAX_PROVENANCE_BYTES_V1, PROVENANCE_UUID_V1};

/// Upper bound for a candidate MP4 handed to [`verify_export_mp4_v1`], in
/// bytes. It matches the 128 MiB output cap of the closed v1 export profile
/// ladder, so anything larger cannot be a conforming client export.
pub const MAX_VERIFIED_EXPORT_MP4_BYTES_V1: usize = 134_217_728;

/// Longest admissible movie duration in media-timescale seconds, matching the
/// 900-second cap shared by every profile of the closed v1 export ladder.
const MAX_VERIFIED_EXPORT_DURATION_SECONDS_V1: u64 = 900;

/// The closed resolution ladder of the v1 export profiles, as
/// `(width_px, height_px)` pairs.
const EXPORT_RESOLUTION_LADDER_V1: [(u16, u16); 3] = [(854, 480), (1280, 720), (1920, 1080)];

/// Everything the v1 structural verification proves about a client-export
/// MP4: geometry, timing, sample accounting, color parameters, and the opaque
/// provenance payload of the labeled `uuid` box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportMp4StructureV1 {
    /// Coded frame width in pixels, from the `avc1` sample entry.
    pub width_px: u16,
    /// Coded frame height in pixels, from the `avc1` sample entry.
    pub height_px: u16,
    /// Shared movie and media timescale in ticks per second.
    pub timescale: u32,
    /// Movie duration in media-timescale ticks, equal across `mvhd`, `tkhd`,
    /// and `mdhd`.
    pub duration_ticks: u64,
    /// Number of samples, equal across every sample table and the top-level
    /// `mdat` count.
    pub sample_count: u64,
    /// Number of sync samples listed in `stss`.
    pub sync_sample_count: u64,
    /// Color parameters read back from the `colr` (`nclx`) box.
    pub color: ColorParametersV1,
    /// Opaque provenance payload of the labeled `uuid` box, without the
    /// 16-byte [`PROVENANCE_UUID_V1`] user type.
    pub provenance: Vec<u8>,
}

/// A candidate client-export MP4 failed the v1 structural verification.
///
/// Verification is fail-closed: the first violated check names the refusal
/// and no partial structure is ever reported.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExportMp4VerifyErrorV1 {
    /// The input exceeds the verification size bound.
    #[error(
        "the input is {actual_bytes} bytes; the v1 verification bound is \
         {MAX_VERIFIED_EXPORT_MP4_BYTES_V1}"
    )]
    InputTooLarge {
        /// Size of the rejected input in bytes.
        actual_bytes: usize,
    },
    /// The bytes do not decode as a complete sequence of ISO BMFF atoms.
    #[error("the container does not parse as ISO BMFF: {detail}")]
    MalformedContainer {
        /// Parser diagnostic for the rejected bytes.
        detail: String,
    },
    /// The top-level atoms are not `ftyp | uuid | mdat.. | moov`.
    #[error("the top-level layout is not ftyp | uuid | mdat.. | moov: {detail}")]
    LayoutMismatch {
        /// Which layout expectation was violated.
        detail: String,
    },
    /// The labeled provenance `uuid` box is absent or does not carry the
    /// [`PROVENANCE_UUID_V1`] user type.
    #[error(
        "the provenance uuid box is missing or does not carry the \
         poietra-prov-v01 user type"
    )]
    ProvenanceMissing,
    /// The provenance payload exceeds the v1 bound.
    #[error(
        "the provenance payload is {actual_bytes} bytes; the v1 bound is \
         {MAX_PROVENANCE_BYTES_V1}"
    )]
    ProvenanceTooLarge {
        /// Size of the rejected payload in bytes.
        actual_bytes: usize,
    },
    /// The movie does not describe exactly one conforming AVC video track.
    #[error("the movie does not describe exactly one conforming video track: {detail}")]
    TrackMismatch {
        /// Which track expectation was violated.
        detail: String,
    },
    /// The sync-sample table is absent or does not mark the first sample.
    #[error("the sync-sample table is missing or does not mark the first sample as a keyframe")]
    KeyframeFirstMissing,
    /// The `avc1` sample entry carries no `colr` box of type `nclx`.
    #[error("the avc1 sample entry carries no colr box of type nclx")]
    ColorParametersMissing,
    /// The sample tables and the `mdat` count disagree with each other or
    /// with the fixed one-sample-per-chunk layout.
    #[error("the sample tables disagree: {detail}")]
    SampleTableMismatch {
        /// Which sample-table expectation was violated.
        detail: String,
    },
    /// The movie is longer than the closed export ladder permits.
    #[error(
        "a duration of {duration_ticks} ticks at {timescale} Hz exceeds the \
         {MAX_VERIFIED_EXPORT_DURATION_SECONDS_V1}-second v1 export bound"
    )]
    DurationExceeded {
        /// The rejected duration in media-timescale ticks.
        duration_ticks: u64,
        /// The timescale the duration is measured against.
        timescale: u32,
    },
    /// The coded frame size is outside the closed export resolution ladder.
    #[error("{width_px}x{height_px} is outside the closed export resolution ladder")]
    ResolutionUnsupported {
        /// The rejected frame width in pixels.
        width_px: u16,
        /// The rejected frame height in pixels.
        height_px: u16,
    },
}

#[derive(Clone, Copy, Debug)]
struct TopLevelAtomSpan {
    kind: FourCC,
    box_start: usize,
    payload_start: usize,
    box_end: usize,
    header_bytes: usize,
}

#[derive(Clone, Copy, Debug)]
struct SampleTableSummary {
    sample_count: u64,
    duration_ticks: u64,
}

/// Verifies that `bytes` are one complete MP4 exactly as
/// [`ExportMuxSessionV1`](crate::ExportMuxSessionV1) produces it and returns
/// the proven structure together with the opaque provenance payload.
///
/// The checks run in a fixed fail-closed order: size bound, full container
/// decode, top-level layout, track shape, color parameters, resolution
/// ladder, keyframe-first `stss`, sample-table consistency, and finally the
/// duration agreement and bound.
///
/// # Errors
///
/// Returns the [`ExportMp4VerifyErrorV1`] variant naming the first violated
/// check; see each variant for the exact condition.
pub fn verify_export_mp4_v1(bytes: &[u8]) -> Result<ExportMp4StructureV1, ExportMp4VerifyErrorV1> {
    if bytes.len() > MAX_VERIFIED_EXPORT_MP4_BYTES_V1 {
        return Err(ExportMp4VerifyErrorV1::InputTooLarge {
            actual_bytes: bytes.len(),
        });
    }
    if bytes.is_empty() {
        return Err(ExportMp4VerifyErrorV1::MalformedContainer {
            detail: "the input is empty".to_owned(),
        });
    }
    let spans = decode_top_level_spans(bytes)?;
    let (provenance, media_spans, moov_span) = verify_layout(bytes, &spans)?;
    let moov = decode_moov(bytes, moov_span)?;
    let (trak, avc1) = single_video_avc1(&moov)?;
    let color = color_parameters(avc1)?;
    let (width_px, height_px) = verify_dimensions(trak, avc1)?;
    let sample_tables = verify_sample_tables(trak, media_spans)?;
    let sync_sample_count = verify_sync_samples(trak, sample_tables.sample_count)?;
    let (timescale, duration_ticks) = verify_durations(&moov, trak, sample_tables.duration_ticks)?;
    Ok(ExportMp4StructureV1 {
        width_px,
        height_px,
        timescale,
        duration_ticks,
        sample_count: sample_tables.sample_count,
        sync_sample_count,
        color,
        provenance,
    })
}

/// A `usize` count always fits `u64` on supported targets; saturating keeps
/// the conversion panic-free without a lossy cast.
fn count_u64(count: usize) -> u64 {
    u64::try_from(count).unwrap_or(u64::MAX)
}

fn layout_mismatch(detail: impl Into<String>) -> ExportMp4VerifyErrorV1 {
    ExportMp4VerifyErrorV1::LayoutMismatch {
        detail: detail.into(),
    }
}

fn track_mismatch(detail: impl Into<String>) -> ExportMp4VerifyErrorV1 {
    ExportMp4VerifyErrorV1::TrackMismatch {
        detail: detail.into(),
    }
}

fn sample_table_mismatch(detail: impl Into<String>) -> ExportMp4VerifyErrorV1 {
    ExportMp4VerifyErrorV1::SampleTableMismatch {
        detail: detail.into(),
    }
}

fn malformed(detail: impl Into<String>) -> ExportMp4VerifyErrorV1 {
    ExportMp4VerifyErrorV1::MalformedContainer {
        detail: detail.into(),
    }
}

fn decode_top_level_spans(bytes: &[u8]) -> Result<Vec<TopLevelAtomSpan>, ExportMp4VerifyErrorV1> {
    let mut cursor = 0usize;
    let mut spans = Vec::new();
    let atom_bound = usize::try_from(MAX_SAMPLE_TABLE_ENTRIES_V1)
        .unwrap_or(usize::MAX)
        .saturating_add(3);
    while cursor < bytes.len() {
        let remaining = bytes.len() - cursor;
        if remaining < 8 {
            return Err(malformed(format!(
                "{remaining} trailing bytes do not form an atom header"
            )));
        }
        if spans.len() >= atom_bound {
            return Err(sample_table_mismatch(format!(
                "the top-level atom count exceeds the v1 sample bound of \
                 {MAX_SAMPLE_TABLE_ENTRIES_V1}"
            )));
        }
        let size32 = u32::from_be_bytes(
            bytes[cursor..cursor + 4]
                .try_into()
                .expect("the length check guarantees four size bytes"),
        );
        let kind_bytes: [u8; 4] = bytes[cursor + 4..cursor + 8]
            .try_into()
            .expect("the length check guarantees four type bytes");
        let kind = FourCC::new(&kind_bytes);
        let (header_bytes, box_bytes) = match size32 {
            0 => (8usize, remaining),
            1 => {
                if remaining < 16 {
                    return Err(malformed("a large-size atom header is truncated"));
                }
                let declared = u64::from_be_bytes(
                    bytes[cursor + 8..cursor + 16]
                        .try_into()
                        .expect("the length check guarantees eight large-size bytes"),
                );
                if declared < 16 {
                    return Err(malformed(format!(
                        "atom {kind:?} declares invalid large size {declared}"
                    )));
                }
                let box_bytes = usize::try_from(declared)
                    .map_err(|_| malformed(format!("atom {kind:?} size does not fit memory")))?;
                (16usize, box_bytes)
            }
            declared if declared < 8 => {
                return Err(malformed(format!(
                    "atom {kind:?} declares invalid size {declared}"
                )));
            }
            declared => (
                8usize,
                usize::try_from(declared).expect("u32 always fits usize on supported targets"),
            ),
        };
        if box_bytes > remaining {
            return Err(malformed(format!(
                "atom {kind:?} declares {box_bytes} bytes with only {remaining} remaining"
            )));
        }
        let box_end = cursor
            .checked_add(box_bytes)
            .ok_or_else(|| malformed("an atom end offset overflowed"))?;
        spans.push(TopLevelAtomSpan {
            kind,
            box_start: cursor,
            payload_start: cursor + header_bytes,
            box_end,
            header_bytes,
        });
        cursor = box_end;
    }
    Ok(spans)
}

fn decode_moov(bytes: &[u8], span: &TopLevelAtomSpan) -> Result<Moov, ExportMp4VerifyErrorV1> {
    let mut encoded = &bytes[span.box_start..span.box_end];
    let moov = Moov::decode(&mut encoded)
        .map_err(|error| malformed(format!("the trailing moov atom does not decode: {error}")))?;
    if !encoded.is_empty() {
        return Err(malformed("the trailing moov atom was not fully consumed"));
    }
    Ok(moov)
}

fn verify_layout<'a>(
    bytes: &[u8],
    spans: &'a [TopLevelAtomSpan],
) -> Result<(Vec<u8>, &'a [TopLevelAtomSpan], &'a TopLevelAtomSpan), ExportMp4VerifyErrorV1> {
    let Some(ftyp_span) = spans.first() else {
        return Err(layout_mismatch("the first atom is not ftyp"));
    };
    if ftyp_span.kind != Ftyp::KIND {
        return Err(layout_mismatch("the first atom is not ftyp"));
    }
    let mut encoded_ftyp = &bytes[ftyp_span.box_start..ftyp_span.box_end];
    let ftyp = Ftyp::decode(&mut encoded_ftyp)
        .map_err(|error| malformed(format!("the ftyp atom does not decode: {error}")))?;
    if !encoded_ftyp.is_empty() {
        return Err(malformed("the ftyp atom was not fully consumed"));
    }
    if ftyp.major_brand != b"isom".into() {
        return Err(layout_mismatch("the ftyp major brand is not isom"));
    }
    let Some(uuid_span) = spans.get(1) else {
        return Err(ExportMp4VerifyErrorV1::ProvenanceMissing);
    };
    let uuid_body = &bytes[uuid_span.payload_start..uuid_span.box_end];
    if uuid_span.kind != FourCC::new(b"uuid") || !uuid_body.starts_with(&PROVENANCE_UUID_V1) {
        return Err(ExportMp4VerifyErrorV1::ProvenanceMissing);
    }
    let provenance = &uuid_body[PROVENANCE_UUID_V1.len()..];
    if provenance.len() > MAX_PROVENANCE_BYTES_V1 {
        return Err(ExportMp4VerifyErrorV1::ProvenanceTooLarge {
            actual_bytes: provenance.len(),
        });
    }
    let Some(moov_span) = spans.last() else {
        return Err(layout_mismatch("the last atom is not moov"));
    };
    if moov_span.kind != Moov::KIND {
        return Err(layout_mismatch("the last atom is not moov"));
    }
    // `first` and `get(1)` matched distinct atoms and `last` is a third one,
    // so the media slice bounds are in range.
    let media = &spans[2..spans.len() - 1];
    if media.is_empty() {
        return Err(layout_mismatch("no mdat atom precedes moov"));
    }
    for span in media {
        if span.kind != FourCC::new(b"mdat") {
            return Err(layout_mismatch(format!(
                "unexpected {:?} atom between the provenance box and moov",
                span.kind
            )));
        }
        if span.header_bytes != 8 {
            return Err(layout_mismatch(
                "an mdat atom does not use the muxer's fixed eight-byte header",
            ));
        }
    }
    Ok((provenance.to_vec(), media, moov_span))
}

fn single_video_avc1(moov: &Moov) -> Result<(&Trak, &Avc1), ExportMp4VerifyErrorV1> {
    if moov.trak.len() != 1 {
        return Err(track_mismatch(format!(
            "expected exactly one trak, found {}",
            moov.trak.len()
        )));
    }
    let trak = &moov.trak[0];
    if trak.mdia.hdlr.handler != b"vide".into() {
        return Err(track_mismatch(format!(
            "the media handler is {:?}, not vide",
            trak.mdia.hdlr.handler
        )));
    }
    if trak.mdia.minf.vmhd.is_none() {
        return Err(track_mismatch("the video media header (vmhd) is missing"));
    }
    let codecs = &trak.mdia.minf.stbl.stsd.codecs;
    if codecs.len() != 1 {
        return Err(track_mismatch(format!(
            "expected exactly one sample entry, found {}",
            codecs.len()
        )));
    }
    let Codec::Avc1(avc1) = &codecs[0] else {
        return Err(track_mismatch("the sample entry is not avc1"));
    };
    Ok((trak, avc1))
}

fn color_parameters(avc1: &Avc1) -> Result<ColorParametersV1, ExportMp4VerifyErrorV1> {
    match avc1.colr {
        Some(Colr::Nclx {
            colour_primaries,
            transfer_characteristics,
            matrix_coefficients,
            full_range_flag,
        }) => Ok(ColorParametersV1 {
            primaries: colour_primaries,
            transfer: transfer_characteristics,
            matrix: matrix_coefficients,
            full_range: full_range_flag,
        }),
        _ => Err(ExportMp4VerifyErrorV1::ColorParametersMissing),
    }
}

fn verify_dimensions(trak: &Trak, avc1: &Avc1) -> Result<(u16, u16), ExportMp4VerifyErrorV1> {
    let width_px = avc1.visual.width;
    let height_px = avc1.visual.height;
    if !EXPORT_RESOLUTION_LADDER_V1.contains(&(width_px, height_px)) {
        return Err(ExportMp4VerifyErrorV1::ResolutionUnsupported {
            width_px,
            height_px,
        });
    }
    if trak.tkhd.width != width_px.into() || trak.tkhd.height != height_px.into() {
        return Err(track_mismatch(format!(
            "tkhd reports {:?}x{:?} but the avc1 sample entry codes {width_px}x{height_px}",
            trak.tkhd.width, trak.tkhd.height
        )));
    }
    Ok((width_px, height_px))
}

fn verify_sync_samples(trak: &Trak, sample_count: u64) -> Result<u64, ExportMp4VerifyErrorV1> {
    let Some(stss) = &trak.mdia.minf.stbl.stss else {
        return Err(ExportMp4VerifyErrorV1::KeyframeFirstMissing);
    };
    if stss.entries.first() != Some(&1) {
        return Err(ExportMp4VerifyErrorV1::KeyframeFirstMissing);
    }
    if count_u64(stss.entries.len()) > sample_count {
        return Err(sample_table_mismatch(format!(
            "stss lists {} sync samples for only {sample_count} samples",
            stss.entries.len()
        )));
    }
    let mut previous = 0u32;
    for &sample_number in &stss.entries {
        if sample_number <= previous || u64::from(sample_number) > sample_count {
            return Err(sample_table_mismatch(format!(
                "stss sample numbers must be strictly increasing and within 1..={sample_count}"
            )));
        }
        previous = sample_number;
    }
    Ok(count_u64(stss.entries.len()))
}

fn verify_sample_tables(
    trak: &Trak,
    media_spans: &[TopLevelAtomSpan],
) -> Result<SampleTableSummary, ExportMp4VerifyErrorV1> {
    let stbl = &trak.mdia.minf.stbl;
    let stsz_count = match &stbl.stsz.samples {
        StszSamples::Different { sizes } => count_u64(sizes.len()),
        StszSamples::Identical { count, .. } => u64::from(*count),
    };
    if stsz_count == 0 || stsz_count > u64::from(MAX_SAMPLE_TABLE_ENTRIES_V1) {
        return Err(sample_table_mismatch(format!(
            "stsz sample count {stsz_count} is outside 1..={MAX_SAMPLE_TABLE_ENTRIES_V1}"
        )));
    }
    let chunk_offsets: Vec<u64> = match (&stbl.stco, &stbl.co64) {
        (Some(stco), None) => stco.entries.iter().copied().map(u64::from).collect(),
        (None, Some(co64)) => co64.entries.clone(),
        (Some(_), Some(_)) => {
            return Err(sample_table_mismatch("both stco and co64 are present"));
        }
        (None, None) => {
            return Err(sample_table_mismatch("neither stco nor co64 is present"));
        }
    };
    let chunk_count = count_u64(chunk_offsets.len());
    let mut stts_count = 0u64;
    let mut stts_duration = 0u64;
    for entry in &stbl.stts.entries {
        if entry.sample_count == 0 || entry.sample_delta == 0 {
            return Err(sample_table_mismatch(
                "stts entries must have positive sample_count and sample_delta",
            ));
        }
        stts_count = stts_count
            .checked_add(u64::from(entry.sample_count))
            .ok_or_else(|| sample_table_mismatch("stts sample count overflowed"))?;
        let entry_duration = u64::from(entry.sample_count)
            .checked_mul(u64::from(entry.sample_delta))
            .ok_or_else(|| sample_table_mismatch("stts duration overflowed"))?;
        stts_duration = stts_duration
            .checked_add(entry_duration)
            .ok_or_else(|| sample_table_mismatch("stts duration overflowed"))?;
    }
    let mdat_count = count_u64(media_spans.len());
    if stsz_count != chunk_count || stsz_count != stts_count || stsz_count != mdat_count {
        return Err(sample_table_mismatch(format!(
            "stsz lists {stsz_count} samples, the chunk offsets list {chunk_count}, \
             stts sums to {stts_count}, and {mdat_count} mdat atoms are present"
        )));
    }
    let one_sample_per_chunk = [StscEntry {
        first_chunk: 1,
        samples_per_chunk: 1,
        sample_description_index: 1,
    }];
    if stbl.stsc.entries != one_sample_per_chunk {
        return Err(sample_table_mismatch(
            "stsc does not describe exactly one sample per chunk",
        ));
    }
    for (index, span) in media_spans.iter().enumerate() {
        let payload_size = span.box_end - span.payload_start;
        let table_size = match &stbl.stsz.samples {
            StszSamples::Different { sizes } => sizes[index],
            StszSamples::Identical { size, .. } => *size,
        };
        if table_size == 0 || u64::from(table_size) != count_u64(payload_size) {
            return Err(sample_table_mismatch(format!(
                "sample {} has mdat payload size {payload_size} but stsz reports {table_size}",
                index + 1
            )));
        }
        let payload_offset = u64::try_from(span.payload_start)
            .map_err(|_| sample_table_mismatch("an mdat payload offset does not fit u64"))?;
        if chunk_offsets[index] != payload_offset {
            return Err(sample_table_mismatch(format!(
                "sample {} starts at byte {payload_offset} but the chunk table reports {}",
                index + 1,
                chunk_offsets[index]
            )));
        }
    }
    Ok(SampleTableSummary {
        sample_count: stsz_count,
        duration_ticks: stts_duration,
    })
}

fn verify_durations(
    moov: &Moov,
    trak: &Trak,
    stts_duration_ticks: u64,
) -> Result<(u32, u64), ExportMp4VerifyErrorV1> {
    let mdhd = &trak.mdia.mdhd;
    if moov.mvhd.timescale != mdhd.timescale {
        return Err(track_mismatch(format!(
            "mvhd timescale {} disagrees with mdhd timescale {}",
            moov.mvhd.timescale, mdhd.timescale
        )));
    }
    if moov.mvhd.duration != trak.tkhd.duration || moov.mvhd.duration != mdhd.duration {
        return Err(track_mismatch(format!(
            "durations disagree: mvhd {} ticks, tkhd {} ticks, mdhd {} ticks",
            moov.mvhd.duration, trak.tkhd.duration, mdhd.duration
        )));
    }
    if mdhd.duration != stts_duration_ticks {
        return Err(sample_table_mismatch(format!(
            "stts sums to {stts_duration_ticks} ticks but the media headers report {}",
            mdhd.duration
        )));
    }
    let timescale = moov.mvhd.timescale;
    if timescale == 0 {
        return Err(track_mismatch("the movie timescale is zero"));
    }
    let duration_ticks = moov.mvhd.duration;
    if duration_ticks > MAX_VERIFIED_EXPORT_DURATION_SECONDS_V1 * u64::from(timescale) {
        return Err(ExportMp4VerifyErrorV1::DurationExceeded {
            duration_ticks,
            timescale,
        });
    }
    Ok((timescale, duration_ticks))
}

#[cfg(test)]
mod tests {
    use std::num::{NonZeroU16, NonZeroU32};

    use mp4_atom::{Any, Avcc, Co64, DecodeMaybe, Encode, Mdat};

    use super::*;
    use crate::session::{
        EncodedSampleV1, ExportMuxConfigV1, ExportMuxSessionV1, VideoParametersV1,
    };

    const TEST_PROVENANCE: &[u8] = b"scene-revision=0123abcd;engine=0.1.0";

    fn synthetic_avcc() -> Avcc {
        Avcc {
            configuration_version: 1,
            avc_profile_indication: 0x64,
            profile_compatibility: 0,
            avc_level_indication: 0x1F,
            length_size: 4,
            sequence_parameter_sets: vec![vec![0x67, 0x64, 0x00, 0x1F, 0xAC, 0xD9, 0x40, 0x50]],
            picture_parameter_sets: vec![vec![0x68, 0xEB, 0xE3, 0xCB]],
            ext: None,
        }
    }

    fn synthetic_description() -> Vec<u8> {
        let mut encoded = Vec::new();
        synthetic_avcc().encode(&mut encoded).unwrap();
        encoded[8..].to_vec()
    }

    fn config(width_px: u16, height_px: u16) -> ExportMuxConfigV1 {
        ExportMuxConfigV1 {
            decoder_configuration: synthetic_description(),
            video: VideoParametersV1 {
                width_px: NonZeroU16::new(width_px).unwrap(),
                height_px: NonZeroU16::new(height_px).unwrap(),
                timescale: NonZeroU32::new(1_000_000).unwrap(),
                frames_per_second: NonZeroU32::new(30).unwrap(),
            },
            color: ColorParametersV1 {
                primaries: 1,
                transfer: 13,
                matrix: 1,
                full_range: false,
            },
            provenance: TEST_PROVENANCE.to_vec(),
            max_sample_count: NonZeroU32::new(16).unwrap(),
        }
    }

    fn sample(bytes: &[u8], timestamp_us: u64, is_key: bool) -> EncodedSampleV1<'_> {
        EncodedSampleV1 {
            bytes,
            timestamp_us,
            duration_us: 33_333,
            is_key,
        }
    }

    /// Three samples (keyframes first and last) at the given resolution.
    fn mux_three_samples(width_px: u16, height_px: u16) -> Vec<u8> {
        let mut session =
            ExportMuxSessionV1::begin(config(width_px, height_px), Vec::new()).unwrap();
        session
            .append_sample(sample(&[0x11; 120], 0, true))
            .unwrap();
        session
            .append_sample(sample(&[0x22; 90], 33_333, false))
            .unwrap();
        session
            .append_sample(sample(&[0x33; 150], 66_667, true))
            .unwrap();
        session.finish().unwrap()
    }

    fn decode_atoms(bytes: &[u8]) -> Vec<Any> {
        let mut buf: &[u8] = bytes;
        let mut atoms = Vec::new();
        while let Some(atom) = Any::decode_maybe(&mut buf).unwrap() {
            atoms.push(atom);
        }
        assert!(buf.is_empty(), "no trailing garbage after the last atom");
        atoms
    }

    fn encode_atoms(atoms: &[Any]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for atom in atoms {
            atom.encode(&mut bytes).unwrap();
        }
        bytes
    }

    /// Decodes a valid file, applies one mutation to its atom list, and
    /// re-encodes the result exactly like the muxer would.
    fn rewrite(bytes: &[u8], mutate: impl FnOnce(&mut Vec<Any>)) -> Vec<u8> {
        let mut atoms = decode_atoms(bytes);
        mutate(&mut atoms);
        encode_atoms(&atoms)
    }

    /// Rewrites only the trailing `moov` of a valid file.
    fn rewrite_moov(bytes: &[u8], mutate: impl FnOnce(&mut Moov)) -> Vec<u8> {
        rewrite(bytes, |atoms| {
            let Some(Any::Moov(moov)) = atoms.last_mut() else {
                panic!("the last atom must be moov");
            };
            mutate(moov);
        })
    }

    fn avc1_mut(moov: &mut Moov) -> &mut Avc1 {
        let Codec::Avc1(avc1) = &mut moov.trak[0].mdia.minf.stbl.stsd.codecs[0] else {
            panic!("the sample entry must be avc1");
        };
        avc1
    }

    #[test]
    fn accepts_a_freshly_muxed_file_and_reports_its_exact_structure() {
        let structure = verify_export_mp4_v1(&mux_three_samples(854, 480)).unwrap();
        assert_eq!(
            structure,
            ExportMp4StructureV1 {
                width_px: 854,
                height_px: 480,
                timescale: 1_000_000,
                duration_ticks: 100_000,
                sample_count: 3,
                sync_sample_count: 2,
                color: ColorParametersV1 {
                    primaries: 1,
                    transfer: 13,
                    matrix: 1,
                    full_range: false,
                },
                provenance: TEST_PROVENANCE.to_vec(),
            }
        );
    }

    #[test]
    fn accepts_every_rung_of_the_resolution_ladder() {
        for (width_px, height_px) in EXPORT_RESOLUTION_LADDER_V1 {
            let structure = verify_export_mp4_v1(&mux_three_samples(width_px, height_px)).unwrap();
            assert_eq!(
                (structure.width_px, structure.height_px),
                (width_px, height_px)
            );
        }
    }

    #[test]
    fn rejects_input_beyond_the_size_bound_before_decoding() {
        let error =
            verify_export_mp4_v1(&vec![0u8; MAX_VERIFIED_EXPORT_MP4_BYTES_V1 + 1]).unwrap_err();
        assert_eq!(
            error,
            ExportMp4VerifyErrorV1::InputTooLarge {
                actual_bytes: MAX_VERIFIED_EXPORT_MP4_BYTES_V1 + 1,
            }
        );
    }

    #[test]
    fn rejects_empty_truncated_and_garbage_input() {
        for bytes in [b"".to_vec(), b"not an mp4 container".to_vec()] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::MalformedContainer { .. }
            ));
        }
        let mut truncated = mux_three_samples(854, 480);
        truncated.truncate(truncated.len() - 10);
        assert!(matches!(
            verify_export_mp4_v1(&truncated).unwrap_err(),
            ExportMp4VerifyErrorV1::MalformedContainer { .. }
        ));
    }

    #[test]
    fn rejects_trailing_garbage_after_the_last_atom() {
        let mut bytes = mux_three_samples(854, 480);
        bytes.extend_from_slice(b"tail");
        assert!(matches!(
            verify_export_mp4_v1(&bytes).unwrap_err(),
            ExportMp4VerifyErrorV1::MalformedContainer { .. }
        ));
    }

    #[test]
    fn rejects_a_missing_provenance_box() {
        let bytes = rewrite(&mux_three_samples(854, 480), |atoms| {
            atoms.remove(1);
        });
        assert_eq!(
            verify_export_mp4_v1(&bytes).unwrap_err(),
            ExportMp4VerifyErrorV1::ProvenanceMissing
        );
    }

    #[test]
    fn rejects_a_uuid_box_with_the_wrong_user_type() {
        let bytes = rewrite(&mux_three_samples(854, 480), |atoms| {
            let Any::Unknown(_, body) = &mut atoms[1] else {
                panic!("the second atom must be the uuid box");
            };
            body[0] = b'X';
        });
        assert_eq!(
            verify_export_mp4_v1(&bytes).unwrap_err(),
            ExportMp4VerifyErrorV1::ProvenanceMissing
        );
    }

    #[test]
    fn rejects_an_oversized_provenance_payload() {
        let bytes = rewrite(&mux_three_samples(854, 480), |atoms| {
            let mut body = PROVENANCE_UUID_V1.to_vec();
            body.extend(vec![0xAA; MAX_PROVENANCE_BYTES_V1 + 1]);
            atoms[1] = Any::Unknown(FourCC::new(b"uuid"), body);
        });
        assert_eq!(
            verify_export_mp4_v1(&bytes).unwrap_err(),
            ExportMp4VerifyErrorV1::ProvenanceTooLarge {
                actual_bytes: MAX_PROVENANCE_BYTES_V1 + 1,
            }
        );
    }

    #[test]
    fn rejects_layout_violations() {
        let valid = mux_three_samples(854, 480);
        let wrong_brand = rewrite(&valid, |atoms| {
            let Any::Ftyp(ftyp) = &mut atoms[0] else {
                panic!("the first atom must be ftyp");
            };
            ftyp.major_brand = b"mp42".into();
        });
        let no_mdat = rewrite(&valid, |atoms| {
            atoms.retain(|atom| !matches!(atom, Any::Mdat(_)));
        });
        let atom_after_moov = rewrite(&valid, |atoms| {
            atoms.push(Any::Mdat(Mdat {
                data: vec![0x44; 8],
            }));
        });
        let moov_before_mdat = rewrite(&valid, |atoms| {
            let moov = atoms.pop().unwrap();
            atoms.insert(2, moov);
        });
        for bytes in [wrong_brand, no_mdat, atom_after_moov, moov_before_mdat] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::LayoutMismatch { .. }
            ));
        }
    }

    #[test]
    fn rejects_track_shape_violations() {
        let valid = mux_three_samples(854, 480);
        let two_traks = rewrite_moov(&valid, |moov| {
            let clone = moov.trak[0].clone();
            moov.trak.push(clone);
        });
        let wrong_handler = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.hdlr.handler = b"soun".into();
        });
        let no_vmhd = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.minf.vmhd = None;
        });
        for bytes in [two_traks, wrong_handler, no_vmhd] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::TrackMismatch { .. }
            ));
        }
    }

    #[test]
    fn rejects_a_missing_or_non_nclx_colr_box() {
        let valid = mux_three_samples(854, 480);
        let no_colr = rewrite_moov(&valid, |moov| {
            avc1_mut(moov).colr = None;
        });
        let non_nclx = rewrite_moov(&valid, |moov| {
            avc1_mut(moov).colr = Some(Colr::Nclc {
                colour_primaries: 1,
                transfer_characteristics: 1,
                matrix_coefficients: 1,
            });
        });
        for bytes in [no_colr, non_nclx] {
            assert_eq!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::ColorParametersMissing
            );
        }
    }

    #[test]
    fn rejects_a_resolution_outside_the_closed_ladder() {
        assert_eq!(
            verify_export_mp4_v1(&mux_three_samples(100, 100)).unwrap_err(),
            ExportMp4VerifyErrorV1::ResolutionUnsupported {
                width_px: 100,
                height_px: 100,
            }
        );
    }

    #[test]
    fn rejects_a_tkhd_size_that_disagrees_with_the_sample_entry() {
        let valid = mux_three_samples(854, 480);
        let wrong_integer = rewrite_moov(&valid, |moov| {
            moov.trak[0].tkhd.width = 1280u16.into();
        });
        let fractional = rewrite_moov(&valid, |moov| {
            moov.trak[0].tkhd.width = mp4_atom::FixedPoint::new(854, 1);
        });
        for bytes in [wrong_integer, fractional] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::TrackMismatch { .. }
            ));
        }
    }

    #[test]
    fn rejects_a_missing_or_late_first_sync_sample() {
        let valid = mux_three_samples(854, 480);
        let no_stss = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.minf.stbl.stss = None;
        });
        let late_first_key = rewrite_moov(&valid, |moov| {
            let stss = moov.trak[0].mdia.minf.stbl.stss.as_mut().unwrap();
            stss.entries[0] = 2;
        });
        for bytes in [no_stss, late_first_key] {
            assert_eq!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::KeyframeFirstMissing
            );
        }
    }

    #[test]
    fn rejects_sample_table_disagreements() {
        let valid = mux_three_samples(854, 480);
        let extra_stsz_entry = rewrite_moov(&valid, |moov| {
            let StszSamples::Different { sizes } = &mut moov.trak[0].mdia.minf.stbl.stsz.samples
            else {
                panic!("the muxer writes per-sample sizes");
            };
            sizes.push(1);
        });
        let multi_sample_chunks = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.minf.stbl.stsc.entries[0].samples_per_chunk = 2;
        });
        for bytes in [extra_stsz_entry, multi_sample_chunks] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::SampleTableMismatch { .. }
            ));
        }
    }

    #[test]
    fn rejects_sample_sizes_and_offsets_that_do_not_name_the_mdat_payloads() {
        let valid = mux_three_samples(854, 480);
        let wrong_size = rewrite_moov(&valid, |moov| {
            let StszSamples::Different { sizes } = &mut moov.trak[0].mdia.minf.stbl.stsz.samples
            else {
                panic!("the muxer writes per-sample sizes");
            };
            sizes[1] += 1;
        });
        let wrong_stco = rewrite_moov(&valid, |moov| {
            moov.trak[0]
                .mdia
                .minf
                .stbl
                .stco
                .as_mut()
                .expect("a small fixture uses stco")
                .entries[1] += 1;
        });
        for bytes in [wrong_size, wrong_stco] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::SampleTableMismatch { .. }
            ));
        }
    }

    #[test]
    fn correlates_co64_offsets_with_the_exact_mdat_payload_starts() {
        let valid = mux_three_samples(854, 480);
        let co64_valid = rewrite_moov(&valid, |moov| {
            let stbl = &mut moov.trak[0].mdia.minf.stbl;
            let entries = stbl
                .stco
                .take()
                .expect("a small fixture uses stco")
                .entries
                .into_iter()
                .map(u64::from)
                .collect();
            stbl.co64 = Some(Co64 { entries });
        });
        verify_export_mp4_v1(&co64_valid).expect("equivalent co64 offsets are accepted");

        let wrong_co64 = rewrite_moov(&co64_valid, |moov| {
            moov.trak[0]
                .mdia
                .minf
                .stbl
                .co64
                .as_mut()
                .expect("the rewritten fixture uses co64")
                .entries[2] += 1;
        });
        assert!(matches!(
            verify_export_mp4_v1(&wrong_co64).unwrap_err(),
            ExportMp4VerifyErrorV1::SampleTableMismatch { .. }
        ));
    }

    #[test]
    fn rejects_zero_or_mismatched_stts_duration() {
        let valid = mux_three_samples(854, 480);
        let zero_delta = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.minf.stbl.stts.entries[0].sample_delta = 0;
        });
        let duration_disagrees = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.minf.stbl.stts.entries[0].sample_delta += 1;
        });
        for bytes in [zero_delta, duration_disagrees] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::SampleTableMismatch { .. }
            ));
        }
    }

    #[test]
    fn rejects_unordered_duplicate_or_out_of_range_sync_samples() {
        let valid = mux_three_samples(854, 480);
        let duplicate = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.minf.stbl.stss.as_mut().unwrap().entries[1] = 1;
        });
        let out_of_range = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.minf.stbl.stss.as_mut().unwrap().entries[1] = 4;
        });
        let too_many = rewrite_moov(&valid, |moov| {
            moov.trak[0]
                .mdia
                .minf
                .stbl
                .stss
                .as_mut()
                .unwrap()
                .entries
                .extend([2, 3]);
        });
        for bytes in [duplicate, out_of_range, too_many] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::SampleTableMismatch { .. }
            ));
        }
    }

    #[test]
    fn rejects_duration_disagreements_between_the_headers() {
        let valid = mux_three_samples(854, 480);
        let tkhd_disagrees = rewrite_moov(&valid, |moov| {
            moov.trak[0].tkhd.duration += 1;
        });
        let mdhd_timescale_disagrees = rewrite_moov(&valid, |moov| {
            moov.trak[0].mdia.mdhd.timescale = 90_000;
        });
        for bytes in [tkhd_disagrees, mdhd_timescale_disagrees] {
            assert!(matches!(
                verify_export_mp4_v1(&bytes).unwrap_err(),
                ExportMp4VerifyErrorV1::TrackMismatch { .. }
            ));
        }
    }

    #[test]
    fn rejects_a_movie_longer_than_the_export_bound() {
        let mut session = ExportMuxSessionV1::begin(config(854, 480), Vec::new()).unwrap();
        session.append_sample(sample(&[0x11; 32], 0, true)).unwrap();
        session
            .append_sample(sample(&[0x22; 32], 901_000_000, false))
            .unwrap();
        let bytes = session.finish().unwrap();
        assert!(matches!(
            verify_export_mp4_v1(&bytes).unwrap_err(),
            ExportMp4VerifyErrorV1::DurationExceeded {
                duration_ticks,
                timescale: 1_000_000,
            } if duration_ticks > 900 * 1_000_000
        ));
    }
}
