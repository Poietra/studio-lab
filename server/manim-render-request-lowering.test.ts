import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ProgramRenderRequest } from "../src/render-pipeline/contracts";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { lowerManimRenderRequest } from "./manim-render-request-lowering";

const frame = { height: 8, width: 14.222 } as const;
const sourcePath = "scene.py";
const entityId = "source:scene.py#GroupedEquation:equation";
const sceneSource = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.add(equation)
        self.wait(5)
        # poietra:anchor 5.000
        self.wait(2)
        # poietra:anchor 7.000
        self.wait(1)
`;

const sceneSourceWithDestination = `${sceneSource}
class NextScene(Scene):
    def construct(self):
        title = Text("Next")
        self.add(title)
`;

function motionProgram(anchor: number, transactionId: string): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    controlOffset: { x: 0, y: 0 },
    delta: { x: 64, y: 0 },
    dependsOn: [],
    easing: "smooth",
    id: `tx:${transactionId}/operation:motion`,
    interval: { end: anchor + 1, start: anchor },
    kind: "CreateMotion",
    provenance: { evidence: [], origin: "direct-manipulation" },
    targetEntityIds: [entityId],
  };
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead", referenceSeconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function sceneBoundaryProgram(anchor: number, transactionId: string): CanonicalEditProgram {
  const operation: CanonicalEditOperation = {
    at: anchor,
    dependsOn: [],
    destination: "next-scene",
    id: `tx:${transactionId}/operation:scene-boundary`,
    interval: { end: anchor, start: anchor },
    kind: "InsertSceneBoundary",
    provenance: { evidence: [], origin: "direct-manipulation" },
  };
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead", referenceSeconds: anchor },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [operation],
    provenance: { evidence: [], origin: "direct-manipulation" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operation.id] },
    transactionId,
    version: 1,
  };
}

function request(program = motionProgram(7, "render-request-lowering")): ProgramRenderRequest {
  return {
    destination: null,
    program,
    projectId: "default",
    sceneName: "GroupedEquation",
    sourceBindings: [{ entityId, sourceVariable: "equation" }],
    sourceHash: createHash("sha256").update(sceneSource).digest("hex"),
    sourcePath,
    viewport: { height: 360, width: 640 },
  };
}

function lower(renderRequest: ProgramRenderRequest, originalSource = sceneSource) {
  return lowerManimRenderRequest({
    frame,
    originalSource,
    projectId: "default",
    request: renderRequest,
  });
}

describe("Manim render request lowering", () => {
  it("evaluates an out-of-order batch in source-anchor order without mutating the input", () => {
    const later = motionProgram(7, "batch-later");
    const earlier = motionProgram(5, "batch-earlier");
    const renderRequest: ProgramRenderRequest = {
      ...request(later),
      programs: [later, earlier],
    };

    const result = lower(renderRequest);

    expect(renderRequest.programs?.map((program) => program.transactionId)).toEqual(["batch-later", "batch-earlier"]);
    expect(result.renderRequest.program.transactionId).toBe("batch-earlier");
    expect(result.renderRequest.programs?.map((program) => program.transactionId)).toEqual([
      "batch-earlier",
      "batch-later",
    ]);
    expect(result.lowered.source.indexOf('poietra:transaction "batch-earlier"')).toBeLessThan(
      result.lowered.source.indexOf('poietra:transaction "batch-later"'),
    );
  });

  it("rejects a source binding that is not proven by the imported Scene", () => {
    const renderRequest: ProgramRenderRequest = {
      ...request(),
      sourceBindings: [{ entityId, sourceVariable: "other_equation" }],
    };

    expect(() => lower(renderRequest)).toThrow(
      expect.objectContaining({
        message: `Source target binding ${entityId} → other_equation does not match the imported Scene.`,
        status: 400,
      }),
    );
  });

  it("rejects a destination when the evaluated batch has no Scene boundary", () => {
    const renderRequest: ProgramRenderRequest = {
      ...request(),
      destination: { sceneName: "NextScene", sourcePath },
    };

    expect(() => lower(renderRequest)).toThrow(
      expect.objectContaining({
        message: "A render without a Scene boundary must not include a destination Scene.",
        status: 400,
      }),
    );
  });

  it("lowers a terminal Scene boundary into the next imported Scene", () => {
    const boundary = sceneBoundaryProgram(7, "next-scene-boundary");
    const renderRequest: ProgramRenderRequest = {
      ...request(boundary),
      destination: { sceneName: "NextScene", sourcePath },
      sourceHash: createHash("sha256").update(sceneSourceWithDestination).digest("hex"),
    };

    const result = lower(renderRequest, sceneSourceWithDestination);

    expect(result.renderRequest.destination).toEqual({ sceneName: "NextScene", sourcePath });
    expect(result.lowered.insertedCode).toContain(
      '# poietra:scene-boundary {"at":7,"destination":"scene.py#NextScene"}',
    );
    expect(result.lowered.insertedCode).toContain("# poietra:incoming-start");
    expect(result.lowered.insertedCode).toContain('title = Text("Next")');
    expect(result.lowered.insertedCode).toContain("return  # The imported next Scene now owns the composition.");
  });

  it("rejects a Scene-boundary Program before the end of a batch", () => {
    const later = motionProgram(7, "motion-after-boundary");
    const boundary = sceneBoundaryProgram(5, "non-terminal-boundary");
    const renderRequest: ProgramRenderRequest = {
      ...request(later),
      destination: { sceneName: "NextScene", sourcePath },
      programs: [later, boundary],
      sourceHash: createHash("sha256").update(sceneSourceWithDestination).digest("hex"),
    };

    expect(() => lower(renderRequest, sceneSourceWithDestination)).toThrow(
      expect.objectContaining({
        message: "A Scene-boundary Program must be the final Program in a render batch.",
        status: 400,
      }),
    );
  });

  it("maps source lowering failures to a client-facing HttpError", () => {
    const renderRequest = request(motionProgram(6, "missing-anchor"));

    expect(() => lower(renderRequest)).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/No # poietra:anchor 6\.000 .*marker exists/),
        status: 400,
      }),
    );
  });
});
