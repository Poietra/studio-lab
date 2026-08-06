import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalProcessFastManimSandboxBackendV1 } from "../server/fast-manim-local-process-sandbox-backend";
import { fastManimRuntimeTraceProducerEnvironment } from "../server/fast-manim-runtime-trace-producer-identity";
import { FastManimSnapshotAdmissionController, FastManimSnapshotRunner } from "../server/fast-manim-snapshot-runner";
import { importSourceSnapshot } from "../server/manim-workspace";
import {
  buildRealManimProjectCensusReport,
  loadRealManimProjectCensusManifest,
  type RealManimProjectCensusManifest,
  type RealManimProjectCensusObservation,
} from "./real-manim-project-census";

const execute = promisify(execFile);
const required = process.env.POIETRA_REAL_MANIM_PROJECT_CENSUS_REQUIRED === "1";
const update = process.env.POIETRA_REAL_MANIM_PROJECT_CENSUS_UPDATE === "1";
const manifestPath = new URL("../fixtures/real-manim-census-v2/manifest.json", import.meta.url);
const baselinePath = new URL("../fixtures/real-manim-census-v2/baseline.json", import.meta.url);
const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn4HhvwMADzoDPsGQfWoAAAAASUVORK5CYII=",
  "base64",
);

async function texBinFromEnvironment() {
  const value = process.env.POIETRA_CAIRO_TEX_BIN?.trim();
  if (!value || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error("POIETRA_CAIRO_TEX_BIN must be an absolute normalized path.");
  }
  const [directory, latex] = await Promise.all([stat(value), stat(join(value, "latex"))]);
  if (!directory.isDirectory() || !latex.isFile()) {
    throw new Error("POIETRA_CAIRO_TEX_BIN must contain the latex executable.");
  }
  return value;
}

function rootsFromEnvironment() {
  const value = process.env.POIETRA_REAL_MANIM_PROJECT_CENSUS_ROOTS?.trim();
  if (!value) throw new Error("POIETRA_REAL_MANIM_PROJECT_CENSUS_ROOTS is required.");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Census roots must be an object.");
  return Object.fromEntries(
    Object.entries(parsed).map(([id, path]) => {
      if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
        throw new Error(`${id} census root must be an absolute normalized path.`);
      }
      return [id, path];
    }),
  );
}

async function git(root: string, ...args: string[]) {
  const { stdout } = await execute("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15_000 });
  return stdout.trim();
}

function canonicalRemote(value: string) {
  return value.replace(/^git@github\.com:/, "https://github.com/").replace(/\/$/, "");
}

async function verifyCheckout(
  root: string,
  pin: { repository: string; revision: string; tree: string },
  files: readonly { path: string; sha256: string }[],
) {
  const [remote, revision, tree, status] = await Promise.all([
    git(root, "remote", "get-url", "origin"),
    git(root, "rev-parse", "HEAD"),
    git(root, "rev-parse", "HEAD^{tree}"),
    git(root, "status", "--porcelain"),
  ]);
  if (canonicalRemote(remote) !== canonicalRemote(pin.repository) || revision !== pin.revision || tree !== pin.tree) {
    throw new Error(`${pin.repository} checkout identity drifted.`);
  }
  if (status) throw new Error(`${pin.repository} checkout is dirty.`);
  for (const file of files) {
    const path = join(root, file.path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) throw new Error(`${file.path} is not a bounded file.`);
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (digest !== file.sha256) throw new Error(`${file.path} digest drifted.`);
  }
}

async function observeCodebase(
  manifest: RealManimProjectCensusManifest,
  selected: RealManimProjectCensusManifest["codebases"][number],
  projectRoot: string,
  python: string,
  texBin: string,
): Promise<RealManimProjectCensusObservation> {
  const frame = manifest.execution.frame;
  const source = await readFile(join(projectRoot, selected.source.path), "utf8");
  const imported = importSourceSnapshot(source, selected.source.path, frame).importedScenes.find(
    ({ name }) => name === selected.source.sceneName,
  );
  const snapshotBackend = new LocalProcessFastManimSandboxBackendV1({
    admissionController: new FastManimSnapshotAdmissionController(),
    command: [python, "-m", manifest.producer.snapshotModule],
    projectRoot,
  });
  const snapshotRunner = new FastManimSnapshotRunner({
    backend: snapshotBackend,
    deployment: "test",
    frame,
    pngProvider: { readVerified: async () => ({ bytes: new Uint8Array(pngBytes), versionToken: "census-v2" }) },
    projectId: "census-v2",
    projectRoot,
    snapshotVersion: manifest.producer.snapshotProfile,
    tenantId: "census-v2",
    timeoutMs: 120_000,
  });
  let snapshotProbe: RealManimProjectCensusObservation["snapshotProbe"];
  try {
    const result = await snapshotRunner.run({
      projectId: "census-v2",
      requestId: `census-v2-${selected.id}`,
      sceneName: selected.source.sceneName,
      sourcePath: selected.source.path,
    });
    snapshotProbe =
      result.status === "verified"
        ? ({ artifactDigest: result.snapshot.snapshotHash, outcome: "accepted", reasons: [] } as const)
        : result.status === "unsupported"
          ? ({ outcome: "fallback", reasons: result.issues.map(({ code }) => `unsupported:${code}`).sort() } as const)
          : result.status === "failed"
            ? ({
                outcome: "rejected",
                reasons: [
                  `failure:${result.failure.code}`,
                  ...(result.failure.contractCode ? [`contract:${result.failure.contractCode}`] : []),
                ].sort(),
              } as const)
            : ({ outcome: "rejected", reasons: ["failure:source-correlation-stale"] } as const);
  } finally {
    await snapshotRunner.close();
  }
  const runtimeBackend = new LocalProcessFastManimSandboxBackendV1({
    admissionController: new FastManimSnapshotAdmissionController(),
    command: [python, "-m", manifest.producer.runtimeTraceModule],
    producerEnv: fastManimRuntimeTraceProducerEnvironment(),
    projectRoot,
  });
  const runtimeRunner = new FastManimSnapshotRunner({
    backend: runtimeBackend,
    deployment: "test",
    frame,
    pngProvider: { readVerified: async () => ({ bytes: new Uint8Array(pngBytes), versionToken: "census-v2" }) },
    projectId: "census-v2",
    projectRoot,
    tenantId: "census-v2",
    timeoutMs: 120_000,
  });
  let runtimeTrace: RealManimProjectCensusObservation["runtimeTrace"];
  try {
    const result = await runtimeRunner.runRuntimeTrace({
      projectId: "census-v2",
      requestId: `census-v2-runtime-${selected.id}`,
      sceneName: selected.source.sceneName,
      sourceHash: selected.source.sha256,
      sourcePath: selected.source.path,
    });
    runtimeTrace =
      result.status === "verified"
        ? { artifactDigest: result.traceDigest, outcome: "accepted", reasons: [] }
        : result.failure.code === "unsupported-profile"
          ? { outcome: "fallback", reasons: ["unsupported:unsupported-profile"] }
          : { outcome: "rejected", reasons: [`failure:${result.failure.code}`] };
  } finally {
    await runtimeRunner.close();
  }
  const execution =
    selected.runtimeDependencies === "producer-compatible"
      ? await executeSceneSmoke(
          projectRoot,
          selected.source.path,
          selected.source.sceneName,
          python,
          texBin,
          manifest.execution,
        )
      : ({
          reason:
            selected.runtimeDependencies === "external-locked"
              ? "plugin-runtime-not-installed"
              : "external-dependencies-unpinned",
          status: "blocked",
        } as const);
  return {
    codebaseId: selected.id,
    execution,
    runtimeTrace,
    snapshotProbe,
    staticImport: {
      entityCount: imported ? Object.keys(imported.runtimeSceneState.objectGraph.entities).length : 0,
      sceneRecognized: imported !== undefined,
      unknownCount: imported?.staticSemanticState.unknowns.length ?? 0,
    },
  };
}

async function executeSceneSmoke(
  projectRoot: string,
  sourcePath: string,
  sceneName: string,
  python: string,
  texBin: string,
  config: RealManimProjectCensusManifest["execution"],
) {
  const mediaRoot = await mkdtemp(join(tmpdir(), "poietra-census-v2-render-"));
  try {
    await execute(
      python,
      [
        "-m",
        "manim",
        config.quality === "low_quality" ? "-ql" : config.quality,
        ...(config.saveLastFrame ? ["-s"] : []),
        ...(config.disableCaching ? ["--disable_caching"] : []),
        "--renderer",
        config.renderer,
        "--resolution",
        `${config.pixelWidth},${config.pixelHeight}`,
        "--media_dir",
        mediaRoot,
        join(projectRoot, sourcePath),
        sceneName,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          HOME: mediaRoot,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: `${texBin}:${dirname(python)}:/usr/bin:/bin`,
          PYTHONHASHSEED: "0",
          TMPDIR: mediaRoot,
          XDG_CACHE_HOME: join(mediaRoot, "cache"),
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    const pngs = (await readdir(mediaRoot, { recursive: true })).filter((path) => path.endsWith(".png"));
    if (pngs.length !== 1) throw new Error(`${sceneName} construct smoke must produce exactly one PNG.`);
    const bytes = await readFile(join(mediaRoot, pngs[0]!));
    if (bytes.byteLength < 1 || bytes.byteLength > 16 * 1024 * 1024) {
      throw new Error(`${sceneName} construct smoke PNG is outside its byte budget.`);
    }
    return {
      artifactBytes: bytes.byteLength,
      artifactDigest: createHash("sha256").update(bytes).digest("hex"),
      status: "passed" as const,
    };
  } finally {
    await rm(mediaRoot, { force: true, recursive: true });
  }
}

describe.skipIf(!required)("pinned real Manim project census v2", () => {
  it("reproduces the measured external-project target selection", { timeout: 300_000 }, async () => {
    const manifest = await loadRealManimProjectCensusManifest(manifestPath);
    const roots = rootsFromEnvironment();
    const expectedRoots = ["producer", ...manifest.codebases.map(({ id }) => id)].sort();
    if (JSON.stringify(Object.keys(roots).sort()) !== JSON.stringify(expectedRoots)) {
      throw new Error(`Census roots must contain exactly: ${expectedRoots.join(", ")}.`);
    }
    const producerRoot = roots.producer!;
    await verifyCheckout(producerRoot, manifest.producer, manifest.producer.files);
    const python = join(producerRoot, ".venv", "bin", "python");
    const texBin = await texBinFromEnvironment();
    const { stdout: runtimeVersions } = await execute(
      python,
      ["-c", "import manim, platform; print(platform.python_version()); print(manim.__version__)"],
      {
        encoding: "utf8",
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: `${dirname(python)}:/usr/bin:/bin` },
        timeout: 15_000,
      },
    );
    if (runtimeVersions.trim() !== `${manifest.producer.pythonVersion}\n${manifest.producer.manimVersion}`) {
      throw new Error("Producer runtime versions drifted.");
    }
    const observations = [];
    for (const selected of manifest.codebases) {
      const root = roots[selected.id]!;
      await verifyCheckout(root, selected, [selected.license, ...selected.toolchain, selected.source]);
      observations.push(await observeCodebase(manifest, selected, root, python, texBin));
    }
    const report = buildRealManimProjectCensusReport(manifest, observations);
    if (update) {
      await writeFile(baselinePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } else {
      expect(report).toEqual(JSON.parse(await readFile(baselinePath, "utf8")));
    }
    expect(report.targetSelection.selectedCodebaseId).toBe("math-to-manim");
  });
});
