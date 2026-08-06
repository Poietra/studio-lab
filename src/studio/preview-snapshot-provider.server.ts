import { z } from "zod";
import { fetchOrganizationScopedManimApiV1 } from "../accounts/organization-scoped-manim-fetch";
import type { CanvasPngAssetTransferV1 } from "../engine/canvas-png-assets";
import {
  opaqueIdV1Schema,
  parseVerifiedSceneIrBundleV1,
  sha256V1Schema,
  sourceIdentityV1Schema,
} from "../engine/contracts";
import { digestFastManimSnapshotBundleInBrowserV1 } from "../engine/fast-manim-snapshot-digest";
import { sceneIrSourceRevisionHash } from "../engine/scene-ir";
import { verifiedSourceRuntimeIdentityMapV1Schema } from "../engine/source-runtime-identity";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../render-pipeline/manim-identity-contract";
import { fastManimRuntimeTraceRunViewV1Schema } from "../render-pipeline/runtime-trace-preview-contract";
import {
  PRISTINE_WORKING_REVISION,
  type StudioPreviewSceneIdentityV1,
  StudioPreviewSnapshotLoadErrorV1,
  type StudioPreviewSnapshotProviderV1,
} from "./preview-snapshot-provider";

const SNAPSHOT_RUN_SCHEMA = "poietra.fast-manim-snapshot-run";
const SNAPSHOT_RESULT_SCHEMA = "poietra.fast-manim-snapshot-result";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024 + 64 * 1024;
const MAX_RUNTIME_TRACE_RESPONSE_BYTES = 88 * 1024 * 1024 + 64 * 1024;
const ZERO_SHA256 = "0".repeat(64);

const identitySchema = z
  .object({
    projectId: manimProjectIdSchema,
    sceneName: manimSceneNameSchema,
    sourceHash: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
  })
  .strict();

const compiledSnapshotSchema = z
  .object({
    bundle: z.unknown(),
    kind: z.literal("compiled"),
    projectId: manimProjectIdSchema,
    requestId: opaqueIdV1Schema,
    runtimeConfigHash: sha256V1Schema,
    sceneId: sourceIdentityV1Schema,
    sceneName: manimSceneNameSchema,
    schema: z.literal(SNAPSHOT_RESULT_SCHEMA),
    snapshotHash: sha256V1Schema,
    sourceHash: sha256V1Schema,
    sourcePath: manimSourcePathSchema,
    version: z.literal(1),
  })
  .strict();

const verifiedRunViewSchema = z
  .object({
    projectId: manimProjectIdSchema,
    publishedAt: z.iso.datetime(),
    requestId: opaqueIdV1Schema,
    revision: z.number().int().positive(),
    runtimeConfigHash: sha256V1Schema,
    sceneName: manimSceneNameSchema,
    schema: z.literal(SNAPSHOT_RUN_SCHEMA),
    snapshot: compiledSnapshotSchema,
    sourceRuntimeIdentity: verifiedSourceRuntimeIdentityMapV1Schema.optional(),
    sourcePath: manimSourcePathSchema,
    status: z.literal("verified"),
    version: z.literal(1),
  })
  .strict();

const runStatusSchema = z.object({ status: z.enum(["failed", "stale", "unsupported", "verified"]) }).passthrough();

export type ServerPreviewSnapshotProviderOptionsV1 = Readonly<{
  fetcher?: typeof globalThis.fetch;
  requestIdFactory?: () => string;
}>;

function providerError(message: string, cause?: unknown, failureKind: "failed" | "unsupported" = "failed") {
  return new StudioPreviewSnapshotLoadErrorV1(message, failureKind, cause === undefined ? undefined : { cause });
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

async function readBoundedJson(response: Response, maxBytes = MAX_RESPONSE_BYTES) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json")
    throw providerError("The Scene snapshot endpoint returned a non-JSON response.");
  const lengthHeader = response.headers.get("content-length");
  const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
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
      if (encodedBytes > maxBytes) {
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

async function readBoundedPng(response: Response, expectedLength: number) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "image/png") throw providerError("The Scene snapshot asset endpoint returned a non-PNG response.");
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(lengthHeader)) {
      throw providerError("The Scene snapshot asset endpoint returned an invalid content length.");
    }
    const declaredLength = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength !== expectedLength) {
      throw providerError("The Scene snapshot asset endpoint content length does not match its manifest.");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw providerError("The Scene snapshot asset endpoint returned no PNG body.");
  const bytes = new Uint8Array(expectedLength);
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > expectedLength) {
      await reader.cancel();
      throw providerError("The Scene snapshot asset endpoint response exceeds its manifest byte length.");
    }
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== expectedLength) {
    throw providerError("The Scene snapshot asset endpoint response is shorter than its manifest byte length.");
  }
  return bytes.buffer;
}

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadSnapshotAssetPayloads(
  fetcher: typeof globalThis.fetch,
  projectId: string,
  assets: Awaited<ReturnType<typeof validateVerifiedRun>>["bundle"]["assets"]["assets"],
  signal?: AbortSignal,
) {
  const payloads: CanvasPngAssetTransferV1[] = [];
  for (const asset of assets) {
    signal?.throwIfAborted();
    const response = await fetcher(
      `/api/manim/projects/${encodeURIComponent(projectId)}/scene-snapshot-assets/${asset.sha256}`,
      { headers: { accept: "image/png" }, method: "GET", signal },
    );
    signal?.throwIfAborted();
    if (!response.ok) throw providerError(`The Scene snapshot asset endpoint failed with HTTP ${response.status}.`);
    const bytes = await readBoundedPng(response, asset.byteLength);
    signal?.throwIfAborted();
    if ((await sha256Hex(bytes)) !== asset.sha256) {
      throw providerError("The Scene snapshot asset endpoint returned bytes with a stale digest.");
    }
    payloads.push({
      assetId: asset.id,
      byteLength: asset.byteLength,
      bytes,
      mediaType: asset.mediaType,
      pixelHeight: asset.pixelHeight,
      pixelWidth: asset.pixelWidth,
      sha256: asset.sha256,
    });
  }
  return payloads;
}

async function validateVerifiedRun(value: unknown, identity: StudioPreviewSceneIdentityV1, requestId: string) {
  const status = runStatusSchema.safeParse(value);
  if (!status.success) throw providerError("The Scene snapshot endpoint returned a malformed run state.", status.error);
  if (status.data.status !== "verified") {
    throw providerError(
      `The Scene snapshot endpoint did not verify this Scene (${status.data.status}).`,
      undefined,
      status.data.status === "unsupported" ? "unsupported" : "failed",
    );
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
  const sourceRuntimeIdentity = (() => {
    const verified = run.sourceRuntimeIdentity;
    if (!verified) return null;
    assertEqual("identity source hash", verified.sourceHash, identity.sourceHash);
    assertEqual("identity Scene ID", verified.sceneId, canonicalSceneId);
    assertEqual("identity runtime configuration", verified.runtimeConfigHash, run.runtimeConfigHash);
    assertEqual("identity snapshot seal", verified.snapshotHash, envelope.snapshotHash);
    const entities = new Map(bundle.scene.entities.map((entity) => [entity.id, entity]));
    const writeStuffGroupId =
      source.snapshotVersion === 12
        ? bundle.scene.entities.find(
            ({ geometry, parentId, sceneOrder }) => geometry.kind === "group" && parentId === null && sceneOrder === 0,
          )?.id
        : undefined;
    const bySourceName = new Map<string, Readonly<{ bindingId: string; entityId: string; sourceName: string }>>();
    const bindingIds = new Set<string>();
    const runtimeEntityIds = new Set<string>();
    for (const mapping of verified.mappings) {
      const entity = entities.get(mapping.entityId);
      const expectedFamilyPath = (() => {
        if (!entity) return null;
        if (source.snapshotVersion === 12) {
          const expected =
            mapping.binding.name === "group"
              ? { parentId: null, path: [] as number[], sceneOrder: 0 }
              : mapping.binding.name === "example_text"
                ? { parentId: writeStuffGroupId, path: [0], sceneOrder: 1 }
                : mapping.binding.name === "example_tex"
                  ? { parentId: writeStuffGroupId, path: [1], sceneOrder: 32 }
                  : null;
          return expected !== null &&
            entity.geometry.kind === "group" &&
            entity.parentId === expected.parentId &&
            entity.sceneOrder === expected.sceneOrder
            ? expected.path
            : null;
        }
        if (source.snapshotVersion === 10 || source.snapshotVersion === 11) {
          return entity.sceneOrder === 0 ? [] : [entity.sceneOrder - 1];
        }
        return [];
      })();
      if (
        !entity ||
        expectedFamilyPath === null ||
        entity.provenanceId !== mapping.provenanceId ||
        JSON.stringify(mapping.familyPath) !== JSON.stringify(expectedFamilyPath)
      ) {
        throw providerError("The verified source/runtime mapping does not name one exact Scene IR entity.");
      }
      if (
        bySourceName.has(mapping.binding.name) ||
        bindingIds.has(mapping.binding.id) ||
        runtimeEntityIds.has(mapping.entityId)
      ) {
        throw providerError("The verified source/runtime mapping is not one-to-one.");
      }
      const browserMapping = {
        bindingId: mapping.binding.id,
        entityId: mapping.entityId,
        sourceName: mapping.binding.name,
      } as const;
      bySourceName.set(mapping.binding.name, browserMapping);
      bindingIds.add(mapping.binding.id);
      runtimeEntityIds.add(mapping.entityId);
    }
    if (
      source.snapshotVersion === 12 &&
      (writeStuffGroupId === undefined ||
        bySourceName.size !== 3 ||
        !bySourceName.has("group") ||
        !bySourceName.has("example_text") ||
        !bySourceName.has("example_tex"))
    ) {
      throw providerError("The verified WriteStuff source/runtime mapping is incomplete.");
    }
    return bySourceName;
  })();
  return {
    bundle,
    engineRevisionHash,
    publicationRevision: run.revision,
    sourceLabel: `verified server snapshot r${run.revision}`,
    sourceRuntimeIdentity,
  };
}

async function validateVerifiedRuntimeTraceRun(
  value: unknown,
  identity: StudioPreviewSceneIdentityV1,
  requestId: string,
) {
  const parsed = fastManimRuntimeTraceRunViewV1Schema.safeParse(value);
  if (!parsed.success) throw providerError("The Runtime Trace endpoint returned malformed evidence.", parsed.error);
  const run = parsed.data;
  if (run.status !== "verified") {
    throw providerError(
      `The Runtime Trace endpoint did not verify this Scene (${run.status}).`,
      undefined,
      run.failure.code === "unsupported-profile" ? "unsupported" : "failed",
    );
  }
  assertEqual("project", run.projectId, identity.projectId);
  assertEqual("request", run.requestId, requestId);
  assertEqual("source path", run.sourcePath, identity.sourcePath);
  assertEqual("Scene name", run.sceneName, identity.sceneName);
  assertEqual("source hash", run.sourceHash, identity.sourceHash);

  let bundle;
  try {
    bundle = await parseVerifiedSceneIrBundleV1(run.bundle);
  } catch (cause) {
    throw providerError("The Runtime Trace endpoint contains an invalid Scene IR bundle.", cause);
  }
  const canonicalSceneId = await expectedSceneId(identity);
  assertEqual("canonical Scene ID", run.sceneId, canonicalSceneId);
  assertEqual("Scene IR ID", bundle.scene.sceneId, canonicalSceneId);
  const source = bundle.scene.source;
  if (source.kind !== "imported-manim-runtime-trace") {
    throw providerError("The Runtime Trace preview does not carry runtime source evidence.");
  }
  assertEqual("Scene IR source hash", source.sourceHash, identity.sourceHash);
  assertEqual("Scene IR runtime configuration", source.runtimeConfigHash, run.runtimeConfigHash);
  assertEqual("Scene IR trace seal", source.traceDigest, run.traceDigest);
  assertEqual("engine revision", sceneIrSourceRevisionHash(bundle.scene), run.traceDigest);
  assertEqual("asset manifest", bundle.scene.assetManifest.manifestDigest, bundle.assets.manifestDigest);
  if (bundle.assets.assets.length !== 0) {
    throw providerError("Runtime Trace must not publish unrelated asset payloads.");
  }

  const expectedProfile =
    identity.sceneName === "UpdatersExample" && source.traceVersion === 1 && bundle.scene.duration === 6
      ? ({
          roots: [
            { bindingName: "square", role: "square" },
            { bindingName: "decimal", role: "decimal" },
          ],
        } as const)
      : identity.sceneName === "OpeningManim" && source.traceVersion === 2 && bundle.scene.duration === 15
        ? ({
            roots: [
              { bindingName: "title", role: "title" },
              { bindingName: "basel", role: "basel" },
              { bindingName: "grid", role: "grid" },
              { bindingName: "grid_title", role: "grid-title" },
            ],
          } as const)
        : null;
  const entities = new Map(bundle.scene.entities.map((entity) => [entity.id, entity]));
  if (source.traceVersion === 3) {
    if (
      run.roots.length !== 0 ||
      !bundle.scene.entities.some((entity) => entity.parentId === null && entity.geometry.kind === "group")
    ) {
      throw providerError("The generic Runtime Trace contains invalid preview-only roots.");
    }
    return {
      bundle,
      engineRevisionHash: run.traceDigest,
      publicationRevision: null,
      sourceLabel: "verified Runtime Trace (preview-only)",
      sourceRuntimeIdentity: new Map(),
    };
  }
  if (!expectedProfile) {
    throw providerError("The Runtime Trace preview does not match a reviewed Scene profile.");
  }

  const sourceRuntimeIdentity = new Map<
    string,
    Readonly<{ bindingId: string; entityId: string; sourceName: string }>
  >();
  let motionRootId: string | null = null;
  if (run.roots.length !== expectedProfile.roots.length) {
    throw providerError("The Runtime Trace source roots do not match the reviewed profile.");
  }
  for (const [index, expectedRoot] of expectedProfile.roots.entries()) {
    const root = run.roots[index];
    const entity = root ? entities.get(root.entityId) : undefined;
    if (
      !root ||
      root.binding.name !== expectedRoot.bindingName ||
      root.entityId !== `${canonicalSceneId}/runtime-root:${expectedRoot.role}` ||
      !entity ||
      entity.geometry.kind !== "group" ||
      entity.parentId === null ||
      (motionRootId !== null && entity.parentId !== motionRootId)
    ) {
      throw providerError("The Runtime Trace source roots do not name the exact reviewed nested groups.");
    }
    motionRootId = entity.parentId;
    sourceRuntimeIdentity.set(expectedRoot.bindingName, {
      bindingId: root.binding.id,
      entityId: root.entityId,
      sourceName: expectedRoot.bindingName,
    });
  }
  const motionRoot = motionRootId === null ? undefined : entities.get(motionRootId);
  if (!motionRoot || motionRoot.geometry.kind !== "group" || motionRoot.parentId !== null) {
    throw providerError("The Runtime Trace source roots do not share one top-level motion group.");
  }
  return {
    bundle,
    engineRevisionHash: run.traceDigest,
    publicationRevision: null,
    sourceLabel: "verified Runtime Trace",
    sourceRuntimeIdentity,
  };
}

/**
 * Same-origin production provider for the issue #65 Scene snapshot endpoint.
 * The server publication revision is retained as publication evidence only;
 * the canvas worker revision is always the verified Scene IR source hash.
 */
export function createServerPreviewSnapshotProviderV1(
  options: ServerPreviewSnapshotProviderOptionsV1 = {},
): StudioPreviewSnapshotProviderV1 {
  const fetcher = options.fetcher ?? fetchOrganizationScopedManimApiV1;
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
      const post = (endpoint: "runtime-traces" | "scene-snapshots") =>
        fetcher(`/api/manim/projects/${encodeURIComponent(identity.projectId)}/${endpoint}`, {
          body: JSON.stringify({ ...identity, requestId }),
          headers: { accept: "application/json", "content-type": "application/json" },
          method: "POST",
          signal,
        });
      let verified:
        | Awaited<ReturnType<typeof validateVerifiedRun>>
        | Awaited<ReturnType<typeof validateVerifiedRuntimeTraceRun>>;
      try {
        const response = await post("runtime-traces");
        signal?.throwIfAborted();
        if (!response.ok) throw providerError(`The Runtime Trace endpoint failed with HTTP ${response.status}.`);
        verified = await validateVerifiedRuntimeTraceRun(
          await readBoundedJson(response, MAX_RUNTIME_TRACE_RESPONSE_BYTES),
          identity,
          requestId,
        );
      } catch (cause) {
        if (!(cause instanceof StudioPreviewSnapshotLoadErrorV1) || cause.failureKind !== "unsupported") throw cause;
        const response = await post("scene-snapshots");
        signal?.throwIfAborted();
        if (!response.ok) throw providerError(`The Scene snapshot endpoint failed with HTTP ${response.status}.`);
        verified = await validateVerifiedRun(await readBoundedJson(response), identity, requestId);
      }
      const { bundle, engineRevisionHash, publicationRevision, sourceLabel, sourceRuntimeIdentity } = verified;
      signal?.throwIfAborted();
      const assetPayloads = await loadSnapshotAssetPayloads(fetcher, identity.projectId, bundle.assets.assets, signal);
      signal?.throwIfAborted();
      return {
        assetPayloads,
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
          serverPublicationRevision: publicationRevision,
        },
        duration: bundle.scene.duration,
        sceneId: bundle.scene.sceneId,
        snapshot: bundle,
        sourceLabel,
        sourceRuntimeIdentity,
      };
    },
  };
}
