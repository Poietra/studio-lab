import { createHash, randomUUID } from "node:crypto";

import { parseVerifiedSceneIrBundleV1, type SceneIrBundleV1, sceneIrSourceRevisionHash } from "../src/engine/contracts";
import { compileMathTexOutlineV1, compileTextOutlineV1 } from "../src/engine/mathtex-outline";
import {
  compileApplyStaticRootTransformEdit,
  compileApplyStudioCreationEdit,
  compileApplyStudioMathTexTransformEdit,
  compileApplyStudioMotionEdit,
} from "../src/engine/scene-authoring";
import type {
  FastManimRuntimeTraceRunRequestV1,
  FastManimRuntimeTraceRunView,
} from "../src/render-pipeline/runtime-trace-preview-contract";
import { isExactStudioMathTexContentProgramBatch } from "../src/studio/operations";
import {
  buildStaticRootTransformEditCommand,
  buildStudioCreationEditCommand,
  buildStudioMathTexTransformEditCommand,
  buildStudioMotionEditCommand,
  isExactStudioMathTexTransformProgramBatch,
  isExactStudioMotionProgramBatch,
  staticRootTransformStudioEntities,
  studioCreationMathTexParts,
  studioCreationTextContent,
  studioMathTexTransformStudioEntities,
  studioMotionStudioEntities,
} from "../src/studio/scene-authoring-wire";
import { fastManimRuntimeTraceSceneIdV1 } from "./fast-manim-runtime-trace-contract";
import type {
  FastManimSnapshotQueryV1,
  FastManimSnapshotRunRequestV1,
  FastManimSnapshotRunViewV1,
} from "./fast-manim-snapshot-contract";
import { HttpError } from "./http/json";
import type { SnapshotProgramAuthorizer } from "./manim-render-request-lowering";

export type SnapshotProgramLookup = (
  projectId: string,
  query: FastManimSnapshotQueryV1,
  signal?: AbortSignal,
) => Promise<FastManimSnapshotRunViewV1>;

export type SnapshotProgramRun = (
  request: FastManimSnapshotRunRequestV1,
  signal?: AbortSignal,
) => Promise<FastManimSnapshotRunViewV1>;

export type RuntimeTraceProgramLookup = (
  request: FastManimRuntimeTraceRunRequestV1,
  signal?: AbortSignal,
) => Promise<FastManimRuntimeTraceRunView>;

async function authorizeStudioCreationProgram(
  input: Parameters<SnapshotProgramAuthorizer>[0],
  bundle: SceneIrBundleV1,
  expectedBaseRevision: string,
) {
  const nextRevision = createHash("sha256")
    .update(expectedBaseRevision)
    .update("\0")
    .update(JSON.stringify(input.programs))
    .digest("hex");
  const mathTexOutlines = [];
  const textOutlines = [];
  const textInputs = new Map<
    string,
    Readonly<{
      content: NonNullable<ReturnType<typeof studioCreationTextContent>>;
      entityId: string;
    }>
  >();
  for (const program of input.programs) {
    for (const operation of program.operations) {
      if (operation.kind === "CreateEntity" && operation.entity.type === "MathTex") {
        const texParts = studioCreationMathTexParts(operation.entity.content);
        if (!texParts) {
          throw new HttpError("Studio-created MathTex requires canonical non-empty TeX parts.", 400);
        }
        let response;
        try {
          response = await compileMathTexOutlineV1(texParts);
        } catch {
          throw new HttpError("The server MathTex outline compiler is unavailable.", 503);
        }
        if (response.result.kind === "unsupported") {
          if (response.result.code === "internal-failure") {
            throw new HttpError("The server MathTex outline compiler failed.", 500);
          }
          throw new HttpError(
            `Studio-created MathTex is unsupported (${response.result.code}): ${response.result.message}`,
            400,
          );
        }
        mathTexOutlines.push({ entityId: operation.entity.id, path: response.result.path, texParts });
      } else if (operation.kind === "CreateEntity" && operation.entity.type === "Text") {
        const content = studioCreationTextContent(operation.entity.content);
        if (!content) {
          throw new HttpError("Studio-created Text requires bounded canonical Unicode content and layout.", 400);
        }
        textInputs.set(
          `${operation.entity.id}\u0000${content.text}\u0000${content.layout.alignment}\u0000${content.layout.fontFamily}\u0000${content.layout.fontSize}\u0000${content.layout.fontWeight}\u0000${content.layout.lineHeight}`,
          { content, entityId: operation.entity.id },
        );
      } else if (operation.kind === "TransformContent" && operation.targetType === "Text") {
        const content = studioCreationTextContent(operation.replacement);
        if (!content) {
          throw new HttpError(
            "Studio-created Text transform requires bounded canonical Unicode content and layout.",
            400,
          );
        }
        textInputs.set(
          `${operation.targetEntityId}\u0000${content.text}\u0000${content.layout.alignment}\u0000${content.layout.fontFamily}\u0000${content.layout.fontSize}\u0000${content.layout.fontWeight}\u0000${content.layout.lineHeight}`,
          { content, entityId: operation.targetEntityId },
        );
      }
    }
  }
  for (const { content, entityId } of textInputs.values()) {
    let response;
    try {
      response = await compileTextOutlineV1({
        layout: {
          alignment: content.layout.alignment,
          fontFamily: content.layout.fontFamily,
          fontWeight: content.layout.fontWeight,
          lineHeight: content.layout.lineHeight,
        },
        text: content.text,
      });
    } catch {
      throw new HttpError("The server Text outline compiler is unavailable.", 503);
    }
    if (response.result.kind === "unsupported") {
      if (response.result.code === "internal-failure") {
        throw new HttpError("The server Text outline compiler failed.", 500);
      }
      throw new HttpError(
        `Studio-created Text is unsupported (${response.result.code}): ${response.result.message}`,
        400,
      );
    }
    textOutlines.push({
      entityId,
      fragments: response.result.fragments.map(({ order, path, sourceCorrelation }) => ({
        order,
        path,
        sourceCorrelation,
      })),
      layout: content.layout,
      path: response.result.path,
      text: content.text,
    });
  }
  await compileApplyStudioCreationEdit(
    bundle,
    buildStudioCreationEditCommand({
      expectedBaseRevision,
      frame: input.frame,
      mathTexOutlines,
      nextRevision,
      programs: input.programs,
      textOutlines,
      viewport: input.request.viewport,
    }),
  );
}

export async function authorizeStudioCreationProgramWithRuntimeTrace(
  input: Parameters<SnapshotProgramAuthorizer>[0],
  runtimeTraceLookup: RuntimeTraceProgramLookup,
  signal?: AbortSignal,
) {
  if (input.authorizationKind !== "studio-creation") {
    throw new HttpError("Runtime Trace authorization is limited to Studio-created entities.", 400);
  }
  signal?.throwIfAborted();
  const requestId = randomUUID();
  const request = {
    projectId: input.projectId,
    requestId,
    sceneName: input.request.sceneName,
    sourceHash: input.request.sourceHash,
    sourcePath: input.request.sourcePath,
  } satisfies FastManimRuntimeTraceRunRequestV1;
  const run = await runtimeTraceLookup(request, signal);
  signal?.throwIfAborted();
  if (run.status !== "verified" || run.version !== 2) {
    throw new HttpError("This Program requires a currently verified Runtime Trace.", 409);
  }
  const sceneId = fastManimRuntimeTraceSceneIdV1(request.sourcePath, request.sceneName);
  if (
    run.projectId !== request.projectId ||
    run.requestId !== request.requestId ||
    run.sceneId !== sceneId ||
    run.sceneName !== request.sceneName ||
    run.sourceHash !== request.sourceHash ||
    run.sourcePath !== request.sourcePath
  ) {
    throw new HttpError("The verified Runtime Trace does not match this render request.", 409);
  }
  const bundle = await parseVerifiedSceneIrBundleV1(run.bundle);
  const source = bundle.scene.source;
  if (
    bundle.scene.sceneId !== sceneId ||
    source.kind !== "imported-manim-runtime-trace" ||
    source.traceVersion !== 3 ||
    source.sourceHash !== request.sourceHash ||
    source.runtimeConfigHash !== run.runtimeConfigHash ||
    source.traceDigest !== run.traceDigest ||
    sceneIrSourceRevisionHash(bundle.scene) !== run.traceDigest ||
    bundle.assets.assets.length !== 0
  ) {
    throw new HttpError("The verified Runtime Trace has stale source correlation.", 409);
  }
  await authorizeStudioCreationProgram(input, bundle, run.traceDigest);
}

export async function authorizeSnapshotProgramWithSnapshot(
  input: Parameters<SnapshotProgramAuthorizer>[0],
  snapshotLookup: SnapshotProgramLookup,
  signal?: AbortSignal,
  snapshotRun?: SnapshotProgramRun,
) {
  signal?.throwIfAborted();
  let published: FastManimSnapshotRunViewV1;
  let freshRequestId: string | null = null;
  try {
    published = await snapshotLookup(
      input.projectId,
      { sceneName: input.request.sceneName, sourcePath: input.request.sourcePath },
      signal,
    );
  } catch (error) {
    if (
      !snapshotRun ||
      input.authorizationKind !== "snapshot" ||
      !isExactStudioMathTexContentProgramBatch(input.programs) ||
      !(error instanceof HttpError) ||
      error.status !== 404
    ) {
      throw error;
    }
    freshRequestId = randomUUID();
    published = await snapshotRun(
      {
        projectId: input.projectId,
        requestId: freshRequestId,
        sceneName: input.request.sceneName,
        sourceHash: input.request.sourceHash,
        sourcePath: input.request.sourcePath,
      },
      signal,
    );
  }
  signal?.throwIfAborted();
  if (freshRequestId !== null && published.requestId !== freshRequestId) {
    throw new HttpError("The fresh verified Scene snapshot has stale request correlation.", 409);
  }
  if (published.status !== "verified") {
    throw new HttpError("This Program requires a currently verified Scene snapshot.", 409);
  }
  const { snapshot } = published;
  if (
    published.projectId !== input.projectId ||
    published.sceneName !== input.request.sceneName ||
    published.sourcePath !== input.request.sourcePath ||
    snapshot.projectId !== input.projectId ||
    snapshot.sceneName !== input.request.sceneName ||
    snapshot.sourcePath !== input.request.sourcePath ||
    snapshot.sourceHash !== input.request.sourceHash
  ) {
    throw new HttpError("The verified Scene snapshot does not match this render request.", 409);
  }
  const bundle = await parseVerifiedSceneIrBundleV1(snapshot.bundle);
  const source = bundle.scene.source;
  if (
    source.kind !== "imported-manim-server-snapshot" ||
    source.sourceHash !== input.request.sourceHash ||
    source.runtimeConfigHash !== published.runtimeConfigHash ||
    source.snapshotHash !== snapshot.snapshotHash ||
    sceneIrSourceRevisionHash(bundle.scene) !== snapshot.snapshotHash
  ) {
    throw new HttpError("The verified Scene snapshot has stale source correlation.", 409);
  }
  const hasStudioCreation = input.programs.some((program) =>
    program.operations.some((operation) => operation.kind === "CreateEntity"),
  );
  if (hasStudioCreation) {
    await authorizeStudioCreationProgram(input, bundle, snapshot.snapshotHash);
    return;
  }
  const nextRevision = createHash("sha256")
    .update(snapshot.snapshotHash)
    .update("\0")
    .update(JSON.stringify(input.programs))
    .digest("hex");
  const sourceRuntimeBindings = (published.sourceRuntimeIdentity?.mappings ?? []).map((mapping) => ({
    runtimeEntityId: mapping.entityId,
    sourceIdentityKey: mapping.binding.name,
    sourceName: mapping.binding.name,
  }));
  if (isExactStudioMathTexContentProgramBatch(input.programs)) {
    const operation = input.programs[0]?.operations[0];
    if (operation?.kind !== "SetProperty" || operation.key !== "content") {
      throw new HttpError("The MathTex content Program is malformed.", 400);
    }
    const texParts = studioCreationMathTexParts(operation.value);
    if (!texParts) {
      throw new HttpError("Imported MathTex content replacement requires canonical non-empty TeX parts.", 400);
    }
    let response;
    try {
      response = await compileMathTexOutlineV1(texParts);
    } catch {
      throw new HttpError("The server MathTex outline compiler is unavailable.", 503);
    }
    if (response.result.kind === "unsupported") {
      if (response.result.code === "internal-failure") {
        throw new HttpError("The server MathTex outline compiler failed.", 500);
      }
      throw new HttpError(
        `MathTex content replacement for ${operation.entityId} is unsupported (${response.result.code}): ${response.result.message}`,
        400,
      );
    }
    await compileApplyStaticRootTransformEdit(
      bundle,
      buildStaticRootTransformEditCommand({
        expectedBaseRevision: snapshot.snapshotHash,
        frame: input.frame,
        mathTexOutlines: [{ entityId: operation.entityId, path: response.result.path, texParts }],
        nextRevision,
        programs: input.programs,
        sourceRuntimeBindings,
        studioEntities: staticRootTransformStudioEntities(input.runtimeSceneState),
        viewport: input.request.viewport,
      }),
    );
    return;
  }
  if (isExactStudioMathTexTransformProgramBatch(input.programs)) {
    const mathTexOutlines = [];
    for (const program of input.programs) {
      for (const operation of program.operations) {
        if (operation.kind !== "TransformContent") continue;
        const texParts = studioCreationMathTexParts(operation.replacement);
        if (!texParts) continue;
        let response;
        try {
          response = await compileMathTexOutlineV1(texParts);
        } catch {
          throw new HttpError("The server MathTex outline compiler is unavailable.", 503);
        }
        if (response.result.kind === "unsupported") {
          if (response.result.code === "internal-failure") {
            throw new HttpError("The server MathTex outline compiler failed.", 500);
          }
          throw new HttpError(
            `MathTex transform target ${operation.targetEntityId} is unsupported (${response.result.code}): ${response.result.message}`,
            400,
          );
        }
        mathTexOutlines.push({ entityId: operation.targetEntityId, path: response.result.path, texParts });
      }
    }
    await compileApplyStudioMathTexTransformEdit(
      bundle,
      buildStudioMathTexTransformEditCommand({
        expectedBaseRevision: snapshot.snapshotHash,
        frame: input.frame,
        mathTexOutlines,
        nextRevision,
        programs: input.programs,
        sourceRuntimeBindings,
        studioEntities: studioMathTexTransformStudioEntities(input.runtimeSceneState),
        viewport: input.request.viewport,
      }),
    );
    return;
  }
  if (isExactStudioMotionProgramBatch(input.programs)) {
    await compileApplyStudioMotionEdit(
      bundle,
      buildStudioMotionEditCommand({
        expectedBaseRevision: snapshot.snapshotHash,
        frame: input.frame,
        nextRevision,
        programs: input.programs,
        sourceRuntimeBindings,
        studioEntities: studioMotionStudioEntities(input.runtimeSceneState),
        viewport: input.request.viewport,
      }),
    );
    return;
  }
  await compileApplyStaticRootTransformEdit(
    bundle,
    buildStaticRootTransformEditCommand({
      expectedBaseRevision: snapshot.snapshotHash,
      frame: input.frame,
      mathTexOutlines: [],
      nextRevision,
      programs: input.programs,
      sourceRuntimeBindings,
      studioEntities: staticRootTransformStudioEntities(input.runtimeSceneState),
      viewport: input.request.viewport,
    }),
  );
}
