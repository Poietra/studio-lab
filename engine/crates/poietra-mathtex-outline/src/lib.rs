//! Hermetic, bounded MathTex-to-cubic-outline compilation for Poietra Studio.
//!
//! The v1 surface accepts a bounded, versioned `MathTex` subset through `RaTeX`.
//! It embeds the required `KaTeX` fonts, exposes no filesystem or network loader, and returns
//! renderer-native cubic paths instead of SVG or executable markup.

mod compile;
mod digest;
mod fonts;
mod outline;
mod segmented;

use poietra_scene_ir::{CubicPathV1, FillRuleV1};
use serde::{Deserialize, Serialize};

pub use compile::compile_mathtex_outline_v1;
pub use segmented::{
    MAX_SEGMENTED_TEX_CUBIC_SEGMENTS_V1, MAX_SEGMENTED_TEX_ENTITIES_V1,
    MAX_SEGMENTED_TEX_FRAGMENTS_V1, MAX_SEGMENTED_TEX_PAINT_LITERAL_BYTES_V1,
    MAX_SEGMENTED_TEX_PAINT_MATCHES_V1, MAX_SEGMENTED_TEX_SOURCE_BYTES_V1,
    MAX_SEGMENTED_TEX_UNSUPPORTED_MESSAGE_BYTES_V1, SEGMENTED_TEX_OUTLINE_REQUEST_SCHEMA_V1,
    SEGMENTED_TEX_OUTLINE_RESPONSE_SCHEMA_V1, SEGMENTED_TEX_OUTLINE_VERSION_V1, SegmentedTexModeV1,
    SegmentedTexOutlineArtifactV1, SegmentedTexOutlineFragmentKindV1,
    SegmentedTexOutlineFragmentV1, SegmentedTexOutlineRequestSchemaV1,
    SegmentedTexOutlineRequestV1, SegmentedTexOutlineResultV1,
    SegmentedTexOutlineUnsupportedCodeV1, SegmentedTexOutlineUnsupportedV1,
    SegmentedTexPaintMatchV1, SegmentedTexPaintSpanV1, SegmentedTexSourceCorrelationV1,
    SegmentedTexSourceKindV1, SegmentedTexWriteEntityStateV1, SegmentedTexWritePlanV1,
    SegmentedTexWriteSampleV1, compile_segmented_tex_outline_v1, evaluate_segmented_tex_write_v1,
};

/// Exact request schema literal accepted by the v1 compiler.
pub const MATHTEX_OUTLINE_REQUEST_SCHEMA_V1: &str = "poietra.mathtex-outline-request";
/// Exact response schema literal emitted by the WASM boundary.
pub const MATHTEX_OUTLINE_RESPONSE_SCHEMA_V1: &str = "poietra.mathtex-outline-response";
/// Contract version shared by the core and WASM wrapper.
pub const MATHTEX_OUTLINE_VERSION_V1: u32 = 1;
/// Maximum number of Studio `MathTex` source parts in one request.
pub const MAX_MATHTEX_PARTS_V1: usize = 16;
/// Maximum aggregate UTF-8 bytes accepted across source parts.
pub const MAX_MATHTEX_SOURCE_BYTES_V1: usize = 2_000;
/// Maximum diagnostic bytes exposed across the trust boundary.
pub const MAX_MATHTEX_UNSUPPORTED_MESSAGE_BYTES_V1: usize = 512;
/// Aggregate SHA-256 of the 19 `KaTeX` TTF faces reachable through the pinned
/// `RaTeX` v0.1.14 `FontId` mapping.
///
/// The digest frames the basename-sorted files with the domain
/// `poietra.mathtex-outline.fonts.v1\0`, an unsigned big-endian file count,
/// then the unsigned big-endian basename length, basename, byte length, and
/// raw bytes for each face. A unit test recomputes it from the embedded assets.
pub const MATHTEX_FONT_DIGEST_V1: &str =
    "6a8369948029b4811a906fdd028542d5e34b11044937544a9870a88d4b9cd93a";

/// Literal request schema represented as a closed serde enum.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum MathTexOutlineRequestSchemaV1 {
    #[serde(rename = "poietra.mathtex-outline-request")]
    MathTexOutlineRequest,
}

/// One bounded `MathTex` outline compilation request.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MathTexOutlineRequestV1 {
    pub schema: MathTexOutlineRequestSchemaV1,
    pub version: u32,
    pub tex_parts: Vec<String>,
}

impl MathTexOutlineRequestV1 {
    /// Creates a correctly versioned v1 request.
    pub fn new(tex_parts: Vec<String>) -> Self {
        Self {
            schema: MathTexOutlineRequestSchemaV1::MathTexOutlineRequest,
            version: MATHTEX_OUTLINE_VERSION_V1,
            tex_parts,
        }
    }
}

/// Tight, local-space ink bounds for a compiled outline.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MathTexOutlineBoundsV1 {
    pub left: f64,
    pub right: f64,
    pub bottom: f64,
    pub top: f64,
}

/// Renderer-native output and provenance for one supported expression.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MathTexOutlineArtifactV1 {
    pub path: CubicPathV1,
    pub bounds: MathTexOutlineBoundsV1,
    pub fill_rule: FillRuleV1,
    pub content_digest: String,
    pub toolchain_digest: String,
    pub font_digest: String,
}

/// Stable reason code for a v1 semantic-preview fallback.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MathTexOutlineUnsupportedCodeV1 {
    InvalidRequest,
    RequestTooLarge,
    SyntaxUnsupported,
    ConversionFailed,
    LayoutFailed,
    FrameItemUnsupported,
    OutlineInvalid,
    OutlineLimitExceeded,
    ResponseTooLarge,
    InternalFailure,
}

/// Bounded unsupported result that keeps the Studio semantic preview authoritative.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MathTexOutlineUnsupportedV1 {
    pub code: MathTexOutlineUnsupportedCodeV1,
    pub message: String,
}

impl MathTexOutlineUnsupportedV1 {
    /// Creates an unsupported result while enforcing the public message bound.
    pub fn new(code: MathTexOutlineUnsupportedCodeV1, message: impl Into<String>) -> Self {
        let mut message = message.into();
        if message.len() > MAX_MATHTEX_UNSUPPORTED_MESSAGE_BYTES_V1 {
            let mut end = MAX_MATHTEX_UNSUPPORTED_MESSAGE_BYTES_V1;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
        }
        Self { code, message }
    }
}

/// Closed v1 compilation result. Newtype variants serialize as one flat tagged object.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum MathTexOutlineResultV1 {
    Compiled(MathTexOutlineArtifactV1),
    Unsupported(MathTexOutlineUnsupportedV1),
}

impl MathTexOutlineResultV1 {
    /// Creates a bounded structured fallback result.
    pub fn unsupported(code: MathTexOutlineUnsupportedCodeV1, message: impl Into<String>) -> Self {
        Self::Unsupported(MathTexOutlineUnsupportedV1::new(code, message))
    }
}
