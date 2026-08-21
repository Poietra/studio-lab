import { describe, expect, it } from "vitest";
import {
  cameraClipFromProgram,
  cameraFocusViewFromPreparedBounds,
  createCameraProgram,
  replaceCameraProgram,
} from "./camera-clip-edit";
import { STUDIO_FIXTURE_SCENE } from "./fixture";

const BASE_VIEW = { center: { x: 0, y: 0 }, frameHeight: 9, frameWidth: 16 } as const;
const FOCUS_VIEW = { center: { x: 4, y: 1 }, frameHeight: 4.5, frameWidth: 8 } as const;

describe("Studio Camera clip editing", () => {
  it("creates and edits one Studio-native camera clip with stable identity", () => {
    const created = createCameraProgram({
      baseView: BASE_VIEW,
      capturedPlayhead: 2,
      easing: "smooth",
      end: 3,
      from: BASE_VIEW,
      scene: STUDIO_FIXTURE_SCENE,
      start: 2,
      to: FOCUS_VIEW,
      transactionId: "camera-focus",
      workspaceOrigin: "studio-native",
    });
    expect(created.kind, JSON.stringify(created.issues)).toBe("valid");
    expect(cameraClipFromProgram(created.program)).toMatchObject({
      easing: "smooth",
      from: BASE_VIEW,
      interval: { end: 3, start: 2 },
      to: FOCUS_VIEW,
      transactionId: "camera-focus",
    });
    expect(created.program.operations[0]).toMatchObject({ kind: "AnimateCamera" });

    const edited = replaceCameraProgram({
      baseProgram: created.program,
      baseView: BASE_VIEW,
      duration: 1.5,
      easing: "linear",
      scene: STUDIO_FIXTURE_SCENE,
    });
    expect(edited.kind, JSON.stringify(edited.issues)).toBe("valid");
    expect(cameraClipFromProgram(edited.program)).toMatchObject({
      easing: "linear",
      interval: { end: 3.5, start: 2 },
      operationId: cameraClipFromProgram(created.program)?.operationId,
    });
  });

  it("derives an aspect-preserving target from exact clip-space bounds", () => {
    expect(
      cameraFocusViewFromPreparedBounds({
        bounds: { bottom: 270, left: 320, right: 480, top: 90 },
        baseView: BASE_VIEW,
        currentView: BASE_VIEW,
        viewport: { height: 360, width: 640 },
      }),
    ).toEqual({
      center: { x: 2, y: 0 },
      frameHeight: 5.625,
      frameWidth: 10,
    });
  });

  it("rejects imported Scenes, aspect changes, and excessive zoom", () => {
    expect(() =>
      createCameraProgram({
        baseView: BASE_VIEW,
        capturedPlayhead: 2,
        easing: "smooth",
        end: 3,
        from: BASE_VIEW,
        scene: STUDIO_FIXTURE_SCENE,
        start: 2,
        to: FOCUS_VIEW,
        transactionId: "imported-camera",
        workspaceOrigin: "imported-manim",
      }),
    ).toThrow(/Studio-native/);
    expect(() =>
      createCameraProgram({
        baseView: BASE_VIEW,
        capturedPlayhead: 2,
        easing: "smooth",
        end: 3,
        from: BASE_VIEW,
        scene: STUDIO_FIXTURE_SCENE,
        start: 2,
        to: { ...FOCUS_VIEW, frameWidth: 9 },
        transactionId: "wrong-aspect",
        workspaceOrigin: "studio-native",
      }),
    ).toThrow(/aspect ratio/);
    expect(() =>
      createCameraProgram({
        baseView: BASE_VIEW,
        capturedPlayhead: 2,
        easing: "smooth",
        end: 3,
        from: BASE_VIEW,
        scene: STUDIO_FIXTURE_SCENE,
        start: 2,
        to: { center: { x: 0, y: 0 }, frameHeight: 0.25, frameWidth: 4 / 9 },
        transactionId: "too-close",
        workspaceOrigin: "studio-native",
      }),
    ).toThrow(/1\/16x/);
  });
});
