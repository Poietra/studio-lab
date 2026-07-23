import { z } from "zod";

const motionDeltaSchema = z.object({
  x: z.number().min(-220).max(220),
  y: z.number().min(-100).max(100),
});
const motionControlOffsetSchema = z.object({
  x: z.number().min(-160).max(160),
  y: z.number().min(-100).max(100),
});
const intervalSchema = z.object({ end: z.number(), start: z.number() });
const targetObjectIdsSchema = z.array(z.string()).min(1).max(16).superRefine((ids, context) => {
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    context.addIssue({
      code: "custom",
      message: `Target object ID ${duplicate} must be unique.`,
    });
  }
});

function boundedInterval(minimumDuration: number) {
  return (value: Readonly<{ end: number; start: number }>, context: z.RefinementCtx) => {
    const duration = value.end - value.start;
    if (duration < minimumDuration) {
      context.addIssue({
        code: "custom",
        message: `Duration must be at least ${minimumDuration} seconds.`,
        path: ["end"],
      });
    }
  };
}

export const suggestionTimeAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absolute"), seconds: z.number() }),
  z.object({ kind: z.literal("playhead"), referenceSeconds: z.number() }),
  z.object({
    kind: z.literal("playhead-offset"),
    offsetSeconds: z.number().negative(),
    referenceSeconds: z.number(),
  }),
]);

export const mathTexSuggestionTargetSchema = z
  .object({
    displayLines: z.array(z.string().trim().min(1).max(120)).min(1).max(4),
    kind: z.literal("mathtex"),
    label: z.string().trim().min(1).max(120),
    texParts: z.array(z.string().trim().min(1).max(2_000)).min(1).max(16),
  })
  .superRefine((target, context) => {
    if (target.texParts.reduce((length, part) => length + part.length, 0) > 2_000) {
      context.addIssue({
        code: "custom",
        message: "MathTex arguments must contain at most 2,000 characters in total.",
        path: ["texParts"],
      });
    }
  });

const createMotionFields = {
  controlOffset: motionControlOffsetSchema,
  delta: motionDeltaSchema,
  easing: z.enum(["linear", "smooth"]),
  end: z.number(),
  kind: z.literal("create-motion"),
  start: z.number(),
  targetObjectIds: targetObjectIdsSchema,
} as const;

export const createMotionSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    ...createMotionFields,
  })
  .superRefine(boundedInterval(0.1));

const createTransformFields = {
  easing: z.literal("smooth"),
  end: z.number(),
  identityAfter: z.literal("target-replaces-source"),
  kind: z.literal("create-transform"),
  mismatchMode: z.literal("transform"),
  sourceObjectId: z.string(),
  start: z.number(),
  strategy: z.literal("transform-matching-tex"),
  target: mathTexSuggestionTargetSchema,
} as const;

export const createTransformSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    ...createTransformFields,
  })
  .superRefine(boundedInterval(0.1));

const createExplanationFields = {
  animation: z.literal("fade-in"),
  end: z.number(),
  kind: z.literal("create-explanation"),
  objectKind: z.literal("text"),
  placement: z.enum(["above", "below", "left", "right"]),
  start: z.number(),
  targetObjectId: z.string(),
  text: z.string().trim().min(1).max(240),
} as const;

export const createExplanationSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    ...createExplanationFields,
  })
  .superRefine(boundedInterval(0.1));

const createSceneTransitionFields = {
  color: z.enum(["black", "sky", "white"]),
  destination: z.literal("next-scene"),
  easing: z.literal("smooth"),
  end: z.number(),
  kind: z.literal("create-scene-transition"),
  shape: z.enum(["circle", "diamond", "hexagon"]),
  start: z.number(),
  style: z.literal("cover-reveal"),
} as const;

export const createSceneTransitionSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    ...createSceneTransitionFields,
  })
  .superRefine(boundedInterval(0.4));

export const createCameraFocusSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    easing: z.literal("smooth"),
    emphasisScale: z.number().min(1).max(1.25),
    end: z.number(),
    kind: z.literal("create-camera-focus"),
    start: z.number(),
    targetObjectIds: targetObjectIdsSchema,
    zoomScale: z.number().min(1).max(2),
  })
  .superRefine(boundedInterval(0.1));

const createEquationFields = {
  animation: z.literal("fade-in"),
  end: z.number(),
  kind: z.literal("create-equation"),
  placement: z.enum(["center", "right"]),
  start: z.number(),
  target: mathTexSuggestionTargetSchema,
} as const;

export const createEquationSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    ...createEquationFields,
  })
  .superRefine(boundedInterval(0.1));

const createExplainedEquationFields = {
  animation: z.literal("fade-in"),
  end: z.number(),
  explanation: z.object({
    placement: z.enum(["above", "below", "left", "right"]),
    text: z.string().trim().min(1).max(240),
  }),
  kind: z.literal("create-explained-equation"),
  placement: z.enum(["center", "right"]),
  start: z.number(),
  target: mathTexSuggestionTargetSchema,
} as const;

export const createExplainedEquationSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    ...createExplainedEquationFields,
  })
  .superRefine(boundedInterval(0.1));

export const createTextTransformSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    easing: z.literal("smooth"),
    end: z.number(),
    kind: z.literal("create-text-transform"),
    sourceObjectId: z.string(),
    start: z.number(),
    strategy: z.literal("replacement-transform"),
    text: z.string().trim().min(1).max(240),
  })
  .superRefine(boundedInterval(0.1));

const scaleObjectsFields = {
  easing: z.literal("smooth"),
  end: z.number(),
  factor: z.number().finite().min(0.01).max(80),
  kind: z.literal("scale-objects"),
  start: z.number(),
  targetObjectIds: targetObjectIdsSchema,
} as const;

export const scaleObjectsSuggestionSchema = z.object({
  anchor: suggestionTimeAnchorSchema,
  ...scaleObjectsFields,
}).strict().superRefine(boundedInterval(0.1));

const deleteObjectsFields = {
  animation: z.literal("fade-out"),
  end: z.number(),
  kind: z.literal("delete-objects"),
  start: z.number(),
  targetObjectIds: targetObjectIdsSchema,
} as const;

export const deleteObjectsSuggestionSchema = z.object({
  anchor: suggestionTimeAnchorSchema,
  ...deleteObjectsFields,
}).strict().superRefine(boundedInterval(0.1));

export const editSuggestionLeafOperationSchema = z.discriminatedUnion("kind", [
  createCameraFocusSuggestionSchema,
  deleteObjectsSuggestionSchema,
  createEquationSuggestionSchema,
  createExplainedEquationSuggestionSchema,
  createTextTransformSuggestionSchema,
  createMotionSuggestionSchema,
  createTransformSuggestionSchema,
  createExplanationSuggestionSchema,
  createSceneTransitionSuggestionSchema,
  scaleObjectsSuggestionSchema,
]);

export const editProgramStepSchema = z.discriminatedUnion("kind", [
  z.object(createMotionFields).superRefine(boundedInterval(0.1)),
  z.object(createTransformFields).superRefine(boundedInterval(0.1)),
  z.object(createExplanationFields).superRefine(boundedInterval(0.1)),
  z.object(createEquationFields).superRefine(boundedInterval(0.1)),
  z.object(createExplainedEquationFields).superRefine(boundedInterval(0.1)),
  z.object(createSceneTransitionFields).superRefine(boundedInterval(0.4)),
  z.object(deleteObjectsFields).strict().superRefine(boundedInterval(0.1)),
  z.object(scaleObjectsFields).strict().superRefine(boundedInterval(0.1)),
]);

export const editProgramSuggestionSchema = z
  .object({
    anchor: suggestionTimeAnchorSchema,
    execution: z.enum(["parallel", "sequence"]),
    kind: z.literal("edit-program"),
    operations: z.array(editProgramStepSchema).min(2).max(3),
  })
  .superRefine((program, context) => {
    const kinds = program.operations.map((operation) => operation.kind);
    const duplicateKinds = kinds.filter((kind, index) => kinds.indexOf(kind) !== index);
    const unsupportedDuplicate = duplicateKinds.find(
      (kind) => (kind !== "create-motion" && kind !== "create-transform") || program.execution !== "sequence",
    );
    if (unsupportedDuplicate) {
      context.addIssue({
        code: "custom",
        message:
          unsupportedDuplicate === "create-motion" || unsupportedDuplicate === "create-transform"
            ? `Repeated ${unsupportedDuplicate} steps require sequence execution.`
            : `EditProgram leaf kind ${unsupportedDuplicate} must be unique.`,
        path: ["operations"],
      });
    }
    const equationCreationCount = kinds.filter(
      (kind) => kind === "create-equation" || kind === "create-explained-equation",
    ).length;
    if (equationCreationCount > 1) {
      context.addIssue({
        code: "custom",
        message: "EditProgram can contain only one equation-creation macro.",
        path: ["operations"],
      });
    }
    const semanticIntentCount = program.operations.reduce(
      (count, operation) => count + (operation.kind === "create-explained-equation" ? 2 : 1),
      0,
    );
    if (semanticIntentCount > 3) {
      context.addIssue({
        code: "custom",
        message: "EditProgram supports at most three semantic intents.",
        path: ["operations"],
      });
    }
    const first = program.operations[0];
    if (!first) return;
    if (program.execution === "parallel") {
      program.operations.slice(1).forEach((operation, index) => {
        if (Math.abs(operation.start - first.start) >= 0.001 || Math.abs(operation.end - first.end) >= 0.001) {
          context.addIssue({
            code: "custom",
            message: "Parallel steps must share one interval.",
            path: ["operations", index + 1],
          });
        }
      });
    } else {
      program.operations.slice(1).forEach((operation, index) => {
        if (operation.start < program.operations[index].end - 0.001) {
          context.addIssue({
            code: "custom",
            message: "Sequence steps must not overlap.",
            path: ["operations", index + 1],
          });
        }
      });
    }
  });

export const editSuggestionOperationSchema = z.union([editSuggestionLeafOperationSchema, editProgramSuggestionSchema]);

export const clarificationOptionSchema = z.object({
  description: z.string().trim().min(1).max(240),
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
});

const clarificationOptionsSchema = z
  .array(clarificationOptionSchema)
  .max(3)
  .superRefine((options, context) => {
    const seen = new Set<string>();
    options.forEach((option, index) => {
      if (seen.has(option.id)) {
        context.addIssue({
          code: "custom",
          message: `Clarification option ID ${option.id} is duplicated.`,
          path: [index, "id"],
        });
      }
      seen.add(option.id);
    });
  });

const clarificationAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("option"), optionId: z.string().trim().min(1).max(40) }),
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(2_000) }),
]);

const clarificationTurnFields = {
  answer: clarificationAnswerSchema,
  options: clarificationOptionsSchema,
  question: z.string().trim().min(1).max(500),
} as const;

function validateClarificationAnswer(
  turn: Readonly<z.infer<z.ZodObject<typeof clarificationTurnFields>>>,
  context: z.RefinementCtx,
) {
  if (turn.answer.kind !== "option") return;
  const { optionId } = turn.answer;
  if (!turn.options.some((option) => option.id === optionId)) {
    context.addIssue({
      code: "custom",
      message: "The selected clarification option is not present in this turn.",
      path: ["answer", "optionId"],
    });
  }
}

const clarificationTurnSchema = z.object(clarificationTurnFields).superRefine(validateClarificationAnswer);

export const editSuggestionRequestSchema = z.object({
  clarification: z
    .object({
      ...clarificationTurnFields,
      history: z.array(clarificationTurnSchema).max(4),
    })
    .superRefine(validateClarificationAnswer)
    .nullable(),
  objects: z.array(
    z.object({
      displayName: z.string(),
      editCapabilities: z.object({
        delete: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("supported") }),
          z.object({ kind: z.literal("blocked"), reason: z.string().trim().min(1).max(500) }),
        ]),
        scale: z.discriminatedUnion("kind", [
          z.object({ current: z.number().finite().positive(), kind: z.literal("supported") }),
          z.object({ kind: z.literal("blocked"), reason: z.string().trim().min(1).max(500) }),
        ]),
      }),
      id: z.string(),
      lifetimes: z.array(intervalSchema),
      mathTex: z.object({ displayLines: z.array(z.string()), texParts: z.array(z.string()) }).nullable(),
      type: z.string(),
    }),
  ),
  playhead: z.number(),
  prompt: z.string().trim().min(1).max(2_000),
  scene: z.object({
    id: z.string().min(1).max(500),
    name: z.string().min(1).max(160),
    nextSceneId: z.string().min(1).max(500).nullable(),
  }),
  sceneDuration: z.number().positive(),
  selectedObjectIds: z.array(z.string()),
});

const modelClarificationOptionSchema = z.object({
  description: z.string().trim().min(1).max(240),
  label: z.string().trim().min(1).max(80),
});

export const modelSuggestionSchema = z
  .object({
    assumptions: z.array(z.string()),
    kind: z.enum(["suggestion", "clarification"]),
    message: z.string(),
    operation: editSuggestionOperationSchema.nullable(),
    options: z.array(modelClarificationOptionSchema).max(3),
    summary: z.string(),
  })
  .superRefine((suggestion, context) => {
    if (suggestion.kind === "suggestion" && suggestion.operation === null) {
      context.addIssue({
        code: "custom",
        message: "A suggestion result must include an operation.",
        path: ["operation"],
      });
    }
    if (suggestion.kind === "clarification" && suggestion.operation !== null) {
      context.addIssue({
        code: "custom",
        message: "A clarification result must not include an operation.",
        path: ["operation"],
      });
    }
  });

export type ModelSuggestion = z.infer<typeof modelSuggestionSchema>;

const suggestionSchema = z.object({
  assumptions: z.array(z.string()),
  confidence: z.literal("medium"),
  operation: editSuggestionOperationSchema,
  provider: z.literal("remote"),
  summary: z.string(),
});

export const editSuggestionResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("clarification"),
    message: z.string().min(1),
    options: clarificationOptionsSchema,
  }),
  z.object({ kind: z.literal("suggestion"), suggestion: suggestionSchema }),
]);

export function parseEditSuggestionResult(value: unknown) {
  return editSuggestionResultSchema.safeParse(value);
}
