import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createConfiguredFastManimLocalGatedOciBackendV1,
  FastManimLocalGatedOciError,
  parseFastManimLocalGatedOciResultV1,
  runFastManimLocalGatedOciV1,
} from "./fast-manim-local-gated-oci-backend";
import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import {
  fastManimSnapshotResultV1Schema,
  fastManimSnapshotSceneIdV1,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH,
} from "./fast-manim-snapshot-contract";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const realImage = process.env.POIETRA_FAST_MANIM_GATED_OCI_IMAGE;
const realLane = /^sha256:[a-f0-9]{64}$/.test(realImage ?? "");
const MAGIC = Buffer.from("POIETR1\0", "ascii");

function context(signal = new AbortController().signal, deadlineMs = 30_000) {
  return {
    deadlineEpochMs: Date.now() + deadlineMs,
    identity: { projectId: "default", requestId: "gated-oci-test", tenantId: "test-tenant" },
    signal,
  };
}

function requestFor(sourceText: string, sceneName: string) {
  const request = sandboxProducerRequest();
  return new FastManimSandboxRequestBundleV1({
    ...request,
    requestId: `gated-${sceneName}`,
    sceneId: fastManimSnapshotSceneIdV1("scene.py", sceneName),
    sceneName,
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    sourceText,
  });
}

function wire(body: Uint8Array, overrides: Readonly<{ digest?: Buffer; length?: number; magic?: Buffer }> = {}) {
  const header = Buffer.alloc(48);
  (overrides.magic ?? MAGIC).copy(header, 0);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(overrides.length ?? body.byteLength, 12);
  (overrides.digest ?? createHash("sha256").update(body).digest()).copy(header, 16);
  return Buffer.concat([header, body]);
}

const staticScene = `from manim import Circle, Line, Rectangle, Scene

class GatedStaticScene(Scene):
    def construct(self):
        circle = Circle().set_fill("#ef4444", opacity=1.0).set_stroke(width=0)
        rectangle = Rectangle().set_fill("#22c55e", opacity=1.0).set_stroke(width=0)
        line = Line([-2.0, -1.0, 0.0], [2.0, 1.0, 0.0]).set_stroke("#3b82f6", width=4)
        self.add(circle, rectangle, line)
`;

describe("local gated OCI factory", () => {
  it("is unconditionally unavailable in production, even when the Docker opt-in and image are supplied", async () => {
    const backend = createConfiguredFastManimLocalGatedOciBackendV1({
      deployment: "production",
      image: `sha256:${"a".repeat(64)}`,
      localDockerDevOptIn: true,
    });
    await expect(backend.status(context())).resolves.toMatchObject({
      backendKind: "disabled",
      capabilities: [],
      health: "unavailable",
      reason: "not-configured",
    });
  });

  it("requires the explicit development opt-in and an immutable image ID", async () => {
    const disabled = createConfiguredFastManimLocalGatedOciBackendV1({
      deployment: "development",
      image: `sha256:${"a".repeat(64)}`,
      localDockerDevOptIn: false,
    });
    await expect(disabled.status(context())).resolves.toMatchObject({ health: "unavailable" });
    expect(() =>
      createConfiguredFastManimLocalGatedOciBackendV1({
        deployment: "development",
        image: "poietra-fast-manim-gated:latest",
        localDockerDevOptIn: true,
      }),
    ).toThrow(/immutable sha256/i);
  });
});

describe("gated OCI result boundary", () => {
  it("accepts the locked Python producer's compact, sorted JSON spelling", () => {
    const result = Buffer.from('{"a":-0.0,"b":[1.0,1e-07,"λ\\n"],"c":{"α":true}}\n', "utf8");
    expect(Buffer.from(parseFastManimLocalGatedOciResultV1(result))).toEqual(result.subarray(0, -1));
  });

  it("rejects invalid UTF-8 and output beyond the exact result-plus-LF budget", () => {
    const invalidUtf8 = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
    expect(() => parseFastManimLocalGatedOciResultV1(invalidUtf8)).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
    expect(() =>
      parseFastManimLocalGatedOciResultV1(Buffer.alloc(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES + 2, 0x78)),
    ).toThrowError(expect.objectContaining({ code: "producer-output-overflow" }));
  });

  it.each([
    '{"b":1,"a":2}\n',
    '{"a":1,"a":2}\n',
    '{"a":1.00}\n',
    '{"a":1E+20}\n',
    '{"a":"\\u03bb"}\n',
    '{ "a":1}\n',
    '{"a":1}\n\n',
  ])("rejects non-canonical result bytes: %s", (result) => {
    expect(() => parseFastManimLocalGatedOciResultV1(Buffer.from(result, "utf8"))).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
  });

  it("rejects JSON nesting beyond the shared snapshot depth budget", () => {
    const nesting = MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH + 1;
    const result = `{"a":${"[".repeat(nesting)}0${"]".repeat(nesting)}}\n`;
    expect(() => parseFastManimLocalGatedOciResultV1(Buffer.from(result, "utf8"))).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
  });
});

describe.skipIf(!realLane)("real rootful gated OCI vertical slice", () => {
  const image = realImage!;

  it("verifies confinement, then renders a real Circle, Rectangle, and Line after the trusted gate", {
    timeout: 60_000,
  }, async () => {
    const request = requestFor(staticScene, "GatedStaticScene");
    const execution = await runFastManimLocalGatedOciV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    expect(execution.evidence).toMatchObject({
      resources: {
        memoryMax: String(512 * 1024 * 1024),
        memorySwapMax: "0",
        pidsMax: "64",
      },
    });
    const result = fastManimSnapshotResultV1Schema.parse(
      JSON.parse(Buffer.from(execution.resultBytes).toString("utf8")),
    );
    expect(result).toMatchObject({ kind: "compiled", requestId: "gated-GatedStaticScene" });
    if (result.kind !== "compiled") throw new Error("Expected a compiled static Scene.");
    expect((result.bundle as { scene: { entities: unknown[] } }).scene.entities).toHaveLength(3);
    expect(Buffer.from(execution.resultBytes).includes(Buffer.from("POIETRA_GATE_READY_V1"))).toBe(false);
  });

  it("keeps later untrusted copies of the READY marker out of the gate and result", { timeout: 60_000 }, async () => {
    const source = staticScene.replace(
      "def construct(self):",
      'def construct(self):\n        import os\n        os.write(2, b"POIETRA_GATE_READY_V1\\nuser-controlled\\n")',
    );
    const request = requestFor(source, "GatedStaticScene");
    const execution = await runFastManimLocalGatedOciV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(
      fastManimSnapshotResultV1Schema.parse(JSON.parse(Buffer.from(execution.resultBytes).toString("utf8"))),
    ).toMatchObject({ requestId: "gated-GatedStaticScene" });
    expect(Buffer.from(execution.resultBytes).includes(Buffer.from("user-controlled"))).toBe(false);
  });

  it("rejects wrong digest, wrong length, early EOF, and trailing bytes at the entrypoint", {
    timeout: 60_000,
  }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const cases = [
      wire(body, { digest: Buffer.alloc(32, 0xa5) }),
      wire(body, { length: body.byteLength - 1 }),
      wire(body, { length: body.byteLength + 1 }),
      Buffer.concat([wire(body), Buffer.from("x")]),
    ];
    for (const bytes of cases) {
      const error = await runFastManimLocalGatedOciV1({
        conformanceWire: { bytes, close: true },
        deadlineEpochMs: Date.now() + 15_000,
        image,
        requestBytes: body,
        signal: new AbortController().signal,
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(FastManimLocalGatedOciError);
      expect(error).toMatchObject({ cleanupVerified: true, code: "producer-exit" });
    }
  });

  it("times out a body that never reaches EOF and still removes its PID and container", {
    timeout: 30_000,
  }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const error = await runFastManimLocalGatedOciV1({
      conformanceWire: { bytes: wire(body), close: false },
      deadlineEpochMs: Date.now() + 1_200,
      image,
      requestBytes: body,
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(FastManimLocalGatedOciError);
    expect(error).toMatchObject({ cleanupVerified: true, code: "producer-timeout" });
  });

  it("aborts a gated body waiting for EOF and proves cleanup", { timeout: 30_000 }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const controller = new AbortController();
    const running = runFastManimLocalGatedOciV1({
      conformanceWire: { bytes: wire(body), close: false },
      deadlineEpochMs: Date.now() + 20_000,
      image,
      requestBytes: body,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 750).unref();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses reflective saved-descriptor source before it can execute", { timeout: 60_000 }, async () => {
    const reflectiveScene = staticScene.replace(
      "def construct(self):",
      'def construct(self):\n        import os\n        os.write(3, b"\\xff")',
    );
    const request = requestFor(reflectiveScene, "GatedStaticScene");
    const execution = await runFastManimLocalGatedOciV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    const result = fastManimSnapshotResultV1Schema.parse(
      JSON.parse(Buffer.from(execution.resultBytes).toString("utf8")),
    );
    expect(result).toMatchObject({ kind: "unsupported", requestId: "gated-GatedStaticScene" });
    if (result.kind !== "unsupported") throw new Error("Expected the static execution profile to refuse reflection.");
    expect(result.issues.flatMap((issue) => issue.evidence ?? [])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/denied import 'os'/),
        expect.stringMatching(/unlisted attribute write/),
      ]),
    );
  });
});
