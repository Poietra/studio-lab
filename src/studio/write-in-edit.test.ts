import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { insertedProgramDuration } from "./program-composition";
import { replaceWriteInProgram, writeInClipFromProgram } from "./write-in-edit";

function mathTexCreation() {
  return createStudioEntitiesProgram({
    capturedPlayhead: 1,
    entities: [
      {
        content: { displayLines: [String.raw`E = mc^2`], texParts: [String.raw`E = mc^2`] },
        position: { x: 320, y: 180 },
        type: "MathTex",
      },
    ],
    scene: STUDIO_FIXTURE_SCENE,
    transactionId: "write-math",
  });
}

describe("Write entrance editing", () => {
  it("replaces the automatic fade, retimes the canonical clip, and removes it", () => {
    const creation = mathTexCreation();
    const entityId = creation.entityIds[0]!;
    const written = replaceWriteInProgram({
      baseProgram: creation.validation.program,
      entityId,
      scene: STUDIO_FIXTURE_SCENE,
      write: { easing: "linear", end: 2.5 },
    });

    expect(written.kind, JSON.stringify(written.issues)).toBe("valid");
    expect(written.program.loweringStatus).toBe("supported");
    expect(written.program.operations.some((operation) => operation.kind === "ChangePresence")).toBe(false);
    expect(insertedProgramDuration(written.program)).toBe(1.5);
    expect(writeInClipFromProgram(written.program)).toMatchObject({
      easing: "linear",
      entityId,
      interval: { end: 2.5, start: 1 },
    });

    const removed = replaceWriteInProgram({
      baseProgram: written.program,
      entityId,
      scene: STUDIO_FIXTURE_SCENE,
      write: null,
    });
    expect(removed.kind, JSON.stringify(removed.issues)).toBe("valid");
    expect(removed.program.loweringStatus).toBe("supported");
    expect(writeInClipFromProgram(removed.program)).toBeNull();
  });

  it("rejects non-MathTex Studio objects", () => {
    const line = createStudioEntitiesProgram({
      capturedPlayhead: 1,
      entities: [{ position: { x: 320, y: 180 }, type: "Line" }],
      scene: STUDIO_FIXTURE_SCENE,
      transactionId: "write-line",
    });
    expect(() =>
      replaceWriteInProgram({
        baseProgram: line.validation.program,
        entityId: line.entityIds[0]!,
        scene: STUDIO_FIXTURE_SCENE,
        write: { easing: "linear", end: 2 },
      }),
    ).toThrow(/MathTex/);
  });
});
