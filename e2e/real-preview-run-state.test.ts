import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FullConfig, FullResult } from "@playwright/test/reporter";
import { afterEach, describe, expect, it } from "vitest";

import RealPreviewRunReporter from "./real-preview-run-reporter";
import {
  MAX_REAL_PREVIEW_EVIDENCE_AGE_MS_V1,
  MAX_REAL_PREVIEW_EVIDENCE_FILES_V1,
  MAX_REAL_PREVIEW_EVIDENCE_RUNS_V1,
  REAL_PREVIEW_DATA_PREFIX_V1,
  REAL_PREVIEW_HARNESS_PREFIX_V1,
  realPreviewRunStateFromEnvironmentV1,
  reclaimRealPreviewRunStateV1,
} from "./real-preview-run-state";

const roots: string[] = [];

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "poietra-real-preview-run-state-test-"));
  roots.push(root);
  const temporaryRoot = join(root, "tmp");
  const outputRoot = join(root, "test-results");
  mkdirSync(temporaryRoot);
  mkdirSync(outputRoot);
  return { evidenceRoot: join(outputRoot, "real-preview-evidence"), outputRoot, root, temporaryRoot };
}

function harnessAt(temporaryRoot: string, suffix = "AbCdEf") {
  const path = join(temporaryRoot, `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-${suffix}`);
  mkdirSync(join(path, "example_scenes"), { recursive: true });
  writeFileSync(join(path, "example_scenes", "basic.py"), "square = Square()\n");
  return path;
}

function dataAt(outputRoot: string, suffix = "1234-real-preview-v9") {
  const path = join(outputRoot, `${REAL_PREVIEW_DATA_PREFIX_V1}${suffix}`);
  mkdirSync(join(path, "sessions"), { recursive: true });
  writeFileSync(join(path, "sessions", "session.json"), "{}");
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("real-preview run state reclamation", () => {
  it("reclaims the run-owned harness and workspace store after a passing run", () => {
    const { evidenceRoot, outputRoot, temporaryRoot } = sandbox();
    const harnessRoot = harnessAt(temporaryRoot);
    const dataRoot = dataAt(outputRoot);

    const result = reclaimRealPreviewRunStateV1({
      dataRoot,
      evidenceRoot,
      harnessRoot,
      now: 1_000,
      outcome: "passed",
      outputRoot,
      temporaryRoot,
    });

    expect(result.failures).toEqual([]);
    expect(result.removed.sort()).toEqual([dataRoot, harnessRoot].sort());
    expect(result.retainedEvidencePath).toBeNull();
    expect(existsSync(harnessRoot)).toBe(false);
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(evidenceRoot)).toBe(false);
  });

  it("retains bounded failure evidence and still leaks no mutable state into the next run", () => {
    const { evidenceRoot, outputRoot, temporaryRoot } = sandbox();
    const harnessRoot = harnessAt(temporaryRoot);
    const dataRoot = dataAt(outputRoot);
    writeFileSync(join(harnessRoot, "example_scenes", "basic.py"), "square = Circle()\n");

    const result = reclaimRealPreviewRunStateV1({
      dataRoot,
      evidenceRoot,
      harnessRoot,
      now: 1_000,
      outcome: "failed",
      outputRoot,
      temporaryRoot,
    });

    expect(result.failures).toEqual([]);
    expect(result.retainedEvidencePath).toBe(join(evidenceRoot, `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-AbCdEf`));
    expect(existsSync(join(result.retainedEvidencePath!, "example_scenes", "basic.py"))).toBe(true);
    expect(existsSync(harnessRoot)).toBe(false);
    expect(existsSync(dataRoot)).toBe(false);
  });

  it("refuses every path outside this run's opaque namespace", () => {
    const { evidenceRoot, outputRoot, root, temporaryRoot } = sandbox();
    const shared = join(root, "fixtures-real-preview-harness");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "basic.py"), "square = Square()\n");
    const bareprefix = join(temporaryRoot, REAL_PREVIEW_HARNESS_PREFIX_V1);
    mkdirSync(bareprefix);
    const nested = join(temporaryRoot, "nested");
    mkdirSync(join(nested, `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-Nested`), { recursive: true });
    const linked = join(temporaryRoot, `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-Linked`);
    symlinkSync(shared, linked, "dir");

    for (const harnessRoot of [shared, bareprefix, join(nested, `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-Nested`), linked]) {
      const result = reclaimRealPreviewRunStateV1({
        dataRoot: null,
        evidenceRoot,
        harnessRoot,
        now: 1_000,
        outcome: "failed",
        outputRoot,
        temporaryRoot,
      });
      expect(result.removed).toEqual([]);
      expect(result.retainedEvidencePath).toBeNull();
      expect(result.failures).toEqual([expect.stringContaining("outside this run's namespace")]);
    }
    expect(existsSync(join(shared, "basic.py"))).toBe(true);
    expect(existsSync(bareprefix)).toBe(true);
    expect(existsSync(linked)).toBe(true);
    // A workspace store outside test-results/ is refused the same way.
    const strayData = join(root, `${REAL_PREVIEW_DATA_PREFIX_V1}stray`);
    mkdirSync(strayData);
    expect(
      reclaimRealPreviewRunStateV1({
        dataRoot: strayData,
        evidenceRoot,
        harnessRoot: null,
        now: 1_000,
        outcome: "passed",
        outputRoot,
        temporaryRoot,
      }).failures,
    ).toEqual([expect.stringContaining("outside this run's namespace")]);
    expect(existsSync(strayData)).toBe(true);
  });

  it("bounds retained evidence by run count, age, and file count", () => {
    const { evidenceRoot, outputRoot, temporaryRoot } = sandbox();
    mkdirSync(evidenceRoot, { recursive: true });
    const expired = join(evidenceRoot, `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-Expired`);
    mkdirSync(expired);
    const now = MAX_REAL_PREVIEW_EVIDENCE_AGE_MS_V1 * 4;
    const expiredSeconds = (now - MAX_REAL_PREVIEW_EVIDENCE_AGE_MS_V1 - 60_000) / 1_000;
    utimesSync(expired, expiredSeconds, expiredSeconds);
    for (let index = 0; index < MAX_REAL_PREVIEW_EVIDENCE_RUNS_V1 + 2; index += 1) {
      const previous = join(evidenceRoot, `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-Prev${index}`);
      mkdirSync(previous);
      const seconds = (now - (index + 1) * 60_000) / 1_000;
      utimesSync(previous, seconds, seconds);
    }

    const harnessRoot = harnessAt(temporaryRoot, "Newest");
    for (let index = 0; index < MAX_REAL_PREVIEW_EVIDENCE_FILES_V1 + 20; index += 1) {
      writeFileSync(join(harnessRoot, `artifact-${String(index).padStart(4, "0")}.txt`), "x");
    }

    const result = reclaimRealPreviewRunStateV1({
      dataRoot: null,
      evidenceRoot,
      harnessRoot,
      now,
      outcome: "failed",
      outputRoot,
      temporaryRoot,
    });

    expect(result.failures).toEqual([]);
    const retained = readdirSync(evidenceRoot).sort();
    expect(retained).toContain(`${REAL_PREVIEW_HARNESS_PREFIX_V1}9-Newest`);
    expect(retained).not.toContain(`${REAL_PREVIEW_HARNESS_PREFIX_V1}9-Expired`);
    expect(retained).toHaveLength(MAX_REAL_PREVIEW_EVIDENCE_RUNS_V1);

    const copied: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name));
        else copied.push(entry.name);
      }
    };
    walk(result.retainedEvidencePath!);
    expect(copied.length).toBeLessThanOrEqual(MAX_REAL_PREVIEW_EVIDENCE_FILES_V1);
  });

  it("treats an already-reclaimed namespace as done instead of a cleanup failure", () => {
    const { evidenceRoot, outputRoot, temporaryRoot } = sandbox();

    expect(
      reclaimRealPreviewRunStateV1({
        dataRoot: join(outputRoot, `${REAL_PREVIEW_DATA_PREFIX_V1}gone-real-preview-v9`),
        evidenceRoot,
        harnessRoot: join(temporaryRoot, `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-Gone`),
        now: 1_000,
        outcome: "failed",
        outputRoot,
        temporaryRoot,
      }),
    ).toEqual({ failures: [], removed: [], retainedEvidencePath: null });
  });

  it("reclaims through the Playwright reporter on both run outcomes without rewriting the run status", async () => {
    const previousData = process.env.POIETRA_E2E_REAL_PREVIEW_DATA_ROOT;
    const previousHarness = process.env.POIETRA_E2E_REAL_PREVIEW_HARNESS_ROOT;
    const written: string[] = [];
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    const capture = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    try {
      for (const status of ["passed", "failed"] as const) {
        const { evidenceRoot, outputRoot } = sandbox();
        // The reporter resolves the namespace against the real `tmpdir()`, so
        // this harness must be a direct child of it like a real run's copy.
        const harnessRoot = mkdtempSync(join(tmpdir(), `${REAL_PREVIEW_HARNESS_PREFIX_V1}9-`));
        roots.push(harnessRoot);
        mkdirSync(join(harnessRoot, "example_scenes"), { recursive: true });
        writeFileSync(join(harnessRoot, "example_scenes", "basic.py"), "square = Circle()\n");
        const dataRoot = dataAt(outputRoot, `${status}-real-preview-v9`);
        process.env.POIETRA_E2E_REAL_PREVIEW_DATA_ROOT = dataRoot;
        process.env.POIETRA_E2E_REAL_PREVIEW_HARNESS_ROOT = harnessRoot;

        const reporter = new RealPreviewRunReporter();
        reporter.onBegin({ projects: [{ outputDir: outputRoot }] } as unknown as FullConfig);
        // The reporter observes the status and never returns a replacement.
        expect(reporter.onEnd({ status } as FullResult)).toBeUndefined();
        // `tmpdir()` owns this run's harness only when the sandbox lives there,
        // so drive the namespace guard through the same environment contract.
        await reporter.onExit();

        expect(existsSync(dataRoot)).toBe(false);
        expect(existsSync(harnessRoot)).toBe(false);
        expect(existsSync(evidenceRoot)).toBe(status === "failed");
      }
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      process.env.POIETRA_E2E_REAL_PREVIEW_DATA_ROOT = previousData;
      process.env.POIETRA_E2E_REAL_PREVIEW_HARNESS_ROOT = previousHarness;
    }
    expect(written.join("")).toContain("real-preview teardown reclaimed");
    expect(written.join("")).not.toContain("teardown failed");
  });

  it("reads the run namespace only from the variables the real-preview config publishes", () => {
    const { outputRoot, temporaryRoot } = sandbox();

    expect(realPreviewRunStateFromEnvironmentV1({}, outputRoot, temporaryRoot)).toBeNull();
    expect(
      realPreviewRunStateFromEnvironmentV1(
        { POIETRA_E2E_REAL_PREVIEW_DATA_ROOT: "   ", POIETRA_E2E_REAL_PREVIEW_HARNESS_ROOT: "" },
        outputRoot,
        temporaryRoot,
      ),
    ).toBeNull();
    expect(
      realPreviewRunStateFromEnvironmentV1(
        { POIETRA_E2E_REAL_PREVIEW_DATA_ROOT: "/store", POIETRA_E2E_REAL_PREVIEW_HARNESS_ROOT: "/harness" },
        outputRoot,
        temporaryRoot,
      ),
    ).toEqual({
      dataRoot: "/store",
      evidenceRoot: join(outputRoot, "real-preview-evidence"),
      harnessRoot: "/harness",
      outputRoot,
      temporaryRoot,
    });
  });
});
