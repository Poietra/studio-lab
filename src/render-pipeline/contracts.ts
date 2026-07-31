import { z } from "zod";

import type { RuntimeSceneState, StaticSemanticState } from "../studio/model";
import { canonicalOperationSchema } from "../studio/operation-registry";
import type { CanonicalEditProgram } from "../studio/operations";
import { runtimeSceneStateSchema, staticSemanticStateSchema } from "../studio/state-schema";

const finiteNumber = z.number().finite();
export const MANIM_PROJECT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const manimProjectIdSchema = z
  .string()
  .regex(MANIM_PROJECT_ID_PATTERN, "Project ID must be an opaque lower-case identifier.");
export const manimProjectNameSchema = z.string().trim().min(1).max(120);
export function isManimSourcePath(value: string) {
  if (
    value.length === 0 ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    !value.endsWith(".py")
  )
    return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
export const manimSourcePathSchema = z
  .string()
  .refine(isManimSourcePath, "Source path must be a normalized relative Python file path.");
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
    edges: z
      .array(
        z.object({
          from: z.string(),
          reason: z.enum(["explicit", "identity", "lifetime", "read-after-write", "write-conflict"]),
          to: z.string(),
        }),
      )
      .max(256),
    mode: z.enum(["dependency-dag", "parallel", "sequence"]),
    order: z.array(z.string()).min(1).max(64),
  }),
  transactionId: z.string().min(1).max(160),
  version: z.literal(1),
});

const programRenderRequestBaseSchema = z.object({
  destination: z
    .object({
      sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      sourcePath: manimSourcePathSchema,
    })
    .strict()
    .nullable(),
  projectId: manimProjectIdSchema,
  sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  sourceBindings: z
    .array(
      z
        .object({
          entityId: z.string().min(1).max(240),
          sourceVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        })
        .strict(),
    )
    .max(128),
  sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  sourcePath: manimSourcePathSchema,
  viewport: z
    .object({
      height: finiteNumber.positive(),
      width: finiteNumber.positive(),
    })
    .strict(),
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

export const programRenderRequestSchema = programRenderRequestBaseSchema
  .extend({
    program: programSchema,
    programs: z.array(programSchema).min(1).max(32).optional(),
  })
  .strict()
  .superRefine((request, context) => {
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

export type ProgramRenderRequest = ProgramRenderRequestBase &
  Readonly<{
    program: CanonicalEditProgram;
    programs?: readonly CanonicalEditProgram[];
  }>;

export type BatchProgramRenderRequest = ProgramRenderRequest &
  Readonly<{
    programs: readonly CanonicalEditProgram[];
  }>;

export type SingleProgramRenderRequest = ProgramRenderRequest & Readonly<{ programs?: undefined }>;

export function renderRequestPrograms(request: ProgramRenderRequest): readonly CanonicalEditProgram[] {
  return request.programs ?? [request.program];
}

function contentHash(value: unknown, seed: number) {
  let hash = seed;
  for (const character of JSON.stringify(value)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function renderProgramBatchId(programs: readonly CanonicalEditProgram[]) {
  const canonicalPrograms = programs.map((program) => programSchema.parse(program));
  return `batch-${canonicalPrograms.length}-${contentHash(canonicalPrograms, 2_166_136_261)}-${contentHash(canonicalPrograms, 2_654_435_761)}`;
}

export function renderRequestId(request: ProgramRenderRequest) {
  const canonicalRequest = programRenderRequestSchema.parse(request);
  return `render-${contentHash(canonicalRequest, 2_166_136_261)}-${contentHash(canonicalRequest, 2_654_435_761)}`;
}

export const renderSourceActionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const renderSourceActionRequestSchema = z
  .object({
    actionId: renderSourceActionIdSchema,
  })
  .strict();

export type RenderSourceActionRequest = z.infer<typeof renderSourceActionRequestSchema>;

export const renderAbandonRequestSchema = z
  .object({
    renderRequestId: z.string().min(1).max(240),
  })
  .strict();

export const renderAbandonViewSchema = z.object({ abandoned: z.literal(true) }).strict();

export const renderCommitRequestSchema = z
  .object({
    actionId: renderSourceActionIdSchema,
    programBatchId: z.string().min(1).max(240),
    projectId: manimProjectIdSchema,
    renderRequestId: z.string().min(1).max(240),
    sceneName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourcePath: manimSourcePathSchema,
  })
  .strict();

export type RenderCommitRequest = z.infer<typeof renderCommitRequestSchema>;

export const renderSourceActionCancellationRequestSchema = z
  .object({
    actionId: renderSourceActionIdSchema,
    kind: z.enum(["commit", "undo"]),
  })
  .strict();

export type RenderSourceActionCancellationRequest = z.infer<typeof renderSourceActionCancellationRequestSchema>;

export type RenderSourceActionView = Readonly<{
  id: string;
  kind: "commit" | "undo";
  outcome: "committed" | "undone" | null;
  state: "cancelled" | "failed" | "running" | "succeeded";
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

export const renderSessionFailureCodeSchema = z.enum([
  "cancelled",
  "cpu-limit",
  "deadline-exceeded",
  "interrupted",
  "memory-limit",
  "pids-limit",
  "render-failed",
]);

export type RenderSessionFailureCode = z.infer<typeof renderSessionFailureCodeSchema>;

export const RENDER_SESSION_CONTRACT_VERSION_HEADER = "x-poietra-render-session-version";
export const RENDER_SESSION_CONTRACT_VERSION_WITH_FAILURE_CODE = "2";
export const RENDER_SESSION_CONTRACT_VERSION_WITH_CPU_LIMIT = "3";

export type RenderSessionView = Readonly<{
  actionInProgress: boolean;
  canCancel: boolean;
  canCommit: boolean;
  canDiscard: boolean;
  canUndo: boolean;
  createdAt: string;
  error: string | null;
  failureCode: RenderSessionFailureCode | null;
  id: string;
  logTail: string;
  patch: Readonly<{
    anchorLine: number;
    anchorLines: readonly number[];
    insertedCode: string;
    patchedSourceHash: string;
    sourceHash: string;
  }>;
  projectId: string;
  programBatchId: string;
  programTransactionId: string;
  renderRequestId: string;
  progress: number;
  sceneName: string;
  sourceAction: RenderSourceActionView | null;
  sourcePath: string;
  status: RenderSessionStatus;
  updatedAt: string;
  videoUrl: string | null;
}>;

export type RenderSourceActionCancellationView = Readonly<{
  action: RenderSourceActionView;
  session: RenderSessionView;
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

export type ManimRenderCapability = Readonly<{
  available: boolean;
  kind: "durable-sandbox" | "local-command";
  unavailableReason: "durable-render-unavailable" | "durable-render-unconfigured" | "local-command-unavailable" | null;
}>;

export type ManimWorkspaceView = Readonly<{
  commandAvailable: boolean;
  frame: Readonly<{ height: number; width: number }>;
  projectId: string;
  projectName: string;
  renderCapability: ManimRenderCapability;
  sources: readonly ManimWorkspaceSource[];
}>;

export type ManimProjectSummary = Readonly<{
  id: string;
  kind: "existing" | "managed";
  name: string;
}>;

export type ManimProjectListView = Readonly<{
  defaultProjectId: string | null;
  projects: readonly ManimProjectSummary[];
}>;

export type ManimProjectMutationView = Readonly<{
  catalog: ManimProjectListView;
  project: ManimProjectSummary | null;
}>;

export type ManimThumbnailState = "current" | "failed" | "generating" | "missing" | "stale" | "unavailable";

export type ManimThumbnailStatus = Readonly<{
  cachedSourceHash: string | null;
  error: string | null;
  generatedAt: string | null;
  imageKind: "empty" | "rendered" | "semantic";
  projectId: string;
  sceneName: string | null;
  sourceHash: string | null;
  sourcePath: string | null;
  state: ManimThumbnailState;
}>;

export type ManimProjectCreateRequest =
  | Readonly<{ kind: "managed"; name: string }>
  | Readonly<{ kind: "existing"; name: string; root: string }>;

export type ManimSourceExport = Readonly<{
  fileName: string;
  projectId: string;
  source: string;
}>;

export type OriginalManimSourceExportRequest = Readonly<{
  projectId: string;
  sourceHash: string;
  sourcePath: string;
}>;

export const originalManimSourceExportRequestSchema: z.ZodType<OriginalManimSourceExportRequest> = z
  .object({
    projectId: manimProjectIdSchema,
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
    sourcePath: manimSourcePathSchema,
  })
  .strict();

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

export const renderSourceActionViewSchema: z.ZodType<RenderSourceActionView> = z
  .object({
    id: renderSourceActionIdSchema,
    kind: z.enum(["commit", "undo"]),
    outcome: z.enum(["committed", "undone"]).nullable(),
    state: z.enum(["cancelled", "failed", "running", "succeeded"]),
  })
  .strict()
  .superRefine((action, context) => {
    const expectedOutcome = action.kind === "commit" ? "committed" : "undone";
    if (action.state === "succeeded" && action.outcome !== expectedOutcome) {
      context.addIssue({ code: "custom", message: `A succeeded ${action.kind} action requires ${expectedOutcome}.` });
    }
    if (action.state !== "succeeded" && action.outcome !== null) {
      context.addIssue({ code: "custom", message: "Only a succeeded source action may expose an outcome." });
    }
  });

export const renderSessionViewSchema: z.ZodType<RenderSessionView> = z
  .object({
    actionInProgress: z.boolean(),
    canCancel: z.boolean(),
    canCommit: z.boolean(),
    canDiscard: z.boolean(),
    canUndo: z.boolean(),
    createdAt: z.string(),
    error: z.string().nullable(),
    failureCode: renderSessionFailureCodeSchema.nullable().default(null),
    id: z.string(),
    logTail: z.string(),
    patch: z
      .object({
        anchorLine: z.number().int().positive(),
        anchorLines: z.array(z.number().int().positive()).min(1).max(128),
        insertedCode: z.string(),
        patchedSourceHash: z.string().regex(/^[0-9a-f]{64}$/),
        sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    projectId: manimProjectIdSchema,
    programBatchId: z.string(),
    programTransactionId: z.string(),
    renderRequestId: z.string(),
    progress: finiteNumber.min(0).max(1),
    sceneName: z.string(),
    sourceAction: renderSourceActionViewSchema.nullable(),
    sourcePath: manimSourcePathSchema,
    status: renderSessionStatusSchema,
    updatedAt: z.string(),
    videoUrl: z.string().nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    const valid =
      session.failureCode === null ||
      session.status === "discarded" ||
      (session.status === "cancelled" && session.failureCode === "cancelled") ||
      (session.status === "failed" && session.failureCode !== "cancelled");
    if (!valid) context.addIssue({ code: "custom", message: "Render failure code does not match its status." });
  });

export const renderSourceActionCancellationViewSchema: z.ZodType<RenderSourceActionCancellationView> = z
  .object({
    action: renderSourceActionViewSchema,
    session: renderSessionViewSchema,
  })
  .strict();

export const manimWorkspaceSourceSchema: z.ZodType<ManimWorkspaceSource> = z
  .object({
    path: manimSourcePathSchema,
    scenes: z.array(
      z
        .object({
          anchors: z.array(finiteNumber.nonnegative()),
          name: z.string(),
          nextSceneId: z.string().nullable(),
          runtimeSceneState: runtimeSceneStateSchema,
          sceneId: z.string(),
          sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
          sourceVariables: z.record(z.string(), z.string()),
          staticSemanticState: staticSemanticStateSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const manimRenderCapabilitySchema: z.ZodType<ManimRenderCapability> = z
  .object({
    available: z.boolean(),
    kind: z.enum(["durable-sandbox", "local-command"]),
    unavailableReason: z
      .enum(["durable-render-unavailable", "durable-render-unconfigured", "local-command-unavailable"])
      .nullable(),
  })
  .strict()
  .refine(
    (capability) =>
      capability.available
        ? capability.unavailableReason === null
        : capability.kind === "local-command"
          ? capability.unavailableReason === "local-command-unavailable"
          : capability.unavailableReason === "durable-render-unavailable" ||
            capability.unavailableReason === "durable-render-unconfigured",
    { message: "Render capability availability and reason do not match." },
  );

export const manimWorkspaceViewSchema: z.ZodType<ManimWorkspaceView> = z
  .object({
    commandAvailable: z.boolean(),
    frame: z.object({ height: finiteNumber.positive(), width: finiteNumber.positive() }).strict(),
    projectId: manimProjectIdSchema,
    projectName: z.string().min(1).max(120),
    renderCapability: manimRenderCapabilitySchema,
    sources: z.array(manimWorkspaceSourceSchema),
  })
  .strict();

export const manimProjectSummarySchema: z.ZodType<ManimProjectSummary> = z
  .object({
    id: manimProjectIdSchema,
    kind: z.enum(["existing", "managed"]),
    name: manimProjectNameSchema,
  })
  .strict();

export const manimProjectListViewSchema: z.ZodType<ManimProjectListView> = z
  .object({
    defaultProjectId: manimProjectIdSchema.nullable(),
    projects: z.array(manimProjectSummarySchema).max(64),
  })
  .strict()
  .superRefine((value, context) => {
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
    if (value.defaultProjectId !== null && !ids.has(value.defaultProjectId)) {
      context.addIssue({
        code: "custom",
        message: "The default project ID is not registered.",
        path: ["defaultProjectId"],
      });
    }
    if ((value.projects.length === 0) !== (value.defaultProjectId === null)) {
      context.addIssue({
        code: "custom",
        message: "The default project ID must be null exactly when the project list is empty.",
        path: ["defaultProjectId"],
      });
    }
  });

export const createManimProjectRequestSchema: z.ZodType<ManimProjectCreateRequest> = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("managed"),
      name: manimProjectNameSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("existing"),
      name: manimProjectNameSchema,
      root: z.string().trim().min(1).max(4_096),
    })
    .strict(),
]);

export const renameManimProjectRequestSchema = z
  .object({
    name: manimProjectNameSchema,
  })
  .strict();

export const manimProjectMutationViewSchema: z.ZodType<ManimProjectMutationView> = z
  .object({
    catalog: manimProjectListViewSchema,
    project: manimProjectSummarySchema.nullable(),
  })
  .strict();

export const manimThumbnailGenerateRequestSchema = z.object({}).strict();

export const manimThumbnailStatusSchema: z.ZodType<ManimThumbnailStatus> = z
  .object({
    cachedSourceHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    error: z.string().max(500).nullable(),
    generatedAt: z.string().datetime().nullable(),
    imageKind: z.enum(["empty", "rendered", "semantic"]),
    projectId: manimProjectIdSchema,
    sceneName: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .nullable(),
    sourceHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    sourcePath: manimSourcePathSchema.nullable(),
    state: z.enum(["current", "failed", "generating", "missing", "stale", "unavailable"]),
  })
  .strict()
  .superRefine((status, context) => {
    const targetFields = [status.sceneName, status.sourceHash, status.sourcePath];
    const hasTarget = targetFields.every((field) => field !== null);
    const hasPartialTarget = targetFields.some((field) => field !== null) && !hasTarget;
    const hasCachedImage = status.cachedSourceHash !== null || status.generatedAt !== null;
    if (hasPartialTarget) {
      context.addIssue({ code: "custom", message: "Thumbnail target fields must be all null or all present." });
    }
    if ((status.cachedSourceHash === null) !== (status.generatedAt === null)) {
      context.addIssue({ code: "custom", message: "Cached thumbnail hash and timestamp must be present together." });
    }
    if (status.imageKind === "empty" && hasTarget) {
      context.addIssue({ code: "custom", message: "An empty thumbnail cannot identify a Scene target." });
    }
    if (status.imageKind === "rendered" && !hasCachedImage) {
      context.addIssue({ code: "custom", message: "A rendered thumbnail requires cached image metadata." });
    }
    if (status.imageKind === "rendered" && hasTarget && status.cachedSourceHash !== status.sourceHash) {
      context.addIssue({ code: "custom", message: "A rendered thumbnail must match its active source." });
    }
    if ((status.state === "failed" || status.state === "unavailable") !== (status.error !== null)) {
      context.addIssue({ code: "custom", message: "Only failed or unavailable thumbnails carry an error." });
    }
    if (
      status.state === "current" &&
      (!hasTarget || status.imageKind !== "rendered" || status.cachedSourceHash !== status.sourceHash)
    ) {
      context.addIssue({ code: "custom", message: "A current thumbnail must render its active source." });
    }
    if (
      status.state === "stale" &&
      (!hasTarget ||
        status.imageKind !== "semantic" ||
        status.cachedSourceHash === null ||
        status.cachedSourceHash === status.sourceHash)
    ) {
      context.addIssue({
        code: "custom",
        message: "A stale thumbnail requires a different cached source and a semantic fallback.",
      });
    }
    if (
      status.state === "missing" &&
      (status.error !== null ||
        (hasTarget && (status.imageKind !== "semantic" || hasCachedImage)) ||
        (!hasTarget && status.imageKind !== "empty"))
    ) {
      context.addIssue({
        code: "custom",
        message: "A missing thumbnail must be an empty workspace or an uncached semantic target.",
      });
    }
    if (status.state === "unavailable" && (hasTarget || status.imageKind !== "empty")) {
      context.addIssue({ code: "custom", message: "An unavailable workspace cannot expose a current Scene target." });
    }
    if ((status.state === "failed" || status.state === "generating") && !hasTarget) {
      context.addIssue({ code: "custom", message: `${status.state} thumbnails require a Scene target.` });
    }
  });

export type ManimApiError = Readonly<{ error: string }>;
