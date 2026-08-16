use crate::session::{MAX_PROVENANCE_BYTES_V1, MAX_SAMPLE_TABLE_ENTRIES_V1};

/// A v1 progressive-MP4 mux operation could not be completed truthfully.
///
/// A session that returned an error is in an unspecified partial state and
/// must be discarded together with its sink contents.
#[derive(Debug, thiserror::Error)]
pub enum ExportMuxErrorV1 {
    /// The raw `avcC` bytes did not parse as a complete
    /// `AVCDecoderConfigurationRecord`.
    #[error("avcC decoder configuration is malformed: {detail}")]
    MalformedDecoderConfiguration {
        /// Parser diagnostic for the rejected bytes.
        detail: String,
    },
    /// The provenance payload exceeds the v1 bound.
    #[error(
        "provenance payload is {actual_bytes} bytes; the v1 bound is {MAX_PROVENANCE_BYTES_V1}"
    )]
    ProvenanceTooLarge {
        /// Size of the rejected payload in bytes.
        actual_bytes: usize,
    },
    /// The requested per-session sample bound exceeds the crate-wide cap that
    /// keeps the retained sample table bounded.
    #[error(
        "a session may retain at most {MAX_SAMPLE_TABLE_ENTRIES_V1} sample records; \
         {requested} were requested"
    )]
    SampleBoundTooLarge {
        /// The rejected `max_sample_count` value.
        requested: u32,
    },
    /// A decodable MP4 must start with a sync sample.
    #[error("the first sample must be a keyframe")]
    FirstSampleNotKey,
    /// Sample timestamps must be strictly increasing.
    #[error(
        "sample timestamps must be strictly increasing: \
         {previous_us} us was followed by {current_us} us"
    )]
    NonMonotonicTimestamp {
        /// Timestamp of the previously accepted sample.
        previous_us: u64,
        /// Timestamp of the rejected sample.
        current_us: u64,
    },
    /// Two strictly increasing microsecond timestamps quantized to the same
    /// media-timescale tick, which would produce a zero sample duration.
    #[error(
        "sample timestamps {previous_us} us and {current_us} us collapse to \
         the same tick at a timescale of {timescale} Hz"
    )]
    TimestampTickCollision {
        /// Timestamp of the previously accepted sample.
        previous_us: u64,
        /// Timestamp of the rejected sample.
        current_us: u64,
        /// The media timescale that quantized both timestamps.
        timescale: u32,
    },
    /// A timestamp did not fit the 64-bit media-timescale tick range.
    #[error("timestamp {timestamp_us} us overflows the 64-bit tick range")]
    TimestampOverflow {
        /// The rejected timestamp.
        timestamp_us: u64,
    },
    /// The session's explicit sample bound was reached.
    #[error("the session accepts at most {max_sample_count} samples")]
    SampleCountExceeded {
        /// The configured bound.
        max_sample_count: u32,
    },
    /// A sample carried no bytes.
    #[error("a sample must carry at least one byte")]
    EmptySample,
    /// A sample was too large for the 32-bit sample-size table.
    #[error("a sample of {actual_bytes} bytes exceeds the 32-bit sample-size table")]
    SampleTooLarge {
        /// Size of the rejected sample in bytes.
        actual_bytes: usize,
    },
    /// A sample duration did not fit the 32-bit time-to-sample table.
    #[error("a sample duration of {ticks} ticks exceeds the 32-bit time-to-sample table")]
    DurationOverflow {
        /// The unrepresentable duration in media-timescale ticks.
        ticks: u64,
    },
    /// `finish` was called before any sample was appended.
    #[error("no samples were appended; an empty movie is not a valid export")]
    NoSamples,
    /// The container metadata could not be encoded.
    #[error("the container structure could not be encoded: {detail}")]
    ContainerEncoding {
        /// Encoder diagnostic.
        detail: String,
    },
    /// The muxed output outgrew the 64-bit addressable range.
    #[error("the muxed output exceeded the addressable 64-bit range")]
    OutputPositionOverflow,
    /// The sink rejected a write.
    #[error("the sink rejected a write")]
    Io(#[from] std::io::Error),
}
