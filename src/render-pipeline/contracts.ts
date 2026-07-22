import { z } from "zod";

import type { RuntimeSceneState, StaticSemanticState } from "../studio/model";
import { canonicalOperationSchema } from "../studio/operation-registry";
import type { CanonicalEditProgram } from "../studio/operations";
import { runtimeSceneStateSchema, staticSemanticStateSchema } from "../studio/state-schema";

const finiteNumber = z.number().finite();
export const manimProjectIdSchema = z.string().regex(
  /^[a-z][a-z0-9_-]{0,63}$/,
  "Project ID must be an opaque lower-case identifier.",
);
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

const programRenderRequestBaseSchema = z.object({
  destination: z.object({
    sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    sourcePath: z.string().min(1).max(500),
  }).strict().nullable(),
  projectId: manimProjectIdSchema,
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
});

function validateSourceBindings(
  request: Readonly<{ sourceBindings: readonly Readonly<{ entityId: string; sourceVariable: string }>[] }>,
  context: z.RefinementCtx,
) {
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
}

export const programRenderRequestSchema = programRenderRequestBaseSchema.extend({
  program: programSchema,
  programs: z.array(programSchema).min(1).max(32).optional(),
}).strict().superRefine((request, context) => {
  validateSourceBindings(request, context);
  const programs = request.programs ?? [request.program];
  if (request.programs && JSON.stringify(request.programs[0]) !== JSON.stringify(request.program)) {
    context.addIssue({
      code: "custom",
      message: "program must equal programs[0] when a render batch is supplied.",
      path: ["program"],
    });
  }
  const transactionIds = new Set<string>();
  let operationCount = 0;
  let intentCount = 0;
  programs.forEach((program, index) => {
    if (transactionIds.has(program.transactionId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate transaction ID ${program.transactionId}.`,
        path: ["programs", index, "transactionId"],
      });
    }
    transactionIds.add(program.transactionId);
    operationCount += program.operations.length;
    intentCount += program.intentCount;
  });
  if (operationCount > 256) {
    context.addIssue({
      code: "custom",
      message: "A render batch accepts at most 256 Canonical operations.",
      path: ["programs"],
    });
  }
  if (intentCount > 64) {
    context.addIssue({
      code: "custom",
      message: "A render batch accepts at most 64 composed intents.",
      path: ["programs"],
    });
  }
});

type ProgramRenderRequestBase = Omit<z.infer<typeof programRenderRequestBaseSchema>, never>;

export type ProgramRenderRequest = ProgramRenderRequestBase & Readonly<{
  program: CanonicalEditProgram;
  programs?: readonly CanonicalEditProgram[];
}>;

export type BatchProgramRenderRequest = ProgramRenderRequest & Readonly<{
  programs: readonly CanonicalEditProgram[];
}>;

export type SingleProgramRenderRequest = ProgramRenderRequest & Readonly<{ programs?: undefined }>;

export function renderRequestPrograms(request: ProgramRenderRequest): readonly CanonicalEditProgram[] {
  return request.programs ?? [request.program];
}

function batchHash(programs: readonly CanonicalEditProgram[], seed: number) {
  let hash = seed;
  for (const character of JSON.stringify(programs)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function renderProgramBatchId(programs: readonly CanonicalEditProgram[]) {
  if (programs.length === 1) return programs[0].transactionId;
  return `batch-${programs.length}-${batchHash(programs, 2_166_136_261)}-${batchHash(programs, 2_654_435_761)}`;
}

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
    anchorLines: readonly number[];
    insertedCode: string;
    sourceHash: string;
  }>;
  projectId: string;
  programBatchId: string;
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
  projectId: string;
  projectName: string;
  sources: readonly ManimWorkspaceSource[];
}>;

export type ManimProjectSummary = Readonly<{
  id: string;
  name: string;
}>;

export type ManimProjectListView = Readonly<{
  defaultProjectId: string;
  projects: readonly ManimProjectSummary[];
}>;

export type ManimSourceExport = Readonly<{
  fileName: string;
  projectId: string;
  source: string;
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
    anchorLines: z.array(z.number().int().positive()).min(1).max(128),
    insertedCode: z.string(),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  projectId: manimProjectIdSchema,
  programBatchId: z.string(),
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
  projectId: manimProjectIdSchema,
  projectName: z.string().min(1).max(120),
  sources: z.array(manimWorkspaceSourceSchema),
}).strict();

export const manimProjectSummarySchema: z.ZodType<ManimProjectSummary> = z.object({
  id: manimProjectIdSchema,
  name: z.string().min(1).max(120),
}).strict();

export const manimProjectListViewSchema: z.ZodType<ManimProjectListView> = z.object({
  defaultProjectId: manimProjectIdSchema,
  projects: z.array(manimProjectSummarySchema).min(1).max(64),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  value.projects.forEach((project, index) => {
    if (ids.has(project.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate project ID ${project.id}.`,
        path: ["projects", index, "id"],
      });
    }
    ids.add(project.id);
  });
  if (!ids.has(value.defaultProjectId)) {
    context.addIssue({
      code: "custom",
      message: "The default project ID is not registered.",
      path: ["defaultProjectId"],
    });
  }
});

export type ManimApiError = Readonly<{ error: string }>;
