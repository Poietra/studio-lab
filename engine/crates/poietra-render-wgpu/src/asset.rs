use std::io::Cursor;

use png::{BitDepth, ColorType, Decoder, Limits, Transformations};
use poietra_scene_ir::{MAX_IMAGE_PIXELS_V1, PngAssetV1};
use sha2::{Digest, Sha256};

const MAX_ENCODED_PNG_BYTES_V1: u64 = 134_217_728;
const PNG_DECODER_WORKING_BYTES_V1: usize = 64 * 1024 * 1024;

/// A manifest-verified static PNG decoded for linear-light GPU filtering.
///
/// Pixels are row-major with PNG row zero first (the top row). Each color
/// sample is converted from sRGB to linear light and multiplied by its
/// straight alpha before being quantized to `Rgba8Unorm`. Uploading these bytes
/// to a non-sRGB `Rgba8Unorm` texture therefore makes nearest and linear GPU
/// filtering operate on premultiplied linear-light values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DecodedPngAssetV1 {
    height: u32,
    premultiplied_linear_rgba8: Vec<u8>,
    sha256: String,
    width: u32,
}

impl DecodedPngAssetV1 {
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.height
    }

    #[must_use]
    pub fn premultiplied_linear_rgba8(&self) -> &[u8] {
        &self.premultiplied_linear_rgba8
    }

    #[must_use]
    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    #[must_use]
    pub const fn width(&self) -> u32 {
        self.width
    }
}

/// Encoded bytes cannot be proven to be the immutable static PNG named by a
/// manifest entry.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum DecodePngAssetErrorV1 {
    #[error("asset {asset_id} declares an invalid encoded byte length {byte_length}")]
    InvalidByteLength { asset_id: String, byte_length: u64 },
    #[error("asset {asset_id} declares invalid dimensions {width}x{height}")]
    InvalidDimensions {
        asset_id: String,
        height: u32,
        width: u32,
    },
    #[error("asset {asset_id} byte length is {actual}, expected {expected}")]
    ByteLengthMismatch {
        actual: u64,
        asset_id: String,
        expected: u64,
    },
    #[error("asset {asset_id} SHA-256 is {actual}, expected {expected}")]
    DigestMismatch {
        actual: String,
        asset_id: String,
        expected: String,
    },
    #[error("asset {asset_id} is not a supported static PNG: {reason}")]
    Decode { asset_id: String, reason: String },
    #[error("asset {asset_id} is animated; only one static PNG frame is supported")]
    Animated { asset_id: String },
    #[error(
        "asset {asset_id} decoded to {actual_width}x{actual_height}, expected {expected_width}x{expected_height}"
    )]
    DimensionMismatch {
        actual_height: u32,
        actual_width: u32,
        asset_id: String,
        expected_height: u32,
        expected_width: u32,
    },
    #[error("asset {asset_id} decoded to unsupported {color_type} {bit_depth} output")]
    UnsupportedOutput {
        asset_id: String,
        bit_depth: String,
        color_type: String,
    },
    #[error("asset {asset_id} decoded pixel storage exceeds the bounded RGBA8 range")]
    DecodedSizeOverflow { asset_id: String },
}

fn decode_error(asset_id: &str, error: impl std::fmt::Display) -> DecodePngAssetErrorV1 {
    DecodePngAssetErrorV1::Decode {
        asset_id: asset_id.to_owned(),
        reason: error.to_string(),
    }
}

fn srgb_u8_to_linear(value: u8) -> f64 {
    let normalized = f64::from(value) / 255.0;
    if normalized <= 0.040_45 {
        normalized / 12.92
    } else {
        ((normalized + 0.055) / 1.055).powf(2.4)
    }
}

fn quantize_unorm8(value: f64) -> u8 {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let quantized = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    quantized
}

fn append_premultiplied_pixel(output: &mut Vec<u8>, red: u8, green: u8, blue: u8, alpha: u8) {
    let normalized_alpha = f64::from(alpha) / 255.0;
    output.extend_from_slice(&[
        quantize_unorm8(srgb_u8_to_linear(red) * normalized_alpha),
        quantize_unorm8(srgb_u8_to_linear(green) * normalized_alpha),
        quantize_unorm8(srgb_u8_to_linear(blue) * normalized_alpha),
        alpha,
    ]);
}

fn premultiply_decoded_pixels(
    asset_id: &str,
    color_type: ColorType,
    pixels: &[u8],
    expected_pixels: usize,
) -> Result<Vec<u8>, DecodePngAssetErrorV1> {
    let expected_bytes = expected_pixels.checked_mul(4).ok_or_else(|| {
        DecodePngAssetErrorV1::DecodedSizeOverflow {
            asset_id: asset_id.to_owned(),
        }
    })?;
    let mut output = Vec::with_capacity(expected_bytes);
    match color_type {
        ColorType::Rgba => {
            if pixels.len() != expected_bytes {
                return Err(decode_error(asset_id, "RGBA output length is inconsistent"));
            }
            for pixel in pixels.chunks_exact(4) {
                append_premultiplied_pixel(&mut output, pixel[0], pixel[1], pixel[2], pixel[3]);
            }
        }
        ColorType::Rgb => {
            if pixels.len() != expected_pixels.saturating_mul(3) {
                return Err(decode_error(asset_id, "RGB output length is inconsistent"));
            }
            for pixel in pixels.chunks_exact(3) {
                append_premultiplied_pixel(&mut output, pixel[0], pixel[1], pixel[2], u8::MAX);
            }
        }
        ColorType::GrayscaleAlpha => {
            if pixels.len() != expected_pixels.saturating_mul(2) {
                return Err(decode_error(
                    asset_id,
                    "grayscale-alpha output length is inconsistent",
                ));
            }
            for pixel in pixels.chunks_exact(2) {
                append_premultiplied_pixel(&mut output, pixel[0], pixel[0], pixel[0], pixel[1]);
            }
        }
        ColorType::Grayscale => {
            if pixels.len() != expected_pixels {
                return Err(decode_error(
                    asset_id,
                    "grayscale output length is inconsistent",
                ));
            }
            for &gray in pixels {
                append_premultiplied_pixel(&mut output, gray, gray, gray, u8::MAX);
            }
        }
        ColorType::Indexed => {
            return Err(DecodePngAssetErrorV1::UnsupportedOutput {
                asset_id: asset_id.to_owned(),
                bit_depth: format!("{:?}", BitDepth::Eight),
                color_type: format!("{color_type:?}"),
            });
        }
    }
    if output.len() != expected_bytes {
        return Err(decode_error(
            asset_id,
            "RGBA8 output length is inconsistent",
        ));
    }
    Ok(output)
}

fn verify_encoded_asset(metadata: &PngAssetV1, bytes: &[u8]) -> Result<u64, DecodePngAssetErrorV1> {
    if metadata.byte_length == 0 || metadata.byte_length > MAX_ENCODED_PNG_BYTES_V1 {
        return Err(DecodePngAssetErrorV1::InvalidByteLength {
            asset_id: metadata.id.clone(),
            byte_length: metadata.byte_length,
        });
    }
    let declared_pixels = u64::from(metadata.pixel_width) * u64::from(metadata.pixel_height);
    if metadata.pixel_width == 0
        || metadata.pixel_height == 0
        || metadata.pixel_width > 16_384
        || metadata.pixel_height > 16_384
        || declared_pixels > MAX_IMAGE_PIXELS_V1
    {
        return Err(DecodePngAssetErrorV1::InvalidDimensions {
            asset_id: metadata.id.clone(),
            height: metadata.pixel_height,
            width: metadata.pixel_width,
        });
    }
    let actual_length =
        u64::try_from(bytes.len()).map_err(|_| DecodePngAssetErrorV1::InvalidByteLength {
            asset_id: metadata.id.clone(),
            byte_length: metadata.byte_length,
        })?;
    if actual_length != metadata.byte_length {
        return Err(DecodePngAssetErrorV1::ByteLengthMismatch {
            actual: actual_length,
            asset_id: metadata.id.clone(),
            expected: metadata.byte_length,
        });
    }
    let actual_digest = format!("{:x}", Sha256::digest(bytes));
    if actual_digest != metadata.sha256 {
        return Err(DecodePngAssetErrorV1::DigestMismatch {
            actual: actual_digest,
            asset_id: metadata.id.clone(),
            expected: metadata.sha256.clone(),
        });
    }
    Ok(declared_pixels)
}

/// Verifies immutable manifest metadata, decodes one bounded static PNG, and
/// converts straight-alpha sRGB samples to premultiplied linear-light RGBA8.
///
/// The function recomputes byte length, SHA-256, and decoded dimensions. A
/// caller may therefore commit the returned value to an asset registry without
/// trusting metadata from the transport envelope.
///
/// # Errors
///
/// Returns a fail-closed error for invalid metadata, stale bytes, malformed or
/// animated PNG input, dimension drift, unsupported decoder output, or checked
/// allocation-size overflow.
pub fn decode_verified_png_v1(
    metadata: &PngAssetV1,
    bytes: &[u8],
) -> Result<DecodedPngAssetV1, DecodePngAssetErrorV1> {
    let declared_pixels = verify_encoded_asset(metadata, bytes)?;

    let mut decoder = Decoder::new_with_limits(
        Cursor::new(bytes),
        Limits {
            bytes: PNG_DECODER_WORKING_BYTES_V1,
        },
    );
    decoder.set_ignore_text_chunk(true);
    decoder.set_transformations(Transformations::normalize_to_color8());
    let mut reader = decoder
        .read_info()
        .map_err(|error| decode_error(&metadata.id, error))?;
    if reader.info().animation_control.is_some() {
        return Err(DecodePngAssetErrorV1::Animated {
            asset_id: metadata.id.clone(),
        });
    }
    let output_size =
        reader
            .output_buffer_size()
            .ok_or_else(|| DecodePngAssetErrorV1::DecodedSizeOverflow {
                asset_id: metadata.id.clone(),
            })?;
    let mut raw_pixels = vec![0; output_size];
    let output = reader
        .next_frame(&mut raw_pixels)
        .map_err(|error| decode_error(&metadata.id, error))?;
    reader
        .finish()
        .map_err(|error| decode_error(&metadata.id, error))?;
    if output.width != metadata.pixel_width || output.height != metadata.pixel_height {
        return Err(DecodePngAssetErrorV1::DimensionMismatch {
            actual_height: output.height,
            actual_width: output.width,
            asset_id: metadata.id.clone(),
            expected_height: metadata.pixel_height,
            expected_width: metadata.pixel_width,
        });
    }
    if output.bit_depth != BitDepth::Eight {
        return Err(DecodePngAssetErrorV1::UnsupportedOutput {
            asset_id: metadata.id.clone(),
            bit_depth: format!("{:?}", output.bit_depth),
            color_type: format!("{:?}", output.color_type),
        });
    }
    let pixel_count = usize::try_from(declared_pixels).map_err(|_| {
        DecodePngAssetErrorV1::DecodedSizeOverflow {
            asset_id: metadata.id.clone(),
        }
    })?;
    let premultiplied_linear_rgba8 = premultiply_decoded_pixels(
        &metadata.id,
        output.color_type,
        &raw_pixels[..output.buffer_size()],
        pixel_count,
    )?;

    Ok(DecodedPngAssetV1 {
        height: metadata.pixel_height,
        premultiplied_linear_rgba8,
        sha256: metadata.sha256.clone(),
        width: metadata.pixel_width,
    })
}

#[cfg(test)]
mod tests {
    use png::{BitDepth, ColorType, Encoder};
    use poietra_scene_ir::{AssetAlphaModeV1, AssetColorSpaceV1, PngAssetKindV1, PngMediaTypeV1};

    use super::*;

    fn encode_png(
        width: u32,
        height: u32,
        color_type: ColorType,
        pixels: &[u8],
        animated: bool,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = Encoder::new(&mut bytes, width, height);
        encoder.set_color(color_type);
        encoder.set_depth(BitDepth::Eight);
        if animated {
            encoder.set_animated(1, 0).unwrap();
        }
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(pixels).unwrap();
        writer.finish().unwrap();
        bytes
    }

    fn metadata(bytes: &[u8], width: u32, height: u32) -> PngAssetV1 {
        PngAssetV1 {
            alpha_mode: AssetAlphaModeV1::Straight,
            byte_length: u64::try_from(bytes.len()).unwrap(),
            color_space: AssetColorSpaceV1::Srgb,
            id: "asset:test".to_owned(),
            kind: PngAssetKindV1::PngImage,
            media_type: PngMediaTypeV1::ImagePng,
            pixel_height: height,
            pixel_width: width,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    #[test]
    fn decodes_row_zero_top_and_premultiplies_in_linear_light() {
        let bytes = encode_png(
            2,
            2,
            ColorType::Rgba,
            &[
                255, 0, 0, 128, 0, 255, 0, 255, // top row
                0, 0, 255, 64, 128, 128, 128, 128, // bottom row
            ],
            false,
        );
        let decoded = decode_verified_png_v1(&metadata(&bytes, 2, 2), &bytes).unwrap();

        assert_eq!(decoded.width(), 2);
        assert_eq!(decoded.height(), 2);
        assert_eq!(decoded.sha256(), format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(
            decoded.premultiplied_linear_rgba8(),
            &[
                128, 0, 0, 128, 0, 255, 0, 255, // top row stays first
                0, 0, 64, 64, 28, 28, 28, 128, // sRGB 128 -> linear, then alpha
            ]
        );
    }

    #[test]
    fn expands_rgb_and_grayscale_inputs_to_rgba8() {
        let cases = [
            (ColorType::Rgb, vec![255, 128, 0], vec![255, 55, 0, 255]),
            (ColorType::Grayscale, vec![128], vec![55, 55, 55, 255]),
            (
                ColorType::GrayscaleAlpha,
                vec![128, 128],
                vec![28, 28, 28, 128],
            ),
        ];
        for (color_type, input, expected) in cases {
            let bytes = encode_png(1, 1, color_type, &input, false);
            let decoded = decode_verified_png_v1(&metadata(&bytes, 1, 1), &bytes).unwrap();
            assert_eq!(decoded.premultiplied_linear_rgba8(), expected);
        }
    }

    #[test]
    fn rejects_stale_length_digest_and_dimensions_before_registry_commit() {
        let bytes = encode_png(1, 1, ColorType::Rgba, &[1, 2, 3, 4], false);

        let mut stale_length = metadata(&bytes, 1, 1);
        stale_length.byte_length += 1;
        assert!(matches!(
            decode_verified_png_v1(&stale_length, &bytes),
            Err(DecodePngAssetErrorV1::ByteLengthMismatch { .. })
        ));

        let mut stale_digest = metadata(&bytes, 1, 1);
        stale_digest.sha256 = "0".repeat(64);
        assert!(matches!(
            decode_verified_png_v1(&stale_digest, &bytes),
            Err(DecodePngAssetErrorV1::DigestMismatch { .. })
        ));

        let stale_dimensions = metadata(&bytes, 2, 1);
        assert!(matches!(
            decode_verified_png_v1(&stale_dimensions, &bytes),
            Err(DecodePngAssetErrorV1::DimensionMismatch { .. })
        ));
    }

    #[test]
    fn rejects_animated_and_malformed_pngs() {
        let animated = encode_png(1, 1, ColorType::Rgba, &[1, 2, 3, 4], true);
        assert!(matches!(
            decode_verified_png_v1(&metadata(&animated, 1, 1), &animated),
            Err(DecodePngAssetErrorV1::Animated { .. })
        ));

        let malformed = b"not a png";
        assert!(matches!(
            decode_verified_png_v1(&metadata(malformed, 1, 1), malformed),
            Err(DecodePngAssetErrorV1::Decode { .. })
        ));
    }
}
