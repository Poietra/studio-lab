import { describe, expect, it } from "vitest";

import { planSelectionLayout, type SelectionLayoutTarget } from "./selection-layout";

function target(
  entityId: string,
  bounds: Readonly<{ bottom: number; left: number; right: number; top: number }>,
  position: Readonly<{ x: number; y: number }>,
): SelectionLayoutTarget {
  return { bounds, entityId, position };
}

describe("selection layout", () => {
  const selection = [
    target("b", { bottom: 50, left: 30, right: 50, top: 10 }, { x: 40, y: 30 }),
    target("a", { bottom: 80, left: 80, right: 120, top: 60 }, { x: 100, y: 70 }),
  ] as const;

  it.each([
    ["align-left" as const, { a: { x: 50, y: 70 }, b: { x: 40, y: 30 } }],
    ["align-horizontal-center" as const, { a: { x: 75, y: 70 }, b: { x: 75, y: 30 } }],
    ["align-right" as const, { a: { x: 100, y: 70 }, b: { x: 110, y: 30 } }],
    ["align-top" as const, { a: { x: 100, y: 20 }, b: { x: 40, y: 30 } }],
    ["align-vertical-middle" as const, { a: { x: 100, y: 45 }, b: { x: 40, y: 45 } }],
    ["align-bottom" as const, { a: { x: 100, y: 70 }, b: { x: 40, y: 60 } }],
  ])("plans %s from visual bounds and returns stable entity order", (command, positions) => {
    expect(planSelectionLayout(command, { cameraScale: 1, targets: selection })).toEqual({
      kind: "valid",
      positions,
      targetEntityIds: ["a", "b"],
    });
  });

  it("converts prepared-space corrections through the camera scale", () => {
    const result = planSelectionLayout("align-left", { cameraScale: 2, targets: selection });
    expect(result).toMatchObject({ kind: "valid", positions: { a: { x: 75, y: 70 } } });
  });

  it("distributes unequal widths and heights with equal visual gaps", () => {
    const horizontal = [
      target("left", { bottom: 20, left: 0, right: 10, top: 0 }, { x: 5, y: 10 }),
      target("middle", { bottom: 20, left: 20, right: 50, top: 0 }, { x: 35, y: 10 }),
      target("right", { bottom: 20, left: 90, right: 100, top: 0 }, { x: 95, y: 10 }),
    ];
    expect(planSelectionLayout("distribute-horizontal", { cameraScale: 1, targets: horizontal })).toEqual({
      kind: "valid",
      positions: {
        left: { x: 5, y: 10 },
        middle: { x: 50, y: 10 },
        right: { x: 95, y: 10 },
      },
      targetEntityIds: ["left", "middle", "right"],
    });

    const vertical = [
      target("top", { bottom: 10, left: 0, right: 20, top: 0 }, { x: 10, y: 5 }),
      target("middle", { bottom: 50, left: 0, right: 20, top: 20 }, { x: 10, y: 35 }),
      target("bottom", { bottom: 100, left: 0, right: 20, top: 90 }, { x: 10, y: 95 }),
    ];
    expect(planSelectionLayout("distribute-vertical", { cameraScale: 1, targets: vertical })).toEqual({
      kind: "valid",
      positions: {
        bottom: { x: 10, y: 95 },
        middle: { x: 10, y: 50 },
        top: { x: 10, y: 5 },
      },
      targetEntityIds: ["bottom", "middle", "top"],
    });
  });

  it("fails the whole request for incomplete, invalid, or unchanged input", () => {
    expect(planSelectionLayout("distribute-horizontal", { cameraScale: 1, targets: selection })).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/three/i),
    });
    expect(
      planSelectionLayout("align-left", {
        cameraScale: 1,
        targets: [selection[0], { ...selection[1], entityId: selection[0].entityId }],
      }),
    ).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/complete selection/i) });
    expect(
      planSelectionLayout("align-left", {
        cameraScale: 1,
        targets: [selection[0], target("same", { bottom: 80, left: 30, right: 60, top: 60 }, { x: 45, y: 70 })],
      }),
    ).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/already/i) });
  });
});
