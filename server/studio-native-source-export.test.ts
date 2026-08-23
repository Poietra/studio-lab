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
        lifetime: { end: null, start: anchor },
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

  it("reuses canonical source lowering for non-overlapping Studio-created objects", () => {
    const circle = creationProgram("create-circle", "native:circle", "Circle", 0, 0.4);
    const rectangle = creationProgram("create-rectangle", "native:rectangle", "Rectangle", 1, 0.5);
    const exported = exportStudioNativeManimSource({
      duration: 3,
      frame,
      programs: [circle, rectangle],
      sceneName: "NativeDemo",
      viewport,
    });
    const imported = importManimScene(exported.source, "poietra_scene.py", exported.sceneName, frame);

    expect(exported.source).toContain("Circle(radius=1)");
    expect(exported.source).toContain("Rectangle(width=3, height=2)");
    expect(exported.source).toContain("run_time=0.4");
    expect(exported.source).toContain("run_time=0.5");
    expect(imported?.runtimeSceneState.duration).toBe(3);
    expect(Object.values(imported?.runtimeSceneState.objectGraph.entities ?? {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "native:circle", type: "Circle" }),
        expect.objectContaining({ id: "native:rectangle", type: "Rectangle" }),
      ]),
    );
  });

  it("fails closed instead of serializing overlapping Program intervals", () => {
    const circle = creationProgram("create-circle", "native:circle", "Circle", 0, 0.8);
    const rectangle = creationProgram("create-rectangle", "native:rectangle", "Rectangle", 0.5, 0.5);

    expect(() =>
      exportStudioNativeManimSource({ duration: 3, frame, programs: [circle, rectangle], viewport }),
    ).toThrow(/overlaps another positive-duration Program/i);
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
