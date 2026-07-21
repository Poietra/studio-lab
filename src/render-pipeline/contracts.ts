import { z } from "zod";

const finiteNumber = z.number().finite();
const pointSchema = z.object({
  x: finiteNumber,
  y: finiteNumber,
}).strict();

export const createMotionRenderRequestSchema = z.object({
  operation: z.object({
    controlOffsetPixels: pointSchema,
    deltaPixels: pointSchema,
    interval: z.object({
      end: finiteNumber.nonnegative(),
      start: finiteNumber.nonnegative(),
    }).strict(),
    kind: z.literal("CreateMotion"),
    targets: z.array(z.object({
      entityId: z.string().min(1).max(160),
      sourceVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    }).strict()).min(1).max(16),
    transactionId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
    viewport: z.object({
      height: finiteNumber.positive(),
      width: finiteNumber.positive(),
    }).strict(),
  }).strict(),
  sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  sourcePath: z.string().min(1).max(500),
}).strict().superRefine((request, context) => {
  if (request.operation.interval.end <= request.operation.interval.start) {
    context.addIssue({
      code: "custom",
      message: "CreateMotion must end after it starts.",
      path: ["operation", "interval", "end"],
    });
  }
  const entityIds = new Set<string>();
  const sourceVariables = new Set<string>();
  request.operation.targets.forEach((target, index) => {
    if (entityIds.has(target.entityId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate target entity ${target.entityId}.`,
        path: ["operation", "targets", index, "entityId"],
      });
    }
    if (sourceVariables.has(target.sourceVariable)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate source variable ${target.sourceVariable}.`,
        path: ["operation", "targets", index, "sourceVariable"],
      });
    }
    entityIds.add(target.entityId);
    sourceVariables.add(target.sourceVariable);
  });
});

export type CreateMotionRenderRequest = z.infer<typeof createMotionRenderRequestSchema>;

export type RenderSessionStatus =
  | "cancelled"
  | "committed"
  | "discarded"
  | "failed"
  | "preparing"
  | "ready"
  | "rendering"
  | "undone";

export type RenderSessionView = Readonly<{
  canCancel: boolean;
  canCommit: boolean;
  canDiscard: boolean;
  canUndo: boolean;
  createdAt: string;
  error: string | null;
  id: string;
  logTail: string;
  patch: Readonly<{
    anchorLine: number;
    insertedCode: string;
    sourceHash: string;
  }>;
  progress: number;
  sceneName: string;
  sourcePath: string;
  status: RenderSessionStatus;
  updatedAt: string;
  videoUrl: string | null;
}>;

export type ManimWorkspaceSource = Readonly<{
  path: string;
  scenes: readonly Readonly<{
    anchors: readonly number[];
    name: string;
  }>[];
}>;

export type ManimWorkspaceView = Readonly<{
  command: readonly string[];
  commandAvailable: boolean;
  frame: Readonly<{ height: number; width: number }>;
  projectRoot: string;
  sources: readonly ManimWorkspaceSource[];
}>;

export type ManimApiError = Readonly<{ error: string }>;
