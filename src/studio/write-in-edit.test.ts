import { describe, expect, it } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { replacePaintColorKeyframeProgram } from "./paint-color-keyframe-edit";
import { insertedProgramDuration } from "./program-composition";
import { replaceWriteInProgram, writeInClipFromProgram, writeInUnavailableReason } from "./write-in-edit";

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

function textCreation() {
  return createStudioEntitiesProgram({
    capturedPlayhead: 1,
    entities: [
      {
        content: { displayLines: ["Write"], text: "Write" },
        position: { x: 320, y: 180 },
        type: "Text",
      },
    ],
    scene: STUDIO_FIXTURE_SCENE,
    transactionId: "write-text",
  });
}

describe("Write entrance editing", () => {
  it("replaces the automatic fade, retimes the canonical clip, and removes it", () => {
    const creation = mathTexCreation();
    const entityId = creation.entityIds[0]!;
    const written = replaceWriteInProgram({
      baseProgram: creation.validation.program,
      entityId,
      fragmentMaterial: null,
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
      fragmentMaterial: null,
      scene: STUDIO_FIXTURE_SCENE,
      write: null,
    });
    expect(removed.kind, JSON.stringify(removed.issues)).toBe("valid");
    expect(removed.program.loweringStatus).toBe("supported");
    expect(writeInClipFromProgram(removed.program)).toBeNull();
  });

  it("admits a texture-free material with Write in either order and preserves removal as recovery", () => {
    const creation = mathTexCreation();
    const entityId = creation.entityIds[0]!;
    const fragmentMaterial = { texture: false } as const;

    const written = replaceWriteInProgram({
      baseProgram: creation.validation.program,
      entityId,
      fragmentMaterial,
      scene: STUDIO_FIXTURE_SCENE,
      write: { easing: "linear", end: 2.5 },
    });
    expect(written.kind, JSON.stringify(written.issues)).toBe("valid");
    expect(writeInUnavailableReason(written.program, entityId, { fragmentMaterial })).toBeNull();
    expect(() =>
      replaceWriteInProgram({
        baseProgram: written.program,
        entityId,
        fragmentMaterial,
        scene: STUDIO_FIXTURE_SCENE,
        write: { easing: "linear", end: 3 },
      }),
    ).not.toThrow();

    expect(() =>
      replaceWriteInProgram({
        baseProgram: written.program,
        entityId,
        fragmentMaterial: { texture: true },
        scene: STUDIO_FIXTURE_SCENE,
        write: { easing: "linear", end: 3 },
      }),
    ).toThrow(/texture/);
    const recovered = replaceWriteInProgram({
      baseProgram: written.program,
      entityId,
      fragmentMaterial: { texture: true },
      scene: STUDIO_FIXTURE_SCENE,
      write: null,
    });
    expect(recovered.kind, JSON.stringify(recovered.issues)).toBe("valid");
    expect(writeInClipFromProgram(recovered.program)).toBeNull();
  });

  it("admits Text without a material and preserves removal when a material becomes incompatible", () => {
    const creation = textCreation();
    const entityId = creation.entityIds[0]!;
    const written = replaceWriteInProgram({
      baseProgram: creation.validation.program,
      entityId,
      fragmentMaterial: null,
      scene: STUDIO_FIXTURE_SCENE,
      write: { easing: "linear", end: 2.5 },
    });
    expect(written.kind, JSON.stringify(written.issues)).toBe("valid");
    expect(written.program.loweringStatus).toBe("unsupported");
    expect(writeInClipFromProgram(written.program)).toMatchObject({ entityId, interval: { end: 2.5, start: 1 } });
    expect(() =>
      replaceWriteInProgram({
        baseProgram: written.program,
        entityId,
        fragmentMaterial: { texture: false },
        scene: STUDIO_FIXTURE_SCENE,
        write: { easing: "linear", end: 3 },
      }),
    ).toThrow(/fragment material/i);
    const recovered = replaceWriteInProgram({
      baseProgram: written.program,
      entityId,
      fragmentMaterial: { texture: false },
      scene: STUDIO_FIXTURE_SCENE,
      write: null,
    });
    expect(recovered.kind, JSON.stringify(recovered.issues)).toBe("valid");
    expect(recovered.program.loweringStatus).toBe("supported");
    expect(writeInClipFromProgram(recovered.program)).toBeNull();
  });

  it("rejects unsupported Studio objects", () => {
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
        fragmentMaterial: null,
        scene: STUDIO_FIXTURE_SCENE,
        write: { easing: "linear", end: 2 },
      }),
    ).toThrow(/MathTex and Text/);
  });

  it("rejects Write after a paint color track is present", () => {
    const creation = mathTexCreation();
    const entityId = creation.entityIds[0]!;
    const tracked = replacePaintColorKeyframeProgram({
      baseProgram: creation.validation.program,
      baseline: "#ffffff",
      entityId,
      keyframes: [
        { easing: "linear", time: 2, value: "#ffffff" },
        { easing: "smooth", time: 3, value: "#22c55e" },
      ],
      property: "fillColor",
      scene: STUDIO_FIXTURE_SCENE,
    });

    expect(() =>
      replaceWriteInProgram({
        baseProgram: tracked.program,
        entityId,
        fragmentMaterial: null,
        scene: STUDIO_FIXTURE_SCENE,
        write: { easing: "linear", end: 2.5 },
      }),
    ).toThrow(/paint color track/i);
  });
});
