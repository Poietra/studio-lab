import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { LocalProcessFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import {
  deriveMixedDynamicMathTexV7TransformPlan,
  digestFastManimSnapshotBundleV1,
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V8,
  FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
  FAST_MANIM_SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8,
  fastManimSnapshotEntityIdV1,
  fastManimSnapshotEntityProvenanceIdV1,
  fastManimSnapshotManifestIdV1,
  fastManimSnapshotPngAssetIdV4,
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

const variableWaitSceneSource = `from manim import *

class VariableWaitScene(Scene):
    def construct(self):
        circle = Circle().set_fill(BLUE, opacity=1).set_stroke(width=0)
        self.add(circle)
        self.wait(2.5, frozen_frame=True)
`;

const imageSceneSource = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class ImageScene(Scene):
    def construct(self):
        image = ImageMobject(
            "image.png",
            resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"],
        )
        self.add(image)
`;

const mixedDynamicSceneSource = `from manim import BLUE, YELLOW, Circle, Create, CubicBezier, MathTex, MoveAlongPath, Scene, linear

class MixedMathDemo(Scene):
    def construct(self):
        equation = MathTex(r"E = mc^2")
        ring = (
            Circle(radius=1.2)
            .set_fill(opacity=0)
            .set_stroke(BLUE, width=24)
            .shift([-3, 0, 0])
        )
        particle = (
            Circle(radius=0.2)
            .set_fill(YELLOW, opacity=1)
            .set_stroke(width=0)
            .move_to([1, -1, 0])
        )
        path = CubicBezier([1, -1, 0], [2, 2, 0], [3, -2, 0], [4, 1, 0])

        equation.move_to((0.5, -0.25, 0))
        equation.scale(1.05)
        self.add(equation)
        self.play(Create(ring, rate_func=linear), run_time=1)
        self.play(MoveAlongPath(particle, path, rate_func=linear), run_time=2)
        self.wait(1, frozen_frame=True)
`;

const imagePngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn4HhvwMADzoDPsGQfWoAAAAASUVORK5CYII=",
  "base64",
);

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

function createRealRunner(
  projectRoot: string,
  snapshotVersion: 1 | 2 | 4 | 7 | 8 = 1,
  pngProvider?: Readonly<{ readVerified: () => Promise<{ bytes: Uint8Array; versionToken: string }> }>,
  publicationStore = new FastManimSnapshotPublicationStore(),
) {
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
    ...(pngProvider === undefined ? {} : { pngProvider }),
    publicationStore,
    snapshotVersion,
    tenantId: "test-tenant",
    timeoutMs: 120_000,
  });
  realRunners.push(runner);
  return runner;
}

const realSeamEnabled = Boolean(producerCommand) && ManimSourceStore.supportsVerifiedRead;
const officialV8ProjectRoot = process.env.POIETRA_FAST_MANIM_V8_PROJECT_ROOT?.trim();
const officialV8SeamEnabled = realSeamEnabled && Boolean(officialV8ProjectRoot);

describe.skipIf(!officialV8SeamEnabled)("real fast-manim SquareToCircle V8 integration", () => {
  it("accepts the merged producer against its exact official example_scenes/basic.py", {
    timeout: 300_000,
  }, async () => {
    const projectRoot = resolve(officialV8ProjectRoot!);
    const sourcePath = "example_scenes/basic.py";
    const sourceText = await readFile(join(projectRoot, sourcePath), "utf8");
    expect(createHash("sha256").update(sourceText, "utf8").digest("hex")).toBe(
      FAST_MANIM_SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8,
    );

    const runner = createRealRunner(projectRoot, 8);
    const view = fastManimSnapshotRunViewV1Schema.parse(
      await runner.run({
        projectId: "default",
        requestId: "real-snapshot-request-v8-official",
        sceneName: "SquareToCircle",
        sourcePath,
      }),
    );
    if (view.status !== "verified" || view.snapshot.kind !== "compiled") {
      throw new Error(`Expected a verified official V8 snapshot, got ${JSON.stringify(view)}`);
    }
    expect(view.snapshot.sourceHash).toBe(FAST_MANIM_SQUARE_TO_CIRCLE_OFFICIAL_SOURCE_SHA256_V8);
    expect(view.runtimeConfigHash).toBe(
      digestFastManimSnapshotRuntimeConfigV1({
        capabilities: [...FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V8],
        frame: REAL_FRAME,
        randomSeed: 0,
        schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
        snapshotVersion: 8,
        version: 1,
      }),
    );
    const bundle = view.snapshot.bundle as Parameters<typeof digestFastManimSnapshotBundleV1>[0];
    expect(bundle.scene).toMatchObject({
      duration: 3,
      source: { kind: "imported-manim-server-snapshot", snapshotVersion: 8 },
    });
    expect(view.sourceRuntimeIdentity?.mappings).toHaveLength(1);
    expect(view.sourceRuntimeIdentity?.mappings[0]).toMatchObject({
      binding: { name: "square", ordinal: 2 },
      familyPath: [],
    });

    const fetched = await runner.snapshot({ sceneName: "SquareToCircle", sourcePath });
    expect(fetched.status).toBe("verified");
    if (fetched.status === "verified") {
      expect(fetched.snapshot).toEqual(view.snapshot);
      expect(fetched.sourceRuntimeIdentity).toEqual(view.sourceRuntimeIdentity);
    }
  });
});

describe.skipIf(!realSeamEnabled)("real fast-manim snapshot producer integration", () => {
  it("seals and republishes the real V7 mixed MathTex/Create/MoveAlongPath Scene with complete identity", {
    timeout: 300_000,
  }, async () => {
    const sourcePath = "mixed-dynamic.py";
    const sceneName = "MixedMathDemo";
    const projectRoot = await temporaryProject(sourcePath, mixedDynamicSceneSource);
    const publicationStore = new FastManimSnapshotPublicationStore();
    const runner = createRealRunner(projectRoot, 7, undefined, publicationStore);
    const view = fastManimSnapshotRunViewV1Schema.parse(
      await runner.run({
        projectId: "default",
        requestId: "real-snapshot-request-v7",
        sceneName,
        sourcePath,
      }),
    );
    if (view.status !== "verified" || view.snapshot.kind !== "compiled") {
      throw new Error(`Expected a verified V7 mixed snapshot, got ${JSON.stringify(view)}`);
    }

    const bundle = view.snapshot.bundle as Parameters<typeof digestFastManimSnapshotBundleV1>[0];
    expect(bundle.scene).toMatchObject({
      duration: 4,
      requiredCapabilities: ["cubic-path-geometry", "motion-path-animation", "path-trim-animation"],
      source: { kind: "imported-manim-server-snapshot", snapshotVersion: 7 },
    });
    expect(bundle.scene.entities).toHaveLength(3);
    expect(bundle.scene.animationChannels).toHaveLength(2);
    const equation = bundle.scene.entities[0];
    if (!equation || equation.geometry.kind !== "cubic-path") throw new Error("Expected the real V7 MathTex outline.");
    const equationAnchors = equation.geometry.path.subpaths.flatMap((subpath) => [
      subpath.start,
      ...subpath.segments.map(({ end }) => end),
    ]);
    const localCenter = {
      x: (Math.min(...equationAnchors.map(({ x }) => x)) + Math.max(...equationAnchors.map(({ x }) => x))) / 2,
      y: (Math.min(...equationAnchors.map(({ y }) => y)) + Math.max(...equationAnchors.map(({ y }) => y))) / 2,
    };
    expect(equation.transform.m11).toBeCloseTo(1.05, 12);
    expect(equation.transform.m22).toBeCloseTo(1.05, 12);
    expect(equation.transform.m11 * localCenter.x + equation.transform.tx).toBeCloseTo(0.5, 12);
    expect(equation.transform.m22 * localCenter.y + equation.transform.ty).toBeCloseTo(-0.25, 12);
    expect(bundle.scene.animationChannels[0]).toMatchObject({
      entityId: `${view.snapshot.sceneId}/entity:1`,
      keyframes: [
        { at: 0, value: 0 },
        { at: 1, value: 1 },
      ],
      kind: "path-trim",
    });
    expect(bundle.scene.animationChannels[1]).toMatchObject({
      entityId: `${view.snapshot.sceneId}/entity:2`,
      keyframes: [{ at: 1 }, { at: 3 }],
      kind: "motion-path",
    });
    expect(
      view.sourceRuntimeIdentity?.mappings.map(({ binding, entityId }) => ({ entityId, name: binding.name })),
    ).toEqual([
      { entityId: `${view.snapshot.sceneId}/entity:0`, name: "equation" },
      { entityId: `${view.snapshot.sceneId}/entity:1`, name: "ring" },
      { entityId: `${view.snapshot.sceneId}/entity:2`, name: "particle" },
    ]);
    expect(view.sourceRuntimeIdentity?.mappings.some(({ binding }) => binding.name === "path")).toBe(false);
    expect(publicationStore.entriesOf(1)[0]?.[1].expected.hermeticMathTexV3Plan).toEqual(
      deriveMixedDynamicMathTexV7TransformPlan(mixedDynamicSceneSource, sceneName),
    );

    const fetched = await runner.snapshot({ sceneName, sourcePath });
    expect(fetched.status).toBe("verified");
    if (fetched.status !== "verified") throw new Error("Expected the published V7 snapshot to re-verify.");
    expect(fetched.sourceRuntimeIdentity).toEqual(view.sourceRuntimeIdentity);
  });

  it("seals one real ImageMobject against the exact PNG bytes sent to its private sandbox", {
    timeout: 300_000,
  }, async () => {
    const projectRoot = await temporaryProject("image-scene.py", imageSceneSource);
    const runner = createRealRunner(projectRoot, 4, {
      readVerified: async () => ({ bytes: imagePngBytes, versionToken: "generation:1" }),
    });
    const view = fastManimSnapshotRunViewV1Schema.parse(
      await runner.run({
        projectId: "default",
        requestId: "real-snapshot-request-v4",
        sceneName: "ImageScene",
        sourcePath: "image-scene.py",
      }),
    );
    if (view.status !== "verified" || view.snapshot.kind !== "compiled") {
      throw new Error(`Expected a verified V4 image snapshot, got ${JSON.stringify(view)}`);
    }
    const bundle = view.snapshot.bundle as Parameters<typeof digestFastManimSnapshotBundleV1>[0];
    const sceneId = fastManimSnapshotSceneIdV1("image-scene.py", "ImageScene");
    const digest = createHash("sha256").update(imagePngBytes).digest("hex");
    expect(bundle.assets.assets).toEqual([
      {
        alphaMode: "straight",
        byteLength: imagePngBytes.byteLength,
        colorSpace: "srgb",
        id: fastManimSnapshotPngAssetIdV4(sceneId),
        kind: "png-image",
        mediaType: "image/png",
        pixelHeight: 1,
        pixelWidth: 2,
        sha256: digest,
      },
    ]);
    expect(bundle.scene.requiredCapabilities).toEqual(["png-image"]);
    expect(bundle.scene.entities).toHaveLength(1);
    expect(bundle.scene.entities[0]).toMatchObject({
      appearance: { kind: "image", opacity: 1 },
      geometry: {
        asset: { assetId: fastManimSnapshotPngAssetIdV4(sceneId), sha256: digest },
        kind: "image",
        sampler: "nearest",
      },
    });
    const wire = JSON.stringify(view);
    expect(wire).not.toContain(projectRoot);
    expect(wire).not.toContain("image.png");
  });

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

  it("seals the upstream V2 frozen-wait duration and full entity lifetime", { timeout: 300_000 }, async () => {
    const projectRoot = await temporaryProject("variable-wait.py", variableWaitSceneSource);
    const runner = createRealRunner(projectRoot, 2);
    const view = fastManimSnapshotRunViewV1Schema.parse(
      await runner.run({
        projectId: "default",
        requestId: "real-snapshot-request-v2",
        sceneName: "VariableWaitScene",
        sourcePath: "variable-wait.py",
      }),
    );
    if (view.status !== "verified" || view.snapshot.kind !== "compiled") {
      throw new Error(`Expected a verified V2 snapshot, got ${JSON.stringify(view)}`);
    }
    const bundle = view.snapshot.bundle as Parameters<typeof digestFastManimSnapshotBundleV1>[0];
    expect(bundle.scene.duration).toBe(2.5);
    expect(bundle.scene.entities.every((entity) => entity.lifetimes[0]?.end === 2.5)).toBe(true);
    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-server-snapshot",
      snapshotVersion: 2,
    });
  });
});
