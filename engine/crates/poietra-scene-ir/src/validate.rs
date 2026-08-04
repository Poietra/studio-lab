use std::collections::{BTreeSet, HashMap, HashSet};
use std::error::Error;
use std::fmt;

use crate::model::{
    AffineTransformV1, AnimationChannelV1, AssetManifestReferenceV1, AssetManifestV1,
    AssetReferenceV1, CubicPathV1, EasingV1, FidelityV1, FillStyleV1, ImageLocalRectV1, IntervalV1,
    KeyframeV1, PointV1, RenderCapabilityV1, RenderCompositingV1, RenderDrawV1,
    RenderEmptyReasonV1, RenderPacketV1, RgbaColorV1, SceneAppearanceV1, SceneCameraViewV1,
    SceneCapabilityV1, SceneGeometryV1, SceneIrV1, SceneSourceV1, StrokeStyleV1,
};

pub const MAX_COORDINATE_V1: f64 = 1_000_000_000.0;
pub const MAX_TOTAL_PATH_SEGMENTS_V1: usize = 100_000;
pub const MAX_ASSETS_V1: usize = 4_096;
pub const MAX_ENCODED_ASSET_BYTES_V1: u64 = 268_435_456;
pub const MAX_IMAGE_PIXELS_V1: u64 = 16_777_216;
pub const MAX_TOTAL_IMAGE_PIXELS_V1: u64 = 33_554_432;
pub const MAX_ENTITIES_V1: usize = 10_000;
pub const MAX_CHANNELS_V1: usize = 10_000;
pub const MAX_KEYFRAMES_V1: usize = 100_000;
pub const MAX_DRAWS_V1: usize = 100_000;
pub const MAX_VIEWPORT_PIXELS_V1: u64 = 33_554_432;
pub const MAX_VALIDATION_ISSUES_V1: usize = 128;

fn omitted_issues_marker() -> ValidationIssue {
    ValidationIssue {
        path: "$".to_owned(),
        message: format!(
            "additional validation issues omitted after the {MAX_VALIDATION_ISSUES_V1}-issue limit"
        ),
    }
}

pub(crate) fn push_validation_issue(
    issues: &mut Vec<ValidationIssue>,
    path: impl Into<String>,
    message: impl Into<String>,
) {
    if issues.len() >= MAX_VALIDATION_ISSUES_V1 {
        issues[MAX_VALIDATION_ISSUES_V1 - 1] = omitted_issues_marker();
        return;
    }
    issues.push(ValidationIssue {
        path: path.into(),
        message: message.into(),
    });
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationIssue {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidationErrors {
    issues: Vec<ValidationIssue>,
}

impl ValidationErrors {
    #[must_use]
    pub fn new(mut issues: Vec<ValidationIssue>) -> Self {
        if issues.len() > MAX_VALIDATION_ISSUES_V1 {
            issues.truncate(MAX_VALIDATION_ISSUES_V1 - 1);
            issues.push(omitted_issues_marker());
        }
        Self { issues }
    }

    #[must_use]
    pub fn issues(&self) -> &[ValidationIssue] {
        &self.issues
    }

    #[must_use]
    pub fn contains_message(&self, needle: &str) -> bool {
        self.issues
            .iter()
            .any(|issue| issue.message.contains(needle))
    }
}

impl fmt::Display for ValidationErrors {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, issue) in self.issues.iter().enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            write!(formatter, "{}: {}", issue.path, issue.message)?;
        }
        Ok(())
    }
}

impl Error for ValidationErrors {}

#[derive(Default)]
struct Validator {
    issues: Vec<ValidationIssue>,
}

impl Validator {
    fn issue(&mut self, path: impl Into<String>, message: impl Into<String>) {
        push_validation_issue(&mut self.issues, path, message);
    }

    fn finish(self) -> Result<(), ValidationErrors> {
        if self.issues.is_empty() {
            Ok(())
        } else {
            Err(ValidationErrors::new(self.issues))
        }
    }
}

fn validate_finite(value: f64, path: &str, validator: &mut Validator) {
    if !value.is_finite() {
        validator.issue(path, "must be finite");
    }
}

fn validate_coordinate(value: f64, path: &str, validator: &mut Validator) {
    validate_finite(value, path, validator);
    if value.is_finite() && !(-MAX_COORDINATE_V1..=MAX_COORDINATE_V1).contains(&value) {
        validator.issue(path, "must be inside the v1 coordinate range");
    }
}

fn validate_positive(value: f64, path: &str, validator: &mut Validator) {
    validate_finite(value, path, validator);
    if value.is_finite() && value <= 0.0 {
        validator.issue(path, "must be positive");
    }
}

fn validate_normalized(value: f64, path: &str, validator: &mut Validator) {
    validate_finite(value, path, validator);
    if value.is_finite() && !(0.0..=1.0).contains(&value) {
        validator.issue(path, "must be between 0 and 1 inclusive");
    }
}

fn is_portable_id(value: &str, allow_hash: bool) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    bytes.all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(byte, b'.' | b'_' | b':' | b'@' | b'/' | b'-')
            || (allow_hash && byte == b'#')
    })
}

fn validate_bounded_text(
    value: &str,
    maximum: usize,
    portable_kind: Option<bool>,
    path: &str,
    validator: &mut Validator,
) {
    // Zod measures JavaScript strings in UTF-16 code units. Matching that boundary
    // prevents native and WASM consumers from accepting different wire documents.
    let length = value.encode_utf16().count();
    if length == 0 || length > maximum {
        validator.issue(path, format!("must contain 1 to {maximum} characters"));
    }
    if value.trim() != value {
        validator.issue(path, "must not have surrounding whitespace");
    }
    if value.chars().any(|character| character.is_ascii_control()) {
        validator.issue(path, "must not contain control characters");
    }
    if let Some(allow_hash) = portable_kind {
        if !is_portable_id(value, allow_hash) {
            validator.issue(path, "must use the portable ASCII identifier subset");
        }
    }
}

fn validate_opaque_id(value: &str, path: &str, validator: &mut Validator) {
    validate_bounded_text(value, 240, Some(false), path, validator);
}

fn validate_source_identity(value: &str, path: &str, validator: &mut Validator) {
    validate_bounded_text(value, 240, Some(true), path, validator);
}

fn validate_evidence(value: &str, path: &str, validator: &mut Validator) {
    validate_bounded_text(value, 500, None, path, validator);
}

fn validate_sha256(value: &str, path: &str, validator: &mut Validator) {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        validator.issue(path, "must be a lower-case SHA-256 digest");
    }
}

fn validate_point(point: &PointV1, path: &str, validator: &mut Validator) {
    validate_coordinate(point.x, &format!("{path}.x"), validator);
    validate_coordinate(point.y, &format!("{path}.y"), validator);
}

fn validate_transform(transform: &AffineTransformV1, path: &str, validator: &mut Validator) {
    validate_finite(transform.m11, &format!("{path}.m11"), validator);
    validate_finite(transform.m12, &format!("{path}.m12"), validator);
    validate_finite(transform.m21, &format!("{path}.m21"), validator);
    validate_finite(transform.m22, &format!("{path}.m22"), validator);
    validate_coordinate(transform.tx, &format!("{path}.tx"), validator);
    validate_coordinate(transform.ty, &format!("{path}.ty"), validator);
}

/// Smallest determinant magnitude an affine sample may carry and still be
/// prepared as f32 renderer geometry.
///
/// The authoritative contract domain is f64, but the renderer converts
/// geometry to f32 before WGPU preparation, so the boundary that matters is
/// the smallest normal f32. Below it a determinant is a subnormal or zero in
/// the renderer's domain: preparation collapses and fails the *complete*
/// frame, which is an availability failure for input the snapshot profile
/// happily sealed as verified (`stretch(1e-50, 1)` is finite, bounded, and
/// non-zero).
///
/// The value is stable across WASM and native because it is not a tuned
/// tolerance. `f32::MIN_POSITIVE` is a fixed IEEE-754 binary32 quantity, and
/// the predicate reaches it only through operations IEEE-754 pins exactly in
/// both targets: round-to-nearest-even f64 -> f32 conversion (`as f32` in
/// Rust, `Math.fround` in TypeScript) and one f64 multiply-subtract. No
/// platform math library is involved, so the same matrix classifies
/// identically everywhere.
pub const MIN_AFFINE_DETERMINANT_V1: f64 = f32::MIN_POSITIVE as f64;

/// Determinant of `transform` as the renderer will see it, in f64.
///
/// The entries are rounded to f32 first: an entry can underflow on its own
/// (`m11 = 1e-50` with `m22 = 1e30` has an f64 determinant of `1e-20`, but
/// `m11` is zero once rounded), so an f64-only determinant would miss the
/// collapse this guard exists to catch.
fn affine_transform_rendered_determinant(transform: &AffineTransformV1) -> f64 {
    #[allow(clippy::cast_possible_truncation)]
    let round = |value: f64| f64::from(value as f32);
    round(transform.m11) * round(transform.m22) - round(transform.m12) * round(transform.m21)
}

/// Whether an affine sample is singular, or near enough that f32 preparation
/// would collapse it.
///
/// An exactly singular transform — reflection's midpoint, for instance — is
/// the `determinant == 0` case and keeps classifying exactly as before.
pub fn affine_transform_is_singular_v1(transform: &AffineTransformV1) -> bool {
    let determinant = affine_transform_rendered_determinant(transform).abs();
    // A NaN determinant classifies as singular rather than reaching preparation.
    determinant.is_nan() || determinant < MIN_AFFINE_DETERMINANT_V1
}

fn validate_color(color: &RgbaColorV1, path: &str, validator: &mut Validator) {
    validate_normalized(color.alpha, &format!("{path}.alpha"), validator);
    validate_normalized(color.blue, &format!("{path}.blue"), validator);
    validate_normalized(color.green, &format!("{path}.green"), validator);
    validate_normalized(color.red, &format!("{path}.red"), validator);
}

fn validate_fill(fill: &FillStyleV1, path: &str, validator: &mut Validator) {
    validate_color(&fill.color, &format!("{path}.color"), validator);
}

fn validate_stroke(stroke: &StrokeStyleV1, path: &str, validator: &mut Validator) {
    validate_color(&stroke.color, &format!("{path}.color"), validator);
    validate_finite(stroke.miter_limit, &format!("{path}.miterLimit"), validator);
    if stroke.miter_limit.is_finite() && !(1.0..=1_000.0).contains(&stroke.miter_limit) {
        validator.issue(
            format!("{path}.miterLimit"),
            "must be between 1 and 1000 inclusive",
        );
    }
    validate_positive(stroke.width_world, &format!("{path}.widthWorld"), validator);
    if stroke.width_world.is_finite() && stroke.width_world > MAX_COORDINATE_V1 {
        validator.issue(
            format!("{path}.widthWorld"),
            "must be inside the v1 coordinate range",
        );
    }
}

fn validate_asset_reference(reference: &AssetReferenceV1, path: &str, validator: &mut Validator) {
    validate_opaque_id(&reference.asset_id, &format!("{path}.assetId"), validator);
    validate_sha256(&reference.sha256, &format!("{path}.sha256"), validator);
}

fn validate_manifest_reference(
    reference: &AssetManifestReferenceV1,
    path: &str,
    validator: &mut Validator,
) {
    validate_sha256(
        &reference.manifest_digest,
        &format!("{path}.manifestDigest"),
        validator,
    );
    validate_opaque_id(
        &reference.manifest_id,
        &format!("{path}.manifestId"),
        validator,
    );
}

fn validate_image_rect(rectangle: &ImageLocalRectV1, path: &str, validator: &mut Validator) {
    validate_coordinate(rectangle.bottom, &format!("{path}.bottom"), validator);
    validate_coordinate(rectangle.left, &format!("{path}.left"), validator);
    validate_coordinate(rectangle.right, &format!("{path}.right"), validator);
    validate_coordinate(rectangle.top, &format!("{path}.top"), validator);
    if rectangle.right <= rectangle.left || rectangle.top <= rectangle.bottom {
        validator.issue(path, "must have positive width and height");
    }
}

fn validate_path_inner(path: &CubicPathV1, base: &str, validator: &mut Validator) -> usize {
    if path.subpaths.is_empty() {
        validator.issue(
            format!("{base}.subpaths"),
            "must contain at least one subpath",
        );
    }
    if path.subpaths.len() > MAX_TOTAL_PATH_SEGMENTS_V1 {
        validator.issue(
            format!("{base}.subpaths"),
            format!("accepts at most {MAX_TOTAL_PATH_SEGMENTS_V1} subpaths"),
        );
    }
    let mut total = 0usize;
    for (subpath_index, subpath) in path.subpaths.iter().enumerate() {
        let subpath_base = format!("{base}.subpaths[{subpath_index}]");
        validate_point(&subpath.start, &format!("{subpath_base}.start"), validator);
        if subpath.segments.is_empty() {
            validator.issue(
                format!("{subpath_base}.segments"),
                "must contain at least one cubic segment",
            );
        }
        if subpath.segments.len() > MAX_TOTAL_PATH_SEGMENTS_V1 {
            validator.issue(
                format!("{subpath_base}.segments"),
                format!("accepts at most {MAX_TOTAL_PATH_SEGMENTS_V1} segments"),
            );
        }
        total = total.saturating_add(subpath.segments.len());
        for (segment_index, segment) in subpath.segments.iter().enumerate() {
            let segment_base = format!("{subpath_base}.segments[{segment_index}]");
            validate_point(
                &segment.control1,
                &format!("{segment_base}.control1"),
                validator,
            );
            validate_point(
                &segment.control2,
                &format!("{segment_base}.control2"),
                validator,
            );
            validate_point(&segment.end, &format!("{segment_base}.end"), validator);
        }
    }
    if total > MAX_TOTAL_PATH_SEGMENTS_V1 {
        validator.issue(
            base,
            format!("accepts at most {MAX_TOTAL_PATH_SEGMENTS_V1} total cubic segments"),
        );
    }
    total
}

/// Validates a cubic path's coordinates and aggregate v1 segment limits.
///
/// # Errors
///
/// Returns all detected v1 contract violations.
pub fn validate_cubic_path_v1(path: &CubicPathV1) -> Result<(), ValidationErrors> {
    let mut validator = Validator::default();
    validate_path_inner(path, "$", &mut validator);
    validator.finish()
}

fn validate_geometry(geometry: &SceneGeometryV1, path: &str, validator: &mut Validator) -> usize {
    match geometry {
        SceneGeometryV1::Circle { center, radius } => {
            validate_point(center, &format!("{path}.center"), validator);
            validate_positive(*radius, &format!("{path}.radius"), validator);
            if radius.is_finite() && *radius > MAX_COORDINATE_V1 {
                validator.issue(
                    format!("{path}.radius"),
                    "must be inside the v1 coordinate range",
                );
            }
            4
        }
        SceneGeometryV1::Rectangle {
            center,
            corner_radius,
            height,
            width,
        } => {
            validate_point(center, &format!("{path}.center"), validator);
            validate_positive(*height, &format!("{path}.height"), validator);
            validate_positive(*width, &format!("{path}.width"), validator);
            validate_finite(*corner_radius, &format!("{path}.cornerRadius"), validator);
            if corner_radius.is_finite() && *corner_radius < 0.0 {
                validator.issue(format!("{path}.cornerRadius"), "must be non-negative");
            }
            for (name, value) in [
                ("height", *height),
                ("width", *width),
                ("cornerRadius", *corner_radius),
            ] {
                if value.is_finite() && value > MAX_COORDINATE_V1 {
                    validator.issue(
                        format!("{path}.{name}"),
                        "must be inside the v1 coordinate range",
                    );
                }
            }
            if corner_radius.is_finite()
                && height.is_finite()
                && width.is_finite()
                && *corner_radius > height.min(*width) / 2.0
            {
                validator.issue(
                    format!("{path}.cornerRadius"),
                    "must fit inside the rectangle",
                );
            }
            if *corner_radius == 0.0 { 4 } else { 8 }
        }
        SceneGeometryV1::Line { end, start } => {
            validate_point(end, &format!("{path}.end"), validator);
            validate_point(start, &format!("{path}.start"), validator);
            1
        }
        SceneGeometryV1::CubicPath { path: cubic_path } => {
            let count = validate_path_inner(cubic_path, &format!("{path}.path"), validator);
            count
                + cubic_path
                    .subpaths
                    .iter()
                    .filter(|subpath| subpath.closed)
                    .count()
        }
        SceneGeometryV1::Group {} => 0,
        SceneGeometryV1::Image {
            asset, local_rect, ..
        } => {
            validate_asset_reference(asset, &format!("{path}.asset"), validator);
            validate_image_rect(local_rect, &format!("{path}.localRect"), validator);
            0
        }
    }
}

fn validate_easing(easing: &EasingV1, path: &str, validator: &mut Validator) {
    if let EasingV1::CubicBezier { x1, x2, y1, y2 } = easing {
        for (name, value) in [("x1", *x1), ("x2", *x2), ("y1", *y1), ("y2", *y2)] {
            validate_normalized(value, &format!("{path}.{name}"), validator);
        }
    }
}

fn validate_keyframes<T>(
    keyframes: &[KeyframeV1<T>],
    maximum: usize,
    duration: f64,
    path: &str,
    validator: &mut Validator,
    mut validate_value: impl FnMut(&T, &str, &mut Validator),
) {
    if keyframes.len() < 2 || keyframes.len() > maximum {
        validator.issue(
            path,
            format!("must contain between 2 and {maximum} keyframes"),
        );
    }
    for (index, keyframe) in keyframes.iter().enumerate() {
        let keyframe_path = format!("{path}[{index}]");
        validate_finite(keyframe.at, &format!("{keyframe_path}.at"), validator);
        if keyframe.at < 0.0 {
            validator.issue(format!("{keyframe_path}.at"), "must be non-negative");
        }
        if keyframe.at > duration {
            validator.issue(
                format!("{keyframe_path}.at"),
                "must not exceed scene duration",
            );
        }
        if index > 0 && keyframes[index - 1].at >= keyframe.at {
            validator.issue(
                format!("{keyframe_path}.at"),
                "keyframe times must be strictly increasing",
            );
        }
        let is_last = index + 1 == keyframes.len();
        match (&keyframe.easing_to_next, is_last) {
            (Some(_), true) => validator.issue(
                format!("{keyframe_path}.easingToNext"),
                "the final keyframe cannot define easingToNext",
            ),
            (None, false) => validator.issue(
                format!("{keyframe_path}.easingToNext"),
                "every non-final keyframe must define easingToNext",
            ),
            (Some(easing), false) => {
                validate_easing(easing, &format!("{keyframe_path}.easingToNext"), validator);
            }
            (None, true) => {}
        }
        validate_value(
            &keyframe.value,
            &format!("{keyframe_path}.value"),
            validator,
        );
    }
}

fn validate_camera_view(view: &SceneCameraViewV1, path: &str, validator: &mut Validator) {
    validate_point(&view.center, &format!("{path}.center"), validator);
    validate_positive(view.frame_height, &format!("{path}.frameHeight"), validator);
    validate_positive(view.frame_width, &format!("{path}.frameWidth"), validator);
    if view.frame_height.is_finite() && view.frame_height > MAX_COORDINATE_V1 {
        validator.issue(
            format!("{path}.frameHeight"),
            "must be inside the v1 coordinate range",
        );
    }
    if view.frame_width.is_finite() && view.frame_width > MAX_COORDINATE_V1 {
        validator.issue(
            format!("{path}.frameWidth"),
            "must be inside the v1 coordinate range",
        );
    }
}

fn validate_appearance(appearance: &SceneAppearanceV1, path: &str, validator: &mut Validator) {
    match appearance {
        SceneAppearanceV1::Group { opacity } | SceneAppearanceV1::Image { opacity } => {
            validate_normalized(*opacity, &format!("{path}.opacity"), validator);
        }
        SceneAppearanceV1::Vector {
            fill,
            opacity,
            stroke,
        } => {
            validate_normalized(*opacity, &format!("{path}.opacity"), validator);
            if let Some(fill) = fill {
                validate_fill(fill, &format!("{path}.fill"), validator);
            }
            if let Some(stroke) = stroke {
                validate_stroke(stroke, &format!("{path}.stroke"), validator);
            }
            if fill.is_none() && stroke.is_none() {
                validator.issue(path, "vector appearance requires a fill or stroke");
            }
        }
    }
}

fn lifetime_is_covered(lifetime: &IntervalV1, parent_lifetimes: &[IntervalV1]) -> bool {
    let mut covered_until = lifetime.start;
    for parent_lifetime in parent_lifetimes {
        if parent_lifetime.end <= covered_until {
            continue;
        }
        if parent_lifetime.start > covered_until {
            return false;
        }
        covered_until = parent_lifetime.end;
        if covered_until >= lifetime.end {
            return true;
        }
    }
    false
}

fn path_topology(path: &CubicPathV1) -> Vec<(bool, usize)> {
    path.subpaths
        .iter()
        .map(|subpath| (subpath.closed, subpath.segments.len()))
        .collect()
}

fn validate_scene_source(source: &SceneSourceV1, path: &str, validator: &mut Validator) {
    match source {
        SceneSourceV1::StudioEditProgram { revision_hash, .. } => {
            validate_sha256(revision_hash, &format!("{path}.revisionHash"), validator);
        }
        SceneSourceV1::ImportedManimServerSnapshot {
            runtime_config_hash,
            snapshot_hash,
            source_hash,
            ..
        } => {
            validate_sha256(
                runtime_config_hash,
                &format!("{path}.runtimeConfigHash"),
                validator,
            );
            validate_sha256(snapshot_hash, &format!("{path}.snapshotHash"), validator);
            validate_sha256(source_hash, &format!("{path}.sourceHash"), validator);
        }
    }
}

fn required_scene_capabilities(scene: &SceneIrV1) -> Vec<SceneCapabilityV1> {
    let mut capabilities = BTreeSet::new();
    for entity in &scene.entities {
        capabilities.insert(match entity.geometry {
            SceneGeometryV1::Group {} => SceneCapabilityV1::LogicalGroup,
            SceneGeometryV1::Image { .. } => SceneCapabilityV1::PngImage,
            SceneGeometryV1::CubicPath { .. } => SceneCapabilityV1::CubicPathGeometry,
            _ => SceneCapabilityV1::ShapePrimitives,
        });
    }
    for channel in &scene.animation_channels {
        capabilities.insert(match channel {
            AnimationChannelV1::AffineTransform { .. } => {
                SceneCapabilityV1::AffineTransformAnimation
            }
            AnimationChannelV1::Camera { .. } => SceneCapabilityV1::CameraAnimation,
            AnimationChannelV1::MotionPath { .. } => SceneCapabilityV1::MotionPathAnimation,
            AnimationChannelV1::Opacity { .. } => SceneCapabilityV1::OpacityAnimation,
            AnimationChannelV1::PathMorph { .. } => SceneCapabilityV1::PathMorphAnimation,
            AnimationChannelV1::PathTrim { .. } => SceneCapabilityV1::PathTrimAnimation,
            AnimationChannelV1::VectorAppearance { .. } => {
                SceneCapabilityV1::VectorAppearanceAnimation
            }
        });
    }
    capabilities.into_iter().collect()
}

/// Validates asset metadata, ordering, uniqueness, and aggregate resource limits.
///
/// This structural helper does not recompute `manifestDigest`; use
/// [`crate::validate_asset_manifest_digest_v1`] or a bundle validator for that check.
///
/// # Errors
///
/// Returns all detected v1 contract violations.
pub fn validate_asset_manifest_v1(manifest: &AssetManifestV1) -> Result<(), ValidationErrors> {
    let mut validator = Validator::default();
    validate_sha256(
        &manifest.manifest_digest,
        "$.manifestDigest",
        &mut validator,
    );
    validate_opaque_id(&manifest.manifest_id, "$.manifestId", &mut validator);
    if manifest.assets.len() > MAX_ASSETS_V1 {
        validator.issue(
            "$.assets",
            format!("accepts at most {MAX_ASSETS_V1} assets"),
        );
    }
    let mut ids = HashSet::new();
    let mut encoded_bytes = 0u64;
    let mut decoded_pixels = 0u64;
    for (index, asset) in manifest.assets.iter().enumerate() {
        let path = format!("$.assets[{index}]");
        validate_opaque_id(&asset.id, &format!("{path}.id"), &mut validator);
        validate_sha256(&asset.sha256, &format!("{path}.sha256"), &mut validator);
        if !ids.insert(asset.id.as_str()) {
            validator.issue(format!("{path}.id"), format!("duplicate ID {}", asset.id));
        }
        if index > 0 && manifest.assets[index - 1].id >= asset.id {
            validator.issue(
                format!("{path}.id"),
                "assets must be sorted by portable ASCII ID",
            );
        }
        if asset.byte_length == 0 || asset.byte_length > 134_217_728 {
            validator.issue(
                format!("{path}.byteLength"),
                "must be between 1 and 134217728 bytes",
            );
        }
        if asset.pixel_height == 0 || asset.pixel_height > 16_384 {
            validator.issue(format!("{path}.pixelHeight"), "must be between 1 and 16384");
        }
        if asset.pixel_width == 0 || asset.pixel_width > 16_384 {
            validator.issue(format!("{path}.pixelWidth"), "must be between 1 and 16384");
        }
        let pixels = u64::from(asset.pixel_width) * u64::from(asset.pixel_height);
        if pixels > MAX_IMAGE_PIXELS_V1 {
            validator.issue(
                path.clone(),
                format!("decoded image exceeds {MAX_IMAGE_PIXELS_V1} pixels"),
            );
        }
        encoded_bytes = encoded_bytes.saturating_add(asset.byte_length);
        decoded_pixels = decoded_pixels.saturating_add(pixels);
    }
    if encoded_bytes > MAX_ENCODED_ASSET_BYTES_V1 {
        validator.issue("$.assets", "manifest exceeds the total encoded-byte limit");
    }
    if decoded_pixels > MAX_TOTAL_IMAGE_PIXELS_V1 {
        validator.issue("$.assets", "manifest exceeds the total decoded-pixel limit");
    }
    validator.finish()
}

/// Validates all Scene IR structural, semantic, hierarchy, and resource invariants.
///
/// # Errors
///
/// Returns all detected v1 contract violations.
#[allow(clippy::too_many_lines)]
pub fn validate_scene_ir_v1(scene: &SceneIrV1) -> Result<(), ValidationErrors> {
    let mut validator = Validator::default();
    validate_source_identity(&scene.scene_id, "$.sceneId", &mut validator);
    validate_manifest_reference(&scene.asset_manifest, "$.assetManifest", &mut validator);
    validate_positive(scene.duration, "$.duration", &mut validator);
    validate_color(
        &scene.camera.background,
        "$.camera.background",
        &mut validator,
    );
    validate_camera_view(&scene.camera.view, "$.camera.view", &mut validator);
    validate_scene_source(&scene.source, "$.source", &mut validator);

    match &scene.fidelity {
        FidelityV1::Exact {} => {}
        FidelityV1::Approximate { evidence } => {
            if evidence.is_empty() || evidence.len() > 64 {
                validator.issue(
                    "$.fidelity.evidence",
                    "approximate fidelity requires 1 to 64 evidence entries",
                );
            }
            for (index, item) in evidence.iter().enumerate() {
                validate_evidence(
                    item,
                    &format!("$.fidelity.evidence[{index}]"),
                    &mut validator,
                );
            }
        }
    }

    if scene.provenance.is_empty() || scene.provenance.len() > MAX_ENTITIES_V1 + MAX_CHANNELS_V1 {
        validator.issue(
            "$.provenance",
            format!(
                "must contain between 1 and {} records",
                MAX_ENTITIES_V1 + MAX_CHANNELS_V1
            ),
        );
    }
    let mut provenance_ids = HashSet::new();
    for (index, record) in scene.provenance.iter().enumerate() {
        let path = format!("$.provenance[{index}]");
        validate_source_identity(&record.id, &format!("{path}.id"), &mut validator);
        if !provenance_ids.insert(record.id.as_str()) {
            validator.issue(format!("{path}.id"), format!("duplicate ID {}", record.id));
        }
        if record.evidence.len() > 64 {
            validator.issue(format!("{path}.evidence"), "accepts at most 64 entries");
        }
        for (evidence_index, evidence) in record.evidence.iter().enumerate() {
            validate_evidence(
                evidence,
                &format!("{path}.evidence[{evidence_index}]"),
                &mut validator,
            );
        }
    }

    if scene.entities.len() > MAX_ENTITIES_V1 {
        validator.issue(
            "$.entities",
            format!("accepts at most {MAX_ENTITIES_V1} entities"),
        );
    }
    let mut entity_ids = HashSet::new();
    let mut entity_indexes = HashMap::new();
    for (index, entity) in scene.entities.iter().enumerate() {
        entity_indexes.insert(entity.id.as_str(), index);
        if !entity_ids.insert(entity.id.as_str()) {
            validator.issue(
                format!("$.entities[{index}].id"),
                format!("duplicate ID {}", entity.id),
            );
        }
    }
    let mut scene_orders = HashSet::new();
    let mut total_segments = 0usize;
    for (index, entity) in scene.entities.iter().enumerate() {
        let path = format!("$.entities[{index}]");
        validate_source_identity(&entity.id, &format!("{path}.id"), &mut validator);
        validate_source_identity(
            &entity.provenance_id,
            &format!("{path}.provenanceId"),
            &mut validator,
        );
        if !provenance_ids.contains(entity.provenance_id.as_str()) {
            validator.issue(
                format!("{path}.provenanceId"),
                format!("unknown provenance record {}", entity.provenance_id),
            );
        }
        if entity.scene_order as usize >= MAX_ENTITIES_V1 {
            validator.issue(
                format!("{path}.sceneOrder"),
                format!("must be less than {MAX_ENTITIES_V1}"),
            );
        }
        if !scene_orders.insert(entity.scene_order) {
            validator.issue(
                format!("{path}.sceneOrder"),
                format!("duplicate sceneOrder {}", entity.scene_order),
            );
        }
        validate_finite(
            entity.source_z_index,
            &format!("{path}.sourceZIndex"),
            &mut validator,
        );
        validate_transform(
            &entity.transform,
            &format!("{path}.transform"),
            &mut validator,
        );
        total_segments = total_segments.saturating_add(validate_geometry(
            &entity.geometry,
            &format!("{path}.geometry"),
            &mut validator,
        ));
        validate_appearance(
            &entity.appearance,
            &format!("{path}.appearance"),
            &mut validator,
        );
        let appearance_matches_geometry = matches!(
            (&entity.geometry, &entity.appearance),
            (SceneGeometryV1::Group {}, SceneAppearanceV1::Group { .. })
                | (
                    SceneGeometryV1::Image { .. },
                    SceneAppearanceV1::Image { .. }
                )
                | (
                    SceneGeometryV1::Circle { .. }
                        | SceneGeometryV1::Rectangle { .. }
                        | SceneGeometryV1::Line { .. }
                        | SceneGeometryV1::CubicPath { .. },
                    SceneAppearanceV1::Vector { .. }
                )
        );
        if !appearance_matches_geometry {
            validator.issue(
                format!("{path}.appearance"),
                "appearance must match the geometry kind",
            );
        }
        if matches!(entity.geometry, SceneGeometryV1::Line { .. })
            && !matches!(
                entity.appearance,
                SceneAppearanceV1::Vector {
                    stroke: Some(_),
                    ..
                }
            )
        {
            validator.issue(
                format!("{path}.appearance.stroke"),
                "line entities require a stroke",
            );
        }
        if let Some(parent_id) = &entity.parent_id {
            validate_source_identity(parent_id, &format!("{path}.parentId"), &mut validator);
            if !entity_indexes.contains_key(parent_id.as_str()) {
                validator.issue(
                    format!("{path}.parentId"),
                    format!("unknown parent entity {parent_id}"),
                );
            }
        }
        if entity.lifetimes.is_empty() || entity.lifetimes.len() > 64 {
            validator.issue(
                format!("{path}.lifetimes"),
                "must contain between 1 and 64 intervals",
            );
        }
        for (lifetime_index, lifetime) in entity.lifetimes.iter().enumerate() {
            let lifetime_path = format!("{path}.lifetimes[{lifetime_index}]");
            validate_finite(
                lifetime.start,
                &format!("{lifetime_path}.start"),
                &mut validator,
            );
            validate_finite(
                lifetime.end,
                &format!("{lifetime_path}.end"),
                &mut validator,
            );
            if lifetime.start < 0.0 || lifetime.end <= lifetime.start {
                validator.issue(
                    lifetime_path.clone(),
                    "must have positive non-negative duration",
                );
            }
            if lifetime.end > scene.duration {
                validator.issue(
                    format!("{lifetime_path}.end"),
                    "must not exceed scene duration",
                );
            }
            if lifetime_index > 0 && entity.lifetimes[lifetime_index - 1].end > lifetime.start {
                validator.issue(
                    lifetime_path.clone(),
                    "lifetimes must be ordered and non-overlapping",
                );
            }
            if let Some(parent_id) = &entity.parent_id {
                if let Some(parent_index) = entity_indexes.get(parent_id.as_str()) {
                    if !lifetime_is_covered(lifetime, &scene.entities[*parent_index].lifetimes) {
                        validator.issue(
                            lifetime_path,
                            "child lifetime must be contained by a parent lifetime",
                        );
                    }
                }
            }
        }
    }

    let mut hierarchy_state: HashMap<&str, u8> = HashMap::new();
    for entity in &scene.entities {
        if hierarchy_state.get(entity.id.as_str()) == Some(&2) {
            continue;
        }
        let mut chain = Vec::new();
        let mut current = Some(entity.id.as_str());
        while let Some(current_id) = current {
            match hierarchy_state.get(current_id) {
                Some(1) => {
                    validator.issue("$.entities", "entity hierarchy must not contain a cycle");
                    break;
                }
                Some(2) => break,
                _ => {}
            }
            hierarchy_state.insert(current_id, 1);
            chain.push(current_id);
            current = entity_indexes
                .get(current_id)
                .and_then(|index| scene.entities[*index].parent_id.as_deref());
        }
        for id in chain {
            hierarchy_state.insert(id, 2);
        }
    }

    if scene.animation_channels.len() > MAX_CHANNELS_V1 {
        validator.issue(
            "$.animationChannels",
            format!("accepts at most {MAX_CHANNELS_V1} channels"),
        );
    }
    let mut channel_ids = HashSet::new();
    let mut channel_targets = HashSet::new();
    let mut total_keyframes = 0usize;
    let mut camera_channels = 0usize;
    for (index, channel) in scene.animation_channels.iter().enumerate() {
        let path = format!("$.animationChannels[{index}]");
        validate_source_identity(channel.id(), &format!("{path}.id"), &mut validator);
        validate_source_identity(
            channel.provenance_id(),
            &format!("{path}.provenanceId"),
            &mut validator,
        );
        if !channel_ids.insert(channel.id()) {
            validator.issue(
                format!("{path}.id"),
                format!("duplicate ID {}", channel.id()),
            );
        }
        if !provenance_ids.contains(channel.provenance_id()) {
            validator.issue(
                format!("{path}.provenanceId"),
                format!("unknown provenance record {}", channel.provenance_id()),
            );
        }
        let target = channel.entity_id().map_or_else(
            || "camera".to_owned(),
            |id| format!("{id}/{}", channel.kind_name()),
        );
        if !channel_targets.insert(target.clone()) {
            validator.issue(
                path.clone(),
                format!("duplicate animation channel target {target}"),
            );
        }
        if let Some(entity_id) = channel.entity_id() {
            validate_source_identity(entity_id, &format!("{path}.entityId"), &mut validator);
            if !entity_indexes.contains_key(entity_id) {
                validator.issue(
                    format!("{path}.entityId"),
                    format!("unknown animated entity {entity_id}"),
                );
            }
        }

        match channel {
            AnimationChannelV1::AffineTransform { keyframes, .. } => {
                total_keyframes = total_keyframes.saturating_add(keyframes.len());
                validate_keyframes(
                    keyframes,
                    MAX_KEYFRAMES_V1,
                    scene.duration,
                    &format!("{path}.keyframes"),
                    &mut validator,
                    validate_transform,
                );
            }
            AnimationChannelV1::Opacity {
                entity_id,
                keyframes,
                ..
            }
            | AnimationChannelV1::PathTrim {
                entity_id,
                keyframes,
                ..
            } => {
                total_keyframes = total_keyframes.saturating_add(keyframes.len());
                validate_keyframes(
                    keyframes,
                    MAX_KEYFRAMES_V1,
                    scene.duration,
                    &format!("{path}.keyframes"),
                    &mut validator,
                    |value, value_path, validator| {
                        validate_normalized(*value, value_path, validator);
                    },
                );
                if matches!(channel, AnimationChannelV1::PathTrim { .. }) {
                    if let Some(entity_index) = entity_indexes.get(entity_id.as_str()) {
                        let entity = &scene.entities[*entity_index];
                        if !matches!(entity.appearance, SceneAppearanceV1::Vector { .. }) {
                            validator.issue(
                                format!("{path}.entityId"),
                                "path-trim requires vector geometry",
                            );
                        }
                        if matches!(
                            entity.appearance,
                            SceneAppearanceV1::Vector { fill: Some(_), .. }
                        ) {
                            validator.issue(
                                format!("{path}.entityId"),
                                "path-trim v1 requires stroke-only vector appearance",
                            );
                        }
                    }
                }
            }
            AnimationChannelV1::PathMorph {
                entity_id,
                keyframes,
                ..
            } => {
                total_keyframes = total_keyframes.saturating_add(keyframes.len());
                let topology = entity_indexes
                    .get(entity_id.as_str())
                    .and_then(
                        |entity_index| match &scene.entities[*entity_index].geometry {
                            SceneGeometryV1::CubicPath { path } => Some(path_topology(path)),
                            _ => None,
                        },
                    );
                if entity_indexes.contains_key(entity_id.as_str()) && topology.is_none() {
                    validator.issue(
                        format!("{path}.entityId"),
                        "path-morph requires canonical cubic-path entity geometry",
                    );
                }
                validate_keyframes(
                    keyframes,
                    256,
                    scene.duration,
                    &format!("{path}.keyframes"),
                    &mut validator,
                    |value, value_path, validator| {
                        total_segments = total_segments
                            .saturating_add(validate_path_inner(value, value_path, validator));
                        if topology
                            .as_ref()
                            .is_some_and(|expected| *expected != path_topology(value))
                        {
                            validator.issue(
                                value_path,
                                "path morph keyframes must have matching cubic topology",
                            );
                        }
                    },
                );
            }
            AnimationChannelV1::VectorAppearance {
                entity_id,
                keyframes,
                ..
            } => {
                total_keyframes = total_keyframes.saturating_add(keyframes.len());
                let base = entity_indexes
                    .get(entity_id.as_str())
                    .and_then(
                        |entity_index| match &scene.entities[*entity_index].appearance {
                            SceneAppearanceV1::Vector { fill, stroke, .. } => {
                                Some((fill.as_ref(), stroke.as_ref()))
                            }
                            SceneAppearanceV1::Group { .. } | SceneAppearanceV1::Image { .. } => {
                                None
                            }
                        },
                    );
                if entity_indexes.contains_key(entity_id.as_str()) && base.is_none() {
                    validator.issue(
                        format!("{path}.entityId"),
                        "vector-appearance requires vector geometry and appearance",
                    );
                }
                let first = keyframes.first().map(|keyframe| &keyframe.value);
                if let (Some((base_fill, base_stroke)), Some(first)) = (base, first) {
                    match (base_fill, &first.fill) {
                        (None, Some(fill)) if fill.color.alpha != 0.0 => validator.issue(
                            format!("{path}.keyframes[0].value.fill"),
                            "vector-appearance may materialize an absent base fill only as an explicit transparent solid fill",
                        ),
                        (Some(_), None) => validator.issue(
                            format!("{path}.keyframes[0].value.fill"),
                            "vector-appearance cannot discard the entity base fill",
                        ),
                        (Some(base_fill), Some(fill)) if base_fill.rule != fill.rule => validator.issue(
                            format!("{path}.keyframes[0].value.fill.rule"),
                            "vector-appearance cannot transition between fill rules",
                        ),
                        (None, None | Some(_)) | (Some(_), Some(_)) => {}
                    }
                    match (base_stroke, &first.stroke) {
                        (None, Some(stroke)) if stroke.color.alpha != 0.0 => validator.issue(
                            format!("{path}.keyframes[0].value.stroke"),
                            "vector-appearance may materialize an absent base stroke only as an explicit transparent solid stroke",
                        ),
                        (Some(_), None) => validator.issue(
                            format!("{path}.keyframes[0].value.stroke"),
                            "vector-appearance cannot discard the entity base stroke",
                        ),
                        (Some(base_stroke), Some(stroke))
                            if base_stroke.cap != stroke.cap
                                || base_stroke.join != stroke.join
                                || base_stroke.miter_limit.to_bits()
                                    != stroke.miter_limit.to_bits() =>
                        {
                            validator.issue(
                                format!("{path}.keyframes[0].value.stroke"),
                                "vector-appearance cannot transition between stroke cap, join, or miter-limit styles",
                            );
                        }
                        (None, None | Some(_)) | (Some(_), Some(_)) => {}
                    }
                }
                validate_keyframes(
                    keyframes,
                    MAX_KEYFRAMES_V1,
                    scene.duration,
                    &format!("{path}.keyframes"),
                    &mut validator,
                    |value, value_path, validator| {
                        if value.fill.is_none() && value.stroke.is_none() {
                            validator.issue(
                                value_path,
                                "vector appearance keyframe requires a fill or stroke",
                            );
                        }
                        if let Some(fill) = &value.fill {
                            validate_fill(fill, &format!("{value_path}.fill"), validator);
                        }
                        if let Some(stroke) = &value.stroke {
                            validate_stroke(stroke, &format!("{value_path}.stroke"), validator);
                        }
                        if let Some(first) = first {
                            if value.fill.is_some() != first.fill.is_some() {
                                validator.issue(
                                    format!("{value_path}.fill"),
                                    "vector-appearance cannot transition between absent and solid fill",
                                );
                            } else if let (Some(fill), Some(first_fill)) =
                                (&value.fill, &first.fill)
                                && fill.rule != first_fill.rule
                            {
                                validator.issue(
                                    format!("{value_path}.fill.rule"),
                                    "vector-appearance cannot transition between fill rules",
                                );
                            }
                            if value.stroke.is_some() != first.stroke.is_some() {
                                validator.issue(
                                    format!("{value_path}.stroke"),
                                    "vector-appearance cannot transition between absent and solid stroke",
                                );
                            } else if let (Some(stroke), Some(first_stroke)) =
                                (&value.stroke, &first.stroke)
                                && (stroke.cap != first_stroke.cap
                                    || stroke.join != first_stroke.join
                                    || stroke.miter_limit.to_bits()
                                        != first_stroke.miter_limit.to_bits())
                            {
                                validator.issue(
                                    format!("{value_path}.stroke"),
                                    "vector-appearance cannot transition between stroke cap, join, or miter-limit styles",
                                );
                            }
                        }
                    },
                );
            }
            AnimationChannelV1::MotionPath {
                keyframes,
                orient_to_path,
                parameterization,
                path: motion_path,
                ..
            } => {
                total_keyframes = total_keyframes.saturating_add(keyframes.len());
                validate_keyframes(
                    keyframes,
                    MAX_KEYFRAMES_V1,
                    scene.duration,
                    &format!("{path}.keyframes"),
                    &mut validator,
                    |value, value_path, validator| {
                        validate_normalized(*value, value_path, validator);
                    },
                );
                total_segments = total_segments.saturating_add(validate_path_inner(
                    motion_path,
                    &format!("{path}.path"),
                    &mut validator,
                ));
                if motion_path.subpaths.len() != 1 {
                    validator.issue(
                        format!("{path}.path.subpaths"),
                        "motion-path v1 requires exactly one cubic subpath",
                    );
                }
                if matches!(
                    parameterization,
                    Some(crate::model::MotionPathParameterizationV1::ManimPointFromProportionV1)
                ) && *orient_to_path
                {
                    validator.issue(
                        format!("{path}.orientToPath"),
                        "manim-point-from-proportion-v1 does not orient the moved entity",
                    );
                }
            }
            AnimationChannelV1::Camera { keyframes, .. } => {
                camera_channels += 1;
                total_keyframes = total_keyframes.saturating_add(keyframes.len());
                validate_keyframes(
                    keyframes,
                    MAX_KEYFRAMES_V1,
                    scene.duration,
                    &format!("{path}.keyframes"),
                    &mut validator,
                    validate_camera_view,
                );
            }
        }
    }
    if camera_channels > 1 {
        validator.issue(
            "$.animationChannels",
            "scene IR accepts at most one camera animation channel",
        );
    }
    if total_keyframes > MAX_KEYFRAMES_V1 {
        validator.issue(
            "$.animationChannels",
            format!("scene IR accepts at most {MAX_KEYFRAMES_V1} total keyframes"),
        );
    }
    if total_segments > MAX_TOTAL_PATH_SEGMENTS_V1 {
        validator.issue(
            "$",
            format!("scene IR accepts at most {MAX_TOTAL_PATH_SEGMENTS_V1} total cubic segments"),
        );
    }

    let expected_capabilities = required_scene_capabilities(scene);
    if scene.required_capabilities != expected_capabilities {
        validator.issue(
            "$.requiredCapabilities",
            "must exactly equal the capabilities derived from scene content",
        );
    }
    validator.finish()
}

fn required_render_capabilities(packet: &RenderPacketV1) -> Vec<RenderCapabilityV1> {
    let mut capabilities = BTreeSet::new();
    for draw in &packet.draws {
        match draw {
            RenderDrawV1::Empty { .. } => {}
            RenderDrawV1::Path { fill, stroke, .. } => {
                if fill.is_some() {
                    capabilities.insert(RenderCapabilityV1::CubicPathFill);
                }
                if stroke.is_some() {
                    capabilities.insert(RenderCapabilityV1::CubicPathStroke);
                }
            }
            RenderDrawV1::Image { .. } => {
                capabilities.insert(RenderCapabilityV1::PngImage);
            }
        }
    }
    capabilities.into_iter().collect()
}

/// Validates all render packet structural, semantic, ordering, and resource invariants.
///
/// # Errors
///
/// Returns all detected v1 contract violations.
#[allow(clippy::too_many_lines)]
pub fn validate_render_packet_v1(packet: &RenderPacketV1) -> Result<(), ValidationErrors> {
    let mut validator = Validator::default();
    validate_manifest_reference(&packet.asset_manifest, "$.assetManifest", &mut validator);
    validate_opaque_id(&packet.packet_id, "$.packetId", &mut validator);
    validate_source_identity(&packet.scene_id, "$.sceneId", &mut validator);
    validate_sha256(
        &packet.scene_revision_hash,
        "$.sceneRevisionHash",
        &mut validator,
    );
    validate_finite(packet.sample_time, "$.sampleTime", &mut validator);
    if packet.sample_time < 0.0 {
        validator.issue("$.sampleTime", "must be non-negative");
    }
    validate_positive(packet.scene_duration, "$.sceneDuration", &mut validator);
    if packet.sample_time > packet.scene_duration {
        validator.issue("$.sampleTime", "must not exceed sceneDuration");
    }
    if packet.evidence.len() > 64 {
        validator.issue("$.evidence", "accepts at most 64 entries");
    }
    for (index, evidence) in packet.evidence.iter().enumerate() {
        validate_evidence(evidence, &format!("$.evidence[{index}]"), &mut validator);
    }

    validate_coordinate(packet.camera.bottom, "$.camera.bottom", &mut validator);
    validate_coordinate(packet.camera.left, "$.camera.left", &mut validator);
    validate_coordinate(packet.camera.right, "$.camera.right", &mut validator);
    validate_coordinate(packet.camera.top, "$.camera.top", &mut validator);
    validate_color(
        &packet.camera.clear_color,
        "$.camera.clearColor",
        &mut validator,
    );
    if packet.camera.right <= packet.camera.left || packet.camera.top <= packet.camera.bottom {
        validator.issue("$.camera", "extents must have positive width and height");
    }
    if packet.viewport.height_px == 0 || packet.viewport.height_px > 16_384 {
        validator.issue("$.viewport.heightPx", "must be between 1 and 16384");
    }
    if packet.viewport.width_px == 0 || packet.viewport.width_px > 16_384 {
        validator.issue("$.viewport.widthPx", "must be between 1 and 16384");
    }
    let viewport_pixels =
        u64::from(packet.viewport.height_px) * u64::from(packet.viewport.width_px);
    if viewport_pixels > MAX_VIEWPORT_PIXELS_V1 {
        validator.issue("$.viewport", "exceeds the viewport pixel limit");
    }
    let camera_width = packet.camera.right - packet.camera.left;
    let camera_height = packet.camera.top - packet.camera.bottom;
    if camera_width > 0.0
        && camera_height > 0.0
        && packet.viewport.height_px > 0
        && packet.viewport.width_px > 0
    {
        let camera_aspect = camera_width / camera_height;
        let viewport_aspect =
            f64::from(packet.viewport.width_px) / f64::from(packet.viewport.height_px);
        if (camera_aspect / viewport_aspect - 1.0).abs() > 0.000_001 {
            validator.issue("$.camera", "camera and viewport aspect ratios must match");
        }
    }

    if packet.draws.len() > MAX_DRAWS_V1 {
        validator.issue("$.draws", format!("accepts at most {MAX_DRAWS_V1} draws"));
    }
    let mut draw_ids = HashSet::new();
    let mut total_segments = 0usize;
    for (index, draw) in packet.draws.iter().enumerate() {
        let path = format!("$.draws[{index}]");
        validate_opaque_id(draw.draw_id(), &format!("{path}.drawId"), &mut validator);
        validate_source_identity(
            draw.entity_id(),
            &format!("{path}.entityId"),
            &mut validator,
        );
        if !draw_ids.insert(draw.draw_id()) {
            validator.issue(
                format!("{path}.drawId"),
                format!("duplicate draw ID {}", draw.draw_id()),
            );
        }
        validate_normalized(draw.opacity(), &format!("{path}.opacity"), &mut validator);
        validate_finite(
            draw.source_z_index(),
            &format!("{path}.sourceZIndex"),
            &mut validator,
        );
        if draw.paint_order() as usize != index {
            validator.issue(
                format!("{path}.paintOrder"),
                "must equal the back-to-front array index",
            );
        }
        match draw {
            RenderDrawV1::Empty {
                reason, transform, ..
            } => {
                validate_transform(transform, &format!("{path}.transform"), &mut validator);
                if *reason == RenderEmptyReasonV1::SingularAffineSample
                    && !affine_transform_is_singular_v1(transform)
                {
                    validator.issue(
                        format!("{path}.transform"),
                        "singular-affine-sample requires a singular or \
                         near-singular transform",
                    );
                }
            }
            RenderDrawV1::Path {
                fill,
                path: cubic_path,
                stroke,
                transform,
                ..
            } => {
                validate_transform(transform, &format!("{path}.transform"), &mut validator);
                total_segments = total_segments.saturating_add(validate_path_inner(
                    cubic_path,
                    &format!("{path}.path"),
                    &mut validator,
                ));
                if let Some(fill) = fill {
                    validate_fill(fill, &format!("{path}.fill"), &mut validator);
                }
                if let Some(stroke) = stroke {
                    validate_stroke(stroke, &format!("{path}.stroke"), &mut validator);
                }
                if fill.is_none() && stroke.is_none() {
                    validator.issue(path, "path draws require a fill or stroke");
                }
            }
            RenderDrawV1::Image {
                asset,
                local_rect,
                transform,
                ..
            } => {
                if packet.compositing == RenderCompositingV1::ManimCairoSrgb {
                    validator.issue(
                        format!("{path}.kind"),
                        "manim-cairo-srgb compositing does not support image draws",
                    );
                }
                validate_asset_reference(asset, &format!("{path}.asset"), &mut validator);
                validate_image_rect(local_rect, &format!("{path}.localRect"), &mut validator);
                validate_transform(transform, &format!("{path}.transform"), &mut validator);
            }
        }
    }
    if total_segments > MAX_TOTAL_PATH_SEGMENTS_V1 {
        validator.issue(
            "$.draws",
            format!("accepts at most {MAX_TOTAL_PATH_SEGMENTS_V1} total cubic segments"),
        );
    }
    let expected_capabilities = required_render_capabilities(packet);
    if packet.required_capabilities != expected_capabilities {
        validator.issue(
            "$.requiredCapabilities",
            "must exactly equal the capabilities derived from packet draws",
        );
    }
    validator.finish()
}
