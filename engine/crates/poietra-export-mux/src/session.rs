use std::fmt;
use std::io::Write;
use std::num::{NonZeroU16, NonZeroU32};

use mp4_atom::{
    Any, AnySampleGroupEntry, Atom, Audio, Avc1, Avcc, Co64, Codec, Colr, Dinf, Dops, Dref, Edts,
    Elst, ElstEntry, Encode, FourCC, Ftyp, Hdlr, Header, Mdat, Mdhd, Mdia, Minf, Moov, Mvhd, Opus,
    Sbgp, SbgpEntry, Sgpd, SgpdEntry, Smhd, Stbl, Stco, Stsc, StscEntry, Stsd, Stss, Stsz,
    StszSamples, Stts, SttsEntry, Tkhd, Trak, Url, Visual, Vmhd,
};

use crate::ExportMuxErrorV1;

/// The 16-byte user type of the provenance `uuid` box.
///
/// ISO/IEC 14496-12 treats the user type as opaque 16 bytes, so an ASCII
/// label is chosen over an RFC 4122 UUID: `poietra-prov-v01` is immediately
/// recognizable in a hex dump, which is the point of a clearly-labeled
/// provenance box.
pub const PROVENANCE_UUID_V1: [u8; 16] = *b"poietra-prov-v01";

/// Upper bound for the opaque provenance payload, in bytes.
pub const MAX_PROVENANCE_BYTES_V1: usize = 64 * 1024;

/// Crate-wide cap on [`ExportMuxConfigV1::max_sample_count`].
///
/// This bounds the retained sample table regardless of configuration. The
/// cap of 2^20 samples covers more than 4.8 hours at 60 fps, far beyond the
/// v1 export limits.
pub const MAX_SAMPLE_TABLE_ENTRIES_V1: u32 = 1_048_576;

const MICROSECONDS_PER_SECOND: u128 = 1_000_000;

/// The fixed Opus clock used by `WebCodecs` and the MP4 Opus sample entry.
pub const OPUS_SAMPLE_RATE: u32 = 48_000;
pub(crate) const OPUS_PACKET_DURATION_SAMPLES: u32 = 960;
pub(crate) const OPUS_ROLL_DISTANCE: i16 = -4;
pub(crate) const ROLL_GROUPING_TYPE: FourCC = FourCC::new(b"roll");

/// Frame geometry and timing declared for the single video track.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoParametersV1 {
    /// Coded frame width in pixels.
    pub width_px: NonZeroU16,
    /// Coded frame height in pixels.
    pub height_px: NonZeroU16,
    /// Media timescale in ticks per second. Microsecond timestamps are
    /// quantized to this timescale with truncating division; `1_000_000`
    /// keeps them exact.
    pub timescale: NonZeroU32,
    /// Nominal frame rate. It is used only as the fallback duration of the
    /// final sample when that sample reports a `duration_us` of zero; every
    /// other duration is derived from consecutive timestamps.
    pub frames_per_second: NonZeroU32,
}

/// Measured color parameters written verbatim into a `colr` box of type
/// `nclx`, as numeric ISO/IEC 23091-2 code points.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColorParametersV1 {
    /// Colour primaries code point.
    pub primaries: u16,
    /// Transfer characteristics code point.
    pub transfer: u16,
    /// Matrix coefficients code point.
    pub matrix: u16,
    /// Full-range flag.
    pub full_range: bool,
}

/// Everything a mux session needs before the first sample arrives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportMuxConfigV1 {
    /// Raw `avcC` bytes, exactly as `WebCodecs` yields them in
    /// `EncodedVideoChunkMetadata.decoderConfig.description`.
    pub decoder_configuration: Vec<u8>,
    /// Frame geometry and timing.
    pub video: VideoParametersV1,
    /// Measured color parameters for the `colr` (`nclx`) box.
    pub color: ColorParametersV1,
    /// Opaque application provenance payload for the labeled `uuid` box,
    /// bounded by [`MAX_PROVENANCE_BYTES_V1`].
    pub provenance: Vec<u8>,
    /// Explicit bound on the number of samples this session accepts,
    /// capped by [`MAX_SAMPLE_TABLE_ENTRIES_V1`].
    pub max_sample_count: NonZeroU32,
}

/// One encoded video sample handed to the muxer.
///
/// The bytes must already be in the length-prefixed AVCC bitstream format
/// matching the session's decoder configuration (`WebCodecs` `avc` format).
#[derive(Debug, Clone, Copy)]
pub struct EncodedSampleV1<'a> {
    /// Encoded sample bytes. Written through to the sink, never retained.
    pub bytes: &'a [u8],
    /// Presentation timestamp in microseconds. Must be strictly increasing;
    /// the first sample's timestamp is treated as the presentation origin.
    pub timestamp_us: u64,
    /// Sample duration in microseconds. Only the final sample's value is
    /// used (earlier durations are derived from consecutive timestamps); a
    /// zero value falls back to the nominal `1 / frames_per_second`.
    pub duration_us: u64,
    /// Whether the sample is independently decodable (a sync sample).
    pub is_key: bool,
}

/// Decoder configuration for the optional Opus track.
///
/// This lane deliberately supports only the universally interoperable
/// mono/stereo, 48 kHz, mapping-family-zero profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpusParametersV1 {
    /// Output channel count. Must be one or two.
    pub channels: u8,
    /// Opus input clock. Must be exactly [`OPUS_SAMPLE_RATE`].
    pub sample_rate: u32,
    /// Decoder priming samples removed at presentation time.
    pub pre_skip: u16,
    /// Decoder output gain in Q7.8 dB, copied to `dOps`.
    pub output_gain: i16,
    /// Must be zero for the supported mono/stereo mapping.
    pub channel_mapping_family: u8,
}

/// One raw Opus packet handed to the optional audio track.
#[derive(Debug, Clone, Copy)]
pub struct EncodedAudioSampleV1<'a> {
    /// Raw Opus packet bytes, without Ogg framing.
    pub bytes: &'a [u8],
    /// Decoded packet duration at 48 kHz.
    pub duration_samples: NonZeroU32,
}

struct SampleRecord {
    offset: u64,
    size: u32,
    tick: u64,
    is_key: bool,
}

struct LastSample {
    timestamp_us: u64,
    duration_us: u64,
}

struct OpusState {
    parameters: OpusParametersV1,
    sample_entry: Opus,
    samples: Vec<AudioSampleRecord>,
    duration_samples: u64,
}

struct AudioSampleRecord {
    offset: u64,
    size: u32,
    duration_samples: u32,
}

/// A single-track progressive-MP4 mux session over a forward-only sink.
///
/// The session writes `ftyp` and the provenance `uuid` box on
/// [`begin`](Self::begin), one `mdat` box per appended sample, and the
/// trailing `moov` on [`finish`](Self::finish). See the crate documentation
/// for the layout decision and its alternatives.
pub struct ExportMuxSessionV1<W> {
    sink: W,
    timescale: u32,
    nominal_final_delta: u32,
    max_sample_count: u32,
    avc1: Avc1,
    position: u64,
    samples: Vec<SampleRecord>,
    last_sample: Option<LastSample>,
    opus: Option<OpusState>,
    audio_started: bool,
}

impl<W> fmt::Debug for ExportMuxSessionV1<W> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExportMuxSessionV1")
            .field("timescale", &self.timescale)
            .field("max_sample_count", &self.max_sample_count)
            .field("sample_count", &self.samples.len())
            .field(
                "audio_sample_count",
                &self.opus.as_ref().map_or(0, |opus| opus.samples.len()),
            )
            .field("position", &self.position)
            .finish_non_exhaustive()
    }
}

impl<W: Write> ExportMuxSessionV1<W> {
    /// Validates the configuration and writes the `ftyp` and provenance
    /// `uuid` boxes to the sink.
    ///
    /// # Errors
    ///
    /// Returns [`ExportMuxErrorV1::MalformedDecoderConfiguration`] when the
    /// `avcC` bytes do not parse, [`ExportMuxErrorV1::ProvenanceTooLarge`]
    /// or [`ExportMuxErrorV1::SampleBoundTooLarge`] when a bound is
    /// exceeded, and [`ExportMuxErrorV1::Io`] when the sink rejects a write.
    pub fn begin(config: ExportMuxConfigV1, sink: W) -> Result<Self, ExportMuxErrorV1> {
        Self::begin_inner(config, None, sink)
    }

    /// Starts a session with one AVC video track and one Opus audio track.
    ///
    /// Video samples must be appended first. Once
    /// [`append_audio_sample`](Self::append_audio_sample) is called, further
    /// video samples are rejected so the forward-only output remains grouped
    /// as video `mdat`s followed by audio `mdat`s.
    ///
    /// # Errors
    ///
    /// Returns a typed configuration, bound, container, or sink error.
    pub fn begin_with_opus(
        config: ExportMuxConfigV1,
        opus: OpusParametersV1,
        sink: W,
    ) -> Result<Self, ExportMuxErrorV1> {
        validate_opus_parameters(opus)?;
        Self::begin_inner(config, Some(opus), sink)
    }

    fn begin_inner(
        config: ExportMuxConfigV1,
        opus: Option<OpusParametersV1>,
        sink: W,
    ) -> Result<Self, ExportMuxErrorV1> {
        let ExportMuxConfigV1 {
            decoder_configuration,
            video,
            color,
            provenance,
            max_sample_count,
        } = config;
        if provenance.len() > MAX_PROVENANCE_BYTES_V1 {
            return Err(ExportMuxErrorV1::ProvenanceTooLarge {
                actual_bytes: provenance.len(),
            });
        }
        if max_sample_count.get() > MAX_SAMPLE_TABLE_ENTRIES_V1 {
            return Err(ExportMuxErrorV1::SampleBoundTooLarge {
                requested: max_sample_count.get(),
            });
        }

        let sample_entry = Avc1 {
            visual: Visual {
                data_reference_index: 1,
                width: video.width_px.get(),
                height: video.height_px.get(),
                ..Visual::default()
            },
            avcc: decode_avcc(&decoder_configuration)?,
            btrt: None,
            colr: Some(Colr::Nclx {
                colour_primaries: color.primaries,
                transfer_characteristics: color.transfer,
                matrix_coefficients: color.matrix,
                full_range_flag: color.full_range,
            }),
            pasp: None,
            taic: None,
            fiel: None,
        };

        let ftyp = Ftyp {
            major_brand: b"isom".into(),
            minor_version: 512,
            compatible_brands: vec![
                b"isom".into(),
                b"iso2".into(),
                b"avc1".into(),
                b"mp41".into(),
            ],
        };
        let mut uuid_body = Vec::with_capacity(PROVENANCE_UUID_V1.len() + provenance.len());
        uuid_body.extend_from_slice(&PROVENANCE_UUID_V1);
        uuid_body.extend(provenance);
        let provenance_atom = Any::Unknown(FourCC::new(b"uuid"), uuid_body);

        let capacity = usize::try_from(max_sample_count.get())
            .unwrap_or(usize::MAX)
            .min(4096);
        let mut session = Self {
            sink,
            timescale: video.timescale.get(),
            nominal_final_delta: nominal_delta(video.timescale, video.frames_per_second),
            max_sample_count: max_sample_count.get(),
            avc1: sample_entry,
            position: 0,
            samples: Vec::with_capacity(capacity),
            last_sample: None,
            opus: opus.map(|parameters| OpusState {
                parameters,
                sample_entry: opus_sample_entry(parameters),
                samples: Vec::with_capacity(capacity),
                duration_samples: 0,
            }),
            audio_started: false,
        };
        session.write_atom_bytes(&encode_atom(&ftyp)?)?;
        session.write_atom_bytes(&encode_atom(&provenance_atom)?)?;
        Ok(session)
    }

    /// Streams one encoded sample to the sink as its own `mdat` box and
    /// records its bounded sample-table entry.
    ///
    /// # Errors
    ///
    /// Returns [`ExportMuxErrorV1::SampleCountExceeded`] once the configured
    /// bound is reached, [`ExportMuxErrorV1::FirstSampleNotKey`] when the
    /// first sample is not a keyframe,
    /// [`ExportMuxErrorV1::NonMonotonicTimestamp`] or
    /// [`ExportMuxErrorV1::TimestampTickCollision`] for timestamp-order
    /// violations, [`ExportMuxErrorV1::EmptySample`] /
    /// [`ExportMuxErrorV1::SampleTooLarge`] /
    /// [`ExportMuxErrorV1::TimestampOverflow`] for unrepresentable samples,
    /// and [`ExportMuxErrorV1::Io`] when the sink rejects a write.
    pub fn append_sample(&mut self, sample: EncodedSampleV1<'_>) -> Result<(), ExportMuxErrorV1> {
        if self.audio_started {
            return Err(ExportMuxErrorV1::VideoSampleAfterAudio);
        }
        let count = u32::try_from(self.samples.len()).map_err(|_| {
            ExportMuxErrorV1::SampleCountExceeded {
                max_sample_count: self.max_sample_count,
            }
        })?;
        if count >= self.max_sample_count {
            return Err(ExportMuxErrorV1::SampleCountExceeded {
                max_sample_count: self.max_sample_count,
            });
        }
        if self.samples.is_empty() && !sample.is_key {
            return Err(ExportMuxErrorV1::FirstSampleNotKey);
        }
        if let Some(last) = &self.last_sample {
            if sample.timestamp_us <= last.timestamp_us {
                return Err(ExportMuxErrorV1::NonMonotonicTimestamp {
                    previous_us: last.timestamp_us,
                    current_us: sample.timestamp_us,
                });
            }
        }
        let tick = timestamp_ticks(sample.timestamp_us, self.timescale)?;
        if let (Some(last), Some(last_record)) = (&self.last_sample, self.samples.last()) {
            if tick <= last_record.tick {
                return Err(ExportMuxErrorV1::TimestampTickCollision {
                    previous_us: last.timestamp_us,
                    current_us: sample.timestamp_us,
                    timescale: self.timescale,
                });
            }
        }
        if sample.bytes.is_empty() {
            return Err(ExportMuxErrorV1::EmptySample);
        }
        let size =
            u32::try_from(sample.bytes.len()).map_err(|_| ExportMuxErrorV1::SampleTooLarge {
                actual_bytes: sample.bytes.len(),
            })?;

        let header = Header {
            kind: Mdat::KIND,
            size: Some(sample.bytes.len()),
        };
        let header_bytes = encode_atom(&header)?;
        let offset = self
            .position
            .checked_add(byte_len(&header_bytes)?)
            .ok_or(ExportMuxErrorV1::OutputPositionOverflow)?;

        self.write_atom_bytes(&header_bytes)?;
        self.sink.write_all(sample.bytes)?;
        self.position = offset
            .checked_add(u64::from(size))
            .ok_or(ExportMuxErrorV1::OutputPositionOverflow)?;

        self.samples.push(SampleRecord {
            offset,
            size,
            tick,
            is_key: sample.is_key,
        });
        self.last_sample = Some(LastSample {
            timestamp_us: sample.timestamp_us,
            duration_us: sample.duration_us,
        });
        Ok(())
    }

    /// Streams one raw Opus packet after the video samples.
    ///
    /// Packet durations are expressed directly in the fixed 48 kHz Opus
    /// clock. Samples are contiguous; this deliberately does not introduce a
    /// second timestamp or gap model.
    ///
    /// # Errors
    ///
    /// Returns a typed state, bound, sample, overflow, container, or sink
    /// error.
    pub fn append_audio_sample(
        &mut self,
        sample: EncodedAudioSampleV1<'_>,
    ) -> Result<(), ExportMuxErrorV1> {
        let Some(opus) = self.opus.as_ref() else {
            return Err(ExportMuxErrorV1::AudioNotConfigured);
        };
        if self.samples.is_empty() {
            return Err(ExportMuxErrorV1::NoSamples);
        }
        let count = u32::try_from(opus.samples.len()).unwrap_or(u32::MAX);
        if count >= self.max_sample_count {
            return Err(ExportMuxErrorV1::SampleCountExceeded {
                max_sample_count: self.max_sample_count,
            });
        }
        if sample.bytes.is_empty() {
            return Err(ExportMuxErrorV1::EmptySample);
        }
        let size =
            u32::try_from(sample.bytes.len()).map_err(|_| ExportMuxErrorV1::SampleTooLarge {
                actual_bytes: sample.bytes.len(),
            })?;
        let duration_samples = sample.duration_samples.get();
        if duration_samples != OPUS_PACKET_DURATION_SAMPLES {
            return Err(ExportMuxErrorV1::UnsupportedOpusConfiguration {
                detail: format!(
                    "packet duration {duration_samples} is not the required 20 ms / {OPUS_PACKET_DURATION_SAMPLES} samples"
                ),
            });
        }
        let next_duration = opus
            .duration_samples
            .checked_add(u64::from(duration_samples))
            .ok_or(ExportMuxErrorV1::AudioDurationOverflow)?;

        let header = Header {
            kind: Mdat::KIND,
            size: Some(sample.bytes.len()),
        };
        let header_bytes = encode_atom(&header)?;
        let offset = self
            .position
            .checked_add(byte_len(&header_bytes)?)
            .ok_or(ExportMuxErrorV1::OutputPositionOverflow)?;

        self.audio_started = true;
        self.write_atom_bytes(&header_bytes)?;
        self.sink.write_all(sample.bytes)?;
        self.position = offset
            .checked_add(u64::from(size))
            .ok_or(ExportMuxErrorV1::OutputPositionOverflow)?;
        let Some(opus) = self.opus.as_mut() else {
            return Err(ExportMuxErrorV1::AudioNotConfigured);
        };
        opus.samples.push(AudioSampleRecord {
            offset,
            size,
            duration_samples,
        });
        opus.duration_samples = next_duration;
        Ok(())
    }

    /// Writes the trailing `moov` box, flushes the sink, and returns it.
    ///
    /// # Errors
    ///
    /// Returns [`ExportMuxErrorV1::NoSamples`] when no sample was appended,
    /// [`ExportMuxErrorV1::DurationOverflow`] or
    /// [`ExportMuxErrorV1::TimestampOverflow`] when a derived duration is
    /// unrepresentable, [`ExportMuxErrorV1::ContainerEncoding`] when the
    /// metadata cannot be encoded, and [`ExportMuxErrorV1::Io`] when the
    /// sink rejects a write.
    pub fn finish(mut self) -> Result<W, ExportMuxErrorV1> {
        let last = self.last_sample.take().ok_or(ExportMuxErrorV1::NoSamples)?;
        let final_delta = self.final_sample_delta(&last)?;

        let mut stts_entries: Vec<SttsEntry> = Vec::new();
        let mut duration_ticks: u64 = 0;
        for (current, next) in self.samples.iter().zip(self.samples.iter().skip(1)) {
            let delta_ticks = next.tick - current.tick;
            let delta = u32::try_from(delta_ticks)
                .map_err(|_| ExportMuxErrorV1::DurationOverflow { ticks: delta_ticks })?;
            duration_ticks += u64::from(delta);
            push_stts_delta(&mut stts_entries, delta);
        }
        duration_ticks += u64::from(final_delta);
        push_stts_delta(&mut stts_entries, final_delta);

        let mut sync_sample_indices: Vec<u32> = Vec::new();
        let mut index: u32 = 0;
        for record in &self.samples {
            index += 1;
            if record.is_key {
                sync_sample_indices.push(index);
            }
        }

        let sizes: Vec<u32> = self.samples.iter().map(|record| record.size).collect();
        let offsets: Vec<u64> = self.samples.iter().map(|record| record.offset).collect();
        let width = self.avc1.visual.width;
        let height = self.avc1.visual.height;
        let stbl = sample_table(
            Codec::Avc1(self.avc1),
            sizes,
            offsets,
            stts_entries,
            Some(Stss {
                entries: sync_sample_indices,
            }),
        );
        let audio_track = match self.opus.take() {
            Some(opus) if opus.samples.is_empty() => {
                return Err(ExportMuxErrorV1::NoAudioSamples);
            }
            Some(opus) => Some(build_opus_track(opus, self.timescale, duration_ticks)?),
            None => None,
        };
        let moov_bytes = encode_atom(&build_moov(
            self.timescale,
            duration_ticks,
            width,
            height,
            stbl,
            audio_track,
        ))?;
        self.sink.write_all(&moov_bytes)?;
        self.sink.flush()?;
        Ok(self.sink)
    }

    fn final_sample_delta(&self, last: &LastSample) -> Result<u32, ExportMuxErrorV1> {
        let last_record = self.samples.last().ok_or(ExportMuxErrorV1::NoSamples)?;
        if last.duration_us == 0 {
            return Ok(self.nominal_final_delta);
        }
        let end_us = last.timestamp_us.checked_add(last.duration_us).ok_or(
            ExportMuxErrorV1::TimestampOverflow {
                timestamp_us: last.timestamp_us,
            },
        )?;
        let end_tick = timestamp_ticks(end_us, self.timescale)?;
        // A final sample always contributes at least one tick, even when its
        // microsecond duration quantizes below the media timescale.
        let delta_ticks = end_tick.saturating_sub(last_record.tick).max(1);
        u32::try_from(delta_ticks)
            .map_err(|_| ExportMuxErrorV1::DurationOverflow { ticks: delta_ticks })
    }

    fn write_atom_bytes(&mut self, bytes: &[u8]) -> Result<(), ExportMuxErrorV1> {
        self.sink.write_all(bytes)?;
        self.position = self
            .position
            .checked_add(byte_len(bytes)?)
            .ok_or(ExportMuxErrorV1::OutputPositionOverflow)?;
        Ok(())
    }
}

fn build_moov(
    timescale: u32,
    duration_ticks: u64,
    width: u16,
    height: u16,
    stbl: Stbl,
    audio_track: Option<Trak>,
) -> Moov {
    let mut moov = Moov {
        mvhd: Mvhd {
            timescale,
            duration: duration_ticks,
            rate: 1u16.into(),
            volume: 1u8.into(),
            next_track_id: 2,
            ..Mvhd::default()
        },
        trak: vec![Trak {
            tkhd: Tkhd {
                track_id: 1,
                duration: duration_ticks,
                enabled: true,
                in_movie: true,
                width: width.into(),
                height: height.into(),
                ..Tkhd::default()
            },
            mdia: Mdia {
                mdhd: Mdhd {
                    timescale,
                    duration: duration_ticks,
                    language: "und".into(),
                    ..Mdhd::default()
                },
                hdlr: Hdlr {
                    handler: b"vide".into(),
                    name: "Poietra Export Video".into(),
                },
                minf: Minf {
                    vmhd: Some(Vmhd::default()),
                    dinf: Dinf {
                        dref: Dref {
                            urls: vec![Url::default()],
                        },
                    },
                    stbl,
                    ..Minf::default()
                },
            },
            ..Trak::default()
        }],
        ..Moov::default()
    };
    if let Some(audio_track) = audio_track {
        moov.mvhd.next_track_id = 3;
        moov.trak.push(audio_track);
    }
    moov
}

fn validate_opus_parameters(opus: OpusParametersV1) -> Result<(), ExportMuxErrorV1> {
    if !matches!(opus.channels, 1 | 2) {
        return Err(ExportMuxErrorV1::UnsupportedOpusConfiguration {
            detail: format!("channel count {} is not mono or stereo", opus.channels),
        });
    }
    if opus.sample_rate != OPUS_SAMPLE_RATE {
        return Err(ExportMuxErrorV1::UnsupportedOpusConfiguration {
            detail: format!(
                "sample rate {} Hz is not the required {OPUS_SAMPLE_RATE} Hz",
                opus.sample_rate
            ),
        });
    }
    if opus.channel_mapping_family != 0 {
        return Err(ExportMuxErrorV1::UnsupportedOpusConfiguration {
            detail: "only channel mapping family 0 is supported".to_owned(),
        });
    }
    Ok(())
}

fn opus_sample_entry(parameters: OpusParametersV1) -> Opus {
    Opus {
        audio: Audio {
            data_reference_index: 1,
            channel_count: u16::from(parameters.channels),
            sample_size: 16,
            sample_rate: 48_000u16.into(),
        },
        dops: Dops {
            output_channel_count: parameters.channels,
            pre_skip: parameters.pre_skip,
            input_sample_rate: parameters.sample_rate,
            output_gain: parameters.output_gain,
        },
        btrt: None,
    }
}

fn build_opus_track(
    opus: OpusState,
    movie_timescale: u32,
    movie_duration: u64,
) -> Result<Trak, ExportMuxErrorV1> {
    let audible_samples = scale_ceil(movie_duration, movie_timescale, OPUS_SAMPLE_RATE)?;
    let required_samples = audible_samples
        .checked_add(u64::from(opus.parameters.pre_skip))
        .ok_or(ExportMuxErrorV1::AudioDurationOverflow)?;
    if opus.duration_samples < required_samples {
        return Err(ExportMuxErrorV1::AudioTooShort {
            available_samples: opus.duration_samples,
            required_samples,
        });
    }

    let stts_entries = opus.samples.iter().fold(Vec::new(), |mut entries, sample| {
        push_stts_delta(&mut entries, sample.duration_samples);
        entries
    });
    let mut stbl = sample_table(
        Codec::Opus(opus.sample_entry),
        opus.samples
            .iter()
            .map(|sample| sample.size)
            .collect::<Vec<_>>(),
        opus.samples
            .iter()
            .map(|sample| sample.offset)
            .collect::<Vec<_>>(),
        stts_entries,
        None,
    );
    let sample_count =
        u32::try_from(opus.samples.len()).map_err(|_| ExportMuxErrorV1::AudioDurationOverflow)?;
    stbl.sgpd = vec![Sgpd {
        grouping_type: ROLL_GROUPING_TYPE,
        default_length: Some(2),
        default_group_description_index: None,
        static_group_description: false,
        static_mapping: false,
        essential: false,
        entries: vec![SgpdEntry {
            description_length: Some(2),
            entry: AnySampleGroupEntry::UnknownGroupingType(
                ROLL_GROUPING_TYPE,
                OPUS_ROLL_DISTANCE.to_be_bytes().to_vec(),
            ),
        }],
    }];
    stbl.sbgp = vec![Sbgp {
        grouping_type: ROLL_GROUPING_TYPE,
        grouping_type_parameter: None,
        entries: vec![SbgpEntry {
            sample_count,
            group_description_index: 1,
        }],
    }];
    Ok(Trak {
        tkhd: Tkhd {
            track_id: 2,
            duration: movie_duration,
            enabled: true,
            in_movie: true,
            volume: 1u8.into(),
            ..Tkhd::default()
        },
        edts: Some(Edts {
            elst: Some(Elst {
                entries: vec![ElstEntry {
                    segment_duration: movie_duration,
                    media_time: Some(u64::from(opus.parameters.pre_skip)),
                    media_rate: 1i16.into(),
                }],
            }),
        }),
        mdia: Mdia {
            mdhd: Mdhd {
                timescale: OPUS_SAMPLE_RATE,
                duration: opus.duration_samples,
                language: "und".into(),
                ..Mdhd::default()
            },
            hdlr: Hdlr {
                handler: b"soun".into(),
                name: "Poietra Export Audio".into(),
            },
            minf: Minf {
                smhd: Some(Smhd::default()),
                dinf: Dinf {
                    dref: Dref {
                        urls: vec![Url::default()],
                    },
                },
                stbl,
                ..Minf::default()
            },
        },
        ..Trak::default()
    })
}

fn sample_table(
    codec: Codec,
    sizes: Vec<u32>,
    offsets: Vec<u64>,
    stts_entries: Vec<SttsEntry>,
    stss: Option<Stss>,
) -> Stbl {
    let (stco, co64) = match offsets
        .iter()
        .copied()
        .map(u32::try_from)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(entries) => (Some(Stco { entries }), None),
        Err(_) => (None, Some(Co64 { entries: offsets })),
    };
    Stbl {
        stsd: Stsd {
            codecs: vec![codec],
        },
        stts: Stts {
            entries: stts_entries,
        },
        stss,
        stsc: Stsc {
            entries: vec![StscEntry {
                first_chunk: 1,
                samples_per_chunk: 1,
                sample_description_index: 1,
            }],
        },
        stsz: Stsz {
            samples: StszSamples::Different { sizes },
        },
        stco,
        co64,
        ..Stbl::default()
    }
}

fn scale_ceil(value: u64, from: u32, to: u32) -> Result<u64, ExportMuxErrorV1> {
    let numerator = u128::from(value) * u128::from(to);
    let scaled = numerator.div_ceil(u128::from(from));
    u64::try_from(scaled).map_err(|_| ExportMuxErrorV1::AudioDurationOverflow)
}

fn byte_len(bytes: &[u8]) -> Result<u64, ExportMuxErrorV1> {
    u64::try_from(bytes.len()).map_err(|_| ExportMuxErrorV1::OutputPositionOverflow)
}

fn nominal_delta(timescale: NonZeroU32, frames_per_second: NonZeroU32) -> u32 {
    let timescale = u64::from(timescale.get());
    let fps = u64::from(frames_per_second.get());
    let delta = (timescale + fps / 2) / fps;
    u32::try_from(delta.max(1)).unwrap_or(u32::MAX)
}

fn timestamp_ticks(timestamp_us: u64, timescale: u32) -> Result<u64, ExportMuxErrorV1> {
    let ticks = u128::from(timestamp_us) * u128::from(timescale) / MICROSECONDS_PER_SECOND;
    u64::try_from(ticks).map_err(|_| ExportMuxErrorV1::TimestampOverflow { timestamp_us })
}

fn push_stts_delta(entries: &mut Vec<SttsEntry>, delta: u32) {
    if let Some(last) = entries.last_mut() {
        if last.sample_delta == delta {
            last.sample_count += 1;
            return;
        }
    }
    entries.push(SttsEntry {
        sample_count: 1,
        sample_delta: delta,
    });
}

fn decode_avcc(description: &[u8]) -> Result<Avcc, ExportMuxErrorV1> {
    let mut remaining: &[u8] = description;
    let avcc = Avcc::decode_body(&mut remaining).map_err(|error| {
        ExportMuxErrorV1::MalformedDecoderConfiguration {
            detail: error.to_string(),
        }
    })?;
    if !remaining.is_empty() {
        return Err(ExportMuxErrorV1::MalformedDecoderConfiguration {
            detail: format!(
                "{} trailing bytes after the configuration record",
                remaining.len()
            ),
        });
    }
    Ok(avcc)
}

fn encode_atom<T: Encode>(atom: &T) -> Result<Vec<u8>, ExportMuxErrorV1> {
    let mut buf = Vec::new();
    atom.encode(&mut buf)
        .map_err(|error| ExportMuxErrorV1::ContainerEncoding {
            detail: error.to_string(),
        })?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp4_atom::DecodeMaybe;

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

    /// The raw `avcC` body bytes, as `WebCodecs` would report them in
    /// `decoderConfig.description` (box payload without the 8-byte header).
    fn synthetic_description() -> Vec<u8> {
        let mut encoded = Vec::new();
        synthetic_avcc().encode(&mut encoded).unwrap();
        encoded[8..].to_vec()
    }

    fn config(max_sample_count: u32) -> ExportMuxConfigV1 {
        ExportMuxConfigV1 {
            decoder_configuration: synthetic_description(),
            video: VideoParametersV1 {
                width_px: NonZeroU16::new(854).unwrap(),
                height_px: NonZeroU16::new(480).unwrap(),
                timescale: NonZeroU32::new(1_000_000).unwrap(),
                frames_per_second: NonZeroU32::new(30).unwrap(),
            },
            color: ColorParametersV1 {
                primaries: 1,
                transfer: 13,
                matrix: 1,
                full_range: false,
            },
            provenance: b"scene-revision=0123abcd;engine=0.1.0".to_vec(),
            max_sample_count: NonZeroU32::new(max_sample_count).unwrap(),
        }
    }

    fn sample(
        bytes: &[u8],
        timestamp_us: u64,
        duration_us: u64,
        is_key: bool,
    ) -> EncodedSampleV1<'_> {
        EncodedSampleV1 {
            bytes,
            timestamp_us,
            duration_us,
            is_key,
        }
    }

    fn decode_all(output: &[u8]) -> Vec<Any> {
        let mut buf: &[u8] = output;
        let mut atoms = Vec::new();
        while let Some(atom) = Any::decode_maybe(&mut buf).unwrap() {
            atoms.push(atom);
        }
        assert!(buf.is_empty(), "no trailing garbage after the last atom");
        atoms
    }

    fn mux_three_samples() -> (Vec<u8>, [Vec<u8>; 3]) {
        let payloads = [vec![0x11; 120], vec![0x22; 90], vec![0x33; 150]];
        let mut session = ExportMuxSessionV1::begin(config(16), Vec::new()).unwrap();
        session
            .append_sample(sample(&payloads[0], 0, 33_333, true))
            .unwrap();
        session
            .append_sample(sample(&payloads[1], 33_333, 33_334, false))
            .unwrap();
        session
            .append_sample(sample(&payloads[2], 66_667, 33_333, true))
            .unwrap();
        (session.finish().unwrap(), payloads)
    }

    fn opus_parameters(channels: u8) -> OpusParametersV1 {
        OpusParametersV1 {
            channels,
            sample_rate: OPUS_SAMPLE_RATE,
            pre_skip: 312,
            output_gain: -12,
            channel_mapping_family: 0,
        }
    }

    fn mux_three_samples_with_opus(channels: u8) -> Vec<u8> {
        let payloads = [vec![0x11; 120], vec![0x22; 90], vec![0x33; 150]];
        let mut session =
            ExportMuxSessionV1::begin_with_opus(config(16), opus_parameters(channels), Vec::new())
                .unwrap();
        session
            .append_sample(sample(&payloads[0], 0, 33_333, true))
            .unwrap();
        session
            .append_sample(sample(&payloads[1], 33_333, 33_334, false))
            .unwrap();
        session
            .append_sample(sample(&payloads[2], 66_667, 33_333, true))
            .unwrap();
        for byte in 0x48..0x4e {
            session
                .append_audio_sample(EncodedAudioSampleV1 {
                    bytes: &[byte; 12],
                    duration_samples: NonZeroU32::new(960).unwrap(),
                })
                .unwrap();
        }
        session.finish().unwrap()
    }

    #[test]
    fn muxes_the_documented_top_level_layout() {
        let (output, payloads) = mux_three_samples();
        let atoms = decode_all(&output);
        assert_eq!(atoms.len(), 6, "ftyp, uuid, three mdat boxes, moov");

        let Any::Ftyp(ftyp) = &atoms[0] else {
            panic!("the first atom must be ftyp, got {:?}", atoms[0].kind());
        };
        assert_eq!(ftyp.major_brand, b"isom".into());
        assert!(ftyp.compatible_brands.contains(&b"avc1".into()));

        let Any::Unknown(kind, body) = &atoms[1] else {
            panic!(
                "the second atom must be the uuid box, got {:?}",
                atoms[1].kind()
            );
        };
        assert_eq!(*kind, FourCC::new(b"uuid"));
        assert_eq!(&body[..16], PROVENANCE_UUID_V1.as_slice());
        assert_eq!(&body[16..], b"scene-revision=0123abcd;engine=0.1.0");

        for (atom, payload) in atoms[2..5].iter().zip(&payloads) {
            let Any::Mdat(mdat) = atom else {
                panic!("expected an mdat box, got {:?}", atom.kind());
            };
            assert_eq!(&mdat.data, payload);
        }
        assert!(
            matches!(&atoms[5], Any::Moov(_)),
            "moov is the final atom (mdat-first layout decision)"
        );
    }

    #[test]
    fn moov_reparses_with_expected_track_and_codec_structure() {
        let (output, _) = mux_three_samples();
        let atoms = decode_all(&output);
        let Some(Any::Moov(moov)) = atoms.last() else {
            panic!("missing moov");
        };

        assert_eq!(moov.mvhd.timescale, 1_000_000);
        assert_eq!(moov.mvhd.duration, 100_000);
        assert_eq!(moov.mvhd.next_track_id, 2);
        assert_eq!(moov.trak.len(), 1);

        let trak = &moov.trak[0];
        assert_eq!(trak.tkhd.track_id, 1);
        assert!(trak.tkhd.enabled);
        assert_eq!(trak.tkhd.duration, 100_000);
        assert_eq!(trak.tkhd.width.integer(), 854);
        assert_eq!(trak.tkhd.height.integer(), 480);
        assert_eq!(trak.mdia.mdhd.timescale, 1_000_000);
        assert_eq!(trak.mdia.mdhd.duration, 100_000);
        assert_eq!(trak.mdia.hdlr.handler, b"vide".into());
        assert!(trak.mdia.minf.vmhd.is_some());

        let stbl = &trak.mdia.minf.stbl;
        assert_eq!(stbl.stsd.codecs.len(), 1);
        let Codec::Avc1(avc1) = &stbl.stsd.codecs[0] else {
            panic!("the sample entry must be avc1");
        };
        assert_eq!(avc1.visual.data_reference_index, 1);
        assert_eq!(avc1.visual.width, 854);
        assert_eq!(avc1.visual.height, 480);
        assert_eq!(avc1.avcc, synthetic_avcc());
        assert_eq!(
            avc1.colr,
            Some(Colr::Nclx {
                colour_primaries: 1,
                transfer_characteristics: 13,
                matrix_coefficients: 1,
                full_range_flag: false,
            })
        );
    }

    #[test]
    fn muxes_mono_and_stereo_opus_after_video_with_priming_and_end_trim() {
        for channels in [1, 2] {
            let output = mux_three_samples_with_opus(channels);
            let atoms = decode_all(&output);
            assert_eq!(atoms.len(), 12, "ftyp, uuid, 3 video, 6 audio, moov");
            let Some(Any::Moov(moov)) = atoms.last() else {
                panic!("missing moov");
            };
            assert_eq!(moov.mvhd.duration, 100_000);
            assert_eq!(moov.mvhd.next_track_id, 3);
            assert_eq!(moov.trak.len(), 2);

            let audio = &moov.trak[1];
            assert_eq!(audio.tkhd.track_id, 2);
            assert_eq!(audio.tkhd.duration, 100_000);
            assert_eq!(audio.mdia.mdhd.timescale, OPUS_SAMPLE_RATE);
            assert_eq!(audio.mdia.mdhd.duration, 5_760);
            assert_eq!(audio.mdia.hdlr.handler, b"soun".into());
            assert!(audio.mdia.minf.smhd.is_some());
            let edits = &audio.edts.as_ref().unwrap().elst.as_ref().unwrap().entries;
            assert_eq!(edits.len(), 1);
            assert_eq!(edits[0].segment_duration, 100_000);
            assert_eq!(edits[0].media_time, Some(312));
            let Codec::Opus(opus) = &audio.mdia.minf.stbl.stsd.codecs[0] else {
                panic!("audio sample entry must be Opus");
            };
            assert_eq!(opus.audio.channel_count, u16::from(channels));
            assert_eq!(opus.audio.sample_rate.integer(), 48_000);
            assert_eq!(opus.dops.output_channel_count, channels);
            assert_eq!(opus.dops.pre_skip, 312);
            assert_eq!(opus.dops.output_gain, -12);
            assert_eq!(audio.mdia.minf.stbl.stts.entries[0].sample_count, 6);
            assert_eq!(audio.mdia.minf.stbl.stts.entries[0].sample_delta, 960);
            assert_eq!(
                audio.mdia.minf.stbl.sgpd,
                vec![Sgpd {
                    grouping_type: ROLL_GROUPING_TYPE,
                    default_length: Some(2),
                    default_group_description_index: None,
                    static_group_description: false,
                    static_mapping: false,
                    essential: false,
                    entries: vec![SgpdEntry {
                        description_length: Some(2),
                        entry: AnySampleGroupEntry::UnknownGroupingType(
                            ROLL_GROUPING_TYPE,
                            OPUS_ROLL_DISTANCE.to_be_bytes().to_vec(),
                        ),
                    }],
                }]
            );
            assert_eq!(
                audio.mdia.minf.stbl.sbgp,
                vec![Sbgp {
                    grouping_type: ROLL_GROUPING_TYPE,
                    grouping_type_parameter: None,
                    entries: vec![SbgpEntry {
                        sample_count: 6,
                        group_description_index: 1,
                    }],
                }]
            );
        }
    }

    #[test]
    fn opus_enabled_session_requires_audio_and_enough_duration() {
        let mut no_audio =
            ExportMuxSessionV1::begin_with_opus(config(16), opus_parameters(1), Vec::new())
                .unwrap();
        no_audio
            .append_sample(sample(&[1], 0, 100_000, true))
            .unwrap();
        assert!(matches!(
            no_audio.finish(),
            Err(ExportMuxErrorV1::NoAudioSamples)
        ));

        let mut short_audio =
            ExportMuxSessionV1::begin_with_opus(config(16), opus_parameters(1), Vec::new())
                .unwrap();
        short_audio
            .append_sample(sample(&[1], 0, 100_000, true))
            .unwrap();
        for byte in 0x48..0x4d {
            short_audio
                .append_audio_sample(EncodedAudioSampleV1 {
                    bytes: &[byte],
                    duration_samples: NonZeroU32::new(960).unwrap(),
                })
                .unwrap();
        }
        assert!(matches!(
            short_audio.finish(),
            Err(ExportMuxErrorV1::AudioTooShort {
                available_samples: 4_800,
                required_samples: 5_112,
            })
        ));
    }

    #[test]
    fn opus_layout_rejects_video_after_audio_and_invalid_configuration() {
        for invalid in [
            OpusParametersV1 {
                channels: 3,
                ..opus_parameters(1)
            },
            OpusParametersV1 {
                sample_rate: 44_100,
                ..opus_parameters(1)
            },
            OpusParametersV1 {
                channel_mapping_family: 1,
                ..opus_parameters(1)
            },
        ] {
            assert!(matches!(
                ExportMuxSessionV1::begin_with_opus(config(16), invalid, Vec::new()),
                Err(ExportMuxErrorV1::UnsupportedOpusConfiguration { .. })
            ));
        }

        let mut session =
            ExportMuxSessionV1::begin_with_opus(config(16), opus_parameters(2), Vec::new())
                .unwrap();
        assert!(matches!(
            session.append_audio_sample(EncodedAudioSampleV1 {
                bytes: &[0x48],
                duration_samples: NonZeroU32::new(5_760).unwrap(),
            }),
            Err(ExportMuxErrorV1::NoSamples)
        ));
        session
            .append_sample(sample(&[1], 0, 100_000, true))
            .unwrap();
        assert!(matches!(
            session.append_audio_sample(EncodedAudioSampleV1 {
                bytes: &[0x48],
                duration_samples: NonZeroU32::new(1_920).unwrap(),
            }),
            Err(ExportMuxErrorV1::UnsupportedOpusConfiguration { .. })
        ));
        session
            .append_audio_sample(EncodedAudioSampleV1 {
                bytes: &[0x48],
                duration_samples: NonZeroU32::new(960).unwrap(),
            })
            .unwrap();
        assert!(matches!(
            session.append_sample(sample(&[2], 100_000, 100_000, false)),
            Err(ExportMuxErrorV1::VideoSampleAfterAudio)
        ));
    }

    #[test]
    fn sample_tables_record_durations_sizes_offsets_and_sync_samples() {
        let (output, payloads) = mux_three_samples();
        let atoms = decode_all(&output);
        let Some(Any::Moov(moov)) = atoms.last() else {
            panic!("missing moov");
        };
        let stbl = &moov.trak[0].mdia.minf.stbl;

        assert_eq!(
            stbl.stts.entries,
            vec![
                SttsEntry {
                    sample_count: 1,
                    sample_delta: 33_333,
                },
                SttsEntry {
                    sample_count: 1,
                    sample_delta: 33_334,
                },
                SttsEntry {
                    sample_count: 1,
                    sample_delta: 33_333,
                },
            ]
        );
        assert_eq!(
            stbl.stsz.samples,
            StszSamples::Different {
                sizes: vec![120, 90, 150],
            }
        );
        assert_eq!(
            stbl.stsc.entries,
            vec![StscEntry {
                first_chunk: 1,
                samples_per_chunk: 1,
                sample_description_index: 1,
            }]
        );
        assert_eq!(
            stbl.stss.as_ref().map(|stss| stss.entries.clone()),
            Some(vec![1, 3]),
            "sync-sample table lists the two keyframes, one-based"
        );

        let stco = stbl.stco.as_ref().expect("offsets fit the 32-bit table");
        assert!(stbl.co64.is_none());
        assert_eq!(stco.entries.len(), 3);
        for (offset, payload) in stco.entries.iter().zip(&payloads) {
            let start = usize::try_from(*offset).unwrap();
            assert_eq!(
                &output[start..start + payload.len()],
                payload.as_slice(),
                "each chunk offset points at the exact sample bytes"
            );
        }
    }

    #[test]
    fn final_sample_with_zero_duration_falls_back_to_nominal_fps_delta() {
        let payload = vec![0x44; 64];
        let mut session = ExportMuxSessionV1::begin(config(16), Vec::new()).unwrap();
        session
            .append_sample(sample(&payload, 0, 33_333, true))
            .unwrap();
        session
            .append_sample(sample(&payload, 33_333, 0, false))
            .unwrap();
        let output = session.finish().unwrap();

        let atoms = decode_all(&output);
        let Some(Any::Moov(moov)) = atoms.last() else {
            panic!("missing moov");
        };
        let stbl = &moov.trak[0].mdia.minf.stbl;
        assert_eq!(
            stbl.stts.entries,
            vec![SttsEntry {
                sample_count: 2,
                sample_delta: 33_333,
            }],
            "equal deltas are run-length merged; the nominal 1/30 s closes the movie"
        );
        assert_eq!(moov.mvhd.duration, 66_666);
    }

    #[test]
    fn rejects_a_non_keyframe_first_sample() {
        let mut session = ExportMuxSessionV1::begin(config(16), Vec::new()).unwrap();
        let error = session
            .append_sample(sample(&[0x55; 10], 0, 33_333, false))
            .unwrap_err();
        assert!(matches!(error, ExportMuxErrorV1::FirstSampleNotKey));
    }

    #[test]
    fn rejects_non_monotonic_timestamps() {
        let mut session = ExportMuxSessionV1::begin(config(16), Vec::new()).unwrap();
        session
            .append_sample(sample(&[0x55; 10], 40_000, 33_333, true))
            .unwrap();
        let equal = session
            .append_sample(sample(&[0x55; 10], 40_000, 33_333, false))
            .unwrap_err();
        assert!(matches!(
            equal,
            ExportMuxErrorV1::NonMonotonicTimestamp {
                previous_us: 40_000,
                current_us: 40_000,
            }
        ));
        let decreasing = session
            .append_sample(sample(&[0x55; 10], 39_999, 33_333, false))
            .unwrap_err();
        assert!(matches!(
            decreasing,
            ExportMuxErrorV1::NonMonotonicTimestamp {
                previous_us: 40_000,
                current_us: 39_999,
            }
        ));
    }

    #[test]
    fn rejects_timestamps_that_collide_on_a_coarse_timescale() {
        let mut coarse = config(16);
        coarse.video.timescale = NonZeroU32::new(1_000).unwrap();
        let mut session = ExportMuxSessionV1::begin(coarse, Vec::new()).unwrap();
        session
            .append_sample(sample(&[0x55; 10], 100, 33_333, true))
            .unwrap();
        let error = session
            .append_sample(sample(&[0x55; 10], 900, 33_333, false))
            .unwrap_err();
        assert!(matches!(
            error,
            ExportMuxErrorV1::TimestampTickCollision {
                previous_us: 100,
                current_us: 900,
                timescale: 1_000,
            }
        ));
    }

    #[test]
    fn rejects_samples_beyond_the_configured_bound() {
        let mut session = ExportMuxSessionV1::begin(config(2), Vec::new()).unwrap();
        session
            .append_sample(sample(&[0x55; 10], 0, 33_333, true))
            .unwrap();
        session
            .append_sample(sample(&[0x55; 10], 33_333, 33_333, false))
            .unwrap();
        let error = session
            .append_sample(sample(&[0x55; 10], 66_667, 33_333, false))
            .unwrap_err();
        assert!(matches!(
            error,
            ExportMuxErrorV1::SampleCountExceeded {
                max_sample_count: 2,
            }
        ));
    }

    #[test]
    fn rejects_an_empty_sample() {
        let mut session = ExportMuxSessionV1::begin(config(16), Vec::new()).unwrap();
        let error = session
            .append_sample(sample(&[], 0, 33_333, true))
            .unwrap_err();
        assert!(matches!(error, ExportMuxErrorV1::EmptySample));
    }

    #[test]
    fn rejects_finishing_an_empty_session() {
        let session = ExportMuxSessionV1::begin(config(16), Vec::new()).unwrap();
        let error = session.finish().unwrap_err();
        assert!(matches!(error, ExportMuxErrorV1::NoSamples));
    }

    #[test]
    fn rejects_a_malformed_decoder_configuration() {
        let mut broken = config(16);
        broken.decoder_configuration = vec![0x01, 0x64, 0x00];
        let error = ExportMuxSessionV1::begin(broken, Vec::new()).unwrap_err();
        assert!(matches!(
            error,
            ExportMuxErrorV1::MalformedDecoderConfiguration { .. }
        ));
    }

    #[test]
    fn rejects_a_decoder_configuration_with_trailing_bytes() {
        let mut padded = config(16);
        padded.decoder_configuration = synthetic_description();
        // A fake ext section (4 zero bytes) parses, so append garbage that
        // survives as unconsumed trailing bytes.
        padded
            .decoder_configuration
            .extend_from_slice(&[0, 0, 0, 0, 0xAB]);
        let error = ExportMuxSessionV1::begin(padded, Vec::new()).unwrap_err();
        assert!(matches!(
            error,
            ExportMuxErrorV1::MalformedDecoderConfiguration { .. }
        ));
    }

    #[test]
    fn rejects_an_oversized_provenance_payload() {
        let mut oversized = config(16);
        oversized.provenance = vec![0xAA; MAX_PROVENANCE_BYTES_V1 + 1];
        let error = ExportMuxSessionV1::begin(oversized, Vec::new()).unwrap_err();
        assert!(matches!(
            error,
            ExportMuxErrorV1::ProvenanceTooLarge {
                actual_bytes,
            } if actual_bytes == MAX_PROVENANCE_BYTES_V1 + 1
        ));
    }

    #[test]
    fn rejects_a_sample_bound_beyond_the_crate_cap() {
        let excessive = config(MAX_SAMPLE_TABLE_ENTRIES_V1 + 1);
        let error = ExportMuxSessionV1::begin(excessive, Vec::new()).unwrap_err();
        assert!(matches!(
            error,
            ExportMuxErrorV1::SampleBoundTooLarge {
                requested,
            } if requested == MAX_SAMPLE_TABLE_ENTRIES_V1 + 1
        ));
    }
}
