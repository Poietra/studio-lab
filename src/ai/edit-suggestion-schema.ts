import { z } from "zod";

const pointSchema = z.object({ x: z.number(), y: z.number() });
const intervalSchema = z.object({ end: z.number(), start: z.number() });

export const suggestionTimeAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absolute"), seconds: z.number() }),
  z.object({ kind: z.literal("playhead"), referenceSeconds: z.number() }),
  z.object({
    kind: z.literal("playhead-offset"),
    offsetSeconds: z.number().negative(),
    referenceSeconds: z.number(),
  }),
]);

export const mathTexSuggestionTargetSchema = z.object({
  displayLines: z.array(z.string()).min(1).max(4),
  kind: z.literal("mathtex"),
  label: z.string().min(1).max(120),
  texParts: z.array(z.string().min(1)).min(1).max(16),
});

export const createMotionSuggestionSchema = z.object({
  anchor: suggestionTimeAnchorSchema,
  controlOffset: pointSchema,
  delta: pointSchema,
  easing: z.literal("smooth"),
  end: z.number(),
  kind: z.literal("create-motion"),
  start: z.number(),
  targetObjectIds: z.array(z.string()).min(1),
});

export const createTransformSuggestionSchema = z.object({
  anchor: suggestionTimeAnchorSchema,
  easing: z.literal("smooth"),
  end: z.number(),
  identityAfter: z.literal("target-replaces-source"),
  kind: z.literal("create-transform"),
  mismatchMode: z.literal("transform"),
  sourceObjectId: z.string(),
  start: z.number(),
  strategy: z.literal("transform-matching-tex"),
  target: mathTexSuggestionTargetSchema,
});

export const createExplanationSuggestionSchema = z.object({
  anchor: suggestionTimeAnchorSchema,
  animation: z.literal("fade-in"),
  end: z.number(),
  kind: z.literal("create-explanation"),
  objectKind: z.literal("text"),
  placement: z.enum(["above", "below", "left", "right"]),
  start: z.number(),
  targetObjectId: z.string(),
  text: z.string().trim().min(1).max(240),
});

export const createSceneTransitionSuggestionSchema = z.object({
  anchor: suggestionTimeAnchorSchema,
  color: z.enum(["black", "sky", "white"]),
  destination: z.literal("next-scene"),
  easing: z.literal("smooth"),
  end: z.number(),
  kind: z.literal("create-scene-transition"),
  shape: z.enum(["circle", "diamond", "hexagon"]),
  start: z.number(),
  style: z.literal("cover-reveal"),
});

export const editSuggestionLeafOperationSchema = z.discriminatedUnion("kind", [
  createMotionSuggestionSchema,
  createTransformSuggestionSchema,
  createExplanationSuggestionSchema,
  createSceneTransitionSuggestionSchema,
]);

export const editProgramStepSchema = z.discriminatedUnion("kind", [
  createMotionSuggestionSchema.omit({ anchor: true }),
  createTransformSuggestionSchema.omit({ anchor: true }),
  createExplanationSuggestionSchema.omit({ anchor: true }),
]);

export const editProgramSuggestionSchema = z.object({
  anchor: suggestionTimeAnchorSchema,
  execution: z.enum(["parallel", "sequence"]),
  kind: z.literal("edit-program"),
  operations: z.array(editProgramStepSchema).min(2).max(3),
}).superRefine((program, context) => {
  const kinds = program.operations.map((operation) => operation.kind);
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: "custom", message: "EditProgram leaf kinds must be unique.", path: ["operations"] });
  }
  const first = program.operations[0];
  if (!first) return;
  if (program.execution === "parallel") {
    program.operations.slice(1).forEach((operation, index) => {
      if (Math.abs(operation.start - first.start) >= 0.001 || Math.abs(operation.end - first.end) >= 0.001) {
        context.addIssue({ code: "custom", message: "Parallel steps must share one interval.", path: ["operations", index + 1] });
      }
    });
  } else {
    program.operations.slice(1).forEach((operation, index) => {
      if (operation.start < program.operations[index].end - 0.001) {
        context.addIssue({ code: "custom", message: "Sequence steps must not overlap.", path: ["operations", index + 1] });
      }
    });
  }
});

export const editSuggestionOperationSchema = z.union([
  editSuggestionLeafOperationSchema,
  editProgramSuggestionSchema,
]);

export const editSuggestionRequestSchema = z.object({
  objects: z.array(z.object({
    displayName: z.string(),
    id: z.string(),
    lifetimes: z.array(intervalSchema),
    mathTex: z.object({ displayLines: z.array(z.string()), texParts: z.array(z.string()) }).nullable(),
    type: z.string(),
  })),
  playhead: z.number(),
  prompt: z.string().trim().min(1).max(2_000),
  sceneDuration: z.number().positive(),
  selectedObjectIds: z.array(z.string()),
});

export const modelSuggestionSchema = z.object({
  assumptions: z.array(z.string()),
  kind: z.enum(["suggestion", "clarification"]),
  message: z.string(),
  operation: editSuggestionOperationSchema.nullable(),
  summary: z.string(),
});

const suggestionSchema = z.object({
  assumptions: z.array(z.string()),
  confidence: z.literal("medium"),
  operation: editSuggestionOperationSchema,
  provider: z.enum(["fixture", "remote"]),
  summary: z.string(),
});

export const editSuggestionResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clarification"), message: z.string().min(1) }),
  z.object({ kind: z.literal("suggestion"), suggestion: suggestionSchema }),
]);

export function parseEditSuggestionResult(value: unknown) {
  return editSuggestionResultSchema.safeParse(value);
}
