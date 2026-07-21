import {
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { LazyMotion, m, useDragControls } from "motion/react";

import {
  type EditSuggestion,
  suggestEdit,
} from "./ai/edit-suggestions";
import { validateEditProgram } from "./ai/edit-program-validation";
import { buildEditProgramSourcePreview } from "./ai/edit-program-source";
import { cn } from "./lib/cn";
import { evaluateWorkingState, programRecord, projectProposedState } from "./studio/evaluator";
import { createFixtureWorkingState, STUDIO_FIXTURE_SCENE } from "./studio/fixture";
import type { ProgramRecord } from "./studio/model";
import {
  type AppliedEdit,
  type DraftEditProgram,
  type EditMode,
  type ExplanationEdit,
  type Interval,
  type MotionRecord,
  type ObjectGroup,
  type ObjectId,
  type PlanId,
  type Point,
  type SceneTransitionEdit,
  type TransformEdit,
  EQUATION,
  FRAME,
  isObjectId,
  isObjectPresentAt,
  LABEL,
  lifetimeEndFor,
  OBJECT_HALF_SIZE,
  OBJECT_LIFETIMES,
  ORIGINAL_EQUATION_LINES,
  ORIGINAL_EQUATION_TEX_PARTS,
  PLAY_SEGMENTS,
  plansFor,
  PROOF_BOX,
  sameObjects,
  SCENE_DURATION,
  SCENE_OBJECTS,
  SOURCE_MOTIONS,
} from "./studio/prototype-fixture";
import {
  addPoints,
  averagePoints,
  clamp,
  easingValue,
  formatTime,
  groupedOperationCount,
  intervalsOverlap,
  intervalStyle,
  patchFor,
  playAt,
  positionStyle,
  quadraticPoint,
  resolveTimeAnchor,
  sampleMotion,
  timeAnchorLabel,
  worldUnits,
} from "./studio/prototype-helpers";
import { EquationContent, EquationMorphContent, SceneObject } from "./studio/prototype-rendering";
import {
  canonicalizeSuggestionProgram,
  createDirectManipulationModifyMotionProgram,
  createDirectManipulationMotionProgram,
  createDirectManipulationPositionProgram,
} from "./studio/suggestion-program";
import { withoutTransaction } from "./studio/transactions";

type Shell = "Browser" | "Electron" | "Tauri";
const loadMotionFeatures = () => import("./lib/motion-features").then((module) => module.default);

function detectShell(): Shell {
  if ("__TAURI_INTERNALS__" in window) return "Tauri";
  if (navigator.userAgent.includes("Electron")) return "Electron";
  return "Browser";
}

export function App() {
  const shell = detectShell();
  const [delta, setDelta] = useState<Point>({ x: 0, y: 0 });
  const [pathBend, setPathBend] = useState<Point>({ x: 0, y: 0 });
  const [draftMotion, setDraftMotion] = useState<Interval | null>(null);
  const [draftMotionTargetIds, setDraftMotionTargetIds] = useState<readonly ObjectId[] | null>(null);
  const [selectedObjectIds, setSelectedObjectIds] = useState<readonly ObjectId[]>(["equation_1"]);
  const [selectedPlanId, setSelectedPlanId] = useState<PlanId>("play-followers");
  const [editMode, setEditMode] = useState<EditMode>("position");
  const [moveDuration, setMoveDuration] = useState(1);
  const [focusedMotionId, setFocusedMotionId] = useState<string | null>("move-equation");
  const [currentTime, setCurrentTime] = useState(5);
  const [isPlaying, setIsPlaying] = useState(false);
  const [appliedEdits, setAppliedEdits] = useState<readonly AppliedEdit[]>([]);
  const [stagedEdits, setStagedEdits] = useState<readonly AppliedEdit[]>([]);
  const [draftTransform, setDraftTransform] = useState<TransformEdit | null>(null);
  const [stagedTransforms, setStagedTransforms] = useState<readonly TransformEdit[]>([]);
  const [appliedTransforms, setAppliedTransforms] = useState<readonly TransformEdit[]>([]);
  const [draftExplanation, setDraftExplanation] = useState<ExplanationEdit | null>(null);
  const [draftEditProgram, setDraftEditProgram] = useState<DraftEditProgram | null>(null);
  const [stagedExplanations, setStagedExplanations] = useState<readonly ExplanationEdit[]>([]);
  const [appliedExplanations, setAppliedExplanations] = useState<readonly ExplanationEdit[]>([]);
  const [draftSceneTransition, setDraftSceneTransition] = useState<SceneTransitionEdit | null>(null);
  const [stagedSceneTransitions, setStagedSceneTransitions] = useState<readonly SceneTransitionEdit[]>([]);
  const [appliedSceneTransitions, setAppliedSceneTransitions] = useState<readonly SceneTransitionEdit[]>([]);
  const [appliedPrograms, setAppliedPrograms] = useState<readonly ProgramRecord[]>([]);
  const [stagedPrograms, setStagedPrograms] = useState<readonly ProgramRecord[]>([]);
  const [draftProgramRecord, setDraftProgramRecord] = useState<ProgramRecord | null>(null);
  const [objectGroups, setObjectGroups] = useState<readonly ObjectGroup[]>([]);
  const [instruction, setInstruction] = useState("");
  const [suggestion, setSuggestion] = useState<EditSuggestion | null>(null);
  const [suggestionMessage, setSuggestionMessage] = useState<string | null>(null);
  const [suggestionStatus, setSuggestionStatus] = useState<"idle" | "loading" | "ready" | "clarification" | "error">("idle");
  const [isComposerVisible, setIsComposerVisible] = useState(true);
  const nextGroupNumber = useRef(1);
  const nextExplanationNumber = useRef(1);
  const nextSceneTransitionNumber = useRef(1);
  const nextCompositeNumber = useRef(1);
  const nextTransactionNumber = useRef(1);
  const suggestionRequest = useRef<AbortController | null>(null);
  const floatingBoardBounds = useRef<HTMLDivElement | null>(null);
  const floatingBoardDragControls = useDragControls();
  const dragState = useRef<{
    pointerId: number;
    clientStart: Point;
    deltaStart: Point;
    bounds: DOMRect;
  } | null>(null);
  const pathDragState = useRef<{
    pointerId: number;
    clientStart: Point;
    bendStart: Point;
    bounds: DOMRect;
  } | null>(null);

  const selectedSet = new Set(selectedObjectIds);
  const selectedObjects = SCENE_OBJECTS.filter((object) => selectedSet.has(object.id));
  const presentObjectIds = SCENE_OBJECTS
    .map((object) => object.id)
    .filter((objectId) => isObjectPresentAt(objectId, currentTime));
  const presentSet = new Set(presentObjectIds);
  const selectedPresentObjectIds = selectedObjectIds.filter((objectId) => presentSet.has(objectId));
  const canEditSelection = selectedPresentObjectIds.length > 0;
  const selectedGroup = objectGroups.find((group) => sameObjects(group.objectIds, selectedObjectIds));
  const selectionLabel = selectedObjects.length === 1
    ? selectedObjects[0].displayName
    : selectedGroup?.name ?? `${selectedObjects.length} selected objects`;
  const selectionInstruction = selectedObjects.length === 1
    ? selectedObjects[0].id
    : selectedGroup?.name ?? `${selectedObjects.length} selected objects together`;
  const selectedPlay = playAt(currentTime);
  const plans = useMemo(
    () => plansFor(selectedObjectIds, currentTime, editMode, moveDuration, selectedGroup?.name),
    [currentTime, editMode, moveDuration, selectedGroup?.name, selectedObjectIds],
  );
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) ?? plans[0];
  const defaultPlanId: PlanId = editMode === "position" ? "play-followers" : "new-move";
  const hasDelta = Math.abs(delta.x) > 0.5 || Math.abs(delta.y) > 0.5;
  const hasPathBend = Math.abs(pathBend.x) > 0.5 || Math.abs(pathBend.y) > 0.5;
  const hasDraftEdit = hasDelta || hasPathBend;
  const hasAnyDraft = hasDraftEdit
    || draftTransform !== null
    || draftExplanation !== null
    || draftSceneTransition !== null
    || draftProgramRecord !== null;
  const hasPendingEdits = stagedEdits.length > 0
    || stagedTransforms.length > 0
    || stagedExplanations.length > 0
    || stagedSceneTransitions.length > 0
    || stagedPrograms.length > 0
    || hasAnyDraft;
  const affectedObjectIds = [...new Set<ObjectId>([
    ...(hasDraftEdit ? draftMotionTargetIds ?? selectedPlan.affected : []),
    ...(draftTransform ? [draftTransform.sourceObjectId] : []),
    ...(draftExplanation ? [draftExplanation.targetObjectId] : []),
    ...(!hasDraftEdit && !draftTransform && !draftExplanation && !draftSceneTransition ? selectedPlan.affected : []),
  ])];
  const affected = new Set<ObjectId>(affectedObjectIds);
  const impactStart = selectedPlan.temporalScope === "whole" ? 0 : (draftMotion?.start ?? currentTime);
  const maximumMoveDuration = selectedPlan.affected.length > 0
    ? Math.max(0, Math.min(
        ...selectedPlan.affected.map((objectId) => lifetimeEndFor(objectId, currentTime) - currentTime),
      ))
    : 0;
  const effectiveMoveDuration = Math.min(moveDuration, maximumMoveDuration);
  const newMoveInterval = draftMotion ?? {
    start: currentTime,
    end: currentTime + effectiveMoveDuration,
  };
  const focusedMotion = SOURCE_MOTIONS.find(
    (motion) => motion.id === focusedMotionId
      && motion.objectIds.some((objectId) => selectedSet.has(objectId))
      && currentTime >= motion.interval.start
      && currentTime < motion.interval.end,
  );
  const workingEdits = [...appliedEdits, ...stagedEdits];
  const workingTransforms = [
    ...appliedTransforms,
    ...stagedTransforms,
    ...(draftTransform ? [draftTransform] : []),
  ]
    .sort((left, right) => left.interval.start - right.interval.start);
  const proposedState = evaluateWorkingState(createFixtureWorkingState({
    appliedPrograms,
    editorContext: {
      ...createFixtureWorkingState().editorContext,
      capturedLanguage: instruction.trim() ? { prompt: instruction.trim() } : undefined,
      playhead: currentTime,
      selection: selectedObjectIds,
    },
    stagedPrograms: [
      ...stagedPrograms,
      ...(draftProgramRecord ? [draftProgramRecord] : []),
    ],
  }));
  const studioProjection = projectProposedState(proposedState, currentTime);
  const projectedProvisionalEntities = studioProjection.canvas.entities.filter((entity) => entity.provisional);
  const projectedExplanationEntities = projectedProvisionalEntities.filter((entity) => (
    entity.type === "Text"
    && entity.content?.text
    && entity.sourceIdentity.kind === "unknown"
  ));
  const projectedCreatedMathTexEntities = projectedProvisionalEntities.filter((entity) => (
    entity.type === "MathTex" && entity.sourceIdentity.kind === "unknown"
  ));
  const projectedTransformTextEntities = projectedProvisionalEntities.filter((entity) => (
    entity.type === "Text"
    && entity.content?.text
    && entity.sourceIdentity.kind === "known"
    && entity.sourceIdentity.value === "equation"
  ));
  const projectedTransitionEntity = projectedProvisionalEntities.find((entity) => (
    entity.type.startsWith("TransitionOverlay:") && entity.present
  )) ?? null;
  const [, projectedTransitionShape, projectedTransitionColor] = projectedTransitionEntity?.type.split(":") ?? [];
  const projectedSceneBoundary = [...studioProjection.timeline.events]
    .reverse()
    .find((event) => event.kind === "scene-boundary") ?? null;
  const projectedTransitionPhase = projectedSceneBoundary?.at !== undefined && currentTime >= projectedSceneBoundary.at
    ? "incoming" as const
    : "outgoing" as const;
  const projectedEquationEntity = studioProjection.canvas.entities.find((entity) => (
    entity.present
    && entity.sourceIdentity.kind === "known"
    && entity.sourceIdentity.value === "equation"
  ));
  const projectedMathTexEntity = projectedEquationEntity?.type === "MathTex"
    ? projectedEquationEntity
    : null;
  const canonicalDraftLabel = draftProgramRecord?.program.operations.some((operation) => operation.kind === "ChangeCamera")
    ? "Camera focus"
    : draftProgramRecord?.program.operations.some((operation) => (
        operation.kind === "TransformContent" && operation.targetType === "Text"
      ))
      ? "Text transform"
      : draftProgramRecord?.program.operations.some((operation) => (
          operation.kind === "CreateEntity" && operation.entity.type === "MathTex"
        ))
        ? "New MathTex"
        : null;

  function equationRenderStateAt(time: number) {
    let lines: readonly string[] = ORIGINAL_EQUATION_LINES;
    let texParts: readonly string[] = ORIGINAL_EQUATION_TEX_PARTS;
    let runtimeId = "equation_1";
    for (const transform of workingTransforms) {
      if (transform.sourceObjectId !== "equation_1") continue;
      if (time < transform.interval.start) break;
      if (time >= transform.interval.end) {
        lines = transform.target.displayLines;
        texParts = transform.target.texParts;
        runtimeId = transform.targetRuntimeId;
        continue;
      }
      const duration = transform.interval.end - transform.interval.start;
      const progress = duration <= 0
        ? 1
        : easingValue(transform.easing, clamp((time - transform.interval.start) / duration, 0, 1));
      return {
        inProgressTransform: transform,
        lines,
        runtimeId,
        texParts,
        transition: {
          progress,
          sourceLines: lines,
          targetLines: transform.target.displayLines,
        },
      };
    }
    return {
      inProgressTransform: null,
      lines,
      runtimeId,
      texParts,
      transition: null,
    };
  }

  const legacyEquationRenderState = equationRenderStateAt(currentTime);
  const equationRenderState = legacyEquationRenderState.transition || !projectedMathTexEntity?.content
    ? legacyEquationRenderState
    : {
        ...legacyEquationRenderState,
        lines: projectedMathTexEntity.content.displayLines,
        runtimeId: projectedMathTexEntity.id,
        texParts: projectedMathTexEntity.content.texParts ?? legacyEquationRenderState.texParts,
      };
  const conflictingSourceMotion = draftTransform
    ? SOURCE_MOTIONS.find((motion) => (
        motion.objectIds.includes(draftTransform.sourceObjectId)
        && intervalsOverlap(motion.interval, draftTransform.interval)
      )) ?? null
    : null;
  const isEditProgramDraft = draftEditProgram !== null;
  const draftProgramIntervals = [
    draftMotion,
    draftTransform?.interval,
    draftExplanation?.interval,
  ].filter((interval): interval is Interval => interval !== null && interval !== undefined);
  const draftProgramInterval = draftProgramIntervals.length > 0 ? {
    start: Math.min(...draftProgramIntervals.map((interval) => interval.start)),
    end: Math.max(...draftProgramIntervals.map((interval) => interval.end)),
  } : null;

  function appliedOffsetForAt(objectId: ObjectId, time: number): Point {
    return workingEdits.reduce<Point>((offset, edit) => {
      const effectEnd = edit.endByObject[objectId] ?? edit.motion.end;
      if (time < edit.start || time >= effectEnd || !edit.affected.includes(objectId)) return offset;
      if (edit.planId !== "new-move" || time >= edit.motion.end) {
        return addPoints(offset, edit.delta);
      }
      const duration = edit.motion.end - edit.motion.start;
      if (duration <= 0) return addPoints(offset, edit.delta);
      const progress = easingValue("smooth", clamp((time - edit.motion.start) / duration, 0, 1));
      const motionOffset = quadraticPoint(
        { x: 0, y: 0 },
        addPoints({ x: edit.delta.x / 2, y: edit.delta.y / 2 }, edit.pathBend),
        edit.delta,
        progress,
      );
      return addPoints(offset, motionOffset);
    }, { x: 0, y: 0 });
  }

  function appliedBendFor(motion: MotionRecord): Point {
    return workingEdits.reduce<Point>((bend, edit) => {
      if (edit.planId !== "play-target") return bend;
      const editsMotion = edit.objectIds.some((objectId) => motion.objectIds.includes(objectId));
      if (!editsMotion || !intervalsOverlap(edit.motion, motion.interval)) return bend;
      return addPoints(bend, edit.pathBend);
    }, { x: 0, y: 0 });
  }

  function draftOffsetForAt(objectId: ObjectId, time: number): Point {
    if (selectedPlan.id === "play-target" && focusedMotion?.objectIds.includes(objectId)) {
      return { x: 0, y: 0 };
    }
    if (selectedPlan.id === "new-move") {
      return hasDelta && affected.has(objectId) ? delta : { x: 0, y: 0 };
    }
    const effectEnd = lifetimeEndFor(objectId, draftMotion?.start ?? currentTime);
    return hasDelta
      && time >= impactStart
      && time < effectEnd
      && affected.has(objectId)
      ? delta
      : { x: 0, y: 0 };
  }

  function pathBendFromGesture(motion: MotionRecord): Point {
    if (selectedPlan.id !== "play-target" || !motion.objectIds.some((objectId) => selectedSet.has(objectId))) {
      return pathBend;
    }
    const duration = motion.interval.end - motion.interval.start;
    const progress = clamp((currentTime - motion.interval.start) / duration, 0, 1);
    const eased = easingValue(motion.easing, progress);
    const controlWeight = 2 * (1 - eased) * eased;
    if (controlWeight < 0.05) return pathBend;
    return addPoints(pathBend, {
      x: clamp(delta.x / controlWeight, -220, 220),
      y: clamp(delta.y / controlWeight, -120, 120),
    });
  }

  const equationMotion = SOURCE_MOTIONS[0];
  const equationAppliedBend = appliedBendFor(equationMotion);
  const equationDraftBend = focusedMotion?.id === equationMotion.id && affected.has("equation_1")
    ? pathBendFromGesture(equationMotion)
    : { x: 0, y: 0 };
  const baseEquation = addPoints(
    sampleMotion(equationMotion, currentTime, equationAppliedBend),
    appliedOffsetForAt("equation_1", currentTime),
  );
  const baseLabel = addPoints(LABEL, appliedOffsetForAt("label_1", currentTime));
  const baseArrowOffset = appliedOffsetForAt("arrow_1", currentTime);
  const baseArrowSource = addPoints(LABEL, baseArrowOffset);
  const baseArrowTarget = addPoints(EQUATION, baseArrowOffset);
  const baseProofBox = addPoints(PROOF_BOX, appliedOffsetForAt("proof_box", currentTime));
  const previewEquation = addPoints(
    addPoints(
      sampleMotion(equationMotion, currentTime, addPoints(equationAppliedBend, equationDraftBend)),
      appliedOffsetForAt("equation_1", currentTime),
    ),
    draftOffsetForAt("equation_1", currentTime),
  );
  const previewLabel = addPoints(baseLabel, draftOffsetForAt("label_1", currentTime));
  const previewArrowSource = addPoints(baseArrowSource, draftOffsetForAt("arrow_1", currentTime));
  const previewArrowTarget = addPoints(baseArrowTarget, draftOffsetForAt("arrow_1", currentTime));
  const previewProofBox = addPoints(baseProofBox, draftOffsetForAt("proof_box", currentTime));
  const baseArrowCenter = {
    x: (baseArrowSource.x + baseArrowTarget.x) / 2,
    y: (baseArrowSource.y - 25 + baseArrowTarget.y + 32) / 2,
  };
  const previewArrowCenter = {
    x: (previewArrowSource.x + previewArrowTarget.x) / 2,
    y: (previewArrowSource.y - 25 + previewArrowTarget.y + 32) / 2,
  };
  const basePosition: Record<ObjectId, Point> = {
    equation_1: baseEquation,
    label_1: baseLabel,
    arrow_1: baseArrowCenter,
    proof_box: baseProofBox,
  };
  const previewPosition: Record<ObjectId, Point> = {
    equation_1: previewEquation,
    label_1: previewLabel,
    arrow_1: previewArrowCenter,
    proof_box: previewProofBox,
  };
  const visibleGroupObjectIds = selectedGroup?.objectIds.filter((objectId) => presentSet.has(objectId)) ?? [];
  const selectedGroupBounds = selectedGroup && visibleGroupObjectIds.length > 0 ? visibleGroupObjectIds.reduce(
    (bounds, objectId) => {
      const point = previewPosition[objectId];
      const halfSize = OBJECT_HALF_SIZE[objectId];
      return {
        left: Math.min(bounds.left, point.x - halfSize.x),
        right: Math.max(bounds.right, point.x + halfSize.x),
        top: Math.min(bounds.top, point.y - halfSize.y),
        bottom: Math.max(bounds.bottom, point.y + halfSize.y),
      };
    },
    { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
  ) : null;
  const selectionBaseCenter = averagePoints(selectedPresentObjectIds.map((objectId) => basePosition[objectId]));
  const selectionPreviewCenter = averagePoints(selectedPresentObjectIds.map((objectId) => previewPosition[objectId]));
  const fallbackPathControl = addPoints({
    x: (selectionBaseCenter.x + selectionPreviewCenter.x) / 2,
    y: (selectionBaseCenter.y + selectionPreviewCenter.y) / 2,
  }, pathBend);

  function motionGeometry(motion: MotionRecord, bend: Point, includeDraft: boolean) {
    const middleTime = (motion.interval.start + motion.interval.end) / 2;
    const objectId = motion.objectIds[0];
    const offsetAt = (time: number) => addPoints(
      appliedOffsetForAt(objectId, time),
      includeDraft ? draftOffsetForAt(objectId, time) : { x: 0, y: 0 },
    );
    return {
      start: addPoints(motion.start, offsetAt(motion.interval.start)),
      control: addPoints(addPoints(motion.control, bend), offsetAt(middleTime)),
      end: addPoints(motion.end, offsetAt(motion.interval.end)),
    };
  }

  const sourceMotionGeometry = focusedMotion
    ? motionGeometry(focusedMotion, appliedBendFor(focusedMotion), false)
    : null;
  const candidateMotionGeometry = focusedMotion
    ? motionGeometry(focusedMotion, addPoints(appliedBendFor(focusedMotion), pathBendFromGesture(focusedMotion)), true)
    : null;
  const pathControlPosition = candidateMotionGeometry?.control ?? fallbackPathControl;
  const objectHasDraftChange = (objectId: ObjectId) => (
    presentSet.has(objectId) && ((hasDelta && affected.has(objectId))
    || (hasPathBend && (
      selectedPlan.id === "new-move"
        ? affected.has(objectId)
        : focusedMotion?.objectIds.includes(objectId) === true
    ))
    )
  );
  const displayedEquation = selectedSet.has("equation_1") ? previewEquation : baseEquation;
  const displayedLabel = selectedSet.has("label_1") ? previewLabel : baseLabel;
  const displayedArrowCenter = selectedSet.has("arrow_1") ? previewArrowCenter : baseArrowCenter;
  const displayedProofBox = selectedSet.has("proof_box") ? previewProofBox : baseProofBox;
  const hasPatchPreview = hasDraftEdit
    || draftTransform !== null
    || draftExplanation !== null
    || draftSceneTransition !== null;
  const patch = useMemo(
    () => {
      if (draftSceneTransition) {
        const constructor = {
          circle: "Circle(radius=1)",
          diamond: "Square(side_length=2).rotate(PI / 4)",
          hexagon: "RegularPolygon(6, radius=1)",
        }[draftSceneTransition.shape];
        const color = {
          black: "BLACK",
          sky: "BLUE_D",
          white: "WHITE",
        }[draftSceneTransition.color];
        const halfDuration = (draftSceneTransition.interval.end - draftSceneTransition.interval.start) / 2;
        return {
          before: `# Scene boundary at ${(draftSceneTransition.interval.start + halfDuration).toFixed(2)}s`,
          after: `${draftSceneTransition.runtimeId} = ${constructor}.set_fill(${color}, opacity=1).set_stroke(width=0).scale(0.01)\nself.add(${draftSceneTransition.runtimeId})\nself.play(${draftSceneTransition.runtimeId}.animate.scale(800), run_time=${halfDuration.toFixed(2)}, rate_func=smooth)\n# replace the outgoing composition with the next Scene at full coverage\nself.play(${draftSceneTransition.runtimeId}.animate.scale(0.00125), run_time=${halfDuration.toFixed(2)}, rate_func=smooth)\nself.remove(${draftSceneTransition.runtimeId})`,
          context: `Creates a Scene-level ${draftSceneTransition.shape} cover-and-reveal transition. The geometry and timing are executable; final lowering must connect the next Scene composition at the covered midpoint.`,
        };
      }
      if (draftEditProgram) {
        const motionEdit = buildActiveEdit();
        const programPreview = buildEditProgramSourcePreview({
          existingMotionConflict: conflictingSourceMotion
            ? `This overlaps ${conflictingSourceMotion.label}, so source lowering must preserve that existing play boundary.`
            : undefined,
          explanation: draftExplanation?.stepIndex !== undefined ? {
            interval: draftExplanation.interval,
            placement: draftExplanation.placement,
            runtimeId: draftExplanation.runtimeId,
            stepIndex: draftExplanation.stepIndex,
            targetObjectId: draftExplanation.targetObjectId,
            text: draftExplanation.text,
          } : null,
          motion: motionEdit?.stepIndex !== undefined ? {
            affected: motionEdit.affected,
            delta: motionEdit.delta,
            interval: motionEdit.motion,
            stepIndex: motionEdit.stepIndex,
          } : null,
          objects: SCENE_OBJECTS,
          pixelsToWorldUnits: worldUnits,
          program: draftEditProgram,
          transform: draftTransform?.stepIndex !== undefined ? {
            interval: draftTransform.interval,
            sourceObjectId: draftTransform.sourceObjectId,
            stepIndex: draftTransform.stepIndex,
            texParts: draftTransform.target.texParts,
          } : null,
        });
        if (programPreview) return programPreview;
      }
      if (draftTransform) {
        const source = SCENE_OBJECTS.find((object) => object.id === draftTransform.sourceObjectId)!;
        const targetVariable = `${source.variableName}_target`;
        const duration = draftTransform.interval.end - draftTransform.interval.start;
        const targetArguments = draftTransform.target.texParts
          .map((part) => JSON.stringify(part))
          .join(", ");
        return {
          before: source.source,
          after: `${targetVariable} = MathTex(${targetArguments})\nself.play(TransformMatchingTex(${source.variableName}, ${targetVariable}, transform_mismatches=True), run_time=${duration.toFixed(2)}, rate_func=smooth)\n${source.variableName} = ${targetVariable}`,
          context: `Endpoint-only browser preview. ${draftTransform.strategy} removes the source runtime object and adds ${draftTransform.targetRuntimeId}; a Manim render must validate glyph correspondence.${conflictingSourceMotion ? ` This overlaps ${conflictingSourceMotion.label}, so source lowering must split or compose that play.` : ""}`,
        };
      }
      if (draftExplanation) {
        const target = SCENE_OBJECTS.find((object) => object.id === draftExplanation.targetObjectId)!;
        const direction = {
          above: "UP",
          below: "DOWN",
          left: "LEFT",
          right: "RIGHT",
        }[draftExplanation.placement];
        const duration = draftExplanation.interval.end - draftExplanation.interval.start;
        return {
          before: `# ${timeAnchorLabel(draftExplanation.anchor)} · exact timeline boundary`,
          after: `${draftExplanation.runtimeId} = Text(${JSON.stringify(draftExplanation.text)})\n${draftExplanation.runtimeId}.next_to(${target.variableName}, ${direction})\nself.play(FadeIn(${draftExplanation.runtimeId}), run_time=${duration.toFixed(2)})`,
          context: `Creates a new Text object beside ${target.displayName}; the target remains unchanged and the explanation persists after FadeIn. Source lowering must preserve the resolved ${draftExplanation.interval.start.toFixed(2)}s boundary.`,
        };
      }
      if (selectedPlan.id === "play-target" && focusedMotion) {
        return {
          before: `# ${focusedMotion.label} · existing spatial path`,
          after: "# fit the path through the dragged position; preserve both endpoints",
          context: `The ${focusedMotion.easing} rate function and ${focusedMotion.interval.start.toFixed(2)}–${focusedMotion.interval.end.toFixed(2)}s timing stay unchanged. Source lowering remains unresolved.`,
        };
      }
      if (!hasDelta && hasPathBend) {
        return {
          before: `# ${focusedMotion?.label ?? "selected motion"} · existing spatial path`,
          after: "# update the motion path control in Scene IR",
          context: "Spatial-path lowering into reproducible Manim source is intentionally unresolved in this prototype.",
        };
      }
      const candidate = patchFor(
        selectedPlan,
        delta,
        selectedObjectIds,
        selectedPlan.id === "new-move" ? newMoveInterval : draftMotion ?? undefined,
      );
      if (!hasPathBend) return candidate;
      return {
        ...candidate,
        context: `${candidate.context} Curved-path lowering is intentionally unresolved in this prototype.`,
      };
    },
    [conflictingSourceMotion, delta.x, delta.y, draftEditProgram, draftExplanation, draftMotion, draftMotionTargetIds, draftSceneTransition, draftTransform, focusedMotion, hasDelta, hasPathBend, newMoveInterval, selectedObjectIds, selectedPlan],
  );

  useEffect(() => {
    if (!isPlaying) return;

    let animationFrame = 0;
    let previous = performance.now();
    const playbackEnd = Math.max(
      draftMotion?.end ?? 0,
      draftTransform?.interval.end ?? 0,
      draftExplanation?.interval.end ?? 0,
      draftSceneTransition?.interval.end ?? 0,
      ...(draftProgramRecord?.program.operations.map((operation) => operation.interval.end) ?? []),
    ) || SCENE_DURATION;
    const tick = (now: number) => {
      const elapsed = (now - previous) / 1000;
      previous = now;
      setCurrentTime((time) => {
        const next = time + elapsed;
        if (next >= playbackEnd) {
          setIsPlaying(false);
          return playbackEnd;
        }
        return next;
      });
      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [draftExplanation, draftMotion, draftProgramRecord, draftSceneTransition, draftTransform, isPlaying]);

  useEffect(() => () => suggestionRequest.current?.abort(), []);

  function updateDelta(next: Point) {
    const normalized = {
      x: Math.round(clamp(next.x, -220, 220)),
      y: Math.round(clamp(next.y, -100, 100)),
    };
    if (!draftMotion && (Math.abs(normalized.x) > 0.5 || Math.abs(normalized.y) > 0.5)) {
      const end = selectedPlan.id === "new-move"
        ? currentTime + effectiveMoveDuration
        : Math.max(
            currentTime,
            ...selectedPlan.affected.map((objectId) => lifetimeEndFor(objectId, currentTime)),
          );
      setDraftMotion({ start: currentTime, end });
    }
    setDelta(normalized);
  }

  function updatePathBend(next: Point) {
    if (!draftMotion) {
      setDraftMotion(selectedPlan.id === "new-move"
        ? newMoveInterval
        : focusedMotion?.interval ?? { start: currentTime, end: currentTime });
    }
    setPathBend({
      x: Math.round(clamp(next.x, -160, 160)),
      y: Math.round(clamp(next.y, -100, 100)),
    });
  }

  function resetDraft() {
    setDelta({ x: 0, y: 0 });
    setPathBend({ x: 0, y: 0 });
    setDraftMotion(null);
    setDraftMotionTargetIds(null);
    setDraftTransform(null);
    setDraftExplanation(null);
    setDraftSceneTransition(null);
    setDraftEditProgram(null);
    setDraftProgramRecord(null);
  }

  function chooseEditMode(nextMode: EditMode) {
    if (nextMode === editMode) return;
    if (hasAnyDraft) stageActiveEdit();
    setEditMode(nextMode);
    setSelectedPlanId(nextMode === "position" ? "play-followers" : "new-move");
    setPathBend({ x: 0, y: 0 });
    setDraftMotion(null);
  }

  function changeMoveDuration(nextDuration: number) {
    const normalized = clamp(nextDuration, 0.1, 5);
    setMoveDuration(normalized);
    if (selectedPlan.id === "new-move" && draftMotion) {
      const available = Math.max(0, Math.min(
        ...selectedPlan.affected.map((objectId) => lifetimeEndFor(objectId, draftMotion.start) - draftMotion.start),
      ));
      setDraftMotion({
        start: draftMotion.start,
        end: draftMotion.start + Math.min(normalized, available),
      });
    }
  }

  async function submitInstruction(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = instruction.trim();
    if (prompt.length === 0 || suggestionStatus === "loading") return;
    const replacesSuggestion = suggestion !== null && hasAnyDraft;
    if (replacesSuggestion) resetDraft();

    suggestionRequest.current?.abort();
    const controller = new AbortController();
    suggestionRequest.current = controller;
    setSuggestion(null);
    setSuggestionStatus("loading");
    setSuggestionMessage(null);

    try {
      const result = await suggestEdit({
        objects: SCENE_OBJECTS.map((object) => ({
          displayName: object.displayName,
          id: object.id,
          lifetimes: OBJECT_LIFETIMES[object.id],
          mathTex: object.id === "equation_1"
            ? {
                displayLines: equationRenderState.lines,
                texParts: equationRenderState.texParts,
              }
            : object.mathTex,
          type: object.type,
        })),
        playhead: currentTime,
        prompt,
        sceneDuration: SCENE_DURATION,
        selectedObjectIds,
      }, { signal: controller.signal });
      if (result.kind === "clarification") {
        setSuggestionMessage(result.message);
        setSuggestionStatus("clarification");
        return;
      }

      const operation = result.suggestion.operation;
      const transactionNumber = nextTransactionNumber.current;
      nextTransactionNumber.current += 1;
      const canonicalValidation = canonicalizeSuggestionProgram(operation, {
        capturedPlayhead: currentTime,
        origin: result.suggestion.provider === "remote" ? "remote-model" : "fixture",
        scene: STUDIO_FIXTURE_SCENE,
        transactionId: `studio-edit-${transactionNumber}`,
      });
      if (canonicalValidation.kind === "invalid") {
        const issue = canonicalValidation.issues.find((candidate) => candidate.severity === "error");
        setSuggestion(null);
        setSuggestionMessage(issue ? `${issue.field}: ${issue.message}` : "The operation could not be validated.");
        setSuggestionStatus("error");
        return;
      }
      const canonicalRecord = programRecord(canonicalValidation.program, canonicalValidation);
      if (operation.kind === "edit-program") {
        const validation = validateEditProgram(operation, {
          capturedPlayhead: currentTime,
          objects: SCENE_OBJECTS.map((object) => ({
            id: object.id,
            lifetimes: OBJECT_LIFETIMES[object.id],
            type: object.type,
          })),
          sceneDuration: SCENE_DURATION,
          selectedObjectIds,
        });
        if (validation.kind === "invalid") {
          setSuggestion(null);
          setSuggestionMessage(validation.message);
          setSuggestionStatus("error");
          return;
        }
        const program = validation.program;
        const firstStep = program.operation.operations[0]!;
        const motionStep = program.motion?.step ?? null;
        const transformStep = program.transform?.step ?? null;
        const explanationStep = program.explanation?.step ?? null;
        const motionTargets = program.motion?.targetObjectIds ?? [];
        const transformSourceId = program.transform?.sourceObjectId ?? null;
        const explanationTargetId = program.explanation?.targetObjectId ?? null;
        const programStart = program.start;

        if (hasAnyDraft && !replacesSuggestion) stageActiveEdit();
        const compositeNumber = nextCompositeNumber.current;
        nextCompositeNumber.current += 1;
        const groupId = `program_${compositeNumber}`;
        const transform: TransformEdit | null = transformStep && transformSourceId ? {
          anchor: program.operation.anchor,
          easing: transformStep.easing,
          groupId,
          identityAfter: transformStep.identityAfter,
          interval: { start: transformStep.start, end: transformStep.end },
          mismatchMode: transformStep.mismatchMode,
          sourceObjectId: transformSourceId,
          stepIndex: program.transform!.index,
          strategy: transformStep.strategy,
          target: transformStep.target,
          targetRuntimeId: `${transformSourceId}::target@${transformStep.start.toFixed(2)}`,
        } : null;
        let explanation: ExplanationEdit | null = null;
        if (explanationStep && explanationTargetId) {
          const explanationNumber = nextExplanationNumber.current;
          nextExplanationNumber.current += 1;
          explanation = {
            anchor: program.operation.anchor,
            animation: explanationStep.animation,
            groupId,
            interval: { start: explanationStep.start, end: explanationStep.end },
            objectKind: explanationStep.objectKind,
            placement: explanationStep.placement,
            runtimeId: `explanation_${explanationNumber}`,
            stepIndex: program.explanation!.index,
            targetObjectId: explanationTargetId,
            text: explanationStep.text,
          };
        }
        setIsPlaying(false);
        setCurrentTime(programStart);
        setFocusedMotionId(null);
        setEditMode("animate");
        setSelectedPlanId("new-move");
        setSelectedObjectIds(motionTargets.length > 0 ? motionTargets : program.touchedObjectIds);
        setMoveDuration(motionStep ? motionStep.end - motionStep.start : firstStep.end - firstStep.start);
        setDraftMotion(motionStep ? { start: motionStep.start, end: motionStep.end } : null);
        setDraftMotionTargetIds(motionStep ? motionTargets : null);
        setDelta(motionStep ? {
          x: motionStep.delta.x,
          y: motionStep.delta.y,
        } : { x: 0, y: 0 });
        setPathBend(motionStep ? {
          x: motionStep.controlOffset.x,
          y: motionStep.controlOffset.y,
        } : { x: 0, y: 0 });
        setDraftTransform(transform);
        setDraftExplanation(explanation);
        setDraftEditProgram({
          anchor: program.operation.anchor,
          execution: program.operation.execution,
          groupId,
          operationKinds: program.operation.operations.map((step) => step.kind),
        });
        setDraftProgramRecord(canonicalRecord);
        setSuggestion({
          ...result.suggestion,
          operation: program.operation,
        });
        setSuggestionMessage(null);
        setSuggestionStatus("ready");
        return;
      }
      if (
        operation.kind === "create-camera-focus"
        || operation.kind === "create-equation"
        || operation.kind === "create-text-transform"
      ) {
        const selectedIds = new Set(selectedObjectIds);
        const targetsAreValid = operation.kind === "create-camera-focus"
          ? operation.targetObjectIds.length > 0
            && operation.targetObjectIds.every((objectId) => isObjectId(objectId) && selectedIds.has(objectId))
          : operation.kind === "create-text-transform"
            ? isObjectId(operation.sourceObjectId) && selectedIds.has(operation.sourceObjectId)
            : true;
        if (!targetsAreValid) {
          setSuggestion(null);
          setSuggestionMessage("The proposed target no longer matches the captured selection.");
          setSuggestionStatus("error");
          return;
        }
        if (hasAnyDraft && !replacesSuggestion) stageActiveEdit();
        setIsPlaying(false);
        setCurrentTime(operation.end);
        setFocusedMotionId(null);
        setDraftMotion(null);
        setDraftMotionTargetIds(null);
        setDelta({ x: 0, y: 0 });
        setPathBend({ x: 0, y: 0 });
        setDraftTransform(null);
        setDraftExplanation(null);
        setDraftSceneTransition(null);
        setDraftEditProgram(null);
        setDraftProgramRecord(canonicalRecord);
        setSuggestion(result.suggestion);
        setSuggestionMessage(null);
        setSuggestionStatus("ready");
        return;
      }
      const anchoredStart = resolveTimeAnchor(operation.anchor);
      const referenceMatches = operation.anchor.kind === "absolute"
        || Math.abs(operation.anchor.referenceSeconds - currentTime) < 0.001;
      if (!Number.isFinite(anchoredStart) || anchoredStart < 0 || anchoredStart > SCENE_DURATION) {
        setSuggestion(null);
        setSuggestionMessage("The requested time resolves outside this Scene.");
        setSuggestionStatus("error");
        return;
      }
      if (!referenceMatches || Math.abs(operation.start - anchoredStart) >= 0.001) {
        setSuggestion(null);
        setSuggestionMessage("The proposed time does not match the captured playhead. Try the request again.");
        setSuggestionStatus("error");
        return;
      }
      const start = anchoredStart;
      const requestedDuration = operation.end - operation.start;

      if (operation.kind === "create-motion") {
        const targetObjectIds = operation.targetObjectIds
          .filter(isObjectId)
          .filter((objectId) => selectedSet.has(objectId))
          .filter((objectId) => isObjectPresentAt(objectId, start));
        const latestTargetEnd = targetObjectIds.length > 0
          ? Math.min(...targetObjectIds.map((objectId) => lifetimeEndFor(objectId, start)), SCENE_DURATION)
          : start;
        const end = clamp(start + requestedDuration, start, latestTargetEnd);
        if (
          targetObjectIds.length === 0
          || targetObjectIds.length !== operation.targetObjectIds.length
          || end - start < 0.1
        ) {
          setSuggestion(null);
          setSuggestionMessage("The proposed motion does not target a visible object for a usable interval.");
          setSuggestionStatus("error");
          return;
        }
        if (hasAnyDraft && !replacesSuggestion) stageActiveEdit();
        setIsPlaying(false);
        setCurrentTime(start);
        setFocusedMotionId(null);
        setEditMode("animate");
        setSelectedPlanId("new-move");
        setSelectedObjectIds(targetObjectIds);
        setMoveDuration(end - start);
        setDraftMotion({ start, end });
        setDraftMotionTargetIds(targetObjectIds);
        setDraftTransform(null);
        setDraftExplanation(null);
        setDraftSceneTransition(null);
        setDelta({
          x: operation.delta.x,
          y: operation.delta.y,
        });
        setPathBend({
          x: operation.controlOffset.x,
          y: operation.controlOffset.y,
        });
        setSuggestion({
          ...result.suggestion,
          operation: { ...operation, end, start, targetObjectIds },
        });
        setDraftProgramRecord(canonicalRecord);
      } else if (operation.kind === "create-transform") {
        const sourceObjectId = isObjectId(operation.sourceObjectId)
          ? operation.sourceObjectId
          : null;
        const source = SCENE_OBJECTS.find((object) => object.id === sourceObjectId);
        const latestTargetEnd = sourceObjectId ? lifetimeEndFor(sourceObjectId, start) : start;
        const end = clamp(start + requestedDuration, start, Math.min(latestTargetEnd, SCENE_DURATION));
        const displayLines = operation.target.displayLines
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 4)
          .map((line) => line.slice(0, 120));
        const texParts = operation.target.texParts
          .map((part) => part.trim())
          .filter(Boolean)
          .slice(0, 16);
        const texLength = texParts.reduce((length, part) => length + part.length, 0);
        if (
          !sourceObjectId
          || !source
          || !selectedSet.has(sourceObjectId)
          || source.type !== "MathTex"
          || !isObjectPresentAt(sourceObjectId, start)
          || end - start < 0.1
          || displayLines.length === 0
          || texParts.length === 0
          || texLength > 2_000
        ) {
          setSuggestion(null);
          setSuggestionMessage("The proposed transform needs one visible MathTex source and a valid target for a usable interval.");
          setSuggestionStatus("error");
          return;
        }
        if (hasAnyDraft && !replacesSuggestion) stageActiveEdit();
        const targetRuntimeId = `${sourceObjectId}::target@${start.toFixed(2)}`;
        const transform: TransformEdit = {
          anchor: operation.anchor,
          easing: operation.easing,
          identityAfter: operation.identityAfter,
          interval: { start, end },
          mismatchMode: operation.mismatchMode,
          sourceObjectId,
          strategy: operation.strategy,
          target: { ...operation.target, displayLines, texParts },
          targetRuntimeId,
        };
        setIsPlaying(false);
        setCurrentTime(start);
        setFocusedMotionId(null);
        setEditMode("animate");
        setSelectedPlanId("new-move");
        setSelectedObjectIds([sourceObjectId]);
        setMoveDuration(end - start);
        setDraftMotion(null);
        setDelta({ x: 0, y: 0 });
        setPathBend({ x: 0, y: 0 });
        setDraftTransform(transform);
        setDraftExplanation(null);
        setDraftSceneTransition(null);
        setSuggestion({
          ...result.suggestion,
          operation: {
            ...operation,
            end,
            sourceObjectId,
            start,
            target: transform.target,
          },
        });
        setDraftProgramRecord(canonicalRecord);
      } else if (operation.kind === "create-explanation") {
        const targetObjectId = isObjectId(operation.targetObjectId)
          ? operation.targetObjectId
          : null;
        const text = operation.text.trim().slice(0, 240);
        const latestTargetEnd = targetObjectId ? lifetimeEndFor(targetObjectId, start) : start;
        const end = clamp(start + requestedDuration, start, Math.min(latestTargetEnd, SCENE_DURATION));
        if (
          !targetObjectId
          || !selectedSet.has(targetObjectId)
          || !isObjectPresentAt(targetObjectId, start)
          || text.length === 0
          || end - start < 0.1
        ) {
          setSuggestion(null);
          setSuggestionMessage("The explanation needs one visible target and enough time for FadeIn.");
          setSuggestionStatus("error");
          return;
        }
        if (hasAnyDraft && !replacesSuggestion) stageActiveEdit();
        const explanationNumber = nextExplanationNumber.current;
        nextExplanationNumber.current += 1;
        const explanation: ExplanationEdit = {
          anchor: operation.anchor,
          animation: operation.animation,
          interval: { start, end },
          objectKind: operation.objectKind,
          placement: operation.placement,
          runtimeId: `explanation_${explanationNumber}`,
          targetObjectId,
          text,
        };
        setIsPlaying(false);
        setCurrentTime(start);
        setFocusedMotionId(null);
        setSelectedObjectIds([targetObjectId]);
        setDraftMotion(null);
        setDelta({ x: 0, y: 0 });
        setPathBend({ x: 0, y: 0 });
        setDraftTransform(null);
        setDraftExplanation(explanation);
        setDraftSceneTransition(null);
        setSuggestion({
          ...result.suggestion,
          operation: {
            ...operation,
            end,
            start,
            targetObjectId,
            text,
          },
        });
        setDraftProgramRecord(canonicalRecord);
      } else {
        const end = clamp(start + requestedDuration, start, SCENE_DURATION);
        if (end - start < 0.4) {
          setSuggestion(null);
          setSuggestionMessage("The Scene transition needs at least 0.4 seconds for cover and reveal.");
          setSuggestionStatus("error");
          return;
        }
        if (hasAnyDraft && !replacesSuggestion) stageActiveEdit();
        const transitionNumber = nextSceneTransitionNumber.current;
        nextSceneTransitionNumber.current += 1;
        const transition: SceneTransitionEdit = {
          anchor: operation.anchor,
          color: operation.color,
          destination: operation.destination,
          easing: operation.easing,
          interval: { start, end },
          runtimeId: `scene_transition_${transitionNumber}`,
          shape: operation.shape,
          style: operation.style,
        };
        setIsPlaying(false);
        setCurrentTime(start);
        setFocusedMotionId(null);
        setEditMode("animate");
        setSelectedPlanId("new-move");
        setDraftMotion(null);
        setDraftMotionTargetIds(null);
        setDelta({ x: 0, y: 0 });
        setPathBend({ x: 0, y: 0 });
        setDraftTransform(null);
        setDraftExplanation(null);
        setDraftSceneTransition(transition);
        setSuggestion({
          ...result.suggestion,
          operation: { ...operation, end, start },
        });
        setDraftProgramRecord(canonicalRecord);
      }
      setSuggestionMessage(null);
      setSuggestionStatus("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSuggestionMessage(error instanceof Error ? error.message : "Could not generate an edit suggestion.");
      setSuggestionStatus("error");
    } finally {
      if (suggestionRequest.current === controller) suggestionRequest.current = null;
    }
  }

  function discardSuggestion() {
    resetDraft();
    setSuggestion(null);
    setSuggestionMessage(null);
    setSuggestionStatus("idle");
  }

  function buildActiveEdit(): AppliedEdit | null {
    const activeAffected = draftMotionTargetIds ?? selectedPlan.affected;
    if (!hasDraftEdit || activeAffected.length === 0) return null;
    const reshapesMotion = selectedPlan.id === "play-target" ? focusedMotion : undefined;
    const editStart = selectedPlan.temporalScope === "whole"
      ? 0
      : reshapesMotion?.interval.start ?? draftMotion?.start ?? currentTime;
    const endByObject = Object.fromEntries(
      activeAffected.map((objectId) => [
        objectId,
        reshapesMotion?.interval.end ?? lifetimeEndFor(objectId, draftMotion?.start ?? currentTime),
      ]),
    ) as Partial<Record<ObjectId, number>>;
    const editEnd = Math.max(editStart, ...Object.values(endByObject));
    return {
      affected: activeAffected,
      delta: reshapesMotion ? { x: 0, y: 0 } : delta,
      endByObject,
      groupId: draftEditProgram?.groupId,
      motion: reshapesMotion?.interval
        ?? draftMotion
        ?? { start: editStart, end: editEnd },
      objectIds: draftMotionTargetIds ?? selectedObjectIds,
      pathBend: reshapesMotion ? pathBendFromGesture(reshapesMotion) : pathBend,
      planId: selectedPlan.id,
      stepIndex: draftEditProgram
        ? draftEditProgram.operationKinds.indexOf("create-motion")
        : undefined,
      start: editStart,
    };
  }

  function buildActiveProgramRecord(activeEdit: AppliedEdit | null) {
    if (draftProgramRecord) return draftProgramRecord;
    if (!activeEdit) return null;
    const transactionNumber = nextTransactionNumber.current;
    nextTransactionNumber.current += 1;
    const transactionId = `studio-gesture-${transactionNumber}`;
    const validation = activeEdit.planId === "play-target" && focusedMotion
      ? createDirectManipulationModifyMotionProgram({
          capturedPlayhead: currentTime,
          controlOffset: activeEdit.pathBend,
          interval: activeEdit.motion,
          motionId: focusedMotion.id,
          scene: STUDIO_FIXTURE_SCENE,
          transactionId,
        })
      : activeEdit.planId === "new-move"
        ? createDirectManipulationMotionProgram({
            capturedPlayhead: activeEdit.motion.start,
            controlOffset: activeEdit.pathBend,
            delta: activeEdit.delta,
            interval: activeEdit.motion,
            scene: STUDIO_FIXTURE_SCENE,
            targetEntityIds: activeEdit.affected,
            transactionId,
          })
        : createDirectManipulationPositionProgram({
            capturedPlayhead: currentTime,
            delta: activeEdit.delta,
            positions: basePosition,
            scene: STUDIO_FIXTURE_SCENE,
            start: activeEdit.start,
            targetEntityIds: activeEdit.affected,
            transactionId,
          });
    return programRecord(validation.program, validation);
  }

  function stageActiveEdit() {
    const activeEdit = buildActiveEdit();
    const canonicalRecord = buildActiveProgramRecord(activeEdit);
    const transactionId = canonicalRecord?.program.transactionId;
    if (activeEdit) setStagedEdits((current) => [...current, { ...activeEdit, transactionId }]);
    if (draftTransform) setStagedTransforms((current) => [...current, { ...draftTransform, transactionId }]);
    if (draftExplanation) setStagedExplanations((current) => [...current, { ...draftExplanation, transactionId }]);
    if (draftSceneTransition) setStagedSceneTransitions((current) => [...current, { ...draftSceneTransition, transactionId }]);
    if (canonicalRecord) setStagedPrograms((current) => [...current, canonicalRecord]);
    resetDraft();
  }

  function togglePlayback() {
    if (hasDraftEdit && !draftEditProgram) stageActiveEdit();
    if (selectedPlanId === "play-target") setSelectedPlanId("new-move");
    const canonicalIntervals = draftProgramRecord?.program.operations.map((operation) => operation.interval) ?? [];
    const previewIntervals = [
      draftMotion,
      draftTransform?.interval,
      draftExplanation?.interval,
      draftSceneTransition?.interval,
      ...canonicalIntervals,
    ].filter((interval): interval is Interval => interval !== null && interval !== undefined);
    const previewInterval = previewIntervals.length > 0 ? {
      start: Math.min(...previewIntervals.map((interval) => interval.start)),
      end: Math.max(...previewIntervals.map((interval) => interval.end)),
    } : null;
    if (previewInterval && currentTime >= previewInterval.end) {
      setCurrentTime(previewInterval.start);
    } else if (currentTime >= SCENE_DURATION) {
      setCurrentTime(0);
    }
    setIsPlaying((playing) => !playing);
  }

  function applyPatch() {
    const activeEdit = buildActiveEdit();
    const activeProgramRecord = buildActiveProgramRecord(activeEdit);
    const activeTransactionId = activeProgramRecord?.program.transactionId;
    const pendingPrograms = activeProgramRecord
      ? [...stagedPrograms, activeProgramRecord]
      : stagedPrograms;
    const pending = activeEdit
      ? [...stagedEdits, { ...activeEdit, transactionId: activeTransactionId }]
      : stagedEdits;
    const pendingTransforms = draftTransform
      ? [...stagedTransforms, { ...draftTransform, transactionId: activeTransactionId }]
      : stagedTransforms;
    const pendingExplanations = draftExplanation
      ? [...stagedExplanations, { ...draftExplanation, transactionId: activeTransactionId }]
      : stagedExplanations;
    const pendingSceneTransitions = draftSceneTransition
      ? [...stagedSceneTransitions, { ...draftSceneTransition, transactionId: activeTransactionId }]
      : stagedSceneTransitions;
    if (
      pendingPrograms.length === 0
      &&
      pending.length === 0
      && pendingTransforms.length === 0
      && pendingExplanations.length === 0
      && pendingSceneTransitions.length === 0
    ) return;
    const latestMovement = [...pending].reverse().find((edit) => edit.planId === "new-move");
    const latestTransform = pendingTransforms.at(-1);
    const latestExplanation = pendingExplanations.at(-1);
    const latestSceneTransition = pendingSceneTransitions.at(-1);
    setAppliedEdits((current) => [...current, ...pending]);
    setAppliedTransforms((current) => [...current, ...pendingTransforms]);
    setAppliedExplanations((current) => [...current, ...pendingExplanations]);
    setAppliedSceneTransitions((current) => [...current, ...pendingSceneTransitions]);
    setAppliedPrograms((current) => [...current, ...pendingPrograms]);
    setStagedEdits([]);
    setStagedTransforms([]);
    setStagedExplanations([]);
    setStagedSceneTransitions([]);
    setStagedPrograms([]);
    resetDraft();
    setSuggestion(null);
    setSuggestionMessage(null);
    setSuggestionStatus("idle");
    setInstruction("");
    const latestEnd = Math.max(
      latestMovement?.motion.end ?? 0,
      latestTransform?.interval.end ?? 0,
      latestExplanation?.interval.end ?? 0,
      latestSceneTransition?.interval.end ?? 0,
      ...pendingPrograms.flatMap((record) => record.program.operations.map((operation) => operation.interval.end)),
    );
    if (latestEnd > 0) setCurrentTime(latestEnd);
  }

  function undoLastApplied() {
    const latestProgram = appliedPrograms.at(-1);
    if (latestProgram) {
      const transactionId = latestProgram.program.transactionId;
      setAppliedPrograms((current) => current.slice(0, -1));
      setAppliedEdits((current) => withoutTransaction(current, transactionId));
      setAppliedTransforms((current) => withoutTransaction(current, transactionId));
      setAppliedExplanations((current) => withoutTransaction(current, transactionId));
      setAppliedSceneTransitions((current) => withoutTransaction(current, transactionId));
      return;
    }
    const latestEdit = appliedEdits.at(-1);
    const latestTransform = appliedTransforms.at(-1);
    const latestExplanation = appliedExplanations.at(-1);
    const latestSceneTransition = appliedSceneTransitions.at(-1);
    const latest = [
      latestEdit ? { groupId: latestEdit.groupId, kind: "edit" as const, start: latestEdit.start } : null,
      latestTransform ? { groupId: latestTransform.groupId, kind: "transform" as const, start: latestTransform.interval.start } : null,
      latestExplanation ? { groupId: latestExplanation.groupId, kind: "explanation" as const, start: latestExplanation.interval.start } : null,
      latestSceneTransition ? { groupId: undefined, kind: "scene-transition" as const, start: latestSceneTransition.interval.start } : null,
    ]
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.start - right.start)
      .at(-1);
    if (!latest) return;
    if (latest.groupId) {
      const groupId = latest.groupId;
      setAppliedEdits((current) => current.filter((entry) => entry.groupId !== groupId));
      setAppliedTransforms((current) => current.filter((entry) => entry.groupId !== groupId));
      setAppliedExplanations((current) => current.filter((entry) => entry.groupId !== groupId));
      return;
    }
    if (latest.kind === "transform") {
      setAppliedTransforms((current) => current.slice(0, -1));
    } else if (latest.kind === "explanation") {
      setAppliedExplanations((current) => current.slice(0, -1));
    } else if (latest.kind === "scene-transition") {
      setAppliedSceneTransitions((current) => current.slice(0, -1));
    } else {
      setAppliedEdits((current) => current.slice(0, -1));
    }
  }

  function toggleObject(objectId: ObjectId) {
    if (!isObjectPresentAt(objectId, currentTime) && !selectedSet.has(objectId)) return;
    const motionAtPlayhead = SOURCE_MOTIONS.find(
      (motion) => motion.objectIds.includes(objectId)
        && currentTime >= motion.interval.start
        && currentTime < motion.interval.end,
    );
    setFocusedMotionId(motionAtPlayhead?.id ?? null);
    const selectionChanges = !selectedSet.has(objectId) || selectedObjectIds.length > 1;
    if (selectionChanges) stageActiveEdit();
    setSelectedObjectIds((current) => {
      if (current.includes(objectId)) {
        return current.filter((id) => id !== objectId);
      }
      return SCENE_OBJECTS
        .map((object) => object.id)
        .filter((id) => current.includes(id) || id === objectId);
    });
    setSelectedPlanId(defaultPlanId);
  }

  function selectAllObjects() {
    if (!sameObjects(selectedObjectIds, presentObjectIds)) stageActiveEdit();
    setSelectedObjectIds(presentObjectIds);
    setSelectedPlanId(defaultPlanId);
    const motionAtPlayhead = SOURCE_MOTIONS.find(
      (motion) => currentTime >= motion.interval.start && currentTime < motion.interval.end,
    );
    setFocusedMotionId(motionAtPlayhead?.id ?? null);
  }

  function createGroup() {
    if (selectedObjectIds.length < 2) return;
    const existing = objectGroups.find((group) => sameObjects(group.objectIds, selectedObjectIds));
    if (existing) return;
    const groupNumber = nextGroupNumber.current;
    nextGroupNumber.current += 1;
    setObjectGroups((current) => [...current, {
      id: `group-${groupNumber}`,
      name: `Group ${groupNumber}`,
      objectIds: selectedObjectIds,
    }]);
  }

  function selectGroup(group: ObjectGroup) {
    if (!sameObjects(group.objectIds, selectedObjectIds)) stageActiveEdit();
    setSelectedObjectIds(group.objectIds);
    setSelectedPlanId(defaultPlanId);
    const motionAtPlayhead = SOURCE_MOTIONS.find(
      (motion) => motion.objectIds.some((objectId) => group.objectIds.includes(objectId))
        && currentTime >= motion.interval.start
        && currentTime < motion.interval.end,
    );
    setFocusedMotionId(motionAtPlayhead?.id ?? null);
  }

  function removeGroup(groupId: string) {
    setObjectGroups((current) => current.filter((group) => group.id !== groupId));
  }

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, objectId: ObjectId) {
    const bounds = event.currentTarget.closest("[data-scene-viewport]")?.getBoundingClientRect();
    if (!bounds) return;
    const motionAtPlayhead = SOURCE_MOTIONS.find(
      (motion) => motion.objectIds.includes(objectId)
        && currentTime >= motion.interval.start
        && currentTime < motion.interval.end,
    );
    setFocusedMotionId(motionAtPlayhead?.id ?? null);
    const alreadySelected = selectedSet.has(objectId);
    const deltaStart = alreadySelected ? delta : { x: 0, y: 0 };
    if (!alreadySelected) {
      stageActiveEdit();
      const nextSelection = event.shiftKey
        ? SCENE_OBJECTS
            .map((object) => object.id)
            .filter((id) => selectedSet.has(id) || id === objectId)
        : [objectId];
      setSelectedObjectIds(nextSelection);
      setSelectedPlanId(defaultPlanId);
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      clientStart: { x: event.clientX, y: event.clientY },
      deltaStart,
      bounds,
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateDelta({
      x: drag.deltaStart.x + ((event.clientX - drag.clientStart.x) * FRAME.width) / drag.bounds.width,
      y: drag.deltaStart.y + ((event.clientY - drag.clientStart.y) * FRAME.height) / drag.bounds.height,
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (dragState.current?.pointerId === event.pointerId) dragState.current = null;
  }

  function beginPathDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.closest("[data-scene-viewport]")?.getBoundingClientRect();
    if (!bounds) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pathDragState.current = {
      pointerId: event.pointerId,
      clientStart: { x: event.clientX, y: event.clientY },
      bendStart: pathBend,
      bounds,
    };
  }

  function movePathDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = pathDragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updatePathBend({
      x: drag.bendStart.x + ((event.clientX - drag.clientStart.x) * FRAME.width) / drag.bounds.width,
      y: drag.bendStart.y + ((event.clientY - drag.clientStart.y) * FRAME.height) / drag.bounds.height,
    });
  }

  function endPathDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (pathDragState.current?.pointerId === event.pointerId) pathDragState.current = null;
  }

  function nudgeSelected(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 1 : 10;
    if (event.key === "ArrowLeft") updateDelta({ x: delta.x - step, y: delta.y });
    else if (event.key === "ArrowRight") updateDelta({ x: delta.x + step, y: delta.y });
    else if (event.key === "ArrowUp") updateDelta({ x: delta.x, y: delta.y - step });
    else if (event.key === "ArrowDown") updateDelta({ x: delta.x, y: delta.y + step });
    else return;
    event.preventDefault();
  }

  function nudgePath(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 1 : 10;
    if (event.key === "ArrowLeft") updatePathBend({ x: pathBend.x - step, y: pathBend.y });
    else if (event.key === "ArrowRight") updatePathBend({ x: pathBend.x + step, y: pathBend.y });
    else if (event.key === "ArrowUp") updatePathBend({ x: pathBend.x, y: pathBend.y - step });
    else if (event.key === "ArrowDown") updatePathBend({ x: pathBend.x, y: pathBend.y + step });
    else return;
    event.preventDefault();
  }

  const activeDraftEdit = buildActiveEdit();
  const pendingTimelineEdits = activeDraftEdit ? [...stagedEdits, activeDraftEdit] : stagedEdits;
  const pendingTimelineTransforms = draftTransform ? [...stagedTransforms, draftTransform] : stagedTransforms;
  const pendingTimelineExplanations = draftExplanation
    ? [...stagedExplanations, draftExplanation]
    : stagedExplanations;
  const pendingTimelineSceneTransitions = draftSceneTransition
    ? [...stagedSceneTransitions, draftSceneTransition]
    : stagedSceneTransitions;
  const legacyPendingEditCount = groupedOperationCount([
    ...pendingTimelineEdits,
    ...pendingTimelineTransforms,
    ...pendingTimelineExplanations,
    ...pendingTimelineSceneTransitions,
  ]);
  const pendingEditCount = Math.max(
    legacyPendingEditCount,
    stagedPrograms.length + (draftProgramRecord ? 1 : 0),
  );
  const hasPendingEditProgram = [...pendingTimelineEdits, ...pendingTimelineTransforms, ...pendingTimelineExplanations]
    .some((entry) => entry.groupId !== undefined);
  const legacyAppliedOperationCount = groupedOperationCount([
    ...appliedEdits,
    ...appliedTransforms,
    ...appliedExplanations,
    ...appliedSceneTransitions,
  ]);
  const appliedOperationCount = Math.max(legacyAppliedOperationCount, appliedPrograms.length);
  const timelineEdits = [...appliedEdits, ...pendingTimelineEdits];
  const timelineTransforms = [...appliedTransforms, ...pendingTimelineTransforms];
  const timelineExplanations = [...appliedExplanations, ...pendingTimelineExplanations];
  const timelineSceneTransitions = [...appliedSceneTransitions, ...pendingTimelineSceneTransitions];
  const canonicalTimelineEvents = studioProjection.timeline.events.filter((event) => event.transactionId);
  const editProgramBounds = new Map<string, Interval>();
  for (const record of [
    ...timelineEdits.map((edit) => ({ groupId: edit.groupId, interval: edit.motion })),
    ...timelineTransforms.map((transform) => ({ groupId: transform.groupId, interval: transform.interval })),
    ...timelineExplanations.map((explanation) => ({ groupId: explanation.groupId, interval: explanation.interval })),
  ]) {
    if (!record.groupId) continue;
    const current = editProgramBounds.get(record.groupId);
    editProgramBounds.set(record.groupId, current ? {
      start: Math.min(current.start, record.interval.start),
      end: Math.max(current.end, record.interval.end),
    } : record.interval);
  }
  const zoneBoundaries = new Set<number>([0, SCENE_DURATION]);
  for (const segment of PLAY_SEGMENTS) {
    zoneBoundaries.add(segment.start);
    zoneBoundaries.add(segment.end);
  }
  for (const lifetimes of Object.values(OBJECT_LIFETIMES)) {
    for (const lifetime of lifetimes) {
      zoneBoundaries.add(lifetime.start);
      zoneBoundaries.add(lifetime.end);
    }
  }
  for (const edit of timelineEdits) {
    if (edit.planId !== "play-target") zoneBoundaries.add(edit.start);
    if (edit.planId === "new-move") zoneBoundaries.add(edit.motion.end);
    for (const end of Object.values(edit.endByObject)) zoneBoundaries.add(end);
  }
  for (const transform of timelineTransforms) {
    zoneBoundaries.add(transform.interval.start);
    zoneBoundaries.add(transform.interval.end);
  }
  for (const explanation of timelineExplanations) {
    zoneBoundaries.add(explanation.interval.start);
    zoneBoundaries.add(explanation.interval.end);
  }
  for (const transition of timelineSceneTransitions) {
    zoneBoundaries.add(transition.interval.start);
    zoneBoundaries.add((transition.interval.start + transition.interval.end) / 2);
    zoneBoundaries.add(transition.interval.end);
  }
  const sortedZoneBoundaries = [...zoneBoundaries]
    .filter((time) => time >= 0 && time <= SCENE_DURATION)
    .sort((left, right) => left - right);
  const timelineZones = sortedZoneBoundaries.slice(0, -1).map((start, index) => {
    const end = sortedZoneBoundaries[index + 1];
    const midpoint = (start + end) / 2;
    const startingEdits = timelineEdits.filter((edit) => (
      edit.planId !== "play-target" && Math.abs(edit.start - start) < 0.001
    ));
    const startingTransforms = timelineTransforms.filter((transform) => (
      Math.abs(transform.interval.start - start) < 0.001
    ));
    const startingExplanations = timelineExplanations.filter((explanation) => (
      Math.abs(explanation.interval.start - start) < 0.001
    ));
    const startingSceneTransitions = timelineSceneTransitions.filter((transition) => (
      Math.abs(transition.interval.start - start) < 0.001
    ));
    const startsTransform = startingTransforms.length > 0;
    const startsExplanation = startingExplanations.length > 0;
    const startsSceneTransition = startingSceneTransitions.length > 0;
    const startsEditProgram = [...editProgramBounds.values()].some((interval) => (
      Math.abs(interval.start - start) < 0.001
    ));
    const startsEdit = startingEdits.length > 0 || startsTransform || startsExplanation || startsSceneTransition;
    const startsMovement = startingEdits.some((edit) => edit.planId === "new-move");
    const endsMovement = timelineEdits.some((edit) => (
      edit.planId === "new-move" && Math.abs(edit.motion.end - start) < 0.001
    ));
    const endsTransform = timelineTransforms.some((transform) => (
      Math.abs(transform.interval.end - start) < 0.001
    ));
    const endsExplanation = timelineExplanations.some((explanation) => (
      Math.abs(explanation.interval.end - start) < 0.001
    ));
    const endsSceneTransition = timelineSceneTransitions.some((transition) => (
      Math.abs(transition.interval.end - start) < 0.001
    ));
    const isSceneBoundary = timelineSceneTransitions.some((transition) => (
      Math.abs((transition.interval.start + transition.interval.end) / 2 - start) < 0.001
    ));
    const endsEditProgram = [...editProgramBounds.values()].some((interval) => (
      Math.abs(interval.end - start) < 0.001
    ));
    const hasEditEffect = timelineEdits.some((edit) => (
      edit.planId !== "play-target"
      && edit.affected.some((objectId) => (
        midpoint >= edit.start
        && midpoint < (edit.planId === "new-move"
          ? edit.motion.end
          : edit.endByObject[objectId] ?? edit.motion.end)
      ))
    )) || timelineTransforms.some((transform) => (
      midpoint >= transform.interval.start && midpoint < transform.interval.end
    )) || timelineExplanations.some((explanation) => (
      midpoint >= explanation.interval.start
    )) || timelineSceneTransitions.some((transition) => (
      midpoint >= transition.interval.start && midpoint < transition.interval.end
    ));
    const exitingObjects = SCENE_OBJECTS.filter((object) => (
      OBJECT_LIFETIMES[object.id].some((lifetime) => Math.abs(lifetime.end - start) < 0.001)
    ));
    return {
      end,
      endsEditProgram,
      endsExplanation,
      endsSceneTransition,
      endsMovement,
      endsTransform,
      exitingObjects,
      hasEditEffect,
      isSceneBoundary,
      play: playAt(midpoint),
      start,
      startsEdit,
      startsEditProgram,
      startsExplanation,
      startsSceneTransition,
      startsMovement,
      startsTransform,
    };
  });

  function editIntervalForObject(edit: AppliedEdit, objectId: ObjectId): Interval {
    return edit.planId === "play-target" || edit.planId === "new-move"
      ? edit.motion
      : { start: edit.start, end: edit.endByObject[objectId] ?? edit.motion.end };
  }

  return (
    <main className="flex h-dvh min-h-[640px] flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-balance text-sm font-semibold">Poietra Studio Lab</h1>
          <span className="text-zinc-700">/</span>
          <p className="truncate text-pretty text-xs text-zinc-400">examples/relativity.py · GroupedEquation</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="hidden text-zinc-500 xl:inline">Experiment: drag interpretation</span>
          <button
            aria-controls="studio-edit-composer"
            aria-expanded={isComposerVisible}
            className="rounded-md border border-zinc-700 px-2 py-1 font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={() => setIsComposerVisible((visible) => !visible)}
            type="button"
          >
            {isComposerVisible ? "Hide composer" : "Show composer"}
          </button>
          <span
            className={cn(
              "rounded-md border px-2 py-1 font-medium",
              shell === "Browser"
                ? "border-zinc-700 text-zinc-400"
                : "border-sky-800 bg-sky-950 text-sky-300",
            )}
          >
            {shell}
          </span>
        </div>
      </header>

      <section className="grid min-h-0 flex-1 grid-cols-12">
        <aside className="col-span-2 min-h-0 min-w-0 overflow-y-auto border-r border-zinc-800 bg-zinc-900/70 p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-balance text-xs font-medium text-zinc-300">Scene objects</h2>
            <button
              className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              onClick={selectAllObjects}
              type="button"
            >
              Select all
            </button>
          </div>
          <ol className="space-y-0.5">
            {SCENE_OBJECTS.map((object) => (
              <SceneObject
                affected={affected.has(object.id)}
                key={object.id}
                name={object.id}
                onToggle={() => toggleObject(object.id)}
                present={presentSet.has(object.id)}
                selected={selectedSet.has(object.id)}
                type={object.type}
              />
            ))}
            {studioProjection.objectList.entities.filter((entity) => entity.provisional).map((entity) => (
              <li
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                  entity.present ? "text-zinc-400" : "text-zinc-600",
                )}
                key={`object-${entity.id}`}
              >
                <span aria-hidden="true" className="size-3.5 shrink-0 border border-zinc-700" />
                <span className="min-w-0 flex-1 truncate">{entity.id}</span>
                <span className="shrink-0 text-[11px] text-sky-400">
                  {entity.type.split(":")[0]}{entity.present ? " · proposed" : " · not yet"}
                </span>
              </li>
            ))}
          </ol>

          <div className="mt-4 border-t border-zinc-800 pt-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-balance text-xs font-medium text-zinc-300">Groups</h2>
              <button
                className="rounded px-1.5 py-0.5 text-[11px] text-sky-400 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:text-zinc-700"
                disabled={selectedObjectIds.length < 2 || selectedGroup !== undefined}
                onClick={createGroup}
                type="button"
              >
                Group selected
              </button>
            </div>
            {objectGroups.length === 0 ? (
              <p className="mt-2 text-pretty text-[11px] leading-5 text-zinc-600">
                Select two or more objects, then group them for one-click selection and dragging.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {objectGroups.map((group) => {
                  const selected = sameObjects(group.objectIds, selectedObjectIds);
                  const visibleCount = group.objectIds.filter((objectId) => presentSet.has(objectId)).length;
                  return (
                    <li className="flex items-center gap-1" key={group.id}>
                      <button
                        aria-pressed={selected}
                        className={cn(
                          "min-w-0 flex-1 rounded px-2 py-1.5 text-left text-xs",
                          selected ? "bg-sky-950 text-sky-200" : "text-zinc-400 hover:bg-zinc-800",
                        )}
                        onClick={() => selectGroup(group)}
                        type="button"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate">{group.name}</span>
                          <span className="shrink-0 text-[10px] text-zinc-600">
                            {visibleCount}/{group.objectIds.length} visible
                          </span>
                        </span>
                      </button>
                      <button
                        aria-label={`Remove ${group.name}`}
                        className="shrink-0 rounded px-1.5 py-1 text-[10px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                        onClick={() => removeGroup(group.id)}
                        title={`Remove ${group.name}`}
                        type="button"
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mt-6 border-t border-zinc-800 pt-4">
            <h2 className="text-balance text-xs font-medium text-zinc-300">Observed relation</h2>
            <dl className="mt-3 space-y-2 text-xs">
              <div>
                <dt className="text-zinc-600">label → equation</dt>
                <dd className="mt-0.5 text-zinc-400">snapshot · next_to</dd>
              </div>
              <div>
                <dt className="text-zinc-600">arrow → both</dt>
                <dd className="mt-0.5 text-zinc-400">snapshot · endpoints</dd>
              </div>
            </dl>
          </div>
        </aside>

        <div className="col-span-7 flex min-w-0 flex-col bg-zinc-950">
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-balance text-sm font-medium">Rendered frame</h2>
                  <span className={cn(
                    "border px-1.5 py-0.5 text-[10px]",
                    canonicalDraftLabel || draftTransform || draftExplanation || draftSceneTransition || equationRenderState.inProgressTransform || editMode === "animate"
                      ? "border-sky-800 text-sky-300"
                      : "border-zinc-700 text-zinc-400",
                  )}>
                    {canonicalDraftLabel
                      ? canonicalDraftLabel
                      : isEditProgramDraft && draftEditProgram
                      ? `${draftEditProgram.operationKinds.length}-step program`
                      : draftSceneTransition
                      ? "Shape transition"
                      : draftExplanation
                      ? "Text FadeIn"
                      : draftTransform
                      ? equationRenderState.transition && equationRenderState.transition.progress > 0
                        ? "Semantic morph"
                        : "MathTex transform"
                      : equationRenderState.inProgressTransform
                        ? "Semantic morph"
                        : editMode === "animate" ? "Animation" : "Position only"}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-zinc-500">
                  {canonicalDraftLabel && draftProgramRecord
                    ? `${canonicalDraftLabel} from ${draftProgramRecord.program.anchor.resolvedSeconds.toFixed(2)}s · sampled from the shared ProposedState.`
                    : isEditProgramDraft && draftEditProgram && draftProgramInterval
                    ? `Atomic ${draftEditProgram.execution} Edit Program at ${draftProgramInterval.start.toFixed(2)}–${draftProgramInterval.end.toFixed(2)}s. Play or scrub every requested effect, then Apply or Reset.`
                    : draftSceneTransition
                    ? `${draftSceneTransition.shape} cover-and-reveal at ${draftSceneTransition.interval.start.toFixed(2)}–${draftSceneTransition.interval.end.toFixed(2)}s (${timeAnchorLabel(draftSceneTransition.anchor)}).`
                    : draftExplanation
                    ? `Explanation appears at ${draftExplanation.interval.start.toFixed(2)}s (${timeAnchorLabel(draftExplanation.anchor)}). Play or scrub the FadeIn, then Apply or Reset.`
                    : draftTransform
                    ? `Press Play or scrub ${draftTransform.interval.start.toFixed(2)}–${draftTransform.interval.end.toFixed(2)}s to preview matching symbols, then Apply or Reset.`
                    : equationRenderState.inProgressTransform
                      ? `Semantic symbol preview at ${currentTime.toFixed(2)}s; final glyph motion still requires a Manim render.`
                    : canEditSelection
                    ? `Drag ${selectionInstruction}. Use arrow keys for 10 px adjustments.`
                    : `${selectionInstruction} is not on screen at ${currentTime.toFixed(2)}s.`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
                <span className="w-20 text-right text-zinc-500">Δx {delta.x > 0 ? "+" : ""}{delta.x} px</span>
                <span className="w-20 text-right text-zinc-500">Δy {delta.y > 0 ? "+" : ""}{delta.y} px</span>
                <button
                  className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
                  disabled={!hasAnyDraft}
                  onClick={suggestion ? discardSuggestion : resetDraft}
                  type="button"
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 items-center justify-center">
              <div
                className="relative aspect-video h-full max-w-full overflow-hidden rounded-lg border border-zinc-800 bg-black shadow-lg"
                data-proposed-state-sample={studioProjection.canvas.sampleId}
                data-scene-viewport
              >
              <m.div
                className="absolute inset-0"
                data-camera-scale={studioProjection.camera.scale.toFixed(3)}
                style={{ scale: studioProjection.camera.scale }}
              >
              <svg aria-hidden="true" className="absolute inset-0 size-full" viewBox="0 0 640 360">
                <g stroke="#27272a" strokeWidth="1">
                  <line x1="0" x2="640" y1="180" y2="180" />
                  <line x1="320" x2="320" y1="0" y2="360" />
                  <line x1="80" x2="80" y1="0" y2="360" />
                  <line x1="160" x2="160" y1="0" y2="360" />
                  <line x1="240" x2="240" y1="0" y2="360" />
                  <line x1="400" x2="400" y1="0" y2="360" />
                  <line x1="480" x2="480" y1="0" y2="360" />
                  <line x1="560" x2="560" y1="0" y2="360" />
                  <line x1="0" x2="640" y1="90" y2="90" />
                  <line x1="0" x2="640" y1="270" y2="270" />
                </g>

                {selectedGroupBounds && selectedGroup ? (
                  <g data-object-group={selectedGroup.id}>
                    <rect
                      fill="none"
                      height={selectedGroupBounds.bottom - selectedGroupBounds.top + 12}
                      rx="4"
                      stroke="#38bdf8"
                      strokeDasharray="6 4"
                      strokeOpacity="0.75"
                      width={selectedGroupBounds.right - selectedGroupBounds.left + 12}
                      x={selectedGroupBounds.left - 6}
                      y={selectedGroupBounds.top - 6}
                    />
                    <text
                      fill="#7dd3fc"
                      fontFamily="ui-sans-serif, system-ui"
                      fontSize="10"
                      x={selectedGroupBounds.left - 2}
                      y={Math.max(12, selectedGroupBounds.top - 10)}
                    >
                      {selectedGroup.name}
                    </text>
                  </g>
                ) : null}

                {presentSet.has("proof_box") ? (
                  <>
                    <rect
                      fill="none"
                      height="62"
                      opacity={selectedSet.has("proof_box") && objectHasDraftChange("proof_box") ? 0.3 : 1}
                      rx="4"
                      stroke="#3f3f46"
                      width="230"
                      x={baseProofBox.x - 115}
                      y={baseProofBox.y - 31}
                    />
                    {objectHasDraftChange("proof_box") ? <rect
                      fill="none"
                      height="62"
                      rx="4"
                      stroke="#38bdf8"
                      strokeDasharray="5 4"
                      width="230"
                      x={previewProofBox.x - 115}
                      y={previewProofBox.y - 31}
                    /> : null}
                  </>
                ) : null}

                {presentSet.has("arrow_1") ? (
                  <g
                    fill="none"
                    opacity={selectedSet.has("arrow_1") && objectHasDraftChange("arrow_1") ? 0.3 : 0.75}
                    stroke="#a1a1aa"
                    strokeWidth="1.5"
                  >
                    <line
                      x1={baseArrowSource.x}
                      x2={baseArrowTarget.x}
                      y1={baseArrowSource.y - 25}
                      y2={baseArrowTarget.y + 32}
                    />
                    <path
                      d={`M ${baseArrowTarget.x - 5} ${baseArrowTarget.y + 39} L ${baseArrowTarget.x} ${baseArrowTarget.y + 32} L ${baseArrowTarget.x + 5} ${baseArrowTarget.y + 39}`}
                    />
                  </g>
                ) : null}

                {objectHasDraftChange("arrow_1") ? (
                  <g
                    fill="none"
                    opacity="0.8"
                    stroke={selectedSet.has("arrow_1") ? "#38bdf8" : "#71717a"}
                    strokeDasharray="5 4"
                    strokeWidth="1.5"
                  >
                    <line
                      x1={previewArrowSource.x}
                      x2={previewArrowTarget.x}
                      y1={previewArrowSource.y - 25}
                      y2={previewArrowTarget.y + 32}
                    />
                    <path
                      d={`M ${previewArrowTarget.x - 5} ${previewArrowTarget.y + 39} L ${previewArrowTarget.x} ${previewArrowTarget.y + 32} L ${previewArrowTarget.x + 5} ${previewArrowTarget.y + 39}`}
                    />
                  </g>
                ) : null}

              </svg>

              {presentSet.has("equation_1") && selectedSet.has("equation_1") && objectHasDraftChange("equation_1") ? (
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-zinc-100 opacity-30"
                  style={positionStyle(baseEquation)}
                >
                  <EquationContent lines={equationRenderState.lines} />
                </div>
              ) : null}
              {presentSet.has("label_1") && selectedSet.has("label_1") && objectHasDraftChange("label_1") ? (
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-xs text-zinc-400 opacity-30"
                  style={positionStyle(baseLabel)}
                >
                  energy
                </div>
              ) : null}

              {presentSet.has("label_1") && affected.has("label_1") && !selectedSet.has("label_1") && hasDelta ? (
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-xs text-zinc-300"
                  style={positionStyle(previewLabel)}
                >
                  energy
                </div>
              ) : null}

              {presentSet.has("proof_box") ? <button
                aria-label="Move proof_box"
                aria-pressed={selectedSet.has("proof_box")}
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 cursor-grab select-none rounded border bg-transparent outline-none active:cursor-grabbing",
                  selectedSet.has("proof_box")
                    ? "border-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400"
                    : "border-transparent hover:border-zinc-600",
                )}
                onKeyDown={nudgeSelected}
                onPointerCancel={endDrag}
                onPointerDown={(event) => beginDrag(event, "proof_box")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                style={{
                  ...positionStyle(displayedProofBox),
                  height: `${(62 / FRAME.height) * 100}%`,
                  touchAction: "none",
                  width: `${(230 / FRAME.width) * 100}%`,
                }}
                type="button"
              >
                {selectedSet.has("proof_box") ? (
                  <span className="absolute -top-6 left-0 whitespace-nowrap bg-sky-400 px-1.5 py-0.5 text-[11px] font-medium text-sky-950">
                    proof_box{selectedPlan.id === "new-move" && hasDelta ? " · destination" : ""}
                  </span>
                ) : null}
              </button> : null}

              {presentSet.has("arrow_1") ? <button
                aria-label="Move arrow_1"
                aria-pressed={selectedSet.has("arrow_1")}
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 cursor-grab select-none rounded border bg-transparent outline-none active:cursor-grabbing",
                  selectedSet.has("arrow_1")
                    ? "border-sky-400 bg-sky-950/30 focus-visible:ring-2 focus-visible:ring-sky-400"
                    : "border-transparent hover:border-zinc-600",
                )}
                onKeyDown={nudgeSelected}
                onPointerCancel={endDrag}
                onPointerDown={(event) => beginDrag(event, "arrow_1")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                style={{ ...positionStyle(displayedArrowCenter), height: "18%", touchAction: "none", width: "5%" }}
                type="button"
              >
                {selectedSet.has("arrow_1") ? (
                  <span className="absolute -right-14 top-1/2 -translate-y-1/2 whitespace-nowrap bg-sky-400 px-1.5 py-0.5 text-[11px] font-medium text-sky-950">
                    arrow_1{selectedPlan.id === "new-move" && hasDelta ? " · destination" : ""}
                  </span>
                ) : null}
              </button> : null}

              {presentSet.has("label_1") ? <button
                aria-label="Move label_1"
                aria-pressed={selectedSet.has("label_1")}
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 cursor-grab select-none rounded border px-2 py-1 text-xs outline-none active:cursor-grabbing",
                  selectedSet.has("label_1")
                    ? "border-sky-400 bg-sky-950/50 text-sky-100 focus-visible:ring-2 focus-visible:ring-sky-400"
                    : "border-transparent bg-transparent text-zinc-400 hover:border-zinc-600",
                )}
                onKeyDown={nudgeSelected}
                onPointerCancel={endDrag}
                onPointerDown={(event) => beginDrag(event, "label_1")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                style={{ ...positionStyle(displayedLabel), touchAction: "none" }}
                type="button"
              >
                energy
                {selectedSet.has("label_1") ? (
                  <span className="absolute -top-6 left-0 whitespace-nowrap bg-sky-400 px-1.5 py-0.5 text-[11px] font-medium text-sky-950">
                    label_1{selectedPlan.id === "new-move" && hasDelta ? " · destination" : ""}
                  </span>
                ) : null}
              </button> : null}

              {projectedEquationEntity?.present ? <button
                aria-label="Move equation_1"
                aria-pressed={selectedSet.has("equation_1")}
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 cursor-grab select-none border px-3 py-2 outline-none active:cursor-grabbing",
                  selectedSet.has("equation_1")
                    ? "border-sky-400 bg-sky-950/50 text-sky-100 focus-visible:ring-2 focus-visible:ring-sky-400"
                    : "border-transparent bg-transparent text-zinc-100 hover:border-zinc-600",
                  projectedEquationEntity.scale > 1.01 && "ring-2 ring-sky-300",
                )}
                onKeyDown={nudgeSelected}
                onPointerCancel={endDrag}
                onPointerDown={(event) => beginDrag(event, "equation_1")}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                style={{
                  ...positionStyle(displayedEquation),
                  opacity: projectedEquationEntity.opacity,
                  scale: projectedEquationEntity.scale,
                  touchAction: "none",
                }}
                type="button"
              >
                {equationRenderState.transition ? (
                  <EquationMorphContent
                    progress={equationRenderState.transition.progress}
                    sourceLines={equationRenderState.transition.sourceLines}
                    targetLines={equationRenderState.transition.targetLines}
                  />
                ) : projectedEquationEntity.type === "Text" ? (
                  <span className="block max-w-64 text-pretty text-center text-sm leading-6">
                    {projectedEquationEntity.content?.text
                      ?? projectedEquationEntity.content?.displayLines.join(" ")}
                  </span>
                ) : (
                  <EquationContent lines={equationRenderState.lines} />
                )}
                {selectedSet.has("equation_1") ? (
                  <span className="absolute -top-6 left-0 whitespace-nowrap bg-sky-400 px-1.5 py-0.5 font-sans text-[11px] font-medium text-sky-950">
                    {projectedEquationEntity.id}{selectedPlan.id === "new-move" && hasDelta ? " · destination" : ""}
                  </span>
                ) : null}
              </button> : null}

              {projectedCreatedMathTexEntities.filter((entity) => entity.present).map((entity) => (
                <m.div
                  aria-label={`New equation: ${entity.content?.label ?? entity.content?.displayLines.join(" ")}`}
                  className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2 border border-dashed border-sky-400 bg-zinc-950/70 px-3 py-2 text-zinc-100"
                  data-equation-object={entity.id}
                  data-proposed-state-sample={studioProjection.canvas.sampleId}
                  key={entity.id}
                  role="img"
                  style={{
                    ...positionStyle(entity.position),
                    opacity: entity.opacity,
                    scale: entity.scale,
                  }}
                >
                  <EquationContent lines={entity.content?.displayLines ?? []} />
                </m.div>
              ))}

              {projectedTransformTextEntities.filter((entity) => (
                entity.present && entity.id !== projectedEquationEntity?.id
              )).map((entity) => (
                <m.div
                  aria-label={`Transform target: ${entity.content?.text}`}
                  className="pointer-events-none absolute z-10 max-w-64 -translate-x-1/2 -translate-y-1/2 border border-dashed border-sky-400 bg-zinc-950/70 px-3 py-2 text-pretty text-center text-sm leading-6 text-zinc-100"
                  data-proposed-state-sample={studioProjection.canvas.sampleId}
                  data-text-transform-target={entity.id}
                  key={entity.id}
                  role="img"
                  style={{
                    ...positionStyle(entity.position),
                    opacity: entity.opacity,
                    scale: entity.scale,
                  }}
                >
                  {entity.content?.text}
                </m.div>
              ))}

              {projectedExplanationEntities.filter((entity) => entity.present).map((entity) => (
                <m.div
                  aria-label={`Explanation: ${entity.content?.text}`}
                  className={cn(
                    "pointer-events-none absolute z-10 max-w-52 -translate-x-1/2 -translate-y-1/2 px-2 py-1 text-center text-xs leading-5 text-zinc-100",
                    entity.transactionId === draftProgramRecord?.program.transactionId
                      ? "border border-dashed border-sky-400 bg-sky-950/70"
                      : "bg-zinc-950/70",
                  )}
                  data-explanation-object={entity.id}
                  data-proposed-state-sample={studioProjection.canvas.sampleId}
                  key={entity.id}
                  role="img"
                  style={{ ...positionStyle(entity.position), opacity: entity.opacity, scale: entity.scale }}
                >
                  {entity.content?.text}
                </m.div>
              ))}

              {(selectedPlan.id === "new-move" && hasDelta)
                || (selectedPlan.id === "play-target" && sourceMotionGeometry) ? (
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-10 size-full"
                  viewBox="0 0 640 360"
                >
                  {selectedPlan.id === "play-target" && sourceMotionGeometry ? (
                    <path
                      d={`M ${sourceMotionGeometry.start.x} ${sourceMotionGeometry.start.y} Q ${sourceMotionGeometry.control.x} ${sourceMotionGeometry.control.y} ${sourceMotionGeometry.end.x} ${sourceMotionGeometry.end.y}`}
                      data-motion-path="source"
                      fill="none"
                      markerEnd="url(#source-trajectory-arrow)"
                      stroke="#a1a1aa"
                      strokeDasharray="3 4"
                      strokeWidth="1.5"
                    />
                  ) : null}
                  {selectedPlan.id === "play-target" && candidateMotionGeometry && hasDraftEdit ? (
                    <path
                      d={`M ${candidateMotionGeometry.start.x} ${candidateMotionGeometry.start.y} Q ${candidateMotionGeometry.control.x} ${candidateMotionGeometry.control.y} ${candidateMotionGeometry.end.x} ${candidateMotionGeometry.end.y}`}
                      data-motion-path="candidate"
                      fill="none"
                      markerEnd="url(#trajectory-arrow)"
                      stroke="#38bdf8"
                      strokeWidth="2"
                    />
                  ) : null}
                  {selectedPlan.id === "new-move" && hasDelta ? (
                    <g data-motion-path="new-move">
                      <path
                        d={`M ${selectionBaseCenter.x} ${selectionBaseCenter.y} Q ${(selectionBaseCenter.x + selectionPreviewCenter.x) / 2 + pathBend.x} ${(selectionBaseCenter.y + selectionPreviewCenter.y) / 2 + pathBend.y} ${selectionPreviewCenter.x} ${selectionPreviewCenter.y}`}
                        fill="none"
                        markerEnd="url(#trajectory-arrow)"
                        stroke="#38bdf8"
                        strokeWidth="2"
                      />
                      <circle cx={selectionBaseCenter.x} cy={selectionBaseCenter.y} fill="#09090b" r="3.5" stroke="#a1a1aa" strokeWidth="1.5" />
                      <circle cx={selectionPreviewCenter.x} cy={selectionPreviewCenter.y} fill="#38bdf8" r="3.5" />
                    </g>
                  ) : null}
                  <defs>
                    <marker id="source-trajectory-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
                      <path d="M0,0 L6,3 L0,6 Z" fill="#a1a1aa" />
                    </marker>
                    <marker id="trajectory-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
                      <path d="M0,0 L6,3 L0,6 Z" fill="#38bdf8" />
                    </marker>
                  </defs>
                </svg>
              ) : null}

              {canEditSelection && (
                (selectedPlan.id === "play-target" && focusedMotion)
                || (selectedPlan.id === "new-move" && hasDelta)
              ) ? (
                <button
                  aria-label="Adjust motion path"
                  className="absolute z-10 size-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-sky-300 bg-zinc-950 outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-sky-400"
                  onKeyDown={nudgePath}
                  onPointerCancel={endPathDrag}
                  onPointerDown={beginPathDrag}
                  onPointerMove={movePathDrag}
                  onPointerUp={endPathDrag}
                  style={{ ...positionStyle(pathControlPosition), touchAction: "none" }}
                  title="Drag to bend the actual motion path"
                  type="button"
                >
                  <span className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-normal text-sky-300">
                    path
                  </span>
                </button>
              ) : null}

              {projectedSceneBoundary?.at !== undefined && currentTime >= projectedSceneBoundary.at ? (
                <div
                  className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-zinc-900"
                  data-incoming-scene={projectedSceneBoundary.transactionId}
                  data-proposed-state-sample={studioProjection.workingPlayback.sampleId}
                >
                  <div className="border border-zinc-700 bg-zinc-950 px-4 py-3 text-center">
                    <p className="text-balance text-sm font-medium text-zinc-200">Next Scene</p>
                    <p className="mt-1 text-pretty text-[11px] text-zinc-500">Incoming composition preview is not loaded</p>
                  </div>
                </div>
              ) : null}

              {projectedTransitionEntity ? (
                <div
                  aria-label={`${projectedTransitionShape} Scene transition · ${projectedTransitionPhase} phase`}
                  className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden"
                  data-proposed-state-sample={studioProjection.canvas.sampleId}
                  data-scene-transition={projectedTransitionEntity.id}
                  role="img"
                >
                  <m.div
                    className={cn(
                      "size-32 shrink-0",
                      projectedTransitionShape === "circle" && "rounded-full",
                      projectedTransitionShape === "hexagon" && "[clip-path:polygon(25%_6.7%,75%_6.7%,100%_50%,75%_93.3%,25%_93.3%,0%_50%)]",
                      projectedTransitionShape === "diamond" && "rounded-md",
                      projectedTransitionColor === "sky" && "bg-sky-500",
                      projectedTransitionColor === "white" && "bg-white",
                      projectedTransitionColor === "black" && "bg-black",
                    )}
                    style={{
                      opacity: projectedTransitionEntity.transactionId === draftProgramRecord?.program.transactionId
                        && projectedTransitionEntity.opacity === 0
                        ? 0.35
                        : 1,
                      transform: `${projectedTransitionShape === "diamond" ? "rotate(45deg) " : ""}scale(${0.05 + projectedTransitionEntity.opacity * 8})`,
                    }}
                  />
                  <span className="absolute bottom-2 right-2 border border-zinc-700 bg-zinc-950/90 px-1.5 py-0.5 text-[10px] text-zinc-300">
                    {projectedTransitionPhase === "outgoing" ? "Covering frame" : "Revealing next Scene"}
                  </span>
                </div>
              ) : null}

              </m.div>

              {isComposerVisible && createPortal(
                <div
                  className="pointer-events-none fixed z-30"
                  ref={floatingBoardBounds}
                  style={{
                    bottom: "max(0.5rem, env(safe-area-inset-bottom))",
                    left: "max(0.5rem, env(safe-area-inset-left))",
                    right: "max(0.5rem, env(safe-area-inset-right))",
                    top: "max(0.5rem, env(safe-area-inset-top))",
                  }}
                >
              <div className="absolute left-1/2 top-12 w-full max-w-xl -translate-x-1/2">
              <LazyMotion features={loadMotionFeatures} strict>
              <m.form
                aria-label="Describe an edit at the playhead"
                className="pointer-events-auto border border-zinc-700 bg-zinc-950/95 p-2 shadow-lg"
                drag
                dragConstraints={floatingBoardBounds}
                dragControls={floatingBoardDragControls}
                dragElastic={0}
                dragListener={false}
                dragMomentum={false}
                id="studio-edit-composer"
                onSubmit={submitInstruction}
              >
                <div
                  className="mb-1.5 flex min-w-0 cursor-grab items-center gap-2 text-[10px] active:cursor-grabbing"
                  onPointerDown={(event) => floatingBoardDragControls.start(event.nativeEvent)}
                  style={{ touchAction: "none" }}
                >
                  <span className="shrink-0 font-medium text-zinc-300">Describe an edit</span>
                  <span className="shrink-0 border border-zinc-700 px-1.5 py-0.5 tabular-nums text-zinc-400">
                    from {currentTime.toFixed(2)}s
                  </span>
                  <span className="min-w-0 truncate border border-zinc-800 px-1.5 py-0.5 text-zinc-500">
                    {selectionLabel}
                  </span>
                  <span className="ml-auto shrink-0 text-zinc-600">
                    {import.meta.env.VITE_POIETRA_AI_ENDPOINT ? "Model endpoint" : "Local fixture"}
                  </span>
                  <span className="shrink-0 border-l border-zinc-800 pl-2 text-zinc-500">Drag</span>
                  <button
                    className="shrink-0 border-l border-zinc-800 pl-2 text-zinc-400 hover:text-zinc-100"
                    onClick={() => setIsComposerVisible(false)}
                    onPointerDown={(event) => event.stopPropagation()}
                    type="button"
                  >
                    Hide
                  </button>
                </div>
                <div className="flex items-end gap-1.5">
                  <label className="sr-only" htmlFor="edit-instruction">Edit instruction</label>
                  <textarea
                    className="max-h-20 min-h-8 min-w-0 flex-1 resize-none border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs leading-5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500"
                    disabled={suggestionStatus === "loading"}
                    id="edit-instruction"
                    onChange={(event) => setInstruction(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={`At ${currentTime.toFixed(2)}s, e.g. “5秒前から文字で解説して”`}
                    rows={1}
                    value={instruction}
                  />
                  <button
                    className="min-h-8 shrink-0 bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
                    disabled={instruction.trim().length === 0 || suggestionStatus === "loading"}
                    type="submit"
                  >
                    {suggestionStatus === "loading" ? "Drafting…" : "Preview"}
                  </button>
                </div>

                {suggestionStatus === "idle" && instruction.length === 0 ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                    <span className="text-zinc-600">Try</span>
                    <button
                      className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
                      onClick={() => setInstruction("Move 96 px right in an upward arc over 1.5s")}
                      type="button"
                    >
                      arc right over 1.5s
                    </button>
                    <button
                      className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
                      onClick={() => setInstruction("10秒の時点から64ピクセル上へ1秒かけて移動")}
                      type="button"
                    >
                      add motion at 10s
                    </button>
                    <button
                      className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
                      onClick={() => setInstruction("これをマクスウェル方程式に変更して")}
                      type="button"
                    >
                      transform MathTex
                    </button>
                    <button
                      className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
                      onClick={() => setInstruction("5秒前からマクスウェル方程式に文字を出現させて解説して")}
                      type="button"
                    >
                      explain from 5s ago
                    </button>
                    <button
                      className="text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
                      onClick={() => setInstruction("ここで良い感じの図形でシーンチェンジしたい")}
                      type="button"
                    >
                      shape Scene transition
                    </button>
                  </div>
                ) : null}

                <div aria-live="polite">
                  {suggestionStatus === "ready" && suggestion ? (
                    <div className="mt-2 border-t border-zinc-800 pt-2 text-[10px]">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-pretty font-medium text-sky-300">
                            {suggestion.provider === "remote" ? "AI draft" : "Fixture draft"} · preview only
                          </p>
                          <p className="mt-0.5 text-pretty leading-4 text-zinc-400">{suggestion.summary}</p>
                        </div>
                        <button
                          className="shrink-0 text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
                          onClick={discardSuggestion}
                          type="button"
                        >
                          Discard
                        </button>
                      </div>
                      <details className="mt-1 text-zinc-600">
                        <summary className="cursor-pointer hover:text-zinc-400">Assumptions · {suggestion.assumptions.length}</summary>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-pretty leading-4">
                          {suggestion.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
                        </ul>
                      </details>
                    </div>
                  ) : null}
                  {(suggestionStatus === "clarification" || suggestionStatus === "error") && suggestionMessage ? (
                    <div className={cn(
                      "mt-2 border-t pt-2 text-pretty text-[10px] leading-4",
                      suggestionStatus === "error"
                        ? "border-red-950 text-red-300"
                        : "border-amber-950 text-amber-300",
                    )}>
                      {suggestionStatus === "error" ? "Could not preview: " : "More detail needed: "}{suggestionMessage}
                    </div>
                  ) : null}
                </div>
              </m.form>
              </LazyMotion>
              </div>
                </div>,
                document.body,
              )}

              <div className="absolute bottom-2 left-2 flex gap-2 text-[11px] tabular-nums text-zinc-500">
                <span>640 × 360</span>
                <span>frame 300</span>
                <span>{formatTime(currentTime)}</span>
              </div>
              </div>
            </div>
          </div>

          <section className="shrink-0 border-t border-zinc-800 bg-zinc-900/70 px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <button
                  className="min-w-16 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
                  onClick={togglePlayback}
                  type="button"
                >
                  {isPlaying ? "Pause" : currentTime >= SCENE_DURATION ? "Replay" : "Play"}
                </button>
                <h2 className="text-balance text-xs font-medium text-zinc-300">Timeline</h2>
                <span className="text-xs text-zinc-500">{selectedPlay.name}</span>
              </div>
              <span className="text-xs tabular-nums text-zinc-400">{formatTime(currentTime)} / 00:12.00</span>
            </div>

            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
              <span className="text-[11px] text-zinc-600">Scene</span>
              <div className="relative h-12 overflow-hidden border border-zinc-700 bg-zinc-950">
                <div className="absolute inset-0 flex">
                  {timelineZones.map((zone) => {
                    const active = currentTime >= zone.start && currentTime < zone.end;
                    const exitLabel = zone.exitingObjects.length > 0
                      ? `${zone.exitingObjects.length} ${zone.exitingObjects.length === 1 ? "object exits" : "objects exit"}`
                      : null;
                    return (
                    <div
                      className={cn(
                        "relative flex min-w-0 items-end border-r px-2 pb-1 text-[11px]",
                        zone.startsEdit
                          ? "border-sky-700 bg-sky-950/70"
                          : zone.hasEditEffect
                            ? "border-zinc-800 bg-sky-950/30"
                            : "border-zinc-800",
                        active ? "text-zinc-200" : "text-zinc-600",
                      )}
                      data-edit-zone={zone.startsEdit ? "true" : undefined}
                      key={`${zone.start}-${zone.end}`}
                      style={{ width: `${((zone.end - zone.start) / SCENE_DURATION) * 100}%` }}
                      title={`${formatTime(zone.start)}–${formatTime(zone.end)}${zone.startsEdit ? ` · ${zone.startsEditProgram ? "Edit Program" : zone.startsSceneTransition ? "Scene transition" : zone.startsExplanation ? "explanation" : zone.startsTransform ? "content transform" : zone.startsMovement ? "animation" : "position edit"} starts` : ""}${zone.isSceneBoundary ? " · incoming Scene boundary" : ""}${zone.endsEditProgram ? " · Edit Program ends" : zone.endsSceneTransition ? " · Scene transition ends" : zone.endsExplanation ? " · FadeIn ends" : zone.endsTransform ? " · content transform ends" : ""}${zone.endsMovement ? " · animation ends" : ""}${exitLabel ? ` · ${exitLabel}` : ""}`}
                    >
                      {zone.startsEdit || zone.isSceneBoundary || zone.endsSceneTransition || zone.endsExplanation || zone.endsTransform || zone.endsMovement || exitLabel ? (
                        <span className={cn(
                          "absolute left-1 top-1 text-[9px] tabular-nums",
                          zone.startsEdit ? "text-sky-400" : "text-zinc-500",
                        )}>
                          {zone.start.toFixed(2)}
                        </span>
                      ) : null}
                      <span className="truncate">
                        {zone.startsEdit
                          ? zone.startsEditProgram
                            ? "Program starts"
                            : zone.startsSceneTransition
                            ? "Transition starts"
                            : zone.startsExplanation
                            ? "Explanation starts"
                            : zone.startsTransform
                            ? "Transform starts"
                            : zone.startsMovement ? "Animation starts" : "Position changes"
                          : zone.isSceneBoundary
                            ? "Next Scene boundary"
                          : zone.endsEditProgram
                            ? "Program ends"
                            : zone.endsSceneTransition
                            ? "Transition ends"
                            : zone.endsExplanation
                            ? "FadeIn ends"
                            : zone.endsTransform
                            ? "Transform ends"
                          : zone.endsMovement
                            ? "Animation ends"
                          : exitLabel
                            ? `${zone.exitingObjects.length} exit`
                            : zone.play.name}
                      </span>
                    </div>
                    );
                  })}
                </div>
                <div
                  aria-hidden="true"
                  className="absolute bottom-0 top-0 w-px bg-sky-400"
                  style={{ left: `${(currentTime / SCENE_DURATION) * 100}%` }}
                />
              </div>

              <span className="text-[11px] text-zinc-600">ProposedState</span>
              <div
                className="relative h-8 overflow-hidden border border-zinc-800 bg-zinc-950"
                data-proposed-state-sample={studioProjection.timeline.sampleId}
              >
                {canonicalTimelineEvents.filter((event) => event.interval).map((event) => (
                  <div
                    className="absolute bottom-1 top-1 overflow-hidden border border-sky-800 bg-sky-950/80 px-1 text-[9px] leading-5 text-sky-200"
                    key={event.id}
                    style={intervalStyle(event.interval!)}
                    title={`${event.label} · ${event.transactionId}`}
                  >
                    <span className="block truncate">{event.label}</span>
                  </div>
                ))}
                {canonicalTimelineEvents.filter((event) => event.at !== undefined).map((event) => (
                  <div
                    className="absolute inset-y-0 z-10 border-l-2 border-sky-300"
                    key={event.id}
                    style={{ left: `${(event.at! / SCENE_DURATION) * 100}%` }}
                    title={`${event.label} · ${formatTime(event.at!)}`}
                  />
                ))}
                <div
                  aria-hidden="true"
                  className="absolute bottom-0 top-0 z-20 w-px bg-sky-400"
                  style={{ left: `${(currentTime / SCENE_DURATION) * 100}%` }}
                />
              </div>

              {SCENE_OBJECTS.map((object) => {
                const sourceMotions = SOURCE_MOTIONS.filter((motion) => motion.objectIds.includes(object.id));
                const objectAppliedEdits = appliedEdits.filter((edit) => edit.affected.includes(object.id));
                const objectPendingEdits = pendingTimelineEdits.filter((edit) => edit.affected.includes(object.id));
                const objectAppliedTransforms = appliedTransforms.filter((transform) => transform.sourceObjectId === object.id);
                const objectPendingTransforms = pendingTimelineTransforms.filter((transform) => transform.sourceObjectId === object.id);
                return (
                  <div className="contents" key={object.id}>
                    <button
                      className={cn(
                        "truncate text-left text-[11px]",
                        selectedSet.has(object.id) ? "text-sky-300" : "text-zinc-600 hover:text-zinc-300",
                      )}
                      onClick={() => {
                        if (!selectedSet.has(object.id) || selectedObjectIds.length !== 1) stageActiveEdit();
                        setSelectedObjectIds([object.id]);
                        setSelectedPlanId(defaultPlanId);
                        const motion = SOURCE_MOTIONS.find((candidate) => (
                          candidate.objectIds.includes(object.id)
                          && currentTime >= candidate.interval.start
                          && currentTime < candidate.interval.end
                        ));
                        setFocusedMotionId(motion?.id ?? null);
                      }}
                      title={object.id}
                      type="button"
                    >
                      {object.displayName}{!presentSet.has(object.id) ? " · off" : ""}
                    </button>
                    <div className="relative h-8 overflow-hidden border border-zinc-800 bg-zinc-950">
                      {OBJECT_LIFETIMES[object.id].map((lifetime) => (
                        <div
                          aria-hidden="true"
                          className="absolute inset-y-0 bg-zinc-900/80"
                          key={`${object.id}-${lifetime.start}-${lifetime.end}`}
                          style={intervalStyle(lifetime)}
                        />
                      ))}
                      {OBJECT_LIFETIMES[object.id].filter((lifetime) => lifetime.end < SCENE_DURATION).map((lifetime) => (
                        <div
                          className="absolute inset-y-0 z-10 border-r border-zinc-500"
                          key={`exit-${object.id}-${lifetime.end}`}
                          style={{ left: `${(lifetime.end / SCENE_DURATION) * 100}%` }}
                          title={`${object.displayName} leaves at ${formatTime(lifetime.end)}`}
                        />
                      ))}
                      {sourceMotions.map((motion) => (
                        <button
                          aria-label={`Select source motion ${motion.label}`}
                          aria-pressed={motion.id === focusedMotion?.id && selectedPlan.id === "play-target"}
                          className={cn(
                            "absolute top-0.5 h-3 px-1 text-left text-[9px] leading-3",
                            motion.id === focusedMotion?.id && selectedPlan.id === "play-target"
                              ? "bg-zinc-700 text-zinc-100"
                              : "bg-zinc-900 text-zinc-500 hover:bg-zinc-800",
                          )}
                          key={motion.id}
                          onClick={() => {
                            if (hasAnyDraft || !selectedSet.has(object.id) || selectedObjectIds.length !== 1) {
                              stageActiveEdit();
                            }
                            setFocusedMotionId(motion.id);
                            setSelectedObjectIds(motion.objectIds);
                            setEditMode("animate");
                            setSelectedPlanId("play-target");
                            setCurrentTime((motion.interval.start + motion.interval.end) / 2);
                          }}
                          style={intervalStyle(motion.interval)}
                          title={`${motion.label} ${formatTime(motion.interval.start)}–${formatTime(motion.interval.end)} · ${motion.easing}`}
                          type="button"
                        >
                          <span className="block truncate">{motion.label}</span>
                        </button>
                      ))}
                      {objectAppliedEdits.map((edit, index) => {
                        const interval = editIntervalForObject(edit, object.id);
                        return (
                          <div
                            className="absolute bottom-0.5 h-3 overflow-hidden border border-sky-800 bg-sky-950 px-1 text-[9px] leading-3 text-sky-300"
                            key={`applied-${index}-${edit.start}`}
                            style={intervalStyle(interval)}
                            title={`${edit.planId === "play-target" ? "Reshaped path" : edit.planId === "new-move" ? "New movement" : "Position effect"} ${formatTime(interval.start)}–${formatTime(interval.end)}`}
                          >
                            <span className="block truncate">
                              {edit.planId === "play-target" ? "path" : edit.planId === "new-move" ? "new move" : "position"}
                            </span>
                          </div>
                        );
                      })}
                      {objectPendingEdits.map((edit, index) => {
                        const interval = editIntervalForObject(edit, object.id);
                        return (
                          <div
                            className="absolute bottom-0.5 z-10 h-3 overflow-hidden border border-dashed border-sky-300 bg-sky-950 px-1 text-[9px] leading-3 text-sky-200"
                            key={`pending-${index}-${edit.start}`}
                            style={intervalStyle(interval)}
                            title={`Pending ${edit.planId === "play-target" ? "path" : edit.planId === "new-move" ? "new movement" : "position"} for ${object.id}`}
                          >
                            <span className="block truncate">
                              {edit.planId === "play-target" ? "path candidate" : edit.planId === "new-move" ? "new move" : "position candidate"}
                            </span>
                          </div>
                        );
                      })}
                      {objectAppliedTransforms.map((transform) => (
                        <div
                          className="absolute bottom-0.5 h-3 overflow-hidden border border-sky-700 bg-sky-900 px-1 text-[9px] leading-3 text-sky-100"
                          key={`applied-transform-${transform.targetRuntimeId}`}
                          style={intervalStyle(transform.interval)}
                          title={`TransformMatchingTex ${formatTime(transform.interval.start)}–${formatTime(transform.interval.end)} · source identity replaced`}
                        >
                          <span className="block truncate">transform</span>
                        </div>
                      ))}
                      {objectPendingTransforms.map((transform) => (
                        <div
                          className="absolute bottom-0.5 z-10 h-3 overflow-hidden border border-dashed border-sky-200 bg-sky-950 px-1 text-[9px] leading-3 text-sky-100"
                          key={`pending-transform-${transform.targetRuntimeId}`}
                          style={intervalStyle(transform.interval)}
                          title={`Pending TransformMatchingTex to ${transform.target.label}`}
                        >
                          <span className="block truncate">transform candidate</span>
                        </div>
                      ))}
                      <div
                        aria-hidden="true"
                        className="absolute bottom-0 top-0 z-10 w-px bg-sky-400"
                        style={{ left: `${(currentTime / SCENE_DURATION) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}

              {timelineExplanations.map((explanation) => {
                const pending = pendingTimelineExplanations.some(
                  (candidate) => candidate.runtimeId === explanation.runtimeId,
                );
                return (
                  <div className="contents" key={`timeline-${explanation.runtimeId}`}>
                    <span className="truncate text-left text-[11px] text-zinc-500" title={explanation.text}>
                      {explanation.runtimeId}
                    </span>
                    <div className="relative h-8 overflow-hidden border border-zinc-800 bg-zinc-950">
                      <div
                        aria-hidden="true"
                        className="absolute inset-y-0 bg-zinc-900/80"
                        style={intervalStyle({ start: explanation.interval.start, end: SCENE_DURATION })}
                      />
                      <div
                        className={cn(
                          "absolute bottom-0.5 h-3 overflow-hidden border px-1 text-[9px] leading-3",
                          pending
                            ? "z-10 border-dashed border-sky-200 bg-sky-950 text-sky-100"
                            : "border-sky-700 bg-sky-900 text-sky-100",
                        )}
                        style={intervalStyle(explanation.interval)}
                        title={`${pending ? "Pending " : ""}FadeIn ${formatTime(explanation.interval.start)}–${formatTime(explanation.interval.end)} · persists afterward`}
                      >
                        <span className="block truncate">{pending ? "FadeIn candidate" : "FadeIn"}</span>
                      </div>
                      <div
                        aria-hidden="true"
                        className="absolute bottom-0 top-0 z-10 w-px bg-sky-400"
                        style={{ left: `${(currentTime / SCENE_DURATION) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}

              {timelineSceneTransitions.map((transition) => {
                const pending = pendingTimelineSceneTransitions.some(
                  (candidate) => candidate.runtimeId === transition.runtimeId,
                );
                return (
                  <div className="contents" key={`timeline-${transition.runtimeId}`}>
                    <span className="truncate text-left text-[11px] text-zinc-500" title={`${transition.shape} transition`}>
                      {transition.runtimeId}
                    </span>
                    <div className="relative h-8 overflow-hidden border border-zinc-800 bg-zinc-950">
                      <div
                        className={cn(
                          "absolute bottom-0.5 h-3 overflow-hidden border px-1 text-[9px] leading-3",
                          pending
                            ? "z-10 border-dashed border-sky-200 bg-sky-950 text-sky-100"
                            : "border-sky-700 bg-sky-900 text-sky-100",
                        )}
                        style={intervalStyle(transition.interval)}
                        title={`${pending ? "Pending " : ""}${transition.shape} cover-and-reveal ${formatTime(transition.interval.start)}–${formatTime(transition.interval.end)}`}
                      >
                        <span className="block truncate">{pending ? "transition candidate" : "Scene transition"}</span>
                      </div>
                      <div
                        aria-hidden="true"
                        className="absolute bottom-0 top-0 z-10 w-px border-l border-dashed border-white/60"
                        style={{ left: `${(((transition.interval.start + transition.interval.end) / 2) / SCENE_DURATION) * 100}%` }}
                      />
                      <div
                        aria-hidden="true"
                        className="absolute bottom-0 top-0 z-10 w-px bg-sky-400"
                        style={{ left: `${(currentTime / SCENE_DURATION) * 100}%` }}
                      />
                    </div>
                  </div>
                );
              })}

              <span aria-hidden="true" />
              <div>
                <label className="sr-only" htmlFor="timeline-position">Timeline position</label>
                <input
                  className="w-full accent-sky-400"
                  id="timeline-position"
                  max={SCENE_DURATION}
                  min="0"
                  onChange={(event) => {
                    const nextTime = Number(event.currentTarget.value);
                    if (hasDraftEdit) stageActiveEdit();
                    if (selectedPlanId === "play-target") {
                      const pathStillActive = SOURCE_MOTIONS.some((motion) => (
                        motion.objectIds.some((objectId) => selectedSet.has(objectId))
                        && nextTime >= motion.interval.start
                        && nextTime < motion.interval.end
                      ));
                      if (!pathStillActive) setSelectedPlanId("new-move");
                    }
                    setCurrentTime(nextTime);
                  }}
                  onPointerDown={() => setIsPlaying(false)}
                  step="0.01"
                  type="range"
                  value={currentTime}
                />
              </div>
            </div>
          </section>
        </div>

        <aside className="col-span-3 flex min-h-0 min-w-0 flex-col border-l border-zinc-800 bg-zinc-900">
          <div className="border-b border-zinc-800 p-4">
            {isEditProgramDraft && draftEditProgram ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-balance text-sm font-medium">Edit Program</h2>
                  <span className="border border-sky-800 px-1.5 py-0.5 text-[10px] text-sky-300">
                    {draftEditProgram.operationKinds.length} operations
                  </span>
                </div>
                <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
                  Review every decomposed effect, its {draftEditProgram.execution} ordering, and one atomic Apply/Undo boundary.
                </p>
              </>
            ) : draftSceneTransition ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-balance text-sm font-medium">Scene transition</h2>
                  <span className="border border-sky-800 px-1.5 py-0.5 text-[10px] text-sky-300">AI candidate</span>
                </div>
                <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
                  Review a new Scene-level shape wipe. It does not depend on the selected object.
                </p>
              </>
            ) : draftExplanation ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-balance text-sm font-medium">Explanation text</h2>
                  <span className="border border-sky-800 px-1.5 py-0.5 text-[10px] text-sky-300">AI candidate</span>
                </div>
                <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
                  Review a new Text object, its target-relative placement, and the resolved past time.
                </p>
              </>
            ) : draftTransform ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-balance text-sm font-medium">Content transform</h2>
                  <span className="border border-sky-800 px-1.5 py-0.5 text-[10px] text-sky-300">AI candidate</span>
                </div>
                <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
                  Review a timed MathTex replacement. This is distinct from changing position or adding movement.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-balance text-sm font-medium">Edit type</h2>
                <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
                  Choose whether this drag changes a position or creates motion over time.
                </p>
                <div className="mt-3 grid grid-cols-2 gap-1" role="group" aria-label="Edit type">
                  <button
                    aria-pressed={editMode === "position"}
                    className={cn(
                      "border px-3 py-2 text-left",
                      editMode === "position"
                        ? "border-sky-700 bg-sky-950/60 text-sky-200"
                        : "border-zinc-700 bg-zinc-950/40 text-zinc-400 hover:border-zinc-600",
                    )}
                    onClick={() => chooseEditMode("position")}
                    type="button"
                  >
                    <span className="block text-xs font-medium">Position</span>
                    <span className="mt-0.5 block text-[10px] text-zinc-500">No animation</span>
                  </button>
                  <button
                    aria-pressed={editMode === "animate"}
                    className={cn(
                      "border px-3 py-2 text-left",
                      editMode === "animate"
                        ? "border-sky-700 bg-sky-950/60 text-sky-200"
                        : "border-zinc-700 bg-zinc-950/40 text-zinc-400 hover:border-zinc-600",
                    )}
                    onClick={() => chooseEditMode("animate")}
                    type="button"
                  >
                    <span className="block text-xs font-medium">Animate</span>
                    <span className="mt-0.5 block text-[10px] text-zinc-500">Timed movement</span>
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {draftProgramRecord ? (
              <section
                className="mb-4 border border-sky-900 bg-sky-950/20 p-2 text-[10px] leading-4"
                data-proposed-state-sample={studioProjection.inspector.sampleId}
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium text-sky-200">Canonical EditProgram v{draftProgramRecord.program.version}</h3>
                  <span className="text-sky-400">{draftProgramRecord.program.schedule.mode}</span>
                </div>
                <dl className="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-zinc-500">
                  <dt>Transaction</dt>
                  <dd className="truncate font-mono text-zinc-300">{draftProgramRecord.program.transactionId}</dd>
                  <dt>Anchor</dt>
                  <dd className="text-zinc-300">
                    {draftProgramRecord.program.anchor.resolvedSeconds.toFixed(2)}s · captured {draftProgramRecord.program.anchor.capturedPlayhead.toFixed(2)}s
                  </dd>
                  <dt>IR leaves</dt>
                  <dd className="text-zinc-300">{draftProgramRecord.program.operations.length} canonical · {draftProgramRecord.program.intentCount} intents</dd>
                  <dt>Lowering</dt>
                  <dd className="text-zinc-300">{draftProgramRecord.program.loweringStatus}</dd>
                </dl>
                {draftProgramRecord.validation.issues.length > 0 ? (
                  <ul className="mt-2 border-t border-sky-950 pt-2 text-amber-300">
                    {draftProgramRecord.validation.issues.map((issue) => (
                      <li key={`${issue.code}-${issue.operationId ?? issue.field}`}>{issue.field}: {issue.message}</li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
            {isEditProgramDraft && draftEditProgram && draftProgramInterval ? (
              <section className="border-b border-zinc-800 pb-4 text-xs">
                <h3 className="text-balance font-medium text-zinc-200">Decomposed operations</h3>
                <ol className="mt-3 space-y-1.5">
                  {draftEditProgram.operationKinds.map((kind, index) => {
                    const interval = kind === "create-motion"
                      ? draftMotion
                      : kind === "create-transform"
                        ? draftTransform?.interval
                        : draftExplanation?.interval;
                    const label = kind === "create-motion"
                      ? "Move selected object"
                      : kind === "create-transform"
                        ? `Transform to ${draftTransform?.target.label ?? "MathTex target"}`
                        : `Show ${draftExplanation?.runtimeId ?? "explanation Text"}`;
                    return (
                      <li className="flex items-center gap-2 border border-zinc-800 bg-zinc-950 px-2 py-1.5" key={`${kind}-${index}`}>
                        <span className="font-mono text-[10px] text-zinc-600">{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-zinc-300">{label}</span>
                        <span className="shrink-0 tabular-nums text-[10px] text-zinc-500">
                          {interval ? `${interval.start.toFixed(2)}–${interval.end.toFixed(2)}s` : "invalid"}
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {draftTransform || draftExplanation ? (
                  <div className="mt-3 border border-zinc-700 bg-zinc-950 p-3 text-zinc-100">
                    {draftTransform ? <EquationContent lines={draftTransform.target.displayLines} /> : null}
                    {draftExplanation ? (
                      <p className={cn(
                        "text-pretty text-center text-xs leading-5 text-zinc-300",
                        draftTransform && "mt-3 border-t border-zinc-800 pt-3",
                      )}>
                        {draftExplanation.text}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums">
                  <div>
                    <dt className="text-[10px] text-zinc-600">Starts</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftProgramInterval.start.toFixed(2)}s</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">Program ends</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftProgramInterval.end.toFixed(2)}s</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[10px] text-zinc-600">Program time anchor</dt>
                    <dd className="mt-0.5 text-zinc-300">{timeAnchorLabel(draftEditProgram.anchor)}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[10px] text-zinc-600">Atomic group</dt>
                    <dd className="mt-0.5 font-mono text-zinc-300">{draftEditProgram.groupId}</dd>
                  </div>
                </dl>
                <p className="mt-3 border border-dashed border-zinc-700 p-2 text-pretty text-[11px] leading-5 text-zinc-500">
                  The model decomposed one free-form request into supported operations. Studio independently checked targets, timing, order, and write conflicts before showing this preview.
                </p>
                {conflictingSourceMotion ? (
                  <p className="mt-2 border border-amber-800/80 bg-amber-950/30 p-2 text-pretty text-[11px] leading-5 text-amber-300">
                    This overlaps “{conflictingSourceMotion.label}” ({conflictingSourceMotion.interval.start.toFixed(2)}–{conflictingSourceMotion.interval.end.toFixed(2)}s). Source lowering must preserve that existing play boundary.
                  </p>
                ) : null}
              </section>
            ) : draftSceneTransition ? (
              <section className="border-b border-zinc-800 pb-4 text-xs">
                <h3 className="text-balance font-medium text-zinc-200">
                  {draftSceneTransition.shape} cover-and-reveal
                </h3>
                <div className="mt-3 flex h-28 items-center justify-center overflow-hidden border border-zinc-700 bg-zinc-950">
                  <div className={cn(
                    "size-14",
                    draftSceneTransition.shape === "circle" && "rounded-full",
                    draftSceneTransition.shape === "diamond" && "rotate-45 rounded-md",
                    draftSceneTransition.shape === "hexagon" && "[clip-path:polygon(25%_6.7%,75%_6.7%,100%_50%,75%_93.3%,25%_93.3%,0%_50%)]",
                    draftSceneTransition.color === "sky" && "bg-sky-500",
                    draftSceneTransition.color === "white" && "bg-white",
                    draftSceneTransition.color === "black" && "border border-zinc-700 bg-black",
                  )} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums">
                  <div>
                    <dt className="text-[10px] text-zinc-600">Cover starts</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftSceneTransition.interval.start.toFixed(2)}s</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">Scene boundary</dt>
                    <dd className="mt-0.5 text-zinc-300">
                      {((draftSceneTransition.interval.start + draftSceneTransition.interval.end) / 2).toFixed(2)}s
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">Reveal ends</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftSceneTransition.interval.end.toFixed(2)}s</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">Destination</dt>
                    <dd className="mt-0.5 text-zinc-300">next Scene</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[10px] text-zinc-600">Time anchor</dt>
                    <dd className="mt-0.5 text-zinc-300">{timeAnchorLabel(draftSceneTransition.anchor)}</dd>
                  </div>
                </dl>
                <p className="mt-3 border border-dashed border-zinc-700 p-2 text-pretty text-[11px] leading-5 text-zinc-500">
                  The browser proves the shape coverage and timing. The incoming Scene composition is connected at the fully covered midpoint during final lowering.
                </p>
              </section>
            ) : draftExplanation ? (
              <section className="border-b border-zinc-800 pb-4 text-xs">
                <h3 className="text-balance font-medium text-zinc-200">Create {draftExplanation.runtimeId}</h3>
                <div className="mt-3 border border-zinc-700 bg-zinc-950 p-3 text-pretty text-center leading-5 text-zinc-100">
                  {draftExplanation.text}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums">
                  <div>
                    <dt className="text-[10px] text-zinc-600">Resolved start</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftExplanation.interval.start.toFixed(2)}s</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">FadeIn ends</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftExplanation.interval.end.toFixed(2)}s</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[10px] text-zinc-600">Time anchor</dt>
                    <dd className="mt-0.5 text-zinc-300">{timeAnchorLabel(draftExplanation.anchor)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">Target</dt>
                    <dd className="mt-0.5 font-mono text-zinc-300">{draftExplanation.targetObjectId}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">Placement</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftExplanation.placement}</dd>
                  </div>
                </dl>
                <p className="mt-3 border border-dashed border-zinc-700 p-2 text-pretty text-[11px] leading-5 text-zinc-500">
                  Play or scrub through the FadeIn interval. The explanation remains visible afterward; the selected equation is not replaced.
                </p>
              </section>
            ) : draftTransform ? (
              <section className="border-b border-zinc-800 pb-4 text-xs">
                <h3 className="text-balance font-medium text-zinc-200">Transform to {draftTransform.target.label}</h3>
                <div className="mt-3 border border-zinc-700 bg-zinc-950 p-3 text-zinc-100">
                  <EquationContent lines={draftTransform.target.displayLines} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums">
                  <div>
                    <dt className="text-[10px] text-zinc-600">Starts</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftTransform.interval.start.toFixed(2)}s</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">Ends</dt>
                    <dd className="mt-0.5 text-zinc-300">{draftTransform.interval.end.toFixed(2)}s</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[10px] text-zinc-600">Strategy</dt>
                    <dd className="mt-0.5 font-mono text-zinc-300">TransformMatchingTex · morph mismatches · smooth</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-[10px] text-zinc-600">Matchable TeX parts</dt>
                    <dd className="mt-0.5 break-all font-mono text-[10px] leading-4 text-zinc-300">
                      {draftTransform.target.texParts.join(" · ")}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 border-t border-zinc-800 pt-3">
                  <p className="text-zinc-500">Runtime identity</p>
                  <p className="mt-1 break-all font-mono text-[10px] leading-4 text-zinc-300">
                    {draftTransform.sourceObjectId} → {draftTransform.targetRuntimeId}
                  </p>
                  <p className="mt-1 text-pretty text-[11px] leading-5 text-zinc-600">
                    Manim removes the source and installs the target after cleanup; generated source therefore rebinds the Python variable.
                  </p>
                </div>
                <p className="mt-3 border border-dashed border-zinc-700 p-2 text-pretty text-[11px] leading-5 text-zinc-500">
                  Play or scrub the interval to see a semantic matching preview. Shared symbols move continuously and unmatched groups cross-morph; exact LaTeX glyph motion remains render-dependent until the Manim validation pass runs.
                </p>
                {conflictingSourceMotion ? (
                  <p className="mt-2 border border-amber-800/80 bg-amber-950/30 p-2 text-pretty text-[11px] leading-5 text-amber-300">
                    This overlaps “{conflictingSourceMotion.label}” ({conflictingSourceMotion.interval.start.toFixed(2)}–{conflictingSourceMotion.interval.end.toFixed(2)}s). Source lowering must split that play or compose both animations.
                  </p>
                ) : null}
              </section>
            ) : (
              <>
            <div className="mb-3 border-b border-zinc-800 pb-3">
              <h3 className="text-balance text-xs font-medium text-zinc-300">
                {editMode === "position" ? "Where should the new position apply?" : "Which movement should be edited?"}
              </h3>
              <p className="mt-1 text-pretty text-[11px] leading-5 text-zinc-600">
                {editMode === "position"
                  ? "The gray object is the current position and the blue outline is the result. No trajectory is created."
                  : "A blue line in the rendered frame is the actual spatial path used by this movement."}
              </p>
            </div>
            <div className="space-y-1.5" role="group" aria-label="Edit candidates">
              {!canEditSelection ? (
                <div className="border border-dashed border-zinc-700 p-3">
                  <p className="text-xs text-zinc-300">Nothing selected is visible at this frame.</p>
                  <p className="mt-1 text-pretty text-[11px] leading-5 text-zinc-600">
                    Move the playhead before the object exits, or select an object that is still on screen.
                  </p>
                </div>
              ) : plans.map((plan) => {
                const selected = plan.id === selectedPlanId;
                return (
                  <button
                    aria-pressed={selected}
                    className={cn(
                      "w-full rounded-md border px-3 py-2.5 text-left",
                      selected
                        ? "border-sky-700 bg-sky-950/60"
                        : "border-zinc-700 bg-zinc-950/40 hover:border-zinc-600 hover:bg-zinc-800/70",
                    )}
                    key={plan.id}
                    onClick={() => setSelectedPlanId(plan.id)}
                    type="button"
                  >
                    <span className="block min-w-0">
                        <span className="flex items-center justify-between gap-2">
                          <span className={cn("truncate text-xs font-medium", selected ? "text-sky-200" : "text-zinc-200")}>
                            {plan.title}
                          </span>
                          <span className={cn("shrink-0 text-[10px]", selected ? "text-sky-400" : "text-zinc-600")}>
                            {plan.rank}
                          </span>
                        </span>
                        <span className="mt-1 block truncate text-[11px] tabular-nums text-zinc-500">
                          {plan.id === "play-target"
                            ? `${focusedMotion?.interval.start.toFixed(2) ?? "—"}–${focusedMotion?.interval.end.toFixed(2) ?? "—"}s · endpoints fixed`
                            : plan.id === "new-move"
                              ? `${newMoveInterval.start.toFixed(2)}–${newMoveInterval.end.toFixed(2)}s · smooth`
                            : plan.temporalScope === "whole"
                              ? `all times · ${plan.affected.length} ${plan.affected.length === 1 ? "object" : "objects"}`
                              : `${(draftMotion?.start ?? currentTime).toFixed(2)}s onward · ${plan.affected.length} ${plan.affected.length === 1 ? "object" : "objects"}`}
                        </span>
                    </span>
                    {selected ? (
                      <span className="mt-2 block text-pretty text-[11px] leading-5 text-zinc-400">
                        {plan.description}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {selectedPlan.id === "new-move" ? (
              <section className="mt-4 border-t border-zinc-800 pt-4 text-xs">
                <h3 className="text-balance font-medium text-zinc-300">New movement</h3>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 tabular-nums">
                  <div>
                    <dt className="text-[10px] text-zinc-600">Starts</dt>
                    <dd className="mt-0.5 text-zinc-300">{newMoveInterval.start.toFixed(2)}s</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] text-zinc-600">Ends</dt>
                    <dd className="mt-0.5 text-zinc-300">{newMoveInterval.end.toFixed(2)}s</dd>
                  </div>
                </dl>
                <label className="mt-3 block text-[11px] text-zinc-500" htmlFor="move-duration">
                  Duration
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    className="min-w-0 flex-1 border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs tabular-nums text-zinc-200"
                    id="move-duration"
                    max={Math.max(0.1, maximumMoveDuration)}
                    min="0.1"
                    onChange={(event) => changeMoveDuration(Number(event.currentTarget.value))}
                    step="0.1"
                    type="number"
                    value={moveDuration}
                  />
                  <span className="text-zinc-600">seconds</span>
                </div>
                {effectiveMoveDuration < moveDuration ? (
                  <p className="mt-1 text-pretty text-[10px] leading-4 text-amber-400">
                    Ends at {newMoveInterval.end.toFixed(2)}s because an affected object leaves the scene.
                  </p>
                ) : null}
                <div className="mt-3 flex items-center justify-between border-t border-zinc-800 pt-3">
                  <span className="text-zinc-500">Easing</span>
                  <span className="font-mono text-zinc-300">smooth</span>
                </div>
                <p className="mt-2 text-pretty text-[11px] leading-5 text-zinc-600">
                  Drag the object to set the destination. The blue path in the frame is generated from that exact start, destination, and bend handle.
                </p>
              </section>
            ) : null}

            {(selectedPlan.id === "play-target" && focusedMotion)
              || (selectedPlan.id === "new-move" && hasDelta) ? (
              <section className="mt-4 border-t border-zinc-800 pt-4 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-zinc-400">Bend handle</span>
                    {hasPathBend ? (
                      <button
                        className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                        onClick={() => setPathBend({ x: 0, y: 0 })}
                        type="button"
                      >
                        Reset path
                      </button>
                    ) : (
                      <span className="text-[11px] text-zinc-600">Optional</span>
                    )}
                  </div>
                  <p className="mt-1 text-pretty text-[11px] leading-5 text-zinc-600">
                    Drag the round handle in the frame to change the actual blue motion path.
                  </p>
              </section>
            ) : null}
              </>
            )}

            <details
              className="mt-4 border-t border-zinc-800 text-xs"
              data-proposed-state-sample={studioProjection.sourcePreview.sampleId}
            >
              <summary className="cursor-pointer py-3 text-zinc-300 hover:text-zinc-100">Code change</summary>
              {draftProgramRecord ? (
                <p className="mb-2 text-[10px] text-zinc-500">
                  Canonical lowering status: <span className="text-zinc-300">{draftProgramRecord.program.loweringStatus}</span>
                </p>
              ) : null}
              {hasPatchPreview ? (
                <div className="mb-3">
                  <div className="overflow-x-auto border border-zinc-700 bg-zinc-950 p-2 font-mono text-[11px] leading-5">
                    <div className="whitespace-pre text-red-300/70">- {patch.before}</div>
                    {patch.after.split("\n").map((line, index) => (
                      <div className="whitespace-pre text-emerald-300/80" key={`${index}-${line}`}>+ {line}</div>
                    ))}
                  </div>
                  <p className="mt-2 text-pretty leading-5 text-zinc-500">{patch.context}</p>
                </div>
              ) : (
                <p className="mb-3 border border-dashed border-zinc-700 p-3 text-pretty leading-5 text-zinc-500">
                  Drag {selectionLabel} to generate a candidate patch.
                </p>
              )}
            </details>

            <details className="border-t border-zinc-800 text-xs">
              <summary className="cursor-pointer py-3 text-zinc-300 hover:text-zinc-100">
                Affected entities · {affectedObjectIds.length + (draftExplanation ? 1 : 0) + (draftSceneTransition ? 1 : 0)}
              </summary>
              <ul className="mb-3 space-y-1.5">
                {affectedObjectIds.map((name) => (
                  <li className="flex items-center justify-between gap-2" key={name}>
                    <span className="truncate text-zinc-400">{name}</span>
                    <span className="text-sky-400">changes</span>
                  </li>
                ))}
                {draftExplanation ? (
                  <li className="flex items-center justify-between gap-2" key={draftExplanation.runtimeId}>
                    <span className="truncate text-zinc-400">{draftExplanation.runtimeId}</span>
                    <span className="text-sky-400">created</span>
                  </li>
                ) : null}
                {draftSceneTransition ? (
                  <li className="flex items-center justify-between gap-2" key={draftSceneTransition.runtimeId}>
                    <span className="truncate text-zinc-400">Scene boundary</span>
                    <span className="text-sky-400">created</span>
                  </li>
                ) : null}
                {SCENE_OBJECTS.filter((object) => !affected.has(object.id)).map((object) => (
                  <li className="flex items-center justify-between gap-2" key={object.id}>
                    <span className="truncate text-zinc-400">{object.id}</span>
                    <span className="text-zinc-600">{presentSet.has(object.id) ? "unchanged" : "off screen"}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          <div className="border-t border-zinc-800 p-3">
            {pendingEditCount > 0 ? (
              <p className="mb-2 text-pretty text-[11px] text-zinc-500">
                {pendingEditCount} pending {pendingEditCount === 1 ? "interpretation remains" : "interpretations remain"} visible while selection changes.
              </p>
            ) : null}
            {appliedOperationCount > 0 ? (
              <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                <p className="truncate text-sky-300">{appliedOperationCount} {appliedOperationCount === 1 ? "edit" : "edits"} applied</p>
                <button
                  className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
                  onClick={undoLastApplied}
                  type="button"
                >
                  Undo
                </button>
              </div>
            ) : null}
            <button
              className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
              disabled={!hasPendingEdits}
              onClick={applyPatch}
              type="button"
            >
              {pendingEditCount > 1
                ? `Apply ${pendingEditCount} candidates`
                : hasPendingEditProgram
                  ? "Apply Edit Program"
                  : "Apply candidate"}
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}
