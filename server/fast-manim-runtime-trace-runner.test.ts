import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import type { FastManimRuntimeTraceRunRequestV1 } from "../src/render-pipeline/runtime-trace-preview-contract";
import { MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 } from "./fast-manim-runtime-trace-contract";
import { FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1 } from "./fast-manim-runtime-trace-profile";
import { FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2 } from "./fast-manim-runtime-trace-v2-profile";
import { MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2 } from "./fast-manim-runtime-trace-v2-result-contract";
import type {
  FastManimSandboxBackendV1,
  FastManimSandboxJobContextV1,
  FastManimSandboxRequestBundleV1,
  FastManimSandboxStatusContextV1,
} from "./fast-manim-sandbox-backend";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { ManimSourceStore } from "./manim-source-store";
import { RUNTIME_TRACE_SOURCE_TEXT } from "./test-fixtures/fast-manim-runtime-trace-fixture";
import { localSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const artifactPath = new URL("./test-fixtures/fast-manim-runtime-trace-updaters-v1.json.gz", import.meta.url);
const openingArtifactPath = new URL("./test-fixtures/fast-manim-runtime-trace-opening-v2.json.gz", import.meta.url);
const FAST_MANIM_COMMIT = "4ed7d01176438e612a8e9b6a080bf61ff906226e";
const FAST_MANIM_TREE = "e1d62d7d0d4ceb238ea9afb68cfdedf1510e9a03";
const PREVIOUS_FAST_MANIM_COMMIT = "365345c2cbb673ab0e9fe22d33353fcbcd43b58c";
const PREVIOUS_FAST_MANIM_TREE = "f6cae74330644d19bd0a5bf12a092c9840a83e90";
const request = {
  projectId: "demo",
  requestId: "req-runtime-trace-hook",
  sceneName: "UpdatersExample",
  sourceHash: FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1,
  sourcePath: "example_scenes/basic.py",
} as const satisfies FastManimRuntimeTraceRunRequestV1;
const openingRequest = {
  projectId: "demo",
  requestId: "req-opening-runtime-trace-hook",
  sceneName: "OpeningManim",
  sourceHash: FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
  sourcePath: "example_scenes/basic.py",
} as const satisfies FastManimRuntimeTraceRunRequestV1;

class ArtifactBackend implements FastManimSandboxBackendV1 {
  requests: unknown[] = [];
  statuses = 0;

  constructor(
    private readonly artifact: Uint8Array,
    private readonly onStart: (() => void | Promise<void>) | undefined = undefined,
  ) {}

  async close() {}

  start(bundle: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    this.requests.push(JSON.parse(Buffer.from(bundle.copyProducerRequestBytes()).toString("utf8")));
    return {
      abort() {},
      result: Promise.resolve(this.onStart?.()).then(() => ({
        attestationDigest: context.attestationDigest,
        kind: "ok" as const,
        requestDigest: bundle.requestDigest,
        resultBytes: Uint8Array.from(this.artifact),
      })),
    };
  }

  async status(context: FastManimSandboxStatusContextV1) {
    context.signal.throwIfAborted();
    this.statuses += 1;
    return localSandboxReadyStatus();
  }
}

const roots: string[] = [];
const runners: FastManimSnapshotRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function officialArtifact() {
  return Buffer.from(
    gunzipSync(await readFile(artifactPath))
      .toString("utf8")
      .replace(PREVIOUS_FAST_MANIM_COMMIT, FAST_MANIM_COMMIT)
      .replace(PREVIOUS_FAST_MANIM_TREE, FAST_MANIM_TREE),
    "utf8",
  );
}

async function officialOpeningArtifact() {
  const artifact = gunzipSync(await readFile(openingArtifactPath))
    .toString("utf8")
    .replace('"projectId":"opening-manim"', `"projectId":"${openingRequest.projectId}"`)
    .replace('"requestId":"request-opening-manim-v2"', `"requestId":"${openingRequest.requestId}"`)
    .replace(PREVIOUS_FAST_MANIM_COMMIT, FAST_MANIM_COMMIT)
    .replace(PREVIOUS_FAST_MANIM_TREE, FAST_MANIM_TREE);
  return Buffer.from(artifact, "utf8");
}

async function projectRoot() {
  const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-"));
  roots.push(root);
  await mkdir(join(root, "example_scenes"));
  await writeFile(join(root, request.sourcePath), RUNTIME_TRACE_SOURCE_TEXT, "utf8");
  return root;
}

function runner(root: string, backend: FastManimSandboxBackendV1) {
  const instance = new FastManimSnapshotRunner({
    backend,
    deployment: "test",
    frame: { height: 8, width: 14.222222222222221 },
    projectId: request.projectId,
    projectRoot: root,
    tenantId: "test-tenant",
  });
  runners.push(instance);
  return instance;
}

describe.skipIf(!ManimSourceStore.supportsVerifiedRead)("fast-manim Runtime Trace runner", () => {
  it("verifies and lowers the real producer artifact without publishing raw trace data", async () => {
    const artifact = await officialArtifact();
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(
      "0e5d9b6cb9c503bdf4e75afa453a6cfae76179519f7d9cf240bb022850be56a5",
    );
    expect(JSON.parse(artifact.toString("utf8"))).toMatchObject({
      producer: {
        fastManimCommit: FAST_MANIM_COMMIT,
        fastManimTree: FAST_MANIM_TREE,
      },
    });
    const backend = new ArtifactBackend(artifact);
    const view = await runner(await projectRoot(), backend).runRuntimeTrace(request);

    expect(view.status).toBe("verified");
    if (view.status !== "verified") throw new Error("Expected a verified Runtime Trace result.");
    const bundle = await parseVerifiedSceneIrBundleV1(view.bundle);
    expect(bundle.scene).toMatchObject({
      duration: 6,
      source: {
        kind: "imported-manim-runtime-trace",
        runtimeConfigHash: "9b69b6296dc706b1deebbc1d9f88b05ef2f97aa9acf1e87eae9a8efd13b33c97",
        traceDigest: "eaf1576603f3e5589a37816d88648253f9786259289665636034373d480cd688",
      },
    });
    expect(bundle.scene.entities).toHaveLength(570);
    expect(view.roots.map(({ binding }) => binding.name)).toEqual(["square", "decimal"]);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      profileVersion: 1,
      sceneOccurrence: { constructStartLine: 113, definitionOrdinal: 5 },
      schema: "poietra.fast-manim-runtime-trace-producer-request",
    });
    expect(backend.statuses).toBe(3);
    expect(JSON.stringify(view)).not.toContain(RUNTIME_TRACE_SOURCE_TEXT.slice(0, 32));
  });

  it("dispatches the exact OpeningManim request to V2 and lowers its real artifact", { timeout: 60_000 }, async () => {
    const backend = new ArtifactBackend(await officialOpeningArtifact());
    const view = await runner(await projectRoot(), backend).runRuntimeTrace(openingRequest);

    if (view.status !== "verified") throw new Error(JSON.stringify(view));
    const bundle = await parseVerifiedSceneIrBundleV1(view.bundle);
    expect(bundle.scene).toMatchObject({
      duration: 15,
      source: {
        kind: "imported-manim-runtime-trace",
        runtimeConfigHash: "0b5d2eae4a3709627a7ccae44ce5a977171452ed73e90ab6bfcfdffda604b977",
        traceVersion: 2,
      },
    });
    expect(bundle.scene.entities).toHaveLength(194);
    expect(bundle.scene.animationChannels).toHaveLength(269);
    expect(bundle.scene.animationChannels.reduce((total, channel) => total + channel.keyframes.length, 0)).toBe(12_551);
    expect(view.roots.map(({ binding }) => binding.name)).toEqual(["title", "basel", "grid", "grid_title"]);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      profileVersion: 2,
      sceneOccurrence: { constructStartLine: 19, definitionOrdinal: 1 },
      schema: "poietra.fast-manim-runtime-trace-producer-request",
      version: 2,
    });
    const responseBytes = Buffer.byteLength(JSON.stringify(view), "utf8");
    expect(responseBytes).toBe(5_490_431);
    expect(responseBytes).toBeLessThan(8 * 1024 * 1024 + 64 * 1024);
  });

  it("rejects stale source correlation before consulting the sandbox", async () => {
    const backend = new ArtifactBackend(await officialArtifact());
    const view = await runner(await projectRoot(), backend).runRuntimeTrace({ ...request, sourceHash: "f".repeat(64) });

    expect(view).toMatchObject({ failure: { code: "source-correlation-stale" }, status: "failed" });
    expect(backend.statuses).toBe(0);
    expect(backend.requests).toHaveLength(0);
  });

  it("rejects a source generation changed during producer execution", async () => {
    const root = await projectRoot();
    const backend = new ArtifactBackend(await officialArtifact(), () =>
      writeFile(join(root, request.sourcePath), `${RUNTIME_TRACE_SOURCE_TEXT}\n`, "utf8"),
    );
    const view = await runner(root, backend).runRuntimeTrace(request);

    expect(view).toMatchObject({ failure: { code: "source-changed" }, status: "failed" });
  });

  it("applies the Runtime Trace result byte ceiling before parsing", async () => {
    const root = await projectRoot();
    const atLimit = await runner(
      root,
      new ArtifactBackend(new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1)),
    ).runRuntimeTrace(request);
    const overLimit = await runner(
      root,
      new ArtifactBackend(new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 + 1)),
    ).runRuntimeTrace(request);

    expect(atLimit).toMatchObject({ failure: { code: "result-rejected" }, status: "failed" });
    expect(overLimit).toMatchObject({ failure: { code: "producer-output-overflow" }, status: "failed" });
  });

  it("uses the larger V2 producer byte ceiling only for the sealed OpeningManim profile", async () => {
    const root = await projectRoot();
    const atLimit = await runner(
      root,
      new ArtifactBackend(new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2)),
    ).runRuntimeTrace(openingRequest);
    const atBodyLimitWithCliLineFeed = new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2 + 1);
    atBodyLimitWithCliLineFeed[atBodyLimitWithCliLineFeed.length - 1] = 0x0a;
    const withCliLineFeed = await runner(root, new ArtifactBackend(atBodyLimitWithCliLineFeed)).runRuntimeTrace(
      openingRequest,
    );
    const overLimit = await runner(
      root,
      new ArtifactBackend(new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2 + 1)),
    ).runRuntimeTrace(openingRequest);

    expect(atLimit).toMatchObject({ failure: { code: "result-rejected" }, status: "failed" });
    expect(withCliLineFeed).toMatchObject({ failure: { code: "result-rejected" }, status: "failed" });
    expect(overLimit).toMatchObject({ failure: { code: "producer-output-overflow" }, status: "failed" });
  });
});
