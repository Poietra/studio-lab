import { createHash } from "node:crypto";

import { parseVerifiedSceneIrBundleV1, sceneIrSourceRevisionHash } from "../src/engine/contracts";
import { compileApplyStaticRootTransformEdit, compileApplyStudioCreationEdit } from "../src/engine/scene-authoring";
import {
  buildStaticRootTransformEditCommand,
  buildStudioCreationEditCommand,
  staticRootTransformStudioEntities,
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
    if (
      input.programs.some((program) =>
        program.operations.some(
          (operation) => operation.kind === "CreateEntity" && operation.entity.type === "MathTex",
        ),
      )
    ) {
      throw new HttpError("Server rendering cannot yet authorize Studio-created MathTex outlines.", 400);
    }
    await compileApplyStudioCreationEdit(
      bundle,
      buildStudioCreationEditCommand({
        expectedBaseRevision: snapshot.snapshotHash,
        frame: input.frame,
        mathTexOutlines: [],
        nextRevision,
        programs: input.programs,
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
      nextRevision,
      programs: input.programs,
      sourceRuntimeBindings: (published.sourceRuntimeIdentity?.mappings ?? []).map((mapping) => ({
        runtimeEntityId: mapping.entityId,
        sourceIdentityKey: mapping.binding.name,
        sourceName: mapping.binding.name,
      })),
      studioEntities: staticRootTransformStudioEntities(input.runtimeSceneState),
      viewport: input.request.viewport,
    }),
  );
}
