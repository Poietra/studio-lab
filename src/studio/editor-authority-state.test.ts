import { describe, expect, it, vi } from "vitest";

import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import type {
  ProjectStudioCreationCompiler,
  ProjectStudioMathTexTransformCompiler,
  ProjectStudioMotionCompiler,
  ProjectStudioTimelineCompiler,
  StudioMathTexTransformProjectionV1,
  StudioMotionProjectionV1,
} from "../engine/scene-authoring";
import { importManimScene } from "../render-pipeline/source-import";
import { createRemoveEntitiesProgram, createStudioEntitiesProgram } from "./authoring-commands";
import {
  EditorCreationAdmissionError,
  EditorMathTexTransformAdmissionError,
  EditorTimelineAdmissionError,
  editorProgramsMatchAuthorityV1,
  materializeAuthoritativeEditorProgramsV1,
} from "./editor-authority-state";
import type { EditorProgramRecord } from "./editor-session-store";
import type { CanonicalEditProgram } from "./operations";
import {
  canonicalizeSuggestionProgram,
  createDirectManipulationOpacityProgram,
  createDirectManipulationPositionProgram,
  createDirectManipulationRotationProgram,
} from "./suggestion-program";

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
    motions: [],
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

function mathTexFinalTargetMotionProgram(): CanonicalEditProgram {
  return {
    anchor: { capturedPlayhead: 2, evidence: [], resolvedSeconds: 2, source: { kind: "absolute", seconds: 2 } },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        controlOffset: { x: 10, y: 5 },
        delta: { x: 40, y: -20 },
        dependsOn: [],
        easing: "smooth",
        id: "math-motion/final-target",
        interval: { end: 3, start: 2 },
        kind: "CreateMotion",
        provenance: { evidence: [], origin: "studio-default" },
        targetEntityIds: ["equation-a-prime"],
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: ["math-motion/final-target"] },
    transactionId: "math-motion",
    version: 1,
  };
}

function standaloneMotionProgram(): CanonicalEditProgram {
  return {
    anchor: { capturedPlayhead: 1, evidence: [], resolvedSeconds: 1, source: { kind: "absolute", seconds: 1 } },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        controlOffset: { x: 10, y: 5 },
        delta: { x: 40, y: -20 },
        dependsOn: [],
        easing: "smooth",
        id: "motion/source",
        interval: { end: 2, start: 1 },
        kind: "CreateMotion",
        provenance: { evidence: [], origin: "remote-model" },
        targetEntityIds: [MATH_TEX_SOURCE_ID],
      },
    ],
    provenance: { evidence: [], origin: "remote-model" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: ["motion/source"] },
    transactionId: "motion-source",
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
  it("admits authoritative Studio creation only through the Rust projector", async () => {
    const targetScene = scene();
    const remote = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ dimensions: { radius: 2 }, position: { x: 200, y: 120 }, type: "Circle" }],
      scene: targetScene.runtimeSceneState,
      transactionId: "editor-create",
    }).validation.program;
    const compiler = vi.fn<ProjectStudioCreationCompiler>(async () => {
      throw new Error("unsupported creation");
    });

    await expect(
      materializeAuthoritativeEditorProgramsV1(targetScene, [], [remote], undefined, undefined, undefined, compiler),
    ).rejects.toThrow(EditorCreationAdmissionError);
    expect(compiler).toHaveBeenCalledWith(
      expect.objectContaining({ baseDuration: 5, schema: "poietra.project-studio-creation-edit" }),
    );
  });

  it("admits standalone motion only through the snapshot-free Rust projector", async () => {
    const remote = standaloneMotionProgram();
    const projection: StudioMotionProjectionV1 = {
      insertions: [{ at: 1, duration: 1, transactionId: remote.transactionId }],
      motions: [
        {
          control: { x: 350, y: 175 },
          controlOffset: { x: 10, y: 5 },
          delta: { x: 40, y: -20 },
          easing: "manim-smooth",
          from: { x: 320, y: 180 },
          interval: { end: 2, start: 1 },
          operationId: "motion/source",
          sourceInterval: { end: 2, start: 1 },
          targetEntityId: MATH_TEX_SOURCE_ID,
          to: { x: 360, y: 160 },
          transactionId: remote.transactionId,
        },
      ],
      projectedDuration: 6,
    };
    const compiler = vi.fn<ProjectStudioMotionCompiler>(async () => projection);

    const materialized = await materializeAuthoritativeEditorProgramsV1(
      scene(),
      [],
      [remote],
      undefined,
      undefined,
      compiler,
    );

    expect(materialized).toEqual([{ program: remote, validation: { issues: [], status: "valid" } }]);
    expect(compiler).toHaveBeenCalledWith(
      expect.objectContaining({
        baseDuration: 5,
        batch: expect.objectContaining({ kind: "standalone" }),
        schema: "poietra.project-studio-motion-edit",
      }),
    );
  });

  it("installs authoritative static-transform and persistent-remove Programs without TypeScript evaluation", async () => {
    const targetScene = scene();
    const move = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 40, y: -20 },
      positions: { [MATH_TEX_SOURCE_ID]: { x: 320, y: 180 } },
      scene: targetScene.runtimeSceneState,
      start: 0,
      targetEntityIds: [MATH_TEX_SOURCE_ID],
      transactionId: "move-imported-equation",
    });
    const remove = createRemoveEntitiesProgram({
      capturedPlayhead: 1,
      entityIds: [MATH_TEX_SOURCE_ID],
      scene: targetScene.runtimeSceneState,
      transactionId: "remove-imported-equation",
    });
    if (move.kind !== "valid" || remove.kind !== "valid") {
      throw new Error(`fixture validation failed: ${JSON.stringify([...move.issues, ...remove.issues])}`);
    }

    const programs = [move.program, remove.program];
    const materialized = await materializeAuthoritativeEditorProgramsV1(targetScene, [], programs);

    expect(materialized).toEqual(programs.map((program) => ({ program, validation: { issues: [], status: "valid" } })));

    const missingTarget = {
      ...remove.program,
      operations: remove.program.operations.map((operation) =>
        operation.kind === "ChangePresence" ? { ...operation, entityId: "source:missing" } : operation,
      ),
    };
    await expect(
      materializeAuthoritativeEditorProgramsV1(targetScene, [], [move.program, missingTarget]),
    ).rejects.toThrow(/invalid for the selected Scene source/i);
  });

  it("retains the exact source-bound opacity and rotation endpoint families", async () => {
    const targetScene = scene();
    const opacity = createDirectManipulationOpacityProgram({
      capturedPlayhead: 0,
      entityId: MATH_TEX_SOURCE_ID,
      opacity: 0.35,
      scene: targetScene.runtimeSceneState,
      start: 0,
      transactionId: "bound-opacity",
    });
    const rotation = createDirectManipulationRotationProgram({
      angleRadians: Math.PI / 4,
      capturedPlayhead: 0,
      entityId: MATH_TEX_SOURCE_ID,
      scene: targetScene.runtimeSceneState,
      start: 0,
      transactionId: "bound-rotation",
    });
    if (opacity.kind !== "valid" || rotation.kind !== "valid") {
      throw new Error(`fixture validation failed: ${JSON.stringify([...opacity.issues, ...rotation.issues])}`);
    }

    await expect(materializeAuthoritativeEditorProgramsV1(targetScene, [], [opacity.program])).resolves.toEqual([
      { program: opacity.program, validation: { issues: [], status: "valid" } },
    ]);
    await expect(materializeAuthoritativeEditorProgramsV1(targetScene, [], [rotation.program])).resolves.toEqual([
      { program: rotation.program, validation: { issues: [], status: "valid" } },
    ]);
  });

  it("retains one exact initial MathTex content replacement as a closed validated family", async () => {
    const contentProgram: CanonicalEditProgram = {
      anchor: { capturedPlayhead: 0, evidence: [], resolvedSeconds: 0, source: { kind: "absolute", seconds: 0 } },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [
        {
          dependsOn: [],
          entityId: MATH_TEX_SOURCE_ID,
          id: "math-content/set",
          interval: { end: 0, start: 0 },
          key: "content",
          kind: "SetProperty",
          provenance: { evidence: [], origin: "direct-manipulation" },
          value: { displayLines: ["B"], label: "B", texParts: ["B"] },
        },
      ],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "parallel",
      schedule: { edges: [], mode: "parallel", order: ["math-content/set"] },
      transactionId: "math-content",
      version: 1,
    };

    await expect(materializeAuthoritativeEditorProgramsV1(scene(), [], [contentProgram])).resolves.toEqual([
      { program: contentProgram, validation: { issues: [], status: "valid" } },
    ]);
  });

  it("rejects an otherwise evaluatable Program without a Rust projection or closed family", async () => {
    const unsupported: CanonicalEditProgram = {
      ...program(),
      operations: [
        {
          dependsOn: [],
          effect: "fade-in",
          entityId: MATH_TEX_SOURCE_ID,
          id: "presence/fade-in",
          interval: { end: 2, start: 1 },
          kind: "ChangePresence",
          persistent: true,
          provenance: { evidence: [], origin: "remote-model" },
        },
      ],
      schedule: { edges: [], mode: "sequence", order: ["presence/fade-in"] },
      transactionId: "presence-fade-in",
    };

    await expect(materializeAuthoritativeEditorProgramsV1(scene(), [], [unsupported])).rejects.toThrow(
      /no supported Rust projection or closed validation path/i,
    );
  });

  it("installs one authoritative Magic Edit scale-then-remove Program", async () => {
    const targetScene = scene();
    const operation: EditSuggestionOperation = {
      anchor: { kind: "playhead", referenceSeconds: 1 },
      execution: "sequence",
      kind: "edit-program",
      operations: [
        {
          easing: "smooth",
          end: 2,
          factor: 1.5,
          kind: "scale-objects",
          start: 1,
          targetObjectIds: [MATH_TEX_SOURCE_ID],
        },
        {
          animation: "fade-out",
          end: 2.4,
          kind: "delete-objects",
          start: 2,
          targetObjectIds: [MATH_TEX_SOURCE_ID],
        },
      ],
    };
    const validation = canonicalizeSuggestionProgram(operation, {
      capturedPlayhead: 1,
      origin: "remote-model",
      scene: targetScene.runtimeSceneState,
      transactionId: "magic-scale-delete",
    });
    if (validation.kind !== "valid") throw new Error(JSON.stringify(validation.issues));

    const materialized = await materializeAuthoritativeEditorProgramsV1(targetScene, [], [validation.program]);

    expect(materialized).toEqual([{ program: validation.program, validation: { issues: [], status: "valid" } }]);
  });

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

  it("admits a later-Program final-target motion through the same Rust MathTex projector", async () => {
    const transform = mathTexTransformProgram();
    const motion = mathTexFinalTargetMotionProgram();
    const transformProjection = acceptedMathTexProjection();
    const compiler = vi.fn<ProjectStudioMathTexTransformCompiler>(async () => ({
      ...transformProjection,
      insertions: [...transformProjection.insertions, { at: 3, duration: 1, transactionId: motion.transactionId }],
      motions: [
        {
          control: { x: 350, y: 175 },
          controlOffset: { x: 10, y: 5 },
          delta: { x: 40, y: -20 },
          easing: "manim-smooth",
          from: { x: 320, y: 180 },
          interval: { end: 4, start: 3 },
          operationId: motion.operations[0]!.id,
          sourceInterval: motion.operations[0]!.interval,
          targetEntityId: "equation-a-prime",
          to: { x: 360, y: 160 },
          transactionId: motion.transactionId,
        },
      ],
      projectedDuration: 7,
      replacements: transformProjection.replacements.map((replacement, index, replacements) =>
        index === replacements.length - 1
          ? { ...replacement, targetLifetime: { ...replacement.targetLifetime, end: 7 } }
          : replacement,
      ),
    }));

    await expect(
      materializeAuthoritativeEditorProgramsV1(scene(), [], [transform, motion], undefined, compiler),
    ).resolves.toHaveLength(2);
    expect(compiler.mock.calls[0]?.[0]).toMatchObject({
      programs: [
        expect.anything(),
        expect.objectContaining({ operations: [expect.objectContaining({ kind: "create-motion" })] }),
      ],
      studioEntities: expect.arrayContaining([
        expect.objectContaining({ objectGraphKey: MATH_TEX_SOURCE_ID, position: { x: 320, y: 180 } }),
      ]),
    });
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
