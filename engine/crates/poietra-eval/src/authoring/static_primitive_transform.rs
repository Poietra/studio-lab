use std::collections::BTreeSet;

use poietra_geometry::{interpolate_cubic_path_v1, scene_geometry_as_cubic_path_v1};
use poietra_scene_ir::{
    AnimationChannelV1, ContractVersionV1, CubicPathV1, EasingV1, FidelityV1, IntervalV1,
    KeyframeV1, PointV1, ProvenanceOriginV1, ProvenanceRecordV1, SceneCapabilityV1,
    SceneGeometryV1, SceneIrBundleV1, SceneSourceV1,
};
use serde::Deserialize;

use crate::{EngineSessionV1, EvaluationError};

use super::{StaticRootTransformSourceBinding, unused_channel_id};

const FACT_EPSILON: f64 = 1.0e-9;
const APPROXIMATE_EVIDENCE: &str = "Static primitive Transform uses Poietra's deterministic four-cubic primitive alignment; Manim point alignment is not yet claimed exact.";

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum StaticPrimitiveGeometryFact {
    Circle { radius: f64 },
    Rectangle { height: f64, width: f64 },
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticPrimitivePaintFact {
    pub color: Option<String>,
    pub fill_color: Option<String>,
    pub stroke_color: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StaticPrimitiveTransformFact {
    pub interval: IntervalV1,
    pub source_center: PointV1,
    pub source_entity_id: String,
    pub source_geometry: StaticPrimitiveGeometryFact,
    pub source_name: String,
    pub source_paint: StaticPrimitivePaintFact,
    pub source_scale: f64,
    pub target_center: PointV1,
    pub target_entity_id: String,
    pub target_geometry: StaticPrimitiveGeometryFact,
    pub target_name: String,
    pub target_paint: StaticPrimitivePaintFact,
    pub target_scale: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyStaticPrimitiveTransformCommand {
    pub expected_base_revision: String,
    pub next_revision: String,
    pub source_runtime_bindings: Vec<StaticRootTransformSourceBinding>,
    pub transform: StaticPrimitiveTransformFact,
}

#[derive(Debug, thiserror::Error)]
pub enum ApplyStaticPrimitiveTransformError {
    #[error("the installed Scene revision does not match expectedBaseRevision")]
    StaleBaseRevision,
    #[error("the static primitive Transform must advance to a different Scene revision")]
    RevisionDidNotAdvance,
    #[error(
        "the static primitive Transform facts are unsupported or do not match the installed Scene"
    )]
    Unsupported,
    #[error("the static primitive Transform Scene failed whole-bundle verification: {0}")]
    ResultInvalid(#[from] EvaluationError),
}

fn close_fact(left: f64, right: f64) -> bool {
    left.is_finite()
        && right.is_finite()
        && (left - right).abs() <= FACT_EPSILON * left.abs().max(right.abs()).max(1.0)
}

fn fact_geometry_is_valid(geometry: &StaticPrimitiveGeometryFact) -> bool {
    match geometry {
        StaticPrimitiveGeometryFact::Circle { radius } => radius.is_finite() && *radius > 0.0,
        StaticPrimitiveGeometryFact::Rectangle { height, width } => {
            height.is_finite() && *height > 0.0 && width.is_finite() && *width > 0.0
        }
    }
}

fn path_bounds(path: &CubicPathV1) -> Option<(PointV1, f64, f64)> {
    let subpath = path.subpaths.first()?;
    if path.subpaths.len() != 1 || !subpath.closed || subpath.segments.len() != 4 {
        return None;
    }
    let mut minimum = PointV1 {
        x: subpath.start.x,
        y: subpath.start.y,
    };
    let mut maximum = minimum.clone();
    for point in std::iter::once(&subpath.start).chain(
        subpath
            .segments
            .iter()
            .flat_map(|segment| [&segment.control1, &segment.control2, &segment.end]),
    ) {
        if !point.x.is_finite() || !point.y.is_finite() {
            return None;
        }
        minimum.x = minimum.x.min(point.x);
        minimum.y = minimum.y.min(point.y);
        maximum.x = maximum.x.max(point.x);
        maximum.y = maximum.y.max(point.y);
    }
    let width = maximum.x - minimum.x;
    let height = maximum.y - minimum.y;
    (width > 0.0 && height > 0.0).then_some((
        PointV1 {
            x: minimum.x.midpoint(maximum.x),
            y: minimum.y.midpoint(maximum.y),
        },
        width,
        height,
    ))
}

fn segment_is_linear(
    start: &PointV1,
    control1: &PointV1,
    control2: &PointV1,
    end: &PointV1,
) -> bool {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let scale = dx.abs().max(dy.abs()).max(1.0);
    let cross = |point: &PointV1| dx * (point.y - start.y) - dy * (point.x - start.x);
    cross(control1).abs() <= FACT_EPSILON * scale * scale
        && cross(control2).abs() <= FACT_EPSILON * scale * scale
}

fn cubic_path_matches_fact(
    path: &CubicPathV1,
    fact: &StaticPrimitiveGeometryFact,
    scale: f64,
) -> Option<PointV1> {
    let (center, width, height) = path_bounds(path)?;
    let subpath = &path.subpaths[0];
    let mut start = &subpath.start;
    let linear_segments = subpath
        .segments
        .iter()
        .map(|segment| {
            let linear =
                segment_is_linear(start, &segment.control1, &segment.control2, &segment.end);
            start = &segment.end;
            linear
        })
        .collect::<Vec<_>>();
    let dimensions_match = match fact {
        StaticPrimitiveGeometryFact::Circle { radius } => {
            linear_segments.iter().all(|linear| !linear)
                && close_fact(width, 2.0 * radius * scale)
                && close_fact(height, 2.0 * radius * scale)
        }
        StaticPrimitiveGeometryFact::Rectangle {
            height: expected_height,
            width: expected_width,
        } => {
            linear_segments.iter().all(|linear| *linear)
                && close_fact(width, expected_width * scale)
                && close_fact(height, expected_height * scale)
        }
    };
    dimensions_match.then_some(center)
}

fn geometry_matches_fact(
    geometry: &SceneGeometryV1,
    fact: &StaticPrimitiveGeometryFact,
    scale: f64,
) -> Option<PointV1> {
    match (geometry, fact) {
        (
            SceneGeometryV1::Circle { center, radius },
            StaticPrimitiveGeometryFact::Circle {
                radius: expected_radius,
            },
        ) if close_fact(*radius, expected_radius * scale) => Some(center.clone()),
        (
            SceneGeometryV1::Rectangle {
                center,
                corner_radius,
                height,
                width,
            },
            StaticPrimitiveGeometryFact::Rectangle {
                height: expected_height,
                width: expected_width,
            },
        ) if close_fact(*corner_radius, 0.0)
            && close_fact(*height, expected_height * scale)
            && close_fact(*width, expected_width * scale) =>
        {
            Some(center.clone())
        }
        (SceneGeometryV1::CubicPath { path }, _) => cubic_path_matches_fact(path, fact, scale),
        _ => None,
    }
}

fn scene_geometry(
    fact: &StaticPrimitiveGeometryFact,
    center: PointV1,
    scale: f64,
) -> SceneGeometryV1 {
    match fact {
        StaticPrimitiveGeometryFact::Circle { radius } => SceneGeometryV1::Circle {
            center,
            radius: radius * scale,
        },
        StaticPrimitiveGeometryFact::Rectangle { height, width } => SceneGeometryV1::Rectangle {
            center,
            corner_radius: 0.0,
            height: height * scale,
            width: width * scale,
        },
    }
}

fn transform_fact_is_closed(fact: &StaticPrimitiveTransformFact, duration: f64) -> bool {
    fact.source_entity_id != fact.target_entity_id
        && !fact.source_entity_id.is_empty()
        && !fact.target_entity_id.is_empty()
        && !fact.source_name.is_empty()
        && !fact.target_name.is_empty()
        && fact.source_name != fact.target_name
        && fact.interval.start.is_finite()
        && fact.interval.end.is_finite()
        && fact.interval.start >= 0.0
        && fact.interval.end > fact.interval.start
        && fact.interval.end <= duration
        // These centers and scales are source-analysis facts in Studio viewport
        // coordinates. They authorize only a no-placement-change Transform;
        // they are deliberately not compared with Scene-local coordinates.
        && fact.source_center.x.is_finite()
        && fact.source_center.y.is_finite()
        && close_fact(fact.source_center.x, fact.target_center.x)
        && close_fact(fact.source_center.y, fact.target_center.y)
        && fact.source_scale.is_finite()
        && fact.source_scale > 0.0
        && close_fact(fact.source_scale, fact.target_scale)
        && fact_geometry_is_valid(&fact.source_geometry)
        && fact_geometry_is_valid(&fact.target_geometry)
        && std::mem::discriminant(&fact.source_geometry)
            != std::mem::discriminant(&fact.target_geometry)
        && fact.source_paint == fact.target_paint
}

fn resolve_source_runtime_entity_id(
    bindings: &[StaticRootTransformSourceBinding],
    fact: &StaticPrimitiveTransformFact,
) -> Option<String> {
    if bindings.iter().any(|binding| {
        binding.source_identity_key == fact.target_name || binding.source_name == fact.target_name
    }) {
        return None;
    }
    let mut matches = bindings.iter().filter(|binding| {
        binding.source_identity_key == fact.source_name && binding.source_name == fact.source_name
    });
    let binding = matches.next()?;
    if matches.next().is_some()
        || bindings
            .iter()
            .filter(|candidate| candidate.runtime_entity_id == binding.runtime_entity_id)
            .count()
            != 1
    {
        return None;
    }
    Some(binding.runtime_entity_id.clone())
}

fn update_required_capabilities(scene: &mut poietra_scene_ir::SceneIrV1) {
    let mut capabilities = scene
        .required_capabilities
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    capabilities.insert(SceneCapabilityV1::CubicPathGeometry);
    capabilities.insert(SceneCapabilityV1::PathMorphAnimation);
    if scene.entities.iter().any(|entity| {
        matches!(
            entity.geometry,
            SceneGeometryV1::Circle { .. }
                | SceneGeometryV1::Rectangle { .. }
                | SceneGeometryV1::Line { .. }
        )
    }) {
        capabilities.insert(SceneCapabilityV1::ShapePrimitives);
    } else {
        capabilities.remove(&SceneCapabilityV1::ShapePrimitives);
    }
    scene.required_capabilities = capabilities.into_iter().collect();
}

fn append_approximate_evidence(scene: &mut poietra_scene_ir::SceneIrV1) {
    match &mut scene.fidelity {
        FidelityV1::Exact {} => {
            scene.fidelity = FidelityV1::Approximate {
                evidence: vec![APPROXIMATE_EVIDENCE.to_owned()],
            };
        }
        FidelityV1::Approximate { evidence } => {
            if !evidence.iter().any(|entry| entry == APPROXIMATE_EVIDENCE) {
                evidence.push(APPROXIMATE_EVIDENCE.to_owned());
            }
        }
    }
}

impl EngineSessionV1 {
    /// Compiles one closed static primitive `Transform(source, target)` fact into a path morph.
    ///
    /// # Errors
    ///
    /// Returns an error without replacing the retained Scene when the fact is stale, incomplete,
    /// unsupported, or inconsistent with the installed source snapshot.
    #[allow(
        clippy::too_many_lines,
        reason = "the atomic admission checks and candidate mutation stay together"
    )]
    pub fn apply_static_primitive_transform(
        &mut self,
        command: ApplyStaticPrimitiveTransformCommand,
    ) -> Result<SceneIrBundleV1, ApplyStaticPrimitiveTransformError> {
        if self.scene().source.revision_hash() != command.expected_base_revision {
            return Err(ApplyStaticPrimitiveTransformError::StaleBaseRevision);
        }
        if command.next_revision == command.expected_base_revision {
            return Err(ApplyStaticPrimitiveTransformError::RevisionDidNotAdvance);
        }
        if !matches!(
            self.scene().source,
            SceneSourceV1::ImportedManimServerSnapshot { .. }
        ) || !transform_fact_is_closed(&command.transform, self.scene().duration)
        {
            return Err(ApplyStaticPrimitiveTransformError::Unsupported);
        }
        let runtime_entity_id =
            resolve_source_runtime_entity_id(&command.source_runtime_bindings, &command.transform)
                .ok_or(ApplyStaticPrimitiveTransformError::Unsupported)?;
        let mut candidate = SceneIrBundleV1 {
            assets: self.assets().clone(),
            scene: self.scene().clone(),
        };
        if candidate.scene.animation_channels.iter().any(|channel| {
            matches!(
                channel,
                AnimationChannelV1::PathMorph { entity_id, .. }
                    if entity_id == &runtime_entity_id
            )
        }) {
            return Err(ApplyStaticPrimitiveTransformError::Unsupported);
        }
        let entity = candidate
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == runtime_entity_id)
            .filter(|entity| entity.parent_id.is_none())
            .ok_or(ApplyStaticPrimitiveTransformError::Unsupported)?;
        if !close_fact(entity.transform.m11, 1.0)
            || !close_fact(entity.transform.m12, 0.0)
            || !close_fact(entity.transform.m21, 0.0)
            || !close_fact(entity.transform.m22, 1.0)
        {
            return Err(ApplyStaticPrimitiveTransformError::Unsupported);
        }
        if !entity.lifetimes.iter().any(|lifetime| {
            lifetime.start <= command.transform.interval.start
                && lifetime.end >= command.transform.interval.end
        }) {
            return Err(ApplyStaticPrimitiveTransformError::Unsupported);
        }
        let local_center = geometry_matches_fact(
            &entity.geometry,
            &command.transform.source_geometry,
            command.transform.source_scale,
        )
        .ok_or(ApplyStaticPrimitiveTransformError::Unsupported)?;
        let source_path = scene_geometry_as_cubic_path_v1(&entity.geometry)
            .map_err(|_| ApplyStaticPrimitiveTransformError::Unsupported)?;
        let target_path = scene_geometry_as_cubic_path_v1(&scene_geometry(
            &command.transform.target_geometry,
            local_center,
            command.transform.target_scale,
        ))
        .map_err(|_| ApplyStaticPrimitiveTransformError::Unsupported)?;
        interpolate_cubic_path_v1(&source_path, &target_path, 0.5)
            .map_err(|_| ApplyStaticPrimitiveTransformError::Unsupported)?;
        entity.geometry = SceneGeometryV1::CubicPath {
            path: source_path.clone(),
        };

        let provenance_id = format!(
            "studio-static-primitive-transform:{}",
            command.next_revision
        );
        let channel_id = unused_channel_id(&candidate.scene, "static-primitive-transform");
        candidate
            .scene
            .animation_channels
            .push(AnimationChannelV1::PathMorph {
                entity_id: runtime_entity_id,
                id: channel_id,
                keyframes: vec![
                    KeyframeV1 {
                        at: command.transform.interval.start,
                        easing_to_next: Some(EasingV1::ManimSmooth {}),
                        value: source_path,
                    },
                    KeyframeV1 {
                        at: command.transform.interval.end,
                        easing_to_next: None,
                        value: target_path,
                    },
                ],
                provenance_id: provenance_id.clone(),
            });
        candidate.scene.provenance.push(ProvenanceRecordV1 {
            evidence: vec![
                "direct top-level static Transform(source, target)".to_owned(),
                format!(
                    "{} -> {} under source identity {}",
                    command.transform.source_entity_id,
                    command.transform.target_entity_id,
                    command.transform.source_name
                ),
            ],
            id: provenance_id,
            origin: ProvenanceOriginV1::StudioEditProgram,
        });
        update_required_capabilities(&mut candidate.scene);
        append_approximate_evidence(&mut candidate.scene);
        candidate.scene.source = SceneSourceV1::StudioEditProgram {
            edit_program_version: ContractVersionV1,
            revision_hash: command.next_revision,
        };
        self.replace_snapshot(candidate.clone())?;
        Ok(candidate)
    }
}

#[cfg(test)]
mod tests {
    use poietra_scene_ir::{AnimationChannelV1, SceneGeometryV1};

    use super::super::tests::{BASE_REVISION, NEXT_REVISION, static_imported_bundle};
    use super::*;

    fn command() -> ApplyStaticPrimitiveTransformCommand {
        ApplyStaticPrimitiveTransformCommand {
            expected_base_revision: BASE_REVISION.to_owned(),
            next_revision: NEXT_REVISION.to_owned(),
            source_runtime_bindings: vec![StaticRootTransformSourceBinding {
                runtime_entity_id: "later".to_owned(),
                source_identity_key: "square".to_owned(),
                source_name: "square".to_owned(),
            }],
            transform: StaticPrimitiveTransformFact {
                interval: IntervalV1 {
                    end: 2.0,
                    start: 1.0,
                },
                source_center: PointV1 { x: 320.0, y: 180.0 },
                source_entity_id: "source:scene.py#SquareToCircle:square".to_owned(),
                source_geometry: StaticPrimitiveGeometryFact::Rectangle {
                    height: 2.0,
                    width: 2.0,
                },
                source_name: "square".to_owned(),
                source_paint: StaticPrimitivePaintFact::default(),
                source_scale: 1.0,
                target_center: PointV1 { x: 320.0, y: 180.0 },
                target_entity_id: "source:scene.py#SquareToCircle:circle".to_owned(),
                target_geometry: StaticPrimitiveGeometryFact::Circle { radius: 1.0 },
                target_name: "circle".to_owned(),
                target_paint: StaticPrimitivePaintFact::default(),
                target_scale: 1.0,
            },
        }
    }

    fn square_bundle() -> SceneIrBundleV1 {
        let mut bundle = static_imported_bundle();
        let entity = bundle
            .scene
            .entities
            .iter_mut()
            .find(|entity| entity.id == "later")
            .unwrap();
        let primitive = SceneGeometryV1::Rectangle {
            center: PointV1 { x: 0.0, y: 0.0 },
            corner_radius: 0.0,
            height: 2.0,
            width: 2.0,
        };
        entity.geometry = SceneGeometryV1::CubicPath {
            path: scene_geometry_as_cubic_path_v1(&primitive).unwrap(),
        };
        update_required_capabilities(&mut bundle.scene);
        bundle
            .scene
            .required_capabilities
            .retain(|capability| *capability != SceneCapabilityV1::PathMorphAnimation);
        bundle
    }

    #[test]
    fn authors_one_path_morph_under_the_source_identity() {
        let mut session = EngineSessionV1::new(square_bundle()).unwrap();

        let result = session.apply_static_primitive_transform(command()).unwrap();

        let entity = result
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert!(matches!(entity.geometry, SceneGeometryV1::CubicPath { .. }));
        let base = square_bundle();
        let base_entity = base
            .scene
            .entities
            .iter()
            .find(|entity| entity.id == "later")
            .unwrap();
        assert_eq!(entity.lifetimes, base_entity.lifetimes);
        let morph = result
            .scene
            .animation_channels
            .iter()
            .find_map(|channel| match channel {
                AnimationChannelV1::PathMorph {
                    entity_id,
                    keyframes,
                    ..
                } => Some((entity_id, keyframes)),
                _ => None,
            })
            .unwrap();
        assert_eq!(morph.0, "later");
        assert!(close_fact(morph.1[0].at, 1.0));
        assert!(close_fact(morph.1[1].at, 2.0));
        assert_eq!(session.scene(), &result.scene);
    }

    #[test]
    fn canonical_evaluator_samples_source_middle_and_target_paths() {
        let mut session = EngineSessionV1::new(square_bundle()).unwrap();
        let result = session.apply_static_primitive_transform(command()).unwrap();
        let AnimationChannelV1::PathMorph { keyframes, .. } = result
            .scene
            .animation_channels
            .iter()
            .find(|channel| matches!(channel, AnimationChannelV1::PathMorph { .. }))
            .unwrap()
        else {
            unreachable!();
        };

        let path_is_close = |left: &poietra_scene_ir::CubicPathV1,
                             right: &poietra_scene_ir::CubicPathV1| {
            left.subpaths.len() == right.subpaths.len()
                && left
                    .subpaths
                    .iter()
                    .zip(&right.subpaths)
                    .all(|(left, right)| {
                        left.closed == right.closed
                            && left.segments.len() == right.segments.len()
                            && std::iter::once((&left.start, &right.start))
                                .chain(left.segments.iter().zip(&right.segments).flat_map(
                                    |(left, right)| {
                                        [
                                            (&left.control1, &right.control1),
                                            (&left.control2, &right.control2),
                                            (&left.end, &right.end),
                                        ]
                                    },
                                ))
                                .all(|(left, right)| {
                                    close_fact(left.x, right.x) && close_fact(left.y, right.y)
                                })
                    })
        };
        for (time, expected) in [(1.0, &keyframes[0].value), (2.0, &keyframes[1].value)] {
            let packet = session
                .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                    evidence: &[],
                    packet_id: "static-primitive-transform",
                    sample_time: time,
                    viewport: poietra_scene_ir::ViewportV1 {
                        height_px: 360,
                        width_px: 640,
                    },
                })
                .unwrap();
            let poietra_scene_ir::RenderDrawV1::Path { path, .. } = packet
                .draws
                .iter()
                .find(|draw| draw.entity_id() == "later")
                .unwrap()
            else {
                panic!("transformed primitive must remain a path draw");
            };
            assert!(path_is_close(path, expected));
        }
        let middle = session
            .sample_render_packet(crate::SampleEngineSessionOptionsV1 {
                evidence: &[],
                packet_id: "static-primitive-transform-middle",
                sample_time: 1.5,
                viewport: poietra_scene_ir::ViewportV1 {
                    height_px: 360,
                    width_px: 640,
                },
            })
            .unwrap();
        let poietra_scene_ir::RenderDrawV1::Path { path, .. } = middle
            .draws
            .iter()
            .find(|draw| draw.entity_id() == "later")
            .unwrap()
        else {
            panic!("transformed primitive must remain a path draw");
        };
        assert_ne!(path, &keyframes[0].value);
        assert_ne!(path, &keyframes[1].value);
    }

    #[test]
    fn rejects_visible_target_paint_changes_and_mismatched_source_facts_atomically() {
        let base = square_bundle();
        let mut visible_target = command();
        visible_target
            .source_runtime_bindings
            .push(StaticRootTransformSourceBinding {
                runtime_entity_id: "earlier".to_owned(),
                source_identity_key: "circle".to_owned(),
                source_name: "circle".to_owned(),
            });
        let mut changed_paint = command();
        changed_paint.transform.target_paint.fill_color = Some("#ff0000".to_owned());
        let mut mismatched_source = command();
        mismatched_source.transform.source_geometry = StaticPrimitiveGeometryFact::Rectangle {
            height: 3.0,
            width: 2.0,
        };

        for invalid in [visible_target, changed_paint, mismatched_source] {
            let mut session = EngineSessionV1::new(base.clone()).unwrap();
            assert!(matches!(
                session.apply_static_primitive_transform(invalid),
                Err(ApplyStaticPrimitiveTransformError::Unsupported)
            ));
            assert_eq!(session.scene(), &base.scene);
        }
    }
}
