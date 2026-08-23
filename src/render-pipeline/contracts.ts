import { z } from "zod";

import { enginePointV1Schema } from "../engine/primitives";
import type { RuntimeSceneState, StaticSemanticState } from "../studio/model";
import { type SceneEdit, sceneEditSchema } from "../studio/scene-edit-contract";
import { runtimeSceneStateSchema, staticSemanticStateSchema } from "../studio/state-schema";
import { manimProjectIdSchema, manimSceneNameSchema, manimSourcePathSchema } from "./manim-identity-contract";

export { sceneEditSchema as canonicalEditProgramSchemaV1 } from "../studio/scene-edit-contract";

export {
  isManimSourcePath,
  MANIM_PROJECT_ID_PATTERN,
  MAX_MANIM_SCENE_NAME_LENGTH_V1,
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "./manim-identity-contract";

const finiteNumber = z.number().finite();
export const manimProjectNameSchema = z.string().trim().min(1).max(120);

const programRenderRequestBaseSchema = z.object({
  cameraCenter: enginePointV1Schema.optional(),
  destination: z
    .object({
      sceneName: manimSceneNameSchema,
      sourcePath: manimSourcePathSchema,
    })
    .strict()
    .nullable(),
  projectId: manimProjectIdSchema,
  sceneName: manimSceneNameSchema,
  // This is an untrusted request for a stricter server-side validation path,
  // never proof that Runtime Trace authorized the edit. The server re-derives
  // that authority from the current source and fresh producer evidence.
  sourceValidation: z.literal("runtime-trace").optional(),
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
    program: sceneEditSchema,
    programs: z.array(sceneEditSchema).min(1).max(32).optional(),
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
    program: SceneEdit;
    programs?: readonly SceneEdit[];
  }>;

export type BatchProgramRenderRequest = ProgramRenderRequest &
  Readonly<{
    programs: readonly SceneEdit[];
  }>;

export type SingleProgramRenderRequest = ProgramRenderRequest & Readonly<{ programs?: undefined }>;

export function renderRequestPrograms(request: ProgramRenderRequest): readonly SceneEdit[] {
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

export function renderProgramBatchId(programs: readonly SceneEdit[]) {
  const canonicalPrograms = programs.map((program) => sceneEditSchema.parse(program));
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
    sceneName: manimSceneNameSchema,
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

export type ManimSourceImportOutcome =
  | Readonly<{
      access: "read-only";
      bindingId: string;
      constructorPath: readonly string[];
      kind: "source-preserved";
      reason: "constructor-not-supported";
      sourceLine: number;
      sourceVariable: string;
    }>
  | Readonly<{
      access: "read-only";
      bindingId: string;
      constructorPath: readonly string[] | null;
      kind: "runtime-only";
      reason: "dynamic-control-flow" | "runtime-constructor";
      sourceLine: number;
      sourceVariable: string;
    }>
  | Readonly<{
      access: "read-only";
      bindingId: string;
      constructorPath: readonly string[] | null;
      kind: "unsupported";
      reason: "ambiguous-binding" | "source-analysis-unavailable" | "unsupported-binding-form";
      sourceLine: number;
      sourceVariable: string | null;
    }>;

export type ManimWorkspaceSource = Readonly<{
  path: string;
  scenes: readonly Readonly<{
    anchors: readonly number[];
    importOutcomes: readonly ManimSourceImportOutcome[];
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
  unavailableReason:
    | "durable-render-unavailable"
    | "durable-render-unconfigured"
    | "local-command-unavailable"
    | "native-render-frozen"
    | null;
}>;

export type ManimWorkspaceView = Readonly<{
  commandAvailable: boolean;
  frame: Readonly<{ height: number; width: number }>;
  /**
   * Present only when the project's durable root is a source-free
   * Studio-native Editor Document. Imported workspaces never carry this
   * field, so their responses stay byte-identical.
   */
  nativeDocument?: Readonly<{ documentKey: string }>;
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

export const MAX_BROWSER_MANIM_SOURCE_BYTES_V1 = 192 * 1024;
export const MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1 = 512 * 1024;
// One valid source byte can occupy six JSON bytes when an ASCII control
// character is escaped as `\u00xx`, while the optional PNG expands by 4/3 in
// base64. Keep the transport ceiling above both worst cases plus the bounded
// project-name and source-name envelope.
export const MAX_BROWSER_MANIM_PROJECT_IMPORT_JSON_BYTES_V1 = 2 * 1024 * 1024;

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_BROWSER_MANIM_IMAGE_PNG_BASE64_LENGTH_V1 = 4 * Math.ceil(MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1 / 3);

function canonicalBase64DecodedByteLength(value: string) {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding === 2 && (BASE64_ALPHABET.indexOf(value.at(-3) ?? "") & 0x0f) !== 0) return null;
  if (padding === 1 && (BASE64_ALPHABET.indexOf(value.at(-2) ?? "") & 0x03) !== 0) return null;
  return (value.length / 4) * 3 - padding;
}

export type BrowserManimProjectImportRequestV1 = Readonly<{
  imagePngBase64: string | null;
  name: string;
  source: string;
  sourceName: string;
}>;

export type ManimThumbnailState = "current" | "failed" | "generating" | "missing" | "stale" | "unavailable";

export type ManimThumbnailStatus = Readonly<{
  cachedSourceHash: string | null;
  error: string | null;
  generatedAt: string | null;
  imageLineage?: "editor-document";
  imageKind: "empty" | "rendered" | "semantic";
  projectId: string;
  sceneName: string | null;
  sourceHash: string | null;
  sourcePath: string | null;
  state: ManimThumbnailState;
}>;

export type ManimProjectCreateRequest =
  | Readonly<{ kind: "managed"; name: string }>
  | Readonly<{ kind: "existing"; name: string; root: string }>
  | Readonly<{ kind: "studio-native"; name: string }>;

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

export type StudioNativeManimSourceExportRequest = Readonly<{
  documentKey: string;
  duration: number;
  fragmentMaterialEntityIds: readonly string[];
  kind: "studio-native";
  programs: readonly SceneEdit[];
  projectId: string;
  sceneName?: string;
  viewport: Readonly<{ height: number; width: number }>;
}>;

export const studioNativeManimSourceExportRequestSchema: z.ZodType<StudioNativeManimSourceExportRequest> = z
  .object({
    documentKey: z.string().regex(/^[0-9a-f]{64}$/u),
    duration: finiteNumber.positive(),
    fragmentMaterialEntityIds: z.array(z.string().min(1).max(240)).max(128),
    kind: z.literal("studio-native"),
    programs: z.array(sceneEditSchema).max(32),
    projectId: manimProjectIdSchema,
    sceneName: manimSceneNameSchema.optional(),
    viewport: z
      .object({
        height: finiteNumber.positive(),
        width: finiteNumber.positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const operationCount = request.programs.reduce((count, program) => count + program.operations.length, 0);
    if (operationCount > 256) {
      context.addIssue({
        code: "custom",
        message: "A Studio-native source export accepts at most 256 Canonical operations.",
        path: ["programs"],
      });
    }
    const intentCount = request.programs.reduce((count, program) => count + program.intentCount, 0);
    if (intentCount > 64) {
      context.addIssue({
        code: "custom",
        message: "A Studio-native source export accepts at most 64 composed intents.",
        path: ["programs"],
      });
    }
  });

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
      .strict()
      .superRefine((patch, context) => {
        if (patch.anchorLines[0] !== patch.anchorLine) {
          context.addIssue({
            code: "custom",
            message: "The primary patch anchor must equal the first source evidence anchor.",
            path: ["anchorLine"],
          });
        }
        if (patch.anchorLines.some((line, index) => index > 0 && line <= patch.anchorLines[index - 1]!)) {
          context.addIssue({
            code: "custom",
            message: "Patch source evidence anchors must be strictly increasing.",
            path: ["anchorLines"],
          });
        }
      }),
    projectId: manimProjectIdSchema,
    programBatchId: z.string(),
    programTransactionId: z.string(),
    renderRequestId: z.string(),
    progress: finiteNumber.min(0).max(1),
    sceneName: manimSceneNameSchema,
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
    if (session.videoUrl !== null && session.videoUrl !== `/api/manim/renders/${session.id}/video`) {
      context.addIssue({ code: "custom", message: "Render video URL does not match its session." });
    }
    if (session.videoUrl !== null && !["committed", "ready", "undone"].includes(session.status)) {
      context.addIssue({ code: "custom", message: "Only a ready render may expose a video URL." });
    }
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
          importOutcomes: z.array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  access: z.literal("read-only"),
                  bindingId: z.string().min(1),
                  constructorPath: z.array(z.string().min(1)),
                  kind: z.literal("source-preserved"),
                  reason: z.literal("constructor-not-supported"),
                  sourceLine: z.number().int().positive(),
                  sourceVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                })
                .strict(),
              z
                .object({
                  access: z.literal("read-only"),
                  bindingId: z.string().min(1),
                  constructorPath: z.array(z.string().min(1)).nullable(),
                  kind: z.literal("runtime-only"),
                  reason: z.enum(["dynamic-control-flow", "runtime-constructor"]),
                  sourceLine: z.number().int().positive(),
                  sourceVariable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                })
                .strict(),
              z
                .object({
                  access: z.literal("read-only"),
                  bindingId: z.string().min(1),
                  constructorPath: z.array(z.string().min(1)).nullable(),
                  kind: z.literal("unsupported"),
                  reason: z.enum(["ambiguous-binding", "source-analysis-unavailable", "unsupported-binding-form"]),
                  sourceLine: z.number().int().positive(),
                  sourceVariable: z
                    .string()
                    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
                    .nullable(),
                })
                .strict(),
            ]),
          ),
          name: manimSceneNameSchema,
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
      .enum([
        "durable-render-unavailable",
        "durable-render-unconfigured",
        "local-command-unavailable",
        "native-render-frozen",
      ])
      .nullable(),
  })
  .strict()
  .refine(
    (capability) =>
      capability.available
        ? capability.unavailableReason === null
        : capability.unavailableReason === "native-render-frozen"
          ? true
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
    nativeDocument: z
      .object({ documentKey: z.string().regex(/^[0-9a-f]{64}$/u) })
      .strict()
      .optional(),
    projectId: manimProjectIdSchema,
    projectName: z.string().min(1).max(120),
    renderCapability: manimRenderCapabilitySchema,
    sources: z.array(manimWorkspaceSourceSchema),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (workspace.nativeDocument && workspace.sources.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A Studio-native workspace cannot also expose imported Manim sources.",
        path: ["sources"],
      });
    }
  });

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
  z
    .object({
      kind: z.literal("studio-native"),
      name: manimProjectNameSchema,
    })
    .strict(),
]);

export const browserManimProjectImportRequestV1Schema: z.ZodType<BrowserManimProjectImportRequestV1> = z
  .object({
    imagePngBase64: z
      .string()
      .max(MAX_BROWSER_MANIM_IMAGE_PNG_BASE64_LENGTH_V1)
      .refine((value) => {
        const decodedLength = canonicalBase64DecodedByteLength(value);
        return decodedLength !== null && decodedLength <= MAX_BROWSER_MANIM_IMAGE_PNG_BYTES_V1;
      }, "Project image.png must use non-empty canonical base64 within the 512 KiB byte limit.")
      .nullable(),
    name: manimProjectNameSchema,
    source: z
      .string()
      .min(1, "The selected Python file is empty.")
      .refine(
        (source) => new TextEncoder().encode(source).byteLength <= MAX_BROWSER_MANIM_SOURCE_BYTES_V1,
        `Browser imports accept at most ${MAX_BROWSER_MANIM_SOURCE_BYTES_V1} UTF-8 bytes.`,
      )
      .refine((source) => !source.includes("\0"), "Python source cannot contain NUL bytes."),
    sourceName: z
      .string()
      .min(1)
      .max(240)
      .regex(/^[^/\\\u0000-\u001f\u007f]+[.]py$/u, "Select one Python .py file without a directory path.")
      .refine(
        (sourceName) => manimSourcePathSchema.safeParse(sourceName).success,
        "Select one normalized Python .py file without a directory path.",
      ),
  })
  .strict();

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
    imageLineage: z.literal("editor-document").optional(),
    imageKind: z.enum(["empty", "rendered", "semantic"]),
    projectId: manimProjectIdSchema,
    sceneName: manimSceneNameSchema.nullable(),
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
    if (status.imageLineage === "editor-document") {
      if (
        hasTarget ||
        status.cachedSourceHash !== null ||
        status.generatedAt === null ||
        status.imageKind !== "rendered" ||
        status.error !== null ||
        (status.state !== "current" && status.state !== "stale")
      ) {
        context.addIssue({
          code: "custom",
          message: "An Editor Document thumbnail must expose one rendered current or stale publication.",
        });
      }
      return;
    }
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
