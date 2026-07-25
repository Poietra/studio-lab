use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};

use poietra_geometry::{
    GeometryError, apply_easing_v1, apply_motion_path_v1, compose_affine_transforms_v1,
    interpolate_affine_transform_v1, interpolate_cubic_path_v1, scene_geometry_as_cubic_path_v1,
    trim_cubic_path_v1,
};
use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, AssetManifestV1, ContractVersionV1, CubicPathV1,
    EngineFrameV1, KeyframeV1, RenderCameraKindV1, RenderCameraV1, RenderCapabilityV1,
    RenderDrawV1, RenderPacketSchemaV1, RenderPacketV1, SceneAppearanceV1, SceneCameraViewV1,
    SceneEntityV1, SceneGeometryV1, SceneIrBundleV1, SceneIrV1, ViewportV1,
    validate_render_packet_for_validated_scene_v1, validate_scene_ir_with_assets_v1,
};

/// A scene cannot be sampled into a truthful v1 frame.
#[derive(Debug, thiserror::Error)]
pub enum EvaluationError {
    #[error("invalid v1 contract input: {0}")]
    InvalidInput(String),
    #[error("invalid evaluated v1 frame: {0}")]
    InvalidOutput(String),
    #[error(transparent)]
    Geometry(#[from] GeometryError),
    #[error("malformed scene reached evaluator: {0}")]
    MalformedScene(&'static str),
}

/// Borrowed inputs for one deterministic Scene IR sample.
#[derive(Clone, Debug)]
pub struct CompileEngineFrameOptionsV1<'a> {
    pub assets: &'a AssetManifestV1,
    pub evidence: &'a [String],
    pub packet_id: &'a str,
    pub sample_time: f64,
    pub scene: &'a SceneIrV1,
    pub viewport: ViewportV1,
}

/// Per-sample evidence for a retained, already validated Engine session.
#[derive(Clone, Debug)]
pub struct SampleEngineSessionOptionsV1<'a> {
    pub evidence: &'a [String],
    pub packet_id: &'a str,
    pub sample_time: f64,
    pub viewport: ViewportV1,
}

/// Owns one validated immutable snapshot so browser workers do not resend or
/// revalidate the entire Scene for every playhead sample.
#[derive(Debug)]
pub struct EngineSessionV1 {
    assets: AssetManifestV1,
    scene: SceneIrV1,
}

impl EngineSessionV1 {
    /// Creates a retained session after fully validating its source bundle.
    ///
    /// # Errors
    ///
    /// Returns [`EvaluationError::InvalidInput`] when the snapshot violates the v1 contract.
    pub fn new(bundle: SceneIrBundleV1) -> Result<Self, EvaluationError> {
        validate_scene_ir_with_assets_v1(&bundle.scene, &bundle.assets)
            .map_err(|error| EvaluationError::InvalidInput(error.to_string()))?;
        Ok(Self {
            assets: bundle.assets,
            scene: bundle.scene,
        })
    }

    /// Atomically replaces the retained snapshot after validating the candidate.
    ///
    /// # Errors
    ///
    /// Returns [`EvaluationError::InvalidInput`] and preserves the current snapshot
    /// when the candidate violates the v1 contract.
    pub fn replace_snapshot(&mut self, bundle: SceneIrBundleV1) -> Result<(), EvaluationError> {
        let replacement = Self::new(bundle)?;
        *self = replacement;
        Ok(())
    }

    #[must_use]
    pub const fn assets(&self) -> &AssetManifestV1 {
        &self.assets
    }

    #[must_use]
    pub const fn scene(&self) -> &SceneIrV1 {
        &self.scene
    }

    /// Samples only a `RenderPacket`; the retained Scene and manifest do not cross
    /// the worker boundary again.
    ///
    /// # Errors
    ///
    /// Returns an evaluation error for invalid request evidence or undefined geometry.
    pub fn sample_render_packet(
        &self,
        options: SampleEngineSessionOptionsV1<'_>,
    ) -> Result<RenderPacketV1, EvaluationError> {
        compile_render_packet_from_validated_v1(CompileEngineFrameOptionsV1 {
            assets: &self.assets,
            evidence: options.evidence,
            packet_id: options.packet_id,
            sample_time: options.sample_time,
            scene: &self.scene,
            viewport: options.viewport,
        })
    }
}

type MotionChannel<'a> = (&'a [KeyframeV1<f64>], &'a CubicPathV1, bool);

#[derive(Debug, Default)]
struct ChannelIndex<'a> {
    affine: HashMap<&'a str, &'a [KeyframeV1<AffineTransformV1>]>,
    camera: Option<&'a [KeyframeV1<SceneCameraViewV1>]>,
    motion: HashMap<&'a str, MotionChannel<'a>>,
    opacity: HashMap<&'a str, &'a [KeyframeV1<f64>]>,
    path_morph: HashMap<&'a str, &'a [KeyframeV1<CubicPathV1>]>,
    path_trim: HashMap<&'a str, &'a [KeyframeV1<f64>]>,
}

impl<'a> ChannelIndex<'a> {
    fn new(scene: &'a SceneIrV1) -> Self {
        let mut output = Self::default();
        for channel in &scene.animation_channels {
            match channel {
                AnimationChannelV1::AffineTransform {
                    entity_id,
                    keyframes,
                    ..
                } => {
                    output.affine.insert(entity_id, keyframes);
                }
                AnimationChannelV1::Camera { keyframes, .. } => {
                    output.camera = Some(keyframes);
                }
                AnimationChannelV1::MotionPath {
                    entity_id,
                    keyframes,
                    orient_to_path,
                    path,
                    ..
                } => {
                    output
                        .motion
                        .insert(entity_id, (keyframes, path, *orient_to_path));
                }
                AnimationChannelV1::Opacity {
                    entity_id,
                    keyframes,
                    ..
                } => {
                    output.opacity.insert(entity_id, keyframes);
                }
                AnimationChannelV1::PathMorph {
                    entity_id,
                    keyframes,
                    ..
                } => {
                    output.path_morph.insert(entity_id, keyframes);
                }
                AnimationChannelV1::PathTrim {
                    entity_id,
                    keyframes,
                    ..
                } => {
                    output.path_trim.insert(entity_id, keyframes);
                }
            }
        }
        output
    }
}

fn sample_keyframes<T: Clone>(
    base: &T,
    keyframes: &[KeyframeV1<T>],
    time: f64,
    interpolate: impl Fn(&T, &T, f64) -> Result<T, GeometryError>,
) -> Result<(T, bool), EvaluationError> {
    let first = keyframes.first().ok_or(EvaluationError::MalformedScene(
        "animation channel has no keyframes",
    ))?;
    if time < first.at {
        return Ok((base.clone(), false));
    }
    let final_keyframe = keyframes.last().ok_or(EvaluationError::MalformedScene(
        "animation channel has no keyframes",
    ))?;
    if time >= final_keyframe.at {
        return Ok((final_keyframe.value.clone(), true));
    }

    let right_index = keyframes.partition_point(|keyframe| keyframe.at <= time);
    let left =
        keyframes
            .get(right_index.saturating_sub(1))
            .ok_or(EvaluationError::MalformedScene(
                "sample time did not resolve to a keyframe segment",
            ))?;
    let right = keyframes
        .get(right_index)
        .ok_or(EvaluationError::MalformedScene(
            "sample time did not resolve to a keyframe segment",
        ))?;
    let easing = left
        .easing_to_next
        .as_ref()
        .ok_or(EvaluationError::MalformedScene(
            "non-final keyframe is missing easingToNext",
        ))?;
    let progress = (time - left.at) / (right.at - left.at);
    let eased = apply_easing_v1(easing, progress);
    Ok((interpolate(&left.value, &right.value, eased)?, true))
}

#[allow(
    clippy::trivially_copy_pass_by_ref,
    clippy::unnecessary_wraps,
    reason = "shares the generic fallible keyframe interpolation callback"
)]
fn interpolate_number(left: &f64, right: &f64, progress: f64) -> Result<f64, GeometryError> {
    Ok(left + (right - left) * progress)
}

#[allow(
    clippy::unnecessary_wraps,
    reason = "shares the generic fallible keyframe interpolation callback"
)]
fn interpolate_camera(
    left: &SceneCameraViewV1,
    right: &SceneCameraViewV1,
    progress: f64,
) -> Result<SceneCameraViewV1, GeometryError> {
    Ok(SceneCameraViewV1 {
        center: poietra_scene_ir::PointV1 {
            x: left.center.x + (right.center.x - left.center.x) * progress,
            y: left.center.y + (right.center.y - left.center.y) * progress,
        },
        frame_height: left.frame_height + (right.frame_height - left.frame_height) * progress,
        frame_width: left.frame_width + (right.frame_width - left.frame_width) * progress,
    })
}

#[derive(Clone, Debug)]
struct LocalSample {
    opacity: f64,
    path: Option<CubicPathV1>,
    transform: AffineTransformV1,
}

fn appearance_opacity(appearance: &SceneAppearanceV1) -> f64 {
    match appearance {
        SceneAppearanceV1::Image { opacity } | SceneAppearanceV1::Vector { opacity, .. } => {
            *opacity
        }
    }
}

fn sample_local_entity(
    channels: &ChannelIndex<'_>,
    entity: &SceneEntityV1,
    time: f64,
) -> Result<LocalSample, EvaluationError> {
    let base_opacity = appearance_opacity(&entity.appearance);
    let opacity = if let Some(keyframes) = channels.opacity.get(entity.id.as_str()) {
        sample_keyframes(&base_opacity, keyframes, time, interpolate_number)?.0
    } else {
        base_opacity
    };

    let mut transform = if let Some(keyframes) = channels.affine.get(entity.id.as_str()) {
        sample_keyframes(
            &entity.transform,
            keyframes,
            time,
            |left, right, progress| Ok(interpolate_affine_transform_v1(left, right, progress)),
        )?
        .0
    } else {
        entity.transform.clone()
    };
    if let Some((keyframes, path, orient_to_path)) = channels.motion.get(entity.id.as_str()) {
        let (progress, active) = sample_keyframes(&0.0, keyframes, time, interpolate_number)?;
        if active {
            transform = apply_motion_path_v1(&transform, path, progress, *orient_to_path)?;
        }
    }

    if matches!(&entity.geometry, SceneGeometryV1::Image { .. }) {
        return Ok(LocalSample {
            opacity,
            path: None,
            transform,
        });
    }
    let mut path = scene_geometry_as_cubic_path_v1(&entity.geometry)?;
    if let Some(keyframes) = channels.path_morph.get(entity.id.as_str()) {
        path = sample_keyframes(&path, keyframes, time, interpolate_cubic_path_v1)?.0;
    }
    if let Some(keyframes) = channels.path_trim.get(entity.id.as_str()) {
        let progress = sample_keyframes(&1.0, keyframes, time, interpolate_number)?.0;
        path = trim_cubic_path_v1(&path, progress)?;
    }
    Ok(LocalSample {
        opacity,
        path: Some(path),
        transform,
    })
}

#[derive(Clone, Debug)]
struct WorldSample {
    opacity: f64,
    transform: AffineTransformV1,
}

fn world_samples(
    scene: &SceneIrV1,
    active: &[&SceneEntityV1],
    local: &HashMap<&str, LocalSample>,
) -> Result<HashMap<String, WorldSample>, EvaluationError> {
    let by_id: HashMap<_, _> = scene
        .entities
        .iter()
        .map(|entity| (entity.id.as_str(), entity))
        .collect();
    let mut output = HashMap::<String, WorldSample>::new();
    for &entity in active {
        if output.contains_key(&entity.id) {
            continue;
        }
        let mut chain = Vec::new();
        let mut current = Some(entity);
        while let Some(member) = current {
            if output.contains_key(&member.id) {
                break;
            }
            chain.push(member);
            current = match &member.parent_id {
                Some(parent_id) => Some(*by_id.get(parent_id.as_str()).ok_or(
                    EvaluationError::MalformedScene("entity has an unknown parent"),
                )?),
                None => None,
            };
            if chain.len() > scene.entities.len() {
                return Err(EvaluationError::MalformedScene(
                    "entity hierarchy contains a cycle",
                ));
            }
        }
        let mut parent_sample = current.and_then(|member| output.get(&member.id)).cloned();
        for member in chain.into_iter().rev() {
            let local_sample =
                local
                    .get(member.id.as_str())
                    .ok_or(EvaluationError::MalformedScene(
                        "entity has no local sample",
                    ))?;
            let sample = WorldSample {
                opacity: parent_sample.as_ref().map_or(1.0, |parent| parent.opacity)
                    * local_sample.opacity,
                transform: parent_sample.as_ref().map_or_else(
                    || local_sample.transform.clone(),
                    |parent| {
                        compose_affine_transforms_v1(&parent.transform, &local_sample.transform)
                    },
                ),
            };
            output.insert(member.id.clone(), sample.clone());
            parent_sample = Some(sample);
        }
    }
    Ok(output)
}

fn sample_camera(
    scene: &SceneIrV1,
    channels: &ChannelIndex<'_>,
    time: f64,
) -> Result<SceneCameraViewV1, EvaluationError> {
    channels.camera.map_or_else(
        || Ok(scene.camera.view.clone()),
        |keyframes| {
            sample_keyframes(&scene.camera.view, keyframes, time, interpolate_camera)
                .map(|sample| sample.0)
        },
    )
}

fn render_capabilities(draws: &[RenderDrawV1]) -> Vec<RenderCapabilityV1> {
    let mut capabilities = BTreeSet::new();
    for draw in draws {
        match draw {
            RenderDrawV1::Image { .. } => {
                capabilities.insert(RenderCapabilityV1::PngImage);
            }
            RenderDrawV1::Path { fill, stroke, .. } => {
                if fill.is_some() {
                    capabilities.insert(RenderCapabilityV1::CubicPathFill);
                }
                if stroke.is_some() {
                    capabilities.insert(RenderCapabilityV1::CubicPathStroke);
                }
            }
        }
    }
    capabilities.into_iter().collect()
}

fn entity_is_active(entity: &SceneEntityV1, time: f64) -> bool {
    entity
        .lifetimes
        .iter()
        .any(|lifetime| time >= lifetime.start && time < lifetime.end)
}

#[allow(
    clippy::too_many_lines,
    reason = "keeps the single frame-boundary assembly order visible and auditable"
)]
fn compile_render_packet_from_validated_v1(
    options: CompileEngineFrameOptionsV1<'_>,
) -> Result<RenderPacketV1, EvaluationError> {
    if !options.sample_time.is_finite()
        || options.sample_time < 0.0
        || options.sample_time > options.scene.duration
    {
        return Err(EvaluationError::InvalidInput(
            "sampleTime must be finite and inside Scene duration".to_owned(),
        ));
    }

    let channels = ChannelIndex::new(options.scene);
    let mut active: Vec<_> = options
        .scene
        .entities
        .iter()
        .filter(|entity| entity_is_active(entity, options.sample_time))
        .collect();
    active.sort_by(|left, right| {
        left.source_z_index
            .partial_cmp(&right.source_z_index)
            .unwrap_or(Ordering::Equal)
            .then(left.scene_order.cmp(&right.scene_order))
    });
    let local: HashMap<_, _> = active
        .iter()
        .copied()
        .map(|entity| {
            sample_local_entity(&channels, entity, options.sample_time)
                .map(|sample| (entity.id.as_str(), sample))
        })
        .collect::<Result<_, _>>()?;
    let world = world_samples(options.scene, &active, &local)?;

    let draws = active
        .into_iter()
        .enumerate()
        .map(|(paint_order, entity)| {
            let paint_order = u32::try_from(paint_order)
                .map_err(|_| EvaluationError::MalformedScene("draw count exceeds u32"))?;
            let local_sample =
                local
                    .get(entity.id.as_str())
                    .ok_or(EvaluationError::MalformedScene(
                        "entity has no local sample",
                    ))?;
            let world_sample = world
                .get(&entity.id)
                .ok_or(EvaluationError::MalformedScene(
                    "entity has no world sample",
                ))?;
            let draw_id = format!("draw:{}", entity.scene_order);
            match (&entity.geometry, &entity.appearance) {
                (
                    SceneGeometryV1::Image {
                        asset,
                        local_rect,
                        sampler,
                    },
                    SceneAppearanceV1::Image { .. },
                ) => Ok(RenderDrawV1::Image {
                    asset: asset.clone(),
                    draw_id,
                    entity_id: entity.id.clone(),
                    local_rect: local_rect.clone(),
                    opacity: world_sample.opacity,
                    paint_order,
                    sampler: *sampler,
                    source_z_index: entity.source_z_index,
                    transform: world_sample.transform.clone(),
                }),
                (SceneGeometryV1::Image { .. }, _) => Err(EvaluationError::MalformedScene(
                    "image geometry has vector appearance",
                )),
                (_, SceneAppearanceV1::Vector { fill, stroke, .. }) => Ok(RenderDrawV1::Path {
                    draw_id,
                    entity_id: entity.id.clone(),
                    fill: fill.clone(),
                    opacity: world_sample.opacity,
                    paint_order,
                    path: local_sample
                        .path
                        .clone()
                        .ok_or(EvaluationError::MalformedScene("vector entity has no path"))?,
                    source_z_index: entity.source_z_index,
                    stroke: stroke.clone(),
                    transform: world_sample.transform.clone(),
                }),
                (_, SceneAppearanceV1::Image { .. }) => Err(EvaluationError::MalformedScene(
                    "vector geometry has image appearance",
                )),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;

    let camera = sample_camera(options.scene, &channels, options.sample_time)?;
    let packet = RenderPacketV1 {
        asset_manifest: options.scene.asset_manifest.clone(),
        camera: RenderCameraV1 {
            bottom: camera.center.y - camera.frame_height / 2.0,
            clear_color: options.scene.camera.background.clone(),
            kind: RenderCameraKindV1::Orthographic2d,
            left: camera.center.x - camera.frame_width / 2.0,
            right: camera.center.x + camera.frame_width / 2.0,
            top: camera.center.y + camera.frame_height / 2.0,
        },
        coordinate_space: options.scene.coordinate_space.clone(),
        required_capabilities: render_capabilities(&draws),
        draws,
        evidence: if options.evidence.is_empty() {
            vec!["Poietra reference evaluator v1".to_owned()]
        } else {
            options.evidence.to_vec()
        },
        packet_id: options.packet_id.to_owned(),
        sample_time: options.sample_time,
        scene_contract_version: ContractVersionV1,
        scene_duration: options.scene.duration,
        scene_id: options.scene.scene_id.clone(),
        scene_revision_hash: options.scene.source.revision_hash().to_owned(),
        schema: RenderPacketSchemaV1::RenderPacket,
        version: ContractVersionV1,
        viewport: options.viewport,
    };
    validate_render_packet_for_validated_scene_v1(&packet, options.scene, options.assets)
        .map_err(|error| EvaluationError::InvalidOutput(error.to_string()))?;
    Ok(packet)
}

/// Compiles a Scene IR and immutable asset manifest into one sampled `RenderPacket`.
///
/// The source bundle and produced packet are validated at the trust boundary. Any
/// unsupported or inconsistent state fails closed.
///
/// # Errors
///
/// Returns [`EvaluationError::InvalidInput`] for a contract violation,
/// [`EvaluationError::Geometry`] for undefined geometry semantics, or
/// [`EvaluationError::InvalidOutput`] if the sampled packet fails its integrity check.
pub fn compile_render_packet_v1(
    options: CompileEngineFrameOptionsV1<'_>,
) -> Result<RenderPacketV1, EvaluationError> {
    validate_scene_ir_with_assets_v1(options.scene, options.assets)
        .map_err(|error| EvaluationError::InvalidInput(error.to_string()))?;
    compile_render_packet_from_validated_v1(options)
}

/// Compiles a Scene IR and immutable asset manifest into one self-contained frame.
///
/// Prefer [`EngineSessionV1::sample_render_packet`] at a browser worker boundary so
/// the immutable Scene and asset metadata are retained instead of cloned per frame.
///
/// # Errors
///
/// Returns the same fail-closed errors as [`compile_render_packet_v1`].
pub fn compile_engine_frame_v1(
    options: CompileEngineFrameOptionsV1<'_>,
) -> Result<EngineFrameV1, EvaluationError> {
    let assets = options.assets;
    let scene = options.scene;
    let packet = compile_render_packet_v1(options)?;
    Ok(EngineFrameV1 {
        assets: assets.clone(),
        packet,
        scene: scene.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use poietra_scene_ir::{
        AssetManifestReferenceV1, AssetManifestSchemaV1, CoordinateSpaceV1, FidelityV1, FillRuleV1,
        FillStyleV1, IntervalV1, ProvenanceOriginV1, ProvenanceRecordV1, RgbaColorV1,
        SceneCameraV1, SceneCapabilityV1, SceneIrSchemaV1, SceneSourceV1,
    };

    const EMPTY_MANIFEST_DIGEST: &str =
        "e675cb4bad3da6b425e5a6bbe88d7da7a986e3cac61dab06139ef63950dcc181";

    fn color(red: f64, green: f64, blue: f64, alpha: f64) -> RgbaColorV1 {
        RgbaColorV1 {
            alpha,
            blue,
            green,
            red,
        }
    }

    fn fixture() -> (AssetManifestV1, SceneIrV1) {
        let assets = AssetManifestV1 {
            assets: Vec::new(),
            manifest_digest: EMPTY_MANIFEST_DIGEST.to_owned(),
            manifest_id: "manifest".to_owned(),
            schema: AssetManifestSchemaV1::AssetManifest,
            version: ContractVersionV1,
        };
        let scene = SceneIrV1 {
            animation_channels: vec![AnimationChannelV1::Opacity {
                entity_id: "circle".to_owned(),
                id: "opacity:circle".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.0,
                        easing_to_next: Some(poietra_scene_ir::EasingV1::Smooth {}),
                        value: 0.0,
                    },
                    KeyframeV1 {
                        at: 2.0,
                        easing_to_next: None,
                        value: 1.0,
                    },
                ],
                provenance_id: "fixture".to_owned(),
            }],
            asset_manifest: AssetManifestReferenceV1 {
                manifest_digest: EMPTY_MANIFEST_DIGEST.to_owned(),
                manifest_id: "manifest".to_owned(),
            },
            camera: SceneCameraV1 {
                background: color(0.0, 0.0, 0.0, 1.0),
                view: SceneCameraViewV1 {
                    center: poietra_scene_ir::PointV1 { x: 0.0, y: 0.0 },
                    frame_height: 9.0,
                    frame_width: 16.0,
                },
            },
            coordinate_space: CoordinateSpaceV1::default(),
            duration: 2.0,
            entities: vec![SceneEntityV1 {
                appearance: SceneAppearanceV1::Vector {
                    fill: Some(FillStyleV1 {
                        color: color(1.0, 0.0, 0.0, 1.0),
                        rule: FillRuleV1::NonZero,
                    }),
                    opacity: 1.0,
                    stroke: None,
                },
                geometry: SceneGeometryV1::Circle {
                    center: poietra_scene_ir::PointV1 { x: 0.0, y: 0.0 },
                    radius: 1.0,
                },
                id: "circle".to_owned(),
                lifetimes: vec![IntervalV1 {
                    end: 2.0,
                    start: 0.0,
                }],
                parent_id: None,
                provenance_id: "fixture".to_owned(),
                scene_order: 0,
                source_z_index: 0.0,
                transform: AffineTransformV1::identity(),
            }],
            fidelity: FidelityV1::Exact {},
            provenance: vec![ProvenanceRecordV1 {
                evidence: vec!["Rust unit fixture".to_owned()],
                id: "fixture".to_owned(),
                origin: ProvenanceOriginV1::Fixture,
            }],
            required_capabilities: vec![
                SceneCapabilityV1::OpacityAnimation,
                SceneCapabilityV1::ShapePrimitives,
            ],
            scene_id: "scene".to_owned(),
            schema: SceneIrSchemaV1::SceneIr,
            source: SceneSourceV1::StudioEditProgram {
                edit_program_version: ContractVersionV1,
                revision_hash: "0".repeat(64),
            },
            version: ContractVersionV1,
        };
        (assets, scene)
    }

    #[test]
    fn compiles_shape_and_smooth_opacity_at_midpoint() {
        let (assets, scene) = fixture();
        let frame = compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
            assets: &assets,
            evidence: &[],
            packet_id: "packet:midpoint",
            sample_time: 1.0,
            scene: &scene,
            viewport: ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();

        assert_eq!(frame.packet.scene_revision_hash, "0".repeat(64));
        assert_eq!(
            frame.packet.evidence,
            vec!["Poietra reference evaluator v1"]
        );
        assert_eq!(
            frame.packet.required_capabilities,
            vec![RenderCapabilityV1::CubicPathFill]
        );
        assert_eq!(frame.packet.draws.len(), 1);
        let RenderDrawV1::Path { opacity, path, .. } = &frame.packet.draws[0] else {
            panic!("circle must lower to a path draw");
        };
        assert!((*opacity - 0.5).abs() < 1.0e-12);
        assert_eq!(path.subpaths[0].segments.len(), 4);
    }

    #[test]
    fn lifetime_end_is_exclusive() {
        let (assets, scene) = fixture();
        let frame = compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
            assets: &assets,
            evidence: &[],
            packet_id: "packet:end",
            sample_time: 2.0,
            scene: &scene,
            viewport: ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
        assert!(frame.packet.draws.is_empty());
    }

    #[test]
    fn rejects_sample_outside_duration_before_evaluation() {
        let (assets, scene) = fixture();
        let error = compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
            assets: &assets,
            evidence: &[],
            packet_id: "packet:invalid",
            sample_time: 2.1,
            scene: &scene,
            viewport: ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap_err();
        assert!(matches!(error, EvaluationError::InvalidInput(_)));
    }

    #[test]
    fn inactive_entities_are_not_sampled_or_lowered() {
        let (assets, mut scene) = fixture();
        let point = poietra_scene_ir::PointV1 { x: 3.0, y: 4.0 };
        scene.entities[0].lifetimes = vec![IntervalV1 {
            end: 2.0,
            start: 1.0,
        }];
        scene
            .animation_channels
            .push(AnimationChannelV1::MotionPath {
                entity_id: "circle".to_owned(),
                id: "motion:circle".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.0,
                        easing_to_next: Some(poietra_scene_ir::EasingV1::Linear {}),
                        value: 0.0,
                    },
                    KeyframeV1 {
                        at: 2.0,
                        easing_to_next: None,
                        value: 1.0,
                    },
                ],
                orient_to_path: true,
                path: CubicPathV1 {
                    subpaths: vec![poietra_scene_ir::CubicSubpathV1 {
                        closed: false,
                        segments: vec![poietra_scene_ir::CubicSegmentV1 {
                            control1: point.clone(),
                            control2: point.clone(),
                            end: point.clone(),
                        }],
                        start: point,
                    }],
                },
                provenance_id: "fixture".to_owned(),
            });
        scene.required_capabilities = vec![
            SceneCapabilityV1::MotionPathAnimation,
            SceneCapabilityV1::OpacityAnimation,
            SceneCapabilityV1::ShapePrimitives,
        ];

        let frame = compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
            assets: &assets,
            evidence: &[],
            packet_id: "packet:inactive",
            sample_time: 0.5,
            scene: &scene,
            viewport: ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();
        assert!(frame.packet.draws.is_empty());
    }

    #[test]
    fn retained_session_samples_packets_and_rejects_snapshot_replacement_atomically() {
        let (assets, scene) = fixture();
        let mut session = EngineSessionV1::new(SceneIrBundleV1 { assets, scene }).unwrap();
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "packet:retained",
                sample_time: 1.0,
                viewport: ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();
        assert_eq!(packet.draws.len(), 1);

        let mut invalid_scene = session.scene().clone();
        invalid_scene.duration = 0.0;
        let rejected = session.replace_snapshot(SceneIrBundleV1 {
            assets: session.assets().clone(),
            scene: invalid_scene,
        });
        assert!(matches!(rejected, Err(EvaluationError::InvalidInput(_))));
        assert!((session.scene().duration - 2.0).abs() < f64::EPSILON);
    }
}
