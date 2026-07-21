import { parseEditSuggestionResult } from "./edit-suggestion-schema";

export type SuggestionPoint = {
  x: number;
  y: number;
};

export type SuggestionInterval = {
  start: number;
  end: number;
};

export type SuggestionMathTexState = {
  displayLines: readonly string[];
  texParts: readonly string[];
};

export type SuggestionObject = {
  displayName: string;
  id: string;
  lifetimes: readonly SuggestionInterval[];
  mathTex: SuggestionMathTexState | null;
  type: string;
};

export type EditSuggestionRequest = {
  objects: readonly SuggestionObject[];
  playhead: number;
  prompt: string;
  sceneDuration: number;
  selectedObjectIds: readonly string[];
};

export type SuggestionTimeAnchor =
  | {
      kind: "absolute";
      seconds: number;
    }
  | {
      kind: "playhead";
      referenceSeconds: number;
    }
  | {
      kind: "playhead-offset";
      offsetSeconds: number;
      referenceSeconds: number;
    };

export type CreateMotionSuggestion = {
  anchor: SuggestionTimeAnchor;
  controlOffset: SuggestionPoint;
  delta: SuggestionPoint;
  easing: "smooth";
  end: number;
  kind: "create-motion";
  start: number;
  targetObjectIds: readonly string[];
};

export type MathTexSuggestionTarget = {
  displayLines: readonly string[];
  kind: "mathtex";
  label: string;
  texParts: readonly string[];
};

export type CreateTransformSuggestion = {
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
};

export type CreateExplanationSuggestion = {
  anchor: SuggestionTimeAnchor;
  animation: "fade-in";
  end: number;
  kind: "create-explanation";
  objectKind: "text";
  placement: "above" | "below" | "left" | "right";
  start: number;
  targetObjectId: string;
  text: string;
};

export type CreateSceneTransitionSuggestion = {
  anchor: SuggestionTimeAnchor;
  color: "black" | "sky" | "white";
  destination: "next-scene";
  easing: "smooth";
  end: number;
  kind: "create-scene-transition";
  shape: "circle" | "diamond" | "hexagon";
  start: number;
  style: "cover-reveal";
};

export type CreateCameraFocusSuggestion = {
  anchor: SuggestionTimeAnchor;
  easing: "smooth";
  emphasisScale: number;
  end: number;
  kind: "create-camera-focus";
  start: number;
  targetObjectIds: readonly string[];
  zoomScale: number;
};

export type CreateEquationSuggestion = {
  anchor: SuggestionTimeAnchor;
  animation: "fade-in";
  end: number;
  kind: "create-equation";
  placement: "center" | "right";
  start: number;
  target: MathTexSuggestionTarget;
};

export type CreateTextTransformSuggestion = {
  anchor: SuggestionTimeAnchor;
  easing: "smooth";
  end: number;
  kind: "create-text-transform";
  sourceObjectId: string;
  start: number;
  strategy: "replacement-transform";
  text: string;
};

export type EditSuggestionLeafOperation =
  | CreateCameraFocusSuggestion
  | CreateEquationSuggestion
  | CreateTextTransformSuggestion
  | CreateMotionSuggestion
  | CreateTransformSuggestion
  | CreateExplanationSuggestion
  | CreateSceneTransitionSuggestion;

export type EditProgramStep =
  | Omit<CreateMotionSuggestion, "anchor">
  | Omit<CreateTransformSuggestion, "anchor">
  | Omit<CreateExplanationSuggestion, "anchor">;

export type EditProgramSuggestion = {
  anchor: SuggestionTimeAnchor;
  execution: "parallel" | "sequence";
  kind: "edit-program";
  operations: readonly EditProgramStep[];
};

export type EditSuggestionOperation = EditSuggestionLeafOperation | EditProgramSuggestion;

export type EditSuggestion = {
  assumptions: readonly string[];
  confidence: "medium";
  operation: EditSuggestionOperation;
  provider: "fixture" | "remote";
  summary: string;
};

export type EditSuggestionResult =
  | {
      kind: "suggestion";
      suggestion: EditSuggestion;
    }
  | {
      kind: "clarification";
      message: string;
    };

type SuggestionOptions = {
  signal?: AbortSignal;
};

const DEFAULT_DURATION = 1.5;
const MAXWELL_TARGET: MathTexSuggestionTarget = {
  displayLines: [
    "∇·E = ρ/ε₀",
    "∇·B = 0",
    "∇×E = −∂B/∂t",
    "∇×B = μ₀J + μ₀ε₀∂E/∂t",
  ],
  kind: "mathtex",
  label: "Maxwell's equations",
  texParts: [String.raw`\begin{aligned}\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\ \nabla \cdot \mathbf{B} &= 0 \\ \nabla \times \mathbf{E} &= -\frac{\partial \mathbf{B}}{\partial t} \\ \nabla \times \mathbf{B} &= \mu_0 \mathbf{J} + \mu_0 \varepsilon_0 \frac{\partial \mathbf{E}}{\partial t}\end{aligned}`],
};

const NEWTON_TARGET: MathTexSuggestionTarget = {
  displayLines: ["F = ma"],
  kind: "mathtex",
  label: "Newton's equation of motion",
  texParts: ["F", "=", "m", "a"],
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseNumber(value: string | undefined) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

type ParsedAnchor = {
  anchor: SuggestionTimeAnchor;
  start: number;
};

function parseAnchor(prompt: string, fallback: number, sceneDuration: number): ParsedAnchor | null {
  if (includesAny(prompt, ["直前", "immediately before", "just before"])) {
    const start = fallback - 1;
    if (start < 0 || start > sceneDuration) return null;
    return {
      anchor: { kind: "playhead-offset", offsetSeconds: -1, referenceSeconds: fallback },
      start,
    };
  }
  const japaneseRelative = prompt.match(/(\d+(?:\.\d+)?)\s*秒(?:前|まえ)/);
  const englishRelative = prompt.match(/(\d+(?:\.\d+)?)\s*(?:s|sec(?:ond)?s?)\s*(?:before|earlier|ago)/i);
  const relative = parseNumber(japaneseRelative?.[1] ?? englishRelative?.[1]);
  if (relative !== undefined) {
    const start = fallback - relative;
    if (start < 0 || start > sceneDuration) return null;
    return {
      anchor: { kind: "playhead-offset", offsetSeconds: -relative, referenceSeconds: fallback },
      start,
    };
  }
  const japanese = prompt.match(/(\d+(?:\.\d+)?)\s*秒(?:の)?(?:時点|から)/);
  const english = prompt.match(/(?:at|from)\s+(\d+(?:\.\d+)?)\s*(?:s|sec(?:ond)?s?)?\b/i);
  const parsed = parseNumber(japanese?.[1] ?? english?.[1]);
  if (parsed !== undefined) {
    if (parsed < 0 || parsed > sceneDuration) return null;
    return { anchor: { kind: "absolute", seconds: parsed }, start: parsed };
  }
  return { anchor: { kind: "playhead", referenceSeconds: fallback }, start: fallback };
}

function parseDuration(prompt: string) {
  const japanese = prompt.match(/(\d+(?:\.\d+)?)\s*秒(?:間|かけて)/);
  const english = prompt.match(/(?:over|for|during)\s+(\d+(?:\.\d+)?)\s*(?:s|sec(?:ond)?s?)\b/i);
  return clamp(parseNumber(japanese?.[1] ?? english?.[1]) ?? DEFAULT_DURATION, 0.1, 5);
}

function parseDistance(prompt: string) {
  const pixels = prompt.match(/(\d+(?:\.\d+)?)\s*(?:px|pixels?|ピクセル)/i);
  return clamp(parseNumber(pixels?.[1]) ?? 96, 8, 220);
}

function includesAny(prompt: string, terms: readonly string[]) {
  const normalized = prompt.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function parseDelta(prompt: string): SuggestionPoint | null {
  const distance = parseDistance(prompt);
  const horizontal = /\bright\b/i.test(prompt) || /右(?:へ|に|方向)?/.test(prompt)
    ? distance
    : /\bleft\b/i.test(prompt) || /左(?:へ|に|方向)?/.test(prompt)
      ? -distance
      : 0;
  const verticalDistance = Math.min(distance, 100);
  const vertical = /\bup\b/i.test(prompt) || /上(?:へ|に|方向)/.test(prompt)
    ? -verticalDistance
    : /\bdown\b/i.test(prompt) || /下(?:へ|に|方向)/.test(prompt)
      ? verticalDistance
      : 0;
  if (horizontal === 0 && vertical === 0) return null;
  return { x: horizontal, y: vertical };
}

function parseControlOffset(prompt: string, delta: SuggestionPoint): SuggestionPoint {
  if (!includesAny(prompt, ["arc", "curve", "curved", "弧", "カーブ", "曲線"])) {
    return { x: 0, y: 0 };
  }
  const bowsDown = includesAny(prompt, ["downward arc", "arc down", "下向き", "下に膨ら"]);
  const magnitude = clamp(Math.max(Math.abs(delta.x), Math.abs(delta.y)) * 0.45, 24, 72);
  return { x: 0, y: bowsDown ? magnitude : -magnitude };
}

function lifetimeAt(object: SuggestionObject, time: number) {
  return object.lifetimes.find((interval) => time >= interval.start && time < interval.end);
}

function summarizeDelta(delta: SuggestionPoint) {
  const parts: string[] = [];
  if (delta.x !== 0) parts.push(`${Math.abs(delta.x)} px ${delta.x > 0 ? "right" : "left"}`);
  if (delta.y !== 0) parts.push(`${Math.abs(delta.y)} px ${delta.y > 0 ? "down" : "up"}`);
  return parts.join(" and ");
}

function explanationText(prompt: string) {
  const quoted = prompt.match(/[「『“"]([^」』”"]{1,120})[」』”"]/u)?.[1]?.trim();
  if (quoted) return quoted;
  if (includesAny(prompt, ["maxwell", "マクスウェル"])) {
    return "電場と磁場の変化が互いを生み出します";
  }
  if (includesAny(prompt, ["newton", "ニュートン"])) {
    return "力は質量と加速度の積です";
  }
  return "この式の意味を、項どうしの関係から読み解きます";
}

function asksForExplanation(prompt: string) {
  return includesAny(prompt, ["説明", "解説", "注釈", "explain", "explanation", "explanatory", "annotate", "annotation"])
    && includesAny(prompt, ["文字", "テキスト", "text", "label", "caption", "annotation", "出現", "表示", "show", "add"]);
}

function asksForSceneTransition(prompt: string) {
  return includesAny(prompt, [
    "scene change",
    "scene transition",
    "transition to the next scene",
    "シーンチェンジ",
    "シーン切り替",
    "次のシーン",
    "場面転換",
  ]);
}

function asksForCameraFocus(prompt: string) {
  return includesAny(prompt, ["camera", "zoom", "カメラ", "ズーム", "寄せ"])
    && includesAny(prompt, ["focus", "emphasize", "highlight", "important", "強調", "重要", "注目"]);
}

function asksForNewEquation(prompt: string) {
  return includesAny(prompt, [
    "add equation",
    "create equation",
    "new equation",
    "write equation",
    "あたらしく数式",
    "新しく数式",
    "新しい数式",
    "数式を書",
    "数式を追加",
  ]);
}

function asksForTextTransform(prompt: string) {
  return includesAny(prompt, [
    "transform into text",
    "transform into words",
    "文字に変形",
    "文字へ変形",
    "テキストに変形",
    "文章に変形",
  ]);
}

function transitionShape(prompt: string): CreateSceneTransitionSuggestion["shape"] {
  if (includesAny(prompt, ["circle", "circular", "円", "丸"])) return "circle";
  if (includesAny(prompt, ["hexagon", "hexagonal", "六角"])) return "hexagon";
  return "diamond";
}

function transitionColor(prompt: string): CreateSceneTransitionSuggestion["color"] {
  if (includesAny(prompt, ["white", "白"])) return "white";
  if (includesAny(prompt, ["black", "黒"])) return "black";
  return "sky";
}

function unsupportedIntent(prompt: string) {
  const intents = [
    { label: "rotation", terms: ["rotate", "rotation", "回転"] },
    { label: "scale", terms: ["scale", "resize", "拡大", "縮小"] },
    { label: "opacity", terms: ["opacity", "transparent", "透明"] },
    { label: "deletion", terms: ["delete", "remove", "消して", "削除"] },
  ] as const;
  return intents.find((intent) => includesAny(prompt, intent.terms))?.label ?? null;
}

function mathTexMatches(object: SuggestionObject, target: MathTexSuggestionTarget) {
  return object.mathTex !== null
    && object.mathTex.displayLines.length === target.displayLines.length
    && object.mathTex.displayLines.every((line, index) => line === target.displayLines[index])
    && object.mathTex.texParts.length === target.texParts.length
    && object.mathTex.texParts.every((part, index) => part === target.texParts[index]);
}

export function suggestEditWithFixture(request: EditSuggestionRequest): EditSuggestionResult {
  const prompt = request.prompt.trim();
  if (prompt.length === 0) {
    return { kind: "clarification", message: "Describe a direction or destination for the selected object." };
  }
  const unsupported = unsupportedIntent(prompt);
  if (unsupported) {
    return {
      kind: "clarification",
      message: `This request includes ${unsupported}, which Studio cannot preview safely yet. Remove that effect or use a supported motion, MathTex transform, or explanation Text operation.`,
    };
  }

  const parsedAnchor = parseAnchor(prompt, request.playhead, request.sceneDuration);
  if (!parsedAnchor) {
    return {
      kind: "clarification",
      message: "The requested time is outside this Scene. Choose a time between 0 and the Scene end.",
    };
  }
  const { anchor, start } = parsedAnchor;
  const namedTarget = includesAny(prompt, ["maxwell", "マクスウェル"])
    ? MAXWELL_TARGET
    : includesAny(prompt, ["newton", "ニュートン"])
      ? NEWTON_TARGET
      : null;
  if (asksForSceneTransition(prompt)) {
    const end = Math.min(start + parseDuration(prompt), request.sceneDuration);
    if (end - start < 0.4) {
      return {
        kind: "clarification",
        message: "There is not enough Scene time remaining for a cover-and-reveal transition.",
      };
    }
    const shape = transitionShape(prompt);
    const color = transitionColor(prompt);
    return {
      kind: "suggestion",
      suggestion: {
        assumptions: [
          `“良い感じ” is resolved to the bounded ${shape} shape preset with the ${color} palette.`,
          "The shape covers the frame during the first half and reveals the next Scene during the second half.",
          "The transition is Scene-level and does not require or modify the selected object.",
        ],
        confidence: "medium",
        operation: {
          anchor,
          color,
          destination: "next-scene",
          easing: "smooth",
          end,
          kind: "create-scene-transition",
          shape,
          start,
          style: "cover-reveal",
        },
        provider: "fixture",
        summary: `Create a ${shape} cover-and-reveal transition to the next Scene from ${start.toFixed(2)}s.`,
      },
    };
  }
  if (asksForNewEquation(prompt)) {
    const end = Math.min(start + Math.min(parseDuration(prompt), 1), request.sceneDuration);
    if (end - start < 0.1) {
      return { kind: "clarification", message: "There is not enough Scene time remaining to create the equation." };
    }
    const target = namedTarget ?? NEWTON_TARGET;
    return {
      kind: "suggestion",
      suggestion: {
        assumptions: [
          namedTarget
            ? `${target.label} is used as the requested conventional equation.`
            : "No formula was supplied, so F = ma is used as a visible, reversible preview default.",
          "A new MathTex entity is created on the right side of the frame; the existing equation is not replaced.",
          "The new entity persists after FadeIn and is applied or undone as one transaction.",
        ],
        confidence: "medium",
        operation: {
          anchor,
          animation: "fade-in",
          end,
          kind: "create-equation",
          placement: "right",
          start,
          target,
        },
        provider: "fixture",
        summary: `Create a new ${target.label} MathTex entity from ${start.toFixed(2)}s.`,
      },
    };
  }
  const selectedObjects = request.objects.filter((object) => request.selectedObjectIds.includes(object.id));
  const visibleSelection = selectedObjects
    .map((object) => ({ object, lifetime: lifetimeAt(object, start) }))
    .filter((entry): entry is { object: SuggestionObject; lifetime: SuggestionInterval } => entry.lifetime !== undefined);

  if (visibleSelection.length === 0) {
    return {
      kind: "clarification",
      message: `The selected object is not present at ${start.toFixed(2)}s. Choose another time or object.`,
    };
  }

  if (asksForCameraFocus(prompt)) {
    const latestEnd = Math.min(request.sceneDuration, ...visibleSelection.map((entry) => entry.lifetime.end));
    const end = Math.min(start + parseDuration(prompt), latestEnd);
    if (end - start < 0.1) {
      return { kind: "clarification", message: "There is not enough visible time remaining for the camera focus." };
    }
    return {
      kind: "suggestion",
      suggestion: {
        assumptions: [
          "The camera uses a bounded 1.35× zoom while the selected visible object scales to 1.12×.",
          "The selected object is the important region because no smaller semantic sub-part is available in the fixture.",
          "Camera and emphasis channels share one captured interval and one Apply/Undo boundary.",
        ],
        confidence: "medium",
        operation: {
          anchor,
          easing: "smooth",
          emphasisScale: 1.12,
          end,
          kind: "create-camera-focus",
          start,
          targetObjectIds: visibleSelection.map((entry) => entry.object.id),
          zoomScale: 1.35,
        },
        provider: "fixture",
        summary: `Focus the camera and emphasize ${visibleSelection.map((entry) => entry.object.displayName).join(", ")} from ${start.toFixed(2)}s.`,
      },
    };
  }

  if (asksForTextTransform(prompt)) {
    const source = visibleSelection.find((entry) => entry.object.type === "MathTex");
    if (!source) {
      return { kind: "clarification", message: "Select one visible MathTex object to transform into explanatory text." };
    }
    const end = Math.min(start + parseDuration(prompt), source.lifetime.end, request.sceneDuration);
    if (end - start < 0.1) {
      return { kind: "clarification", message: "There is not enough visible time remaining for the text transform." };
    }
    const text = explanationText(prompt);
    return {
      kind: "suggestion",
      suggestion: {
        assumptions: [
          "“直前” is resolved once as one second before the captured playhead.",
          "The selected MathTex is replaced by a Text runtime identity containing the explanatory sentence.",
          "The browser preview is semantic; final glyph-level rendering remains illustrative.",
        ],
        confidence: "medium",
        operation: {
          anchor,
          easing: "smooth",
          end,
          kind: "create-text-transform",
          sourceObjectId: source.object.id,
          start,
          strategy: "replacement-transform",
          text,
        },
        provider: "fixture",
        summary: `Transform ${source.object.displayName} into explanatory Text from ${start.toFixed(2)}s.`,
      },
    };
  }

  const delta = parseDelta(prompt);
  const wantsExplanation = asksForExplanation(prompt);

  if (delta && (namedTarget || wantsExplanation)) {
    if (visibleSelection.length !== 1) {
      return {
        kind: "clarification",
        message: "Select one visible object so Studio can preserve the target across every requested step.",
      };
    }
    if (includesAny(prompt, ["同時", "simultaneously", "at the same time"])) {
      return {
        kind: "clarification",
        message: "Moving and rewriting or observing the same object in parallel has conflicting dependencies. Specify which effect should happen first.",
      };
    }
    const target = visibleSelection[0].object;
    if (namedTarget && target.type !== "MathTex") {
      return {
        kind: "clarification",
        message: `Select one visible MathTex object to transform into ${namedTarget.label}.`,
      };
    }
    const expectsTransform = namedTarget !== null && !mathTexMatches(target, namedTarget);
    const expectedOperationCount = 1 + (expectsTransform ? 1 : 0) + (wantsExplanation ? 1 : 0);
    const operations: EditProgramStep[] = [];
    let cursor = start;
    const motionEnd = Math.min(cursor + parseDuration(prompt), request.sceneDuration, visibleSelection[0].lifetime.end);
    if (motionEnd - cursor >= 0.1) {
      operations.push({
        controlOffset: parseControlOffset(prompt, delta),
        delta,
        easing: "smooth",
        end: motionEnd,
        kind: "create-motion",
        start: cursor,
        targetObjectIds: [target.id],
      });
      cursor = motionEnd;
    }
    if (namedTarget && expectsTransform) {
      const transformEnd = Math.min(cursor + parseDuration(prompt), request.sceneDuration, visibleSelection[0].lifetime.end);
      if (transformEnd - cursor >= 0.1) {
        operations.push({
          easing: "smooth",
          end: transformEnd,
          identityAfter: "target-replaces-source",
          kind: "create-transform",
          mismatchMode: "transform",
          sourceObjectId: target.id,
          start: cursor,
          strategy: "transform-matching-tex",
          target: namedTarget,
        });
        cursor = transformEnd;
      }
    }
    if (wantsExplanation) {
      const explanationEnd = Math.min(cursor + Math.min(parseDuration(prompt), 1), request.sceneDuration, visibleSelection[0].lifetime.end);
      if (explanationEnd - cursor >= 0.1) {
        operations.push({
          animation: "fade-in",
          end: explanationEnd,
          kind: "create-explanation",
          objectKind: "text",
          placement: "right",
          start: cursor,
          targetObjectId: target.id,
          text: explanationText(prompt),
        });
      }
    }
    if (operations.length !== expectedOperationCount || operations.length < 2) {
      return {
        kind: "clarification",
        message: "There is not enough visible Scene time to schedule every requested effect.",
      };
    }
    return {
      kind: "suggestion",
      suggestion: {
        assumptions: [
          "The sentence was decomposed into every supported effect instead of choosing only one verb.",
          "Effects on the same object run in sequence to preserve position, identity replacement, and target-relative placement.",
          "The whole Edit Program is previewed, applied, and undone atomically.",
        ],
        confidence: "medium",
        operation: {
          anchor,
          execution: "sequence",
          kind: "edit-program",
          operations,
        },
        provider: "fixture",
        summary: `Run ${operations.length} requested edits on ${target.displayName} from ${start.toFixed(2)}s as one Edit Program.`,
      },
    };
  }

  if (wantsExplanation) {
    if (visibleSelection.length !== 1) {
      return {
        kind: "clarification",
        message: "Select one visible object to receive the explanation text.",
      };
    }
    const end = Math.min(start + Math.min(parseDuration(prompt), 1), request.sceneDuration);
    if (end - start < 0.1) {
      return { kind: "clarification", message: "There is not enough Scene time remaining for FadeIn." };
    }
    const target = visibleSelection[0].object;
    if (namedTarget && target.type === "MathTex" && !mathTexMatches(target, namedTarget)) {
      return {
        kind: "suggestion",
        suggestion: {
          assumptions: [
            `The selected MathTex is first transformed into ${namedTarget.label}.`,
            "The explanation Text is positioned relative to the replacement target and appears in the same parallel play.",
            "Transform and FadeIn share one captured time anchor and are applied and undone atomically.",
          ],
          confidence: "medium",
          operation: {
            anchor,
            execution: "parallel",
            kind: "edit-program",
            operations: [
              {
                easing: "smooth",
                end,
                identityAfter: "target-replaces-source",
                kind: "create-transform",
                mismatchMode: "transform",
                sourceObjectId: target.id,
                start,
                strategy: "transform-matching-tex",
                target: namedTarget,
              },
              {
                animation: "fade-in",
                end,
                kind: "create-explanation",
                objectKind: "text",
                placement: "right",
                start,
                targetObjectId: target.id,
                text: explanationText(prompt),
              },
            ],
          },
          provider: "fixture",
          summary: `Transform ${target.displayName} into ${namedTarget.label} and create explanation text in one parallel Edit Program from ${start.toFixed(2)}s.`,
        },
      };
    }
    return {
      kind: "suggestion",
      suggestion: {
        assumptions: [
          "The requested past time is resolved relative to the visible playhead before preview.",
          "A new Text object is placed to the right of the selected object and persists after FadeIn.",
          "The selected source object keeps its identity and content.",
        ],
        confidence: "medium",
        operation: {
          anchor,
          animation: "fade-in",
          end,
          kind: "create-explanation",
          objectKind: "text",
          placement: "right",
          start,
          targetObjectId: target.id,
          text: explanationText(prompt),
        },
        provider: "fixture",
        summary: `Create explanation text beside ${target.displayName} from ${start.toFixed(2)}s.`,
      },
    };
  }

  if (namedTarget) {
    const source = visibleSelection.find((entry) => entry.object.type === "MathTex");
    if (!source) {
      return {
        kind: "clarification",
        message: `Select one visible MathTex object to transform into ${namedTarget.label}.`,
      };
    }
    const end = Math.min(start + parseDuration(prompt), source.lifetime.end, request.sceneDuration);
    if (end - start < 0.1) {
      return { kind: "clarification", message: "There is not enough visible time remaining for the transform." };
    }
    return {
      kind: "suggestion",
      suggestion: {
        assumptions: [
          "The instruction creates a TransformMatchingTex animation at the playhead.",
          "Exact TeX parts shared by the source and target remain continuous; unmatched groups morph with transform_mismatches=True.",
          "The target replaces the source runtime identity after cleanup; the exported variable is rebound.",
        ],
        confidence: "medium",
        operation: {
          anchor,
          easing: "smooth",
          end,
          identityAfter: "target-replaces-source",
          kind: "create-transform",
          mismatchMode: "transform",
          sourceObjectId: source.object.id,
          start,
          strategy: "transform-matching-tex",
          target: namedTarget,
        },
        provider: "fixture",
        summary: `Transform ${source.object.displayName} into ${namedTarget.label} from ${start.toFixed(2)}s to ${end.toFixed(2)}s.`,
      },
    };
  }

  if (!delta) {
    return {
      kind: "clarification",
      message: "I found the time anchor, but not the spatial change. Try “move 96 px right in an upward arc.”",
    };
  }

  const requestedDuration = parseDuration(prompt);
  const latestEnd = Math.min(
    request.sceneDuration,
    ...visibleSelection.map((entry) => entry.lifetime.end),
  );
  const end = Math.min(start + requestedDuration, latestEnd);
  if (end - start < 0.1) {
    return {
      kind: "clarification",
      message: "There is not enough visible time remaining to create this motion.",
    };
  }

  const durationWasClipped = end < start + requestedDuration - 0.001;
  const controlOffset = parseControlOffset(prompt, delta);
  const assumptions = [
    "The instruction creates a new motion; it does not rewrite an earlier source animation.",
    "The final offset persists after the motion until the target leaves the scene.",
    "Connected-object propagation follows the current deterministic fixture policy.",
  ];
  if (durationWasClipped) assumptions.push("The duration was clipped at the earliest target exit.");

  return {
    kind: "suggestion",
    suggestion: {
      assumptions,
      confidence: "medium",
      operation: {
        anchor,
        controlOffset,
        delta,
        easing: "smooth",
        end,
        kind: "create-motion",
        start,
        targetObjectIds: visibleSelection.map((entry) => entry.object.id),
      },
      provider: "fixture",
      summary: `Create a ${summarizeDelta(delta)} movement from ${start.toFixed(2)}s to ${end.toFixed(2)}s.`,
    },
  };
}

export async function suggestEdit(
  request: EditSuggestionRequest,
  options: SuggestionOptions = {},
): Promise<EditSuggestionResult> {
  const endpoint = import.meta.env.VITE_POIETRA_AI_ENDPOINT as string | undefined;
  if (!endpoint) {
    const parsedFixture = parseEditSuggestionResult(suggestEditWithFixture(request));
    if (!parsedFixture.success) throw new Error("Local fixture returned an invalid operation.");
    return parsedFixture.data;
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
