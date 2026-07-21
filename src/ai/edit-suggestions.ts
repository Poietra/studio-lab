import { parseEditSuggestionResult } from "./edit-suggestion-schema";

export type SuggestionPoint = Readonly<{ x: number; y: number }>;

export type SuggestionInterval = Readonly<{ end: number; start: number }>;

export type SuggestionMathTexState = Readonly<{
  displayLines: readonly string[];
  texParts: readonly string[];
}>;

export type SuggestionObject = Readonly<{
  displayName: string;
  id: string;
  lifetimes: readonly SuggestionInterval[];
  mathTex: SuggestionMathTexState | null;
  type: string;
}>;

export type EditSuggestionRequest = Readonly<{
  clarification: ClarificationFollowUp | null;
  objects: readonly SuggestionObject[];
  playhead: number;
  prompt: string;
  scene: Readonly<{
    id: string;
    name: string;
    nextSceneId: string | null;
  }>;
  sceneDuration: number;
  selectedObjectIds: readonly string[];
}>;

export type ClarificationOption = Readonly<{
  description: string;
  id: string;
  label: string;
}>;

export type ClarificationAnswer =
  | Readonly<{ kind: "option"; optionId: string }>
  | Readonly<{ kind: "text"; text: string }>;

export type ClarificationTurn = Readonly<{
  answer: ClarificationAnswer;
  options: readonly ClarificationOption[];
  question: string;
}>;

export type ClarificationFollowUp = ClarificationTurn & Readonly<{
  history: readonly ClarificationTurn[];
}>;

export type SuggestionTimeAnchor =
  | Readonly<{ kind: "absolute"; seconds: number }>
  | Readonly<{ kind: "playhead"; referenceSeconds: number }>
  | Readonly<{
      kind: "playhead-offset";
      offsetSeconds: number;
      referenceSeconds: number;
    }>;

export type CreateMotionSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  controlOffset: SuggestionPoint;
  delta: SuggestionPoint;
  easing: "smooth";
  end: number;
  kind: "create-motion";
  start: number;
  targetObjectIds: readonly string[];
}>;

export type MathTexSuggestionTarget = Readonly<{
  displayLines: readonly string[];
  kind: "mathtex";
  label: string;
  texParts: readonly string[];
}>;

export type CreateTransformSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  easing: "smooth";
  end: number;
  identityAfter: "target-replaces-source";
  kind: "create-transform";
  mismatchMode: "transform";
  sourceObjectId: string;
  start: number;
  strategy: "transform-matching-tex";
  target: MathTexSuggestionTarget;
}>;

export type CreateExplanationSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  animation: "fade-in";
  end: number;
  kind: "create-explanation";
  objectKind: "text";
  placement: "above" | "below" | "left" | "right";
  start: number;
  targetObjectId: string;
  text: string;
}>;

export type CreateSceneTransitionSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  color: "black" | "sky" | "white";
  destination: "next-scene";
  easing: "smooth";
  end: number;
  kind: "create-scene-transition";
  shape: "circle" | "diamond" | "hexagon";
  start: number;
  style: "cover-reveal";
}>;

export type CreateCameraFocusSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  easing: "smooth";
  emphasisScale: number;
  end: number;
  kind: "create-camera-focus";
  start: number;
  targetObjectIds: readonly string[];
  zoomScale: number;
}>;

export type CreateEquationSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  animation: "fade-in";
  end: number;
  kind: "create-equation";
  placement: "center" | "right";
  start: number;
  target: MathTexSuggestionTarget;
}>;

export type CreateExplainedEquationSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  animation: "fade-in";
  end: number;
  explanation: Readonly<{
    placement: "above" | "below" | "left" | "right";
    text: string;
  }>;
  kind: "create-explained-equation";
  placement: "center" | "right";
  start: number;
  target: MathTexSuggestionTarget;
}>;

export type CreateTextTransformSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  easing: "smooth";
  end: number;
  kind: "create-text-transform";
  sourceObjectId: string;
  start: number;
  strategy: "replacement-transform";
  text: string;
}>;

export type EditSuggestionLeafOperation =
  | CreateCameraFocusSuggestion
  | CreateEquationSuggestion
  | CreateExplainedEquationSuggestion
  | CreateTextTransformSuggestion
  | CreateMotionSuggestion
  | CreateTransformSuggestion
  | CreateExplanationSuggestion
  | CreateSceneTransitionSuggestion;

export type EditProgramStep =
  | Omit<CreateMotionSuggestion, "anchor">
  | Omit<CreateTransformSuggestion, "anchor">
  | Omit<CreateExplanationSuggestion, "anchor">
  | Omit<CreateEquationSuggestion, "anchor">
  | Omit<CreateExplainedEquationSuggestion, "anchor">
  | Omit<CreateSceneTransitionSuggestion, "anchor">;

export type EditProgramSuggestion = Readonly<{
  anchor: SuggestionTimeAnchor;
  execution: "parallel" | "sequence";
  kind: "edit-program";
  operations: readonly EditProgramStep[];
}>;

export type EditSuggestionOperation = EditSuggestionLeafOperation | EditProgramSuggestion;

export type EditSuggestion = Readonly<{
  assumptions: readonly string[];
  confidence: "medium";
  operation: EditSuggestionOperation;
  provider: "remote";
  summary: string;
}>;

export type EditSuggestionResult =
  | Readonly<{ kind: "suggestion"; suggestion: EditSuggestion }>
  | Readonly<{
      kind: "clarification";
      message: string;
      options: readonly ClarificationOption[];
    }>;

type SuggestionOptions = Readonly<{ signal?: AbortSignal }>;

export async function suggestEdit(
  request: EditSuggestionRequest,
  options: SuggestionOptions = {},
): Promise<EditSuggestionResult> {
  const endpoint = import.meta.env.VITE_POIETRA_AI_ENDPOINT as string | undefined;
  if (!endpoint) {
    throw new Error("Magic Edit requires a configured AI endpoint. Set VITE_POIETRA_AI_ENDPOINT and restart Studio.");
  }

  const response = await fetch(endpoint, {
    body: JSON.stringify(request),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: options.signal,
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message = typeof result === "object"
      && result !== null
      && "error" in result
      && typeof result.error === "string"
      ? result.error
      : `Suggestion endpoint returned ${response.status}.`;
    throw new Error(message);
  }
  const parsedRemote = parseEditSuggestionResult(result);
  if (!parsedRemote.success) throw new Error("Suggestion endpoint returned an invalid operation.");
  if (parsedRemote.data.kind === "suggestion") {
    return {
      ...parsedRemote.data,
      suggestion: { ...parsedRemote.data.suggestion, provider: "remote" },
    };
  }
  return parsedRemote.data;
}
