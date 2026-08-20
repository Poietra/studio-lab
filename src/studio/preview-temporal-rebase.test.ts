import { describe, expect, it } from "vitest";
import { lowerVerifiedFastManimRuntimeTraceV3 } from "../../server/fast-manim-runtime-trace-v3-lowering";
import { fastManimRuntimeTraceV3Schema } from "../../server/fast-manim-runtime-trace-v3-result-contract";
import genericRuntimeTraceFixture from "../../server/test-fixtures/fast-manim-runtime-trace-v3-generic.json";
import type {
  ApplyStudioBoundEntityEditCompiler,
  ApplyStudioBoundEntityEditWireCommandV1,
} from "../engine/scene-authoring";
import { canonicalFastManimRuntimeTraceSampleTimeV3 } from "../render-pipeline/runtime-trace-v3-shared-contract";
import { programRecord } from "./evaluator";
import { type RuntimeEntity, type RuntimeSceneState, STUDIO_STATE_VERSION, type WorkingState } from "./model";
import {
  isStudioNativePreviewSceneIdentityV1,
  PRISTINE_WORKING_REVISION,
  type StudioVerifiedPreviewSnapshotV1,
} from "./preview-snapshot-provider";
import {
  compileStudioPreviewRuntimeTraceEdit,
  projectStudioPreviewRuntimeTraceEntityPresence,
  projectStudioPreviewRuntimeTraceValidationScene,
  studioPreviewRuntimeTraceEditAnchor,
  studioPreviewRuntimeTraceEditCandidates,
  studioPreviewRuntimeTraceEditTargetIsPresent,
} from "./preview-temporal-rebase";
import { createDirectManipulationPositionProgram } from "./suggestion-program";
import { compileStudioPreviewSceneV1 } from "./use-preview-renderer";

const FRAME = { height: 8, width: 14.222222222222221 } as const;
const VIEWPORT = { height: 360, width: 640 } as const;

function importedSquareEntity(id: string): RuntimeEntity {
  return {
    geometry: {
      dimensions: { kind: "known", value: { height: 2, width: 2 } },
      position: { kind: "known", value: { x: 320, y: 180 } },
      scale: { kind: "known", value: 1 },
      style: { kind: "known", value: {} },
    },
    id,
    lifetime: [{ end: 3, start: 0 }],
    provisional: false,
    sourceIdentity: { kind: "known", value: "square" },
    type: "Square",
  };
}

function workingState(scene: RuntimeSceneState, snapshot: StudioVerifiedPreviewSnapshotV1): WorkingState {
  const context = snapshot.correlation.context;
  if (isStudioNativePreviewSceneIdentityV1(context)) throw new Error("Runtime Trace fixtures require source identity.");
  return {
    appliedEdits: [],
    editorContext: {
      activeSceneId: scene.sceneId,
      playhead: 0,
      selection: Object.keys(scene.objectGraph.entities),
      version: STUDIO_STATE_VERSION,
      viewport: VIEWPORT,
    },
    runtimeSceneState: scene,
    sourceSnapshot: {
      configId: context.projectId,
      hash: `sha256:${context.sourceHash}`,
      sourceId: context.sourcePath,
      version: STUDIO_STATE_VERSION,
    },
    stagedEdits: [],
    staticSemanticState: { entities: [], unknowns: [], version: STUDIO_STATE_VERSION },
    version: STUDIO_STATE_VERSION,
  };
}

async function genericSnapshot(traceOverride?: ReturnType<typeof fastManimRuntimeTraceV3Schema.parse>) {
  const trace = traceOverride ?? fastManimRuntimeTraceV3Schema.parse(genericRuntimeTraceFixture);
  const bundle = await lowerVerifiedFastManimRuntimeTraceV3(trace);
  const source = bundle.scene.source;
  const mapping = trace.sourceBindings[0];
  if (source.kind !== "imported-manim-runtime-trace" || !mapping) {
    throw new Error("The generic Runtime Trace fixture lost its source-bound root.");
  }
  const snapshot: StudioVerifiedPreviewSnapshotV1 = {
    assetPayloads: [],
    correlation: {
      assetsManifestDigest: bundle.assets.manifestDigest,
      context: {
        projectId: trace.projectId,
        sceneName: trace.sceneName,
        sourceDuration: bundle.scene.duration,
        sourceHash: trace.sourceHash,
        sourcePath: trace.sourcePath,
        workingRevision: PRISTINE_WORKING_REVISION,
      },
      engineRevisionHash: source.traceDigest,
      sceneDuration: bundle.scene.duration,
      sceneId: bundle.scene.sceneId,
      serverPublicationRevision: null,
    },
    duration: bundle.scene.duration,
    sceneId: bundle.scene.sceneId,
    snapshot: bundle,
    sourceLabel: "verified Runtime Trace (preview-only)",
    sourceRuntimeIdentity: new Map(
      trace.sourceBindings.map((entry) => [
        entry.binding.name,
        {
          bindingId: entry.binding.id,
          entityId: entry.rootId,
          runtimeTraceEvidence: {
            endpoints: entry.endpoints,
            updaterStatus: entry.updaterStatus,
          },
          sourceName: entry.binding.name,
        },
      ]),
    ),
  };
  return { mapping, snapshot };
}

function withAdditionalSourceRoot(snapshot: StudioVerifiedPreviewSnapshotV1) {
  const [sourceName, mapping] = [...(snapshot.sourceRuntimeIdentity ?? [])][0] ?? [];
  const root = snapshot.snapshot.scene.entities.find(({ id }) => id === mapping?.entityId);
  if (!sourceName || !mapping?.runtimeTraceEvidence || !root) {
    throw new Error("The generic Runtime Trace fixture lost its source-bound root.");
  }
  const additionalSourceName = "circle";
  const additionalRootId = `${mapping.entityId}:second`;
  return {
    ...snapshot,
    snapshot: {
      ...snapshot.snapshot,
      scene: {
        ...snapshot.snapshot.scene,
        entities: [...snapshot.snapshot.scene.entities, { ...root, id: additionalRootId }],
      },
    },
    sourceRuntimeIdentity: new Map([
      ...(snapshot.sourceRuntimeIdentity ?? []),
      [
        additionalSourceName,
        {
          ...mapping,
          bindingId: `${mapping.bindingId}:second`,
          entityId: additionalRootId,
          sourceName: additionalSourceName,
        },
      ],
    ]),
  } satisfies StudioVerifiedPreviewSnapshotV1;
}

async function moveInput() {
  const { snapshot } = await genericSnapshot();
  const candidate = studioPreviewRuntimeTraceEditCandidates(snapshot, 0, [])[0];
  if (!candidate) throw new Error("The generic Runtime Trace fixture lost its construction candidate.");
  const entity = {
    ...importedSquareEntity(candidate.studioEntityId),
    lifetime: [candidate.entityProjection.lifetime],
  };
  const runtimeSceneState: RuntimeSceneState = {
    constraintGraph: { constraints: [] },
    duration: candidate.duration,
    eventTrack: { events: [] },
    objectGraph: { entities: { [entity.id]: entity }, lineage: [] },
    propertyChannels: {},
    provenanceGraph: { records: [] },
    sceneId: candidate.studioSceneId,
    version: STUDIO_STATE_VERSION,
  };
  const base = workingState(runtimeSceneState, snapshot);
  const validationScene = projectStudioPreviewRuntimeTraceValidationScene(runtimeSceneState, candidate);
  const validation = createDirectManipulationPositionProgram({
    capturedPlayhead: 0,
    delta: { x: 64, y: -36 },
    positions: { [candidate.studioEntityId]: candidate.baseCenter },
    scene: validationScene,
    start: 0,
    targetEntityIds: [candidate.studioEntityId],
    transactionId: "generic-v3-initial-move",
  });
  if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));
  const record = programRecord(validation.program, validation);
  return {
    base,
    candidate,
    record,
    snapshot,
    validationScene,
    workingState: { ...base, appliedEdits: [record] },
  };
}

describe("Runtime Trace endpoint candidate integration", () => {
  it("mints one construction candidate only from exact pristine source evidence", async () => {
    const { mapping, snapshot } = await genericSnapshot();
    const candidate = studioPreviewRuntimeTraceEditCandidates(snapshot, 0, [])[0];
    expect(candidate).toMatchObject({
      baseCenter: { x: 320, y: 180 },
      baseDimensions: mapping.endpoints.terminal.dimensions,
      bindingId: mapping.binding.id,
      capabilities: { paintOpacity: true, rotation: true, uniformScale: true },
      phase: "construction",
      runtimeEntityId: mapping.rootId,
      sourceAnchor: 0,
      targetSourceName: "square",
    });
  });

  it("fails closed at the compact source-evidence boundary", async () => {
    const { snapshot } = await genericSnapshot();
    const [sourceName, mapping] = [...(snapshot.sourceRuntimeIdentity ?? [])][0] ?? [];
    const evidence = mapping?.runtimeTraceEvidence;
    if (!sourceName || !mapping || !evidence) throw new Error("The generic mapping is missing.");
    const cases: readonly (readonly [string, StudioVerifiedPreviewSnapshotV1])[] = [
      [
        "stale correlation",
        {
          ...snapshot,
          correlation: { ...snapshot.correlation, engineRevisionHash: "0".repeat(64) },
        },
      ],
      [
        "updater conflict",
        {
          ...snapshot,
          sourceRuntimeIdentity: new Map([
            [
              sourceName,
              {
                ...mapping,
                runtimeTraceEvidence: { ...evidence, updaterStatus: "conflict" },
              },
            ],
          ]),
        },
      ],
      [
        "aliased root",
        {
          ...snapshot,
          sourceRuntimeIdentity: new Map([
            ...(snapshot.sourceRuntimeIdentity ?? []),
            ["alias", { ...mapping, bindingId: `${mapping.bindingId}:alias`, sourceName: "alias" }],
          ]),
        },
      ],
      [
        "non-root entity",
        {
          ...snapshot,
          snapshot: {
            ...snapshot.snapshot,
            scene: {
              ...snapshot.snapshot.scene,
              entities: snapshot.snapshot.scene.entities.map((entity) =>
                entity.id === mapping.entityId ? { ...entity, parentId: "synthetic-parent" } : entity,
              ),
            },
          },
        },
      ],
      [
        "degenerate endpoint",
        {
          ...snapshot,
          sourceRuntimeIdentity: new Map([
            [
              sourceName,
              {
                ...mapping,
                runtimeTraceEvidence: {
                  ...evidence,
                  endpoints: {
                    ...evidence.endpoints,
                    terminal: {
                      ...evidence.endpoints.terminal,
                      dimensions: { ...evidence.endpoints.terminal.dimensions, width: 0 },
                    },
                  },
                },
              },
            ],
          ]),
        },
      ],
    ];
    for (const [name, candidateSnapshot] of cases) {
      expect({ candidates: studioPreviewRuntimeTraceEditCandidates(candidateSnapshot, 0, []), name }).toEqual({
        candidates: [],
        name,
      });
    }
  });

  it("mints settled authority only inside its unique verified source wait", async () => {
    const { snapshot } = await genericSnapshot();
    const mapping = snapshot.sourceRuntimeIdentity?.get("square");
    if (!mapping?.runtimeTraceEvidence) throw new Error("The generic mapping lost endpoint evidence.");
    const settledAnchor = canonicalFastManimRuntimeTraceSampleTimeV3(1);
    const duration = 2 / 60;
    const settledSnapshot: StudioVerifiedPreviewSnapshotV1 = {
      ...snapshot,
      correlation: {
        ...snapshot.correlation,
        context: { ...snapshot.correlation.context, sourceDuration: duration },
        sceneDuration: duration,
      },
      duration,
      snapshot: {
        ...snapshot.snapshot,
        scene: {
          ...snapshot.snapshot.scene,
          duration,
          entities: snapshot.snapshot.scene.entities.map((entity) =>
            entity.id === mapping.entityId ? { ...entity, lifetimes: [{ end: duration, start: 0 }] } : entity,
          ),
        },
      },
      sourceRuntimeIdentity: new Map([
        [
          "square",
          {
            ...mapping,
            runtimeTraceEvidence: {
              ...mapping.runtimeTraceEvidence,
              endpoints: {
                ...mapping.runtimeTraceEvidence.endpoints,
                terminal: {
                  ...mapping.runtimeTraceEvidence.endpoints.terminal,
                  frameIndex: 1,
                  sampleTime: settledAnchor,
                },
              },
            },
          },
        ],
      ]),
    };
    const sourceEvents: RuntimeSceneState["eventTrack"]["events"] = [
      {
        id: "import:generic:wait:1",
        interval: { end: duration, start: settledAnchor },
        kind: "wait",
        label: "wait",
      },
    ];
    expect(
      studioPreviewRuntimeTraceEditCandidates(settledSnapshot, settledAnchor + 0.01, sourceEvents)[0],
    ).toMatchObject({
      capabilities: { paintOpacity: false, rotation: false, uniformScale: true },
      phase: "settled",
      sourceAnchor: settledAnchor,
    });
    expect(studioPreviewRuntimeTraceEditAnchor(settledSnapshot, settledAnchor + 0.01, sourceEvents)).toBe(
      settledAnchor,
    );
    expect(studioPreviewRuntimeTraceEditCandidates(settledSnapshot, settledAnchor + 0.01, [])).toEqual([]);
  });

  it("projects candidate-scoped interaction facts without mutating the imported base", async () => {
    const { candidate, validationScene } = await moveInput();
    const target = validationScene.objectGraph.entities[candidate.studioEntityId];
    if (!target?.geometry) throw new Error("The projected target is missing.");
    const projected = projectStudioPreviewRuntimeTraceEntityPresence(
      [
        {
          ...target,
          geometry: target.geometry,
          opacity: 1,
          position: { x: 0, y: 0 },
          present: false,
          scale: 1,
        },
      ],
      candidate,
      new Map([[candidate.runtimeEntityId, {}]]),
      0,
    );
    expect(projected[0]).toMatchObject({ position: candidate.baseCenter, present: true, scale: 1 });
    const scaleProjection = {
      from: 1,
      interval: { end: 5, start: 5 },
      kind: "uniform-scale",
      operationId: "scale",
      studioEntityId: candidate.studioEntityId,
      to: 2,
      transactionId: "scale",
    } as const;
    const scaleAt = (sampleTime: number) =>
      projectStudioPreviewRuntimeTraceEntityPresence(
        projected,
        candidate,
        new Map([[candidate.runtimeEntityId, {}]]),
        sampleTime,
        scaleProjection,
      )[0]?.scale;
    expect([scaleAt(4.9), scaleAt(5)]).toEqual([1, 2]);
    expect(studioPreviewRuntimeTraceEditTargetIsPresent(validationScene, candidate.studioEntityId, 0, candidate)).toBe(
      true,
    );
  });
});

describe("source-bound endpoint compilation", () => {
  it("forwards complete Programs and all verified candidates to one high-level Rust command", async () => {
    const { candidate, record, snapshot: singleRootSnapshot, workingState } = await moveInput();
    const snapshot = withAdditionalSourceRoot(singleRootSnapshot);
    const verifiedCandidates = studioPreviewRuntimeTraceEditCandidates(snapshot, 0, []);
    expect(verifiedCandidates.map(({ targetSourceName }) => targetSourceName)).toEqual(["square", "circle"]);
    const commands: ApplyStudioBoundEntityEditWireCommandV1[] = [];
    const projection = {
      interval: { end: 0, start: 0 },
      kind: "position",
      operationId: record.program.operations[0]!.id,
      studioEntityId: candidate.studioEntityId,
      transactionId: record.program.transactionId,
      value: { x: 384, y: 144 },
    } as const;
    const compiler: ApplyStudioBoundEntityEditCompiler = async (bundle, command) => {
      commands.push(command);
      return { bundle, projection };
    };
    const nextRevision = "b".repeat(64);
    const result = await compileStudioPreviewRuntimeTraceEdit({
      boundEntityEditCompiler: compiler,
      frame: FRAME,
      snapshot,
      sourceRevisionHash: nextRevision,
      workingState,
    });
    expect(result.kind).toBe("rebased");
    if (result.kind === "rebased") expect(result.result.projection).toEqual(projection);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.candidates).toEqual(
      verifiedCandidates.map((verifiedCandidate) => ({
        baseCenter: verifiedCandidate.baseCenter,
        baseOpacity: verifiedCandidate.baseOpacity,
        capabilities: verifiedCandidate.capabilities,
        evidenceId: verifiedCandidate.bindingId,
        phase: verifiedCandidate.phase,
        sceneEntityId: verifiedCandidate.runtimeEntityId,
        sourceAnchor: verifiedCandidate.sourceAnchor,
        studioEntityId: verifiedCandidate.studioEntityId,
      })),
    );
    expect(commands[0]).toMatchObject({
      expectedBaseRevision: snapshot.correlation.engineRevisionHash,
      nextRevision,
      programs: [
        {
          anchorCapturedPlayhead: 0,
          anchorResolvedSeconds: 0,
          anchorSource: { kind: "playhead", referenceSeconds: 0 },
          intentCount: 1,
          loweringSupported: true,
          operations: [
            {
              dependsOn: [],
              entityId: candidate.studioEntityId,
              id: record.program.operations[0]!.id,
              interval: { end: 0, start: 0 },
              kind: "move",
              origin: "direct-manipulation",
              position: { x: 384, y: 144 },
            },
          ],
          requestedExecution: "parallel",
          scheduleEdgeCount: 0,
          scheduleMode: "parallel",
        },
      ],
      schema: "poietra.apply-studio-bound-entity-edit",
      viewport: VIEWPORT,
    });

    const compiled = await compileStudioPreviewSceneV1({
      applyStudioBoundEntityEditCompiler: compiler,
      frame: FRAME,
      snapshot,
      workingState,
      workingRevision: "generic-v3-initial-move-revision",
      workspaceKey: "generic-preview/scenes/staticsquare.py/StaticSquare",
    });
    expect(compiled.kind).toBe("compiled");
    if (compiled.kind === "compiled") {
      expect(compiled.scene.boundEntityProjection).toEqual(projection);
      expect(compiled.scene.editAuthority).toBe("source-bound-endpoint");
    }
    const mismatched = await compileStudioPreviewSceneV1({
      applyStudioBoundEntityEditCompiler: async (bundle) => ({
        bundle,
        projection: { ...projection, value: { ...projection.value, x: projection.value.x + 1 } },
      }),
      frame: FRAME,
      snapshot,
      workingState,
      workingRevision: "generic-v3-mismatched-projection",
      workspaceKey: "generic-preview/scenes/staticsquare.py/StaticSquare",
    });
    expect(mismatched).toMatchObject({ kind: "unsupported" });
  });

  it("reports a core rejection without synthesizing a fallback Scene", async () => {
    const { snapshot, workingState } = await moveInput();
    const result = await compileStudioPreviewRuntimeTraceEdit({
      boundEntityEditCompiler: async () => {
        throw new Error("unsupported Program");
      },
      frame: FRAME,
      snapshot,
      sourceRevisionHash: "c".repeat(64),
      workingState,
    });
    expect(result).toEqual({
      issue: {
        code: "target-edit-unsupported",
        message: "Rust core rejected the source-bound endpoint edit: unsupported Program",
      },
      kind: "unsupported",
    });
  });
});
