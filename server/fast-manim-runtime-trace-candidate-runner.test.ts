import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import {
  canonicalFastManimRuntimeTraceCoordinateV1,
  digestFastManimRuntimeTraceVisualSemanticsV1,
  type FastManimRuntimeTraceProducerRequestV1,
  type FastManimRuntimeTraceV1,
} from "./fast-manim-runtime-trace-contract";
import {
  FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1,
  trustedFastManimRuntimeTraceProducerV1,
} from "./fast-manim-runtime-trace-profile";
import type {
  FastManimSandboxBackendV1,
  FastManimSandboxJobContextV1,
  FastManimSandboxRequestBundleV1,
  FastManimSandboxStatusContextV1,
} from "./fast-manim-sandbox-backend";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { fastManimSourceBindingIdentifierV1 } from "./fast-manim-source-runtime-identity";
import { ManimSourceStore } from "./manim-source-store";
import { RUNTIME_TRACE_SOURCE_TEXT } from "./test-fixtures/fast-manim-runtime-trace-fixture";
import { localSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const artifactPath = new URL("./test-fixtures/fast-manim-runtime-trace-updaters-v1.json.gz", import.meta.url);
const sourcePath = "example_scenes/basic.py";
const sceneName = "UpdatersExample";
const candidateSource = RUNTIME_TRACE_SOURCE_TEXT.replace(
  "            run_time=5,\n        )\n        self.wait()\n",
  "            run_time=5,\n        )\n        square.move_to((1.25, 2.5, 0))\n        decimal.update(0)\n        self.wait()\n",
);

function exactJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "-0.0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(exactJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}:${exactJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Expected JSON-only Runtime Trace fixture data.");
}

class CandidateArtifactBackend implements FastManimSandboxBackendV1 {
  requests: FastManimRuntimeTraceProducerRequestV1[] = [];
  statusCalls = 0;

  constructor(private readonly corruptPrefix = false) {}

  async close() {}

  start(bundle: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    const request = JSON.parse(
      Buffer.from(bundle.copyProducerRequestBytes()).toString("utf8"),
    ) as FastManimRuntimeTraceProducerRequestV1;
    this.requests.push(request);
    return {
      abort() {},
      result: this.result(bundle, context, request),
    };
  }

  private async result(
    bundle: FastManimSandboxRequestBundleV1,
    context: FastManimSandboxJobContextV1,
    request: FastManimRuntimeTraceProducerRequestV1,
  ) {
    const trace = JSON.parse(gunzipSync(await readFile(artifactPath)).toString("utf8")) as FastManimRuntimeTraceV1;
    Object.assign(trace, {
      projectId: request.projectId,
      requestId: request.requestId,
      runtimeConfigHash: request.runtimeConfigHash,
      sceneId: request.sceneId,
      sceneName: request.sceneName,
      sceneOccurrence: request.sceneOccurrence,
      sourceHash: request.sourceHash,
      sourcePath: request.sourcePath,
    });
    Object.assign(trace.producer, trustedFastManimRuntimeTraceProducerV1().producer, {
      semanticsSha256: trace.producer.semanticsSha256,
    });
    trace.roots.forEach((root) => {
      root.binding.id = fastManimSourceBindingIdentifierV1(trace.sourceHash, trace.sceneId, root.binding);
    });
    if (request.sourceHash !== FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1) {
      for (let frameIndex = 300; frameIndex < trace.frames.length; frameIndex += 1) {
        const frame = trace.frames[frameIndex];
        frame.motionY = 2.5;
        frame.draws[0].localPosition.x = 1.25;
        for (const draw of frame.draws.slice(1)) {
          draw.localPosition.x = canonicalFastManimRuntimeTraceCoordinateV1(draw.localPosition.x + 1.25);
        }
      }
      if (this.corruptPrefix) {
        trace.frames[299].motionY = canonicalFastManimRuntimeTraceCoordinateV1(trace.frames[299].motionY + 0.125);
      }
    }
    trace.producer.semanticsSha256 = digestFastManimRuntimeTraceVisualSemanticsV1(trace);
    return {
      attestationDigest: context.attestationDigest,
      kind: "ok" as const,
      requestDigest: bundle.requestDigest,
      resultBytes: Buffer.from(exactJson(trace), "utf8"),
    };
  }

  async status(context: FastManimSandboxStatusContextV1) {
    this.statusCalls += 1;
    context.signal.throwIfAborted();
    return localSandboxReadyStatus();
  }
}

const roots: string[] = [];
const runners: FastManimSnapshotRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function projectRoot(source = RUNTIME_TRACE_SOURCE_TEXT) {
  const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-candidate-"));
  roots.push(root);
  await mkdir(join(root, "example_scenes"));
  await writeFile(join(root, sourcePath), source, "utf8");
  return root;
}

async function runner(backend: FastManimSandboxBackendV1, source = RUNTIME_TRACE_SOURCE_TEXT) {
  const instance = new FastManimSnapshotRunner({
    backend,
    deployment: "test",
    frame: { height: 8, width: 128 / 9 },
    projectId: "demo",
    projectRoot: await projectRoot(source),
    tenantId: "test-tenant",
  });
  runners.push(instance);
  return instance;
}

describe.skipIf(!ManimSourceStore.supportsVerifiedRead)("Runtime Trace terminal candidate runner", () => {
  it("re-traces edited project bytes through the normal preview entrypoint", async () => {
    const backend = new CandidateArtifactBackend();
    const sourceHash = createHash("sha256").update(candidateSource, "utf8").digest("hex");
    const result = await (await runner(backend, candidateSource)).runRuntimeTrace({
      projectId: "demo",
      requestId: "req-runtime-trace-edited-preview",
      sceneName,
      sourceHash,
      sourcePath,
    });

    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("Expected a verified edited Runtime Trace preview.");
    const bundle = await parseVerifiedSceneIrBundleV1(result.bundle);
    expect(result.sourceHash).toBe(sourceHash);
    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-runtime-trace",
      sourceHash,
      traceDigest: result.traceDigest,
      traceVersion: 1,
    });
    expect(result.roots.map(({ binding }) => binding.id)).toEqual(
      result.roots.map(({ binding }) => fastManimSourceBindingIdentifierV1(sourceHash, result.sceneId, binding)),
    );
    expect(backend.requests.map(({ sourceHash: producedHash }) => producedHash)).toEqual([
      FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1,
      sourceHash,
    ]);
    expect(backend.statusCalls).toBeGreaterThan(0);
  });

  it("falls through an unreviewed candidate edit to generic V3 preview", async () => {
    const invalidSource = RUNTIME_TRACE_SOURCE_TEXT.replace(
      "        self.wait()\n",
      "        square.rotate(0.25)\n        self.wait()\n",
    );
    const sourceHash = createHash("sha256").update(invalidSource, "utf8").digest("hex");
    const backend = new CandidateArtifactBackend();
    const result = await (await runner(backend, invalidSource)).runRuntimeTrace({
      projectId: "demo",
      requestId: "req-runtime-trace-unreviewed-source",
      sceneName,
      sourceHash,
      sourcePath,
    });

    expect(result).toMatchObject({
      failure: { code: "result-rejected" },
      sourceHash,
      status: "failed",
    });
    expect(backend.statusCalls).toBeGreaterThan(0);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({ profileVersion: 3, version: 3 });
  });

  it("executes official and candidate bytes without publishing either trace", async () => {
    const backend = new CandidateArtifactBackend();
    const result = await (await runner(backend)).runRuntimeTraceCandidateUnpublished(candidateSource, {
      projectId: "demo",
      requestId: "req-runtime-trace-candidate",
      sceneName,
      sourcePath,
    });

    expect(result).toMatchObject({
      sourceHash: expect.not.stringMatching(FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1),
      status: "verified",
      traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(backend.requests.map(({ sourceHash }) => sourceHash)).toEqual([
      FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V1,
      result.sourceHash,
    ]);
  });

  it("fails closed when producer execution changes a protected frame", async () => {
    await expect(
      (await runner(new CandidateArtifactBackend(true))).runRuntimeTraceCandidateUnpublished(candidateSource, {
        projectId: "demo",
        requestId: "req-runtime-trace-candidate-rejected",
        sceneName,
        sourcePath,
      }),
    ).rejects.toMatchObject({ code: "candidate-prefix" });
  });
});
