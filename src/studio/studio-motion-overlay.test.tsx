import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StudioMotionOverlay } from "./studio-motion-overlay";

describe("StudioMotionOverlay", () => {
  it("serializes every Rust-projected cubic segment without adding editable TS control geometry", () => {
    const markup = renderToStaticMarkup(
      <StudioMotionOverlay
        dragPreview={null}
        editableMotionIds={new Set(["pen-motion"])}
        entities={[]}
        interactionMode="animate"
        motionPaths={[
          {
            end: { x: 50, y: 40 },
            entityId: "circle",
            interval: { end: 3, start: 2 },
            kind: "cubic",
            motionId: "pen-motion",
            path: {
              closed: false,
              segments: [
                {
                  control1: { x: 16, y: 8 },
                  control2: { x: 24, y: 32 },
                  end: { x: 30, y: 20 },
                },
                {
                  control1: { x: 36, y: 8 },
                  control2: { x: 44, y: 52 },
                  end: { x: 50, y: 40 },
                },
              ],
              start: { x: 10, y: 20 },
            },
            pathEntityId: "pen",
            start: { x: 10, y: 20 },
          },
        ]}
        onMotionControlChange={vi.fn()}
      />,
    );

    expect(markup).toContain('data-motion-path="pen-motion"');
    expect(markup).toContain('data-motion-path-kind="cubic"');
    expect(markup).toContain('data-motion-path-source="pen"');
    expect(markup).toContain('d="M 10 20 C 16 8 24 32 30 20 C 36 8 44 52 50 40"');
    expect(markup).not.toContain("data-motion-control");
  });
});
