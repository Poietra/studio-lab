import { describe, expect, it } from "vitest";

import { STUDIO_STYLE_PROFILE } from "../studio/style-profile";
import { editSuggestionRequestSchema, parseEditSuggestionResult } from "./edit-suggestion-schema";

function remoteSuggestion(operation: unknown) {
  return {
    kind: "suggestion",
    suggestion: {
      assumptions: [],
      confidence: "medium",
      operation,
      provider: "remote",
      summary: "Edit selected objects.",
    },
  };
}

describe("Magic Edit scale and delete contracts", () => {
  it("accepts bounded relative scaling and explicit deletion", () => {
    expect(
      parseEditSuggestionResult(
        remoteSuggestion({
          anchor: { kind: "playhead", referenceSeconds: 5 },
          easing: "smooth",
          end: 6,
          factor: 1.5,
          kind: "scale-objects",
          start: 5,
          targetObjectIds: ["equation"],
        }),
      ).success,
    ).toBe(true);
    expect(
      parseEditSuggestionResult(
        remoteSuggestion({
          anchor: { kind: "absolute", seconds: 5 },
          animation: "fade-out",
          end: 5.4,
          kind: "delete-objects",
          start: 5,
          targetObjectIds: ["equation"],
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects duplicate targets, unsafe factors, and invented style fields", () => {
    const base = {
      anchor: { kind: "playhead", referenceSeconds: 5 },
      easing: "smooth",
      end: 6,
      factor: 1.5,
      kind: "scale-objects",
      start: 5,
      targetObjectIds: ["equation", "equation"],
    };
    expect(parseEditSuggestionResult(remoteSuggestion(base)).success).toBe(false);
    expect(
      parseEditSuggestionResult(
        remoteSuggestion({
          ...base,
          factor: 100,
          targetObjectIds: ["equation"],
        }),
      ).success,
    ).toBe(false);
    expect(
      parseEditSuggestionResult(
        remoteSuggestion({
          ...base,
          color: "red",
          targetObjectIds: ["equation"],
        }),
      ).success,
    ).toBe(false);
  });

  it("carries explicit per-object capabilities in the model context", () => {
    const request = editSuggestionRequestSchema.safeParse({
      clarification: null,
      objects: [
        {
          displayName: "Known equation",
          editCapabilities: {
            delete: { kind: "supported" },
            scale: { current: 1.25, kind: "supported" },
          },
          id: "known",
          lifetimes: [{ end: 10, start: 0 }],
          mathTex: null,
          type: "MathTex",
        },
        {
          displayName: "Runtime group",
          editCapabilities: {
            delete: { kind: "blocked", reason: "Runtime identity is unknown." },
            scale: { kind: "blocked", reason: "Scale comes from a function call." },
          },
          id: "unknown",
          lifetimes: [{ end: 10, start: 0 }],
          mathTex: null,
          type: "VGroup",
        },
      ],
      playhead: 5,
      prompt: "Make the selection larger.",
      scene: { id: "scene.py#Example", name: "Example", nextSceneId: null },
      sceneDuration: 10,
      selectedObjectIds: ["known"],
      styleProfile: STUDIO_STYLE_PROFILE,
    });

    expect(request.success).toBe(true);
  });
});
