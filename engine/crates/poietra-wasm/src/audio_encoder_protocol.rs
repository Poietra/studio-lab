//! Closed refusal vocabulary for the optional browser audio encoder.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AudioEncoderRefusal {
    ApiUnavailable,
    EncoderError,
    InvalidTimestamp,
    MuxFailed,
    OutputLimitExceeded,
    UnsupportedCodec,
}

impl AudioEncoderRefusal {
    pub(crate) const fn wire_name(self) -> &'static str {
        match self {
            Self::ApiUnavailable => "api-unavailable",
            Self::EncoderError => "encoder-error",
            Self::InvalidTimestamp => "invalid-timestamp",
            Self::MuxFailed => "mux-failed",
            Self::OutputLimitExceeded => "output-limit-exceeded",
            Self::UnsupportedCodec => "unsupported-codec",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_encoder_uses_only_existing_browser_export_refusals() {
        assert_eq!(
            AudioEncoderRefusal::ApiUnavailable.wire_name(),
            "api-unavailable"
        );
        assert_eq!(
            AudioEncoderRefusal::EncoderError.wire_name(),
            "encoder-error"
        );
        assert_eq!(
            AudioEncoderRefusal::InvalidTimestamp.wire_name(),
            "invalid-timestamp"
        );
        assert_eq!(AudioEncoderRefusal::MuxFailed.wire_name(), "mux-failed");
        assert_eq!(
            AudioEncoderRefusal::OutputLimitExceeded.wire_name(),
            "output-limit-exceeded"
        );
        assert_eq!(
            AudioEncoderRefusal::UnsupportedCodec.wire_name(),
            "unsupported-codec"
        );
    }
}
