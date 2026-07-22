import { z } from "zod";

import type { RuntimeSceneState, StaticSemanticState } from "../studio/model";
import { canonicalOperationSchema } from "../studio/operation-registry";
import type { CanonicalEditProgram } from "../studio/operations";
import { runtimeSceneStateSchema, staticSemanticStateSchema } from "../studio/state-schema";

const finiteNumber = z.number().finite();
const resolvedAnchorSchema = z.object({
  capturedPlayhead: finiteNumber,
  evidence: z.array(z.string().max(500)).max(32),
  resolvedSeconds: finiteNumber.nonnegative(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("absolute"), seconds: finiteNumber }),
    z.object({ kind: z.literal("playhead"), referenceSeconds: finiteNumber }),
    z.object({
      kind: z.literal("playhead-offset"),
      offsetSeconds: finiteNumber,
      referenceSeconds: finiteNumber,
    }),
    z.object({
      boundary: z.enum(["play-end", "play-start", "scene-end", "scene-start"]),
      eventId: z.string(),
      kind: z.literal("structural"),
      offsetSeconds: finiteNumber.optional(),
    }),
  ]),
});

const programSchema = z.object({
  anchor: resolvedAnchorSchema,
  intentCount: z.number().int().min(1).max(16),
  loweringStatus: z.enum(["illustrative", "supported", "unsupported"]),
  operations: z.array(canonicalOperationSchema).min(1).max(64),
  provenance: z.object({
    evidence: z.array(z.string().max(500)).max(64),
    origin: z.enum(["direct-manipulation", "fixture", "remote-model", "studio-default"]),
  }),
  requestedExecution: z.enum(["parallel", "sequence"]),
  schedule: z.object({
    edges: z.array(z.object({
      from: z.string(),
      reason: z.enum(["explicit", "identity", "lifetime", "read-after-write", "write-conflict"]),
      to: z.string(),
    })).max(256),
    mode: z.enum(["dependency-dag", "parallel", "sequence"]),
    order: z.array(z.string()).min(1).max(64),
  }),
  transactionId: z.string().min(1).max(160),
  version: z.literal(1),
});

export const programRenderRequestSchema = z.object({
  destination: z.object({
    sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    sourcePath: z.string().min(1).max(500),
  }).strict().nullable(),
  program: programSchema,
  sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  sourceBindings: z.array(z.object({
    entityId: z.string().min(1).max(240),
    sourceVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  }).strict()).max(128),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourcePath: z.string().min(1).max(500),
  viewport: z.object({
    height: finiteNumber.positive(),
    width: finiteNumber.positive(),
  }).strict(),
}).strict().superRefine((request, context) => {
  const entityIds = new Set<string>();
  const sourceVariables = new Set<string>();
  request.sourceBindings.forEach((target, index) => {
    if (entityIds.has(target.entityId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate target entity ${target.entityId}.`,
        path: ["sourceBindings", index, "entityId"],
      });
    }
    if (sourceVariables.has(target.sourceVariable)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate source variable ${target.sourceVariable}.`,
        path: ["sourceBindings", index, "sourceVariable"],
      });
    }
    entityIds.add(target.entityId);
    sourceVariables.add(target.sourceVariable);
  });
});

export type ProgramRenderRequest = Omit<z.infer<typeof programRenderRequestSchema>, "program"> & Readonly<{
  program: CanonicalEditProgram;
}>;

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
  programTransactionId: string;
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
    nextSceneId: string | null;
    name: string;
    runtimeSceneState: RuntimeSceneState;
    sceneId: string;
    sourceHash: string;
    sourceVariables: Readonly<Record<string, string>>;
    staticSemanticState: StaticSemanticState;
  }>[];
}>;

export type ManimWorkspaceView = Readonly<{
  command: readonly string[];
  commandAvailable: boolean;
  frame: Readonly<{ height: number; width: number }>;
  sources: readonly ManimWorkspaceSource[];
}>;

export const renderSessionStatusSchema: z.ZodType<RenderSessionStatus> = z.enum([
  "cancelled",
  "committed",
  "discarded",
  "failed",
  "preparing",
  "ready",
  "rendering",
  "undone",
]);

export const renderSessionViewSchema: z.ZodType<RenderSessionView> = z.object({
  canCancel: z.boolean(),
  canCommit: z.boolean(),
  canDiscard: z.boolean(),
  canUndo: z.boolean(),
  createdAt: z.string(),
  error: z.string().nullable(),
  id: z.string(),
  logTail: z.string(),
  patch: z.object({
    anchorLine: z.number().int().positive(),
    insertedCode: z.string(),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  programTransactionId: z.string(),
  progress: finiteNumber.min(0).max(1),
  sceneName: z.string(),
  sourcePath: z.string(),
  status: renderSessionStatusSchema,
  updatedAt: z.string(),
  videoUrl: z.string().nullable(),
}).strict();

export const manimWorkspaceSourceSchema: z.ZodType<ManimWorkspaceSource> = z.object({
  path: z.string(),
  scenes: z.array(z.object({
    anchors: z.array(finiteNumber.nonnegative()),
    name: z.string(),
    nextSceneId: z.string().nullable(),
    runtimeSceneState: runtimeSceneStateSchema,
    sceneId: z.string(),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourceVariables: z.record(z.string(), z.string()),
    staticSemanticState: staticSemanticStateSchema,
  }).strict()),
}).strict();

export const manimWorkspaceViewSchema: z.ZodType<ManimWorkspaceView> = z.object({
  command: z.array(z.string()),
  commandAvailable: z.boolean(),
  frame: z.object({ height: finiteNumber.positive(), width: finiteNumber.positive() }).strict(),
  sources: z.array(manimWorkspaceSourceSchema),
}).strict();

export type ManimApiError = Readonly<{ error: string }>;
