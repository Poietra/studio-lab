import { describe, expect, it, vi } from "vitest";

import { createStudioEntitiesProgram } from "./authoring-commands";
import { runDraftSourcePreflight } from "./draft-apply-preflight";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import { replaceOpacityKeyframeProgram } from "./opacity-keyframe-edit";

function creationProgram() {
  const creation = createStudioEntitiesProgram({
    capturedPlayhead: 1,
    entities: [{ content: undefined, position: { x: 320, y: 180 }, type: "Circle" }],
    scene: STUDIO_FIXTURE_SCENE,
    transactionId: "draft-preflight",
  });
  expect(creation.validation.kind).toBe("valid");
  return creation;
}

describe("draft Apply source preflight", () => {
  it("keeps source preflight for a source-lowerable draft", async () => {
    const creation = creationProgram();
    const sourcePreflight = vi.fn(async () => undefined);

    await runDraftSourcePreflight(creation.validation.program, sourcePreflight);

    expect(sourcePreflight).toHaveBeenCalledOnce();
  });

  it("applies a client-only opacity draft without requesting source preflight", async () => {
    const creation = creationProgram();
    const opacity = replaceOpacityKeyframeProgram({
      baseProgram: creation.validation.program,
      entityId: creation.entityIds[0]!,
      keyframes: [{ easing: "smooth", time: 2, value: 1 }],
      scene: STUDIO_FIXTURE_SCENE,
    });
    const sourcePreflight = vi.fn(async () => undefined);

    await runDraftSourcePreflight(opacity.program, sourcePreflight);

    expect(sourcePreflight).not.toHaveBeenCalled();
  });
});
