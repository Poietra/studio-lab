import { describe, expect, it } from "vitest";

import { importManimScene } from "../src/render-pipeline/source-import";
import type { CanonicalEditOperation, CanonicalEditProgram } from "../src/studio/operations";
import { exportStudioNativeManimSource } from "./studio-native-source-export";

const frame = { height: 8, width: 14.222 } as const;
const viewport = { height: 360, width: 640 } as const;

function operationBase(id: string, start: number, end = start) {
  return {
    dependsOn: [],
    id,
    interval: { end, start },
    provenance: { evidence: [], origin: "studio-default" as const },
  };
}

function program(
  transactionId: string,
  anchor: number,
  operations: readonly CanonicalEditOperation[],
  loweringStatus: CanonicalEditProgram["loweringStatus"] = "supported",
): CanonicalEditProgram {
  return {
    anchor: {
      capturedPlayhead: anchor,
      evidence: [`captured-playhead:${anchor.toFixed(3)}`],
      resolvedSeconds: anchor,
      source: { kind: "playhead", referenceSeconds: anchor },
    },
    intentCount: 1,
    loweringStatus,
    operations,
    provenance: { evidence: ["Studio-native authoring"], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: operations.map(({ id }) => id) },
    transactionId,
    version: 1,
  };
}

function creationProgram(
  transactionId: string,
  entityId: string,
  type: "Circle" | "Rectangle",
  anchor: number,
  duration = 0.4,
  lifetimeEnd: number | null = null,
) {
  const createId = `${transactionId}/create`;
  const positionId = `${transactionId}/position`;
  const appearId = `${transactionId}/appear`;
  return program(transactionId, anchor, [
    {
      ...operationBase(createId, anchor),
      entity: {
        dimensions: type === "Circle" ? { radius: 1 } : { height: 2, width: 3 },
        id: entityId,
        lifetime: { end: lifetimeEnd, start: anchor },
        type,
      },
      kind: "CreateEntity",
    },
    {
      ...operationBase(positionId, anchor),
      dependsOn: [createId],
      entityId,
      key: "position",
      kind: "SetProperty",
      value: type === "Circle" ? { x: 160, y: 180 } : { x: 480, y: 180 },
    },
    {
      ...operationBase(appearId, anchor, anchor + duration),
      dependsOn: [positionId],
      effect: "fade-in",
      entityId,
      kind: "ChangePresence",
      persistent: true,
    },
  ]);
}

function contentCreationProgram(
  transactionId: string,
  entityId: string,
  type: "MathTex" | "Text",
  content: Readonly<{ displayLines: readonly string[]; texParts?: readonly string[]; text?: string }>,
  anchor = 0,
  duration = 0.4,
) {
  const createId = `${transactionId}/create`;
  const positionId = `${transactionId}/position`;
  const appearId = `${transactionId}/appear`;
  return program(transactionId, anchor, [
    {
      ...operationBase(createId, anchor),
      entity: { content, id: entityId, lifetime: { end: null, start: anchor }, type },
      kind: "CreateEntity",
    },
    {
      ...operationBase(positionId, anchor),
      dependsOn: [createId],
      entityId,
      key: "position",
      kind: "SetProperty",
      value: { x: 320, y: 180 },
    },
    {
      ...operationBase(appearId, anchor, anchor + duration),
      dependsOn: [positionId],
      effect: "fade-in",
      entityId,
      kind: "ChangePresence",
      persistent: true,
    },
  ]);
}

describe("Studio-native Manim source export", () => {
  it("exports an empty canonical Scene without fabricating imported source identity", () => {
    const exported = exportStudioNativeManimSource({ duration: 5, frame, programs: [], viewport });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(exported.sceneName).toBe("PoietraScene");
    expect(exported.source).toContain("class PoietraScene(Scene):");
    expect(exported.source).toContain("self.wait(5)");
    expect(imported?.runtimeSceneState.duration).toBe(5);
    expect(imported?.runtimeSceneState.objectGraph.entities).toEqual({});
  });

  it("does not inherit the MP4 duration limit when exporting source", () => {
    const exported = exportStudioNativeManimSource({ duration: 1_200, frame, programs: [], viewport });

    expect(exported.source).toContain("self.wait(1200)");
  });

  it("reuses canonical source lowering for non-overlapping Studio-created objects", () => {
    const circle = creationProgram("create-circle", "native:circle", "Circle", 0, 0.4);
    // The user created this object at working time 1.0. The preceding 0.4s
    // insertion is already removed when Studio persists its source anchor.
    const rectangle = creationProgram("create-rectangle", "native:rectangle", "Rectangle", 0.6, 0.5);
    const exported = exportStudioNativeManimSource({
      duration: 3,
      frame,
      programs: [circle, rectangle],
      viewport,
    });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(exported.source).toContain("Circle(radius=1)");
    expect(exported.source).toContain("Rectangle(width=3, height=2)");
    expect(exported.source).toContain("run_time=0.4");
    expect(exported.source).toContain("run_time=0.5");
    expect(imported?.runtimeSceneState.duration).toBe(3);
    expect(imported?.runtimeSceneState.objectGraph.entities["native:circle"]?.lifetime[0]?.start).toBe(0);
    expect(imported?.runtimeSceneState.objectGraph.entities["native:rectangle"]?.lifetime[0]?.start).toBe(1);
    expect(Object.values(imported?.runtimeSceneState.objectGraph.entities ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          geometry: expect.objectContaining({ position: { kind: "known", value: { x: 160, y: 180 } } }),
          id: "native:circle",
          type: "Circle",
        }),
        expect.objectContaining({
          geometry: expect.objectContaining({ position: { kind: "known", value: { x: 480, y: 180 } } }),
          id: "native:rectangle",
          type: "Rectangle",
        }),
      ]),
    );
  });

  it("serializes Programs appended at the same source anchor in canonical input order", () => {
    const circle = creationProgram("create-circle", "native:circle", "Circle", 0, 0.4);
    const rectangle = creationProgram("create-rectangle", "native:rectangle", "Rectangle", 0, 0.5);
    const exported = exportStudioNativeManimSource({ duration: 3, frame, programs: [circle, rectangle], viewport });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(imported?.runtimeSceneState.objectGraph.entities["native:circle"]?.lifetime[0]?.start).toBe(0);
    expect(imported?.runtimeSceneState.objectGraph.entities["native:rectangle"]?.lifetime[0]?.start).toBe(0.4);
  });

  it("preserves a finite Studio-created lifetime on the synthetic source timeline", () => {
    const circle = creationProgram("create-circle", "native:circle", "Circle", 0, 0.4, 2);
    const exported = exportStudioNativeManimSource({ duration: 3, frame, programs: [circle], viewport });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(exported.source).toContain("self.remove(");
    expect(imported?.runtimeSceneState.objectGraph.entities["native:circle"]?.lifetime[0]?.end).toBe(2.4);
  });

  it("preserves a later persistent Delete Program on the working timeline", () => {
    const circle = creationProgram("create-circle", "native:circle", "Circle", 0, 0.4);
    const remove = program("remove-circle", 1.1, [
      {
        ...operationBase("remove-circle/remove", 1.1, 1.4),
        effect: "remove",
        entityId: "native:circle",
        kind: "ChangePresence",
        persistent: true,
      },
    ]);
    const exported = exportStudioNativeManimSource({ duration: 3.7, frame, programs: [circle, remove], viewport });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(exported.source).toContain("FadeOut(");
    expect(imported?.runtimeSceneState.objectGraph.entities["native:circle"]?.lifetime[0]?.end).toBe(1.8);
  });

  it("round-trips later motion and resize through their imported property channels", () => {
    const circle = creationProgram("create-circle", "native:circle", "Circle", 0, 0.4);
    const motion = program("move-circle", 0.6, [
      {
        ...operationBase("move-circle/motion", 0.6, 1.1),
        controlOffset: { x: 0, y: 0 },
        delta: { x: 40, y: -20 },
        easing: "smooth",
        kind: "CreateMotion",
        targetEntityIds: ["native:circle"],
      },
    ]);
    const resize = program("resize-circle", 1.2, [
      {
        ...operationBase("resize-circle/resize", 1.2),
        entityId: "native:circle",
        from: { dimensions: { radius: 1 }, position: { x: 200, y: 160 } },
        kind: "ResizeEntity",
        provenance: { evidence: [], origin: "direct-manipulation" },
        scale: 1,
        shape: "circle",
        to: { dimensions: { radius: 2 }, position: { x: 240, y: 170 } },
      },
    ]);
    const exported = exportStudioNativeManimSource({
      duration: 3.9,
      frame,
      programs: [circle, motion, resize],
      viewport,
    });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(imported?.runtimeSceneState.propertyChannels["native:circle/position"]?.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ interval: { end: 1.5, start: 1 }, value: { x: 200, y: 160 } }),
        expect.objectContaining({ value: { x: 240, y: 170 } }),
      ]),
    );
    expect(imported?.runtimeSceneState.propertyChannels["native:circle/dimensions"]?.samples.at(-1)?.value).toEqual({
      radius: 2,
    });
  });

  it("round-trips a later Text content edit without treating the initial value as final", () => {
    const text = contentCreationProgram(
      "create-text",
      "native:text",
      "Text",
      { displayLines: ["Before"], text: "Before" },
      0,
      0.4,
    );
    const content = program("edit-text", 0.6, [
      {
        ...operationBase("edit-text/content", 0.6),
        entityId: "native:text",
        key: "content",
        kind: "SetProperty",
        value: { displayLines: ["After"], text: "After" },
      },
    ]);
    const exported = exportStudioNativeManimSource({ duration: 3.4, frame, programs: [text, content], viewport });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(imported?.runtimeSceneState.objectGraph.entities["native:text"]?.content?.text).toBe("After");
    expect(imported?.runtimeSceneState.propertyChannels["native:text/content"]?.samples).toHaveLength(2);
  });

  it("round-trips MathTex replacement lineage without keeping the source alive", () => {
    const equation = contentCreationProgram(
      "create-equation",
      "native:equation",
      "MathTex",
      { displayLines: ["E = mc^2"], texParts: ["E", "=", "m", "c^2"] },
      0,
      0.4,
    );
    const transform = program("transform-equation", 0.6, [
      {
        ...operationBase("transform-equation/content", 0.6, 1.1),
        kind: "TransformContent",
        replacement: { displayLines: ["F = ma"], texParts: ["F", "=", "m", "a"] },
        sourceEntityId: "native:equation",
        strategy: "transform-matching-tex",
        targetEntityId: "native:equation-next",
        targetType: "MathTex",
      },
    ]);
    const exported = exportStudioNativeManimSource({
      duration: 3.9,
      frame,
      programs: [equation, transform],
      viewport,
    });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(imported?.runtimeSceneState.objectGraph.entities["native:equation"]?.lifetime.at(-1)?.end).toBe(1.5);
    expect(imported?.runtimeSceneState.objectGraph.entities["native:equation-next"]?.content?.texParts).toEqual([
      "F",
      "=",
      "m",
      "a",
    ]);
  });

  it("reports the unsupported operation family", () => {
    const visibility = program(
      "hide-circle",
      1,
      [
        {
          ...operationBase("hide-circle/visibility", 1),
          entityId: "native:circle",
          key: "visibility",
          kind: "SetProperty",
          value: false,
        },
      ],
      "unsupported",
    );

    expect(() => exportStudioNativeManimSource({ duration: 3, frame, programs: [visibility], viewport })).toThrow(
      /SetProperty.*has no truthful Manim source lowering/i,
    );
  });
});
