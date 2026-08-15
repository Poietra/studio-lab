import { describe, expect, it, vi } from "vitest";

import type {
  ProjectStudioMathTexTransformCompiler,
  ProjectStudioTimelineCompiler,
  StudioMathTexTransformProjectionV1,
} from "../engine/scene-authoring";
import { importManimScene } from "../render-pipeline/source-import";
import {
  EditorMathTexTransformAdmissionError,
  EditorTimelineAdmissionError,
  editorProgramsMatchAuthorityV1,
  materializeAuthoritativeEditorProgramsV1,
} from "./editor-authority-state";
import type { EditorProgramRecord } from "./editor-session-store";
import type { CanonicalEditProgram } from "./operations";

const source = `from manim import *

class Demo(Scene):
    def construct(self):
        equation_a = MathTex("A")
        self.add(equation_a)
        self.wait(5)
`;

const MATH_TEX_SOURCE_ID = "source:scene.py#Demo:equation_a";

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

function mathTexTransformProgram(): CanonicalEditProgram {
  return {
    anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
    intentCount: 2,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        id: "math-transform/a-to-b",
        interval: { end: 1.5, start: 1 },
        kind: "TransformContent",
        provenance: { evidence: [], origin: "studio-default" },
        replacement: { displayLines: ["B"], label: "B", texParts: ["B"] },
        sourceEntityId: MATH_TEX_SOURCE_ID,
        strategy: "transform-matching-tex",
        targetEntityId: "equation-b",
        targetType: "MathTex",
      },
      {
        dependsOn: ["math-transform/a-to-b"],
        id: "math-transform/b-to-a",
        interval: { end: 2, start: 1.5 },
        kind: "TransformContent",
        provenance: { evidence: [], origin: "studio-default" },
        replacement: { displayLines: ["A"], label: "A", texParts: ["A"] },
        sourceEntityId: "equation-b",
        strategy: "transform-matching-tex",
        targetEntityId: "equation-a-prime",
        targetType: "MathTex",
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: {
      edges: [{ from: "math-transform/a-to-b", reason: "explicit", to: "math-transform/b-to-a" }],
      mode: "sequence",
      order: ["math-transform/a-to-b", "math-transform/b-to-a"],
    },
    transactionId: "math-transform",
    version: 1,
  };
}

function acceptedMathTexProjection(): StudioMathTexTransformProjectionV1 {
  return {
    insertions: [{ at: 1, duration: 1, transactionId: "math-transform" }],
    projectedDuration: 6,
    replacements: [
      {
        content: { displayLines: ["B"], label: "B", texParts: ["B"] },
        interval: { end: 1.5, start: 1 },
        operationId: "math-transform/a-to-b",
        sourceEntityId: MATH_TEX_SOURCE_ID,
        targetEntityId: "equation-b",
        targetLifetime: { end: 2, start: 1 },
        targetType: "math-tex",
        transactionId: "math-transform",
      },
      {
        content: { displayLines: ["A"], label: "A", texParts: ["A"] },
        interval: { end: 2, start: 1.5 },
        operationId: "math-transform/b-to-a",
        sourceEntityId: "equation-b",
        targetEntityId: "equation-a-prime",
        targetLifetime: { end: 6, start: 1.5 },
        targetType: "math-tex",
        transactionId: "math-transform",
      },
    ],
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

  it("materializes an exact authoritative MathTex A-to-B-to-A batch as valid records", async () => {
    const remote = mathTexTransformProgram();
    const compiler = vi.fn<ProjectStudioMathTexTransformCompiler>(async () => acceptedMathTexProjection());

    const materialized = await materializeAuthoritativeEditorProgramsV1(scene(), [], [remote], undefined, compiler);

    expect(materialized).toEqual([{ program: remote, validation: { issues: [], status: "valid" } }]);
    expect(compiler).toHaveBeenCalledOnce();
    expect(compiler).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDuration: 5,
        schema: "poietra.project-studio-math-tex-transform",
        studioEntities: expect.arrayContaining([
          expect.objectContaining({
            lifetime: [{ end: 5, start: 0 }],
            objectGraphKey: MATH_TEX_SOURCE_ID,
            type: "math-tex",
          }),
        ]),
      }),
    );
  });

  it("rejects malformed MathTex content through Rust admission", async () => {
    const remote = mathTexTransformProgram();
    const malformed = {
      ...remote,
      operations: [{ ...remote.operations[0]!, replacement: { displayLines: [], texParts: [] } }],
      intentCount: 1,
      schedule: { edges: [], mode: "sequence" as const, order: [remote.operations[0]!.id] },
    };
    const compiler = vi.fn<ProjectStudioMathTexTransformCompiler>(async (command) => {
      const replacement = command.programs[0]?.operations[0];
      if (replacement?.kind === "transform-content" && replacement.replacement === null) {
        throw new Error("unsupported MathTex content");
      }
      return acceptedMathTexProjection();
    });

    await expect(
      materializeAuthoritativeEditorProgramsV1(scene(), [], [malformed], undefined, compiler),
    ).rejects.toThrow(/Rust MathTex transform admission rejected.*unsupported MathTex content/i);
  });

  it("rejects a MathTex transform whose source is absent from the selected Scene", async () => {
    const remote = mathTexTransformProgram();
    const missingSource = {
      ...remote,
      operations: [{ ...remote.operations[0]!, sourceEntityId: "missing" }],
      intentCount: 1,
      schedule: { edges: [], mode: "sequence" as const, order: [remote.operations[0]!.id] },
    };
    const compiler = vi.fn<ProjectStudioMathTexTransformCompiler>(async (command) => {
      const sourceId =
        command.programs[0]?.operations[0]?.kind === "transform-content"
          ? command.programs[0].operations[0].sourceEntityId
          : null;
      if (!command.studioEntities.some(({ objectGraphKey }) => objectGraphKey === sourceId)) {
        throw new Error("missing source entity");
      }
      return acceptedMathTexProjection();
    });

    await expect(
      materializeAuthoritativeEditorProgramsV1(scene(), [], [missingSource], undefined, compiler),
    ).rejects.toThrow(/Rust MathTex transform admission rejected.*missing source entity/i);
  });

  it("rejects an uncorrelated MathTex projection returned by the compiler", async () => {
    const remote = mathTexTransformProgram();
    const projection = acceptedMathTexProjection();
    const compiler: ProjectStudioMathTexTransformCompiler = async () => ({
      ...projection,
      replacements: [{ ...projection.replacements[0]!, targetEntityId: "wrong-target" }],
    });

    const admission = materializeAuthoritativeEditorProgramsV1(scene(), [], [remote], undefined, compiler);
    await expect(admission).rejects.toBeInstanceOf(EditorMathTexTransformAdmissionError);
    await expect(admission).rejects.toThrow(
      /Rust MathTex transform admission rejected.*one unique result per Program operation/i,
    );
  });

  it("rejects TransformContent mixed with a family that has no Rust batch authority", async () => {
    const transform = mathTexTransformProgram();
    const mixed: CanonicalEditProgram = {
      ...transform,
      intentCount: 3,
      operations: [...transform.operations, program().operations[0]!],
      schedule: {
        edges: transform.schedule.edges,
        mode: "sequence",
        order: [...transform.schedule.order, "shared/wait"],
      },
    };

    await expect(materializeAuthoritativeEditorProgramsV1(scene(), [], [mixed])).rejects.toThrow(
      /TransformContent only as an exact Rust MathTex transform batch/i,
    );
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
