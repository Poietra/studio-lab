//! Minimal WAV admission for the local browser export path.
//!
//! This is deliberately not a general audio model. The browser exporter
//! accepts one exact format that `AudioData` can consume without resampling:
//! RIFF/WAVE PCM, 48 kHz, signed 16-bit little-endian, mono or stereo.

use std::fmt;

use serde::Deserialize;

const RIFF_HEADER_BYTES: usize = 12;
const CHUNK_HEADER_BYTES: usize = 8;
const PCM_FORMAT_TAG: u16 = 1;
const SAMPLE_RATE_HZ: u32 = 48_000;
const BYTES_PER_SAMPLE: u16 = 2;

pub(crate) const MAX_WAV_INPUT_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const AUDIO_FRAME_SAMPLES: usize = 960; // 20 ms at 48 kHz.

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct PcmTimelineTiming {
    #[serde(rename = "timelineOffsetSampleFrames")]
    pub(crate) timeline_offset: u64,
    #[serde(rename = "trimEndSampleFrames")]
    pub(crate) trim_end: Option<u64>,
    #[serde(rename = "trimStartSampleFrames")]
    pub(crate) trim_start: u64,
}

pub(crate) fn parse_pcm_timeline_timing(
    bytes: &[u8],
) -> Result<PcmTimelineTiming, serde_json::Error> {
    serde_json::from_slice(bytes)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WavRefusal {
    InputTooLarge { actual: usize },
    Invalid(&'static str),
    UnsupportedContainer,
    UnsupportedFormat(u16),
    UnsupportedChannels(u16),
    UnsupportedSampleRate(u32),
    UnsupportedBitsPerSample(u16),
}

impl WavRefusal {
    pub(crate) const fn wire_name(&self) -> &'static str {
        match self {
            Self::InputTooLarge { .. } => "wav-too-large",
            Self::Invalid(_) => "invalid-wav",
            Self::UnsupportedContainer => "unsupported-wav-container",
            Self::UnsupportedFormat(_) => "unsupported-wav-format",
            Self::UnsupportedChannels(_) => "unsupported-wav-channels",
            Self::UnsupportedSampleRate(_) => "unsupported-wav-sample-rate",
            Self::UnsupportedBitsPerSample(_) => "unsupported-wav-bit-depth",
        }
    }
}

impl fmt::Display for WavRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InputTooLarge { actual } => write!(
                formatter,
                "the WAV input is {actual} bytes; the limit is {MAX_WAV_INPUT_BYTES} bytes"
            ),
            Self::Invalid(message) => formatter.write_str(message),
            Self::UnsupportedContainer => {
                formatter.write_str("only a RIFF/WAVE container is supported (RF64 is not)")
            }
            Self::UnsupportedFormat(tag) => {
                write!(formatter, "WAV format tag {tag} is not integer PCM (tag 1)")
            }
            Self::UnsupportedChannels(channels) => {
                write!(
                    formatter,
                    "WAV channel count {channels} is not mono or stereo"
                )
            }
            Self::UnsupportedSampleRate(rate) => {
                write!(formatter, "WAV sample rate {rate} Hz is not 48000 Hz")
            }
            Self::UnsupportedBitsPerSample(bits) => {
                write!(formatter, "WAV bit depth {bits} is not signed 16-bit PCM")
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PcmWav {
    channels: u8,
    interleaved_s16_le: Vec<u8>,
}

impl PcmWav {
    pub(crate) fn sample_frames(&self) -> u64 {
        let bytes_per_frame = u64::from(self.channels) * u64::from(BYTES_PER_SAMPLE);
        u64::try_from(self.interleaved_s16_le.len()).unwrap_or(u64::MAX) / bytes_per_frame
    }

    /// Trims or zero-pads the admitted PCM to the exact video frame-grid
    /// duration. Both supported video rates divide 48 kHz exactly.
    pub(crate) fn fit_to_video(
        self,
        video_frame_count: u64,
        frames_per_second: u32,
        timing: PcmTimelineTiming,
    ) -> Result<PreparedPcm, WavRefusal> {
        let sample_frames = video_frame_count
            .checked_mul(u64::from(SAMPLE_RATE_HZ))
            .and_then(|samples| samples.checked_div(u64::from(frames_per_second)))
            .ok_or(WavRefusal::Invalid("the audio duration overflowed"))?;
        if sample_frames == 0
            || sample_frames.checked_mul(u64::from(frames_per_second))
                != video_frame_count.checked_mul(u64::from(SAMPLE_RATE_HZ))
        {
            return Err(WavRefusal::Invalid(
                "the video duration is not representable on the 48 kHz audio grid",
            ));
        }
        let source_sample_frames = self.sample_frames();
        let trim_end_sample_frames = timing.trim_end.unwrap_or(source_sample_frames);
        if timing.trim_start >= trim_end_sample_frames {
            return Err(WavRefusal::Invalid(
                "audio trim out must be later than trim in",
            ));
        }
        if trim_end_sample_frames > source_sample_frames {
            return Err(WavRefusal::Invalid(
                "audio trim out exceeds the WAV duration",
            ));
        }
        let content_sample_frames = trim_end_sample_frames
            .saturating_sub(timing.trim_start)
            .min(sample_frames.saturating_sub(timing.timeline_offset));
        let bytes_per_frame = u64::from(self.channels) * u64::from(BYTES_PER_SAMPLE);
        let byte_start = timing
            .trim_start
            .checked_mul(bytes_per_frame)
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(WavRefusal::Invalid("the audio trim start overflowed"))?;
        let byte_end = timing
            .trim_start
            .checked_add(content_sample_frames)
            .and_then(|value| value.checked_mul(bytes_per_frame))
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(WavRefusal::Invalid("the audio trim end overflowed"))?;
        Ok(PreparedPcm {
            channels: self.channels,
            interleaved_s16_le: self.interleaved_s16_le[byte_start..byte_end].to_vec(),
            sample_frames,
            timeline_start_sample: timing.timeline_offset.min(sample_frames),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedPcm {
    channels: u8,
    interleaved_s16_le: Vec<u8>,
    sample_frames: u64,
    timeline_start_sample: u64,
}

impl PreparedPcm {
    pub(crate) const fn channels(&self) -> u8 {
        self.channels
    }

    pub(crate) fn chunks(&self) -> PreparedPcmChunks<'_> {
        PreparedPcmChunks {
            pcm: self,
            first_sample: 0,
        }
    }
}

pub(crate) struct PreparedPcmChunks<'a> {
    pcm: &'a PreparedPcm,
    first_sample: u64,
}

impl Iterator for PreparedPcmChunks<'_> {
    type Item = PcmChunk;

    fn next(&mut self) -> Option<Self::Item> {
        let remaining = self.pcm.sample_frames.checked_sub(self.first_sample)?;
        if remaining == 0 {
            return None;
        }
        let source_sample_frames = remaining.min(AUDIO_FRAME_SAMPLES as u64);
        let bytes_per_frame = usize::from(self.pcm.channels) * usize::from(BYTES_PER_SAMPLE);
        let byte_len = AUDIO_FRAME_SAMPLES.checked_mul(bytes_per_frame)?;
        let mut bytes = vec![0; byte_len];
        let content_sample_frames = u64::try_from(self.pcm.interleaved_s16_le.len())
            .ok()?
            .checked_div(u64::try_from(bytes_per_frame).ok()?)?;
        let chunk_end = self.first_sample.checked_add(source_sample_frames)?;
        let content_end = self
            .pcm
            .timeline_start_sample
            .checked_add(content_sample_frames)?;
        let overlap_start = self.first_sample.max(self.pcm.timeline_start_sample);
        let overlap_end = chunk_end.min(content_end);
        if overlap_start < overlap_end {
            let source_byte_start = usize::try_from(overlap_start - self.pcm.timeline_start_sample)
                .ok()?
                .checked_mul(bytes_per_frame)?;
            let destination_byte_start = usize::try_from(overlap_start - self.first_sample)
                .ok()?
                .checked_mul(bytes_per_frame)?;
            let overlap_byte_len = usize::try_from(overlap_end - overlap_start)
                .ok()?
                .checked_mul(bytes_per_frame)?;
            bytes[destination_byte_start..destination_byte_start + overlap_byte_len]
                .copy_from_slice(
                    &self.pcm.interleaved_s16_le
                        [source_byte_start..source_byte_start + overlap_byte_len],
                );
        }
        let chunk = PcmChunk {
            bytes,
            first_sample: self.first_sample,
            sample_frames: u32::try_from(AUDIO_FRAME_SAMPLES)
                .expect("a 20 ms PCM chunk fits in u32"),
        };
        self.first_sample += AUDIO_FRAME_SAMPLES as u64;
        Some(chunk)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PcmChunk {
    pub(crate) bytes: Vec<u8>,
    pub(crate) first_sample: u64,
    pub(crate) sample_frames: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WaveFormat {
    channels: u16,
    sample_rate: u32,
    byte_rate: u32,
    block_align: u16,
    bits_per_sample: u16,
    format_tag: u16,
}

fn u16_le(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn parse_format(bytes: &[u8]) -> Result<WaveFormat, WavRefusal> {
    if bytes.len() < 16 {
        return Err(WavRefusal::Invalid(
            "the WAV fmt chunk is shorter than 16 bytes",
        ));
    }
    Ok(WaveFormat {
        format_tag: u16_le(bytes, 0),
        channels: u16_le(bytes, 2),
        sample_rate: u32_le(bytes, 4),
        byte_rate: u32_le(bytes, 8),
        block_align: u16_le(bytes, 12),
        bits_per_sample: u16_le(bytes, 14),
    })
}

fn validate_format(format: WaveFormat) -> Result<u8, WavRefusal> {
    if format.format_tag != PCM_FORMAT_TAG {
        return Err(WavRefusal::UnsupportedFormat(format.format_tag));
    }
    if !matches!(format.channels, 1 | 2) {
        return Err(WavRefusal::UnsupportedChannels(format.channels));
    }
    if format.sample_rate != SAMPLE_RATE_HZ {
        return Err(WavRefusal::UnsupportedSampleRate(format.sample_rate));
    }
    if format.bits_per_sample != 16 {
        return Err(WavRefusal::UnsupportedBitsPerSample(format.bits_per_sample));
    }
    let expected_block_align = format
        .channels
        .checked_mul(BYTES_PER_SAMPLE)
        .ok_or(WavRefusal::Invalid("the WAV block alignment overflowed"))?;
    let expected_byte_rate = SAMPLE_RATE_HZ
        .checked_mul(u32::from(expected_block_align))
        .ok_or(WavRefusal::Invalid("the WAV byte rate overflowed"))?;
    if format.block_align != expected_block_align || format.byte_rate != expected_byte_rate {
        return Err(WavRefusal::Invalid(
            "the WAV byte rate or block alignment is inconsistent with its format",
        ));
    }
    u8::try_from(format.channels)
        .map_err(|_| WavRefusal::Invalid("the WAV channel count is not addressable"))
}

pub(crate) fn parse_pcm_wav(bytes: &[u8]) -> Result<PcmWav, WavRefusal> {
    if bytes.len() > MAX_WAV_INPUT_BYTES {
        return Err(WavRefusal::InputTooLarge {
            actual: bytes.len(),
        });
    }
    if bytes.len() < RIFF_HEADER_BYTES {
        return Err(WavRefusal::Invalid(
            "the WAV input is shorter than its RIFF header",
        ));
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(WavRefusal::UnsupportedContainer);
    }
    let declared_size = usize::try_from(u32_le(bytes, 4))
        .ok()
        .and_then(|size| size.checked_add(8))
        .ok_or(WavRefusal::Invalid("the RIFF size overflowed"))?;
    if declared_size != bytes.len() {
        return Err(WavRefusal::Invalid(
            "the RIFF size does not match the supplied WAV byte length",
        ));
    }

    let mut offset = RIFF_HEADER_BYTES;
    let mut format = None;
    let mut data = None;
    while offset < bytes.len() {
        let header_end = offset
            .checked_add(CHUNK_HEADER_BYTES)
            .ok_or(WavRefusal::Invalid("a WAV chunk header overflowed"))?;
        if header_end > bytes.len() {
            return Err(WavRefusal::Invalid("a WAV chunk header is truncated"));
        }
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_len = usize::try_from(u32_le(bytes, offset + 4))
            .map_err(|_| WavRefusal::Invalid("a WAV chunk length is not addressable"))?;
        let chunk_end = header_end
            .checked_add(chunk_len)
            .ok_or(WavRefusal::Invalid("a WAV chunk length overflowed"))?;
        if chunk_end > bytes.len() {
            return Err(WavRefusal::Invalid(
                "a WAV chunk extends beyond the RIFF container",
            ));
        }
        match chunk_id {
            b"fmt " if format.is_some() => {
                return Err(WavRefusal::Invalid("the WAV contains duplicate fmt chunks"));
            }
            b"fmt " => {
                format = Some(parse_format(&bytes[header_end..chunk_end])?);
            }
            b"data" if data.is_some() => {
                return Err(WavRefusal::Invalid(
                    "the WAV contains duplicate data chunks",
                ));
            }
            b"data" => {
                data = Some(&bytes[header_end..chunk_end]);
            }
            _ => {}
        }
        offset = chunk_end
            .checked_add(chunk_len & 1)
            .ok_or(WavRefusal::Invalid("WAV chunk padding overflowed"))?;
        if offset > bytes.len() {
            return Err(WavRefusal::Invalid("a padded WAV chunk is truncated"));
        }
    }

    let format = format.ok_or(WavRefusal::Invalid("the WAV has no fmt chunk"))?;
    let channels = validate_format(format)?;
    let data = data.ok_or(WavRefusal::Invalid("the WAV has no data chunk"))?;
    if data.is_empty() {
        return Err(WavRefusal::Invalid("the WAV data chunk is empty"));
    }
    let block_align = usize::from(format.block_align);
    if data.len() % block_align != 0 {
        return Err(WavRefusal::Invalid(
            "the WAV data length is not aligned to complete sample frames",
        ));
    }
    Ok(PcmWav {
        channels,
        interleaved_s16_le: data.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(channels: u16, sample_rate: u32, bits: u16, frames: usize) -> Vec<u8> {
        let bytes_per_sample = usize::from(bits / 8);
        let data_len = frames * usize::from(channels) * bytes_per_sample;
        let block_align = channels * (bits / 8);
        let byte_rate = sample_rate * u32::from(block_align);
        let mut bytes = Vec::with_capacity(44 + data_len);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&u32::try_from(36 + data_len).unwrap().to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0");
        bytes.extend_from_slice(&PCM_FORMAT_TAG.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&bits.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&u32::try_from(data_len).unwrap().to_le_bytes());
        for index in 0..data_len {
            bytes.push(u8::try_from(index % 251).unwrap());
        }
        bytes
    }

    #[test]
    fn admits_mono_and_stereo_pcm() {
        for channels in [1, 2] {
            let parsed = parse_pcm_wav(&wav(channels, SAMPLE_RATE_HZ, 16, 960)).unwrap();
            assert_eq!(parsed.channels, u8::try_from(channels).unwrap());
            assert_eq!(
                parsed.interleaved_s16_le.len(),
                960 * usize::from(channels) * 2
            );
        }
    }

    #[test]
    fn accepts_ancillary_chunks_and_odd_padding() {
        let mut bytes = wav(1, SAMPLE_RATE_HZ, 16, 1);
        let data_chunk = bytes.split_off(36);
        bytes.extend_from_slice(b"JUNK\x03\0\0\0abc\0");
        bytes.extend_from_slice(&data_chunk);
        let size = u32::try_from(bytes.len() - 8).unwrap().to_le_bytes();
        bytes[4..8].copy_from_slice(&size);
        assert!(parse_pcm_wav(&bytes).is_ok());
    }

    #[test]
    fn rejects_unsupported_or_inconsistent_formats() {
        assert!(matches!(
            parse_pcm_wav(&wav(1, 44_100, 16, 1)),
            Err(WavRefusal::UnsupportedSampleRate(44_100))
        ));
        assert!(matches!(
            parse_pcm_wav(&wav(3, SAMPLE_RATE_HZ, 16, 1)),
            Err(WavRefusal::UnsupportedChannels(3))
        ));
        assert!(matches!(
            parse_pcm_wav(&wav(2, SAMPLE_RATE_HZ, 24, 1)),
            Err(WavRefusal::UnsupportedBitsPerSample(24))
        ));
        let mut inconsistent = wav(1, SAMPLE_RATE_HZ, 16, 1);
        inconsistent[28..32].copy_from_slice(&1_u32.to_le_bytes());
        assert!(matches!(
            parse_pcm_wav(&inconsistent),
            Err(WavRefusal::Invalid(_))
        ));
    }

    #[test]
    fn rejects_rf64_truncation_and_duplicate_data() {
        let mut rf64 = wav(1, SAMPLE_RATE_HZ, 16, 1);
        rf64[0..4].copy_from_slice(b"RF64");
        assert_eq!(parse_pcm_wav(&rf64), Err(WavRefusal::UnsupportedContainer));

        let mut truncated = wav(1, SAMPLE_RATE_HZ, 16, 1);
        truncated.pop();
        assert!(matches!(
            parse_pcm_wav(&truncated),
            Err(WavRefusal::Invalid(_))
        ));

        let mut duplicate = wav(1, SAMPLE_RATE_HZ, 16, 1);
        duplicate.extend_from_slice(b"data\0\0\0\0");
        let size = u32::try_from(duplicate.len() - 8).unwrap().to_le_bytes();
        duplicate[4..8].copy_from_slice(&size);
        assert!(matches!(
            parse_pcm_wav(&duplicate),
            Err(WavRefusal::Invalid(_))
        ));
    }

    #[test]
    fn trims_and_pads_to_exact_video_duration() {
        let short = parse_pcm_wav(&wav(2, SAMPLE_RATE_HZ, 16, 100)).unwrap();
        let padded = short
            .fit_to_video(30, 30, PcmTimelineTiming::default())
            .unwrap();
        assert_eq!(padded.sample_frames, 48_000);
        assert_eq!(padded.interleaved_s16_le.len(), 400);
        assert_eq!(padded.chunks().count(), 50);
        let last = padded.chunks().last().unwrap();
        assert!(last.bytes.iter().all(|byte| *byte == 0));

        let long = parse_pcm_wav(&wav(1, SAMPLE_RATE_HZ, 16, 2_000)).unwrap();
        let trimmed = long
            .fit_to_video(1, 60, PcmTimelineTiming::default())
            .unwrap();
        assert_eq!(trimmed.sample_frames, 800);
        assert_eq!(trimmed.interleaved_s16_le.len(), 1_600);
        let chunk = trimmed.chunks().next().unwrap();
        assert_eq!(chunk.sample_frames, 960);
        assert_eq!(chunk.bytes.len(), 1_920);
        assert!(chunk.bytes[1_600..].iter().all(|byte| *byte == 0));
    }

    #[test]
    fn places_one_trimmed_source_interval_on_the_video_timeline() {
        let source = parse_pcm_wav(&wav(1, SAMPLE_RATE_HZ, 16, 24_000)).unwrap();
        let prepared = source
            .fit_to_video(
                30,
                30,
                PcmTimelineTiming {
                    timeline_offset: 4_800,
                    trim_end: Some(14_400),
                    trim_start: 4_800,
                },
            )
            .unwrap();
        let chunks = prepared.chunks().collect::<Vec<_>>();
        assert!(
            chunks[..5]
                .iter()
                .all(|chunk| chunk.bytes.iter().all(|byte| *byte == 0))
        );
        assert_eq!(chunks[5].bytes[0], u8::try_from((4_800 * 2) % 251).unwrap());
        assert!(
            chunks[15..]
                .iter()
                .all(|chunk| chunk.bytes.iter().all(|byte| *byte == 0))
        );
    }

    #[test]
    fn rejects_an_empty_or_out_of_bounds_trim() {
        let source = parse_pcm_wav(&wav(1, SAMPLE_RATE_HZ, 16, 960)).unwrap();
        assert!(
            source
                .clone()
                .fit_to_video(
                    30,
                    30,
                    PcmTimelineTiming {
                        trim_end: Some(100),
                        trim_start: 100,
                        ..PcmTimelineTiming::default()
                    },
                )
                .is_err()
        );
        assert!(
            source
                .fit_to_video(
                    30,
                    30,
                    PcmTimelineTiming {
                        trim_end: Some(961),
                        ..PcmTimelineTiming::default()
                    },
                )
                .is_err()
        );
    }
}
