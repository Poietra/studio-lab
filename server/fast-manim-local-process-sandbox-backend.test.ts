import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";
import {
  LocalProcessFastManimSandboxBackendV1,
  materializeFastManimSandboxPngV2,
} from "./fast-manim-local-process-sandbox-backend";
import { MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 } from "./fast-manim-runtime-trace-contract";
import {
  createFastManimRuntimeTraceProducerRequestV2,
  FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2,
  FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
  FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2,
} from "./fast-manim-runtime-trace-v2-profile";
import { MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2 } from "./fast-manim-runtime-trace-v2-result-contract";
import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import { FastManimSnapshotAdmissionController } from "./fast-manim-snapshot-publication";
import {
  RUNTIME_TRACE_SOURCE_TEXT,
  runtimeTraceRequestFixture,
} from "./test-fixtures/fast-manim-runtime-trace-fixture";
import { sandboxPngBytes, sandboxPngProducerRequest } from "./test-fixtures/fast-manim-sandbox-png-fixture";

const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "poietra-png-sandbox-test-"));
  roots.push(root);
  return root;
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await delay(10);
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function context(requestId: string) {
  return {
    attestationDigest: "a".repeat(64),
    deadlineEpochMs: Date.now() + 10_000,
    identity: { projectId: "default", requestId, tenantId: "test-tenant" },
    signal: new AbortController().signal,
  };
}

describe("local-process fast-manim PNG materialization", () => {
  it("passes strict producer JSON on stdin and exposes only fixed image.png in the private cwd", async () => {
    const projectRoot = await temporaryRoot();
    const producer = sandboxPngProducerRequest();
    const pngBytes = sandboxPngBytes();
    const request = new FastManimSandboxRequestBundleV1(producer, { pngBytes });
    const child = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const png = fs.readFileSync("image.png");
  const stat = fs.lstatSync("image.png");
  process.stdout.write(JSON.stringify({
    digest: crypto.createHash("sha256").update(png).digest("hex"),
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    mode: stat.mode & 0o777,
    request: JSON.parse(input),
  }));
});
`;
    const backend = new LocalProcessFastManimSandboxBackendV1({
      command: [process.execPath, "-e", child],
      projectRoot,
    });
    try {
      const result = await backend.start(request, context(producer.requestId)).result;
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error("The local producer did not complete.");
      expect(JSON.parse(Buffer.from(result.resultBytes).toString("utf8"))).toEqual({
        digest: createHash("sha256").update(pngBytes).digest("hex"),
        isFile: true,
        isSymbolicLink: false,
        mode: 0o600,
        request: producer,
      });
    } finally {
      await backend.close();
    }
  });

  it("refuses to replace an existing image.png symlink", async () => {
    const runtimeRoot = await temporaryRoot();
    const outside = join(runtimeRoot, "outside.png");
    await writeFile(outside, "unchanged", "utf8");
    await symlink(outside, join(runtimeRoot, "image.png"));
    const request = new FastManimSandboxRequestBundleV1(sandboxPngProducerRequest(), {
      pngBytes: sandboxPngBytes(),
    });
    await expect(materializeFastManimSandboxPngV2(runtimeRoot, request)).rejects.toThrow();
    await expect(readFile(outside, "utf8")).resolves.toBe("unchanged");
  });
});

describe("local-process producer admission release", () => {
  async function runOnce(
    controller: FastManimSnapshotAdmissionController,
    child: string,
    signal?: AbortSignal,
    deadlineEpochMs = Date.now() + 10_000,
  ) {
    const projectRoot = await temporaryRoot();
    const producer = runtimeTraceRequestFixture();
    const request = new FastManimSandboxRequestBundleV1(producer);
    const backend = new LocalProcessFastManimSandboxBackendV1({
      admissionController: controller,
      command: [process.execPath, "-e", child],
      projectRoot,
    });
    try {
      return await backend.start(request, {
        ...context(producer.requestId),
        deadlineEpochMs,
        ...(signal ? { signal } : {}),
      }).result;
    } finally {
      await backend.close();
    }
  }

  it("returns the shared slot on success, producer failure, abort, and an expired deadline", async () => {
    const controller = new FastManimSnapshotAdmissionController({ maxConcurrent: 1 });
    expect(controller.activeCount).toBe(0);

    const ok = await runOnce(controller, 'process.stdout.write("{}")');
    expect(ok.kind).toBe("ok");
    expect(controller.activeCount).toBe(0);

    const failed = await runOnce(controller, "process.exit(3)");
    expect(failed).toMatchObject({ code: "producer-exit", kind: "failed" });
    expect(controller.activeCount).toBe(0);

    const abortRoot = await temporaryRoot();
    const readyPath = join(abortRoot, "producer-ready");
    const abortProducer = runtimeTraceRequestFixture();
    const abortRequest = new FastManimSandboxRequestBundleV1(abortProducer);
    const abortBackend = new LocalProcessFastManimSandboxBackendV1({
      admissionController: controller,
      command: [
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync(process.argv.at(-1), "ready"); setInterval(() => {}, 60_000)',
        readyPath,
      ],
      projectRoot: abortRoot,
    });
    const aborter = new AbortController();
    try {
      const aborting = abortBackend.start(abortRequest, {
        ...context(abortProducer.requestId),
        signal: aborter.signal,
      }).result;
      expect(controller.activeCount).toBe(1);
      await waitForFile(readyPath);
      aborter.abort();
      await expect(aborting).rejects.toMatchObject({ name: "AbortError" });
      expect(controller.activeCount).toBe(0);
    } finally {
      await abortBackend.close();
    }

    // The deadline check returns before the slot is taken at all.
    const expired = await runOnce(controller, 'process.stdout.write("{}")', undefined, Date.now() - 1);
    expect(expired).toMatchObject({ code: "producer-timeout", kind: "failed" });
    expect(controller.activeCount).toBe(0);

    // The cap is intact: a fresh run is still admitted after every path above.
    const finalRelease = controller.tryAcquire();
    expect(finalRelease).not.toBeNull();
    expect(controller.activeCount).toBe(1);
    finalRelease?.();
    expect(controller.activeCount).toBe(0);
  });

  it("refuses admission at the shared cap without leaking the held slot", async () => {
    const controller = new FastManimSnapshotAdmissionController({ maxConcurrent: 1 });
    const release = controller.tryAcquire();
    expect(release).not.toBeNull();

    await expect(runOnce(controller, 'process.stdout.write("{}")')).rejects.toMatchObject({ code: "capacity" });
    expect(controller.activeCount).toBe(1);

    release?.();
    expect(controller.activeCount).toBe(0);
    release?.();
    expect(controller.activeCount).toBe(0);

    await expect(runOnce(controller, 'process.stdout.write("{}")')).resolves.toMatchObject({ kind: "ok" });
    expect(controller.activeCount).toBe(0);
  });

  it("returns the shared slot before reporting cleanup failure", async () => {
    const controller = new FastManimSnapshotAdmissionController({ maxConcurrent: 1 });
    const projectRoot = await temporaryRoot();
    const producer = runtimeTraceRequestFixture();
    const backend = new LocalProcessFastManimSandboxBackendV1({
      admissionController: controller,
      command: [process.execPath, "-e", 'process.stdout.write("{}")'],
      projectRoot,
      runtimeDirectoryRemover: async (runtimeDir) => {
        roots.push(runtimeDir);
        throw new Error("synthetic cleanup failure");
      },
    });
    try {
      await expect(
        backend.start(new FastManimSandboxRequestBundleV1(producer), context(producer.requestId)).result,
      ).rejects.toMatchObject({ code: "cleanup" });
      expect(controller.activeCount).toBe(0);
    } finally {
      await backend.close().catch(() => undefined);
    }
  });
});

describe("local-process Runtime Trace output bounds", () => {
  function runtimeTraceRequestV2() {
    return createFastManimRuntimeTraceProducerRequestV2(
      {
        projectId: "demo",
        requestId: "req-opening-runtime-trace-v2",
        sceneName: FAST_MANIM_RUNTIME_TRACE_SCENE_NAME_V2,
        sourceHash: FAST_MANIM_RUNTIME_TRACE_SOURCE_HASH_V2,
        sourcePath: FAST_MANIM_RUNTIME_TRACE_SOURCE_PATH_V2,
      },
      RUNTIME_TRACE_SOURCE_TEXT,
      { height: 8, width: 128 / 9 },
    );
  }

  async function produce(
    byteLength: number,
    producer:
      | ReturnType<typeof runtimeTraceRequestFixture>
      | ReturnType<typeof runtimeTraceRequestV2> = runtimeTraceRequestFixture(),
  ) {
    const projectRoot = await temporaryRoot();
    const request = new FastManimSandboxRequestBundleV1(producer);
    const child = String.raw`
const byteLength = Number(process.argv.at(-1));
process.stdout.write(Buffer.alloc(byteLength, 0x78));
`;
    const backend = new LocalProcessFastManimSandboxBackendV1({
      command: [process.execPath, "-e", child, String(byteLength)],
      projectRoot,
    });
    try {
      return await backend.start(request, context(producer.requestId)).result;
    } finally {
      await backend.close();
    }
  }

  it("admits exactly one CLI line feed above the V1 JSON body", async () => {
    const byteLength = MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 + 1;
    const result = await produce(byteLength);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("The local producer did not complete.");
    expect(result.resultBytes).toHaveLength(byteLength);
  });

  it("fails closed above the V1 body plus its CLI line feed", async () => {
    const result = await produce(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 + 2);

    expect(result).toMatchObject({ code: "producer-output-overflow", kind: "failed" });
  });

  it("admits the same V2-sized stdout only when the sealed request selected V2", async () => {
    const byteLength = MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V1 + 2;
    const producer = runtimeTraceRequestV2();
    const request = new FastManimSandboxRequestBundleV1(producer);
    expect(request.maximumResultBytes).toBe(MAX_FAST_MANIM_RUNTIME_TRACE_JSON_BYTES_V2 + 1);
    const result = await produce(byteLength, producer);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("The local producer did not complete.");
    expect(result.resultBytes).toHaveLength(byteLength);
  });
});
