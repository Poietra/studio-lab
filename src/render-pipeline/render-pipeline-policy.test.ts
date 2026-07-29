import { describe, expect, it } from "vitest";

import type { CanonicalEditProgram } from "../studio/operations";
import { renderProgramBatchId, renderRequestId, type ManimWorkspaceView, type RenderSessionView } from "./contracts";
import {
  renderCandidateRequest,
  renderPipelineActionBlocker,
  renderSessionMatchesCandidate,
  renderSourceMutationOutcome,
  renderSourceRefreshMatches,
  renderSourceRefreshResolved,
  renderSourceRefreshTarget,
  resolveRenderPipelinePolicy,
  type RenderProgramCandidate,
} from "./render-pipeline-policy";

function program(deltaX = 64): CanonicalEditProgram {
  const operation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: deltaX, y: 0 },
    dependsOn: [],
    easing: "smooth" as const,
    id: "tx/operation:motion",
    interval: { end: 2, start: 1 },
    kind: "CreateMotion" as const,
    provenance: { evidence: [], origin: "direct-manipulation" as const },
    targetEntityIds: ["equation"],
  };
  return {
    anchor: {
      capturedPlayhead: 1,
      evidence: [],
      resolvedSeconds: 1,
      source: { kind: "playhead", referenceSeconds: 1 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId: "same-transaction",
    version: 1,
  };
}

function candidate(overrides: Partial<RenderProgramCandidate> = {}): RenderProgramCandidate {
  const candidateProgram = program();
  return {
    anchors: [1],
    destination: null,
    program: candidateProgram,
    programs: [candidateProgram],
    projectId: "project-a",
    sceneName: "SceneOne",
    sourceBindings: [{ entityId: "equation", sourceVariable: "equation" }],
    sourceHash: "a".repeat(64),
    sourcePath: "scene.py",
    viewport: { height: 360, width: 640 },
    ...overrides,
  };
}

function session(target: RenderProgramCandidate, overrides: Partial<RenderSessionView> = {}): RenderSessionView {
  return {
    actionInProgress: false,
    canCancel: false,
    canCommit: true,
    canDiscard: true,
    canUndo: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    error: null,
    failureCode: null,
    id: "render-id",
    logTail: "done",
    patch: {
      anchorLine: 4,
      anchorLines: [4],
      insertedCode: "self.wait(1)",
      patchedSourceHash: "c".repeat(64),
      sourceHash: target.sourceHash,
    },
    programBatchId: renderProgramBatchId(target.programs),
    programTransactionId: target.program.transactionId,
    progress: 1,
    projectId: target.projectId,
    renderRequestId: renderRequestId(renderCandidateRequest(target)),
    sceneName: target.sceneName,
    sourceAction: null,
    sourcePath: target.sourcePath,
    status: "ready",
    updatedAt: "2026-01-01T00:00:01.000Z",
    videoUrl: "/api/manim/renders/render-id/video",
    ...overrides,
  };
}

function policy(
  target: RenderProgramCandidate | null,
  rendered: RenderSessionView | null,
  lifecycleBlocker: string | null = null,
) {
  return resolveRenderPipelinePolicy({
    candidate: target,
    candidateBlocker: target ? null : "Create a Canonical draft first.",
    candidateLifecycleBlocker: lifecycleBlocker,
    commandAvailable: true,
    originalExportBlocker: null,
    session: rendered,
  });
}

describe("render pipeline lifecycle policy", () => {
  it("allows Commit only for the exact current rendered candidate", () => {
    const target = candidate();
    const resolved = policy(target, session(target));

    expect(resolved).toMatchObject({
      commitBlocker: null,
      exportBlocker: null,
      previewBlocker: null,
      sessionMatchesCandidate: true,
    });
  });

  it("blocks candidate Render, Export, and Commit during a timing conflict without blocking recovery actions", () => {
    const target = candidate();
    const blocker = "Resolve verified Scene timing before continuing.";
    const resolved = policy(target, session(target), blocker);

    expect(renderPipelineActionBlocker("render", resolved)).toBe(blocker);
    expect(renderPipelineActionBlocker("export", resolved)).toBe(blocker);
    expect(renderPipelineActionBlocker("commit", resolved)).toBe(blocker);
    expect(renderPipelineActionBlocker("cancel", resolved)).toBeNull();
    expect(renderPipelineActionBlocker("discard", resolved)).toBeNull();
    expect(renderPipelineActionBlocker("undo", resolved)).toBeNull();
  });

  it("keeps original source Export available while verified timing loads", () => {
    const resolved = policy(null, null, "Wait for verified Scene timing.");

    expect(renderPipelineActionBlocker("export", resolved)).toBeNull();
    expect(renderPipelineActionBlocker("render", resolved)).not.toBeNull();
  });

  it("rejects an old session after a same-transaction Program edit", () => {
    const original = candidate();
    const editedProgram = program(96);
    const edited = candidate({ program: editedProgram, programs: [editedProgram] });
    const rendered = session(original);

    expect(renderProgramBatchId(edited.programs)).not.toBe(rendered.programBatchId);
    expect(renderSessionMatchesCandidate(rendered, edited)).toBe(false);
    expect(policy(edited, rendered).commitBlocker).toMatch(/no longer matches/i);
  });

  it("fingerprints the canonical wire Program rather than client-only fields", () => {
    const canonical = program();
    const clientRecord = { ...canonical, editorOnly: "ignored by the render contract" } as CanonicalEditProgram;

    expect(renderProgramBatchId([clientRecord])).toBe(renderProgramBatchId([canonical]));
  });

  it.each([
    ["missing candidate", null],
    ["different source", candidate({ sourceHash: "b".repeat(64) })],
    ["different project", candidate({ projectId: "project-b" })],
    ["different Scene", candidate({ sceneName: "SceneTwo" })],
    ["different path", candidate({ sourcePath: "other.py" })],
    ["different source binding", candidate({ sourceBindings: [{ entityId: "equation", sourceVariable: "other" }] })],
    ["different viewport", candidate({ viewport: { height: 720, width: 1280 } })],
    ["different destination", candidate({ destination: { sceneName: "SceneTwo", sourcePath: "scene.py" } })],
  ])("rejects a ready session with a %s", (_label, currentCandidate) => {
    const renderedCandidate = candidate();
    const rendered = session(renderedCandidate);

    expect(renderSessionMatchesCandidate(rendered, currentCandidate)).toBe(false);
    expect(policy(currentCandidate, rendered).commitBlocker).not.toBeNull();
  });
});

describe("render source refresh correlation", () => {
  it("uses the pre-mutation source revision for Commit and Undo refreshes", () => {
    const rendered = session(candidate());

    expect(renderSourceRefreshTarget(rendered, "committed")).toMatchObject({
      resultSourceHash: rendered.patch.patchedSourceHash,
      sourceHash: rendered.patch.sourceHash,
    });
    expect(renderSourceRefreshTarget(rendered, "undone")).toMatchObject({
      resultSourceHash: rendered.patch.sourceHash,
      sourceHash: rendered.patch.patchedSourceHash,
    });
  });

  it.each([
    ["ready", "committed", "committed"],
    ["committed", "undone", "undone"],
    ["ready", "undone", null],
    ["committed", "committed", null],
  ] as const)("maps a %s to %s session transition to %s", (previousStatus, nextStatus, outcome) => {
    expect(renderSourceMutationOutcome(previousStatus, nextStatus)).toBe(outcome);
  });

  it.each([
    ["another project", { projectId: "project-b" }],
    ["another Scene", { sceneName: "SceneTwo" }],
    ["another source revision", { sourceHash: "b".repeat(64) }],
    ["another source path", { sourcePath: "other.py" }],
  ])("does not target the active editor for %s", (_label, override) => {
    const rendered = session(candidate());
    const target = renderSourceRefreshTarget(rendered, "committed");

    expect(renderSourceRefreshMatches(target, { ...target, ...override })).toBe(false);
  });

  it("targets only the exact active source identity", () => {
    const rendered = session(candidate());
    const target = renderSourceRefreshTarget(rendered, "committed");

    expect(renderSourceRefreshMatches(target, target)).toBe(true);
    expect(renderSourceRefreshMatches(target, null)).toBe(false);
  });

  it("resolves only after workspace import observes the post-mutation revision", () => {
    const rendered = session(candidate());
    const target = renderSourceRefreshTarget(rendered, "committed");
    const workspace = {
      commandAvailable: true,
      frame: { height: 8, width: 14.222 },
      projectId: target.projectId,
      projectName: "Project A",
      sources: [
        {
          path: target.sourcePath,
          scenes: [
            {
              anchors: [],
              name: target.sceneName,
              nextSceneId: null,
              runtimeSceneState: { duration: 1, eventTrack: { events: [] }, objectGraph: { entities: {} } },
              sceneId: `${target.sourcePath}#${target.sceneName}`,
              sourceHash: target.resultSourceHash,
              sourceVariables: {},
              staticSemanticState: { entities: {}, knowledge: "complete" },
            },
          ],
        },
      ],
    } as unknown as ManimWorkspaceView;

    expect(renderSourceRefreshResolved(target, workspace)).toBe(true);
    expect(
      renderSourceRefreshResolved(target, {
        ...workspace,
        sources: [
          {
            ...workspace.sources[0],
            scenes: [{ ...workspace.sources[0].scenes[0], sourceHash: target.sourceHash }],
          },
        ],
      }),
    ).toBe(false);
  });
});
