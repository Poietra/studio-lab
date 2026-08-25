use std::collections::BTreeSet;

use poietra_geometry::{
    GeometryError, apply_easing_v1, apply_manim_motion_path_v1, apply_motion_path_v1,
    compose_affine_transforms_v1, interpolate_affine_transform_v1, interpolate_cubic_path_v1,
    rotate_affine_transform_v1, scene_geometry_as_cubic_path_v1,
    trim_cubic_path_uniform_parameter_v1, trim_cubic_path_v1,
};
use poietra_scene_ir::{
    AffineTransformV1, AnimationChannelV1, AssetManifestV1, ContractVersionV1, CubicPathV1,
    EngineFrameV1, FillStyleV1, KeyframeV1, MotionPathParameterizationV1,
    PathTrimParameterizationV1, RENDER_ASPECT_RELATIVE_TOLERANCE_V1, RenderCameraKindV1,
    RenderCameraV1, RenderCapabilityV1, RenderDrawV1, RenderEmptyReasonV1, RenderPacketSchemaV1,
    RenderPacketV1, RgbaColorV1, SceneAppearanceV1, SceneCameraViewV1, SceneEntityV1,
    SceneGeometryV1, SceneIrBundleV1, SceneIrV1, StrokeStyleV1, VectorAppearanceValueV1,
    ViewportV1, affine_transform_is_singular_v1, validate_render_packet_for_validated_scene_v1,
    validate_scene_ir_with_assets_v1,
};

use crate::retained_index::{
    RetainedSceneIndexErrorV1, RetainedSceneIndexStatsV1, RetainedSceneIndexV1,
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
    #[error(transparent)]
    RetainedIndex(#[from] RetainedSceneIndexErrorV1),
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
    index: RetainedSceneIndexV1,
    index_build_count: u64,
    scene: SceneIrV1,
}

impl EngineSessionV1 {
    /// Creates a retained session after fully validating its source bundle.
    ///
    /// # Errors
    ///
    /// Returns [`EvaluationError::InvalidInput`] when the snapshot violates the v1 contract, or
    /// [`EvaluationError::RetainedIndex`] when its derived index exceeds the bounded byte policy,
    /// overflows byte accounting, or cannot be allocated consistently.
    pub fn new(bundle: SceneIrBundleV1) -> Result<Self, EvaluationError> {
        validate_scene_ir_with_assets_v1(&bundle.scene, &bundle.assets)
            .map_err(|error| EvaluationError::InvalidInput(error.to_string()))?;
        let index = RetainedSceneIndexV1::build(&bundle.scene)?;
        Ok(Self {
            assets: bundle.assets,
            index,
            index_build_count: 1,
            scene: bundle.scene,
        })
    }

    /// Atomically replaces the retained snapshot after validating the candidate.
    ///
    /// # Errors
    ///
    /// Returns [`EvaluationError::InvalidInput`] when the candidate violates the v1 contract,
    /// [`EvaluationError::RetainedIndex`] when its bounded derived index cannot be accounted or
    /// allocated, or [`EvaluationError::MalformedScene`] if the retained build counter overflows.
    /// Every failure preserves the current snapshot and index.
    pub fn replace_snapshot(&mut self, bundle: SceneIrBundleV1) -> Result<(), EvaluationError> {
        let mut replacement = Self::new(bundle)?;
        replacement.index_build_count =
            self.index_build_count
                .checked_add(1)
                .ok_or(EvaluationError::MalformedScene(
                    "retained index build count overflowed",
                ))?;
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

    /// Returns immutable install-time evidence for the snapshot-derived index.
    /// Sampling never changes this value; only a successful complete snapshot
    /// replacement advances its build count.
    #[must_use]
    pub fn retained_index_stats(&self) -> RetainedSceneIndexStatsV1 {
        RetainedSceneIndexStatsV1 {
            accounted_bytes: self.index.accounted_bytes(),
            build_count: self.index_build_count,
            channel_entries: self.index.channel_entries(),
            entity_entries: self.index.entity_entries(),
            hierarchy_entries: self.index.hierarchy_order().len(),
            paint_order_entries: self.index.stable_paint_order().len(),
        }
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
        self.sample_with_camera_fit(options, CameraViewportFitV1::Exact)
    }

    /// Samples one `RenderPacket` for a closed export-ladder viewport.
    ///
    /// Interactive presentation snaps the viewport onto the camera's exact
    /// aspect, so [`Self::sample_render_packet`] never fits anything. The
    /// export ladder is the opposite authority: its pixel grids are fixed, and
    /// the 854×480 rung's aspect deviates from a 16:9 camera by less than one
    /// pixel column (854 is the even-width rounding of 480 × 16/9). This
    /// entry resolves that deviation exactly as the historically accepted
    /// 854×480 Manim server profile did: the sampled camera window is widened
    /// symmetrically about its center along the deficient axis until world
    /// aspect equals pixel aspect. Content is never cropped, and a viewport
    /// already inside the packet validator's aspect tolerance samples
    /// bit-identically to the interactive path.
    ///
    /// # Errors
    ///
    /// Returns an evaluation error for invalid request evidence or undefined geometry.
    pub fn sample_export_render_packet(
        &self,
        options: SampleEngineSessionOptionsV1<'_>,
    ) -> Result<RenderPacketV1, EvaluationError> {
        self.sample_with_camera_fit(options, CameraViewportFitV1::WidenToViewportAspect)
    }

    fn sample_with_camera_fit(
        &self,
        options: SampleEngineSessionOptionsV1<'_>,
        camera_fit: CameraViewportFitV1,
    ) -> Result<RenderPacketV1, EvaluationError> {
        compile_render_packet_with_camera_fit_v1(
            CompileEngineFrameOptionsV1 {
                assets: &self.assets,
                evidence: options.evidence,
                packet_id: options.packet_id,
                sample_time: options.sample_time,
                scene: &self.scene,
                viewport: options.viewport,
            },
            &self.index,
            camera_fit,
        )
    }
}

/// How a sampled camera view relates to the requested viewport grid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CameraViewportFitV1 {
    /// The camera is authoritative; the caller chose an aspect-exact viewport.
    Exact,
    /// The viewport grid is authoritative (closed export ladder); the camera
    /// window widens sub-pixel about its center to the viewport aspect.
    WidenToViewportAspect,
}

/// Widens the deficient camera axis about the fixed center so the world
/// window's aspect equals the viewport's pixel aspect. A view already within
/// the packet validator's shared aspect tolerance is returned unchanged, so
/// aspect-exact viewports keep bit-identical sampling.
fn fit_camera_view_to_viewport_v1(
    view: SceneCameraViewV1,
    viewport: &ViewportV1,
) -> SceneCameraViewV1 {
    // NaN frame extents fall through here; the non-finite aspect guard below
    // returns the view unchanged for the packet validator to reject.
    if viewport.width_px == 0
        || viewport.height_px == 0
        || view.frame_width <= 0.0
        || view.frame_height <= 0.0
    {
        return view;
    }
    let viewport_aspect = f64::from(viewport.width_px) / f64::from(viewport.height_px);
    let camera_aspect = view.frame_width / view.frame_height;
    if !camera_aspect.is_finite()
        || !viewport_aspect.is_finite()
        || (camera_aspect / viewport_aspect - 1.0).abs() <= RENDER_ASPECT_RELATIVE_TOLERANCE_V1
    {
        return view;
    }
    if camera_aspect < viewport_aspect {
        SceneCameraViewV1 {
            frame_width: view.frame_height * viewport_aspect,
            ..view
        }
    } else {
        SceneCameraViewV1 {
            frame_height: view.frame_width / viewport_aspect,
            ..view
        }
    }
}

fn sample_keyframes<T: Clone, E>(
    base: &T,
    keyframes: &[KeyframeV1<T>],
    time: f64,
    interpolate: impl Fn(&T, &T, f64) -> Result<T, E>,
) -> Result<(T, bool), EvaluationError>
where
    EvaluationError: From<E>,
{
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
    let raw_progress = (time - left.at) / (right.at - left.at);
    let matches_right_boundary = time > left.at
        && (1.0 - raw_progress).abs() <= 4.0 * f64::EPSILON * raw_progress.abs().max(1.0);
    let progress = if matches_right_boundary {
        1.0
    } else {
        raw_progress
    };
    let eased = apply_easing_v1(easing, progress);
    Ok((
        interpolate(&left.value, &right.value, eased).map_err(EvaluationError::from)?,
        true,
    ))
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

fn interpolate_color(left: &RgbaColorV1, right: &RgbaColorV1, progress: f64) -> RgbaColorV1 {
    RgbaColorV1 {
        alpha: left.alpha + (right.alpha - left.alpha) * progress,
        blue: left.blue + (right.blue - left.blue) * progress,
        green: left.green + (right.green - left.green) * progress,
        red: left.red + (right.red - left.red) * progress,
    }
}

fn interpolate_vector_appearance(
    left: &VectorAppearanceValueV1,
    right: &VectorAppearanceValueV1,
    progress: f64,
) -> Result<VectorAppearanceValueV1, EvaluationError> {
    let fill = match (&left.fill, &right.fill) {
        (None, None) => None,
        (Some(left), Some(right)) => {
            let fragment_material = match (&left.fragment_material, &right.fragment_material) {
                (None, None) => None,
                (Some(left), Some(right))
                    if left.shader_id == right.shader_id
                        && left.revision == right.revision
                        && left.texture == right.texture
                        && left.parameters.len() == right.parameters.len() =>
                {
                    let mut material = left.clone();
                    for (value, right) in material.parameters.iter_mut().zip(&right.parameters) {
                        *value += (*right - *value) * progress;
                    }
                    Some(material)
                }
                (None | Some(_), Some(_)) | (Some(_), None) => {
                    return Err(EvaluationError::MalformedScene(
                        "vector-appearance fragment material identity changed after validation",
                    ));
                }
            };
            Some(FillStyleV1 {
                color: interpolate_color(&left.color, &right.color, progress),
                fragment_material,
                rule: left.rule,
            })
        }
        (None, Some(_)) | (Some(_), None) => {
            return Err(EvaluationError::MalformedScene(
                "vector-appearance fill presence changed after validation",
            ));
        }
    };
    let stroke = match (&left.stroke, &right.stroke) {
        (None, None) => None,
        (Some(left), Some(right)) => {
            let fragment_material = match (&left.fragment_material, &right.fragment_material) {
                (None, None) => None,
                (Some(left), Some(right))
                    if left.shader_id == right.shader_id
                        && left.revision == right.revision
                        && left.texture == right.texture
                        && left.parameters.len() == right.parameters.len() =>
                {
                    let mut material = left.clone();
                    for (value, right) in material.parameters.iter_mut().zip(&right.parameters) {
                        *value += (*right - *value) * progress;
                    }
                    Some(material)
                }
                (None | Some(_), Some(_)) | (Some(_), None) => {
                    return Err(EvaluationError::MalformedScene(
                        "vector-appearance stroke fragment material identity changed after validation",
                    ));
                }
            };
            Some(StrokeStyleV1 {
                cap: left.cap,
                color: interpolate_color(&left.color, &right.color, progress),
                dash_length_world: left.dash_length_world,
                fragment_material,
                gap_length_world: left.gap_length_world,
                join: left.join,
                miter_limit: left.miter_limit,
                width_world: left.width_world + (right.width_world - left.width_world) * progress,
            })
        }
        (None, Some(_)) | (Some(_), None) => {
            return Err(EvaluationError::MalformedScene(
                "vector-appearance stroke presence changed after validation",
            ));
        }
    };
    Ok(VectorAppearanceValueV1 { fill, stroke })
}

fn normalize_vector_appearance_stroke(
    mut appearance: VectorAppearanceValueV1,
) -> VectorAppearanceValueV1 {
    if appearance
        .stroke
        .as_ref()
        .is_some_and(|stroke| stroke.width_world == 0.0)
    {
        appearance.stroke = None;
    }
    appearance
}

#[derive(Clone, Debug)]
struct LocalSample {
    empty_reason: Option<RenderEmptyReasonV1>,
    fill: Option<FillStyleV1>,
    opacity: f64,
    path: Option<CubicPathV1>,
    stroke: Option<StrokeStyleV1>,
    transform: AffineTransformV1,
}

fn appearance_opacity(appearance: &SceneAppearanceV1) -> f64 {
    match appearance {
        SceneAppearanceV1::Group { opacity }
        | SceneAppearanceV1::Image { opacity }
        | SceneAppearanceV1::Vector { opacity, .. } => *opacity,
    }
}

fn sample_affine_transform(
    index: &RetainedSceneIndexV1,
    scene: &SceneIrV1,
    entity_index: usize,
    entity: &SceneEntityV1,
    time: f64,
) -> Result<(AffineTransformV1, bool), EvaluationError> {
    let Some(channel_index) = index.affine_channel(entity_index) else {
        return Ok((entity.transform.clone(), false));
    };
    let (transform, active) = match scene.animation_channels.get(channel_index) {
        Some(AnimationChannelV1::AffineTransform { keyframes, .. }) => sample_keyframes(
            &entity.transform,
            keyframes,
            time,
            |left, right, progress| {
                Ok::<_, GeometryError>(interpolate_affine_transform_v1(left, right, progress))
            },
        )?,
        Some(AnimationChannelV1::Rotation {
            keyframes, pivot, ..
        }) => {
            let (angle, active) = sample_keyframes(&0.0, keyframes, time, interpolate_number)?;
            (
                rotate_affine_transform_v1(&entity.transform, angle, pivot),
                active,
            )
        }
        _ => {
            return Err(EvaluationError::MalformedScene(
                "retained transform channel index has the wrong kind",
            ));
        }
    };
    // V1 evidence is deliberately limited to the entity's own sampled channel
    // before motion/world composition. Ancestor or motion-induced singularity,
    // and any composition that loses exact singularity, remain fail-closed.
    //
    // The predicate is the one `poietra-scene-ir` validates against, so
    // evaluation and packet validation cannot classify a sample differently.
    // It is the renderer's threshold rather than an exact zero:
    // `stretch(1e-50, 1)` survives an f64 determinant but collapses in f32
    // preparation, which would fail the whole frame instead of this draw.
    let singular = active && affine_transform_is_singular_v1(&transform);
    Ok((transform, singular))
}

fn sample_vector_appearance(
    index: &RetainedSceneIndexV1,
    scene: &SceneIrV1,
    entity_index: usize,
    entity: &SceneEntityV1,
    time: f64,
) -> Result<Option<VectorAppearanceValueV1>, EvaluationError> {
    let base = match &entity.appearance {
        SceneAppearanceV1::Vector { fill, stroke, .. } => Some(VectorAppearanceValueV1 {
            fill: fill.clone(),
            stroke: stroke.clone(),
        }),
        SceneAppearanceV1::Group { .. } | SceneAppearanceV1::Image { .. } => None,
    };
    let Some(channel_index) = index.vector_appearance_channel(entity_index) else {
        return Ok(base);
    };
    let Some(AnimationChannelV1::VectorAppearance { keyframes, .. }) =
        scene.animation_channels.get(channel_index)
    else {
        return Err(EvaluationError::MalformedScene(
            "retained vector-appearance channel index has the wrong kind",
        ));
    };
    let Some(base) = &base else {
        return Err(EvaluationError::MalformedScene(
            "vector-appearance channel targets image appearance",
        ));
    };
    sample_keyframes(base, keyframes, time, interpolate_vector_appearance)
        .map(|sample| Some(normalize_vector_appearance_stroke(sample.0)))
}

fn sample_local_entity(
    index: &RetainedSceneIndexV1,
    scene: &SceneIrV1,
    entity_index: usize,
    entity: &SceneEntityV1,
    time: f64,
) -> Result<LocalSample, EvaluationError> {
    let base_opacity = appearance_opacity(&entity.appearance);
    let opacity = if let Some(channel_index) = index.opacity_channel(entity_index) {
        let Some(AnimationChannelV1::Opacity { keyframes, .. }) =
            scene.animation_channels.get(channel_index)
        else {
            return Err(EvaluationError::MalformedScene(
                "retained opacity channel index has the wrong kind",
            ));
        };
        sample_keyframes(&base_opacity, keyframes, time, interpolate_number)?.0
    } else {
        base_opacity
    };

    let appearance = sample_vector_appearance(index, scene, entity_index, entity, time)?;

    let (mut transform, singular_affine_sample) =
        sample_affine_transform(index, scene, entity_index, entity, time)?;
    if let Some(channel_index) = index.motion_channel(entity_index) {
        let Some(AnimationChannelV1::MotionPath {
            keyframes,
            path,
            orient_to_path,
            parameterization,
            ..
        }) = scene.animation_channels.get(channel_index)
        else {
            return Err(EvaluationError::MalformedScene(
                "retained motion channel index has the wrong kind",
            ));
        };
        let (progress, active) = sample_keyframes(&0.0, keyframes, time, interpolate_number)?;
        if active {
            transform = match parameterization {
                None | Some(MotionPathParameterizationV1::ArcLengthV1) => {
                    apply_motion_path_v1(&transform, path, progress, *orient_to_path)?
                }
                Some(MotionPathParameterizationV1::ManimPointFromProportionV1) => {
                    apply_manim_motion_path_v1(&transform, path, progress, *orient_to_path)?
                }
            };
        }
    }

    if matches!(
        &entity.geometry,
        SceneGeometryV1::Group {} | SceneGeometryV1::Image { .. }
    ) {
        return Ok(LocalSample {
            empty_reason: None,
            fill: None,
            opacity,
            path: None,
            stroke: None,
            transform,
        });
    }
    let mut path = scene_geometry_as_cubic_path_v1(&entity.geometry)?;
    if let Some(channel_index) = index.path_morph_channel(entity_index) {
        let Some(AnimationChannelV1::PathMorph { keyframes, .. }) =
            scene.animation_channels.get(channel_index)
        else {
            return Err(EvaluationError::MalformedScene(
                "retained path-morph channel index has the wrong kind",
            ));
        };
        path = sample_keyframes(&path, keyframes, time, interpolate_cubic_path_v1)?.0;
    }
    let mut empty_reason =
        singular_affine_sample.then_some(RenderEmptyReasonV1::SingularAffineSample);
    if let Some(channel_index) = index.path_trim_channel(entity_index) {
        let Some(AnimationChannelV1::PathTrim {
            keyframes,
            parameterization,
            ..
        }) = scene.animation_channels.get(channel_index)
        else {
            return Err(EvaluationError::MalformedScene(
                "retained path-trim channel index has the wrong kind",
            ));
        };
        let progress = sample_keyframes(&1.0, keyframes, time, interpolate_number)?.0;
        if progress == 0.0 {
            empty_reason = Some(RenderEmptyReasonV1::PathTrimZero);
        } else {
            path = match parameterization {
                None | Some(PathTrimParameterizationV1::ArcLengthV1) => {
                    trim_cubic_path_v1(&path, progress)?
                }
                Some(PathTrimParameterizationV1::UniformCubicParameterV1) => {
                    trim_cubic_path_uniform_parameter_v1(&path, progress)?
                }
            };
        }
    }
    Ok(LocalSample {
        empty_reason,
        fill: appearance.as_ref().and_then(|value| value.fill.clone()),
        opacity,
        path: Some(path),
        stroke: appearance.and_then(|value| value.stroke),
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
    index: &RetainedSceneIndexV1,
    local: &[Option<LocalSample>],
) -> Result<Vec<Option<WorldSample>>, EvaluationError> {
    let mut output: Vec<Option<WorldSample>> = vec![None; scene.entities.len()];
    for &entity_index in index.hierarchy_order() {
        let Some(local_sample) = local.get(entity_index).and_then(Option::as_ref) else {
            continue;
        };
        let parent_sample = index
            .parent(entity_index)
            .map(|parent_index| {
                output.get(parent_index).and_then(Option::as_ref).ok_or(
                    EvaluationError::MalformedScene("active entity has no sampled parent"),
                )
            })
            .transpose()?;
        output[entity_index] = Some(WorldSample {
            opacity: parent_sample.map_or(1.0, |parent| parent.opacity) * local_sample.opacity,
            transform: parent_sample.map_or_else(
                || local_sample.transform.clone(),
                |parent| compose_affine_transforms_v1(&parent.transform, &local_sample.transform),
            ),
        });
    }
    Ok(output)
}

fn sample_camera(
    scene: &SceneIrV1,
    index: &RetainedSceneIndexV1,
    time: f64,
) -> Result<SceneCameraViewV1, EvaluationError> {
    index.camera_channel().map_or_else(
        || Ok(scene.camera.view.clone()),
        |channel_index| {
            let Some(AnimationChannelV1::Camera { keyframes, .. }) =
                scene.animation_channels.get(channel_index)
            else {
                return Err(EvaluationError::MalformedScene(
                    "retained camera channel index has the wrong kind",
                ));
            };
            sample_keyframes(&scene.camera.view, keyframes, time, interpolate_camera)
                .map(|sample| sample.0)
        },
    )
}

fn render_capabilities(draws: &[RenderDrawV1]) -> Vec<RenderCapabilityV1> {
    let mut capabilities = BTreeSet::new();
    for draw in draws {
        match draw {
            RenderDrawV1::Empty { .. } => {}
            RenderDrawV1::Image { .. } => {
                capabilities.insert(RenderCapabilityV1::PngImage);
            }
            RenderDrawV1::Path { fill, stroke, .. } => {
                if fill.is_some() {
                    capabilities.insert(RenderCapabilityV1::CubicPathFill);
                }
                if fill
                    .as_ref()
                    .is_some_and(|fill| fill.fragment_material.is_some())
                    || stroke
                        .as_ref()
                        .is_some_and(|stroke| stroke.fragment_material.is_some())
                {
                    capabilities.insert(RenderCapabilityV1::FragmentMaterial);
                }
                if fill
                    .as_ref()
                    .and_then(|fill| fill.fragment_material.as_ref())
                    .is_some_and(|material| material.texture.is_some())
                    || stroke
                        .as_ref()
                        .and_then(|stroke| stroke.fragment_material.as_ref())
                        .is_some_and(|material| material.texture.is_some())
                {
                    capabilities.insert(RenderCapabilityV1::PngImage);
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
    index: &RetainedSceneIndexV1,
) -> Result<RenderPacketV1, EvaluationError> {
    compile_render_packet_with_camera_fit_v1(options, index, CameraViewportFitV1::Exact)
}

#[allow(clippy::too_many_lines)] // One contiguous sample-and-assemble pipeline.
fn compile_render_packet_with_camera_fit_v1(
    options: CompileEngineFrameOptionsV1<'_>,
    index: &RetainedSceneIndexV1,
    camera_fit: CameraViewportFitV1,
) -> Result<RenderPacketV1, EvaluationError> {
    if !options.sample_time.is_finite()
        || options.sample_time < 0.0
        || options.sample_time > options.scene.duration
    {
        return Err(EvaluationError::InvalidInput(
            "sampleTime must be finite and inside Scene duration".to_owned(),
        ));
    }
    let state_sample_time = options.scene.state_sample_time(options.sample_time);

    let active: Vec<_> = index
        .stable_paint_order()
        .iter()
        .copied()
        .filter(|entity_index| {
            let entity = &options.scene.entities[*entity_index];
            entity.visible && entity_is_active(entity, state_sample_time)
        })
        .collect();
    let mut local = vec![None; options.scene.entities.len()];
    for &entity_index in &active {
        let entity = &options.scene.entities[entity_index];
        local[entity_index] = Some(sample_local_entity(
            index,
            options.scene,
            entity_index,
            entity,
            state_sample_time,
        )?);
    }
    let world = world_samples(options.scene, index, &local)?;

    let draws = active
        .into_iter()
        .filter(|entity_index| {
            !matches!(
                options.scene.entities[*entity_index].geometry,
                SceneGeometryV1::Group {}
            )
        })
        .enumerate()
        .map(|(paint_order, entity_index)| {
            let paint_order = u32::try_from(paint_order)
                .map_err(|_| EvaluationError::MalformedScene("draw count exceeds u32"))?;
            let entity = &options.scene.entities[entity_index];
            let local_sample = local.get(entity_index).and_then(Option::as_ref).ok_or(
                EvaluationError::MalformedScene("entity has no local sample"),
            )?;
            let world_sample = world.get(entity_index).and_then(Option::as_ref).ok_or(
                EvaluationError::MalformedScene("entity has no world sample"),
            )?;
            let draw_id = format!("draw:{}", entity.scene_order);
            if let Some(reason) = local_sample.empty_reason {
                return match (&entity.geometry, &entity.appearance) {
                    (SceneGeometryV1::Group {}, _) | (_, SceneAppearanceV1::Group { .. }) => {
                        Err(EvaluationError::MalformedScene(
                            "logical group reached drawable packet assembly",
                        ))
                    }
                    (SceneGeometryV1::Image { .. }, _) => Err(EvaluationError::MalformedScene(
                        "image entity sampled an empty vector visual",
                    )),
                    (_, SceneAppearanceV1::Vector { .. }) => Ok(RenderDrawV1::Empty {
                        draw_id,
                        entity_id: entity.id.clone(),
                        opacity: world_sample.opacity,
                        paint_order,
                        reason,
                        source_z_index: entity.source_z_index,
                        transform: world_sample.transform.clone(),
                    }),
                    (_, SceneAppearanceV1::Image { .. }) => Err(EvaluationError::MalformedScene(
                        "vector geometry has image appearance",
                    )),
                };
            }
            match (&entity.geometry, &entity.appearance) {
                (SceneGeometryV1::Group {}, _) | (_, SceneAppearanceV1::Group { .. }) => {
                    Err(EvaluationError::MalformedScene(
                        "logical group reached drawable packet assembly",
                    ))
                }
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
                (_, SceneAppearanceV1::Vector { .. }) => Ok(RenderDrawV1::Path {
                    draw_id,
                    entity_id: entity.id.clone(),
                    fill: local_sample.fill.clone(),
                    opacity: world_sample.opacity,
                    paint_order,
                    path: local_sample
                        .path
                        .clone()
                        .ok_or(EvaluationError::MalformedScene("vector entity has no path"))?,
                    source_z_index: entity.source_z_index,
                    stroke: local_sample.stroke.clone(),
                    transform: world_sample.transform.clone(),
                }),
                (_, SceneAppearanceV1::Image { .. }) => Err(EvaluationError::MalformedScene(
                    "vector geometry has image appearance",
                )),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;

    let camera = sample_camera(options.scene, index, state_sample_time)?;
    let camera = match camera_fit {
        CameraViewportFitV1::Exact => camera,
        CameraViewportFitV1::WidenToViewportAspect => {
            fit_camera_view_to_viewport_v1(camera, &options.viewport)
        }
    };
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
        compositing: options.scene.compositing,
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
/// [`EvaluationError::RetainedIndex`] when the bounded derived index cannot be accounted or
/// allocated, [`EvaluationError::Geometry`] for undefined geometry semantics,
/// [`EvaluationError::InvalidOutput`] if the sampled packet fails its integrity check, or
/// [`EvaluationError::MalformedScene`] if a validated Scene cannot satisfy evaluator invariants.
pub fn compile_render_packet_v1(
    options: CompileEngineFrameOptionsV1<'_>,
) -> Result<RenderPacketV1, EvaluationError> {
    validate_scene_ir_with_assets_v1(options.scene, options.assets)
        .map_err(|error| EvaluationError::InvalidInput(error.to_string()))?;
    let index = RetainedSceneIndexV1::build(options.scene)?;
    compile_render_packet_from_validated_v1(options, &index)
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
        FillStyleV1, IntervalV1, ProvenanceOriginV1, ProvenanceRecordV1, RenderCompositingV1,
        RgbaColorV1, SceneCameraV1, SceneCapabilityV1, SceneIrSchemaV1, SceneSourceV1,
        SceneStateSamplingV1, SnapshotProfileVersionV1, StrokeCapV1, StrokeJoinV1, StrokeStyleV1,
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
            compositing: RenderCompositingV1::LinearLight,
            coordinate_space: CoordinateSpaceV1::default(),
            duration: 2.0,
            entities: vec![SceneEntityV1 {
                appearance: SceneAppearanceV1::Vector {
                    fill: Some(FillStyleV1 {
                        color: color(1.0, 0.0, 0.0, 1.0),
                        fragment_material: None,
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
                visible: true,
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
            state_sampling: SceneStateSamplingV1 {
                frame_rate: None,
                retains_terminal_state: false,
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
    fn export_sampling_widens_the_camera_window_to_the_sd_ladder_rung() {
        let (assets, scene) = fixture();
        let session = EngineSessionV1::new(SceneIrBundleV1 { assets, scene })
            .expect("the evaluator fixture must validate");
        let sd_viewport = ViewportV1 {
            height_px: 480,
            width_px: 854,
        };

        // Interactive sampling keeps the camera authoritative and refuses the
        // sub-pixel aspect mismatch of the SD export rung.
        let interactive = session.sample_render_packet(SampleEngineSessionOptionsV1 {
            evidence: &[],
            packet_id: "packet:interactive-sd",
            sample_time: 0.5,
            viewport: sd_viewport.clone(),
        });
        assert!(matches!(
            interactive,
            Err(EvaluationError::InvalidOutput(message)) if message.contains("aspect")
        ));

        // Export sampling widens the window about its center: height is kept,
        // width grows below one pixel column, and the world aspect equals the
        // pixel aspect exactly.
        let packet = session
            .sample_export_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "packet:export-sd",
                sample_time: 0.5,
                viewport: sd_viewport,
            })
            .expect("the SD rung must sample through the export camera fit");
        let width = packet.camera.right - packet.camera.left;
        let height = packet.camera.top - packet.camera.bottom;
        assert_eq!(height.to_bits(), 9.0_f64.to_bits());
        assert!((width / height - 854.0 / 480.0).abs() < 1.0e-12);
        assert!(
            width > 16.0 && width < 16.03,
            "width {width} must widen sub-pixel"
        );
        assert_eq!(
            packet.camera.left.to_bits(),
            (-packet.camera.right).to_bits()
        );
    }

    #[test]
    fn export_sampling_is_bit_identical_on_aspect_exact_rungs() {
        let (assets, scene) = fixture();
        let session = EngineSessionV1::new(SceneIrBundleV1 { assets, scene })
            .expect("the evaluator fixture must validate");
        let sample = |packet_id: &str, export: bool| {
            let options = SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id,
                sample_time: 0.5,
                viewport: ViewportV1 {
                    height_px: 1080,
                    width_px: 1920,
                },
            };
            if export {
                session.sample_export_render_packet(options)
            } else {
                session.sample_render_packet(options)
            }
            .expect("aspect-exact rungs must sample on both paths")
        };
        let interactive = sample("packet:parity", false);
        let export = sample("packet:parity", true);
        assert_eq!(
            serde_json::to_string(&interactive).expect("packets serialize"),
            serde_json::to_string(&export).expect("packets serialize"),
            "an aspect-exact viewport must sample bit-identically on both paths"
        );
    }

    #[test]
    fn emits_scene_compositing_independently_of_source_profile() {
        let (assets, mut scene) = fixture();
        scene.compositing = RenderCompositingV1::ManimCairoSrgb;
        scene.source = SceneSourceV1::ImportedManimServerSnapshot {
            runtime_config_hash: "0".repeat(64),
            snapshot_hash: "0".repeat(64),
            snapshot_version: SnapshotProfileVersionV1::V11,
            source_hash: "0".repeat(64),
        };
        let compile = |scene: &SceneIrV1, packet_id: &str| {
            compile_render_packet_v1(CompileEngineFrameOptionsV1 {
                assets: &assets,
                evidence: &[],
                packet_id,
                sample_time: 1.0,
                scene,
                viewport: ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap()
        };

        let v11 = compile(&scene, "packet:v11");
        assert_eq!(v11.compositing, RenderCompositingV1::ManimCairoSrgb);
        assert_eq!(
            serde_json::to_value(&v11).unwrap()["compositing"],
            "manim-cairo-srgb"
        );

        let set_snapshot_version = |scene: &mut SceneIrV1, version| {
            let SceneSourceV1::ImportedManimServerSnapshot {
                snapshot_version, ..
            } = &mut scene.source
            else {
                unreachable!()
            };
            *snapshot_version = version;
        };
        set_snapshot_version(&mut scene, SnapshotProfileVersionV1::V8);
        let v8 = compile(&scene, "packet:v8");
        assert_eq!(v8.compositing, RenderCompositingV1::ManimCairoSrgb);

        set_snapshot_version(&mut scene, SnapshotProfileVersionV1::V12);
        let v12 = compile(&scene, "packet:v12");
        assert_eq!(v12.compositing, RenderCompositingV1::ManimCairoSrgb);

        set_snapshot_version(&mut scene, SnapshotProfileVersionV1::V9);
        let v9 = compile(&scene, "packet:v9");
        assert_eq!(v9.compositing, RenderCompositingV1::ManimCairoSrgb);

        set_snapshot_version(&mut scene, SnapshotProfileVersionV1::V10);
        let v10 = compile(&scene, "packet:v10");
        assert_eq!(v10.compositing, RenderCompositingV1::ManimCairoSrgb);

        scene.compositing = RenderCompositingV1::LinearLight;
        let linear = compile(&scene, "packet:linear");
        assert_eq!(linear.compositing, RenderCompositingV1::LinearLight);
        assert!(
            serde_json::to_value(&linear)
                .unwrap()
                .get("compositing")
                .is_none()
        );
    }

    #[test]
    fn scene_sampling_retains_its_final_hold_independently_of_source_profile() {
        let (assets, mut scene) = fixture();
        scene.source = SceneSourceV1::ImportedManimServerSnapshot {
            runtime_config_hash: "0".repeat(64),
            snapshot_hash: "0".repeat(64),
            snapshot_version: SnapshotProfileVersionV1::V9,
            source_hash: "0".repeat(64),
        };
        scene.state_sampling.retains_terminal_state = true;
        let packet = compile_render_packet_v1(CompileEngineFrameOptionsV1 {
            assets: &assets,
            evidence: &[],
            packet_id: "packet:v12-duration",
            sample_time: scene.duration,
            scene: &scene,
            viewport: ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();

        assert_eq!(packet.sample_time.to_bits(), scene.duration.to_bits());
        assert_eq!(packet.draws.len(), 1);
    }

    #[test]
    fn compiles_manim_smooth_opacity_at_an_interior_sample() {
        let (assets, mut scene) = fixture();
        let AnimationChannelV1::Opacity { keyframes, .. } = &mut scene.animation_channels[0] else {
            panic!("fixture must contain an opacity channel");
        };
        keyframes[0].easing_to_next = Some(poietra_scene_ir::EasingV1::ManimSmooth {});
        let frame = compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
            assets: &assets,
            evidence: &[],
            packet_id: "packet:manim-smooth",
            sample_time: 0.5,
            scene: &scene,
            viewport: ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();

        assert!((frame.packet.draws[0].opacity() - 0.070_103_716_545_108_15).abs() <= 1.0e-15);
    }

    #[test]
    fn keyframe_endpoint_tolerance_preserves_a_short_segment() {
        let keyframes = [
            KeyframeV1 {
                at: 0.0,
                easing_to_next: Some(poietra_scene_ir::EasingV1::Linear {}),
                value: 0.0,
            },
            KeyframeV1 {
                at: f64::EPSILON,
                easing_to_next: None,
                value: 1.0,
            },
        ];

        assert_eq!(
            sample_keyframes(&0.0, &keyframes, 0.0, interpolate_number)
                .unwrap()
                .0,
            0.0
        );
        assert_eq!(
            sample_keyframes(&0.0, &keyframes, f64::EPSILON / 2.0, interpolate_number)
                .unwrap()
                .0,
            0.5
        );

        let wider_keyframes = [
            keyframes[0].clone(),
            KeyframeV1 {
                at: 5.0 * f64::EPSILON,
                easing_to_next: None,
                value: 1.0,
            },
        ];
        assert_eq!(
            sample_keyframes(&0.0, &wider_keyframes, f64::EPSILON, interpolate_number)
                .unwrap()
                .0,
            0.2
        );
    }

    #[test]
    fn finite_hierarchy_inputs_fail_closed_when_affine_composition_overflows() {
        let (assets, mut scene) = fixture();
        scene.entities[0].transform.m11 = f64::MAX;
        let mut child = scene.entities[0].clone();
        child.id = "child".to_owned();
        child.parent_id = Some("circle".to_owned());
        child.scene_order = 1;
        child.transform = AffineTransformV1 {
            m11: 2.0,
            ..AffineTransformV1::identity()
        };
        scene.entities.push(child);

        let error = compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
            assets: &assets,
            evidence: &[],
            packet_id: "packet:hierarchy-overflow",
            sample_time: 1.0,
            scene: &scene,
            viewport: ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap_err();

        assert!(matches!(error, EvaluationError::InvalidOutput(_)));
    }

    #[test]
    fn logical_group_composes_hierarchy_state_without_emitting_a_draw() {
        let (assets, mut scene) = fixture();
        scene.animation_channels.clear();
        let mut child = scene.entities[0].clone();
        child.id = "child".to_owned();
        child.parent_id = Some("group".to_owned());
        child.scene_order = 1;
        child.transform.tx = 2.0;
        child.transform.ty = 3.0;
        let SceneAppearanceV1::Vector { opacity, .. } = &mut child.appearance else {
            panic!("fixture child must be vector appearance");
        };
        *opacity = 0.5;
        let group = SceneEntityV1 {
            appearance: SceneAppearanceV1::Group { opacity: 0.5 },
            geometry: SceneGeometryV1::Group {},
            id: "group".to_owned(),
            lifetimes: vec![IntervalV1 {
                end: 2.0,
                start: 0.0,
            }],
            parent_id: None,
            provenance_id: "fixture".to_owned(),
            scene_order: 0,
            source_z_index: 0.0,
            transform: AffineTransformV1 {
                tx: 10.0,
                ty: 5.0,
                ..AffineTransformV1::identity()
            },
            visible: true,
        };
        scene.entities = vec![group, child];
        scene.required_capabilities = vec![
            SceneCapabilityV1::LogicalGroup,
            SceneCapabilityV1::ShapePrimitives,
        ];

        let frame = compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
            assets: &assets,
            evidence: &[],
            packet_id: "packet:logical-group",
            sample_time: 0.5,
            scene: &scene,
            viewport: ViewportV1 {
                height_px: 900,
                width_px: 1600,
            },
        })
        .unwrap();

        let [
            RenderDrawV1::Path {
                entity_id,
                opacity,
                paint_order,
                transform,
                ..
            },
        ] = frame.packet.draws.as_slice()
        else {
            panic!("only the logical group's child must produce a path draw");
        };
        assert_eq!(entity_id, "child");
        assert!((*opacity - 0.25).abs() < f64::EPSILON);
        assert_eq!(*paint_order, 0);
        assert!((transform.tx - 12.0).abs() < f64::EPSILON);
        assert!((transform.ty - 8.0).abs() < f64::EPSILON);
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
    fn zero_trim_is_an_explicit_empty_visual_while_positive_trim_is_a_path() {
        let (assets, mut scene) = fixture();
        scene.entities[0].appearance = SceneAppearanceV1::Vector {
            fill: None,
            opacity: 1.0,
            stroke: Some(StrokeStyleV1 {
                cap: StrokeCapV1::Round,
                color: color(1.0, 0.0, 0.0, 1.0),
                dash_length_world: None,
                fragment_material: None,
                gap_length_world: None,
                join: StrokeJoinV1::Round,
                miter_limit: 4.0,
                width_world: 0.1,
            }),
        };
        scene.animation_channels.push(AnimationChannelV1::PathTrim {
            entity_id: "circle".to_owned(),
            id: "trim:circle".to_owned(),
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
            parameterization: None,
            provenance_id: "fixture".to_owned(),
        });
        scene.required_capabilities = vec![
            SceneCapabilityV1::OpacityAnimation,
            SceneCapabilityV1::PathTrimAnimation,
            SceneCapabilityV1::ShapePrimitives,
        ];

        let compile = |sample_time| {
            compile_engine_frame_v1(CompileEngineFrameOptionsV1 {
                assets: &assets,
                evidence: &[],
                packet_id: "packet:trim",
                sample_time,
                scene: &scene,
                viewport: ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap()
        };

        let empty = compile(0.0);
        assert!(matches!(
            empty.packet.draws.as_slice(),
            [RenderDrawV1::Empty {
                reason: RenderEmptyReasonV1::PathTrimZero,
                ..
            }]
        ));
        assert!(empty.packet.required_capabilities.is_empty());

        let positive = compile(0.001);
        assert!(matches!(
            positive.packet.draws.as_slice(),
            [RenderDrawV1::Path { .. }]
        ));
        assert_eq!(
            positive.packet.required_capabilities,
            vec![RenderCapabilityV1::CubicPathStroke]
        );
    }

    #[test]
    fn retained_affine_reflection_uses_a_draw_local_empty_midpoint() {
        let (assets, mut scene) = fixture();
        let mut sibling = scene.entities[0].clone();
        sibling.id = "sibling".to_owned();
        sibling.scene_order = 1;
        sibling.source_z_index = 1.0;
        scene.entities.push(sibling);
        let mut inherited = scene.entities[0].clone();
        inherited.id = "inherited".to_owned();
        inherited.parent_id = Some("circle".to_owned());
        inherited.scene_order = 2;
        inherited.source_z_index = 2.0;
        scene.entities.push(inherited);
        scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: "circle".to_owned(),
                id: "reflect:circle".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.0,
                        easing_to_next: Some(poietra_scene_ir::EasingV1::Linear {}),
                        value: AffineTransformV1::identity(),
                    },
                    KeyframeV1 {
                        at: 1.0,
                        easing_to_next: None,
                        value: AffineTransformV1 {
                            m11: -1.0,
                            ..AffineTransformV1::identity()
                        },
                    },
                ],
                provenance_id: "fixture".to_owned(),
            });
        scene.required_capabilities = vec![
            SceneCapabilityV1::AffineTransformAnimation,
            SceneCapabilityV1::OpacityAnimation,
            SceneCapabilityV1::ShapePrimitives,
        ];
        let session = EngineSessionV1::new(SceneIrBundleV1 { assets, scene }).unwrap();
        let sample = |sample_time| {
            session
                .sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "packet:reflection-seek",
                    sample_time,
                    viewport: ViewportV1 {
                        height_px: 900,
                        width_px: 1600,
                    },
                })
                .unwrap()
        };

        let identity = sample(0.0);
        let singular = sample(0.5);
        let reflected = sample(1.0);
        let singular_repeat = sample(0.5);
        let identity_repeat = sample(0.0);

        assert!(matches!(identity.draws[0], RenderDrawV1::Path { .. }));
        assert!(matches!(
            singular.draws[0],
            RenderDrawV1::Empty {
                reason: RenderEmptyReasonV1::SingularAffineSample,
                ..
            }
        ));
        assert!(matches!(singular.draws[1], RenderDrawV1::Path { .. }));
        // Parent-induced singularity has no direct-channel empty evidence in
        // this leaf slice and therefore remains fail-closed downstream.
        assert!(matches!(singular.draws[2], RenderDrawV1::Path { .. }));
        assert!(matches!(reflected.draws[0], RenderDrawV1::Path { .. }));
        assert_eq!(singular.draws, singular_repeat.draws);
        assert_eq!(identity.draws, identity_repeat.draws);
    }

    #[test]
    fn near_singular_affine_sample_is_lowered_before_f32_preparation() {
        // `stretch(1e-50, 1)` has a non-zero f64 determinant, so an exact
        // `== 0.0` predicate emits a Path draw here and f32 preparation then
        // collapses it and fails the complete frame. The shared threshold
        // classifies it as singular during evaluation and packet validation.
        let (assets, mut scene) = fixture();
        let mut sibling = scene.entities[0].clone();
        sibling.id = "sibling".to_owned();
        sibling.scene_order = 1;
        sibling.source_z_index = 1.0;
        scene.entities.push(sibling);
        scene
            .animation_channels
            .push(AnimationChannelV1::AffineTransform {
                entity_id: "circle".to_owned(),
                id: "collapse:circle".to_owned(),
                keyframes: vec![
                    KeyframeV1 {
                        at: 0.0,
                        easing_to_next: Some(poietra_scene_ir::EasingV1::Linear {}),
                        value: AffineTransformV1::identity(),
                    },
                    KeyframeV1 {
                        at: 1.0,
                        easing_to_next: None,
                        value: AffineTransformV1 {
                            m11: 1e-50,
                            ..AffineTransformV1::identity()
                        },
                    },
                ],
                provenance_id: "fixture".to_owned(),
            });
        scene.required_capabilities = vec![
            SceneCapabilityV1::AffineTransformAnimation,
            SceneCapabilityV1::OpacityAnimation,
            SceneCapabilityV1::ShapePrimitives,
        ];
        let session = EngineSessionV1::new(SceneIrBundleV1 { assets, scene }).unwrap();
        let packet = session
            .sample_render_packet(SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "packet:near-singular",
                sample_time: 1.0,
                viewport: ViewportV1 {
                    height_px: 900,
                    width_px: 1600,
                },
            })
            .unwrap();

        assert!(matches!(
            packet.draws[0],
            RenderDrawV1::Empty {
                reason: RenderEmptyReasonV1::SingularAffineSample,
                ..
            }
        ));
        // The collapse is draw-local: the sibling still renders.
        assert!(matches!(packet.draws[1], RenderDrawV1::Path { .. }));
    }

    #[test]
    fn retained_uniform_cubic_trim_is_stable_across_non_monotonic_seeks() {
        let (assets, mut scene) = fixture();
        scene.entities[0].appearance = SceneAppearanceV1::Vector {
            fill: None,
            opacity: 1.0,
            stroke: Some(StrokeStyleV1 {
                cap: StrokeCapV1::Butt,
                color: color(1.0, 0.0, 0.0, 1.0),
                dash_length_world: None,
                fragment_material: None,
                gap_length_world: None,
                join: StrokeJoinV1::Miter,
                miter_limit: 4.0,
                width_world: 0.1,
            }),
        };
        scene.entities[0].geometry = SceneGeometryV1::Rectangle {
            center: poietra_scene_ir::PointV1 { x: 0.0, y: 0.0 },
            corner_radius: 0.0,
            height: 2.0,
            width: 4.0,
        };
        scene.animation_channels.push(AnimationChannelV1::PathTrim {
            entity_id: "circle".to_owned(),
            id: "trim:rectangle".to_owned(),
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
            parameterization: Some(PathTrimParameterizationV1::UniformCubicParameterV1),
            provenance_id: "fixture".to_owned(),
        });
        scene.required_capabilities = vec![
            SceneCapabilityV1::OpacityAnimation,
            SceneCapabilityV1::PathTrimAnimation,
            SceneCapabilityV1::ShapePrimitives,
        ];
        let session = EngineSessionV1::new(SceneIrBundleV1 { assets, scene }).unwrap();
        let endpoint_at = |sample_time: f64| {
            let packet_id = format!("packet:uniform:{sample_time}");
            let packet = session
                .sample_render_packet(SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: &packet_id,
                    sample_time,
                    viewport: ViewportV1 {
                        height_px: 900,
                        width_px: 1600,
                    },
                })
                .unwrap();
            let Some(RenderDrawV1::Path { path, .. }) = packet.draws.first() else {
                return None;
            };
            path.subpaths
                .last()
                .and_then(|subpath| subpath.segments.last())
                .map(|segment| segment.end.clone())
        };

        let first = endpoint_at(0.5);
        assert_eq!(
            endpoint_at(1.0),
            Some(poietra_scene_ir::PointV1 { x: -2.0, y: 1.0 })
        );
        assert_eq!(endpoint_at(0.5), first);
        assert_eq!(first, Some(poietra_scene_ir::PointV1 { x: -2.0, y: -1.0 }));
        assert_eq!(endpoint_at(2.0), None);
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
                parameterization: None,
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
