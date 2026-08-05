import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DurableFastManimSnapshotRunnerFactoryV1,
  DurableFastManimSnapshotServiceV1,
} from "./durable-fast-manim-snapshot-service";
import {
  deriveHermeticMathTexMorphV5Plan,
  deriveHermeticMathTexV3TransformPlan,
  deriveHermeticPngV4TransformPlan,
  deriveMixedDynamicMathTexV7TransformPlan,
  deriveWarpSquareV9TransformPlan,
  deriveWriteStuffV12TransformPlan,
  type ExpectedFastManimSnapshotCorrelationV1,
  type FastManimSnapshotRunViewV1,
  type VerifiedCompiledFastManimSnapshotResultV1,
} from "./fast-manim-snapshot-contract";
import type { FastManimSnapshotRunner, FastManimUnpublishedSnapshotRunViewV1 } from "./fast-manim-snapshot-runner";
import { DurableFastManimSnapshotSourceProviderV1 } from "./fast-manim-snapshot-source-provider";
import { HttpError } from "./http/json";
import type { SnapshotArtifactPublisherV1 } from "./storage/snapshot-artifact-publisher";
import type { SnapshotArtifactReceiptV1, SnapshotPublicationV1 } from "./storage/snapshot-publication-repository";
import type {
  SourceContentBlobStoreV1,
  WorkspaceSourceHeadV1,
  WorkspaceSourceRepositoryV1,
} from "./storage/workspace-source-repository";

const TENANT = "tenant-a";
const PROJECT = "workspace-a";
const SOURCE_PATH = "examples/scene.py";
const SCENE_NAME = "ExampleScene";
const SOURCE_DIGEST = "a".repeat(64);
const RUNTIME_DIGEST = "b".repeat(64);
const PROFILE_DIGEST = "c".repeat(64);
const RESULT_DIGEST = "d".repeat(64);
const SNAPSHOT_DIGEST = "e".repeat(64);
const RELEASE_RUNTIME_DIGEST = "f".repeat(64);
const V9_RUNTIME_CONFIG_HASH = "a2a789613c64b68c4b9b0c3542975b334b3b03388b7c8b0b903f690cca69c38a";
const V12_RUNTIME_CONFIG_HASH = "2022ea1ccebb06668fc92386455c4d4928305e72a5a5459d103e3d86261a4593";
const PUBLISHED_AT = new Date("2026-07-28T01:02:03.000Z");
const request = {
  projectId: PROJECT,
  requestId: "snapshot-request-a",
  sceneName: SCENE_NAME,
  sourcePath: SOURCE_PATH,
} as const;
const TRANSFORMED_PNG_SOURCE = `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class ExampleScene(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
        image.move_to((1.25, -0.75, 0))
        image.scale(1.5)
        self.wait(1)
`;
const TRANSFORMED_PNG_SOURCE_DIGEST = createHash("sha256").update(TRANSFORMED_PNG_SOURCE, "utf8").digest("hex");
const TRANSFORMED_MATHTEX_SOURCE = `from manim import MathTex, Scene

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        equation.move_to((1.25, -0.75, 0))
        equation.scale(1.5)
        self.wait(1)
`;
const TRANSFORMED_MATHTEX_SOURCE_DIGEST = createHash("sha256").update(TRANSFORMED_MATHTEX_SOURCE, "utf8").digest("hex");
const TRANSFORMED_MATHTEX_SOURCE_V7 = `from manim import Circle, Create, CubicBezier, MathTex, MoveAlongPath, Scene

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        ring = Circle()
        particle = Circle()
        path = CubicBezier((0, 0, 0), (1, 1, 0), (2, 1, 0), (3, 0, 0))
        equation.move_to((1.25, -0.75, 0))
        equation.scale(1.5)
        self.add(equation)
        self.play(Create(ring), run_time=1)
        self.play(MoveAlongPath(particle, path), run_time=2)
        self.wait(1)
`;
const TRANSFORMED_MATHTEX_SOURCE_DIGEST_V7 = createHash("sha256")
  .update(TRANSFORMED_MATHTEX_SOURCE_V7, "utf8")
  .digest("hex");
const MATHTEX_MORPH_SOURCE_V5 = String.raw`from manim import MathTex, Scene, TransformMatchingTex, smoothstep

class ExampleScene(Scene):
    def construct(self):
        equation = MathTex("E = mc^2")
        self.add(equation)
        self.wait(1, frozen_frame=True)
        maxwell = MathTex(r"\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}")
        maxwell.move_to(equation.get_center())
        self.play(TransformMatchingTex(equation, maxwell, transform_mismatches=True), run_time=1, rate_func=smoothstep)
        equation = maxwell
        self.wait(0.5, frozen_frame=True)
        restored = MathTex("E = mc^2")
        restored.move_to(maxwell.get_center())
        self.play(TransformMatchingTex(maxwell, restored, transform_mismatches=True), run_time=2, rate_func=smoothstep)
        maxwell = restored
        equation = restored
        self.wait(1, frozen_frame=True)
`;
const MATHTEX_MORPH_SOURCE_DIGEST_V5 = createHash("sha256").update(MATHTEX_MORPH_SOURCE_V5, "utf8").digest("hex");

function sourceHead(generation = 7n, digest = SOURCE_DIGEST): WorkspaceSourceHeadV1 {
  return {
    blob: {
      byteSize: 128,
      digest,
      etag: "source-etag",
      objectKey: `tenants/${TENANT}/sources/${digest}`,
      versionId: `source-version-${generation}`,
    },
    generation,
    projectId: PROJECT,
    sourcePath: SOURCE_PATH,
    tenantId: TENANT,
  };
}

const compiledSnapshot = {
  bundle: {
    scene: {
      camera: { view: { frameHeight: 8, frameWidth: 14.222222222222221 } },
      sceneId: `scene:${"1".repeat(64)}`,
      source: { kind: "imported-manim-server-snapshot", snapshotVersion: 1, sourceHash: SOURCE_DIGEST },
    },
  },
  kind: "compiled",
  snapshotHash: SNAPSHOT_DIGEST,
  sourceHash: SOURCE_DIGEST,
} as unknown as VerifiedCompiledFastManimSnapshotResultV1;

const verifiedView = {
  projectId: PROJECT,
  requestId: request.requestId,
  runtimeConfigHash: RUNTIME_DIGEST,
  sceneName: SCENE_NAME,
  schema: "poietra.fast-manim-snapshot-run",
  snapshot: compiledSnapshot,
  sourcePath: SOURCE_PATH,
  status: "verified",
  version: 1,
} as const satisfies FastManimUnpublishedSnapshotRunViewV1;

function v9VerifiedView(sourceHash: string) {
  return {
    ...verifiedView,
    runtimeConfigHash: V9_RUNTIME_CONFIG_HASH,
    sceneName: "WarpSquare",
    snapshot: {
      ...compiledSnapshot,
      bundle: {
        ...compiledSnapshot.bundle,
        scene: {
          ...compiledSnapshot.bundle.scene,
          source: { ...compiledSnapshot.bundle.scene.source, snapshotVersion: 9, sourceHash },
        },
      },
      sourceHash,
    } as unknown as VerifiedCompiledFastManimSnapshotResultV1,
    sourcePath: "example_scenes/basic.py",
  } satisfies FastManimUnpublishedSnapshotRunViewV1;
}

function v12VerifiedView(sourceHash: string) {
  return {
    ...verifiedView,
    runtimeConfigHash: V12_RUNTIME_CONFIG_HASH,
    sceneName: "WriteStuff",
    snapshot: {
      ...compiledSnapshot,
      bundle: {
        ...compiledSnapshot.bundle,
        scene: {
          ...compiledSnapshot.bundle.scene,
          source: { ...compiledSnapshot.bundle.scene.source, snapshotVersion: 12, sourceHash },
        },
      },
      sourceHash,
    } as unknown as VerifiedCompiledFastManimSnapshotResultV1,
    sourcePath: "example_scenes/basic.py",
  } satisfies FastManimUnpublishedSnapshotRunViewV1;
}

const artifact = {
  byteSize: 256,
  etag: "snapshot-etag",
  objectKey: `tenants/${TENANT}/snapshots/${RESULT_DIGEST}`,
  profileDigest: PROFILE_DIGEST,
  resultDigest: RESULT_DIGEST,
  runtimeConfigHash: RUNTIME_DIGEST,
  runtimeDigest: RELEASE_RUNTIME_DIGEST,
  sourceDigest: SOURCE_DIGEST,
  versionId: "snapshot-version-a",
} satisfies SnapshotArtifactReceiptV1;

function publication(generation = 12n): SnapshotPublicationV1 {
  return {
    artifact,
    generation,
    projectId: PROJECT,
    publicationId: "018f57e2-4c8b-4d31-a91e-4ae5e5c6c8a1",
    publishedAt: PUBLISHED_AT,
    requestId: request.requestId,
    runtimeConfigHash: RUNTIME_DIGEST,
    runtimeDigest: RELEASE_RUNTIME_DIGEST,
    sceneName: SCENE_NAME,
    snapshotHash: SNAPSHOT_DIGEST,
    sourceGeneration: 7n,
    sourcePath: SOURCE_PATH,
    tenantId: TENANT,
  };
}

function expected(): ExpectedFastManimSnapshotCorrelationV1 {
  return {
    frame: { height: 8, width: 14.222222222222221 },
    projectId: PROJECT,
    requestId: request.requestId,
    runtimeConfigHash: RUNTIME_DIGEST,
    snapshotVersion: 1,
    sceneId: compiledSnapshot.bundle.scene.sceneId,
    sceneName: SCENE_NAME,
    sourceHash: SOURCE_DIGEST,
    sourcePath: SOURCE_PATH,
  };
}

function transformedPngV4View() {
  const snapshot = {
    ...compiledSnapshot,
    bundle: {
      ...compiledSnapshot.bundle,
      scene: {
        ...compiledSnapshot.bundle.scene,
        source: {
          ...compiledSnapshot.bundle.scene.source,
          snapshotVersion: 4,
          sourceHash: TRANSFORMED_PNG_SOURCE_DIGEST,
        },
      },
    },
    sourceHash: TRANSFORMED_PNG_SOURCE_DIGEST,
  } as unknown as VerifiedCompiledFastManimSnapshotResultV1;
  return { ...verifiedView, snapshot } satisfies FastManimUnpublishedSnapshotRunViewV1;
}

function transformedPngSourceHead() {
  const head = sourceHead(7n, TRANSFORMED_PNG_SOURCE_DIGEST);
  return {
    ...head,
    blob: { ...head.blob, byteSize: Buffer.byteLength(TRANSFORMED_PNG_SOURCE, "utf8") },
  };
}

function transformedMathTexV3View() {
  const snapshot = {
    ...compiledSnapshot,
    bundle: {
      ...compiledSnapshot.bundle,
      scene: {
        ...compiledSnapshot.bundle.scene,
        source: {
          ...compiledSnapshot.bundle.scene.source,
          snapshotVersion: 3,
          sourceHash: TRANSFORMED_MATHTEX_SOURCE_DIGEST,
        },
      },
    },
    sourceHash: TRANSFORMED_MATHTEX_SOURCE_DIGEST,
  } as unknown as VerifiedCompiledFastManimSnapshotResultV1;
  return { ...verifiedView, snapshot } satisfies FastManimUnpublishedSnapshotRunViewV1;
}

function transformedMathTexSourceHead() {
  const head = sourceHead(7n, TRANSFORMED_MATHTEX_SOURCE_DIGEST);
  return {
    ...head,
    blob: { ...head.blob, byteSize: Buffer.byteLength(TRANSFORMED_MATHTEX_SOURCE, "utf8") },
  };
}

function transformedMathTexV7View() {
  const snapshot = {
    ...compiledSnapshot,
    bundle: {
      ...compiledSnapshot.bundle,
      scene: {
        ...compiledSnapshot.bundle.scene,
        source: {
          ...compiledSnapshot.bundle.scene.source,
          snapshotVersion: 7,
          sourceHash: TRANSFORMED_MATHTEX_SOURCE_DIGEST_V7,
        },
      },
    },
    sourceHash: TRANSFORMED_MATHTEX_SOURCE_DIGEST_V7,
  } as unknown as VerifiedCompiledFastManimSnapshotResultV1;
  return { ...verifiedView, snapshot } satisfies FastManimUnpublishedSnapshotRunViewV1;
}

function transformedMathTexSourceHeadV7() {
  const head = sourceHead(7n, TRANSFORMED_MATHTEX_SOURCE_DIGEST_V7);
  return {
    ...head,
    blob: { ...head.blob, byteSize: Buffer.byteLength(TRANSFORMED_MATHTEX_SOURCE_V7, "utf8") },
  };
}

function mathTexMorphV5View(sourceDigest = MATHTEX_MORPH_SOURCE_DIGEST_V5) {
  const snapshot = {
    ...compiledSnapshot,
    bundle: {
      ...compiledSnapshot.bundle,
      scene: {
        ...compiledSnapshot.bundle.scene,
        source: { ...compiledSnapshot.bundle.scene.source, snapshotVersion: 5, sourceHash: sourceDigest },
      },
    },
    sourceHash: sourceDigest,
  } as unknown as VerifiedCompiledFastManimSnapshotResultV1;
  return { ...verifiedView, snapshot } satisfies FastManimUnpublishedSnapshotRunViewV1;
}

function mathTexMorphSourceHeadV5(source: string) {
  const digest = createHash("sha256").update(source, "utf8").digest("hex");
  const head = sourceHead(7n, digest);
  return { ...head, blob: { ...head.blob, byteSize: Buffer.byteLength(source, "utf8") } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function harness(
  runView: FastManimUnpublishedSnapshotRunViewV1 = verifiedView,
  runtimeDigest = RELEASE_RUNTIME_DIGEST,
  runtimeConfigHash: string | null = RUNTIME_DIGEST,
) {
  const runnerClose = vi.fn(async () => undefined);
  const runnerRun = vi.fn<FastManimSnapshotRunner["runUnpublished"]>(async () => runView);
  const runnerRunCandidate = vi.fn<FastManimSnapshotRunner["runCandidateUnpublished"]>(async () => runView);
  const runner = {
    close: runnerClose,
    runCandidateUnpublished: runnerRunCandidate,
    runUnpublished: runnerRun,
  } as unknown as FastManimSnapshotRunner;
  const create = vi.fn<DurableFastManimSnapshotRunnerFactoryV1["create"]>(async () => ({
    profileDigest: PROFILE_DIGEST,
    runner,
    runtimeConfigHash,
    runtimeDigest,
  }));
  const factory = {
    close: vi.fn(async () => undefined),
    create,
    ready: vi.fn(async () => true),
    runtimeConfigHash,
    runtimeDigest,
  } satisfies DurableFastManimSnapshotRunnerFactoryV1;
  const readSourceHead = vi.fn<WorkspaceSourceRepositoryV1["readSourceHead"]>(async () => sourceHead());
  const sourceRepository = {
    close: vi.fn(async () => undefined),
    readSourceHead,
  } as unknown as WorkspaceSourceRepositoryV1;
  const readSource = vi.fn<SourceContentBlobStoreV1["readSource"]>(async () => "from manim import *");
  const blobs = {
    close: vi.fn(async () => undefined),
    readSource,
  } as unknown as SourceContentBlobStoreV1;
  const publish = vi.fn<SnapshotArtifactPublisherV1["publish"]>(async () => ({
    kind: "published" as const,
    publication: publication(),
  }));
  const readCurrent = vi.fn<SnapshotArtifactPublisherV1["readCurrent"]>(async () => ({ kind: "missing" as const }));
  const softDeleteProject = vi.fn<SnapshotArtifactPublisherV1["softDeleteProject"]>(async () => undefined);
  const publisher = {
    close: vi.fn(async () => undefined),
    publish,
    readCurrent,
    ready: vi.fn(async () => true),
    softDeleteProject,
  } as unknown as SnapshotArtifactPublisherV1;
  const service = new DurableFastManimSnapshotServiceV1({
    blobs,
    factory,
    publicationIdFactory: () => "018f57e2-4c8b-4d31-a91e-4ae5e5c6c8a1",
    publisher,
    sourceRepository,
    tenantId: TENANT,
  });
  return {
    blobs,
    factory,
    publish,
    publisher,
    readCurrent,
    readSource,
    readSourceHead,
    runner,
    runnerClose,
    runnerRun,
    runnerRunCandidate,
    service,
    softDeleteProject,
    sourceRepository,
  };
}

describe("DurableFastManimSnapshotServiceV1", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["not-a-digest", "0".repeat(64)])(
    "rejects an invalid or legacy active runtime identity before taking ownership",
    (runtimeDigest) => {
      expect(() => harness(verifiedView, runtimeDigest)).toThrow(/factory runtime digest is invalid/i);
    },
  );

  it("rejects an invalid active runtime configuration before taking ownership", () => {
    expect(() => harness(verifiedView, RELEASE_RUNTIME_DIGEST, "not-a-digest")).toThrow(
      /factory runtime-config hash is invalid/i,
    );
  });

  it("lazily shares one project runner and returns the committed durable revision", async () => {
    const fixture = harness();

    const [first, second] = await Promise.all([fixture.service.run(request), fixture.service.run(request)]);

    expect(fixture.factory.create).toHaveBeenCalledTimes(1);
    expect(fixture.factory.create.mock.calls[0]?.[0]).toMatchObject({ projectId: PROJECT });
    expect(fixture.factory.create.mock.calls[0]?.[0].sourceProvider).toBeInstanceOf(
      DurableFastManimSnapshotSourceProviderV1,
    );
    expect(first).toMatchObject({ publishedAt: PUBLISHED_AT.toISOString(), revision: 12, status: "verified" });
    expect(second).toMatchObject({ publishedAt: PUBLISHED_AT.toISOString(), revision: 12, status: "verified" });
    expect(fixture.publish).toHaveBeenCalledTimes(2);
    expect(fixture.publish.mock.calls[0]?.[0]).toMatchObject({
      expected: expected(),
      expectedSourceGeneration: 7n,
      profileDigest: PROFILE_DIGEST,
      runtimeConfigHash: RUNTIME_DIGEST,
      runtimeDigest: RELEASE_RUNTIME_DIGEST,
    });
  });

  it("verifies immutable candidate bytes without source reads or publication", async () => {
    const fixture = harness();
    const candidateSource = "from manim import Scene\n";

    await expect(fixture.service.runCandidateUnpublished(candidateSource, request)).resolves.toBe(verifiedView);

    expect(fixture.factory.create).toHaveBeenCalledOnce();
    expect(fixture.runnerRunCandidate).toHaveBeenCalledWith(candidateSource, request, undefined);
    expect(fixture.runnerRun).not.toHaveBeenCalled();
    expect(fixture.readSourceHead).not.toHaveBeenCalled();
    expect(fixture.readSource).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("does not allocate a candidate runner after an early abort", async () => {
    const fixture = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      fixture.service.runCandidateUnpublished("from manim import Scene\n", request, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fixture.factory.create).not.toHaveBeenCalled();
    expect(fixture.runnerRunCandidate).not.toHaveBeenCalled();
    expect(fixture.readSourceHead).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("publishes an automatically selected concrete runtime identity and requires it for durable lookup", async () => {
    const fixture = harness(verifiedView, RELEASE_RUNTIME_DIGEST, null);

    await expect(fixture.service.run(request)).resolves.toMatchObject({ status: "verified" });
    expect(fixture.publish).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeConfigHash: verifiedView.runtimeConfigHash }),
      undefined,
    );
    await expect(
      fixture.service.snapshot(PROJECT, { sceneName: SCENE_NAME, sourcePath: SOURCE_PATH }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      fixture.service.snapshot(PROJECT, {
        runtimeConfigHash: verifiedView.runtimeConfigHash,
        sceneName: SCENE_NAME,
        sourcePath: SOURCE_PATH,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fixture.readCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeConfigHash: verifiedView.runtimeConfigHash }),
      undefined,
    );
  });

  it("retains the server-derived edited V9 plan at the durable publication boundary", async () => {
    const official = await readFile(
      new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
      "utf8",
    );
    const anchor = "class WarpSquare(Scene):\n    def construct(self):\n        square = Square()\n";
    const source = official.replace(
      anchor,
      `${anchor}        square.move_to((1.25, -0.5, 0))\n        square.scale(1.5)\n`,
    );
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
    const view = v9VerifiedView(sourceHash);
    const fixture = harness(view, RELEASE_RUNTIME_DIGEST, V9_RUNTIME_CONFIG_HASH);
    const head = {
      ...sourceHead(7n, sourceHash),
      blob: { ...sourceHead(7n, sourceHash).blob, byteSize: Buffer.byteLength(source, "utf8") },
      sourcePath: "example_scenes/basic.py",
    };
    fixture.readSourceHead.mockResolvedValue(head);
    fixture.readSource.mockResolvedValue(source);
    const v9Request = {
      ...request,
      sceneName: "WarpSquare",
      sourcePath: "example_scenes/basic.py",
    };

    await expect(fixture.service.run(v9Request)).resolves.toMatchObject({ status: "verified" });

    expect(fixture.publish).toHaveBeenCalledOnce();
    expect(fixture.publish.mock.calls[0]?.[0]).toMatchObject({
      expected: {
        runtimeConfigHash: V9_RUNTIME_CONFIG_HASH,
        snapshotVersion: 9,
        warpSquareV9Plan: deriveWarpSquareV9TransformPlan(source, "WarpSquare"),
      },
      runtimeConfigHash: V9_RUNTIME_CONFIG_HASH,
      snapshot: view.snapshot,
    });

    await expect(
      fixture.service.snapshot(PROJECT, { sceneName: "WarpSquare", sourcePath: "example_scenes/basic.py" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fixture.readCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeConfigHash: V9_RUNTIME_CONFIG_HASH }),
      undefined,
    );
  });

  it("retains the server-derived edited V12 plan at the durable publication boundary", async () => {
    const official = await readFile(
      new URL("../fixtures/real-preview-harness/example_scenes/basic.py", import.meta.url),
      "utf8",
    );
    const anchor = '        group.width = config["frame_width"] - 2 * LARGE_BUFF\n';
    const source = official.replace(
      anchor,
      `${anchor}        example_tex.move_to((1.25, -0.5, 0))\n        example_tex.scale(0.5)\n`,
    );
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
    const view = v12VerifiedView(sourceHash);
    const fixture = harness(view, RELEASE_RUNTIME_DIGEST, V12_RUNTIME_CONFIG_HASH);
    const head = {
      ...sourceHead(7n, sourceHash),
      blob: { ...sourceHead(7n, sourceHash).blob, byteSize: Buffer.byteLength(source, "utf8") },
      sourcePath: "example_scenes/basic.py",
    };
    fixture.readSourceHead.mockResolvedValue(head);
    fixture.readSource.mockResolvedValue(source);
    const v12Request = {
      ...request,
      sceneName: "WriteStuff",
      sourcePath: "example_scenes/basic.py",
    };

    await expect(fixture.service.run(v12Request)).resolves.toMatchObject({ status: "verified" });

    expect(fixture.publish).toHaveBeenCalledOnce();
    expect(fixture.publish.mock.calls[0]?.[0]).toMatchObject({
      expected: {
        runtimeConfigHash: V12_RUNTIME_CONFIG_HASH,
        snapshotVersion: 12,
        writeStuffV12Plan: deriveWriteStuffV12TransformPlan(source, "WriteStuff"),
      },
      runtimeConfigHash: V12_RUNTIME_CONFIG_HASH,
      snapshot: view.snapshot,
    });
  });

  it("retains the server-derived V4 image transform plan for durable publication", async () => {
    const fixture = harness(transformedPngV4View());
    const head = transformedPngSourceHead();
    fixture.readSourceHead.mockResolvedValue(head);
    fixture.readSource.mockResolvedValue(TRANSFORMED_PNG_SOURCE);

    await expect(fixture.service.run(request)).resolves.toMatchObject({ status: "verified" });

    expect(fixture.readSource).toHaveBeenCalledWith(TENANT, head.blob, undefined);
    const published = fixture.publish.mock.calls[0]?.[0];
    if (!published) throw new Error("Expected one durable V4 publication.");
    expect(published.expected.hermeticPngV4Plan).toEqual(
      deriveHermeticPngV4TransformPlan(TRANSFORMED_PNG_SOURCE, SCENE_NAME),
    );
  });

  it("retains the server-derived V3 MathTex transform plan for durable publication", async () => {
    const fixture = harness(transformedMathTexV3View());
    const head = transformedMathTexSourceHead();
    fixture.readSourceHead.mockResolvedValue(head);
    fixture.readSource.mockResolvedValue(TRANSFORMED_MATHTEX_SOURCE);

    await expect(fixture.service.run(request)).resolves.toMatchObject({ status: "verified" });

    expect(fixture.readSource).toHaveBeenCalledWith(TENANT, head.blob, undefined);
    const published = fixture.publish.mock.calls[0]?.[0];
    if (!published) throw new Error("Expected one durable V3 publication.");
    expect(published.expected.hermeticMathTexV3Plan).toEqual(
      deriveHermeticMathTexV3TransformPlan(TRANSFORMED_MATHTEX_SOURCE, SCENE_NAME),
    );
  });

  it("retains and serves the server-derived V7 MathTex transform plan", async () => {
    const fixture = harness(transformedMathTexV7View());
    const head = transformedMathTexSourceHeadV7();
    fixture.readSourceHead.mockResolvedValue(head);
    fixture.readSource.mockResolvedValue(TRANSFORMED_MATHTEX_SOURCE_V7);

    await expect(fixture.service.run(request)).resolves.toMatchObject({ status: "verified" });

    const published = fixture.publish.mock.calls[0]?.[0];
    if (!published) throw new Error("Expected one durable V7 publication.");
    expect(published.expected.hermeticMathTexV3Plan).toEqual(
      deriveMixedDynamicMathTexV7TransformPlan(TRANSFORMED_MATHTEX_SOURCE_V7, SCENE_NAME),
    );
    fixture.readCurrent.mockResolvedValueOnce({
      document: {
        expected: published.expected,
        profileDigest: PROFILE_DIGEST,
        runtimeDigest: RELEASE_RUNTIME_DIGEST,
        schema: "poietra.studio-snapshot-artifact",
        snapshot: published.snapshot,
        sourceRuntimeIdentity: published.sourceRuntimeIdentity,
        version: 2,
      },
      kind: "published",
      publication: publication(15n),
    } as never);

    await expect(
      fixture.service.snapshot(PROJECT, { sceneName: SCENE_NAME, sourcePath: SOURCE_PATH }),
    ).resolves.toMatchObject({ snapshot: published.snapshot, status: "verified" });
  });

  it("re-derives and retains the strict V5 MathTex morph plan for durable publication", async () => {
    const fixture = harness(mathTexMorphV5View());
    const head = mathTexMorphSourceHeadV5(MATHTEX_MORPH_SOURCE_V5);
    fixture.readSourceHead.mockResolvedValue(head);
    fixture.readSource.mockResolvedValue(MATHTEX_MORPH_SOURCE_V5);

    await expect(fixture.service.run(request)).resolves.toMatchObject({ status: "verified" });

    const published = fixture.publish.mock.calls[0]?.[0];
    if (!published) throw new Error("Expected one durable V5 publication.");
    expect(published.expected.hermeticMathTexMorphV5Plan).toEqual(
      deriveHermeticMathTexMorphV5Plan(MATHTEX_MORPH_SOURCE_V5, SCENE_NAME),
    );
  });

  it("refuses a receipt-valid V5 source that drifts outside the strict source profile", async () => {
    const driftedSource = `import os\n${MATHTEX_MORPH_SOURCE_V5}`;
    const head = mathTexMorphSourceHeadV5(driftedSource);
    const fixture = harness(mathTexMorphV5View(head.blob.digest));
    fixture.readSourceHead.mockResolvedValue(head);
    fixture.readSource.mockResolvedValue(driftedSource);

    await expect(fixture.service.run(request)).rejects.toMatchObject({ code: "profile-violation" });
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("fails closed when the version-pinned V4 source bytes do not match their receipt", async () => {
    const fixture = harness(transformedPngV4View());
    const head = transformedPngSourceHead();
    fixture.readSourceHead.mockResolvedValue(head);
    fixture.readSource.mockResolvedValue(`${TRANSFORMED_PNG_SOURCE}# changed after receipt\n`);

    await expect(fixture.service.run(request)).rejects.toThrow(/version-pinned blob receipt/i);
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("does not allocate runners for valid project IDs whose durable source does not exist", async () => {
    const fixture = harness();
    fixture.readSourceHead.mockRejectedValue(new HttpError("No managed workspace exists.", 404));

    const results = await Promise.allSettled(
      Array.from({ length: 32 }, (_, index) =>
        fixture.service.run({ ...request, projectId: `missing-workspace-${index}` }),
      ),
    );

    expect(
      results.every(
        (result) => result.status === "rejected" && result.reason instanceof HttpError && result.reason.status === 404,
      ),
    ).toBe(true);
    expect(fixture.factory.create).not.toHaveBeenCalled();
    expect(fixture.runnerClose).not.toHaveBeenCalled();
  });

  it("does not publish runner failures or unsupported results", async () => {
    const unsupported = {
      fallback: { kind: "server-authoritative-render" },
      issues: [],
      projectId: PROJECT,
      requestId: request.requestId,
      runtimeConfigHash: RUNTIME_DIGEST,
      sceneName: SCENE_NAME,
      schema: "poietra.fast-manim-snapshot-run",
      sourcePath: SOURCE_PATH,
      status: "unsupported",
      version: 1,
    } as const satisfies FastManimSnapshotRunViewV1;
    const fixture = harness(unsupported);

    await expect(fixture.service.run(request)).resolves.toEqual(unsupported);
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.readSourceHead).toHaveBeenCalledTimes(1);
  });

  it("turns source-generation drift and a failed publication CAS into source-changed failures", async () => {
    const drift = harness();
    drift.readSourceHead.mockResolvedValueOnce(sourceHead()).mockResolvedValueOnce(sourceHead(8n));

    const drifted = await drift.service.run(request);

    expect(drifted).toMatchObject({ failure: { code: "source-changed" }, status: "failed" });
    expect(drift.publish).not.toHaveBeenCalled();

    const stale = harness();
    stale.publish.mockResolvedValueOnce({ kind: "source-stale" } as never);

    const rejected = await stale.service.run(request);

    expect(rejected).toMatchObject({ failure: { code: "source-changed" }, status: "failed" });
  });

  it("rejects a verified result from another runtime configuration before publication", async () => {
    const fixture = harness({ ...verifiedView, runtimeConfigHash: "2".repeat(64) });

    await expect(fixture.service.run(request)).rejects.toThrow(/active runtime configuration/i);
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("serves a version-pinned durable artifact without constructing a runner", async () => {
    const fixture = harness();
    fixture.readCurrent.mockResolvedValueOnce({
      document: {
        expected: expected(),
        profileDigest: PROFILE_DIGEST,
        runtimeDigest: RELEASE_RUNTIME_DIGEST,
        schema: "poietra.studio-snapshot-artifact",
        snapshot: compiledSnapshot,
        sourceRuntimeIdentity: null,
        version: 2,
      },
      kind: "published",
      publication: publication(15n),
    } as never);

    const view = await fixture.service.snapshot(PROJECT, { sceneName: SCENE_NAME, sourcePath: SOURCE_PATH });

    expect(view).toMatchObject({
      publishedAt: PUBLISHED_AT.toISOString(),
      requestId: request.requestId,
      revision: 15,
      snapshot: compiledSnapshot,
      status: "verified",
    });
    expect(fixture.factory.create).not.toHaveBeenCalled();
    expect(fixture.readCurrent).toHaveBeenCalledWith(
      {
        projectId: PROJECT,
        runtimeConfigHash: RUNTIME_DIGEST,
        runtimeDigest: RELEASE_RUNTIME_DIGEST,
        sceneName: SCENE_NAME,
        sourcePath: SOURCE_PATH,
        tenantId: TENANT,
      },
      undefined,
    );
  });

  it.each([
    ["missing", { kind: "missing" as const }],
    ["source-stale", { generation: 13n, kind: "stale" as const, reason: "source-stale" as const }],
    ["artifact-missing", { generation: 13n, kind: "stale" as const, reason: "artifact-missing" as const }],
    ["artifact-corrupt", { generation: 13n, kind: "stale" as const, reason: "artifact-corrupt" as const }],
  ])("returns 404 when no complete durable correlation can be served (%s)", async (_reason, result) => {
    const fixture = harness();
    fixture.readCurrent.mockResolvedValueOnce(result as never);

    await expect(
      fixture.service.snapshot(PROJECT, { sceneName: SCENE_NAME, sourcePath: SOURCE_PATH }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns a retryable 503 when the durable publication is continuously superseded", async () => {
    const fixture = harness();
    fixture.readCurrent.mockResolvedValueOnce({
      generation: 13n,
      kind: "stale",
      reason: "concurrently-superseded",
    });

    await expect(
      fixture.service.snapshot(PROJECT, { sceneName: SCENE_NAME, sourcePath: SOURCE_PATH }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/retry/i), status: 503 });
  });

  it("deletes durable state before releasing a source-validation-only project entry", async () => {
    const fixture = harness();
    const validation = deferred<WorkspaceSourceHeadV1>();
    fixture.readSourceHead.mockReturnValueOnce(validation.promise);
    const run = fixture.service.run(request);
    await vi.waitFor(() => expect(fixture.readSourceHead).toHaveBeenCalledTimes(1));
    expect(fixture.factory.create).not.toHaveBeenCalled();

    await fixture.service.releaseProject(PROJECT);
    validation.resolve(sourceHead());

    await expect(run).rejects.toMatchObject({ status: 503 });
    expect(fixture.softDeleteProject).toHaveBeenCalledWith(TENANT, PROJECT, undefined);
    expect(fixture.factory.create).not.toHaveBeenCalled();
    expect(fixture.runnerRun).not.toHaveBeenCalled();
  });

  it("releases an active runner only after durable project deletion commits", async () => {
    const fixture = harness();
    const order: string[] = [];
    fixture.softDeleteProject.mockImplementationOnce(async () => {
      order.push("durable-delete");
    });
    fixture.runnerClose.mockImplementationOnce(async () => {
      order.push("runner-close");
    });
    const running = deferred<FastManimUnpublishedSnapshotRunViewV1>();
    fixture.runnerRun.mockReturnValueOnce(running.promise);
    const run = fixture.service.run(request);
    await vi.waitFor(() => expect(fixture.runnerRun).toHaveBeenCalledTimes(1));

    await fixture.service.releaseProject(PROJECT);
    running.resolve(verifiedView);

    await expect(run).rejects.toMatchObject({ status: 503 });
    expect(fixture.runnerClose).toHaveBeenCalledTimes(1);
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(order).toEqual(["durable-delete", "runner-close"]);
  });

  it("preserves its runner when durable deletion fails", async () => {
    const fixture = harness();
    await fixture.service.run(request);
    const deletion = deferred<void>();
    fixture.softDeleteProject.mockReturnValueOnce(deletion.promise);
    const failure = new HttpError("retained render session", 409);
    const release = fixture.service.releaseProject(PROJECT);
    const rejected = expect(release).rejects.toBe(failure);

    deletion.reject(failure);
    await rejected;

    await expect(fixture.service.run(request)).resolves.toMatchObject({ status: "verified" });
    expect(fixture.factory.create).toHaveBeenCalledTimes(1);
    expect(fixture.runnerClose).not.toHaveBeenCalled();
  });

  it("returns an in-flight publication that committed while project deletion completed", async () => {
    const fixture = harness();
    const commit = deferred<Readonly<{ kind: "published"; publication: SnapshotPublicationV1 }>>();
    fixture.publish.mockReturnValueOnce(commit.promise);
    const run = fixture.service.run(request);
    await vi.waitFor(() => expect(fixture.publish).toHaveBeenCalledTimes(1));

    const release = fixture.service.releaseProject(PROJECT);
    await vi.waitFor(() => expect(fixture.runnerClose).toHaveBeenCalledTimes(1));
    await expect(release).resolves.toBeUndefined();
    commit.resolve({ kind: "published", publication: publication(14n) });

    await expect(run).resolves.toMatchObject({ revision: 14, status: "verified" });
  });

  it("returns a committed publication when service close races with the publish response", async () => {
    const fixture = harness();
    const commit = deferred<Readonly<{ kind: "published"; publication: SnapshotPublicationV1 }>>();
    fixture.publish.mockReturnValueOnce(commit.promise);
    const run = fixture.service.run(request);
    await vi.waitFor(() => expect(fixture.publish).toHaveBeenCalledTimes(1));

    const closing = fixture.service.close();
    await vi.waitFor(() => expect(fixture.runnerClose).toHaveBeenCalledTimes(1));
    commit.resolve({ kind: "published", publication: publication(14n) });

    await expect(run).resolves.toMatchObject({ revision: 14, status: "verified" });
    await expect(closing).resolves.toBeUndefined();
  });

  it("evicts a failed lazy creation so the next request can retry", async () => {
    const fixture = harness();
    const creationFailure = new Error("broker unavailable");
    fixture.factory.create.mockRejectedValueOnce(creationFailure);

    await expect(fixture.service.run(request)).rejects.toBe(creationFailure);
    await expect(fixture.service.run(request)).resolves.toMatchObject({ status: "verified" });
    expect(fixture.factory.create).toHaveBeenCalledTimes(2);
  });

  it("closes a runner that finishes creation after its project is released", async () => {
    const fixture = harness();
    const creation = deferred<{
      profileDigest: string;
      runner: FastManimSnapshotRunner;
      runtimeConfigHash: string;
      runtimeDigest: string;
    }>();
    fixture.factory.create.mockReturnValueOnce(creation.promise);
    const run = fixture.service.run(request);
    await vi.waitFor(() => expect(fixture.factory.create).toHaveBeenCalledTimes(1));

    const release = fixture.service.releaseProject(PROJECT);
    creation.resolve({
      profileDigest: PROFILE_DIGEST,
      runner: fixture.runner,
      runtimeConfigHash: RUNTIME_DIGEST,
      runtimeDigest: RELEASE_RUNTIME_DIGEST,
    });

    await expect(run).rejects.toBeInstanceOf(HttpError);
    await expect(release).resolves.toBeUndefined();
    expect(fixture.runnerClose).toHaveBeenCalledTimes(1);
    expect(fixture.runnerRun).not.toHaveBeenCalled();
  });

  it("closes and rejects a runner from a different runtime generation", async () => {
    const fixture = harness();
    fixture.factory.create.mockResolvedValueOnce({
      profileDigest: PROFILE_DIGEST,
      runner: fixture.runner,
      runtimeConfigHash: RUNTIME_DIGEST,
      runtimeDigest: "1".repeat(64),
    });

    await expect(fixture.service.run(request)).rejects.toThrow(/runner identity is invalid/i);
    expect(fixture.runnerClose).toHaveBeenCalledOnce();
    expect(fixture.runnerRun).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("closes and rejects a runner from a different runtime configuration", async () => {
    const fixture = harness();
    fixture.factory.create.mockResolvedValueOnce({
      profileDigest: PROFILE_DIGEST,
      runner: fixture.runner,
      runtimeConfigHash: "2".repeat(64),
      runtimeDigest: RELEASE_RUNTIME_DIGEST,
    });

    await expect(fixture.service.run(request)).rejects.toThrow(/runner identity is invalid/i);
    expect(fixture.runnerClose).toHaveBeenCalledOnce();
    expect(fixture.runnerRun).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("does not overturn a committed deletion when runner cleanup fails", async () => {
    const fixture = harness();
    await fixture.service.run(request);
    fixture.runnerClose.mockRejectedValueOnce(new Error("released runner cleanup failed"));

    await expect(fixture.service.releaseProject(PROJECT)).resolves.toBeUndefined();
    await expect(fixture.service.close()).rejects.toThrow(AggregateError);

    expect(fixture.softDeleteProject).toHaveBeenCalledTimes(1);
    expect(fixture.factory.close).toHaveBeenCalledTimes(1);
    expect(fixture.publisher.close).toHaveBeenCalledTimes(1);
  });

  it("owns factory and publisher lifecycle but leaves shared source storage open", async () => {
    const fixture = harness();
    await fixture.service.run(request);

    await expect(fixture.service.ready()).resolves.toBe(true);
    await fixture.service.close();

    expect(fixture.runnerClose).toHaveBeenCalledTimes(1);
    expect(fixture.factory.close).toHaveBeenCalledTimes(1);
    expect(fixture.publisher.close).toHaveBeenCalledTimes(1);
    expect(fixture.sourceRepository.close).not.toHaveBeenCalled();
    expect(fixture.blobs.close).not.toHaveBeenCalled();
    await expect(fixture.service.ready()).resolves.toBe(false);
  });

  it("reports runner cleanup failures while still closing the factory and publisher", async () => {
    const fixture = harness();
    await fixture.service.run(request);
    fixture.runnerClose.mockRejectedValueOnce(new Error("runner cleanup failed"));

    await expect(fixture.service.close()).rejects.toThrow(AggregateError);

    expect(fixture.factory.close).toHaveBeenCalledTimes(1);
    expect(fixture.publisher.close).toHaveBeenCalledTimes(1);
  });
});
