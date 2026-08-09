import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalProcessFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import {
  detectSandboxResidueFaultV1,
  runFastManimSandboxIsolationConformanceV1,
  type SandboxConformanceEnvironmentV1,
  type SandboxConformanceObservationV1,
  type SandboxConformancePhaseV1,
  type SandboxConformanceTenantV1,
} from "./fast-manim-sandbox-isolation-conformance";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const HOST_SENTINEL_NAME = "POIETRA_CONFORMANCE_HOST_SENTINEL";
const PRODUCER_SENTINEL_NAME = "POIETRA_CONFORMANCE_PRODUCER_SENTINEL";
const PRODUCER_SENTINEL_VALUE = "delivered";

// A producer that reports what it observed about its private execution
// environment, then completes, exits non-zero, or hangs until aborted. Its mode
// is fixed by the backend's producer command, so the harness selects a mode per
// phase rather than per request.
const PROBE = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const [mode, readyPath] = process.argv.slice(-2);
  const request = JSON.parse(input);
  fs.writeFileSync(readyPath, process.cwd(), "utf8");
  if (mode === "fail") process.exit(3);
  if (mode === "hang") { setInterval(() => {}, 1_000); return; }
  process.stdout.write(JSON.stringify({
    workdir: process.cwd(),
    workdirEntries: fs.readdirSync(".").sort(),
    privateHome: process.env.HOME ?? null,
    privateTmpdir: process.env.TMPDIR ?? null,
    hostSentinel: process.env["${HOST_SENTINEL_NAME}"] ?? null,
    producerSentinel: process.env["${PRODUCER_SENTINEL_NAME}"] ?? null,
    marker: request.requestId,
    sourceDigest: crypto.createHash("sha256").update(request.sourceText, "utf8").digest("hex"),
  }));
});
`;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function probeModeForPhase(phase: SandboxConformancePhaseV1) {
  return phase === "failure" ? "fail" : phase === "abort" ? "hang" : "complete";
}

function localProcessConformanceEnvironment(): SandboxConformanceEnvironmentV1 {
  const projectRoot = join(tmpdir(), `poietra-conformance-project-${process.pid}-${Math.trunc(performance.now())}`);
  roots.push(projectRoot);
  let backendSequence = 0;

  const tenantFor = (seed: number): SandboxConformanceTenantV1 => {
    const requestMarker = `req-conformance-${seed}`;
    const baseProducer = sandboxProducerRequest();
    const sourceText = `${baseProducer.sourceText}\n# poietra-conformance-source-${seed}\n`;
    const sourceDigest = createHash("sha256").update(sourceText, "utf8").digest("hex");
    const producer = {
      ...baseProducer,
      projectId: "conformance",
      requestId: requestMarker,
      sourceHash: sourceDigest,
      sourceText,
    };
    return {
      context: {
        attestationDigest: "a".repeat(64),
        deadlineEpochMs: Date.now() + 30_000,
        identity: { projectId: "conformance", requestId: requestMarker, tenantId: `tenant-${seed}` },
        signal: new AbortController().signal,
      },
      request: new FastManimSandboxRequestBundleV1(producer),
      requestMarker,
      sourceDigest,
    };
  };

  return {
    assessRequestPrivacy(observationA, observationB) {
      return {
        detail: `A=${observationA.workdir} (${observationA.workdirEntries.join(",") || "empty"}), B=${observationB.workdir} (${observationB.workdirEntries.join(",") || "empty"})`,
        passed:
          observationA.workdir !== observationB.workdir &&
          observationA.workdirEntries.length === 0 &&
          observationB.workdirEntries.length === 0 &&
          observationA.privateHome === observationA.workdir &&
          observationA.privateTmpdir === observationA.workdir &&
          observationB.privateHome === observationB.workdir &&
          observationB.privateTmpdir === observationB.workdir,
      };
    },
    cleanupTargetExists(path) {
      return existsSync(path);
    },
    createBackend({ faultDisableCleanup = false, observedCleanupTargets, phase }) {
      backendSequence += 1;
      const readyPath = join(
        tmpdir(),
        `poietra-conformance-ready-${process.pid}-${Math.trunc(performance.now())}-${backendSequence}-${phase}`,
      );
      roots.push(readyPath);
      const backend = new LocalProcessFastManimSandboxBackendV1({
        command: [process.execPath, "-e", PROBE, probeModeForPhase(phase), readyPath],
        producerEnv: { [PRODUCER_SENTINEL_NAME]: PRODUCER_SENTINEL_VALUE },
        projectRoot,
        runtimeDirectoryRemover: async (runtimeDir) => {
          observedCleanupTargets.push(runtimeDir);
          roots.push(runtimeDir);
          if (!faultDisableCleanup) {
            await rm(runtimeDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
          }
        },
      });
      return {
        backend,
        async waitUntilStarted() {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            try {
              const target = await readFile(readyPath, "utf8");
              if (target.length > 0) return target;
            } catch {
              // The producer has not reached its start latch yet.
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`Sandbox conformance producer did not start during ${phase}.`);
        },
      };
    },
    hostSentinelName: HOST_SENTINEL_NAME,
    parseObservation(resultBytes): SandboxConformanceObservationV1 {
      const raw = JSON.parse(Buffer.from(resultBytes).toString("utf8")) as Record<string, unknown>;
      return {
        hostSentinel: (raw.hostSentinel as string | null) ?? null,
        privateHome: (raw.privateHome as string | null) ?? null,
        privateTmpdir: (raw.privateTmpdir as string | null) ?? null,
        producerSentinel: (raw.producerSentinel as string | null) ?? null,
        requestMarker: String(raw.marker),
        sourceDigest: String(raw.sourceDigest),
        workdir: String(raw.workdir),
        workdirEntries: (raw.workdirEntries as string[] | undefined) ?? [],
        cleanupTarget: String(raw.workdir),
      };
    },
    platform: {
      guaranteed: ["mkdtemp private HOME/TMPDIR", "host env allowlist", "runtime-dir removal in finally"],
      label: "local-process-development-v1",
      verified: [
        "request-private empty workdir",
        "cross-tenant delivery isolation",
        "host env non-leak",
        "workdir reclaimed on success/failure/abort",
      ],
    },
    producerSentinelValue: PRODUCER_SENTINEL_VALUE,
    tenant: tenantFor,
  };
}

describe("fast-manim sandbox tenant-isolation conformance", () => {
  it("passes every backend-neutral isolation claim on the local-process backend", async () => {
    const report = await runFastManimSandboxIsolationConformanceV1(localProcessConformanceEnvironment());

    expect(report.checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((entry) => entry.name)).toEqual([
      "request-private-workdir",
      "cross-tenant-delivery-isolation",
      "host-env-non-leak",
      "workdir-reclaimed-on-success",
      "workdir-reclaimed-on-failure",
      "workdir-reclaimed-on-abort",
    ]);
    expect(report.platform.label).toBe("local-process-development-v1");
  });

  it("detects residue when runtime-directory cleanup is removed", async () => {
    const fault = await detectSandboxResidueFaultV1(localProcessConformanceEnvironment());

    expect(fault.observedResidue).toBe(true);
    expect(fault.workdirs.length).toBeGreaterThan(0);
    for (const path of fault.workdirs) {
      expect(existsSync(path)).toBe(true);
      rmSync(path, { force: true, recursive: true });
    }
  });
});
