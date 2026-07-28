import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createFastManimRuncProductionCompositionV1,
  type FastManimRuncProductionCompositionOptionsV1,
} from "./fast-manim-runc-production-composition";
import { FastManimSandboxRequestBundleV1, resolveFastManimSandboxReadiness } from "./fast-manim-sandbox-backend";
import { DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1 } from "./fast-manim-sandbox-resources";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const realLaneEnabled = process.env.POIETRA_RUN_FAST_MANIM_RUNC_REAL === "1";
const configPath = process.env.POIETRA_FAST_MANIM_RUNC_REAL_CONFIG?.trim();

type RealHostConfig = Omit<
  FastManimRuncProductionCompositionOptionsV1,
  "limits" | "profile" | "seccomp" | "startupSignal"
>;

function loadJson(path: string) {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

function loadConfig() {
  if (!configPath) {
    throw new Error("POIETRA_FAST_MANIM_RUNC_REAL_CONFIG is required when the real production runc lane is enabled.");
  }
  return loadJson(configPath) as RealHostConfig;
}

async function childDirectories(path: string) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

describe.skipIf(!realLaneEnabled)("real production runc composition", () => {
  it("runs one snapshot through runc, userns, cgroup v2, and the verified read-only rootfs", {
    timeout: 180_000,
  }, async () => {
    const config = loadConfig();
    const profile = loadJson(
      new URL("../sandbox/fast-manim-oci/profile.v1.json", import.meta.url).pathname,
    ) as FastManimRuncProductionCompositionOptionsV1["profile"];
    const seccomp = loadJson(
      new URL("../sandbox/fast-manim-oci/seccomp.v1.json", import.meta.url).pathname,
    ) as FastManimRuncProductionCompositionOptionsV1["seccomp"];
    const startup = new AbortController();
    const backend = await createFastManimRuncProductionCompositionV1({
      ...config,
      limits: DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
      profile,
      seccomp,
      startupSignal: startup.signal,
    });

    try {
      const requestValue = sandboxProducerRequest();
      const identity = {
        projectId: requestValue.projectId,
        requestId: requestValue.requestId,
        tenantId: "runc-real-tenant",
      };
      const status = await backend.status({
        deadlineEpochMs: Date.now() + 60_000,
        identity,
        signal: new AbortController().signal,
      });
      const readiness = resolveFastManimSandboxReadiness(status, "production", Date.now(), backend.attestationVerifier);
      expect(readiness.kind).toBe("ready");
      if (readiness.kind !== "ready") throw new Error("The real production runc backend was not ready.");

      const request = new FastManimSandboxRequestBundleV1(requestValue);
      const execution = await backend.start(request, {
        attestationDigest: readiness.attestationDigest,
        deadlineEpochMs: Date.now() + 120_000,
        identity,
        signal: new AbortController().signal,
      }).result;
      expect(execution.kind).toBe("ok");
      if (execution.kind !== "ok") throw new Error(`The real production runc job failed: ${execution.code}.`);
      expect(execution.requestDigest).toBe(request.requestDigest);
      expect(JSON.parse(Buffer.from(execution.resultBytes).toString("utf8"))).toMatchObject({
        schema: "poietra.fast-manim-source-runtime-identity",
        version: 1,
      });
    } finally {
      await backend.close();
    }

    await expect(childDirectories(config.cgroup.root)).resolves.toEqual([]);
    await expect(childDirectories(config.bundleRoot)).resolves.toEqual([]);
    await expect(childDirectories(config.runtimeStateRoot)).resolves.toEqual([]);
  });
});
