import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { FastManimSandboxBackendV1 } from "./fast-manim-sandbox-backend";
import { localSandboxReadyStatus } from "./test-fixtures/fast-manim-sandbox-backend-fixture";
import { sandboxPngBytes } from "./test-fixtures/fast-manim-sandbox-png-fixture";

import {
  createRunner,
  expectFailure,
  installFastManimSnapshotRunnerFixture,
  producerCommand,
  runRequest,
  supportsVerifiedRead,
} from "./test-fixtures/fast-manim-snapshot-runner-fixture";

const { projectRoot } = installFastManimSnapshotRunnerFixture();

function captureThenFail(onRequest: (request: Uint8Array) => void): FastManimSandboxBackendV1 {
  return {
    async close() {},
    start(request, context) {
      onRequest(request.copyBytes());
      return {
        abort() {},
        result: Promise.resolve({
          attestationDigest: context.attestationDigest,
          code: "sandbox-execution-failed",
          kind: "failed",
          requestDigest: request.requestDigest,
        }),
      };
    },
    async status() {
      return localSandboxReadyStatus();
    },
  };
}

describe.skipIf(!supportsVerifiedRead)("fast-manim snapshot runner hermetic plan pinning", () => {
  it("returns a structured fallback before spawning when profile V4 has no valid PNG generation", async () => {
    const root = await projectRoot();
    const missing = createRunner(root, producerCommand(), { snapshotVersion: 4 });
    expectFailure(await missing.run(runRequest()), "asset-unavailable");
    await missing.close();

    const invalid = createRunner(root, producerCommand(), {
      pngProvider: { readVerified: async () => ({ bytes: Uint8Array.of(1, 2, 3), versionToken: "generation:1" }) },
      snapshotVersion: 4,
    });
    expectFailure(await invalid.run(runRequest({ requestId: "snapshot-request-invalid-png" })), "asset-unavailable");
    await invalid.close();
  });

  it("does not read a configured PNG provider for legacy snapshot profiles", async () => {
    const readVerified = vi.fn(async () => {
      throw new Error("Legacy snapshots must not read image.png.");
    });
    const runner = createRunner(await projectRoot(), producerCommand(), { pngProvider: { readVerified } });

    await expect(runner.run(runRequest())).resolves.toMatchObject({ status: "verified" });
    expect(readVerified).not.toHaveBeenCalled();
    await runner.close();
  });

  it("keeps the source-derived V4 transform plan out of the producer wire", async () => {
    const root = await projectRoot();
    const source = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class ExampleScene(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
        image.scale(1.5)
        image.move_to((1, -2, 0))
        self.wait(1)
`;
    await writeFile(join(root, "scene.py"), source, "utf8");
    let capturedRequest: Uint8Array | undefined;
    const backend = captureThenFail((request) => {
      capturedRequest = request;
    });
    const runner = createRunner(root, null, {
      backend,
      pngProvider: { readVerified: async () => ({ bytes: sandboxPngBytes(), versionToken: "generation:1" }) },
      snapshotVersion: 4,
    });

    expectFailure(await runner.run(runRequest()), "sandbox-execution-failed");
    expect(capturedRequest).toBeDefined();
    const encoded = Buffer.from(capturedRequest!).toString("utf8");
    const envelope = JSON.parse(encoded) as { producerRequest: Record<string, unknown> };
    expect(envelope.producerRequest.sourceText).toBe(source);
    expect(envelope.producerRequest).not.toHaveProperty("hermeticPngV4Plan");
    expect(encoded).not.toContain("hermeticPngV4Plan");
    await runner.close();
  });

  it("keeps the source-derived V3 MathTex transform plan out of the producer wire", async () => {
    const root = await projectRoot();
    const source = `from manim import MathTex, Scene

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        equation.scale(1.5)
        equation.move_to((1, -2, 0))
        self.wait(2)
`;
    await writeFile(join(root, "scene.py"), source, "utf8");
    let capturedRequest: Uint8Array | undefined;
    const backend = captureThenFail((request) => {
      capturedRequest = request;
    });
    const runner = createRunner(root, null, { backend, snapshotVersion: 3 });

    expectFailure(await runner.run(runRequest()), "sandbox-execution-failed");
    expect(capturedRequest).toBeDefined();
    const encoded = Buffer.from(capturedRequest!).toString("utf8");
    const producerRequest = JSON.parse(encoded) as Record<string, unknown>;
    expect(producerRequest.sourceText).toBe(source);
    expect(producerRequest).not.toHaveProperty("hermeticMathTexV3Plan");
    expect(encoded).not.toContain("hermeticMathTexV3Plan");
    await runner.close();
  });

  it("keeps the source-derived V5 MathTex morph plan out of the producer wire", async () => {
    const root = await projectRoot();
    const source = String.raw`from manim import MathTex, Scene, TransformMatchingTex, smoothstep

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        maxwell = MathTex(r"\nabla \cdot \mathbf{E}")
        maxwell.move_to(equation.get_center())
        self.play(TransformMatchingTex(equation, maxwell, transform_mismatches=True), run_time=1, rate_func=smoothstep)
        equation = maxwell
        restored = MathTex("E = mc^2")
        restored.move_to(maxwell.get_center())
        self.play(TransformMatchingTex(maxwell, restored, transform_mismatches=True), run_time=1, rate_func=smoothstep)
        maxwell = restored
        equation = restored
`;
    await writeFile(join(root, "scene.py"), source, "utf8");
    let capturedRequest: Uint8Array | undefined;
    const backend = captureThenFail((request) => {
      capturedRequest = request;
    });
    const runner = createRunner(root, null, { backend, snapshotVersion: 5 });

    expectFailure(await runner.run(runRequest()), "sandbox-execution-failed");
    expect(capturedRequest).toBeDefined();
    const encoded = Buffer.from(capturedRequest!).toString("utf8");
    const producerRequest = JSON.parse(encoded) as Record<string, unknown>;
    expect(producerRequest.sourceText).toBe(source);
    expect(producerRequest.snapshotVersion).toBe(5);
    expect(producerRequest).not.toHaveProperty("hermeticMathTexMorphV5Plan");
    expect(encoded).not.toContain("hermeticMathTexMorphV5Plan");
    await runner.close();
  });
});
