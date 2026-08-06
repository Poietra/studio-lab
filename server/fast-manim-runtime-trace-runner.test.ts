import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import type { FastManimRuntimeTraceRunRequestV1 } from "../src/render-pipeline/runtime-trace-preview-contract";
import { MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 } from "./fast-manim-runtime-trace-contract";
import { FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1 } from "./fast-manim-runtime-trace-profile";
import {
  FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
  trustedFastManimRuntimeTraceProducerV2,
} from "./fast-manim-runtime-trace-v2-profile";
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
  return gunzipSync(await readFile(artifactPath));
}

async function officialOpeningArtifact() {
  const trusted = trustedFastManimRuntimeTraceProducerV2();
  const artifact = gunzipSync(await readFile(openingArtifactPath))
    .toString("utf8")
    .replace('"projectId":"opening-manim"', `"projectId":"${openingRequest.projectId}"`)
    .replace('"requestId":"request-opening-manim-v2"', `"requestId":"${openingRequest.requestId}"`)
    .replace(
      '"fastManimCommit":"0000000000000000000000000000000000000000"',
      `"fastManimCommit":"${trusted.producer.fastManimCommit}"`,
    )
    .replace(
      '"fastManimTree":"1111111111111111111111111111111111111111"',
      `"fastManimTree":"${trusted.producer.fastManimTree}"`,
    );
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
    const backend = new ArtifactBackend(await officialArtifact());
    const view = await runner(await projectRoot(), backend).runRuntimeTrace(request);

    expect(view.status).toBe("verified");
    if (view.status !== "verified") throw new Error("Expected a verified Runtime Trace result.");
    const bundle = await parseVerifiedSceneIrBundleV1(view.bundle);
    expect(bundle.scene).toMatchObject({
      duration: 6,
      source: {
        kind: "imported-manim-runtime-trace",
        runtimeConfigHash: "9b69b6296dc706b1deebbc1d9f88b05ef2f97aa9acf1e87eae9a8efd13b33c97",
        traceDigest: "cb048bb5c779f069f4340f1a21efa8b591011adc3e5d81b8f92b2c6a1b316929",
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

  it("dispatches the exact OpeningManim request to V2 and lowers its real artifact", async () => {
    const backend = new ArtifactBackend(await officialOpeningArtifact());
    const view = await runner(await projectRoot(), backend).runRuntimeTrace(openingRequest);

    if (view.status !== "verified") throw new Error(JSON.stringify(view));
    const bundle = await parseVerifiedSceneIrBundleV1(view.bundle);
    expect(bundle.scene).toMatchObject({
      duration: 3,
      source: {
        kind: "imported-manim-runtime-trace",
        runtimeConfigHash: "9fd2f025662f618dfae3f5e9c570e060b465b8c825b586161a0675274c4d27d1",
        traceVersion: 2,
      },
    });
    expect(bundle.scene.entities).toHaveLength(47);
    expect(bundle.scene.animationChannels).toHaveLength(73);
    expect(bundle.scene.animationChannels.reduce((total, channel) => total + channel.keyframes.length, 0)).toBe(13_140);
    expect(view.roots.map(({ binding }) => binding.name)).toEqual(["title", "basel"]);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      profileVersion: 2,
      sceneOccurrence: { constructStartLine: 19, definitionOrdinal: 1 },
      schema: "poietra.fast-manim-runtime-trace-producer-request",
      version: 2,
    });
    const responseBytes = Buffer.byteLength(JSON.stringify(view), "utf8");
    expect(responseBytes).toBe(2_043_112);
    expect(responseBytes).toBeLessThan(2 * 1024 * 1024 + 64 * 1024);
  });

  it("rejects non-profile source correlation before consulting the sandbox", async () => {
    const backend = new ArtifactBackend(await officialArtifact());
    const view = await runner(await projectRoot(), backend).runRuntimeTrace({ ...request, sourceHash: "f".repeat(64) });

    expect(view).toMatchObject({ failure: { code: "unsupported-profile" }, status: "failed" });
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
    const overLimit = await runner(
      root,
      new ArtifactBackend(new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2 + 1)),
    ).runRuntimeTrace(openingRequest);

    expect(atLimit).toMatchObject({ failure: { code: "result-rejected" }, status: "failed" });
    expect(overLimit).toMatchObject({ failure: { code: "producer-output-overflow" }, status: "failed" });
  });
});
