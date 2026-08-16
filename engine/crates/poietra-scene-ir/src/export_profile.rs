//! `ExportProfileV1` — the closed v1 contract describing one client-side video export.
//!
//! The profile is the single authority for *how* a Scene is encoded — output
//! resolution, sampling frame rate, codec tier, color contract version, and the
//! declared duration/output-size bounds — and it never modifies the Scene
//! itself. Consumers (export sessions, muxers, publication acceptance) are
//! introduced separately; this module only defines and validates the contract.

use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

use crate::model::{ContractVersionV1, deserialize_js_safe_u32, deserialize_js_safe_u64};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum ExportProfileSchemaV1 {
    #[default]
    #[serde(rename = "poietra.export-profile")]
    ExportProfile,
}

/// The only codec tier accepted by v1: H.264 video in an MP4 container.
///
/// H.264/MP4 is the most widely supported `WebCodecs` encode target and the
/// only container/codec pair the existing server acceptance profile
/// (`sandbox/manim-render-gated-oci/render-entrypoint.py::_validate_mp4`) has
/// ever admitted. Additional tiers (AV1/VP9 + `WebM`) are a later, opt-in
/// phase.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum ExportCodecTierV1 {
    #[default]
    #[serde(rename = "h264-mp4")]
    H264Mp4,
}

/// The only export color contract version accepted by v1.
///
/// The integer version-locks the export color pipeline without restating it:
/// version 1 names the contract under which export frames are sRGB-encoded
/// RGBA readback. The normative definition (encoder tagging, `colr` boxes,
/// roundtrip gates) belongs to the export-authority color ADR.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ExportColorContractVersionV1;

impl Serialize for ExportColorContractVersionV1 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(1)
    }
}

impl<'de> Deserialize<'de> for ExportColorContractVersionV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = deserialize_js_safe_u64(deserializer)?;
        if version == 1 {
            Ok(Self)
        } else {
            Err(de::Error::custom(format!(
                "unsupported export color contract version {version}; expected 1"
            )))
        }
    }
}

/// Closed 16:9 output ladder aligned to the 8 × (128/9) scene-unit frame.
///
/// 1280×720 and 1920×1080 are exact 16:9 pixel grids: they rasterize the same
/// camera frame at different densities and never change what is visible.
/// 854×480 preserves the legacy accepted server render profile — 854 px is
/// the even-width rounding of 480 × 16/9 — so its pixel aspect deviates from
/// 16:9 by less than one pixel column; export sampling resolves that
/// deviation exactly as the legacy Manim profile did, by widening the camera
/// window sub-pixel about its center (never cropping). Arbitrary integer
/// dimensions are rejected by construction: the wire value is one of these
/// three literals.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ExportResolutionV1 {
    #[serde(rename = "854x480")]
    Sd854x480,
    #[serde(rename = "1280x720")]
    Hd1280x720,
    #[serde(rename = "1920x1080")]
    FullHd1920x1080,
}

impl ExportResolutionV1 {
    #[must_use]
    pub const fn width_px(&self) -> u32 {
        match self {
            Self::Sd854x480 => 854,
            Self::Hd1280x720 => 1280,
            Self::FullHd1920x1080 => 1920,
        }
    }

    #[must_use]
    pub const fn height_px(&self) -> u32 {
        match self {
            Self::Sd854x480 => 480,
            Self::Hd1280x720 => 720,
            Self::FullHd1920x1080 => 1080,
        }
    }
}

/// Closed v1 sampling/output frame rate, carried on the wire as the integer
/// 30 or 60.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportFrameRateV1 {
    Fps30,
    Fps60,
}

impl ExportFrameRateV1 {
    #[must_use]
    pub const fn frames_per_second(&self) -> f64 {
        match self {
            Self::Fps30 => 30.0,
            Self::Fps60 => 60.0,
        }
    }
}

impl Serialize for ExportFrameRateV1 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(match self {
            Self::Fps30 => 30,
            Self::Fps60 => 60,
        })
    }
}

impl<'de> Deserialize<'de> for ExportFrameRateV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match deserialize_js_safe_u64(deserializer)? {
            30 => Ok(Self::Fps30),
            60 => Ok(Self::Fps60),
            value => Err(de::Error::custom(format!(
                "unsupported export frame rate {value}; expected 30 or 60"
            ))),
        }
    }
}

/// Closed v1 description of one client-side video export.
///
/// # Sampling frame-rate precedence (#693 Question 6 decision)
///
/// The export profile supplies the sampling fps. Export stepping walks output
/// frame indices `i` and samples the Scene at
/// [`crate::SceneIrV1::state_sample_time`]`(i / frameRate)` using this
/// profile's `frame_rate`. `SceneIrV1.state_sampling.frame_rate` remains the
/// Scene's own declaration of its retained-state sampling grid and is NOT
/// overwritten by the profile. The precedence rule is composition, not
/// override:
///
/// - the profile decides *which instants are requested* — `i / frameRate` for
///   each output frame index `i`;
/// - the Scene's `state_sampling` decides *how each requested instant
///   resolves* to retained state — `state_sample_time` quantizes onto the
///   Scene's own `frame_rate` grid when that declaration is non-null and
///   applies the terminal-retention rule at the endpoint.
///
/// An exporter therefore never writes to `state_sampling.frame_rate`; a Scene
/// declaring `frame_rate: null` samples continuously at exactly the profile's
/// requested instants.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportProfileV1 {
    pub codec: ExportCodecTierV1,
    pub color_contract_version: ExportColorContractVersionV1,
    /// Output and sampling frame rate. See the precedence rule on
    /// [`ExportProfileV1`].
    pub frame_rate: ExportFrameRateV1,
    /// Declared upper bound on encoded video duration, in whole seconds.
    ///
    /// Must stay within [`crate::MAX_EXPORT_DURATION_SECONDS_V1`].
    #[serde(deserialize_with = "deserialize_js_safe_u32")]
    pub max_duration_seconds: u32,
    /// Declared upper bound on the finalized container size, in bytes.
    ///
    /// Must stay within [`crate::MAX_EXPORT_OUTPUT_BYTES_V1`].
    #[serde(deserialize_with = "deserialize_js_safe_u64")]
    pub max_output_bytes: u64,
    pub resolution: ExportResolutionV1,
    pub schema: ExportProfileSchemaV1,
    pub version: ContractVersionV1,
}

#[cfg(test)]
mod export_wire_tests {
    use super::*;

    #[test]
    fn frame_rate_matches_javascript_number_semantics() {
        assert_eq!(
            serde_json::from_str::<ExportFrameRateV1>("30.0").unwrap(),
            ExportFrameRateV1::Fps30
        );
        assert_eq!(
            serde_json::from_str::<ExportFrameRateV1>("6e1").unwrap(),
            ExportFrameRateV1::Fps60
        );
        assert!(serde_json::from_str::<ExportFrameRateV1>("59.94").is_err());
        assert!(serde_json::from_str::<ExportFrameRateV1>("24").is_err());
    }

    #[test]
    fn color_contract_version_is_closed_at_one() {
        assert_eq!(
            serde_json::from_str::<ExportColorContractVersionV1>("1.0").unwrap(),
            ExportColorContractVersionV1
        );
        assert!(serde_json::from_str::<ExportColorContractVersionV1>("2").is_err());
        assert_eq!(
            serde_json::to_string(&ExportColorContractVersionV1).unwrap(),
            "1"
        );
    }

    #[test]
    fn resolution_ladder_is_closed_and_carries_pixel_dimensions() {
        let ladder = [
            (ExportResolutionV1::Sd854x480, "\"854x480\"", 854, 480),
            (ExportResolutionV1::Hd1280x720, "\"1280x720\"", 1280, 720),
            (
                ExportResolutionV1::FullHd1920x1080,
                "\"1920x1080\"",
                1920,
                1080,
            ),
        ];
        for (resolution, wire, width, height) in ladder {
            assert_eq!(serde_json::to_string(&resolution).unwrap(), wire);
            assert_eq!(
                serde_json::from_str::<ExportResolutionV1>(wire).unwrap(),
                resolution
            );
            assert_eq!(resolution.width_px(), width);
            assert_eq!(resolution.height_px(), height);
        }
        assert!(serde_json::from_str::<ExportResolutionV1>("\"640x360\"").is_err());
        assert!(serde_json::from_str::<ExportResolutionV1>("\"3840x2160\"").is_err());
    }
}
