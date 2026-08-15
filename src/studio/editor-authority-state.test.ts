import { describe, expect, it } from "vitest";

import type { ProjectStudioTimelineCompiler } from "../engine/scene-authoring";
import { importManimScene } from "../render-pipeline/source-import";
import {
  EditorTimelineAdmissionError,
  editorProgramsMatchAuthorityV1,
  materializeAuthoritativeEditorProgramsV1,
} from "./editor-authority-state";
import type { EditorProgramRecord } from "./editor-session-store";
import type { CanonicalEditProgram } from "./operations";

const source = `from manim import *

class Demo(Scene):
    def construct(self):
        label = Text("Demo")
        self.add(label)
        self.wait(5)
`;

function scene() {
  const imported = importManimScene(source, "scene.py", "Demo");
  if (!imported) throw new Error("fixture import failed");
  return { ...imported, name: "Demo", nextSceneId: null, sourcePath: "scene.py" };
}

function program(label = "wait"): CanonicalEditProgram {
  return {
    anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        eventKind: "wait",
        id: "shared/wait",
        interval: { end: 2, start: 1 },
        kind: "InsertTimelineEvent",
        label,
        provenance: { evidence: [], origin: "studio-default" },
        purpose: "scene-duration",
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: ["shared/wait"] },
    transactionId: "shared",
    version: 1,
  };
}

const acceptTimeline: ProjectStudioTimelineCompiler = async (command) => {
  const program = command.programs[0]!;
  const operation = program.operations[0]!;
  return {
    programProjections: [
      {
        operationId: operation.id,
        transactionId: program.transactionId,
        workingAnchor: program.anchorResolvedSeconds,
        workingInterval: operation.interval,
      },
    ],
    projectedDuration: command.baseDuration + (operation.interval.end - operation.interval.start),
    transforms: [{ interval: operation.interval, kind: "insert", operationId: operation.id }],
  };
};

describe("authoritative Editor Program materialization", () => {
  it("compares accepted local state to the exact authoritative projection", () => {
    const exact = program();
    const local: EditorProgramRecord = {
      program: exact,
      validation: { issues: [], status: "valid" },
    };

    expect(editorProgramsMatchAuthorityV1([local], [exact])).toBe(true);
    expect(editorProgramsMatchAuthorityV1([local], [program("remote spelling")])).toBe(false);
  });

  it("preserves local authoring metadata only for an exact canonical match", async () => {
    const exact = program();
    const local: EditorProgramRecord = {
      editorMetadata: { operation: null, selection: ["label"] },
      program: exact,
      validation: { issues: [], status: "valid" },
    };

    const preserved = await materializeAuthoritativeEditorProgramsV1(scene(), [local], [exact], acceptTimeline);
    const replaced = await materializeAuthoritativeEditorProgramsV1(
      scene(),
      [local],
      [program("remote spelling")],
      acceptTimeline,
    );

    expect(preserved[0]?.editorMetadata).toEqual(local.editorMetadata);
    expect(replaced[0]?.editorMetadata).toBeUndefined();
    expect(replaced[0]?.validation.status).toBe("valid");
  });

  it("rejects a structurally valid remote Program that is invalid for the selected Scene", async () => {
    await expect(
      materializeAuthoritativeEditorProgramsV1(
        scene(),
        [],
        [{ ...program(), loweringStatus: "unsupported" }],
        acceptTimeline,
      ),
    ).rejects.toThrow(/invalid for the selected Scene/i);
    await expect(
      materializeAuthoritativeEditorProgramsV1(
        scene(),
        [],
        [{ ...program(), loweringStatus: "illustrative" }],
        acceptTimeline,
      ),
    ).rejects.toThrow(/invalid for the selected Scene/i);
  });

  it("keeps authoritative source coordinates across timeline admission and re-materialization", async () => {
    const remote = program();
    const rebasingProjection: ProjectStudioTimelineCompiler = async (command) => ({
      programProjections: [
        {
          operationId: "shared/wait",
          transactionId: "shared",
          workingAnchor: 3,
          workingInterval: { end: 4, start: 3 },
        },
      ],
      projectedDuration: command.baseDuration + 1,
      transforms: [{ interval: { end: 4, start: 3 }, kind: "insert", operationId: "shared/wait" }],
    });
    const materialized = await materializeAuthoritativeEditorProgramsV1(scene(), [], [remote], rebasingProjection);
    const refreshed = await materializeAuthoritativeEditorProgramsV1(
      scene(),
      materialized,
      [remote],
      rebasingProjection,
    );

    expect(materialized[0]?.program).toEqual(remote);
    expect(refreshed[0]?.program).toEqual(remote);
    expect(refreshed[0]?.validation).toEqual({ issues: [], status: "valid" });
    expect(editorProgramsMatchAuthorityV1(refreshed, [remote])).toBe(true);
  });

  it("rejects an invalid Rust correlation", async () => {
    await expect(
      materializeAuthoritativeEditorProgramsV1(scene(), [], [program()], async (command) => ({
        programProjections: [
          {
            operationId: "different-operation",
            transactionId: "shared",
            workingAnchor: 1,
            workingInterval: { end: 2, start: 1 },
          },
        ],
        projectedDuration: command.baseDuration + 1,
        transforms: [{ interval: { end: 2, start: 1 }, kind: "insert", operationId: "shared/wait" }],
      })),
    ).rejects.toThrow(/correlation/i);
  });

  it("rejects a batch that mixes Scene duration and other Programs", async () => {
    const boundary: CanonicalEditProgram = {
      ...program(),
      operations: [
        {
          at: 1,
          dependsOn: [],
          destination: "next-scene",
          id: "boundary/scene",
          interval: { end: 1, start: 1 },
          kind: "InsertSceneBoundary",
          provenance: { evidence: [], origin: "studio-default" },
        },
      ],
      schedule: { edges: [], mode: "sequence", order: ["boundary/scene"] },
      transactionId: "boundary",
    };

    const rejected = materializeAuthoritativeEditorProgramsV1(scene(), [], [program(), boundary]);
    await expect(rejected).rejects.toBeInstanceOf(EditorTimelineAdmissionError);
    await expect(rejected).rejects.toThrow(/must not mix Scene duration and other Programs/i);
  });
});
