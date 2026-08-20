import { describe, expect, it } from "vitest";

import { createDirectManipulationPositionProgram } from "./suggestion-program";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { lockedEntityMutationTargets, toggleEntityLock } from "./entity-lock";

describe("Studio entity locks", () => {
  it("finds only locked write targets in a canonical Program", () => {
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 1, y: 0 },
      positions: {
        equation_1: { x: 0, y: 0 },
        label_1: { x: 0, y: 1 },
      },
      scene: STUDIO_FIXTURE_SCENE,
      start: 0,
      targetEntityIds: ["equation_1", "label_1"],
      transactionId: "locked-move",
    });
    expect(validation.kind).toBe("valid");
    expect(lockedEntityMutationTargets(validation.program, new Set(["label_1", "unrelated"]))).toEqual(["label_1"]);
  });

  it("adds and removes one lock without disturbing the other rows", () => {
    expect(toggleEntityLock(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleEntityLock(["a", "b"], "a")).toEqual(["b"]);
  });
});
