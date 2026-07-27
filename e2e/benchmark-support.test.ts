import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs module with a sibling .d.ts; vitest resolves it at runtime.
import { makeBenchmarkBuildManifest } from "../scripts/benchmark-build-manifest.mjs";
import {
  assessDecisionEligibility,
  collectCommitIdentity,
  collectHostEnvironment,
  requireStableCommitIdentity,
  resolveBenchmarkProvenance,
} from "./benchmark-environment";
import {
  BENCHMARK_BUILD_MANIFEST_PATH,
  benchmarkBuildManifestSchema,
  manifestFileMismatch,
  sha256Hex,
  verifyServedBuildManifest,
} from "./benchmark-manifest";
import { summarizeSignedTiming, summarizeTiming } from "./engine-stress-workloads";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function fakeGit(headCommit: string, porcelain: string) {
  return (args: readonly string[]) => {
    if (args[0] === "rev-parse") return `${headCommit}\n`;
    if (args[0] === "status") return porcelain;
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
}

describe("benchmark provenance", () => {
  it("derives clean/dirty identity from git and fails closed when git is unavailable", () => {
    expect(collectCommitIdentity(fakeGit(COMMIT_A, ""))).toEqual({
      headCommit: COMMIT_A,
      treeState: "clean",
      uncommittedPathCount: 0,
    });
    expect(collectCommitIdentity(fakeGit(COMMIT_A, " M a.ts\n?? b.ts\n"))).toEqual({
      headCommit: COMMIT_A,
      treeState: "dirty",
      uncommittedPathCount: 2,
    });
    expect(
      collectCommitIdentity(() => {
        throw new Error("no git");
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("aborts the decision lane on a dirty tree unless the smoke override is set", () => {
    expect(resolveBenchmarkProvenance({}, fakeGit(COMMIT_A, ""))).toEqual({
      commitIdentity: { headCommit: COMMIT_A, treeState: "clean", uncommittedPathCount: 0 },
      grade: "clean-commit",
    });
    expect(() => resolveBenchmarkProvenance({}, fakeGit(COMMIT_A, "?? x\n"))).toThrow(/clean working tree/);
    expect(resolveBenchmarkProvenance({ POIETRA_BENCHMARK_ALLOW_DIRTY: "1" }, fakeGit(COMMIT_A, "?? x\n")).grade).toBe(
      "non-decision-grade-dirty-tree",
    );
  });

  it("rejects HEAD or tree-state drift between run start and run end", () => {
    const start = { headCommit: COMMIT_A, treeState: "clean", uncommittedPathCount: 0 } as const;
    expect(requireStableCommitIdentity(start, fakeGit(COMMIT_A, ""))).toEqual(start);
    expect(() => requireStableCommitIdentity(start, fakeGit(COMMIT_B, ""))).toThrow(/changed during the benchmark run/);
    expect(() => requireStableCommitIdentity(start, fakeGit(COMMIT_A, " M drift.ts\n"))).toThrow(/disqualified/);
  });
});

describe("decision eligibility", () => {
  const hardwareAdapter = { backend: "BrowserWebGpu", deviceType: "DiscreteGpu", name: "Radeon" };

  it("flags software adapters, missing evidence, and unpinned reference profiles machine-readably", () => {
    const assessment = assessDecisionEligibility({
      grade: "non-decision-grade-dirty-tree",
      host: collectHostEnvironment(),
      pageAdapterHintArchitecture: "swiftshader",
      workerAdapters: [{ backend: "BrowserWebGpu", deviceType: "Cpu", name: "" }],
    });
    expect(assessment.eligible).toBe(false);
    expect(assessment.reasons.join("\n")).toMatch(/dirty/);
    expect(assessment.reasons.join("\n")).toMatch(/software adapter/);
    expect(assessment.reasons.join("\n")).toMatch(/swiftshader/);
    expect(assessment.reasons.join("\n")).toMatch(/reference adapter\/host\/driver\/power-mode/);

    // Even a clean hardware run stays ineligible until a reference profile is
    // pinned; the reasons say exactly why.
    const cleanest = assessDecisionEligibility({
      grade: "clean-commit",
      host: collectHostEnvironment(),
      pageAdapterHintArchitecture: null,
      workerAdapters: [hardwareAdapter],
    });
    expect(cleanest.eligible).toBe(false);
    expect(cleanest.reasons.every((reason) => reason.length > 0)).toBe(true);
  });

  it("requires at least one worker adapter evidence entry", () => {
    const assessment = assessDecisionEligibility({
      grade: "clean-commit",
      host: collectHostEnvironment(),
      pageAdapterHintArchitecture: null,
      workerAdapters: [],
    });
    expect(assessment.reasons.join("\n")).toMatch(/no Worker device adapter evidence/);
  });
});

describe("build manifest", () => {
  it("hashes the served executable set and detects swapped or truncated files", () => {
    const distDir = mkdtempSync(join(tmpdir(), "poietra-manifest-"));
    try {
      mkdirSync(join(distDir, "assets"));
      mkdirSync(join(distDir, "engine-wasm"));
      writeFileSync(join(distDir, "benchmark.html"), "<html>bench</html>");
      writeFileSync(join(distDir, "assets", "benchmark-abc.js"), "entry();");
      writeFileSync(join(distDir, "assets", "canvas-worker-client-def.js"), "client();");
      writeFileSync(join(distDir, "engine-wasm", "poietra_wasm.js"), "glue();");
      writeFileSync(join(distDir, "engine-wasm", "poietra_wasm_bg.wasm"), Buffer.from([0, 97, 115, 109]));

      const manifest = benchmarkBuildManifestSchema.parse(
        makeBenchmarkBuildManifest(distDir, { commit: COMMIT_A, treeState: "clean" }),
      );
      expect(manifest.files.map((file) => file.path)).toEqual([
        "assets/benchmark-abc.js",
        "assets/canvas-worker-client-def.js",
        "benchmark.html",
        "engine-wasm/poietra_wasm.js",
        "engine-wasm/poietra_wasm_bg.wasm",
      ]);

      const entry = manifest.files.find((file) => file.path === "assets/benchmark-abc.js")!;
      expect(manifestFileMismatch(entry, new TextEncoder().encode("entry();"))).toBeNull();
      expect(manifestFileMismatch(entry, new TextEncoder().encode("swapped();"))).toMatch(/hashes to|bytes/);
      expect(manifestFileMismatch(entry, new TextEncoder().encode("entry()"))).toMatch(/bytes/);
      expect(sha256Hex(new TextEncoder().encode("entry();"))).toBe(entry.sha256);
    } finally {
      rmSync(distDir, { force: true, recursive: true });
    }
  });
});

describe("served build manifest verification", () => {
  function servedFixture(treeState: "clean" | "dirty") {
    const encoder = new TextEncoder();
    const files = new Map<string, Uint8Array>([
      ["benchmark.html", encoder.encode("<html>bench</html>")],
      ["assets/benchmark-abc.js", encoder.encode("entry();")],
      ["engine-wasm/poietra_wasm.js", encoder.encode("glue();")],
      ["engine-wasm/poietra_wasm_bg.wasm", new Uint8Array([0, 97, 115, 109])],
    ]);
    const manifest = {
      commit: COMMIT_A,
      files: [...files.entries()]
        .map(([path, bytes]) => ({ byteLength: bytes.byteLength, path, sha256: sha256Hex(bytes) }))
        .sort((left, right) => left.path.localeCompare(right.path)),
      generatedAtEpochMs: 1,
      schema: "poietra.benchmark-build-manifest",
      treeState,
      version: 1,
    };
    const fetchServedFile = async (path: string) => {
      if (path === BENCHMARK_BUILD_MANIFEST_PATH) return new TextEncoder().encode(JSON.stringify(manifest));
      const bytes = files.get(path);
      if (!bytes) throw new Error(`unexpected fetch: ${path}`);
      return bytes;
    };
    return { fetchServedFile, files };
  }

  it("accepts a served build whose commit AND tree state match the run's provenance", async () => {
    const { fetchServedFile } = servedFixture("clean");
    await expect(
      verifyServedBuildManifest(fetchServedFile, { headCommit: COMMIT_A, treeState: "clean" }),
    ).resolves.toMatchObject({ commit: COMMIT_A, treeState: "clean" });
  });

  it("rejects a dirty-built manifest at the same HEAD during a clean-tree run", async () => {
    // Same commit, but the served bytes were produced from a dirty tree: a
    // clean (decision-candidate) run must never attribute them to its commit.
    const { fetchServedFile } = servedFixture("dirty");
    await expect(
      verifyServedBuildManifest(fetchServedFile, { headCommit: COMMIT_A, treeState: "clean" }),
    ).rejects.toThrow(/built from a dirty tree.*this run's tree is clean/);
    // And the inverse: a clean-built manifest does not match a dirty run.
    const clean = servedFixture("clean");
    await expect(
      verifyServedBuildManifest(clean.fetchServedFile, { headCommit: COMMIT_A, treeState: "dirty" }),
    ).rejects.toThrow(/built from a clean tree.*this run's tree is dirty/);
  });

  it("rejects a manifest built at a different commit or with swapped served bytes", async () => {
    const { fetchServedFile, files } = servedFixture("clean");
    await expect(
      verifyServedBuildManifest(fetchServedFile, { headCommit: COMMIT_B, treeState: "clean" }),
    ).rejects.toThrow(/stale build/);
    files.set("assets/benchmark-abc.js", new TextEncoder().encode("tampered();"));
    await expect(
      verifyServedBuildManifest(fetchServedFile, { headCommit: COMMIT_A, treeState: "clean" }),
    ).rejects.toThrow(/verification failed/);
  });
});

describe("report summaries", () => {
  it("rejects short, non-finite, or negative series and keeps signed residuals unclamped", () => {
    expect(() => summarizeTiming([1, 2], 3)).toThrow(/exactly 3/);
    expect(() => summarizeTiming([1, -0.5, 2], 3)).toThrow(/invalid/);
    expect(() => summarizeTiming([1, Number.NaN, 2], 3)).toThrow(/invalid/);
    expect(summarizeTiming([3, 1, 2], 3).p50Ms).toBe(2);

    expect(() => summarizeSignedTiming([0.1, Number.POSITIVE_INFINITY], 2)).toThrow(/invalid/);
    const signed = summarizeSignedTiming([-0.4, 0.2, 0.1], 3);
    expect(signed.p50Ms).toBe(0.1);
    expect(Math.min(...signed.samplesMs)).toBe(-0.4);
  });
});
