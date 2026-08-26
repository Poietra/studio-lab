import { describe, expect, it } from "vitest";

import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { RuntimeSceneState } from "./model";
import { createPathMotionProgram, pathMotionClipFromProgram, replacePathMotionProgram } from "./path-motion-edit";

const PATH_ID = "studio-pen";
const TARGET_ID = "studio-circle";

function scene(): RuntimeSceneState {
  return {
    ...STUDIO_FIXTURE_SCENE,
    objectGraph: {
      ...STUDIO_FIXTURE_SCENE.objectGraph,
      entities: {
        ...STUDIO_FIXTURE_SCENE.objectGraph.entities,
        [PATH_ID]: {
          id: PATH_ID,
          lifetime: [{ end: STUDIO_FIXTURE_SCENE.duration, start: 0 }],
          provisional: false,
          sourceIdentity: { evidence: [], kind: "unknown", reason: "Studio-created" },
          transactionId: "create-pen",
          type: "CubicBezier",
        },
        [TARGET_ID]: {
          id: TARGET_ID,
          lifetime: [{ end: STUDIO_FIXTURE_SCENE.duration, start: 0 }],
          provisional: false,
          sourceIdentity: { evidence: [], kind: "unknown", reason: "Studio-created" },
          transactionId: "create-circle",
          type: "Circle",
        },
      },
    },
  };
}

function createdProgram() {
  const validation = createPathMotionProgram({
    capturedPlayhead: 2,
    easing: "smooth",
    end: 3,
    pathEntityId: PATH_ID,
    scene: scene(),
    start: 2,
    targetEntityId: TARGET_ID,
    transactionId: "pen-motion",
  });
  expect(validation.kind).toBe("valid");
  if (validation.kind !== "valid") throw new TypeError("Expected one valid Pen motion Program.");
  return validation.program;
}

describe("Pen path motion authoring", () => {
  it("creates and retimes an ID-only canonical operation without changing identity", () => {
    const program = createdProgram();
    const operation = program.operations[0];
    expect(operation).toMatchObject({
      easing: "smooth",
      kind: "CreatePathMotion",
      pathEntityId: PATH_ID,
      targetEntityId: TARGET_ID,
    });
    expect(operation && "path" in operation).toBe(false);
    expect(program.loweringStatus).toBe("unsupported");

    const replacement = replacePathMotionProgram({
      baseProgram: program,
      duration: 2.5,
      easing: "linear",
      scene: scene(),
      start: 4,
    });
    expect(replacement.kind).toBe("valid");
    if (replacement.kind !== "valid") throw new TypeError("Expected one valid retimed Pen motion Program.");
    expect(pathMotionClipFromProgram(replacement.program)).toEqual({
      easing: "linear",
      interval: { end: 6.5, start: 4 },
      operationId: operation?.id,
      pathEntityId: PATH_ID,
      targetEntityId: TARGET_ID,
      transactionId: program.transactionId,
    });
  });

  it("rejects invalid intervals and identical path/target IDs", () => {
    expect(() =>
      createPathMotionProgram({
        capturedPlayhead: 2,
        easing: "smooth",
        end: 2.05,
        pathEntityId: PATH_ID,
        scene: scene(),
        start: 2,
        targetEntityId: TARGET_ID,
        transactionId: "too-short",
      }),
    ).toThrow(/at least 0\.1 seconds/i);
    expect(() =>
      createPathMotionProgram({
        capturedPlayhead: 2,
        easing: "smooth",
        end: 3,
        pathEntityId: PATH_ID,
        scene: scene(),
        start: 2,
        targetEntityId: PATH_ID,
        transactionId: "same-target",
      }),
    ).toThrow(/distinct path and target/i);
  });
});
