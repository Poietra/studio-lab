import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { LocalProcessFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import {
  digestFastManimSnapshotBundleV1,
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
  fastManimSnapshotEntityIdV1,
  fastManimSnapshotEntityProvenanceIdV1,
  fastManimSnapshotManifestIdV1,
  fastManimSnapshotRunViewV1Schema,
  fastManimSnapshotSceneIdV1,
  fastManimSnapshotSceneProvenanceIdV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";
import {
  FastManimSnapshotAdmissionController,
  FastManimSnapshotPublicationStore,
  FastManimSnapshotRunner,
} from "./fast-manim-snapshot-runner";
import { parseFastManimSnapshotProducerCommand } from "./manim-render-config";
import { ManimSourceStore } from "./manim-source-store";

/**
 * Real integration harness for the upstream fast-manim exporter
 * (Poietra/fast-manim#4). It exercises the exact stdin/stdout producer
 * contract, server-owned sealing, and published-snapshot re-verification the
 * fake producer covers in CI, but against the real exporter binary.
 *
 * Explicitly skipped unless POIETRA_FAST_MANIM_SNAPSHOT_COMMAND points at a
 * real producer. Optional overrides:
 * - POIETRA_FAST_MANIM_SNAPSHOT_PROJECT_ROOT: existing Manim project root
 *   (defaults to a temporary project containing the static Scene below)
 * - POIETRA_FAST_MANIM_SNAPSHOT_SOURCE / POIETRA_FAST_MANIM_SNAPSHOT_SCENE:
 *   source path and Scene name inside that project
 */
const producerCommand = parseFastManimSnapshotProducerCommand(process.env.POIETRA_FAST_MANIM_SNAPSHOT_COMMAND);

// The proven v1 static profile: fill-only Circle and Rectangle (explicit
// zero-width stroke — default-stroked shapes are not advertised as verified)
// plus a stroke-only straight Line. No waits or animations.
const staticSceneSource = `from manim import *

class ExampleScene(Scene):
    def construct(self):
        circle = Circle().set_fill(BLUE, opacity=1).set_stroke(width=0)
        rectangle = Rectangle().set_fill(GREEN, opacity=1).set_stroke(width=0)
        line = Line(LEFT, RIGHT).set_stroke(WHITE, width=4)
        self.add(circle, rectangle, line)
`;

const animatedSceneSource = `from manim import *

class AnimatedScene(Scene):
    def construct(self):
        circle = Circle().set_fill(BLUE, opacity=1).set_stroke(width=0)
        self.add(circle)
        self.wait(1)
`;

const REAL_FRAME = { height: 8, width: 14.222222222222221 } as const;

const temporaryRoots: string[] = [];
const realRunners: FastManimSnapshotRunner[] = [];

afterEach(async () => {
  // Close every runner before removing roots: an unclosed runner would leak
  // its publication owner (and, without the injected stores below, entries in
  // the process-global store), making revision expectations order-sensitive.
  await Promise.all(realRunners.splice(0).map((runner) => runner.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryProject(fileName: string, source: string) {
  const projectRoot = await mkdtemp(join(tmpdir(), "poietra-real-snapshot-"));
  temporaryRoots.push(projectRoot);
  await writeFile(join(projectRoot, fileName), source, "utf8");
  return projectRoot;
}

function createRealRunner(projectRoot: string) {
  if (!producerCommand) throw new Error("Unreachable: the real producer command gate failed.");
  const backend = new LocalProcessFastManimSandboxBackendV1({
    admissionController: new FastManimSnapshotAdmissionController(),
    command: producerCommand,
    projectRoot,
  });
  const runner = new FastManimSnapshotRunner({
    // Fresh per-runner admission and publication state: the real seam must
    // not consume or observe the process-global budgets of other tests.
    backend,
    deployment: "test",
    frame: REAL_FRAME,
    projectId: "default",
    projectRoot,
    publicationStore: new FastManimSnapshotPublicationStore(),
    tenantId: "test-tenant",
    timeoutMs: 120_000,
  });
  realRunners.push(runner);
  return runner;
}

const realSeamEnabled = Boolean(producerCommand) && ManimSourceStore.supportsVerifiedRead;

describe.skipIf(!realSeamEnabled)("real fast-manim snapshot producer integration", () => {
  it("seals the static Circle+Rectangle+Line Scene as verified with a stable snapshot digest", {
    timeout: 300_000,
  }, async () => {
    const configuredRoot = process.env.POIETRA_FAST_MANIM_SNAPSHOT_PROJECT_ROOT?.trim();
    const sourcePath = process.env.POIETRA_FAST_MANIM_SNAPSHOT_SOURCE?.trim() || "scene.py";
    const sceneName = process.env.POIETRA_FAST_MANIM_SNAPSHOT_SCENE?.trim() || "ExampleScene";
    const projectRoot = configuredRoot
      ? resolve(configuredRoot)
      : await temporaryProject(sourcePath, staticSceneSource);
    const runner = createRealRunner(projectRoot);

    const first = fastManimSnapshotRunViewV1Schema.parse(
      await runner.run({ projectId: "default", requestId: "real-snapshot-request-1", sceneName, sourcePath }),
    );
    if (first.status !== "verified") {
      throw new Error(`Expected a verified real snapshot run, got ${JSON.stringify(first)}`);
    }
    expect(first.revision).toBe(1);
    if (first.snapshot.kind !== "compiled") throw new Error("Expected a compiled real snapshot.");
    expect(first.snapshot.snapshotHash).not.toBe(ZERO_SHA256);
    expect(first.snapshot.sceneId).toBe(fastManimSnapshotSceneIdV1(sourcePath, sceneName));
    // Mutual determinism contract: the real exporter recomputes this hash
    // over a config pinning randomSeed to 0 and runs under PYTHONHASHSEED=0;
    // a verified run therefore correlates the pinned seed end to end.
    expect(first.runtimeConfigHash).toBe(
      digestFastManimSnapshotRuntimeConfigV1({
        capabilities: [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1],
        frame: REAL_FRAME,
        randomSeed: 0,
        schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
        snapshotVersion: 1,
        version: 1,
      }),
    );
    const bundle = first.snapshot.bundle as Parameters<typeof digestFastManimSnapshotBundleV1>[0];
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(first.snapshot.snapshotHash);
    // The static fixture's Circle, Rectangle, and Line must actually exist:
    // two fill-only shapes and one stroke-only line.
    expect(bundle.scene.entities).toHaveLength(3);
    const vectorEntities = bundle.scene.entities.filter((entity) => entity.appearance.kind === "vector");
    expect(vectorEntities).toHaveLength(3);
    const filled = vectorEntities.filter(
      (entity) => entity.appearance.kind === "vector" && entity.appearance.fill !== null,
    );
    const stroked = vectorEntities.filter(
      (entity) => entity.appearance.kind === "vector" && entity.appearance.stroke !== null,
    );
    expect(filled).toHaveLength(2);
    expect(stroked).toHaveLength(1);
    // The mutual exporter/server v1 rule emits exact deterministic
    // identifiers: the server refuses anything else, so a verified result
    // must carry the scene record plus one entity record per entity in
    // ascending sceneOrder, each entity referencing its own record.
    expect(bundle.assets.manifestId).toBe(fastManimSnapshotManifestIdV1(first.snapshot.sceneId));
    expect(bundle.scene.provenance.map((record) => record.id)).toEqual([
      fastManimSnapshotSceneProvenanceIdV1(first.snapshot.sceneId),
      ...bundle.scene.entities
        .map((entity) => entity.sceneOrder)
        .sort((left, right) => left - right)
        .map((sceneOrder) => fastManimSnapshotEntityProvenanceIdV1(first.snapshot.sceneId, sceneOrder)),
    ]);
    for (const entity of bundle.scene.entities) {
      expect(entity.id).toBe(fastManimSnapshotEntityIdV1(first.snapshot.sceneId, entity.sceneOrder));
      expect(entity.provenanceId).toBe(
        fastManimSnapshotEntityProvenanceIdV1(first.snapshot.sceneId, entity.sceneOrder),
      );
    }

    const wire = JSON.stringify(first);
    expect(wire).not.toContain(projectRoot);
    expect(wire).not.toContain("def construct");

    // The same immutable input must seal identically on a second run.
    const second = fastManimSnapshotRunViewV1Schema.parse(
      await runner.run({ projectId: "default", requestId: "real-snapshot-request-2", sceneName, sourcePath }),
    );
    if (second.status !== "verified") {
      throw new Error(`Expected the second real snapshot run to verify, got status ${second.status}.`);
    }
    expect(second.revision).toBe(2);
    if (second.snapshot.kind !== "compiled") throw new Error("Expected a compiled second real snapshot.");
    expect(second.snapshot.snapshotHash).toBe(first.snapshot.snapshotHash);

    const fetched = await runner.snapshot({ sceneName, sourcePath });
    expect(fetched.status).toBe("verified");
    if (fetched.status !== "verified") throw new Error("Expected the published real snapshot to re-verify.");
    expect(fetched.revision).toBe(2);
  });

  it("reports an animated Scene as unsupported with server-owned bounded issues", { timeout: 300_000 }, async () => {
    const projectRoot = await temporaryProject("animated.py", animatedSceneSource);
    const runner = createRealRunner(projectRoot);
    const view = fastManimSnapshotRunViewV1Schema.parse(
      await runner.run({
        projectId: "default",
        requestId: "real-snapshot-request-3",
        sceneName: "AnimatedScene",
        sourcePath: "animated.py",
      }),
    );
    expect(view.status).toBe("unsupported");
    if (view.status !== "unsupported") {
      throw new Error(`Expected the animated Scene to be unsupported, got ${JSON.stringify(view)}`);
    }
    expect(view.issues.length).toBeGreaterThan(0);
    for (const issue of view.issues) expect(issue.evidence).toEqual([]);
    expect(view.fallback).toEqual({ kind: "server-authoritative-render" });
  });
});
