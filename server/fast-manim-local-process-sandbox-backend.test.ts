import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalProcessFastManimSandboxBackendV1,
  materializeFastManimSandboxPngV2,
} from "./fast-manim-local-process-sandbox-backend";
import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import { sandboxPngBytes, sandboxPngProducerRequest } from "./test-fixtures/fast-manim-sandbox-png-fixture";

const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "poietra-png-sandbox-test-"));
  roots.push(root);
  return root;
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
