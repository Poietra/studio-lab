import { type SceneEntityV1, type SceneIrV1, sceneIrSourceRevisionHash, sceneIrV1Schema } from "../engine/scene-ir";
import { canonicalRuntimeTraceF64HexV3 } from "../render-pipeline/runtime-trace-v3-digest";
import {
  canonicalFastManimRuntimeTraceSampleTimeV3,
  FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3,
} from "../render-pipeline/runtime-trace-v3-shared-contract";
import { evaluateWorkingState } from "./evaluator";
import type { Point, ProgramRecord, ProjectedEntity, ProposedState, RuntimeSceneState } from "./model";
import { PRISTINE_WORKING_REVISION, type StudioVerifiedPreviewSnapshotV1 } from "./preview-snapshot-provider";
import { STUDIO_VIEWPORT } from "./studio-viewport-geometry";

export type StudioPreviewTemporalRebaseIssueCodeV1 =
  | "camera-edit-unsupported"
  | "channel-timing-edit-unsupported"
  | "conflicting-edit-unsupported"
  | "geometry-edit-unsupported"
  | "identity-unverified"
  | "mid-animation-edit-unsupported"
  | "motion-path-edit-unsupported"
  | "profile-unsupported"
  | "source-correlation-invalid"
  | "target-edit-unsupported";

export type StudioPreviewTemporalRebaseIssueV1 = Readonly<{
  code: StudioPreviewTemporalRebaseIssueCodeV1;
  message: string;
}>;

export type StudioPreviewTemporalRebaseResultV1 =
  | Readonly<{ issue: StudioPreviewTemporalRebaseIssueV1; kind: "unsupported" }>
  | Readonly<{ kind: "rebased"; scene: SceneIrV1 }>;

type AuthorizedEditV1 = Readonly<{
  operationIds: readonly string[];
  position: Point | null;
  runtimeEntityId: string;
  scaleFactor: number | null;
}>;

type SupportedTemporalRebaseProfileV1 = 7 | 8 | 9 | 10 | 12;

const OFFICIAL_BASIC_SOURCE_HASH = "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f" as const;
const SQUARE_TO_CIRCLE_V8_PROFILE = {
  runtimeConfigHash: "9650b633875a68d2e6c000e89cb21bdffabe2b6fbf08f2262b54842344e000a2",
  snapshotHash: "fbe5f70ca7ddda9a87fb39491acbf461e8b61d93e7972ca572d6da5aefa23f9a",
} as const;
const LINE_JOINTS_V10_PROFILE = {
  leaves: [
    { join: "miter", sceneOrder: 1, sourceName: "t1" },
    { join: "round", sceneOrder: 2, sourceName: "t2" },
    { join: "bevel", sceneOrder: 3, sourceName: "t3" },
  ],
  runtimeConfigHash: "b99127c213f9e049ffd247c8287bfba4f8d12d77e89bee5b1308bafc2527e9ec",
  snapshotHash: "53fd284f9fd30f8223f90dfc9c291d571bab25d61b55170d5e57cf346e1b2827",
  sourceNames: ["grp", "t1", "t2", "t3"],
} as const;
const WRITE_STUFF_V12_PROFILE = {
  runtimeConfigHash: "2022ea1ccebb06668fc92386455c4d4928305e72a5a5459d103e3d86261a4593",
  snapshotHash: "b4cb36f1756e1204d6093f9fd838f75eb6810429b5aad30abc68af4c7d7c2594",
  sourceNames: ["group", "example_text", "example_tex"],
} as const;

export type StudioPreviewInitialEditRuntimeAuthorityV1 =
  | Readonly<{
      baseCenter: Point;
      duration: 3;
      lifetime: Readonly<{ end: 3; start: 0 }>;
      profile: "square-to-circle-v8";
      relativeScale: 1;
      runtimeEntityId: string;
      studioEntityId: string;
      studioSceneId: string;
    }>
  | Readonly<{
      duration: 4;
      profile: "warp-square-v9";
      runtimeEntityId: string;
      studioEntityId: string;
      studioSceneId: string;
    }>
  | Readonly<{
      baseCenter: Point;
      duration: 1;
      lifetime: Readonly<{ end: 1; start: 0 }>;
      profile: "line-joints-v10";
      relativeScale: 1;
      runtimeEntityId: string;
      studioEntityId: string;
      studioSceneId: string;
    }>
  | Readonly<{
      baseCenter: Point;
      duration: 4;
      lifetime: Readonly<{ end: 4; start: 0 }>;
      profile: "write-stuff-v12";
      relativeScale: 1;
      runtimeEntityId: string;
      studioEntityId: string;
      studioSceneId: string;
    }>;

/**
 * Source-bound generic V3 evidence that may become edit authority once a
 * source lowerer can prove the corresponding static Studio geometry. It is
 * deliberately not part of `StudioPreviewInitialEditRuntimeAuthorityV1`, so
 * merely receiving this candidate cannot enable an interactive gesture.
 */
export type StudioPreviewGenericInitialEditAuthorityCandidateV1 = Readonly<{
  baseCenter: Point;
  /** Runtime endpoint dimensions in Scene units; never an assumed scale=1. */
  baseDimensions: Readonly<{ height: number; width: number }>;
  bindingId: string;
  duration: number;
  lifetime: Readonly<{ end: number; start: 0 }>;
  profile: "generic-runtime-trace-v3";
  runtimeEntityId: string;
  sourceName: string;
  studioEntityId: string;
  studioSceneId: string;
}>;

export type StudioPreviewInitialEditProjectionAuthorityV1 =
  | StudioPreviewGenericInitialEditAuthorityCandidateV1
  | StudioPreviewInitialEditRuntimeAuthorityV1;

export type StudioPreviewGenericInitialEditV1 =
  | Readonly<{ kind: "move"; position: Point }>
  | Readonly<{ kind: "resize"; scaleFactor: number }>;

export type StudioPreviewGenericInitialEditProgramSetV1 =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      candidate: StudioPreviewGenericInitialEditAuthorityCandidateV1;
      edit: StudioPreviewGenericInitialEditV1;
      kind: "authorized";
    }>
  | Readonly<{ kind: "unauthorized" }>;

function unsupported(code: StudioPreviewTemporalRebaseIssueCodeV1, message: string) {
  return { issue: { code, message }, kind: "unsupported" } as const;
}

function closeEnough(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

function isFinitePoint(value: unknown): value is Point {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y)
  );
}

function isExactCreateChannel(channel: SceneIrV1["animationChannels"][number]) {
  return (
    channel.kind === "path-trim" &&
    channel.parameterization === "uniform-cubic-parameter-v1" &&
    channel.keyframes.length === 2 &&
    channel.keyframes[0]?.at === 0 &&
    channel.keyframes[0]?.value === 0 &&
    channel.keyframes[1]?.value === 1
  );
}

function supportedTemporalRebaseProfileV1(scene: SceneIrV1): SupportedTemporalRebaseProfileV1 | null {
  const source = scene.source;
  if (source.kind !== "imported-manim-server-snapshot") return null;
  const version = Number(source.snapshotVersion);
  return version === 7 || version === 8 || version === 9 || version === 10 || version === 12 ? version : null;
}

function isExactManimSmoothInterval(channel: SceneIrV1["animationChannels"][number], start: number, end: number) {
  return (
    channel.keyframes.length === 2 &&
    channel.keyframes[0]?.at === start &&
    channel.keyframes[0]?.easingToNext?.kind === "manim-smooth" &&
    channel.keyframes[1]?.at === end &&
    channel.keyframes[1]?.easingToNext === null
  );
}

function isExactStableSquareToCircleV8(scene: SceneIrV1, runtimeEntityId: string) {
  const [entity] = scene.entities;
  const [opacity, pathMorph, vectorAppearance, pathTrim] = scene.animationChannels;
  return (
    supportedTemporalRebaseProfileV1(scene) === 8 &&
    scene.duration === 3 &&
    scene.entities.length === 1 &&
    entity?.id === runtimeEntityId &&
    entity.geometry.kind === "cubic-path" &&
    entity.lifetimes.length === 1 &&
    entity.lifetimes[0]?.start === 0 &&
    entity.lifetimes[0]?.end === 3 &&
    scene.animationChannels.length === 4 &&
    opacity?.kind === "opacity" &&
    opacity.entityId === runtimeEntityId &&
    isExactManimSmoothInterval(opacity, 2, 3) &&
    opacity.keyframes[0]?.value === 1 &&
    opacity.keyframes[1]?.value === 0 &&
    pathMorph?.kind === "path-morph" &&
    pathMorph.entityId === runtimeEntityId &&
    isExactManimSmoothInterval(pathMorph, 1, 2) &&
    vectorAppearance?.kind === "vector-appearance" &&
    vectorAppearance.entityId === runtimeEntityId &&
    isExactManimSmoothInterval(vectorAppearance, 1, 2) &&
    pathTrim?.kind === "path-trim" &&
    pathTrim.entityId === runtimeEntityId &&
    isExactCreateChannel(pathTrim) &&
    pathTrim.keyframes[0]?.easingToNext?.kind === "manim-smooth" &&
    pathTrim.keyframes[1]?.at === 1 &&
    pathTrim.keyframes[1]?.easingToNext === null
  );
}

function isExactOfficialSquareToCircleV8(scene: SceneIrV1, runtimeEntityId: string) {
  const source = scene.source;
  return (
    source.kind === "imported-manim-server-snapshot" &&
    source.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    source.snapshotHash === SQUARE_TO_CIRCLE_V8_PROFILE.snapshotHash &&
    source.runtimeConfigHash === SQUARE_TO_CIRCLE_V8_PROFILE.runtimeConfigHash &&
    scene.requiredCapabilities.length === 5 &&
    scene.requiredCapabilities[0] === "cubic-path-geometry" &&
    scene.requiredCapabilities[1] === "opacity-animation" &&
    scene.requiredCapabilities[2] === "path-morph-animation" &&
    scene.requiredCapabilities[3] === "path-trim-animation" &&
    scene.requiredCapabilities[4] === "vector-appearance-animation" &&
    scene.camera.view.center.x === 0 &&
    scene.camera.view.center.y === 0 &&
    scene.camera.view.frameWidth === 14.222222222222221 &&
    scene.camera.view.frameHeight === 8 &&
    isExactStableSquareToCircleV8(scene, runtimeEntityId)
  );
}

function isExactStableWarpSquareV9(scene: SceneIrV1, runtimeEntityId: string) {
  const [entity] = scene.entities;
  const [pathMorph] = scene.animationChannels;
  return (
    supportedTemporalRebaseProfileV1(scene) === 9 &&
    scene.duration === 4 &&
    scene.entities.length === 1 &&
    entity?.id === runtimeEntityId &&
    entity.geometry.kind === "cubic-path" &&
    entity.lifetimes.length === 1 &&
    entity.lifetimes[0]?.start === 0 &&
    entity.lifetimes[0]?.end === 4 &&
    scene.animationChannels.length === 1 &&
    pathMorph?.kind === "path-morph" &&
    pathMorph.entityId === runtimeEntityId &&
    isExactManimSmoothInterval(pathMorph, 0, 3)
  );
}

function isExactStableLineJointsV10(
  scene: SceneIrV1,
  runtimeIds: Readonly<{ grp: string; t1: string; t2: string; t3: string }>,
) {
  // The verified snapshot hash seals full content; these checks pin the
  // hierarchy facts consumed locally instead of reimplementing its producer.
  const source = scene.source;
  const [group] = scene.entities;
  return (
    source.kind === "imported-manim-server-snapshot" &&
    supportedTemporalRebaseProfileV1(scene) === 10 &&
    source.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    source.snapshotHash === LINE_JOINTS_V10_PROFILE.snapshotHash &&
    source.runtimeConfigHash === LINE_JOINTS_V10_PROFILE.runtimeConfigHash &&
    scene.duration === 1 &&
    scene.animationChannels.length === 0 &&
    scene.entities.length === 4 &&
    scene.requiredCapabilities.length === 2 &&
    scene.requiredCapabilities[0] === "cubic-path-geometry" &&
    scene.requiredCapabilities[1] === "logical-group" &&
    scene.camera.view.center.x === 0 &&
    scene.camera.view.center.y === 0 &&
    scene.camera.view.frameWidth === 14.222222222222221 &&
    scene.camera.view.frameHeight === 8 &&
    group?.id === runtimeIds.grp &&
    group.geometry.kind === "group" &&
    group.parentId === null &&
    LINE_JOINTS_V10_PROFILE.leaves.every((profile, index) => {
      const entity = scene.entities[index + 1];
      return (
        entity?.id === runtimeIds[profile.sourceName] &&
        entity.parentId === runtimeIds.grp &&
        entity.sceneOrder === profile.sceneOrder &&
        entity.geometry.kind === "cubic-path" &&
        entity.appearance.kind === "vector" &&
        entity.appearance.stroke?.join === profile.join &&
        entity.lifetimes.length === 1 &&
        entity.lifetimes[0]?.start === 0 &&
        entity.lifetimes[0]?.end === 1
      );
    })
  );
}

function isExactStableWriteStuffV12(
  scene: SceneIrV1,
  runtimeIds: Readonly<{ exampleTex: string; exampleText: string; group: string }>,
) {
  // The sealed snapshot hash owns the exact 575 cubic curves and all channel
  // bytes. These local checks pin only the hierarchy facts authoring consumes.
  const source = scene.source;
  const [group, exampleText] = scene.entities;
  const exampleTex = scene.entities[32];
  return (
    source.kind === "imported-manim-server-snapshot" &&
    supportedTemporalRebaseProfileV1(scene) === 12 &&
    source.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    source.snapshotHash === WRITE_STUFF_V12_PROFILE.snapshotHash &&
    source.runtimeConfigHash === WRITE_STUFF_V12_PROFILE.runtimeConfigHash &&
    scene.duration === 4 &&
    scene.entities.length === 61 &&
    scene.animationChannels.length === 58 &&
    scene.requiredCapabilities.length === 4 &&
    scene.requiredCapabilities[0] === "cubic-path-geometry" &&
    scene.requiredCapabilities[1] === "logical-group" &&
    scene.requiredCapabilities[2] === "path-trim-animation" &&
    scene.requiredCapabilities[3] === "vector-appearance-animation" &&
    scene.camera.view.center.x === 0 &&
    scene.camera.view.center.y === 0 &&
    scene.camera.view.frameWidth === 14.222222222222221 &&
    scene.camera.view.frameHeight === 8 &&
    group?.id === runtimeIds.group &&
    group.geometry.kind === "group" &&
    group.parentId === null &&
    group.sceneOrder === 0 &&
    exampleText?.id === runtimeIds.exampleText &&
    exampleText.geometry.kind === "group" &&
    exampleText.parentId === group.id &&
    exampleText.sceneOrder === 1 &&
    exampleTex?.id === runtimeIds.exampleTex &&
    exampleTex.geometry.kind === "group" &&
    exampleTex.parentId === group.id &&
    exampleTex.sceneOrder === 32 &&
    scene.entities
      .slice(2, 32)
      .every(
        (entity, index) =>
          entity.sceneOrder === index + 2 &&
          entity.parentId === exampleText.id &&
          entity.geometry.kind === "cubic-path",
      ) &&
    scene.entities
      .slice(33)
      .every(
        (entity, index) =>
          entity.sceneOrder === index + 33 &&
          entity.parentId === exampleTex.id &&
          entity.geometry.kind === "cubic-path",
      )
  );
}

function genericRuntimeTraceSnapshotCorrelationIsExactV3(snapshot: StudioVerifiedPreviewSnapshotV1) {
  const { correlation, snapshot: bundle } = snapshot;
  const source = bundle.scene.source;
  return (
    source.kind === "imported-manim-runtime-trace" &&
    source.traceVersion === 3 &&
    sceneIrSourceRevisionHash(bundle.scene) === correlation.engineRevisionHash &&
    source.sourceHash === correlation.context.sourceHash &&
    bundle.assets.manifestDigest === correlation.assetsManifestDigest &&
    bundle.scene.sceneId === correlation.sceneId &&
    snapshot.sceneId === correlation.sceneId &&
    bundle.scene.duration === correlation.sceneDuration &&
    snapshot.duration === correlation.sceneDuration &&
    correlation.sceneDuration === correlation.context.sourceDuration &&
    correlation.context.workingRevision === PRISTINE_WORKING_REVISION
  );
}

/**
 * Projects every pristine generic V3 mapping into a future-authoring
 * candidate. Each candidate rechecks every fact it consumes, but does not
 * grant GUI or source-rewrite authority; that promotion belongs to the
 * generic lowerer. Updater-conflicted or degenerate mappings simply mint no
 * candidate, so their roots stay selection-only.
 */
export function studioPreviewGenericInitialEditAuthorityCandidatesV1(
  snapshot: StudioVerifiedPreviewSnapshotV1,
): readonly StudioPreviewGenericInitialEditAuthorityCandidateV1[] {
  if (!genericRuntimeTraceSnapshotCorrelationIsExactV3(snapshot)) return [];
  const identity = snapshot.sourceRuntimeIdentity;
  if (!identity || identity.size === 0) return [];
  const camera = snapshot.snapshot.scene.camera.view;
  if (
    !Number.isFinite(camera.frameHeight) ||
    !Number.isFinite(camera.frameWidth) ||
    camera.frameHeight <= 0 ||
    camera.frameWidth <= 0
  ) {
    return [];
  }
  const context = snapshot.correlation.context;
  // The provider enforces one-to-one source/runtime identity; a synthetic map
  // that aliases one runtime root under two names is never edit evidence.
  const mappedEntityIds = [...identity.values()].map(({ entityId }) => entityId);
  if (new Set(mappedEntityIds).size !== mappedEntityIds.length) return [];
  const candidates: StudioPreviewGenericInitialEditAuthorityCandidateV1[] = [];
  for (const [sourceName, mapping] of identity) {
    const evidence = mapping.runtimeTraceEvidence;
    if (mapping.sourceName !== sourceName || !evidence || evidence.updaterStatus !== "none") continue;
    const root = snapshot.snapshot.scene.entities.find(({ id }) => id === mapping.entityId);
    const lifetime = root?.lifetimes[0];
    if (
      !root ||
      root.parentId !== null ||
      root.geometry.kind !== "group" ||
      root.lifetimes.length !== 1 ||
      !lifetime ||
      lifetime.start !== 0 ||
      !Number.isFinite(lifetime.end) ||
      lifetime.end <= 0
    ) {
      continue;
    }
    const { initial, terminal } = evidence.endpoints;
    const terminalEndFrameValue = lifetime.end * FAST_MANIM_RUNTIME_TRACE_FRAME_RATE_V3;
    const terminalFrame = Math.round(terminalEndFrameValue) - 1;
    const finiteEndpoint = (endpoint: typeof initial) =>
      [
        endpoint.center.x,
        endpoint.center.y,
        endpoint.dimensions.height,
        endpoint.dimensions.width,
        endpoint.sampleTime,
      ].every(Number.isFinite) &&
      endpoint.dimensions.height > 0 &&
      endpoint.dimensions.width > 0;
    if (
      !finiteEndpoint(initial) ||
      !finiteEndpoint(terminal) ||
      initial.frameIndex !== 0 ||
      initial.sampleTime !== 0 ||
      terminalFrame < 0 ||
      Math.abs(terminalEndFrameValue - (terminalFrame + 1)) > Number.EPSILON * 64 * Math.max(1, terminalFrame + 1) ||
      terminal.frameIndex !== terminalFrame ||
      canonicalRuntimeTraceF64HexV3(terminal.sampleTime) !==
        canonicalRuntimeTraceF64HexV3(canonicalFastManimRuntimeTraceSampleTimeV3(terminalFrame))
    ) {
      continue;
    }
    // The gesture edits the settled object: `move_to`/`scale` act on the
    // constructed placement, observed by the terminal endpoint. An entrance
    // animation's partial frame-zero box is evidence-gated above but never
    // the manipulation anchor.
    candidates.push({
      baseCenter: scenePointToStudioPoint(
        terminal.center,
        { height: camera.frameHeight, width: camera.frameWidth },
        camera.center,
      ),
      baseDimensions: { ...terminal.dimensions },
      bindingId: mapping.bindingId,
      duration: snapshot.duration,
      lifetime: { end: lifetime.end, start: 0 },
      profile: "generic-runtime-trace-v3",
      runtimeEntityId: mapping.entityId,
      sourceName,
      studioEntityId: `source:${context.sourcePath}#${context.sceneName}:${sourceName}`,
      studioSceneId: `${context.sourcePath}#${context.sceneName}`,
    });
  }
  return candidates;
}

function genericInitialEditProgramV1(
  record: ProgramRecord,
  candidate: StudioPreviewGenericInitialEditAuthorityCandidateV1,
): StudioPreviewGenericInitialEditV1 | null {
  const program = record.program;
  const operation = program.operations[0];
  if (
    record.validation.status !== "valid" ||
    program.operations.length !== 1 ||
    !operation ||
    program.intentCount !== 1 ||
    program.loweringStatus !== "supported" ||
    program.provenance.origin !== "direct-manipulation" ||
    program.requestedExecution !== "parallel" ||
    program.schedule.mode !== "parallel" ||
    program.schedule.edges.length !== 0 ||
    program.schedule.order.length !== 1 ||
    program.schedule.order[0] !== operation.id ||
    program.anchor.capturedPlayhead !== 0 ||
    program.anchor.resolvedSeconds !== 0 ||
    !(
      (program.anchor.source.kind === "absolute" && program.anchor.source.seconds === 0) ||
      (program.anchor.source.kind === "playhead" && program.anchor.source.referenceSeconds === 0)
    ) ||
    !("entityId" in operation) ||
    operation.entityId !== candidate.studioEntityId ||
    operation.dependsOn.length !== 0 ||
    operation.interval.start !== 0 ||
    operation.interval.end !== 0 ||
    operation.provenance.origin !== "direct-manipulation"
  ) {
    return null;
  }
  if (operation.kind === "SetProperty" && operation.key === "position" && isFinitePoint(operation.value)) {
    return { kind: "move", position: { x: operation.value.x, y: operation.value.y } };
  }
  if (
    operation.kind === "AnimateProperty" &&
    operation.key === "scale" &&
    operation.control === undefined &&
    typeof operation.from === "number" &&
    typeof operation.to === "number" &&
    typeof operation.relativeFactor === "number" &&
    Number.isFinite(operation.from) &&
    Number.isFinite(operation.to) &&
    Number.isFinite(operation.relativeFactor) &&
    operation.from > 0 &&
    operation.to > 0 &&
    operation.relativeFactor > 0 &&
    // The server lowerer canonicalizes to twelve significant digits and
    // rejects the identity factor; mirror it so an authorized set never
    // carries a request the mutation authority is guaranteed to refuse.
    Number(operation.relativeFactor.toPrecision(12)) !== 1 &&
    closeEnough(operation.to / operation.from, operation.relativeFactor)
  ) {
    return { kind: "resize", scaleFactor: operation.relativeFactor };
  }
  return null;
}

/**
 * Browser-side capability gate for the one request #523/#510 may send to the
 * server. The one staged Program must target exactly one minted candidate;
 * it does not verify Python source authority; the fresh-source V3 lowerer
 * owns that decision and must reject independently.
 */
export function studioPreviewGenericInitialEditProgramSetV1(
  records: readonly ProgramRecord[],
  candidates: readonly StudioPreviewGenericInitialEditAuthorityCandidateV1[],
): StudioPreviewGenericInitialEditProgramSetV1 {
  if (records.length === 0) return { kind: "none" };
  if (records.length !== 1 || candidates.length === 0) return { kind: "unauthorized" };
  const record = records[0]!;
  const operation = record.program.operations[0];
  const targetEntityId = operation && "entityId" in operation ? operation.entityId : null;
  const matching = candidates.filter(({ studioEntityId }) => studioEntityId === targetEntityId);
  const candidate = matching[0];
  if (matching.length !== 1 || !candidate) return { kind: "unauthorized" };
  const edit = genericInitialEditProgramV1(record, candidate);
  return edit ? { candidate, edit, kind: "authorized" } : { kind: "unauthorized" };
}

/**
 * Browser-authoring authority for a pinned, unedited producer fixture. A
 * producer-backed reimport changes its source seal, so this cannot accidentally
 * open a second local edit against edited Python.
 */
export function studioPreviewInitialEditRuntimeAuthorityV1(
  snapshot: StudioVerifiedPreviewSnapshotV1,
): StudioPreviewInitialEditRuntimeAuthorityV1 | null {
  if (!snapshotCorrelationIsExact(snapshot)) return null;
  const { context } = snapshot.correlation;
  const source = snapshot.snapshot.scene.source;
  const identity = snapshot.sourceRuntimeIdentity;
  const square = identity?.get("square");
  if (
    source.kind === "imported-manim-server-snapshot" &&
    Number(source.snapshotVersion) === 8 &&
    source.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    context.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    context.sourcePath === "example_scenes/basic.py" &&
    context.sceneName === "SquareToCircle" &&
    identity?.size === 1 &&
    square?.sourceName === "square" &&
    isExactOfficialSquareToCircleV8(snapshot.snapshot.scene, square.entityId)
  ) {
    const target = snapshot.snapshot.scene.entities.find(({ id }) => id === square.entityId);
    const localCenter = target ? localBoundaryCenter(snapshot.snapshot.scene, target) : null;
    const sourceTransform = target && localCenter ? uniformSourceTransform(target, localCenter) : null;
    if (sourceTransform?.scale === 1) {
      return {
        baseCenter: scenePointToStudioPoint(
          sourceTransform.worldCenter,
          {
            height: snapshot.snapshot.scene.camera.view.frameHeight,
            width: snapshot.snapshot.scene.camera.view.frameWidth,
          },
          snapshot.snapshot.scene.camera.view.center,
        ),
        duration: 3,
        lifetime: { end: 3, start: 0 },
        profile: "square-to-circle-v8",
        relativeScale: 1,
        runtimeEntityId: square.entityId,
        studioEntityId: `source:${context.sourcePath}#${context.sceneName}:square`,
        studioSceneId: `${context.sourcePath}#${context.sceneName}`,
      };
    }
    return null;
  }
  if (
    source.kind === "imported-manim-server-snapshot" &&
    Number(source.snapshotVersion) === 12 &&
    source.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    context.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    context.sourcePath === "example_scenes/basic.py" &&
    context.sceneName === "WriteStuff" &&
    identity?.size === WRITE_STUFF_V12_PROFILE.sourceNames.length
  ) {
    const group = identity.get("group");
    const exampleText = identity.get("example_text");
    const exampleTex = identity.get("example_tex");
    if (
      group?.sourceName === "group" &&
      exampleText?.sourceName === "example_text" &&
      exampleTex?.sourceName === "example_tex" &&
      new Set([group.entityId, exampleText.entityId, exampleTex.entityId]).size ===
        WRITE_STUFF_V12_PROFILE.sourceNames.length &&
      isExactStableWriteStuffV12(snapshot.snapshot.scene, {
        exampleTex: exampleTex.entityId,
        exampleText: exampleText.entityId,
        group: group.entityId,
      })
    ) {
      const target = snapshot.snapshot.scene.entities.find(({ id }) => id === exampleTex.entityId);
      const localCenter = target ? localBoundaryCenter(snapshot.snapshot.scene, target) : null;
      const sourceTransform = target && localCenter ? uniformSourceTransform(target, localCenter) : null;
      if (sourceTransform?.scale === 1) {
        return {
          baseCenter: scenePointToStudioPoint(
            sourceTransform.worldCenter,
            {
              height: snapshot.snapshot.scene.camera.view.frameHeight,
              width: snapshot.snapshot.scene.camera.view.frameWidth,
            },
            snapshot.snapshot.scene.camera.view.center,
          ),
          duration: 4,
          lifetime: { end: 4, start: 0 },
          profile: "write-stuff-v12",
          relativeScale: 1,
          runtimeEntityId: exampleTex.entityId,
          studioEntityId: `source:${context.sourcePath}#${context.sceneName}:example_tex`,
          studioSceneId: `${context.sourcePath}#${context.sceneName}`,
        };
      }
    }
    return null;
  }
  if (
    source.kind === "imported-manim-server-snapshot" &&
    Number(source.snapshotVersion) === 10 &&
    source.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    context.sourceHash === OFFICIAL_BASIC_SOURCE_HASH &&
    context.sourcePath === "example_scenes/basic.py" &&
    context.sceneName === "LineJoints" &&
    identity?.size === LINE_JOINTS_V10_PROFILE.sourceNames.length
  ) {
    const grp = identity.get("grp");
    const t1 = identity.get("t1");
    const t2 = identity.get("t2");
    const t3 = identity.get("t3");
    if (
      grp?.sourceName === "grp" &&
      t1?.sourceName === "t1" &&
      t2?.sourceName === "t2" &&
      t3?.sourceName === "t3" &&
      new Set([grp.entityId, t1.entityId, t2.entityId, t3.entityId]).size ===
        LINE_JOINTS_V10_PROFILE.sourceNames.length &&
      isExactStableLineJointsV10(snapshot.snapshot.scene, {
        grp: grp.entityId,
        t1: t1.entityId,
        t2: t2.entityId,
        t3: t3.entityId,
      })
    ) {
      const target = snapshot.snapshot.scene.entities.find(({ id }) => id === t2.entityId);
      const localCenter = target ? localBoundaryCenter(snapshot.snapshot.scene, target) : null;
      const sourceTransform = target && localCenter ? uniformSourceTransform(target, localCenter) : null;
      if (sourceTransform?.scale === 1) {
        return {
          baseCenter: scenePointToStudioPoint(
            sourceTransform.worldCenter,
            {
              height: snapshot.snapshot.scene.camera.view.frameHeight,
              width: snapshot.snapshot.scene.camera.view.frameWidth,
            },
            snapshot.snapshot.scene.camera.view.center,
          ),
          duration: 1,
          lifetime: { end: 1, start: 0 },
          profile: "line-joints-v10",
          relativeScale: 1,
          runtimeEntityId: t2.entityId,
          studioEntityId: `source:${context.sourcePath}#${context.sceneName}:t2`,
          studioSceneId: `${context.sourcePath}#${context.sceneName}`,
        };
      }
    }
    return null;
  }
  const mapping = square;
  if (
    source.kind !== "imported-manim-server-snapshot" ||
    Number(source.snapshotVersion) !== 9 ||
    source.sourceHash !== OFFICIAL_BASIC_SOURCE_HASH ||
    context.sourceHash !== OFFICIAL_BASIC_SOURCE_HASH ||
    context.sourcePath !== "example_scenes/basic.py" ||
    context.sceneName !== "WarpSquare" ||
    identity?.size !== 1 ||
    !mapping ||
    mapping.sourceName !== "square" ||
    !isExactStableWarpSquareV9(snapshot.snapshot.scene, mapping.entityId)
  ) {
    return null;
  }
  return {
    duration: 4,
    profile: "warp-square-v9",
    runtimeEntityId: mapping.entityId,
    studioEntityId: `source:${context.sourcePath}#${context.sceneName}:square`,
    studioSceneId: `${context.sourcePath}#${context.sceneName}`,
  };
}

function studioInitialEditTargetMatches(
  entity: RuntimeSceneState["objectGraph"]["entities"][string] | ProjectedEntity | undefined,
  authority: StudioPreviewInitialEditProjectionAuthorityV1,
) {
  if (authority.profile === "generic-runtime-trace-v3") {
    return (
      entity?.id === authority.studioEntityId &&
      !entity.provisional &&
      entity.transactionId === undefined &&
      entity.sourceIdentity.kind === "known" &&
      entity.sourceIdentity.value === authority.sourceName
    );
  }
  const expected =
    authority.profile === "line-joints-v10"
      ? { name: "t2", type: "Triangle" }
      : authority.profile === "write-stuff-v12"
        ? { name: "example_tex", type: "MathTex" }
        : { name: "square", type: "Square" };
  return (
    entity?.id === authority.studioEntityId &&
    entity.type === expected.type &&
    !entity.provisional &&
    entity.transactionId === undefined &&
    entity.sourceIdentity.kind === "known" &&
    entity.sourceIdentity.value === expected.name
  );
}

/** Projects only the exact runtime-backed edit target into Studio's interaction UI. */
export function projectStudioPreviewInitialEntityPresenceV1(
  entities: readonly ProjectedEntity[],
  authority: StudioPreviewInitialEditProjectionAuthorityV1 | null,
  interactionGeometry: ReadonlyMap<string, unknown> | null,
  sampleTime: number,
) {
  const geometrylessSquareToCircleInitialTarget = authority?.profile === "square-to-circle-v8" && sampleTime === 0;
  if (
    !authority ||
    (!geometrylessSquareToCircleInitialTarget && !interactionGeometry?.has(authority.runtimeEntityId))
  ) {
    return entities;
  }
  if (authority.profile === "generic-runtime-trace-v3") {
    const target = entities.find(({ id }) => id === authority.studioEntityId);
    if (!target || !studioInitialEditTargetMatches(target, authority)) return entities;
    return entities.map((entity) =>
      entity.id === target.id
        ? {
            ...entity,
            geometry: {
              ...entity.geometry,
              position: { kind: "known" as const, value: authority.baseCenter },
            },
            position: authority.baseCenter,
            present: true,
          }
        : entity,
    );
  }
  if (authority.profile === "line-joints-v10" || authority.profile === "write-stuff-v12") {
    const target = entities.find(({ id }) => id === authority.studioEntityId);
    if (!target || !studioInitialEditTargetMatches(target, authority)) return entities;
    return entities.map((entity) =>
      entity.id === target.id
        ? {
            ...entity,
            geometry: {
              ...entity.geometry,
              position:
                entity.geometry.position.kind === "known"
                  ? entity.geometry.position
                  : { kind: "known" as const, value: authority.baseCenter },
              scale:
                entity.geometry.scale.kind === "known"
                  ? entity.geometry.scale
                  : { kind: "known" as const, value: authority.relativeScale },
            },
            position: entity.geometry.position.kind === "known" ? entity.position : authority.baseCenter,
            present: true,
            scale: entity.geometry.scale.kind === "known" ? entity.scale : authority.relativeScale,
          }
        : entity,
    );
  }
  if (authority.profile === "square-to-circle-v8") {
    const target = entities.find(({ id }) => id === authority.studioEntityId);
    if (!target || !studioInitialEditTargetMatches(target, authority) || target.present) return entities;
    return entities.map((entity) => (entity.id === target.id ? { ...entity, present: true } : entity));
  }
  if (entities.length !== 1) return entities;
  const [entity] = entities;
  if (!studioInitialEditTargetMatches(entity, authority) || entity.present) return entities;
  return [{ ...entity, present: true }];
}

/**
 * Supplies runtime-proven lifetime evidence only to validation of the exact
 * initial edit. The imported base remains untouched.
 */
export function projectStudioPreviewInitialValidationSceneV1(
  scene: RuntimeSceneState,
  authority: StudioPreviewInitialEditProjectionAuthorityV1 | null,
) {
  if (!authority || scene.duration !== authority.duration || scene.sceneId !== authority.studioSceneId) return scene;
  const entities = Object.values(scene.objectGraph.entities);
  if (authority.profile === "generic-runtime-trace-v3") {
    const target = scene.objectGraph.entities[authority.studioEntityId];
    if (!studioInitialEditTargetMatches(target, authority) || !target.geometry) return scene;
    const projectedTarget: RuntimeSceneState["objectGraph"]["entities"][string] = {
      ...target,
      geometry: {
        ...target.geometry,
        position: { kind: "known", value: authority.baseCenter },
      },
      lifetime: [authority.lifetime],
    };
    const propertyChannels = Object.fromEntries(
      Object.entries(scene.propertyChannels).map(([channelId, channel]) =>
        channel.entityId === target.id && channel.key === "position"
          ? [
              channelId,
              {
                ...channel,
                samples: channel.samples.map((sample) =>
                  sample.operationId
                    ? sample
                    : {
                        ...sample,
                        knowledge: { kind: "known" as const, value: authority.baseCenter },
                        value: authority.baseCenter,
                      },
                ),
              },
            ]
          : [channelId, channel],
      ),
    );
    return {
      ...scene,
      objectGraph: {
        ...scene.objectGraph,
        entities: { ...scene.objectGraph.entities, [target.id]: projectedTarget },
      },
      propertyChannels,
    };
  }
  if (authority.profile === "line-joints-v10" || authority.profile === "write-stuff-v12") {
    const target = scene.objectGraph.entities[authority.studioEntityId];
    if (!studioInitialEditTargetMatches(target, authority) || !target.geometry) return scene;
    const projectedTarget: RuntimeSceneState["objectGraph"]["entities"][string] = {
      ...target,
      geometry: {
        ...target.geometry,
        position:
          target.geometry.position.kind === "known"
            ? target.geometry.position
            : { kind: "known", value: authority.baseCenter },
        scale:
          target.geometry.scale.kind === "known"
            ? target.geometry.scale
            : { kind: "known", value: authority.relativeScale },
      },
      lifetime: [authority.lifetime],
    };
    const propertyChannels = Object.fromEntries(
      Object.entries(scene.propertyChannels).map(([channelId, channel]) => {
        if (channel.entityId !== target.id || (channel.key !== "position" && channel.key !== "scale")) {
          return [channelId, channel];
        }
        const value = channel.key === "position" ? authority.baseCenter : authority.relativeScale;
        return [
          channelId,
          {
            ...channel,
            samples: channel.samples.map((sample) =>
              sample.operationId ? sample : { ...sample, knowledge: { kind: "known" as const, value }, value },
            ),
          },
        ];
      }),
    );
    return {
      ...scene,
      objectGraph: {
        ...scene.objectGraph,
        entities: { ...scene.objectGraph.entities, [target.id]: projectedTarget },
      },
      propertyChannels,
    };
  }
  const [entity] = entities;
  if (entities.length !== 1 || !studioInitialEditTargetMatches(entity, authority)) return scene;
  if (entity.lifetime.length === 1 && entity.lifetime[0]?.start === 0 && entity.lifetime[0]?.end === 4) return scene;
  if (entity.lifetime.length !== 0) return scene;
  return {
    ...scene,
    objectGraph: {
      ...scene.objectGraph,
      entities: { ...scene.objectGraph.entities, [entity.id]: { ...entity, lifetime: [{ end: 4, start: 0 }] } },
    },
  };
}

export function studioPreviewInitialEditTargetIsPresentV1(
  scene: RuntimeSceneState,
  entityId: string,
  sourceTime: number,
  authority: StudioPreviewInitialEditProjectionAuthorityV1 | null,
) {
  const projected = sourceTime === 0 ? projectStudioPreviewInitialValidationSceneV1(scene, authority) : scene;
  return (
    projected.objectGraph.entities[entityId]?.lifetime.some(
      (interval) => sourceTime >= interval.start - 0.0005 && sourceTime < interval.end,
    ) ?? false
  );
}

/**
 * Returns the only synthetic authoring anchor accepted by the bounded V8-V10
 * preview profiles. This is preview authority, not a claim that the source
 * contains a lowerable `# poietra:anchor` marker.
 */
export function studioPreviewSyntheticInitialEditAnchorV1(snapshot: StudioVerifiedPreviewSnapshotV1) {
  if (studioPreviewInitialEditRuntimeAuthorityV1(snapshot)) return 0;
  if (studioPreviewGenericInitialEditAuthorityCandidatesV1(snapshot).length > 0) return 0;
  if (!snapshotCorrelationIsExact(snapshot)) return null;
  const identity = snapshot.sourceRuntimeIdentity;
  if (!identity || identity.size !== 1) return null;
  const mapping = identity.get("square");
  if (
    !mapping ||
    mapping.sourceName !== "square" ||
    !isExactStableSquareToCircleV8(snapshot.snapshot.scene, mapping.entityId)
  ) {
    return null;
  }
  return 0;
}

function snapshotCorrelationIsExact(snapshot: StudioVerifiedPreviewSnapshotV1) {
  const { correlation, snapshot: bundle } = snapshot;
  const source = bundle.scene.source;
  return (
    source.kind === "imported-manim-server-snapshot" &&
    supportedTemporalRebaseProfileV1(bundle.scene) !== null &&
    sceneIrSourceRevisionHash(bundle.scene) === correlation.engineRevisionHash &&
    source.sourceHash === correlation.context.sourceHash &&
    bundle.assets.manifestDigest === correlation.assetsManifestDigest &&
    bundle.scene.sceneId === correlation.sceneId &&
    snapshot.sceneId === correlation.sceneId &&
    bundle.scene.duration === correlation.sceneDuration &&
    snapshot.duration === correlation.sceneDuration &&
    correlation.sceneDuration === correlation.context.sourceDuration &&
    correlation.context.workingRevision === PRISTINE_WORKING_REVISION
  );
}

function applyTransform(point: Point, transform: SceneEntityV1["transform"]): Point {
  return {
    x: transform.m11 * point.x + transform.m12 * point.y + transform.tx,
    y: transform.m21 * point.x + transform.m22 * point.y + transform.ty,
  };
}

function localBoundaryCenter(scene: SceneIrV1, entity: SceneEntityV1) {
  const byId = new Map(scene.entities.map((candidate) => [candidate.id, candidate]));
  const points = scene.entities.flatMap((candidate) => {
    if (candidate.geometry.kind !== "cubic-path") return [];
    const transforms: SceneEntityV1["transform"][] = [];
    let cursor: SceneEntityV1 | undefined = candidate;
    const seen = new Set<string>();
    while (cursor.id !== entity.id) {
      if (seen.has(cursor.id)) return [];
      seen.add(cursor.id);
      transforms.push(cursor.transform);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
      if (!cursor) return [];
    }
    return candidate.geometry.path.subpaths.flatMap((subpath) =>
      [subpath.start, ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end])].map(
        (point) => transforms.reduce((transformed, transform) => applyTransform(transformed, transform), point),
      ),
    );
  });
  if (points.length === 0) return null;
  return {
    x: (Math.min(...points.map(({ x }) => x)) + Math.max(...points.map(({ x }) => x))) / 2,
    y: (Math.min(...points.map(({ y }) => y)) + Math.max(...points.map(({ y }) => y))) / 2,
  };
}

function uniformSourceTransform(entity: SceneEntityV1, localCenter: Point) {
  const { m11, m12, m21, m22, tx, ty } = entity.transform;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(m11), Math.abs(m22)) * 32;
  if (
    ![m11, m12, m21, m22, tx, ty].every(Number.isFinite) ||
    m11 <= 0 ||
    m12 !== 0 ||
    m21 !== 0 ||
    Math.abs(m11 - m22) > tolerance
  ) {
    return null;
  }
  const worldCenter = { x: m11 * localCenter.x + tx, y: m22 * localCenter.y + ty };
  return Number.isFinite(worldCenter.x) && Number.isFinite(worldCenter.y) ? { scale: m11, worldCenter } : null;
}

function studioPointToScenePoint(
  point: Point,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: Point,
) {
  return {
    x: cameraCenter.x + (point.x / STUDIO_VIEWPORT.width - 0.5) * frame.width,
    y: cameraCenter.y + (0.5 - point.y / STUDIO_VIEWPORT.height) * frame.height,
  };
}

function scenePointToStudioPoint(
  point: Point,
  frame: Readonly<{ height: number; width: number }>,
  cameraCenter: Point,
) {
  return {
    x: ((point.x - cameraCenter.x) / frame.width + 0.5) * STUDIO_VIEWPORT.width,
    y: (0.5 - (point.y - cameraCenter.y) / frame.height) * STUDIO_VIEWPORT.height,
  };
}

function operationIssueCode(
  kind: ProposedState["programs"][number]["program"]["operations"][number]["kind"],
): StudioPreviewTemporalRebaseIssueCodeV1 {
  if (kind === "ChangeCamera") return "camera-edit-unsupported";
  if (kind === "CreateMotion" || kind === "ModifyMotion") return "motion-path-edit-unsupported";
  if (kind === "InsertSceneBoundary" || kind === "InsertTimelineEvent" || kind === "TrimSceneDuration") {
    return "channel-timing-edit-unsupported";
  }
  if (kind === "ResizeEntity" || kind === "TransformContent") return "geometry-edit-unsupported";
  return "target-edit-unsupported";
}

function planInitialTransformEdit(
  input: Readonly<{
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
  }>,
):
  | Readonly<{ edit: AuthorizedEditV1; kind: "supported"; profile: SupportedTemporalRebaseProfileV1 }>
  | StudioPreviewTemporalRebaseResultV1 {
  const scene = input.snapshot.snapshot.scene;
  if (!snapshotCorrelationIsExact(input.snapshot)) {
    return unsupported(
      "source-correlation-invalid",
      "The verified temporal snapshot has inconsistent source authority.",
    );
  }
  const profile = supportedTemporalRebaseProfileV1(scene);
  if (profile === null) return unsupported("profile-unsupported", "The snapshot profile cannot be temporally rebased.");
  const initialEditAuthority =
    profile === 9 || profile === 10 || profile === 12
      ? studioPreviewInitialEditRuntimeAuthorityV1(input.snapshot)
      : null;
  if (input.proposedState.evaluatedScene.duration !== scene.duration) {
    return unsupported(
      "channel-timing-edit-unsupported",
      "Initial imported-animation edits cannot change Scene or channel timing.",
    );
  }
  const base = input.proposedState.base;
  const context = input.snapshot.correlation.context;
  const expectedStudioSceneId = `${context.sourcePath}#${context.sceneName}`;
  const expectedSourceHash = `sha256:${context.sourceHash}`;
  if (
    base.runtimeSceneState.duration !== scene.duration ||
    base.runtimeSceneState.sceneId !== expectedStudioSceneId ||
    base.editorContext.activeSceneId !== expectedStudioSceneId ||
    input.proposedState.evaluatedScene.sceneId !== expectedStudioSceneId ||
    base.sourceSnapshot.sourceId !== context.sourcePath ||
    base.sourceSnapshot.hash !== expectedSourceHash
  ) {
    return unsupported(
      "source-correlation-invalid",
      "Studio state is not correlated with the verified temporal Scene.",
    );
  }

  const identity = input.snapshot.sourceRuntimeIdentity;
  if (!identity || (profile !== 12 && identity.size !== scene.entities.length)) {
    return unsupported("identity-unverified", "Imported-animation edits require complete runtime identity.");
  }
  const runtimeEntities = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const verifiedRuntimeIds = new Set<string>();
  for (const [sourceName, mapping] of identity) {
    if (
      mapping.sourceName !== sourceName ||
      !runtimeEntities.has(mapping.entityId) ||
      verifiedRuntimeIds.has(mapping.entityId)
    ) {
      return unsupported("identity-unverified", "Temporal source/runtime identity is incomplete or ambiguous.");
    }
    verifiedRuntimeIds.add(mapping.entityId);
  }
  if (profile !== 12 && verifiedRuntimeIds.size !== runtimeEntities.size) {
    return unsupported("identity-unverified", "Temporal source/runtime identity does not cover every entity.");
  }
  const baseEntities = base.runtimeSceneState.objectGraph.entities;
  const evaluatedEntities = input.proposedState.evaluatedScene.objectGraph.entities;
  if (Object.keys(baseEntities).length !== Object.keys(evaluatedEntities).length) {
    return unsupported(
      "target-edit-unsupported",
      "Initial imported-animation edits cannot create, remove, or replace Studio-imported entities.",
    );
  }

  const mappedStudioRuntimeIds = new Set<string>();
  const studioToRuntime = new Map<string, string>();
  for (const entity of Object.values(evaluatedEntities)) {
    const baseEntity = baseEntities[entity.id];
    if (
      !baseEntity ||
      entity.provisional ||
      entity.transactionId !== undefined ||
      entity.type !== baseEntity.type ||
      entity.sourceIdentity.kind !== "known" ||
      baseEntity.sourceIdentity.kind !== "known" ||
      entity.sourceIdentity.value !== baseEntity.sourceIdentity.value
    ) {
      return unsupported("identity-unverified", "A temporal edit target has no stable imported identity.");
    }
    const mapping = identity.get(entity.sourceIdentity.value);
    // Static import may retain source-only transform targets (the `circle` in
    // SquareToCircle) that are not independent runtime entities. They may
    // remain in Studio's semantic graph, but any operation targeting one is
    // rejected below because it has no verified runtime mapping.
    if (!mapping) {
      const onlyRuntimeMapping = identity.values().next().value;
      const sourceOnlyV8TransformTarget =
        profile === 8 &&
        entity.type === "Circle" &&
        entity.sourceIdentity.value === "circle" &&
        onlyRuntimeMapping !== undefined &&
        isExactStableSquareToCircleV8(scene, onlyRuntimeMapping.entityId);
      if (sourceOnlyV8TransformTarget) continue;
      return unsupported("identity-unverified", "Temporal source/runtime identity is incomplete or ambiguous.");
    }
    if (
      mapping.sourceName !== entity.sourceIdentity.value ||
      !runtimeEntities.has(mapping.entityId) ||
      mappedStudioRuntimeIds.has(mapping.entityId)
    ) {
      return unsupported("identity-unverified", "Temporal source/runtime identity is incomplete or ambiguous.");
    }
    mappedStudioRuntimeIds.add(mapping.entityId);
    studioToRuntime.set(entity.id, mapping.entityId);
  }
  const channelsByEntity = new Map<string, SceneIrV1["animationChannels"]>();
  for (const channel of scene.animationChannels) {
    if (!("entityId" in channel)) {
      return unsupported("profile-unsupported", "Temporal preview does not admit camera animation channels.");
    }
    const supportedKind =
      profile === 7
        ? channel.kind === "path-trim" || channel.kind === "motion-path"
        : profile === 8
          ? channel.kind === "opacity" ||
            channel.kind === "path-morph" ||
            channel.kind === "vector-appearance" ||
            channel.kind === "path-trim"
          : profile === 9
            ? channel.kind === "path-morph"
            : profile === 12
              ? channel.kind === "path-trim" || channel.kind === "vector-appearance"
              : false;
    if (!supportedKind) {
      return unsupported("profile-unsupported", "Temporal preview found a channel outside its bounded profile.");
    }
    channelsByEntity.set(channel.entityId, [...(channelsByEntity.get(channel.entityId) ?? []), channel]);
  }

  let edit: AuthorizedEditV1 | null = null;
  const authorizedOperations = new Map<
    string,
    Readonly<{ key: "position" | "scale"; studioEntityId: string; value: Point | number }>
  >();
  for (const record of input.proposedState.programs) {
    const { program } = record;
    if (record.validation.status !== "valid") {
      return unsupported("conflicting-edit-unsupported", "Temporal preview cannot apply an invalid Program.");
    }
    if (program.anchor.resolvedSeconds !== 0 || program.anchor.capturedPlayhead !== 0) {
      return unsupported(
        "mid-animation-edit-unsupported",
        "Initial imported-animation edits must be captured and anchored at source time zero.",
      );
    }
    if (program.loweringStatus !== "supported") {
      return unsupported("target-edit-unsupported", "Temporal preview accepts only source-lowerable edits.");
    }
    for (const operation of program.operations) {
      if (operation.interval.start !== 0 || operation.interval.end !== 0) {
        return unsupported(
          "mid-animation-edit-unsupported",
          "Initial imported-animation edits must be instantaneous at source time zero.",
        );
      }
      if (authorizedOperations.has(operation.id)) {
        return unsupported("conflicting-edit-unsupported", "Temporal operation IDs must be unique.");
      }
      if (!("entityId" in operation)) {
        return unsupported(operationIssueCode(operation.kind), "The operation does not commute with imported time.");
      }
      const runtimeEntityId = studioToRuntime.get(operation.entityId);
      if (!runtimeEntityId) {
        return unsupported("identity-unverified", "An edited Studio entity has no verified runtime identity.");
      }
      if (edit && edit.runtimeEntityId !== runtimeEntityId) {
        return unsupported(
          "conflicting-edit-unsupported",
          "One temporal preview revision may edit one logical target.",
        );
      }
      const targetChannels = channelsByEntity.get(runtimeEntityId) ?? [];
      if (targetChannels.some(({ kind }) => kind === "motion-path")) {
        return unsupported(
          "motion-path-edit-unsupported",
          "Mixed V7 initial preview cannot edit a MoveAlongPath target or path.",
        );
      }
      const studioEntity = evaluatedEntities[operation.entityId];
      const staticMathTex = profile === 7 && studioEntity?.type === "MathTex" && targetChannels.length === 0;
      const createTarget = profile === 7 && targetChannels.length === 1 && isExactCreateChannel(targetChannels[0]!);
      const stableV8Target =
        profile === 8 &&
        studioEntity?.type === "Square" &&
        studioEntity.sourceIdentity.kind === "known" &&
        studioEntity.sourceIdentity.value === "square" &&
        isExactStableSquareToCircleV8(scene, runtimeEntityId);
      const stableV9Target =
        profile === 9 &&
        initialEditAuthority?.profile === "warp-square-v9" &&
        initialEditAuthority.runtimeEntityId === runtimeEntityId &&
        studioEntity?.type === "Square" &&
        studioEntity.sourceIdentity.kind === "known" &&
        studioEntity.sourceIdentity.value === "square" &&
        isExactStableWarpSquareV9(scene, runtimeEntityId);
      const stableV10Target =
        profile === 10 &&
        initialEditAuthority?.profile === "line-joints-v10" &&
        initialEditAuthority.runtimeEntityId === runtimeEntityId &&
        studioEntity?.type === "Triangle" &&
        studioEntity.sourceIdentity.kind === "known" &&
        studioEntity.sourceIdentity.value === "t2";
      const stableV12Target =
        profile === 12 &&
        initialEditAuthority?.profile === "write-stuff-v12" &&
        initialEditAuthority.runtimeEntityId === runtimeEntityId &&
        studioEntity?.type === "MathTex" &&
        studioEntity.sourceIdentity.kind === "known" &&
        studioEntity.sourceIdentity.value === "example_tex";
      const runtimeEntity = runtimeEntities.get(runtimeEntityId);
      if (
        (!staticMathTex &&
          !createTarget &&
          !stableV8Target &&
          !stableV9Target &&
          !stableV10Target &&
          !stableV12Target) ||
        (runtimeEntity?.geometry.kind !== "cubic-path" && !stableV12Target)
      ) {
        return unsupported(
          "target-edit-unsupported",
          "The temporal profile does not authorize this imported animation target.",
        );
      }
      const prior: AuthorizedEditV1 = edit ?? {
        operationIds: [],
        position: null,
        runtimeEntityId,
        scaleFactor: null,
      };
      if (operation.kind === "SetProperty" && operation.key === "position" && isFinitePoint(operation.value)) {
        if (prior.position) {
          return unsupported("conflicting-edit-unsupported", "One temporal target has conflicting position edits.");
        }
        edit = { ...prior, operationIds: [...prior.operationIds, operation.id], position: { ...operation.value } };
        authorizedOperations.set(operation.id, {
          key: "position",
          studioEntityId: operation.entityId,
          value: operation.value,
        });
        continue;
      }
      if (
        operation.kind === "AnimateProperty" &&
        operation.key === "scale" &&
        operation.control === undefined &&
        typeof operation.from === "number" &&
        typeof operation.to === "number" &&
        typeof operation.relativeFactor === "number" &&
        Number.isFinite(operation.from) &&
        Number.isFinite(operation.to) &&
        Number.isFinite(operation.relativeFactor) &&
        operation.from > 0 &&
        operation.to > 0 &&
        operation.relativeFactor > 0 &&
        closeEnough(operation.to / operation.from, operation.relativeFactor)
      ) {
        if (prior.scaleFactor !== null) {
          return unsupported("conflicting-edit-unsupported", "One temporal target has conflicting scale edits.");
        }
        edit = {
          ...prior,
          operationIds: [...prior.operationIds, operation.id],
          scaleFactor: operation.relativeFactor,
        };
        authorizedOperations.set(operation.id, {
          key: "scale",
          studioEntityId: operation.entityId,
          value: operation.to,
        });
        continue;
      }
      return unsupported(
        operationIssueCode(operation.kind),
        "Temporal preview accepts only finite position and positive uniform scale edits.",
      );
    }
  }
  if (!edit) {
    return unsupported("target-edit-unsupported", "Temporal preview found no supported edit.");
  }

  const observedOperations = new Map<string, number>();
  for (const channel of Object.values(input.proposedState.evaluatedScene.propertyChannels)) {
    for (const sample of channel.samples) {
      if (!sample.operationId) continue;
      const authorized = authorizedOperations.get(sample.operationId);
      const positionMatches =
        authorized?.key === "position" &&
        sample.kind === "exact" &&
        isFinitePoint(sample.value) &&
        isFinitePoint(authorized.value) &&
        closeEnough(sample.value.x, authorized.value.x) &&
        closeEnough(sample.value.y, authorized.value.y);
      const scaleMatches =
        authorized?.key === "scale" &&
        sample.kind === "animated" &&
        typeof sample.from === "number" &&
        typeof sample.value === "number" &&
        typeof authorized.value === "number" &&
        closeEnough(sample.value, authorized.value);
      if (
        !authorized ||
        authorized.studioEntityId !== channel.entityId ||
        authorized.key !== channel.key ||
        (!positionMatches && !scaleMatches)
      ) {
        return unsupported(
          "conflicting-edit-unsupported",
          "Evaluated temporal property evidence does not match its authorized operation value.",
        );
      }
      observedOperations.set(sample.operationId, (observedOperations.get(sample.operationId) ?? 0) + 1);
    }
  }
  if ([...authorizedOperations].some(([operationId]) => observedOperations.get(operationId) !== 1)) {
    return unsupported(
      "conflicting-edit-unsupported",
      "Temporal preview requires one evaluated property sample per authorized operation.",
    );
  }
  return { edit, kind: "supported", profile };
}

/**
 * Composes a uniform scale about a fixed center with an existing entity
 * transform, keeping the center's image invariant while every descendant
 * scales with the linear part.
 */
export function conjugateUniformScaleAboutCenterV1(
  transform: SceneEntityV1["transform"],
  center: Point,
  factor: number,
): SceneEntityV1["transform"] {
  return {
    m11: transform.m11 * factor,
    m12: transform.m12 * factor,
    m21: transform.m21 * factor,
    m22: transform.m22 * factor,
    tx: center.x + (transform.tx - center.x) * factor,
    ty: center.y + (transform.ty - center.y) * factor,
  };
}

/**
 * Reprojects one authorized t=0 move or uniform resize onto the verified
 * generic V3 hierarchy. The runtime root remains the geometry authority;
 * Studio only composes a top-level translation or a uniform scale about the
 * verified initial center and never reconstructs or flattens descendants.
 */
export function compileStudioPreviewGenericInitialEditV1(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    sourceRevisionHash: string;
  }>,
): StudioPreviewTemporalRebaseResultV1 {
  const candidates = studioPreviewGenericInitialEditAuthorityCandidatesV1(input.snapshot);
  if (candidates.length === 0) {
    return unsupported("source-correlation-invalid", "Generic Runtime Trace initial-edit evidence is unavailable.");
  }
  const scene = input.snapshot.snapshot.scene;
  const context = input.snapshot.correlation.context;
  const base = input.proposedState.base;
  const correlation = candidates[0]!;
  if (
    input.frame.width !== scene.camera.view.frameWidth ||
    input.frame.height !== scene.camera.view.frameHeight ||
    base.runtimeSceneState.sceneId !== correlation.studioSceneId ||
    base.runtimeSceneState.duration !== correlation.duration ||
    base.editorContext.activeSceneId !== correlation.studioSceneId ||
    base.sourceSnapshot.sourceId !== context.sourcePath ||
    base.sourceSnapshot.hash !== `sha256:${context.sourceHash}` ||
    input.proposedState.evaluatedScene.sceneId !== correlation.studioSceneId ||
    input.proposedState.evaluatedScene.duration !== correlation.duration
  ) {
    return unsupported(
      "source-correlation-invalid",
      "Studio state is not correlated with the generic Runtime Trace initial-edit evidence.",
    );
  }
  const programSet = studioPreviewGenericInitialEditProgramSetV1(input.proposedState.programs, candidates);
  if (programSet.kind !== "authorized") {
    return unsupported(
      "target-edit-unsupported",
      "Generic Runtime Trace permits exactly one initial position move or uniform resize.",
    );
  }
  const candidate = programSet.candidate;
  const targetIndex = scene.entities.findIndex(({ id }) => id === candidate.runtimeEntityId);
  const target = scene.entities[targetIndex];
  if (!target || target.parentId !== null || target.geometry.kind !== "group") {
    return unsupported("identity-unverified", "The generic Runtime Trace edit target is not its verified root group.");
  }
  const edit = programSet.edit;
  const baseCenter = studioPointToScenePoint(candidate.baseCenter, input.frame, scene.camera.view.center);
  let editedTransform: SceneEntityV1["transform"];
  if (edit.kind === "move") {
    const targetCenter = studioPointToScenePoint(edit.position, input.frame, scene.camera.view.center);
    const translation = { x: targetCenter.x - baseCenter.x, y: targetCenter.y - baseCenter.y };
    if (![translation.x, translation.y].every(Number.isFinite)) {
      return unsupported("geometry-edit-unsupported", "The generic Runtime Trace root translation is not finite.");
    }
    editedTransform = {
      ...target.transform,
      tx: target.transform.tx + translation.x,
      ty: target.transform.ty + translation.y,
    };
  } else {
    // Conjugate the uniform scale about the verified initial center so the
    // root keeps its placement while every descendant scales with it.
    editedTransform = conjugateUniformScaleAboutCenterV1(target.transform, baseCenter, edit.scaleFactor);
  }
  if (
    ![
      editedTransform.m11,
      editedTransform.m12,
      editedTransform.m21,
      editedTransform.m22,
      editedTransform.tx,
      editedTransform.ty,
    ].every(Number.isFinite)
  ) {
    return unsupported("geometry-edit-unsupported", "The generic Runtime Trace root transform is not finite.");
  }
  const provenanceId =
    edit.kind === "move"
      ? `studio-generic-v3-initial-move:${input.sourceRevisionHash}`
      : `studio-generic-v3-initial-resize:${input.sourceRevisionHash}`;
  if (scene.provenance.some(({ id }) => id === provenanceId)) {
    return unsupported("conflicting-edit-unsupported", "The generic initial-edit provenance identity already exists.");
  }
  const editedEntity: SceneEntityV1 = {
    ...target,
    provenanceId,
    transform: editedTransform,
  };
  const rebased: SceneIrV1 = {
    ...scene,
    entities: scene.entities.map((entity, index) => (index === targetIndex ? editedEntity : entity)),
    provenance: [
      ...scene.provenance,
      {
        evidence: [
          edit.kind === "move"
            ? "Studio t=0 position request projected onto one verified generic Runtime Trace V3 root"
            : "Studio t=0 uniform resize request projected onto one verified generic Runtime Trace V3 root",
          `source binding ${candidate.bindingId}`,
          `authorized operation ${input.proposedState.programs[0]!.program.operations[0]!.id}`,
        ],
        id: provenanceId,
        origin: "studio-edit-program",
      },
    ],
    source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: input.sourceRevisionHash },
  };
  const parsed = sceneIrV1Schema.safeParse(rebased);
  return parsed.success
    ? { kind: "rebased", scene: parsed.data }
    : unsupported(
        "conflicting-edit-unsupported",
        `The generic initial edit is not valid Scene IR: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
      );
}

/**
 * Rebase one bounded t=0 Studio transform directly onto a verified temporal
 * snapshot. The static Studio adapter is deliberately bypassed: untouched
 * dynamic semantic state is not reconstructed or flattened. For V9 this
 * affine result is a t=0 draft only; the renderer hook rejects later samples
 * until producer-backed reimport supplies the edited path-morph endpoint.
 */
export function compileStudioPreviewTemporalRebaseV1(
  input: Readonly<{
    frame: Readonly<{ height: number; width: number }>;
    proposedState: ProposedState;
    snapshot: StudioVerifiedPreviewSnapshotV1;
    sourceRevisionHash: string;
  }>,
): StudioPreviewTemporalRebaseResultV1 {
  const scene = input.snapshot.snapshot.scene;
  if (
    !Number.isFinite(input.frame.width) ||
    !Number.isFinite(input.frame.height) ||
    input.frame.width !== scene.camera.view.frameWidth ||
    input.frame.height !== scene.camera.view.frameHeight
  ) {
    return unsupported("camera-edit-unsupported", "Temporal rebase requires the exact verified camera frame.");
  }
  const initialEditAuthority = studioPreviewInitialEditRuntimeAuthorityV1(input.snapshot);
  const validationScene = projectStudioPreviewInitialValidationSceneV1(
    input.proposedState.base.runtimeSceneState,
    initialEditAuthority,
  );
  // The conservative Python importer cannot infer WarpSquare's lifetime from
  // ApplyPointwiseFunction. Direct manipulation validates against producer
  // evidence when the draft is created, but the normal workspace projection
  // intentionally revalidates every Program against the unmodified import.
  // Re-run that validation here with the same exact, snapshot-gated evidence
  // so the temporal compiler observes the operation it is about to authorize.
  const proposedState =
    validationScene === input.proposedState.base.runtimeSceneState
      ? input.proposedState
      : evaluateWorkingState({ ...input.proposedState.base, runtimeSceneState: validationScene });
  const planned = planInitialTransformEdit({ proposedState, snapshot: input.snapshot });
  if (planned.kind !== "supported") return planned;
  const { edit, profile } = planned;
  const targetIndex = scene.entities.findIndex(({ id }) => id === edit.runtimeEntityId);
  const target = scene.entities[targetIndex];
  const center = target ? localBoundaryCenter(scene, target) : null;
  if (!target || !center) {
    return unsupported("geometry-edit-unsupported", "The authorized temporal target has no bounded cubic geometry.");
  }
  const sourceTransform = uniformSourceTransform(target, center);
  if (!sourceTransform) {
    return unsupported(
      "profile-unsupported",
      "Verified temporal base entities must retain a finite positive uniform transform without rotation or shear.",
    );
  }
  const scale = sourceTransform.scale * (edit.scaleFactor ?? 1);
  const targetCenter = edit.position
    ? studioPointToScenePoint(edit.position, input.frame, scene.camera.view.center)
    : sourceTransform.worldCenter;
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(targetCenter.x) || !Number.isFinite(targetCenter.y)) {
    return unsupported("profile-unsupported", "The composed temporal transform is not finite and positive.");
  }
  const provenanceId = `studio-temporal-rebase:${input.sourceRevisionHash}`;
  if (scene.provenance.some(({ id }) => id === provenanceId)) {
    return unsupported(
      "conflicting-edit-unsupported",
      "The Studio temporal rebase provenance identity already exists.",
    );
  }
  const editedEntity: SceneEntityV1 = {
    ...target,
    provenanceId,
    transform: {
      m11: scale,
      m12: 0,
      m21: 0,
      m22: scale,
      tx: targetCenter.x - scale * center.x,
      ty: targetCenter.y - scale * center.y,
    },
  };
  const candidate: SceneIrV1 = {
    ...scene,
    entities: scene.entities.map((entity, index) => (index === targetIndex ? editedEntity : entity)),
    provenance: [
      ...scene.provenance,
      {
        evidence: [
          `Studio t=0 transform rebased onto verified snapshot V${profile} geometry`,
          ...edit.operationIds.map((operationId) => `authorized operation ${operationId}`),
        ],
        id: provenanceId,
        origin: "studio-edit-program",
      },
    ],
    source: { editProgramVersion: 1, kind: "studio-edit-program", revisionHash: input.sourceRevisionHash },
  };
  const parsed = sceneIrV1Schema.safeParse(candidate);
  if (!parsed.success) {
    return unsupported(
      "conflicting-edit-unsupported",
      `The temporal rebase is not valid Scene IR: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return { kind: "rebased", scene: candidate };
}
