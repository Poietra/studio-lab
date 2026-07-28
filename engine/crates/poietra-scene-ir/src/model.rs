use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const JAVASCRIPT_MAX_SAFE_INTEGER_F64: f64 = 9_007_199_254_740_991.0;

fn deserialize_js_safe_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    let number = serde_json::Number::deserialize(deserializer)?;
    if let Some(value) = number.as_u64() {
        return (value <= JAVASCRIPT_MAX_SAFE_INTEGER)
            .then_some(value)
            .ok_or_else(|| de::Error::custom("integer exceeds the JavaScript safe range"));
    }
    let value = number
        .as_f64()
        .filter(|value| {
            value.is_finite()
                && *value >= 0.0
                && value.fract() == 0.0
                && *value <= JAVASCRIPT_MAX_SAFE_INTEGER_F64
        })
        .ok_or_else(|| de::Error::custom("expected a non-negative JavaScript-safe integer"))?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(value as u64)
}

fn deserialize_js_safe_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = deserialize_js_safe_u64(deserializer)?;
    u32::try_from(value).map_err(|_| de::Error::custom("integer exceeds the u32 range"))
}

/// The only wire contract version accepted by this crate.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ContractVersionV1;

impl Serialize for ContractVersionV1 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(1)
    }
}

impl<'de> Deserialize<'de> for ContractVersionV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let version = deserialize_js_safe_u64(deserializer)?;
        if version == 1 {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!(
                "unsupported contract version {version}; expected 1"
            )))
        }
    }
}

/// The fast-manim snapshot profile carried inside the Scene IR v1 envelope.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SnapshotProfileVersionV1 {
    #[default]
    V1,
    V2,
}

impl Serialize for SnapshotProfileVersionV1 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u8(match self {
            Self::V1 => 1,
            Self::V2 => 2,
        })
    }
}

impl<'de> Deserialize<'de> for SnapshotProfileVersionV1 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match deserialize_js_safe_u64(deserializer)? {
            1 => Ok(Self::V1),
            2 => Ok(Self::V2),
            version => Err(de::Error::custom(format!(
                "unsupported fast-manim snapshot profile version {version}; expected 1 or 2"
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointV1 {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AffineTransformV1 {
    pub m11: f64,
    pub m12: f64,
    pub m21: f64,
    pub m22: f64,
    pub tx: f64,
    pub ty: f64,
}

impl AffineTransformV1 {
    #[must_use]
    pub const fn identity() -> Self {
        Self {
            m11: 1.0,
            m12: 0.0,
            m21: 0.0,
            m22: 1.0,
            tx: 0.0,
            ty: 0.0,
        }
    }
}

impl Default for AffineTransformV1 {
    fn default() -> Self {
        Self::identity()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RgbaColorV1 {
    pub alpha: f64,
    pub blue: f64,
    pub green: f64,
    pub red: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CubicSegmentV1 {
    pub control1: PointV1,
    pub control2: PointV1,
    pub end: PointV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CubicSubpathV1 {
    pub closed: bool,
    pub segments: Vec<CubicSegmentV1>,
    pub start: PointV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CubicPathV1 {
    pub subpaths: Vec<CubicSubpathV1>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetReferenceV1 {
    pub asset_id: String,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetManifestReferenceV1 {
    pub manifest_digest: String,
    pub manifest_id: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum FillRuleV1 {
    #[serde(rename = "evenodd")]
    EvenOdd,
    #[default]
    #[serde(rename = "nonzero")]
    NonZero,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FillStyleV1 {
    pub color: RgbaColorV1,
    pub rule: FillRuleV1,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StrokeCapV1 {
    #[default]
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StrokeJoinV1 {
    Bevel,
    #[default]
    Miter,
    Round,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StrokeStyleV1 {
    pub cap: StrokeCapV1,
    pub color: RgbaColorV1,
    pub join: StrokeJoinV1,
    pub miter_limit: f64,
    pub width_world: f64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum AssetAlphaModeV1 {
    #[default]
    #[serde(rename = "straight")]
    Straight,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum AssetColorSpaceV1 {
    #[default]
    #[serde(rename = "srgb")]
    Srgb,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum PngAssetKindV1 {
    #[default]
    #[serde(rename = "png-image")]
    PngImage,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum PngMediaTypeV1 {
    #[default]
    #[serde(rename = "image/png")]
    ImagePng,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PngAssetV1 {
    pub alpha_mode: AssetAlphaModeV1,
    #[serde(deserialize_with = "deserialize_js_safe_u64")]
    pub byte_length: u64,
    pub color_space: AssetColorSpaceV1,
    pub id: String,
    pub kind: PngAssetKindV1,
    pub media_type: PngMediaTypeV1,
    #[serde(deserialize_with = "deserialize_js_safe_u32")]
    pub pixel_height: u32,
    #[serde(deserialize_with = "deserialize_js_safe_u32")]
    pub pixel_width: u32,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum AssetManifestSchemaV1 {
    #[default]
    #[serde(rename = "poietra.asset-manifest")]
    AssetManifest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetManifestV1 {
    pub assets: Vec<PngAssetV1>,
    pub manifest_digest: String,
    pub manifest_id: String,
    pub schema: AssetManifestSchemaV1,
    pub version: ContractVersionV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntervalV1 {
    pub end: f64,
    pub start: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SceneGeometryV1 {
    #[serde(rename = "circle")]
    Circle { center: PointV1, radius: f64 },
    #[serde(rename = "rectangle")]
    Rectangle {
        center: PointV1,
        #[serde(rename = "cornerRadius")]
        corner_radius: f64,
        height: f64,
        width: f64,
    },
    #[serde(rename = "line")]
    Line { end: PointV1, start: PointV1 },
    #[serde(rename = "cubic-path")]
    CubicPath { path: CubicPathV1 },
    #[serde(rename = "image")]
    Image {
        asset: AssetReferenceV1,
        #[serde(rename = "localRect")]
        local_rect: ImageLocalRectV1,
        sampler: ImageSamplerV1,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageLocalRectV1 {
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
    pub top: f64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageSamplerV1 {
    #[default]
    Linear,
    Nearest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SceneAppearanceV1 {
    #[serde(rename = "vector")]
    Vector {
        fill: Option<FillStyleV1>,
        opacity: f64,
        stroke: Option<StrokeStyleV1>,
    },
    #[serde(rename = "image")]
    Image { opacity: f64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneEntityV1 {
    pub appearance: SceneAppearanceV1,
    pub geometry: SceneGeometryV1,
    pub id: String,
    pub lifetimes: Vec<IntervalV1>,
    pub parent_id: Option<String>,
    pub provenance_id: String,
    #[serde(deserialize_with = "deserialize_js_safe_u32")]
    pub scene_order: u32,
    pub source_z_index: f64,
    pub transform: AffineTransformV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum EasingV1 {
    #[serde(rename = "linear")]
    Linear {},
    #[serde(rename = "smooth")]
    Smooth {},
    #[serde(rename = "cubic-bezier")]
    CubicBezier { x1: f64, x2: f64, y1: f64, y2: f64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyframeV1<T> {
    pub at: f64,
    pub easing_to_next: Option<EasingV1>,
    pub value: T,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneCameraViewV1 {
    pub center: PointV1,
    #[serde(rename = "frameHeight")]
    pub frame_height: f64,
    #[serde(rename = "frameWidth")]
    pub frame_width: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum AnimationChannelV1 {
    #[serde(rename = "affine-transform")]
    AffineTransform {
        #[serde(rename = "entityId")]
        entity_id: String,
        id: String,
        keyframes: Vec<KeyframeV1<AffineTransformV1>>,
        #[serde(rename = "provenanceId")]
        provenance_id: String,
    },
    #[serde(rename = "opacity")]
    Opacity {
        #[serde(rename = "entityId")]
        entity_id: String,
        id: String,
        keyframes: Vec<KeyframeV1<f64>>,
        #[serde(rename = "provenanceId")]
        provenance_id: String,
    },
    #[serde(rename = "path-trim")]
    PathTrim {
        #[serde(rename = "entityId")]
        entity_id: String,
        id: String,
        keyframes: Vec<KeyframeV1<f64>>,
        #[serde(rename = "provenanceId")]
        provenance_id: String,
    },
    #[serde(rename = "path-morph")]
    PathMorph {
        #[serde(rename = "entityId")]
        entity_id: String,
        id: String,
        keyframes: Vec<KeyframeV1<CubicPathV1>>,
        #[serde(rename = "provenanceId")]
        provenance_id: String,
    },
    #[serde(rename = "motion-path")]
    MotionPath {
        #[serde(rename = "entityId")]
        entity_id: String,
        id: String,
        keyframes: Vec<KeyframeV1<f64>>,
        #[serde(rename = "orientToPath")]
        orient_to_path: bool,
        path: CubicPathV1,
        #[serde(rename = "provenanceId")]
        provenance_id: String,
    },
    #[serde(rename = "camera")]
    Camera {
        id: String,
        keyframes: Vec<KeyframeV1<SceneCameraViewV1>>,
        #[serde(rename = "provenanceId")]
        provenance_id: String,
    },
}

impl AnimationChannelV1 {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::AffineTransform { id, .. }
            | Self::Opacity { id, .. }
            | Self::PathTrim { id, .. }
            | Self::PathMorph { id, .. }
            | Self::MotionPath { id, .. }
            | Self::Camera { id, .. } => id,
        }
    }

    #[must_use]
    pub fn provenance_id(&self) -> &str {
        match self {
            Self::AffineTransform { provenance_id, .. }
            | Self::Opacity { provenance_id, .. }
            | Self::PathTrim { provenance_id, .. }
            | Self::PathMorph { provenance_id, .. }
            | Self::MotionPath { provenance_id, .. }
            | Self::Camera { provenance_id, .. } => provenance_id,
        }
    }

    #[must_use]
    pub fn entity_id(&self) -> Option<&str> {
        match self {
            Self::AffineTransform { entity_id, .. }
            | Self::Opacity { entity_id, .. }
            | Self::PathTrim { entity_id, .. }
            | Self::PathMorph { entity_id, .. }
            | Self::MotionPath { entity_id, .. } => Some(entity_id),
            Self::Camera { .. } => None,
        }
    }

    #[must_use]
    pub const fn kind_name(&self) -> &'static str {
        match self {
            Self::AffineTransform { .. } => "affine-transform",
            Self::Opacity { .. } => "opacity",
            Self::PathTrim { .. } => "path-trim",
            Self::PathMorph { .. } => "path-morph",
            Self::MotionPath { .. } => "motion-path",
            Self::Camera { .. } => "camera",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SceneSourceV1 {
    #[serde(rename = "studio-edit-program")]
    StudioEditProgram {
        #[serde(rename = "editProgramVersion")]
        edit_program_version: ContractVersionV1,
        #[serde(rename = "revisionHash")]
        revision_hash: String,
    },
    #[serde(rename = "imported-manim-server-snapshot")]
    ImportedManimServerSnapshot {
        #[serde(rename = "runtimeConfigHash")]
        runtime_config_hash: String,
        #[serde(rename = "snapshotHash")]
        snapshot_hash: String,
        #[serde(rename = "snapshotVersion")]
        snapshot_version: SnapshotProfileVersionV1,
        #[serde(rename = "sourceHash")]
        source_hash: String,
    },
}

impl SceneSourceV1 {
    #[must_use]
    pub fn revision_hash(&self) -> &str {
        match self {
            Self::StudioEditProgram { revision_hash, .. } => revision_hash,
            Self::ImportedManimServerSnapshot { snapshot_hash, .. } => snapshot_hash,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProvenanceOriginV1 {
    #[serde(rename = "fast-manim-server-snapshot")]
    FastManimServerSnapshot,
    #[serde(rename = "fixture")]
    Fixture,
    #[serde(rename = "studio-edit-program")]
    StudioEditProgram,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProvenanceRecordV1 {
    pub evidence: Vec<String>,
    pub id: String,
    pub origin: ProvenanceOriginV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum FidelityV1 {
    #[serde(rename = "exact")]
    Exact {},
    #[serde(rename = "approximate")]
    Approximate { evidence: Vec<String> },
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub enum SceneCapabilityV1 {
    #[serde(rename = "affine-transform-animation")]
    AffineTransformAnimation,
    #[serde(rename = "camera-animation")]
    CameraAnimation,
    #[serde(rename = "cubic-path-geometry")]
    CubicPathGeometry,
    #[serde(rename = "motion-path-animation")]
    MotionPathAnimation,
    #[serde(rename = "opacity-animation")]
    OpacityAnimation,
    #[serde(rename = "path-morph-animation")]
    PathMorphAnimation,
    #[serde(rename = "path-trim-animation")]
    PathTrimAnimation,
    #[serde(rename = "png-image")]
    PngImage,
    #[serde(rename = "shape-primitives")]
    ShapePrimitives,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum CpuPrecisionV1 {
    #[default]
    #[serde(rename = "f64")]
    F64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum CoordinateSpaceKindV1 {
    #[default]
    #[serde(rename = "cartesian-2d")]
    Cartesian2d,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum CoordinateOriginV1 {
    #[default]
    #[serde(rename = "center")]
    Center,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum CoordinateUnitV1 {
    #[default]
    #[serde(rename = "scene-unit")]
    SceneUnit,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum XAxisDirectionV1 {
    #[default]
    #[serde(rename = "right")]
    Right,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum YAxisDirectionV1 {
    #[default]
    #[serde(rename = "up")]
    Up,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateSpaceV1 {
    pub cpu_precision: CpuPrecisionV1,
    pub kind: CoordinateSpaceKindV1,
    pub origin: CoordinateOriginV1,
    pub unit: CoordinateUnitV1,
    pub x_axis: XAxisDirectionV1,
    pub y_axis: YAxisDirectionV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneCameraV1 {
    pub background: RgbaColorV1,
    pub view: SceneCameraViewV1,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum SceneIrSchemaV1 {
    #[default]
    #[serde(rename = "poietra.scene-ir")]
    SceneIr,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneIrV1 {
    pub animation_channels: Vec<AnimationChannelV1>,
    pub asset_manifest: AssetManifestReferenceV1,
    pub camera: SceneCameraV1,
    pub coordinate_space: CoordinateSpaceV1,
    pub duration: f64,
    pub entities: Vec<SceneEntityV1>,
    pub fidelity: FidelityV1,
    pub provenance: Vec<ProvenanceRecordV1>,
    pub required_capabilities: Vec<SceneCapabilityV1>,
    pub scene_id: String,
    pub schema: SceneIrSchemaV1,
    pub source: SceneSourceV1,
    pub version: ContractVersionV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum RenderDrawV1 {
    #[serde(rename = "empty")]
    Empty {
        #[serde(rename = "drawId")]
        draw_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        opacity: f64,
        #[serde(rename = "paintOrder")]
        #[serde(deserialize_with = "deserialize_js_safe_u32")]
        paint_order: u32,
        reason: RenderEmptyReasonV1,
        #[serde(rename = "sourceZIndex")]
        source_z_index: f64,
        transform: AffineTransformV1,
    },
    #[serde(rename = "path")]
    Path {
        #[serde(rename = "drawId")]
        draw_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        fill: Option<FillStyleV1>,
        opacity: f64,
        #[serde(rename = "paintOrder")]
        #[serde(deserialize_with = "deserialize_js_safe_u32")]
        paint_order: u32,
        path: CubicPathV1,
        #[serde(rename = "sourceZIndex")]
        source_z_index: f64,
        stroke: Option<StrokeStyleV1>,
        transform: AffineTransformV1,
    },
    #[serde(rename = "image")]
    Image {
        asset: AssetReferenceV1,
        #[serde(rename = "drawId")]
        draw_id: String,
        #[serde(rename = "entityId")]
        entity_id: String,
        #[serde(rename = "localRect")]
        local_rect: ImageLocalRectV1,
        opacity: f64,
        #[serde(rename = "paintOrder")]
        #[serde(deserialize_with = "deserialize_js_safe_u32")]
        paint_order: u32,
        sampler: ImageSamplerV1,
        #[serde(rename = "sourceZIndex")]
        source_z_index: f64,
        transform: AffineTransformV1,
    },
}

impl RenderDrawV1 {
    #[must_use]
    pub fn draw_id(&self) -> &str {
        match self {
            Self::Empty { draw_id, .. }
            | Self::Path { draw_id, .. }
            | Self::Image { draw_id, .. } => draw_id,
        }
    }

    #[must_use]
    pub fn entity_id(&self) -> &str {
        match self {
            Self::Empty { entity_id, .. }
            | Self::Path { entity_id, .. }
            | Self::Image { entity_id, .. } => entity_id,
        }
    }

    #[must_use]
    pub const fn opacity(&self) -> f64 {
        match self {
            Self::Empty { opacity, .. }
            | Self::Path { opacity, .. }
            | Self::Image { opacity, .. } => *opacity,
        }
    }

    #[must_use]
    pub const fn paint_order(&self) -> u32 {
        match self {
            Self::Empty { paint_order, .. }
            | Self::Path { paint_order, .. }
            | Self::Image { paint_order, .. } => *paint_order,
        }
    }

    #[must_use]
    pub const fn source_z_index(&self) -> f64 {
        match self {
            Self::Empty { source_z_index, .. }
            | Self::Path { source_z_index, .. }
            | Self::Image { source_z_index, .. } => *source_z_index,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum RenderEmptyReasonV1 {
    #[serde(rename = "path-trim-zero")]
    PathTrimZero,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub enum RenderCapabilityV1 {
    #[serde(rename = "cubic-path-fill")]
    CubicPathFill,
    #[serde(rename = "cubic-path-stroke")]
    CubicPathStroke,
    #[serde(rename = "png-image")]
    PngImage,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum RenderCameraKindV1 {
    #[default]
    #[serde(rename = "orthographic-2d")]
    Orthographic2d,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderCameraV1 {
    pub bottom: f64,
    pub clear_color: RgbaColorV1,
    pub kind: RenderCameraKindV1,
    pub left: f64,
    pub right: f64,
    pub top: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewportV1 {
    #[serde(deserialize_with = "deserialize_js_safe_u32")]
    pub height_px: u32,
    #[serde(deserialize_with = "deserialize_js_safe_u32")]
    pub width_px: u32,
}

#[cfg(test)]
mod integer_wire_tests {
    use super::*;

    #[derive(Debug, Deserialize, PartialEq)]
    struct U32Probe {
        #[serde(deserialize_with = "deserialize_js_safe_u32")]
        value: u32,
    }

    #[test]
    fn accepts_json_float_lexemes_that_javascript_treats_as_integers() {
        assert_eq!(
            serde_json::from_str::<ContractVersionV1>("1.0").unwrap(),
            ContractVersionV1
        );
        assert_eq!(
            serde_json::from_str::<U32Probe>(r#"{"value":1e0}"#).unwrap(),
            U32Probe { value: 1 }
        );
    }

    #[test]
    fn rejects_fractional_and_javascript_unsafe_integer_values() {
        assert!(serde_json::from_str::<U32Probe>(r#"{"value":1.5}"#).is_err());
        assert!(serde_json::from_str::<ContractVersionV1>("9007199254740992").is_err());
    }

    #[test]
    fn snapshot_profile_versions_match_javascript_number_semantics() {
        assert_eq!(
            serde_json::from_str::<SnapshotProfileVersionV1>("1.0").unwrap(),
            SnapshotProfileVersionV1::V1
        );
        assert_eq!(
            serde_json::from_str::<SnapshotProfileVersionV1>("2.0").unwrap(),
            SnapshotProfileVersionV1::V2
        );
        assert!(serde_json::from_str::<SnapshotProfileVersionV1>("3.0").is_err());
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub enum RenderPacketSchemaV1 {
    #[default]
    #[serde(rename = "poietra.render-packet")]
    RenderPacket,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPacketV1 {
    pub asset_manifest: AssetManifestReferenceV1,
    pub camera: RenderCameraV1,
    pub coordinate_space: CoordinateSpaceV1,
    pub draws: Vec<RenderDrawV1>,
    pub evidence: Vec<String>,
    pub packet_id: String,
    pub required_capabilities: Vec<RenderCapabilityV1>,
    pub sample_time: f64,
    pub scene_duration: f64,
    pub scene_id: String,
    pub scene_revision_hash: String,
    pub schema: RenderPacketSchemaV1,
    pub scene_contract_version: ContractVersionV1,
    pub version: ContractVersionV1,
    pub viewport: ViewportV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneIrBundleV1 {
    pub assets: AssetManifestV1,
    pub scene: SceneIrV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RenderPacketBundleV1 {
    pub assets: AssetManifestV1,
    pub packet: RenderPacketV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineFrameV1 {
    pub assets: AssetManifestV1,
    pub packet: RenderPacketV1,
    pub scene: SceneIrV1,
}
