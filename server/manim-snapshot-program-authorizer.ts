import { createHash } from "node:crypto";

import { parseVerifiedSceneIrBundleV1, sceneIrSourceRevisionHash } from "../src/engine/contracts";
import { compileMathTexOutlineV1, compileTextOutlineV1 } from "../src/engine/mathtex-outline";
import {
  compileApplyStaticRootTransformEdit,
  compileApplyStudioCreationEdit,
  compileApplyStudioMathTexTransformEdit,
  compileApplyStudioMotionEdit,
} from "../src/engine/scene-authoring";
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
import type { FastManimSnapshotQueryV1, FastManimSnapshotRunViewV1 } from "./fast-manim-snapshot-contract";
import { HttpError } from "./http/json";
import type { SnapshotProgramAuthorizer } from "./manim-render-request-lowering";

export type SnapshotProgramLookup = (
  projectId: string,
  query: FastManimSnapshotQueryV1,
  signal?: AbortSignal,
) => Promise<FastManimSnapshotRunViewV1>;

export async function authorizeSnapshotProgramWithSnapshot(
  input: Parameters<SnapshotProgramAuthorizer>[0],
  snapshotLookup: SnapshotProgramLookup,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const published = await snapshotLookup(
    input.projectId,
    { sceneName: input.request.sceneName, sourcePath: input.request.sourcePath },
    signal,
  );
  signal?.throwIfAborted();
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
  const nextRevision = createHash("sha256")
    .update(snapshot.snapshotHash)
    .update("\0")
    .update(JSON.stringify(input.programs))
    .digest("hex");
  const hasStudioCreation = input.programs.some((program) =>
    program.operations.some((operation) => operation.kind === "CreateEntity"),
  );
  if (hasStudioCreation) {
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
            `${operation.entity.id}\u0000${content.text}\u0000${content.layout.alignment}\u0000${content.layout.fontSize}\u0000${content.layout.lineHeight}`,
            { content, entityId: operation.entity.id },
          );
        }
      }
    }
    for (const { content, entityId } of textInputs.values()) {
      let response;
      try {
        response = await compileTextOutlineV1({
          layout: { alignment: content.layout.alignment, lineHeight: content.layout.lineHeight },
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
      textOutlines.push({ entityId, layout: content.layout, path: response.result.path, text: content.text });
    }
    await compileApplyStudioCreationEdit(
      bundle,
      buildStudioCreationEditCommand({
        expectedBaseRevision: snapshot.snapshotHash,
        frame: input.frame,
        mathTexOutlines,
        nextRevision,
        programs: input.programs,
        textOutlines,
        viewport: input.request.viewport,
      }),
    );
    return;
  }
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
