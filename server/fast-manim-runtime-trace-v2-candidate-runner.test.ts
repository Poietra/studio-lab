import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import type { FastManimRuntimeTraceProducerRequestV2 } from "./fast-manim-runtime-trace-v2-contract";
import { lowerVerifiedFastManimRuntimeTraceOpeningPositionCandidateV2 } from "./fast-manim-runtime-trace-v2-lowering";
import {
  FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
  trustedFastManimRuntimeTraceProducerV2,
} from "./fast-manim-runtime-trace-v2-profile";
import {
  canonicalFastManimRuntimeTraceCoordinateV2,
  digestFastManimRuntimeTraceVisualSemanticsV2,
  type FastManimRuntimeTraceV2,
} from "./fast-manim-runtime-trace-v2-result-contract";
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
import { RUNTIME_TRACE_V2_GRID_TITLE_ROOT } from "./test-fixtures/fast-manim-runtime-trace-v2-fixture";
import { localSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const artifactPath = new URL("./test-fixtures/fast-manim-runtime-trace-opening-v2.json.gz", import.meta.url);
const sourcePath = "example_scenes/basic.py";
const sceneName = "OpeningManim";
const candidateSource = RUNTIME_TRACE_SOURCE_TEXT.replace(
  "        self.play(Transform(grid_title, grid_transform_title))\n        self.wait()\n",
  "        self.play(Transform(grid_title, grid_transform_title))\n" +
    "        grid_title.shift((1.25, -0.5, 0))\n" +
    "        self.wait()\n",
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

class OpeningCandidateBackend implements FastManimSandboxBackendV1 {
  readonly requests: FastManimRuntimeTraceProducerRequestV2[] = [];
  candidateTrace: FastManimRuntimeTraceV2 | undefined;

  async close() {}

  start(bundle: FastManimSandboxRequestBundleV1, context: FastManimSandboxJobContextV1) {
    const request = JSON.parse(
      Buffer.from(bundle.copyProducerRequestBytes()).toString("utf8"),
    ) as FastManimRuntimeTraceProducerRequestV2;
    this.requests.push(request);
    return {
      abort() {},
      result: this.result(bundle, context, request),
    };
  }

  private async result(
    bundle: FastManimSandboxRequestBundleV1,
    context: FastManimSandboxJobContextV1,
    request: FastManimRuntimeTraceProducerRequestV2,
  ) {
    const trace = JSON.parse(gunzipSync(await readFile(artifactPath)).toString("utf8")) as FastManimRuntimeTraceV2;
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
    Object.assign(trace.producer, trustedFastManimRuntimeTraceProducerV2().producer);
    trace.roots.forEach((root) => {
      root.binding.id = fastManimSourceBindingIdentifierV1(trace.sourceHash, trace.sceneId, root.binding);
    });
    if (request.sourceHash !== FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2) {
      for (const frame of trace.frames.slice(840)) {
        for (const draw of frame.draws) {
          if (draw.rootId !== RUNTIME_TRACE_V2_GRID_TITLE_ROOT) continue;
          draw.translation.x = canonicalFastManimRuntimeTraceCoordinateV2(draw.translation.x + 1.25);
          draw.translation.y = canonicalFastManimRuntimeTraceCoordinateV2(draw.translation.y - 0.5);
        }
      }
    }
    trace.producer.semanticsSha256 = digestFastManimRuntimeTraceVisualSemanticsV2(trace);
    if (request.sourceHash !== FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2) this.candidateTrace = trace;
    return {
      attestationDigest: context.attestationDigest,
      kind: "ok" as const,
      requestDigest: bundle.requestDigest,
      resultBytes: Buffer.from(exactJson(trace), "utf8"),
    };
  }

  async status(context: FastManimSandboxStatusContextV1) {
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

async function runner(backend: FastManimSandboxBackendV1) {
  const root = await mkdtemp(join(tmpdir(), "poietra-opening-candidate-"));
  roots.push(root);
  await mkdir(join(root, "example_scenes"));
  await writeFile(join(root, sourcePath), RUNTIME_TRACE_SOURCE_TEXT, "utf8");
  const instance = new FastManimSnapshotRunner({
    backend,
    deployment: "test",
    frame: { height: 8, width: 128 / 9 },
    projectId: "demo",
    projectRoot: root,
    tenantId: "test-tenant",
  });
  runners.push(instance);
  return instance;
}

describe.skipIf(!ManimSourceStore.supportsVerifiedRead)("Runtime Trace V2 OpeningManim candidate runner", () => {
  it("executes fresh official and candidate traces without publishing either one", async () => {
    const backend = new OpeningCandidateBackend();
    const instance = await runner(backend);
    const result = await instance.runRuntimeTraceCandidateUnpublished(candidateSource, {
      projectId: "demo",
      requestId: "req-opening-runtime-trace-candidate",
      sceneName,
      sourcePath,
    });

    expect(result).toMatchObject({
      sourceHash: expect.not.stringMatching(FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2),
      status: "verified",
      traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(backend.requests.map(({ sourceHash }) => sourceHash)).toEqual([
      FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
      result.sourceHash,
    ]);
    if (!backend.candidateTrace) throw new Error("Expected a produced OpeningManim candidate trace.");
    await expect(
      lowerVerifiedFastManimRuntimeTraceOpeningPositionCandidateV2(backend.candidateTrace, { x: 1, y: -0.5 }),
    ).rejects.toMatchObject({ code: "semantic-mismatch" });
    await expect(
      lowerVerifiedFastManimRuntimeTraceOpeningPositionCandidateV2(backend.candidateTrace, { x: 1.25, y: -0.5 }),
    ).resolves.toBeDefined();

    const root = roots.at(-1);
    if (!root) throw new Error("Expected an OpeningManim candidate project root.");
    await writeFile(join(root, sourcePath), candidateSource, "utf8");
    const preview = await instance.runRuntimeTrace({
      projectId: "demo",
      requestId: "req-opening-runtime-trace-candidate-preview",
      sceneName,
      sourceHash: result.sourceHash,
      sourcePath,
    });
    if (preview.status !== "verified") {
      throw new Error(
        `Edited OpeningManim preview failed ${preview.failure.code}; producer hashes ${backend.requests
          .map(({ sourceHash }) => sourceHash)
          .join(",")}.`,
      );
    }
    expect(preview).toMatchObject({
      sourceHash: result.sourceHash,
      status: "verified",
      traceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(backend.requests.map(({ sourceHash }) => sourceHash)).toEqual([
      FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
      result.sourceHash,
      FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
      result.sourceHash,
    ]);
  }, 120_000);
});
