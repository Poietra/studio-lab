//! Progressive MP4 (ISO BMFF) muxing for Poietra's client-side export lane.
//!
//! This crate frames already-encoded H.264 samples and, optionally, raw Opus
//! packets from `WebCodecs` into an MP4 byte stream on a caller-provided
//! [`std::io::Write`] sink. It never runs an encoder or retains media bytes.
//!
//! # Container layout decision: `moov` placement (#720 / #693)
//!
//! The muxer emits, in a single forward pass:
//!
//! ```text
//! ftyp | uuid | video mdat... | optional audio mdat... | moov
//! ```
//!
//! **Decision: media-first with `moov` at the end of the file.** The v1 use
//! case is a local save of a finished export. A trailing `moov` lets the muxer
//! stream every media byte to the sink the moment it arrives — no seeking, no
//! buffering of media data, and no back-patching — over a plain forward-only
//! `Write` sink (an OPFS writer in the browser, a file on native, a `Vec<u8>`
//! in tests). Each sample is framed as its own `mdat` box (8 bytes of overhead
//! per sample, permitted by ISO/IEC 14496-12), which removes the need to know
//! the total media size upfront or to rewrite an `mdat` header afterwards.
//!
//! Rejected alternatives, recorded for the later phases of #693:
//!
//! - **Fast start** (`moov` before `mdat`): better for progressive playback
//!   over HTTP, but it requires buffering all media bytes, a second pass, or a
//!   seekable sink to patch chunk offsets. Local playback does not need it,
//!   and a separate relocation pass can add it later without changing this
//!   crate's contract.
//! - **Fragmented MP4** (`moof`/`mdat` pairs): the right shape for live
//!   streaming, but it costs player compatibility for plain local files and a
//!   bounded, finished export does not need incremental finalization.
//!
//! # Bounded memory
//!
//! Media bytes pass straight through to the sink. The only per-sample state
//! retained is one bounded sample-table record (offset, size, timestamp tick,
//! sync flag). The bound is explicit: [`ExportMuxConfigV1::max_sample_count`],
//! itself capped by [`MAX_SAMPLE_TABLE_ENTRIES_V1`]. Exceeding either bound is
//! a typed error, never an unbounded allocation.
//!
//! # Codec, color, and provenance boxes
//!
//! - The `avc1` sample entry carries the `avcC` decoder configuration parsed
//!   from the raw bytes that `WebCodecs` reports via
//!   `EncodedVideoChunkMetadata.decoderConfig.description`.
//! - A `colr` box of type `nclx` records the measured color parameters as
//!   numeric ISO/IEC 23091-2 code points supplied by the caller. The muxer
//!   does not assume or translate color semantics.
//! - The application provenance payload is written as a top-level `uuid` box
//!   whose 16-byte user type is the ASCII label [`PROVENANCE_UUID_V1`]
//!   (`poietra-prov-v01`), so hex dumps identify it immediately. The payload
//!   is opaque to this crate and bounded by [`MAX_PROVENANCE_BYTES_V1`].
//! - Optional audio uses mono/stereo Opus at 48 kHz. One edit list trims
//!   decoder pre-skip and encoded tail padding to the video duration.
//!
//! # Verification
//!
//! [`verify_export_mp4_v1`] validates the closed container shape emitted by
//! this muxer and returns measured structure plus the opaque provenance. It
//! rejects any disagreement between media payloads, sample tables, timing,
//! and headers.
//!
//! # Portability
//!
//! The core path makes no filesystem or platform assumption: the crate
//! compiles for `wasm32-unknown-unknown` and writes through any
//! [`std::io::Write`] implementation.

mod error;
mod session;
mod verify;

pub use error::ExportMuxErrorV1;
pub use session::{
    ColorParametersV1, EncodedAudioSampleV1, EncodedSampleV1, ExportMuxConfigV1,
    ExportMuxSessionV1, MAX_PROVENANCE_BYTES_V1, MAX_SAMPLE_TABLE_ENTRIES_V1, OPUS_SAMPLE_RATE,
    OpusParametersV1, PROVENANCE_UUID_V1, VideoParametersV1,
};
pub use verify::{
    ExportMp4StructureV1, ExportMp4VerifyErrorV1, MAX_VERIFIED_EXPORT_MP4_BYTES_V1,
    OpusAudioStructureV1, verify_export_mp4_v1,
};
