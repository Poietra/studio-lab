import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseVerifiedSceneIrBundleV1 } from "../src/engine/contracts";
import type { FastManimRuntimeTraceRunRequestV1 } from "../src/render-pipeline/runtime-trace-preview-contract";
import { trustedFastManimRuntimeTraceProducerV3 } from "./fast-manim-runtime-trace-v3-profile";
import {
  digestFastManimRuntimeTraceSourceBindingsV3,
  MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V3,
} from "./fast-manim-runtime-trace-v3-result-contract";
import type {
  FastManimSandboxBackendV1,
  FastManimSandboxJobContextV1,
  FastManimSandboxRequestBundleV1,
  FastManimSandboxStatusContextV1,
} from "./fast-manim-sandbox-backend";
import { FastManimSnapshotRunner } from "./fast-manim-snapshot-runner";
import { ManimSourceStore } from "./manim-source-store";
import { localSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const genericArtifactPath = new URL("./test-fixtures/fast-manim-runtime-trace-v3-generic.json", import.meta.url);
const GENERIC_SOURCE = `from manim import *

class StaticSquare(Scene):
    def construct(self):
        square = Square().set_fill(BLUE, opacity=0.6)
        square.set_stroke(WHITE, width=2)
        self.add(square)
        self.wait(1 / 60)
`;
const genericRequest = {
  projectId: "demo",
  requestId: "req-generic-runtime-trace-hook",
  sceneName: "StaticSquare",
  sourceHash: createHash("sha256").update(GENERIC_SOURCE).digest("hex"),
  sourcePath: "scenes/staticsquare.py",
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

async function genericArtifact(updaterStatus?: "conflict" | "none") {
  const artifact = JSON.parse(await readFile(genericArtifactPath, "utf8"));
  const trusted = trustedFastManimRuntimeTraceProducerV3();
  Object.assign(artifact, { projectId: genericRequest.projectId, requestId: genericRequest.requestId });
  Object.assign(artifact.producer, trusted);
  if (updaterStatus !== undefined) {
    artifact.sourceBindings[0].updaterStatus = updaterStatus;
    artifact.producer.correlationSha256 = digestFastManimRuntimeTraceSourceBindingsV3(
      artifact.sourceHash,
      artifact.sceneId,
      artifact.sourceBindings,
    );
  }
  return Buffer.from(JSON.stringify(artifact), "utf8");
}

async function genericProjectRoot() {
  const root = await mkdtemp(join(tmpdir(), "poietra-runtime-trace-"));
  roots.push(root);
  await mkdir(join(root, "scenes"));
  await writeFile(join(root, genericRequest.sourcePath), GENERIC_SOURCE, "utf8");
  return root;
}

function runner(
  root: string,
  backend: FastManimSandboxBackendV1,
  configuredFrame: Readonly<{ height: number; width: number }> = { height: 8, width: 14.222222222222221 },
) {
  const instance = new FastManimSnapshotRunner({
    backend,
    deployment: "test",
    frame: configuredFrame,
    projectId: genericRequest.projectId,
    projectRoot: root,
    tenantId: "test-tenant",
  });
  runners.push(instance);
  return instance;
}

describe.skipIf(!ManimSourceStore.supportsVerifiedRead)("fast-manim Runtime Trace runner", () => {
  it("dispatches a non-profile Scene through generic preview-only V3", async () => {
    const backend = new ArtifactBackend(await genericArtifact());
    const view = await runner(await genericProjectRoot(), backend).runRuntimeTrace(genericRequest);

    if (view.status !== "verified") throw new Error(JSON.stringify(view));
    const bundle = await parseVerifiedSceneIrBundleV1(view.bundle);
    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-runtime-trace",
      sourceHash: genericRequest.sourceHash,
      traceVersion: 3,
    });
    expect(view).toMatchObject({
      producerEvidence: {
        correlationSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        semanticsSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
      roots: [
        {
          binding: { name: "square", ordinal: 1 },
          entityId: expect.stringMatching(/\/runtime-v3-root:0$/u),
          evidence: {
            endpoints: {
              initial: {
                center: { x: 0, y: 0 },
                dimensions: { height: 2, width: 2 },
                frameIndex: 0,
                sampleTime: 0,
              },
              terminal: {
                center: { x: 0, y: 0 },
                dimensions: { height: 2, width: 2 },
                frameIndex: 0,
                sampleTime: 0,
              },
            },
            updaterStatus: "none",
          },
        },
      ],
      version: 2,
    });
    expect(bundle.scene.entities.some(({ id }) => id === view.roots[0]?.entityId)).toBe(true);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]).toMatchObject({
      profileVersion: 3,
      sceneOccurrence: { constructStartLine: 4, definitionOrdinal: 1 },
      sceneName: genericRequest.sceneName,
      schema: "poietra.fast-manim-runtime-trace-producer-request",
      sourceBindings: [
        {
          id: expect.stringMatching(/^source-binding:[0-9a-f]{64}$/u),
          name: "square",
          ordinal: 1,
          span: { endColumn: 14, endLine: 5, startColumn: 8, startLine: 5 },
        },
      ],
      version: 3,
    });
  });

  it("preserves verified generic V3 updater conflicts as non-edit authority evidence", async () => {
    const backend = new ArtifactBackend(await genericArtifact("conflict"));
    const view = await runner(await genericProjectRoot(), backend).runRuntimeTrace(genericRequest);

    if (view.status !== "verified" || view.version !== 2) throw new Error(JSON.stringify(view));
    expect(view.roots).toHaveLength(1);
    expect(view.roots[0]?.evidence.updaterStatus).toBe("conflict");
  });

  it("returns a failed view when the generic V3 camera is not canonical", async () => {
    const backend = new ArtifactBackend(await genericArtifact());
    const view = await runner(await genericProjectRoot(), backend, { height: 8, width: 10 }).runRuntimeTrace(
      genericRequest,
    );

    expect(view).toMatchObject({ failure: { code: "runtime-config-changed" }, status: "failed" });
    expect(backend.requests).toHaveLength(0);
    expect(backend.statuses).toBe(0);
  });

  it("rejects stale source correlation before consulting the sandbox", async () => {
    const backend = new ArtifactBackend(await genericArtifact());
    const view = await runner(await genericProjectRoot(), backend).runRuntimeTrace({
      ...genericRequest,
      sourceHash: "f".repeat(64),
    });

    expect(view).toMatchObject({ failure: { code: "source-correlation-stale" }, status: "failed" });
    expect(backend.statuses).toBe(0);
    expect(backend.requests).toHaveLength(0);
  });

  it("rejects a source generation changed during producer execution", async () => {
    const root = await genericProjectRoot();
    const backend = new ArtifactBackend(await genericArtifact(), () =>
      writeFile(join(root, genericRequest.sourcePath), `${GENERIC_SOURCE}\n`, "utf8"),
    );
    const view = await runner(root, backend).runRuntimeTrace(genericRequest);

    expect(view).toMatchObject({ failure: { code: "source-changed" }, status: "failed" });
  });

  it("applies the Runtime Trace result byte ceiling before parsing", async () => {
    const root = await genericProjectRoot();
    const atLimit = await runner(
      root,
      new ArtifactBackend(new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V3)),
    ).runRuntimeTrace(genericRequest);
    const overLimit = await runner(
      root,
      new ArtifactBackend(new Uint8Array(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V3 + 1)),
    ).runRuntimeTrace(genericRequest);

    expect(atLimit).toMatchObject({ failure: { code: "result-rejected" }, status: "failed" });
    expect(overLimit).toMatchObject({ failure: { code: "producer-output-overflow" }, status: "failed" });
  });
});
