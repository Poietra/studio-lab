import { describe, expect, it } from "vitest";

import { STUDIO_FIXTURE_SCENE } from "../studio/fixture";
import { STUDIO_STYLE_PROFILE } from "../studio/style-profile";
import { createClarificationContextFingerprint } from "./clarification";
import { editSuggestionRequestSchema, parseEditSuggestionResult } from "./edit-suggestion-schema";

const options = [
  {
    description: "Replace the selected MathTex while preserving its timeline placement.",
    id: "option-1",
    label: "Replace selected",
  },
  {
    description: "Keep the selected MathTex and create a second equation.",
    id: "option-2",
    label: "Add new equation",
  },
] as const;

describe("bounded clarification context", () => {
  it("invalidates a pending question when captured editor context changes", () => {
    const entities = Object.values(STUDIO_FIXTURE_SCENE.objectGraph.entities);
    const captured = createClarificationContextFingerprint({
      entities,
      playhead: 5,
      selection: ["label_1", "equation_1"],
    });
    expect(
      createClarificationContextFingerprint({
        entities,
        playhead: 5,
        selection: ["equation_1", "label_1"],
      }),
    ).toBe(captured);
    expect(
      createClarificationContextFingerprint({
        entities,
        playhead: 5.25,
        selection: ["equation_1", "label_1"],
      }),
    ).not.toBe(captured);
  });

  it("accepts structured choices from the remote endpoint", () => {
    const parsed = parseEditSuggestionResult({
      kind: "clarification",
      message: "Should Studio replace the selected equation or add a new one?",
      options,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.kind !== "clarification") return;
    expect(parsed.data.options.map((option) => option.id)).toEqual(["option-1", "option-2"]);
  });

  it("keeps the original prompt, question, choices and selected option in one follow-up", () => {
    const parsed = editSuggestionRequestSchema.safeParse({
      clarification: {
        answer: { kind: "option", optionId: "option-1" },
        history: [],
        options,
        question: "Should Studio replace the selected equation or add a new one?",
      },
      objects: [
        {
          displayName: "Energy equation",
          editCapabilities: {
            delete: { kind: "supported" },
            scale: { current: 1, kind: "supported" },
          },
          id: "equation_1",
          lifetimes: [{ end: 12, start: 0 }],
          mathTex: { displayLines: ["E = mc²"], texParts: ["E", "=", "m", "c^2"] },
          type: "MathTex",
        },
      ],
      playhead: 5,
      prompt: "Make this Maxwell equations, either by replacing it or adding a new equation.",
      scene: { id: "scene.py#Current", name: "Current", nextSceneId: "scene.py#Next" },
      sceneDuration: 12,
      selectedObjectIds: ["equation_1"],
      styleProfile: STUDIO_STYLE_PROFILE,
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts relative free-text answers without replacing the original prompt", () => {
    const parsed = editSuggestionRequestSchema.safeParse({
      clarification: {
        answer: { kind: "text", text: "前者" },
        history: [],
        options,
        question: "Should Studio replace the selected equation or add a new one?",
      },
      objects: [],
      playhead: 5,
      prompt: "Make this Maxwell equations, either by replacing it or adding a new equation.",
      scene: { id: "scene.py#Current", name: "Current", nextSceneId: "scene.py#Next" },
      sceneDuration: 12,
      selectedObjectIds: [],
      styleProfile: STUDIO_STYLE_PROFILE,
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps earlier resolved questions when the model asks a follow-up", () => {
    const parsed = editSuggestionRequestSchema.safeParse({
      clarification: {
        answer: { kind: "text", text: "はい" },
        history: [
          {
            answer: { kind: "option", optionId: "option-2" },
            options,
            question: "Should Studio replace the selected equation or add a new one?",
          },
        ],
        options: [],
        question: "Should Studio preview the explanation after adding the equation?",
      },
      objects: [],
      playhead: 5,
      prompt: "Add Maxwell equations and explain them in the next Scene.",
      scene: { id: "scene.py#Current", name: "Current", nextSceneId: "scene.py#Next" },
      sceneDuration: 12,
      selectedObjectIds: [],
      styleProfile: STUDIO_STYLE_PROFILE,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.clarification?.history).toHaveLength(1);
  });

  it("rejects stale option answers and duplicate response option identities at the shared contract", () => {
    const request = editSuggestionRequestSchema.safeParse({
      clarification: {
        answer: { kind: "option", optionId: "option-missing" },
        history: [],
        options,
        question: "Which edit should Studio make?",
      },
      objects: [],
      playhead: 5,
      prompt: "Update the equation.",
      scene: { id: "scene.py#Current", name: "Current", nextSceneId: null },
      sceneDuration: 12,
      selectedObjectIds: [],
      styleProfile: STUDIO_STYLE_PROFILE,
    });
    const result = parseEditSuggestionResult({
      kind: "clarification",
      message: "Which edit should Studio make?",
      options: [options[0], { ...options[1], id: options[0].id }],
    });

    expect(request.success).toBe(false);
    expect(result.success).toBe(false);
  });
});
