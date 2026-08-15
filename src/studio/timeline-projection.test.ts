import { describe, expect, it, vi } from "vitest";

import type { ProjectStudioTimelineCompiler, StudioTimelineProjectionV1 } from "../engine/scene-authoring";
import { type RuntimeSceneState, STUDIO_STATE_VERSION, type WorkingState } from "./model";
import { type CanonicalEditOperation, type CanonicalEditProgram, isSceneDurationOperation } from "./operations";
import {
  correlateTimelineProgramBatch,
  isSceneDurationProgram,
  isSceneDurationProgramBatch,
  normalizeTimelineProjectionCommand,
  projectLegacyTimelineProposedState,
  projectTimelineProgramBatch,
  sceneDurationTrimAvailabilityFromProjection,
  selectTimelineProgramBatchProjection,
  sourceTimeToWorkingTime,
  workingTimeToSourceTime,
} from "./timeline-projection";

function timelineProgram(transactionId: string, operation: CanonicalEditOperation, anchor = 5): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`absolute:${anchor}`],
      resolvedSeconds: anchor,
      source: { kind: "absolute", seconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [`program:${transactionId}`], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function waitProgram(transactionId: string, operationId: string, duration: number) {
  return timelineProgram(transactionId, {
    dependsOn: [],
    eventKind: "wait",
    id: operationId,
    interval: { end: 5 + duration, start: 5 },
    kind: "InsertTimelineEvent",
    label: "Extend Scene duration",
    provenance: { evidence: [`wait:${duration}`], origin: "studio-default" },
    purpose: "scene-duration",
  });
}

function trimProgram(waitOperationIds: readonly string[]) {
  return timelineProgram("trim-duration", {
    dependsOn: [],
    id: "trim-operation",
    interval: { end: 5, start: 5 },
    kind: "TrimSceneDuration",
    provenance: { evidence: ["trim:1"], origin: "studio-default" },
    removedDuration: 1,
    targetDuration: 12,
    waitOperationIds,
  });
}

const projection = {
  programProjections: [
    {
      operationId: "wait-one",
      transactionId: "wait-one-program",
      workingAnchor: 5,
      workingInterval: { end: 6, start: 5 },
    },
    {
      operationId: "wait-two",
      transactionId: "wait-two-program",
      workingAnchor: 6,
      workingInterval: { end: 8, start: 6 },
    },
    {
      operationId: "trim-operation",
      transactionId: "trim-duration",
      workingAnchor: 8,
      workingInterval: { end: 8, start: 8 },
    },
  ],
  projectedDuration: 12,
  transforms: [
    { interval: { end: 6, start: 5 }, kind: "insert", operationId: "wait-one" },
    { interval: { end: 8, start: 6 }, kind: "insert", operationId: "wait-two" },
    {
      interval: { end: 8, start: 7 },
      kind: "remove",
      operationId: "trim-operation",
      waitReductions: [{ operationId: "wait-two", removedDuration: 1 }],
    },
  ],
} as const satisfies StudioTimelineProjectionV1;

function sourcePrograms() {
  return [
    waitProgram("wait-one-program", "wait-one", 1),
    waitProgram("wait-two-program", "wait-two", 2),
    trimProgram(["wait-two", "wait-one"]),
  ] as const;
}

describe("Studio timeline projection adapter", () => {
  it("does not classify a zero-duration lifetime restore as a Scene duration Program", async () => {
    const restore = timelineProgram("restore-lifetime", {
      dependsOn: [],
      eventKind: "wait",
      id: "restore-lifetime-operation",
      interval: { end: 5, start: 5 },
      kind: "InsertTimelineEvent",
      label: "Restore imported lifetime",
      provenance: { evidence: [], origin: "direct-manipulation" },
    });
    const compiler = vi.fn<ProjectStudioTimelineCompiler>(async () => projection);

    expect(isSceneDurationOperation(restore.operations[0]!)).toBe(false);
    expect(isSceneDurationProgram(restore)).toBe(false);
    expect(isSceneDurationProgramBatch([restore])).toBe(false);
    await expect(projectTimelineProgramBatch(10, [restore], compiler)).rejects.toThrow(/Scene duration operation/i);
    expect(compiler).not.toHaveBeenCalled();
  });

  it("normalizes same-anchor waits and a trim, then trusts correlated Rust working intervals", async () => {
    const programs = sourcePrograms();
    const compiler = vi.fn<ProjectStudioTimelineCompiler>(async () => projection);

    const result = await projectTimelineProgramBatch(10, programs, compiler);

    expect(compiler).toHaveBeenCalledWith(normalizeTimelineProjectionCommand(10, programs));
    expect(compiler.mock.calls[0]![0].programs.map((program) => program.anchorResolvedSeconds)).toEqual([5, 5, 5]);
    expect(result.programs.map((program) => program.anchor.resolvedSeconds)).toEqual([5, 6, 8]);
    expect(result.programs.map((program) => program.operations[0].interval)).toEqual([
      { end: 6, start: 5 },
      { end: 8, start: 6 },
      { end: 8, start: 8 },
    ]);
    expect(result.programs[1]).toEqual({
      ...programs[1],
      anchor: { ...programs[1].anchor, resolvedSeconds: 6 },
      operations: [{ ...programs[1].operations[0], interval: { end: 8, start: 6 } }],
    });
    expect(correlateTimelineProgramBatch(programs, projection)).toEqual(result);
  });

  it("selects an execution prefix while preserving the requested Program order", () => {
    const programs = sourcePrograms();

    const result = selectTimelineProgramBatchProjection(10, [programs[1], programs[0]], projection);

    expect(result.programs.map((program) => program.operations[0].id)).toEqual(["wait-two", "wait-one"]);
    expect(result.projection.programProjections.map(({ operationId }) => operationId)).toEqual([
      "wait-two",
      "wait-one",
    ]);
    expect(result.projection.transforms.map(({ operationId }) => operationId)).toEqual(["wait-one", "wait-two"]);
    expect(result.projection.projectedDuration).toBe(13);
  });

  it("rejects a subset that omits transforms required by its execution context", () => {
    expect(() => selectTimelineProgramBatchProjection(10, [sourcePrograms()[2]], projection)).toThrow(
      /execution prefix/i,
    );
  });

  it.each([
    {
      label: "missing",
      projection: { ...projection, transforms: projection.transforms.slice(1) },
    },
    {
      label: "duplicate",
      projection: {
        ...projection,
        programProjections: [projection.programProjections[0], ...projection.programProjections],
      },
    },
  ])("rejects $label Rust correlations while selecting a subset", ({ projection: invalidProjection }) => {
    expect(() => selectTimelineProgramBatchProjection(10, [sourcePrograms()[0]], invalidProjection)).toThrow(
      /correlations/i,
    );
  });

  it("maps time in both directions using only Rust transform intervals", () => {
    expect(sourceTimeToWorkingTime(projection.transforms, 4)).toBe(4);
    expect(sourceTimeToWorkingTime(projection.transforms, 5)).toBe(7);
    expect(sourceTimeToWorkingTime(projection.transforms, 6)).toBe(8);
    expect(workingTimeToSourceTime(projection.transforms, 6.5)).toBe(5);
    expect(workingTimeToSourceTime(projection.transforms, 7)).toBe(5);
    expect(workingTimeToSourceTime(projection.transforms, 8)).toBe(6);
  });

  it("derives the remaining safe duration suffix from Rust transforms", () => {
    expect(sceneDurationTrimAvailabilityFromProjection(projection)).toEqual({
      anchor: 5,
      blocker: null,
      minimumDuration: 10,
      removableDuration: 2,
      waitOperationIds: ["wait-two", "wait-one"],
    });
  });

  it("keeps consumed wait IDs for admission but excludes them from trim availability", () => {
    expect(
      sceneDurationTrimAvailabilityFromProjection({
        programProjections: [],
        projectedDuration: 11,
        transforms: [
          { interval: { end: 6, start: 5 }, kind: "insert", operationId: "consumed-wait" },
          {
            interval: { end: 6, start: 5 },
            kind: "remove",
            operationId: "consume-wait",
            waitReductions: [{ operationId: "consumed-wait", removedDuration: 1 }],
          },
          { interval: { end: 8, start: 7 }, kind: "insert", operationId: "active-wait" },
        ],
      }),
    ).toEqual({
      anchor: 7,
      blocker: null,
      minimumDuration: 10,
      removableDuration: 1,
      waitOperationIds: ["active-wait", "consumed-wait"],
    });
  });

  it("rejects mixed timeline and non-timeline operation families before calling Rust", async () => {
    const move = timelineProgram("move-program", {
      dependsOn: [],
      entityId: "equation",
      id: "move-operation",
      interval: { end: 5, start: 5 },
      key: "position",
      kind: "SetProperty",
      provenance: { evidence: [], origin: "studio-default" },
      value: { x: 1, y: 2 },
    });
    const compiler = vi.fn<ProjectStudioTimelineCompiler>(async () => projection);

    await expect(projectTimelineProgramBatch(10, [sourcePrograms()[0], move], compiler)).rejects.toThrow(
      /must not mix Scene duration and other operation families/i,
    );
    expect(compiler).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "result count",
      projection: { ...projection, programProjections: projection.programProjections.slice(0, 2) },
    },
    {
      label: "operation identity",
      projection: {
        ...projection,
        programProjections: [
          { ...projection.programProjections[0], operationId: "different-operation" },
          ...projection.programProjections.slice(1),
        ],
      },
    },
  ])("rejects a Rust projection with mismatched $label", async ({ projection: mismatched }) => {
    const compiler: ProjectStudioTimelineCompiler = async () => mismatched;
    await expect(projectTimelineProgramBatch(10, sourcePrograms(), compiler)).rejects.toThrow(/correlat/i);
  });

  it("projects the legacy RuntimeSceneState view from Rust transforms and projected intervals", async () => {
    const programs = sourcePrograms();
    const projected = await projectTimelineProgramBatch(10, programs, async () => projection);
    const scene: RuntimeSceneState = {
      constraintGraph: { constraints: [] },
      duration: 10,
      eventTrack: {
        events: [
          { id: "base-span", interval: { end: 6, start: 4 }, kind: "play", label: "Base span" },
          { at: 8, id: "base-point", kind: "scene-boundary", label: "Base point" },
        ],
      },
      objectGraph: {
        entities: {
          equation: {
            id: "equation",
            lifetime: [{ end: 10, start: 0 }],
            provisional: false,
            sourceIdentity: { kind: "known", value: "equation" },
            type: "MathTex",
          },
        },
        lineage: [{ at: 8, from: "before", operationId: "base-lineage", relation: "replaces", to: "equation" }],
      },
      propertyChannels: {
        "equation/position": {
          entityId: "equation",
          key: "position",
          samples: [
            {
              interval: { end: 8, start: 6 },
              kind: "animated",
              provenanceId: "base-position",
              value: { x: 1, y: 0 },
            },
          ],
        },
      },
      provenanceGraph: {
        records: [{ evidence: [], id: "base-provenance", origin: "import" }],
      },
      sceneId: "scene",
      version: STUDIO_STATE_VERSION,
    };
    const records = programs.map((program) => ({
      program,
      validation: { issues: [], status: "valid" as const },
    }));
    const workingState: WorkingState = {
      appliedPrograms: records,
      editorContext: {
        activeSceneId: "scene",
        playhead: 5,
        selection: [],
        version: STUDIO_STATE_VERSION,
        viewport: { height: 360, width: 640 },
      },
      runtimeSceneState: scene,
      sourceSnapshot: {
        configId: "fixture",
        hash: `sha256:${"0".repeat(64)}`,
        sourceId: "scene.py",
        version: STUDIO_STATE_VERSION,
      },
      stagedPrograms: [],
      staticSemanticState: { entities: [], unknowns: [], version: STUDIO_STATE_VERSION },
      version: STUDIO_STATE_VERSION,
    };

    const proposed = projectLegacyTimelineProposedState(workingState, projected);

    expect(proposed.evaluatedScene.duration).toBe(12);
    expect(proposed.evaluatedScene.objectGraph.entities.equation?.lifetime).toEqual([{ end: 12, start: 0 }]);
    expect(proposed.evaluatedScene.eventTrack.events.find(({ id }) => id === "base-span")?.interval).toEqual({
      end: 8,
      start: 4,
    });
    expect(proposed.evaluatedScene.eventTrack.events.find(({ id }) => id === "base-point")?.at).toBe(10);
    expect(proposed.evaluatedScene.objectGraph.lineage[0]?.at).toBe(10);
    expect(proposed.evaluatedScene.propertyChannels["equation/position"]?.samples[0]?.interval).toEqual({
      end: 10,
      start: 8,
    });
    expect(proposed.evaluatedScene.eventTrack.events.find(({ id }) => id === "wait-one/timeline")?.interval).toEqual({
      end: 6,
      start: 5,
    });
    expect(proposed.evaluatedScene.eventTrack.events.find(({ id }) => id === "wait-two/timeline")?.interval).toEqual({
      end: 7,
      start: 6,
    });
    expect(proposed.evaluatedScene.eventTrack.events.find(({ id }) => id === "trim-operation/event")?.interval).toEqual(
      { end: 7, start: 7 },
    );
    expect(proposed.evaluatedScene.provenanceGraph.records.map(({ id }) => id)).toEqual([
      "base-provenance",
      "wait-one/provenance",
      "wait-two/provenance",
      "trim-operation/provenance",
    ]);
    expect(proposed.programs.every(({ validation }) => validation.status === "valid")).toBe(true);
  });
});
