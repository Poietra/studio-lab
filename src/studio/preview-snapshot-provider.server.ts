import { z } from "zod";
import {
  opaqueIdV1Schema,
  parseVerifiedSceneIrBundleV1,
  sha256V1Schema,
  sourceIdentityV1Schema,
} from "../engine/contracts";
import { digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSceneIdentityV1,
  type StudioPreviewSnapshotProviderV1,
} from "./preview-snapshot-provider";

const SNAPSHOT_RUN_SCHEMA = "poietra.fast-manim-snapshot-run";
const SNAPSHOT_RESULT_SCHEMA = "poietra.fast-manim-snapshot-result";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024 + 32 * 1024;
const ZERO_SHA256 = "0".repeat(64);

const projectIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const sceneNameSchema = z
  .string()
  .max(240)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const sourcePathSchema = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      value.length <= 500 &&
      !/[\u0000-\u001f\u007f]/.test(value) &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[A-Za-z]:/.test(value) &&
      value.endsWith(".py") &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  );
const identitySchema = z
  .object({
    projectId: projectIdSchema,
    sceneName: sceneNameSchema,
    sourceHash: sha256V1Schema,
    sourcePath: sourcePathSchema,
  })
  .strict();

const compiledSnapshotSchema = z
  .object({
    bundle: z.unknown(),
    kind: z.literal("compiled"),
    projectId: projectIdSchema,
    requestId: opaqueIdV1Schema,
    runtimeConfigHash: sha256V1Schema,
    sceneId: sourceIdentityV1Schema,
    sceneName: sceneNameSchema,
    schema: z.literal(SNAPSHOT_RESULT_SCHEMA),
    snapshotHash: sha256V1Schema,
    sourceHash: sha256V1Schema,
    sourcePath: sourcePathSchema,
    version: z.literal(1),
  })
  .strict();

const verifiedRunViewSchema = z
  .object({
    projectId: projectIdSchema,
    publishedAt: z.iso.datetime(),
    requestId: opaqueIdV1Schema,
    revision: z.number().int().positive(),
    runtimeConfigHash: sha256V1Schema,
    sceneName: sceneNameSchema,
    schema: z.literal(SNAPSHOT_RUN_SCHEMA),
    snapshot: compiledSnapshotSchema,
    sourcePath: sourcePathSchema,
    status: z.literal("verified"),
    version: z.literal(1),
  })
  .strict();

const runStatusSchema = z.object({ status: z.enum(["failed", "stale", "unsupported", "verified"]) }).passthrough();

export type ServerPreviewSnapshotProviderOptionsV1 = Readonly<{
  fetcher?: typeof globalThis.fetch;
  requestIdFactory?: () => string;
}>;

function providerError(message: string, cause?: unknown) {
  return new Error(message, cause === undefined ? undefined : { cause });
}

function assertEqual(label: string, actual: string, expected: string) {
  if (actual !== expected) throw providerError(`The verified Scene snapshot has stale ${label} correlation.`);
}

async function expectedSceneId(identity: StudioPreviewSceneIdentityV1) {
  const bytes = new TextEncoder().encode(`${identity.sourcePath}\u0000${identity.sceneName}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `scene:${hex}`;
}

async function readBoundedJson(response: Response) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json")
    throw providerError("The Scene snapshot endpoint returned a non-JSON response.");
  const lengthHeader = response.headers.get("content-length");
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw providerError("The Scene snapshot endpoint response is too large.");
  }
  const chunks: Uint8Array[] = [];
  let encodedBytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      encodedBytes += value.byteLength;
      if (encodedBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw providerError("The Scene snapshot endpoint response is too large.");
      }
      chunks.push(value);
    }
  }
  const encoded = new Uint8Array(encodedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(encoded);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw providerError("The Scene snapshot endpoint returned malformed JSON.", cause);
  }
}

async function validateVerifiedRun(value: unknown, identity: StudioPreviewSceneIdentityV1, requestId: string) {
  const status = runStatusSchema.safeParse(value);
  if (!status.success) throw providerError("The Scene snapshot endpoint returned a malformed run state.", status.error);
  if (status.data.status !== "verified") {
    throw providerError(`The Scene snapshot endpoint did not verify this Scene (${status.data.status}).`);
  }
  const parsed = verifiedRunViewSchema.safeParse(value);
  if (!parsed.success)
    throw providerError("The Scene snapshot endpoint returned a malformed verified snapshot.", parsed.error);
  const run = parsed.data;
  assertEqual("project", run.projectId, identity.projectId);
  assertEqual("request", run.requestId, requestId);
  assertEqual("source path", run.sourcePath, identity.sourcePath);
  assertEqual("Scene name", run.sceneName, identity.sceneName);

  const envelope = run.snapshot;
  assertEqual("snapshot project", envelope.projectId, identity.projectId);
  assertEqual("snapshot request", envelope.requestId, requestId);
  assertEqual("snapshot source path", envelope.sourcePath, identity.sourcePath);
  assertEqual("snapshot Scene name", envelope.sceneName, identity.sceneName);
  assertEqual("source hash", envelope.sourceHash, identity.sourceHash);
  assertEqual("runtime configuration", envelope.runtimeConfigHash, run.runtimeConfigHash);
  if (envelope.snapshotHash === ZERO_SHA256) throw providerError("The verified Scene snapshot is not server-sealed.");

  let bundle;
  try {
    bundle = await parseVerifiedSceneIrBundleV1(envelope.bundle);
  } catch (cause) {
    throw providerError("The verified Scene snapshot contains an invalid Scene IR bundle.", cause);
  }
  const canonicalSceneId = await expectedSceneId(identity);
  assertEqual("canonical Scene ID", envelope.sceneId, canonicalSceneId);
  assertEqual("Scene IR ID", bundle.scene.sceneId, canonicalSceneId);
  const source = bundle.scene.source;
  if (source.kind !== "imported-manim-server-snapshot") {
    throw providerError("The verified Scene snapshot does not carry server snapshot source evidence.");
  }
  assertEqual("Scene IR source hash", source.sourceHash, identity.sourceHash);
  assertEqual("Scene IR runtime configuration", source.runtimeConfigHash, run.runtimeConfigHash);
  assertEqual("Scene IR server seal", source.snapshotHash, envelope.snapshotHash);
  const canonicalSnapshotHash = await digestFastManimSnapshotBundleInBrowserV1(bundle);
  assertEqual("canonical snapshot digest", canonicalSnapshotHash, envelope.snapshotHash);
  const engineRevisionHash = sceneIrSourceRevisionHash(bundle.scene);
  assertEqual("engine revision", engineRevisionHash, envelope.snapshotHash);
  assertEqual("asset manifest", bundle.scene.assetManifest.manifestDigest, bundle.assets.manifestDigest);
  return { bundle, engineRevisionHash, run };
}

/**
 * Same-origin production provider for the issue #65 Scene snapshot endpoint.
 * The server publication revision is retained as publication evidence only;
 * the canvas worker revision is always the verified Scene IR source hash.
 */
export function createServerPreviewSnapshotProviderV1(
  options: ServerPreviewSnapshotProviderOptionsV1 = {},
): StudioPreviewSnapshotProviderV1 {
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const requestIdFactory = options.requestIdFactory ?? (() => `studio-preview:${globalThis.crypto.randomUUID()}`);
  return {
    id: "server-scene-snapshot",
    loadVerifiedSnapshot: async ({ identity: inputIdentity, signal }) => {
      signal?.throwIfAborted();
      const identityResult = identitySchema.safeParse(inputIdentity);
      if (!identityResult.success)
        throw providerError("The Scene snapshot request identity is invalid.", identityResult.error);
      const identity = identityResult.data;
      const requestId = requestIdFactory();
      if (!opaqueIdV1Schema.safeParse(requestId).success)
        throw providerError("The Scene snapshot request ID is invalid.");
      const response = await fetcher(`/api/manim/projects/${encodeURIComponent(identity.projectId)}/scene-snapshots`, {
        body: JSON.stringify({ ...identity, requestId }),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        signal,
      });
      signal?.throwIfAborted();
      if (!response.ok) throw providerError(`The Scene snapshot endpoint failed with HTTP ${response.status}.`);
      const value = await readBoundedJson(response);
      signal?.throwIfAborted();
      const { bundle, engineRevisionHash, run } = await validateVerifiedRun(value, identity, requestId);
      signal?.throwIfAborted();
      return {
        correlation: {
          assetsManifestDigest: bundle.assets.manifestDigest,
          context: {
            ...identity,
            sourceDuration: bundle.scene.duration,
            workingRevision: PRISTINE_WORKING_REVISION,
          },
          engineRevisionHash,
          sceneDuration: bundle.scene.duration,
          sceneId: bundle.scene.sceneId,
          serverPublicationRevision: run.revision,
        },
        duration: bundle.scene.duration,
        sceneId: bundle.scene.sceneId,
        snapshot: bundle,
        sourceLabel: `verified server snapshot r${run.revision}`,
      };
    },
  };
}
