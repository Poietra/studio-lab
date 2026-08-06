import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { LocalProcessFastManimSandboxBackendV1 } from "../server/fast-manim-local-process-sandbox-backend";
import { fastManimRuntimeTraceProducerEnvironmentV1 } from "../server/fast-manim-runtime-trace-profile";
import { FastManimSnapshotAdmissionController, FastManimSnapshotRunner } from "../server/fast-manim-snapshot-runner";
import { parseFastManimSnapshotProducerCommand } from "../server/manim-render-config";
import {
  assertRealManimCensusFloor,
  buildRealManimCensusReport,
  loadRealManimCensusManifest,
  type RealManimCensusAttempt,
  realManimCensusCaseId,
  realManimCensusRuntimeTraceCaseId,
} from "./real-manim-census-report";

const execute = promisify(execFile);
const workspaceRoot = resolve(import.meta.dirname, "..");
const manifestPath = join(workspaceRoot, "fixtures", "real-manim-census-v1", "manifest.json");
const baselinePath = join(workspaceRoot, "fixtures", "real-manim-census-v1", "baseline.json");
const fastManimRootValue = process.env.POIETRA_REAL_MANIM_CENSUS_FAST_MANIM_ROOT?.trim();
const snapshotCommand = parseFastManimSnapshotProducerCommand(process.env.POIETRA_FAST_MANIM_SNAPSHOT_COMMAND);
const runtimeTraceCommand = parseFastManimSnapshotProducerCommand(process.env.POIETRA_FAST_MANIM_RUNTIME_TRACE_COMMAND);
const enabled = Boolean(fastManimRootValue && snapshotCommand && runtimeTraceCommand);

const frame = { height: 8, width: 14.222222222222221 } as const;
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn4HhvwMADzoDPsGQfWoAAAAASUVORK5CYII=",
  "base64",
);

async function gitValue(root: string, expression: string) {
  const { stdout } = await execute("git", ["-C", root, "rev-parse", expression], { encoding: "utf8" });
  return stdout.trim();
}

async function verifyPinnedProducer(
  root: string,
  producer: Readonly<{ digest: string; repository: string; revision: string; tree: string }>,
) {
  const [revision, tree, status] = await Promise.all([
    gitValue(root, "HEAD"),
    gitValue(root, "HEAD^{tree}"),
    execute("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).then(({ stdout }) => stdout),
  ]);
  if (status.trim()) throw new Error("The pinned fast-manim census checkout must be clean.");
  if (revision !== producer.revision || tree !== producer.tree) {
    throw new Error(`Expected fast-manim ${producer.revision}/${producer.tree}, received ${revision}/${tree}.`);
  }
  const digest = createHash("sha256")
    .update(producer.repository)
    .update("\0")
    .update(revision)
    .update("\0")
    .update(tree)
    .digest("hex");
  if (digest !== producer.digest) throw new Error("The pinned fast-manim producer digest does not match.");
  return digest;
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, callback: (value: T) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await callback(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

describe.skipIf(!enabled)("pinned real-Manim compatibility census", () => {
  it("regenerates structured producer coverage without converting unknowns into previews", {
    timeout: 900_000,
  }, async () => {
    const fastManimRoot = resolve(fastManimRootValue!);
    const snapshotProducerCommand = snapshotCommand!;
    const runtimeTraceProducerCommand = runtimeTraceCommand!;
    const manifest = await loadRealManimCensusManifest(manifestPath);
    if (snapshotProducerCommand.at(-2) !== "-m" || snapshotProducerCommand.at(-1) !== manifest.producer.module) {
      throw new Error(`The census command must execute the pinned ${manifest.producer.module} module.`);
    }
    if (
      runtimeTraceProducerCommand.at(-2) !== "-m" ||
      runtimeTraceProducerCommand.at(-1) !== manifest.producer.runtimeTraceModule
    ) {
      throw new Error(
        `The Runtime Trace census command must execute the pinned ${manifest.producer.runtimeTraceModule} module.`,
      );
    }
    const producerDigest = await verifyPinnedProducer(fastManimRoot, manifest.producer);
    await execute("uv", ["sync", "--frozen", "--project", fastManimRoot], { cwd: workspaceRoot, encoding: "utf8" });
    const assetBytes = new Map([["fixture-png", pngBytes]]);
    for (const asset of manifest.assets) {
      const bytes = assetBytes.get(asset.id);
      if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        throw new Error(`The real-Manim census asset ${asset.id} does not match its manifest pin.`);
      }
    }
    const fixturePng = manifest.assets.find(({ id }) => id === "fixture-png");
    if (fixturePng === undefined) throw new Error("The real-Manim census snapshot PNG is not pinned.");
    const cases = manifest.sources.flatMap((source) =>
      source.scenes.flatMap((scene) => [
        ...scene.profiles.map((profile) => ({
          caseId: realManimCensusCaseId(source.id, scene.name, profile),
          corpus: source.corpus,
          features: scene.features ?? [],
          kind: "snapshot" as const,
          profile,
          repository: source.repository,
          sceneName: scene.name,
          sourcePath: source.path,
          sourceSha256: source.sha256,
        })),
        ...(scene.runtimeTraceVersions ?? []).map((runtimeTraceVersion) => ({
          caseId: realManimCensusRuntimeTraceCaseId(source.id, scene.name, runtimeTraceVersion),
          corpus: source.corpus,
          features: scene.features ?? [],
          kind: "runtime-trace" as const,
          repository: source.repository,
          runtimeTraceVersion,
          sceneName: scene.name,
          sourcePath: source.path,
          sourceSha256: source.sha256,
        })),
      ]),
    );

    const attempts = await mapConcurrent(cases, 2, async (entry): Promise<RealManimCensusAttempt> => {
      const projectRoot = entry.repository === "fast-manim" ? fastManimRoot : workspaceRoot;
      const sourceBytes = await readFile(join(projectRoot, entry.sourcePath));
      const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
      if (sourceDigest !== entry.sourceSha256) throw new Error(`${entry.caseId} source digest drifted.`);
      const backend = new LocalProcessFastManimSandboxBackendV1({
        admissionController: new FastManimSnapshotAdmissionController(),
        command: entry.kind === "snapshot" ? snapshotProducerCommand : runtimeTraceProducerCommand,
        ...(entry.kind === "runtime-trace" ? { producerEnv: fastManimRuntimeTraceProducerEnvironmentV1() } : {}),
        projectRoot,
      });
      const runner = new FastManimSnapshotRunner({
        backend,
        deployment: "test",
        frame,
        projectId: "census",
        projectRoot,
        pngProvider: {
          readVerified: async () => ({ bytes: new Uint8Array(pngBytes), versionToken: fixturePng.versionToken }),
        },
        ...(entry.kind === "snapshot" ? { snapshotVersion: entry.profile } : {}),
        tenantId: "census",
        timeoutMs: 120_000,
      });
      try {
        const common = {
          caseId: entry.caseId,
          corpus: entry.corpus,
          features: entry.features,
          sceneName: entry.sceneName,
        } as const;
        if (entry.kind === "runtime-trace") {
          const result = await runner.runRuntimeTrace({
            projectId: "census",
            requestId: entry.caseId.replaceAll(/[^a-zA-Z0-9._:-]/g, "-"),
            sceneName: entry.sceneName,
            sourceHash: sourceDigest,
            sourcePath: entry.sourcePath,
          });
          if (result.status === "verified") {
            return {
              ...common,
              outcome: "accepted",
              reasons: [],
              runtimeTraceVersion: entry.runtimeTraceVersion,
              traceHash: result.traceDigest,
            };
          }
          return {
            ...common,
            outcome: "rejected",
            reasons: [`failure:${result.failure.code}`],
            runtimeTraceVersion: entry.runtimeTraceVersion,
          };
        }
        const result = await runner.run({
          projectId: "census",
          requestId: entry.caseId.replaceAll(/[^a-zA-Z0-9._:-]/g, "-"),
          sceneName: entry.sceneName,
          sourcePath: entry.sourcePath,
        });
        const snapshotCommon = { ...common, profile: entry.profile } as const;
        if (result.status === "verified") {
          return { ...snapshotCommon, outcome: "accepted", reasons: [], snapshotHash: result.snapshot.snapshotHash };
        }
        if (result.status === "unsupported") {
          return {
            ...snapshotCommon,
            outcome: "fallback",
            reasons: result.issues.map(({ code }) => `unsupported:${code}`).sort(),
          };
        }
        if (result.status === "failed") {
          return {
            ...snapshotCommon,
            outcome: "rejected",
            reasons: [
              `failure:${result.failure.code}`,
              ...(result.failure.contractCode ? [`contract:${result.failure.contractCode}`] : []),
            ].sort(),
          };
        }
        return { ...snapshotCommon, outcome: "rejected", reasons: ["failure:source-correlation-stale"] };
      } finally {
        await runner.close();
      }
    });

    const report = buildRealManimCensusReport(manifest, producerDigest, attempts);
    const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as unknown;
    if (process.env.POIETRA_REAL_MANIM_CENSUS_UPDATE === "1") {
      if (process.env.POIETRA_REAL_MANIM_CENSUS_REPLACE_CORPUS !== "1") {
        assertRealManimCensusFloor(report, baseline);
      }
      await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } else {
      assertRealManimCensusFloor(report, baseline);
    }
    expect(report.summary.attempts.total).toBe(cases.length);
    console.info(JSON.stringify(report.summary));
  });
});
