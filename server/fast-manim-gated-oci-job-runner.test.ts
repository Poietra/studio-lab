import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import fastManimGatedOciSeccompV1 from "../sandbox/fast-manim-gated-oci/seccomp.v1.json";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
  FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
} from "../src/engine/source-runtime-identity";
import {
  assertFastManimGatedOciImageV1,
  FAST_MANIM_GATED_OCI_PROFILE_V1,
  FAST_MANIM_GATED_OCI_SNAPSHOT_RELEASE_READY_V1,
  FAST_MANIM_HERMETIC_PNG_V4_PRODUCER_CONTRACT_V1,
  FastManimGatedOciDockerClientV1,
  FastManimGatedOciError,
  FastManimGatedOciJobRunnerV1,
  parseFastManimGatedOciResultV1,
  reconcileFastManimGatedOciDockerOrphansV1,
  runFastManimGatedOciJobV1,
} from "./fast-manim-gated-oci-job-runner";
import { FastManimSandboxBackendControlError, FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import {
  deriveHermeticMathTexV3TransformPlan,
  deriveHermeticPngV4TransformPlan,
  digestFastManimSnapshotRuntimeConfigV1,
  type FastManimSnapshotProducerRequestV1,
  fastManimSnapshotSceneIdV1,
  MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS,
  MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES,
  parseAndSealFastManimSnapshotProducerJsonV1,
} from "./fast-manim-snapshot-contract";
import { parseFastManimProducerDocumentV1 } from "./fast-manim-source-runtime-document";
import { verifyFastManimSourceRuntimeIdentityV1 } from "./fast-manim-source-runtime-identity";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";
import {
  FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1,
  FAST_MANIM_SANDBOX_CONFORMANCE_LEAK_SENTINELS_V1,
} from "./test-fixtures/fast-manim-sandbox-conformance-fixture";
import {
  SANDBOX_TRANSFORMED_PNG_EXPECTED,
  sandboxPngBytes,
  sandboxPngProducerRequest,
  sandboxTransformedPngProducerRequest,
  sandboxTransformedPngSource,
} from "./test-fixtures/fast-manim-sandbox-png-fixture";

const realImage = process.env.POIETRA_FAST_MANIM_GATED_OCI_IMAGE;
const realLane = /^sha256:[a-f0-9]{64}$/.test(realImage ?? "");
const pythonInterpreter = process.env.PYTHON?.trim() || "python3";
const MAGIC = Buffer.from("POIETR1\0", "ascii");
const seccompPath = fileURLToPath(new URL("../sandbox/fast-manim-gated-oci/seccomp.v1.json", import.meta.url));
const affineScene = readFileSync(
  fileURLToPath(new URL("../fixtures/real-preview-harness/scene_affine.py", import.meta.url)),
  "utf8",
);
const pathTrimScene = readFileSync(
  fileURLToPath(new URL("../fixtures/real-preview-harness/scene_path_trim.py", import.meta.url)),
  "utf8",
);
const pathMorphScene = readFileSync(
  fileURLToPath(new URL("../fixtures/real-preview-harness/scene_path_morph.py", import.meta.url)),
  "utf8",
);
const motionPathScene = readFileSync(
  fileURLToPath(new URL("../fixtures/real-preview-harness/scene_motion_path.py", import.meta.url)),
  "utf8",
);

function context(signal = new AbortController().signal, deadlineMs = 30_000) {
  return {
    deadlineEpochMs: Date.now() + deadlineMs,
    identity: { projectId: "default", requestId: "gated-oci-test", tenantId: "test-tenant" },
    signal,
  };
}

function producerRequestFor(
  sourceText: string,
  sceneName: string,
  snapshotVersion: 1 | 2 | 3 = 1,
  sourcePath = "scene.py",
) {
  const request = sandboxProducerRequest();
  const runtimeConfig = { ...request.runtimeConfig, snapshotVersion };
  return {
    ...request,
    requestId: `gated-${sceneName}`,
    runtimeConfig,
    runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(runtimeConfig),
    sceneId: fastManimSnapshotSceneIdV1(sourcePath, sceneName),
    sceneName,
    snapshotVersion,
    sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
    sourcePath,
    sourceText,
  };
}

function requestFor(sourceText: string, sceneName: string, snapshotVersion: 1 | 2 | 3 = 1) {
  return new FastManimSandboxRequestBundleV1(producerRequestFor(sourceText, sceneName, snapshotVersion));
}

type ProducerRequest = FastManimSnapshotProducerRequestV1;

function expectedFor(source: ProducerRequest) {
  return {
    frame: source.runtimeConfig.frame,
    projectId: source.projectId,
    requestId: source.requestId,
    runtimeConfigHash: source.runtimeConfigHash,
    sceneId: source.sceneId,
    sceneName: source.sceneName,
    snapshotVersion: source.snapshotVersion,
    sourceHash: source.sourceHash,
    sourcePath: source.sourcePath,
  };
}

async function verifyCombinedResult(resultBytes: Uint8Array, source: ProducerRequest) {
  const producerDocument = parseFastManimProducerDocumentV1(resultBytes);
  if (!producerDocument.combined) throw new Error("The gated OCI producer returned a legacy snapshot-only result.");
  const expected = expectedFor(source);
  const snapshot = await parseAndSealFastManimSnapshotProducerJsonV1(
    producerDocument.snapshotJson,
    expected,
    source.sourceText,
  );
  const sourceRuntimeIdentity = verifyFastManimSourceRuntimeIdentityV1(producerDocument.combined, {
    expected,
    snapshot,
    sourceText: source.sourceText,
  });
  return { snapshot, sourceRuntimeIdentity };
}

function combinedResultWire(snapshotJson: string) {
  const snapshotDigest = createHash("sha256").update(snapshotJson, "utf8").digest("hex");
  return Buffer.from(
    `${canonicalJsonV1({
      evidence: {},
      schema: FAST_MANIM_SOURCE_RUNTIME_IDENTITY_SCHEMA_V1,
      snapshotDigest,
      snapshotJson,
      version: FAST_MANIM_SOURCE_RUNTIME_IDENTITY_VERSION_V1,
    })}\n`,
    "utf8",
  );
}

function wire(body: Uint8Array, overrides: Readonly<{ digest?: Buffer; length?: number; magic?: Buffer }> = {}) {
  const header = Buffer.alloc(48);
  (overrides.magic ?? MAGIC).copy(header, 0);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(overrides.length ?? body.byteLength, 12);
  (overrides.digest ?? createHash("sha256").update(body).digest()).copy(header, 16);
  return Buffer.concat([header, body]);
}

const staticScene = FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1.supported.sourceText;

const opacityLifetimeScene = `from manim import Circle, FadeIn, FadeOut, Scene, linear

class GatedOpacityLifetimeScene(Scene):
    def construct(self):
        circle = Circle().set_fill("#ef4444", opacity=0.35).set_stroke(width=0)
        self.wait(1, frozen_frame=True)
        self.play(FadeIn(circle, rate_func=linear), run_time=2)
        self.wait(1, frozen_frame=True)
        self.play(FadeOut(circle, rate_func=linear), run_time=2)
`;

const mathTexScene = String.raw`from manim import MathTex, Scene

class GatedMathTexScene(Scene):
    def construct(self):
        equation = MathTex(r"\frac{a}{b}")
        self.add(equation)
        equation.move_to((1.25, -0.75, 0))
        equation.scale(1.5)
        equation.move_to((-0.25, 0.75, 0))
        equation.scale(0.5)
        self.wait(2)
`;

const V4_POST_ADD_PLAN = Object.freeze({
  terminalWait: 2,
  transforms: Object.freeze([
    Object.freeze({ kind: "move-to" as const, x: 1.25, y: -0.75 }),
    Object.freeze({ factor: 1.5, kind: "scale" as const }),
  ]),
});

const V4_PRODUCER_OWNED_PRELUDE_CORPUS = Object.freeze([
  Object.freeze({
    case: "producer-admitted formatting and docstrings",
    source: `"""module documentation"""
from manim import (
    ImageMobject,
    RESAMPLING_ALGORITHMS,
    Scene,
)

class TransformedImageScene(Scene):  # comments are producer-owned syntax
  """class documentation"""

  def construct(self):
    """construct documentation"""
    image = ImageMobject("image" ".png", resampling_algorithm=RESAMPLING_ALGORITHMS["near" "est"])
    self.add(image)
    image.move_to((1.25, -0.75, 0))
    image.scale(1.5)
    self.wait(2)
`,
  }),
  Object.freeze({
    case: "producer-rejected module side effect",
    source: `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

print("producer must reject this")

class TransformedImageScene(Scene):
    def construct(self):
        image = ImageMobject("image.png", resampling_algorithm=RESAMPLING_ALGORITHMS["nearest"])
        self.add(image)
        image.move_to((1.25, -0.75, 0))
        image.scale(1.5)
        self.wait(2)
`,
  }),
  Object.freeze({
    case: "producer-rejected constructor",
    source: `from manim import ImageMobject, RESAMPLING_ALGORITHMS, Scene

class TransformedImageScene(Scene):
    def construct(self):
        image = ImageMobject("other.png", resampling_algorithm=RESAMPLING_ALGORITHMS["cubic"])
        self.add(image)
        image.move_to((1.25, -0.75, 0))
        image.scale(1.5)
        self.wait(2)
`,
  }),
] as const);

const TRUSTED_IMAGE_LABELS = Object.freeze({
  "io.poietra.fast-manim.archive-sha256": "2efa05e411df6a13b7c1bfab93bc99f8b58aeb8f3daf5f17db894b3c0ed54823",
  "io.poietra.fast-manim.commit": "d2480e8096a5cac64f7f86ed1d0d01f5c87839e3",
  "io.poietra.fast-manim.tree": "0ca5f7fc0c77a87fec7df605c8ce1190edf16f0a",
  "io.poietra.mathtex-outline.abi-version": "1",
  "io.poietra.mathtex-outline.artifact-sha256": "0".repeat(64),
  "io.poietra.mathtex-outline.engine-archive-sha256":
    "2aa42246977322bae54862f49ce28b3e61bf8b472a93800b2fdda8e344173d32",
  "io.poietra.mathtex-outline.engine-commit": "be671c1ddcfc8466548c8822956e19579256e581",
  "io.poietra.mathtex-outline.engine-tree": "d0f6d72213c65527ae9b7a4717390b48db1e9256",
  "io.poietra.mathtex-outline.font-sha256": "e52df76208d1e41c8222496e9fb30cc2a1fe8a275b14995f3f6c3a9205db21fa",
  "io.poietra.mathtex-outline.notice-sha256": "44eebb7f078626c705cf0d952509075410f86bb91af6e4102d38565c53ddb856",
  "io.poietra.mathtex-outline.target": "linux-amd64",
  "io.poietra.mathtex-outline.toolchain-sha256": "40a85bd625fe868b295906a6a002a1cfae677be241f835898f467a113b626430",
  "io.poietra.snapshot-sandbox-envelope-version": "2",
  "io.poietra.sandbox-slice": "gated-oci-v1",
});

class RecordingDockerClient extends FastManimGatedOciDockerClientV1 {
  readonly calls: string[][] = [];
  readonly responses: Array<Readonly<{ code: number; stderr: Buffer; stdout: Buffer }>> = [];

  override async run(arguments_: readonly string[]) {
    this.calls.push([...arguments_]);
    return this.responses.shift() ?? { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) };
  }
}

function trustedImageInspection(
  image: string,
  target: readonly string[] = FAST_MANIM_GATED_OCI_PROFILE_V1.target,
  labels: Readonly<Record<string, string>> = TRUSTED_IMAGE_LABELS,
) {
  return Buffer.from(
    JSON.stringify([
      {
        Config: {
          Cmd: target,
          Entrypoint: ["/opt/venv/bin/python", "/opt/poietra/gated-entrypoint.py"],
          Labels: labels,
        },
        Id: image,
      },
    ]),
  );
}

function stoppedFixedContainerInspection(image: string, containerId: string) {
  const profile = FAST_MANIM_GATED_OCI_PROFILE_V1;
  return Buffer.from(
    JSON.stringify([
      {
        Config: {
          Cmd: profile.target,
          Entrypoint: profile.entrypoint,
          Env: Object.entries(profile.environment).map(([key, value]) => `${key}=${value}`),
          Image: image,
          Labels: profile.requiredContainerLabels,
          OpenStdin: profile.openStdin,
          StdinOnce: profile.stdinOnce,
          StopTimeout: profile.stopTimeoutSeconds,
          Tty: profile.tty,
          User: profile.user,
          WorkingDir: profile.workingDirectory,
        },
        HostConfig: {
          AutoRemove: profile.autoRemove,
          Binds: null,
          CapAdd: null,
          CapDrop: profile.capabilitiesDropped,
          CgroupnsMode: profile.cgroupNamespace,
          Devices: profile.devices,
          IpcMode: profile.ipc,
          LogConfig: { Config: profile.logDriver.config, Type: profile.logDriver.type },
          MaskedPaths: profile.requiredMaskedSystemPaths,
          Memory: profile.memoryBytes,
          MemorySwap: profile.memorySwapBytes,
          NanoCpus: profile.cpuNanoSeconds,
          NetworkMode: profile.network,
          PidMode: "",
          PidsLimit: profile.pidsLimit,
          Privileged: profile.privileged,
          ReadonlyPaths: profile.requiredReadOnlySystemPaths,
          ReadonlyRootfs: profile.readOnlyRootfs,
          SecurityOpt: ["no-new-privileges=true", `seccomp=${JSON.stringify(fastManimGatedOciSeccompV1)}`],
          ShmSize: profile.shmBytes,
          Tmpfs: { [profile.tmpfs.path]: profile.tmpfs.options.join(",") },
          Ulimits: profile.ulimits.map((limit) => ({
            Hard: limit.hard,
            Name: limit.name,
            Soft: limit.soft,
          })),
        },
        Id: containerId,
        Image: image,
        Mounts: profile.mounts,
        Name: "/poietra-gated-00000000000000000000000000000000",
        State: { Pid: 0, Running: false },
      },
    ]),
  );
}

describe("gated OCI Docker ownership", () => {
  it("targets a canonical fixed socket and reconciles only broker-owned jobs", async () => {
    expect(() => new FastManimGatedOciDockerClientV1({ socketPath: "relative.sock" })).toThrow(/canonical/i);
    const image = `sha256:${"a".repeat(64)}`;
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: trustedImageInspection(image) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );

    await reconcileFastManimGatedOciDockerOrphansV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: client,
      image,
      seccompPath,
      signal: new AbortController().signal,
    });
    expect(client.calls).toEqual([
      ["image", "inspect", image],
      ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label=io.poietra.gated-job=v1"],
    ]);
  });

  it("rejects an immutable image that still targets the legacy snapshot-only producer", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push({
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: trustedImageInspection(image, ["/opt/venv/bin/python", "-m", "manim.renderer.scene_snapshot"]),
    });

    await expect(
      assertFastManimGatedOciImageV1(image, client, Date.now() + 10_000, new AbortController().signal),
    ).rejects.toThrow(/does not match the gated slice/i);
  });

  it.each(Object.keys(TRUSTED_IMAGE_LABELS))("rejects an image whose %s label drifted", async (label) => {
    const image = `sha256:${"a".repeat(64)}`;
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push({
      code: 0,
      stderr: Buffer.alloc(0),
      stdout: trustedImageInspection(image, FAST_MANIM_GATED_OCI_PROFILE_V1.target, {
        ...TRUSTED_IMAGE_LABELS,
        [label]: "drifted",
      }),
    });

    await expect(
      assertFastManimGatedOciImageV1(image, client, Date.now() + 10_000, new AbortController().signal),
    ).rejects.toThrow(/does not match the gated slice/i);
  });

  it("removes owned orphans while keeping readiness failed after image drift", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const containerId = "b".repeat(64);
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push(
      { code: 1, stderr: Buffer.from("untrusted"), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${containerId}\n`) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify([{ Id: containerId }])) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );

    await expect(
      reconcileFastManimGatedOciDockerOrphansV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: client,
        image,
        seccompPath,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    expect(client.calls).toContainEqual(["container", "kill", containerId]);
    expect(client.calls).toContainEqual(["container", "rm", "--force", containerId]);
  });

  it("removes a stopped orphan but requires a clean restart instead of treating leader exit as reap proof", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const containerId = "b".repeat(64);
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: trustedImageInspection(image) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${containerId}\n`) },
      { code: 0, stderr: Buffer.alloc(0), stdout: stoppedFixedContainerInspection(image, containerId) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );

    await expect(
      reconcileFastManimGatedOciDockerOrphansV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: client,
        image,
        seccompPath,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    expect(client.calls).toContainEqual(["container", "rm", "--force", containerId]);

    const retry = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    retry.responses.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: trustedImageInspection(image) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );
    await expect(
      reconcileFastManimGatedOciDockerOrphansV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: retry,
        image,
        seccompPath,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("still removes owned orphans before failing closed on seccomp drift", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const containerId = "b".repeat(64);
    const client = new RecordingDockerClient({ socketPath: "/run/user/1000/poietra-docker.sock" });
    client.responses.push(
      { code: 0, stderr: Buffer.alloc(0), stdout: trustedImageInspection(image) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(`${containerId}\n`) },
      {
        code: 0,
        stderr: Buffer.alloc(0),
        stdout: Buffer.from(
          JSON.stringify([
            {
              Config: { Labels: { "io.poietra.gated-job": "v1" } },
              Id: containerId,
              Name: "/poietra-gated-00000000000000000000000000000000",
              State: { Pid: 0, Running: false },
            },
          ]),
        ),
      },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
      { code: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) },
    );

    await expect(
      reconcileFastManimGatedOciDockerOrphansV1({
        cgroupKillPolicy: "best-effort",
        dockerClient: client,
        image,
        seccompPath: "/definitely-missing/poietra-seccomp.json",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "cleanup" });
    expect(client.calls).toEqual(
      expect.arrayContaining([
        ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", "label=io.poietra.gated-job=v1"],
        ["container", "kill", containerId],
        ["container", "rm", "--force", containerId],
      ]),
    );
  });
});

describe("gated OCI fixed profile", () => {
  it("keeps production promotion closed until the external native artifact is pinned", () => {
    const buildScriptPath = fileURLToPath(new URL("../scripts/build-fast-manim-gated-oci.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [buildScriptPath], { encoding: "utf8" });
    expect(FAST_MANIM_GATED_OCI_SNAPSHOT_RELEASE_READY_V1).toBe(false);
    expect(TRUSTED_IMAGE_LABELS["io.poietra.mathtex-outline.artifact-sha256"]).toBe("0".repeat(64));
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: expect.stringContaining("awaiting the pinned-builder MathTex artifact digest"),
    });
  });

  it("admits the RaTeX-only fraction source under the V3 server-owned plan", () => {
    expect(mathTexScene).toContain('MathTex(r"\\frac{a}{b}")');
    expect(deriveHermeticMathTexV3TransformPlan(mathTexScene, "GatedMathTexScene")).toEqual({
      terminalWait: 2,
      transforms: [
        { kind: "move-to", x: 1.25, y: -0.75 },
        { factor: 1.5, kind: "scale" },
        { kind: "move-to", x: -0.25, y: 0.75 },
        { factor: 0.5, kind: "scale" },
      ],
    });
  });

  it("admits the shared repeated-transform V4 source under the server-owned plan", () => {
    expect(deriveHermeticPngV4TransformPlan(sandboxTransformedPngSource, "TransformedImageScene")).toEqual({
      terminalWait: 2,
      transforms: [
        { kind: "move-to", x: 1.25, y: -0.75 },
        { factor: 1.5, kind: "scale" },
        { kind: "move-to", x: -0.25, y: 0.75 },
        { factor: 0.5, kind: "scale" },
      ],
    });
  });

  it.each(V4_PRODUCER_OWNED_PRELUDE_CORPUS)("derives only the V4 post-add plan across $case", ({ source }) => {
    expect(deriveHermeticPngV4TransformPlan(source, "TransformedImageScene")).toEqual(V4_POST_ADD_PLAN);
  });

  it("keeps the immutable producer pin aligned across the builder, image, and admitted profile", () => {
    const buildScript = readFileSync(
      fileURLToPath(new URL("../scripts/build-fast-manim-gated-oci.mjs", import.meta.url)),
      "utf8",
    );
    const containerfile = readFileSync(
      fileURLToPath(new URL("../sandbox/fast-manim-gated-oci/Containerfile", import.meta.url)),
      "utf8",
    );
    const verifier = readFileSync(
      fileURLToPath(new URL("../sandbox/fast-manim-gated-oci/verify-mathtex-provider.py", import.meta.url)),
      "utf8",
    );
    const snapshotContract = readFileSync(
      fileURLToPath(new URL("./fast-manim-snapshot-contract.ts", import.meta.url)),
      "utf8",
    );
    const buildPinnedLabels = Object.entries(TRUSTED_IMAGE_LABELS).filter(
      ([key]) =>
        key.startsWith("io.poietra.fast-manim.") ||
        key.startsWith("io.poietra.mathtex-outline.engine-") ||
        key === "io.poietra.mathtex-outline.artifact-sha256",
    );

    expect(FAST_MANIM_GATED_OCI_PROFILE_V1.requiredContainerLabels).toMatchObject(TRUSTED_IMAGE_LABELS);
    expect(FAST_MANIM_GATED_OCI_PROFILE_V1.producerContracts).toEqual({
      hermeticPngV4: FAST_MANIM_HERMETIC_PNG_V4_PRODUCER_CONTRACT_V1,
    });
    expect(FAST_MANIM_HERMETIC_PNG_V4_PRODUCER_CONTRACT_V1).toEqual({
      archiveSha256: TRUSTED_IMAGE_LABELS["io.poietra.fast-manim.archive-sha256"],
      authority: "manim.renderer._scene_snapshot.profile.hermetic_png_plan_v4",
      commit: TRUSTED_IMAGE_LABELS["io.poietra.fast-manim.commit"],
      snapshotVersion: 4,
      studioResponsibility: "post-add-static-transform-plan",
      tree: TRUSTED_IMAGE_LABELS["io.poietra.fast-manim.tree"],
      version: 1,
    });
    for (const [key, value] of Object.entries(TRUSTED_IMAGE_LABELS)) {
      expect(containerfile, `${key} must be emitted by the immutable image`).toContain(`${key}="${value}"`);
    }
    for (const [key, value] of buildPinnedLabels) {
      expect(buildScript, `${key} must be pinned by the build helper`).toContain(value);
    }
    for (const key of [
      "io.poietra.mathtex-outline.font-sha256",
      "io.poietra.mathtex-outline.toolchain-sha256",
    ] as const) {
      const digest = TRUSTED_IMAGE_LABELS[key];
      expect(verifier, `${key} must be verified inside the image`).toContain(digest);
      expect(snapshotContract, `${key} must be admitted by the server`).toContain(digest);
    }
    // The current checkout can advance independently; the Containerfile verifies the notice
    // inside its pinned engine archive, so its two build checks and image label must agree.
    const pinnedNoticeDigest = TRUSTED_IMAGE_LABELS["io.poietra.mathtex-outline.notice-sha256"];
    expect(containerfile.match(new RegExp(pinnedNoticeDigest, "gu"))).toHaveLength(3);
    for (const stale of [
      "3083db9ed9a9a93c2808ee3f51189ceca92d230b",
      "bff6f60534f820650d1c9e3c7d38627c56c6a0c6",
      "3c64e0440fb5a2e0541aacc7a19bf87bdf46ac6f84059620ae5a0d812385cc1b",
      "4d2a80abe1dbb0d800fd74c36d8a442afdb8efb6",
      "270b237602705c240cab9daef824e6f0400d2f3c",
      "8c1e29ae95275a55a7c0ccc21f77848b63378ef37a469bd56820f7a372ff97e2",
    ]) {
      expect(buildScript).not.toContain(stale);
      expect(containerfile).not.toContain(stale);
    }
  });

  it("validates and materializes only the fixed sealed PNG attachment in Python", () => {
    const entrypointPath = fileURLToPath(
      new URL("../sandbox/fast-manim-gated-oci/gated-entrypoint.py", import.meta.url),
    );
    const testPath = fileURLToPath(
      new URL("../sandbox/fast-manim-gated-oci/gated-entrypoint.test.py", import.meta.url),
    );
    const pngPath = fileURLToPath(new URL("../src-tauri/icons/32x32.png", import.meta.url));
    const result = spawnSync(pythonInterpreter, [testPath, entrypointPath, pngPath], { encoding: "utf8" });
    expect({ stderr: result.stderr, status: result.status }).toEqual({
      stderr: expect.stringContaining("Ran 4 tests"),
      status: 0,
    });
  });

  it("treats seccomp EPERM/EACCES at stream socket creation as proof that outbound networking is blocked", () => {
    const entrypointPath = fileURLToPath(
      new URL("../sandbox/fast-manim-gated-oci/gated-entrypoint.py", import.meta.url),
    );
    const probe = String.raw`
import errno
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("poietra_gate", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DeniedSocket:
    def __init__(self, code):
        self.code = code
    def __call__(self, *_args, **_kwargs):
        raise OSError(self.code, "blocked by seccomp")

for code in (errno.EPERM, errno.EACCES):
    module.socket.socket = DeniedSocket(code)
    module._assert_outbound_network_blocked()

module.socket.socket = DeniedSocket(errno.EINVAL)
try:
    module._assert_outbound_network_blocked()
except RuntimeError:
    pass
else:
    raise AssertionError("unexpected socket errors must remain fail-closed")
`;
    const result = spawnSync(pythonInterpreter, ["-c", probe, entrypointPath], { encoding: "utf8" });
    expect({ stderr: result.stderr, status: result.status }).toEqual({ stderr: "", status: 0 });
  });
});

describe("gated OCI job runner lifecycle", () => {
  it("requires an immutable image ID", () => {
    expect(
      () =>
        new FastManimGatedOciJobRunnerV1({
          cgroupKillPolicy: "best-effort",
          dockerClient: new FastManimGatedOciDockerClientV1(),
          image: "poietra-fast-manim-gated:latest",
        }),
    ).toThrow(/immutable sha256/i);
  });

  it("latches cleanup failure, refuses new jobs, and fails close", async () => {
    const cleanupError = new FastManimSandboxBackendControlError("cleanup");
    const jobs = new FastManimGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: new FastManimGatedOciDockerClientV1(),
      executeJob: async () => {
        throw cleanupError;
      },
      image: `sha256:${"a".repeat(64)}`,
    });
    const request = requestFor(staticScene, "GatedStaticScene");
    const jobContext = { ...context(), attestationDigest: "b".repeat(64) };
    await expect(jobs.start(request, jobContext).result).rejects.toBe(cleanupError);
    expect(jobs.health()).toBe("cleanup-failed");
    expect(() => jobs.start(request, jobContext)).toThrow(FastManimSandboxBackendControlError);
    await expect(jobs.close()).rejects.toMatchObject({ code: "cleanup" });
  });

  it("forwards the exact digest-bound V2 PNG envelope to the fixed OCI gate", async () => {
    let capturedRequestBytes: Uint8Array | undefined;
    const jobs = new FastManimGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: new FastManimGatedOciDockerClientV1(),
      executeJob: async (options) => {
        capturedRequestBytes = options.requestBytes;
        return {
          cleanupVerified: true,
          evidence: {
            cgroup: "0::/test",
            containerId: "b".repeat(64),
            pid: 42,
            resources: { cpuMax: "100000 100000", memoryMax: "1", memorySwapMax: "0", pidsMax: "1" },
          },
          resultBytes: Uint8Array.of(0x7b, 0x7d),
        };
      },
      image: `sha256:${"a".repeat(64)}`,
    });
    const request = new FastManimSandboxRequestBundleV1(sandboxPngProducerRequest(), {
      pngBytes: sandboxPngBytes(),
    });
    const result = await jobs.start(request, { ...context(), attestationDigest: "b".repeat(64) }).result;
    expect(result).toMatchObject({ kind: "ok", requestDigest: request.requestDigest });
    expect(capturedRequestBytes).toEqual(request.copyBytes());
    expect(createHash("sha256").update(capturedRequestBytes!).digest("hex")).toBe(request.requestDigest);
    await expect(jobs.close()).resolves.toBeUndefined();
  });

  it("permanently taints after create dispatch is aborted before an immutable ID is observed", async () => {
    const image = `sha256:${"a".repeat(64)}`;
    const executionController = new AbortController();
    let createDispatched = false;
    let recoveryAttempted = false;
    const jobs = new FastManimGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: new FastManimGatedOciDockerClientV1(),
      executeJob: (options) =>
        runFastManimGatedOciJobV1({
          ...options,
          createUncertainTestSeam: {
            assertTrustedImage: async () => undefined,
            createContainer: (_arguments, _timeoutMs, signal) => {
              createDispatched = true;
              executionController.abort();
              return new Promise((_resolve, reject) => {
                const rejectAbort = () =>
                  reject(new DOMException("The create control process was aborted.", "AbortError"));
                if (signal?.aborted) rejectAbort();
                else signal?.addEventListener("abort", rejectAbort, { once: true });
              });
            },
            recoverContainerByName: async (containerName) => {
              recoveryAttempted = true;
              expect(containerName).toMatch(/^poietra-gated-[a-f0-9]{32}$/);
            },
          },
        }),
      image,
    });
    const request = requestFor(staticScene, "GatedStaticScene");
    const jobContext = { ...context(executionController.signal), attestationDigest: "b".repeat(64) };

    await expect(jobs.start(request, jobContext).result).rejects.toMatchObject({ code: "cleanup" });
    expect({ createDispatched, recoveryAttempted }).toEqual({ createDispatched: true, recoveryAttempted: true });
    expect(jobs.health()).toBe("cleanup-failed");
    expect(() => jobs.start(request, { ...context(), attestationDigest: "c".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "cleanup" }),
    );
    await expect(jobs.close()).rejects.toMatchObject({ code: "cleanup" });
  });
});

describe("gated OCI result boundary", () => {
  it("accepts the locked Python producer's compact, sorted JSON spelling", () => {
    const result = Buffer.from(
      '{"a":-0.0,"b":[0.0001,1.0,1e-07,1e+20,1000000000000000.0,"λ\\n"],"c":{"α":true}}\n',
      "utf8",
    );
    expect(Buffer.from(parseFastManimGatedOciResultV1(result))).toEqual(result.subarray(0, -1));
  });

  it("round-trips a combined envelope beyond the legacy snapshot-only result cap", () => {
    const snapshotJson = JSON.stringify("x".repeat(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES - 2));
    expect(Buffer.byteLength(snapshotJson, "utf8")).toBe(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES);
    const wire = combinedResultWire(snapshotJson);
    expect(wire.byteLength).toBeGreaterThan(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES + 1);
    expect(wire.byteLength).toBeLessThanOrEqual(MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES);

    const body = parseFastManimGatedOciResultV1(wire);
    const producerDocument = parseFastManimProducerDocumentV1(body);
    expect(producerDocument.snapshotJson).toBe(snapshotJson);
    expect(producerDocument.combined?.snapshotDigest).toBe(
      createHash("sha256").update(snapshotJson, "utf8").digest("hex"),
    );
  });

  it("rejects invalid UTF-8 and output beyond the exact result-plus-LF budget", () => {
    const invalidUtf8 = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
    expect(() => parseFastManimGatedOciResultV1(invalidUtf8)).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
    expect(() =>
      parseFastManimGatedOciResultV1(Buffer.alloc(MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES + 1, 0x78)),
    ).toThrowError(expect.objectContaining({ code: "producer-output-overflow" }));
  });

  it.each([
    '{"b":1,"a":2}\n',
    '{"a":1,"a":2}\n',
    '{"a":1.00}\n',
    '{"a":1e+01}\n',
    '{"a":1e-00}\n',
    '{"a":1E+20}\n',
    '{"a":0.00001}\n',
    '{"a":10000000000000000.0}\n',
    '{"a":"\\u03bb"}\n',
    '{ "a":1}\n',
    '{"a":1}\n\n',
  ])("rejects non-canonical result bytes: %s", (result) => {
    expect(() => parseFastManimGatedOciResultV1(Buffer.from(result, "utf8"))).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
  });

  it("rejects JSON nesting beyond the shared snapshot depth budget", () => {
    const nesting = MAX_FAST_MANIM_SNAPSHOT_STRUCTURE_DEPTH + 1;
    const result = `{"a":${"[".repeat(nesting)}0${"]".repeat(nesting)}}\n`;
    expect(() => parseFastManimGatedOciResultV1(Buffer.from(result, "utf8"))).toThrowError(
      expect.objectContaining({ code: "sandbox-result-rejected" }),
    );
  });

  it("rejects arrays, objects, and total entries beyond the shared structural budgets", () => {
    const oversizedArray = `{"a":[${Array.from({ length: MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS + 1 }, () => "0").join(",")}]}\n`;
    const oversizedObject = Object.fromEntries(
      Array.from({ length: MAX_FAST_MANIM_SNAPSHOT_OBJECT_FIELDS + 1 }, (_, index) => [
        `field-${index.toString().padStart(3, "0")}`,
        0,
      ]),
    );
    const tooManyEntries = { a: Array(9_000).fill(0), b: Array(9_000).fill(0), c: Array(9_000).fill(0) };
    for (const result of [
      oversizedArray,
      `${JSON.stringify(oversizedObject)}\n`,
      `${JSON.stringify(tooManyEntries)}\n`,
    ]) {
      expect(() => parseFastManimGatedOciResultV1(Buffer.from(result, "utf8"))).toThrowError(
        expect.objectContaining({ code: "sandbox-result-rejected" }),
      );
    }
  });
});

describe.skipIf(!realLane)("real rootful gated OCI vertical slice", () => {
  const image = realImage!;

  it("reaches READY under the custom seccomp profile, then renders a real Circle, Rectangle, and Line", {
    timeout: 60_000,
  }, async () => {
    const conformance = FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1.supported;
    const source = producerRequestFor(conformance.sourceText, conformance.sceneName, 1, conformance.sourcePath);
    const request = new FastManimSandboxRequestBundleV1(source);
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    expect(execution.evidence).toMatchObject({
      resources: {
        memoryMax: String(512 * 1024 * 1024),
        memorySwapMax: "0",
        pidsMax: "64",
      },
    });
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    expect(snapshot).toMatchObject({ kind: "compiled", requestId: "gated-GatedStaticScene" });
    if (snapshot.kind !== "compiled") throw new Error("Expected a compiled static Scene.");
    expect(snapshot.bundle.scene.entities).toHaveLength(3);
    expect(sourceRuntimeIdentity?.mappings.map((mapping) => mapping.binding.name)).toEqual([
      "circle",
      "rectangle",
      "line",
    ]);
    expect(Buffer.from(execution.resultBytes).includes(Buffer.from("POIETRA_GATE_READY_V1"))).toBe(false);
    for (const sentinel of FAST_MANIM_SANDBOX_CONFORMANCE_LEAK_SENTINELS_V1) {
      expect(Buffer.from(execution.resultBytes).includes(Buffer.from(sentinel))).toBe(false);
    }
  });

  it("loads the pinned native provider and returns a transformed real V3 MathTex outline", {
    timeout: 60_000,
  }, async () => {
    const source = producerRequestFor(mathTexScene, "GatedMathTexScene", 3, "mathtex.py");
    const request = new FastManimSandboxRequestBundleV1(source);
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    if (snapshot.kind !== "compiled") throw new Error("Expected a compiled MathTex V3 snapshot.");
    expect(snapshot.bundle.scene).toMatchObject({
      duration: 2,
      requiredCapabilities: ["cubic-path-geometry"],
      source: { kind: "imported-manim-server-snapshot", snapshotVersion: 3 },
    });
    expect(snapshot.bundle.scene.entities).toHaveLength(1);
    const entity = snapshot.bundle.scene.entities[0]!;
    if (entity.geometry.kind !== "cubic-path" || entity.appearance.kind !== "vector") {
      throw new Error("Expected one vector cubic MathTex outline.");
    }
    expect(entity.geometry.path.subpaths.length).toBeGreaterThan(1);
    expect(entity.geometry.path.subpaths.every((subpath) => subpath.closed && subpath.segments.length > 0)).toBe(true);
    expect(entity.appearance.fill).not.toBeNull();
    expect(entity.appearance.stroke).toBeNull();
    expect(entity.lifetimes).toEqual([{ end: 2, start: 0 }]);
    expect(entity.transform).toEqual({ m11: 0.75, m12: 0, m21: 0, m22: 0.75, tx: -0.25, ty: 0.75 });
    expect(sourceRuntimeIdentity?.mappings).toMatchObject([{ binding: { name: "equation" }, entityId: entity.id }]);
  });

  it("materializes one sealed PNG and returns a real V4 image entity", { timeout: 60_000 }, async () => {
    const source = sandboxPngProducerRequest();
    const pngBytes = sandboxPngBytes();
    const request = new FastManimSandboxRequestBundleV1(source, { pngBytes });
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    if (snapshot.kind !== "compiled") throw new Error("Expected a compiled PNG V4 snapshot.");
    expect(snapshot.bundle.scene).toMatchObject({
      requiredCapabilities: ["png-image"],
      source: { kind: "imported-manim-server-snapshot", snapshotVersion: 4 },
    });
    const asset = snapshot.bundle.assets.assets[0];
    expect(asset).toMatchObject({
      byteLength: pngBytes.byteLength,
      kind: "png-image",
      mediaType: "image/png",
      pixelHeight: 32,
      pixelWidth: 32,
      sha256: createHash("sha256").update(pngBytes).digest("hex"),
    });
    const entity = snapshot.bundle.scene.entities[0];
    expect(entity?.appearance).toEqual({ kind: "image", opacity: 1 });
    expect(entity?.geometry).toMatchObject({
      asset: { assetId: asset?.id, sha256: asset?.sha256 },
      kind: "image",
      sampler: "nearest",
    });
    expect(sourceRuntimeIdentity?.mappings).toMatchObject([{ binding: { name: "image" }, entityId: entity?.id }]);
  });

  it("applies repeated V4 PNG transforms and a terminal wait in the real OCI producer", {
    timeout: 60_000,
  }, async () => {
    const source = sandboxTransformedPngProducerRequest();
    const pngBytes = sandboxPngBytes();
    const request = new FastManimSandboxRequestBundleV1(source, { pngBytes });
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    if (snapshot.kind !== "compiled") throw new Error("Expected a compiled transformed PNG V4 snapshot.");
    expect(snapshot.bundle.scene).toMatchObject({
      duration: 1,
      requiredCapabilities: ["png-image"],
      source: { kind: "imported-manim-server-snapshot", snapshotVersion: 4 },
    });
    expect(snapshot.bundle.scene.entities).toHaveLength(1);
    const entity = snapshot.bundle.scene.entities[0]!;
    if (entity.geometry.kind !== "image") throw new Error("Expected transformed image geometry.");
    const halfExtent =
      ((32 / 1_080) * source.runtimeConfig.frame.height * SANDBOX_TRANSFORMED_PNG_EXPECTED.cumulativeScale) / 2;
    expect(entity.geometry.localRect).toEqual({
      bottom: expect.closeTo(SANDBOX_TRANSFORMED_PNG_EXPECTED.centerY - halfExtent, 13),
      left: expect.closeTo(SANDBOX_TRANSFORMED_PNG_EXPECTED.centerX - halfExtent, 13),
      right: expect.closeTo(SANDBOX_TRANSFORMED_PNG_EXPECTED.centerX + halfExtent, 13),
      top: expect.closeTo(SANDBOX_TRANSFORMED_PNG_EXPECTED.centerY + halfExtent, 13),
    });
    expect(sourceRuntimeIdentity?.mappings).toMatchObject([{ binding: { name: "image" }, entityId: entity.id }]);
  });

  it("returns unsupported when a V4 prelude disagrees with the pinned producer contract", {
    timeout: 60_000,
  }, async () => {
    const canonical = sandboxPngProducerRequest();
    const sourceText = canonical.sourceText.replace('"image.png"', '"other.png"');
    const source = {
      ...canonical,
      requestId: "snapshot-png-prelude-drift",
      sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
      sourceText,
    };
    const request = new FastManimSandboxRequestBundleV1(source, { pngBytes: sandboxPngBytes() });
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    expect(snapshot).toMatchObject({
      kind: "unsupported",
      requestId: source.requestId,
    });
    if (snapshot.kind !== "unsupported") {
      throw new Error("The pinned V4 producer compiled a source outside its constructor contract.");
    }
    expect(snapshot.issues).toEqual([expect.objectContaining({ code: "runtime-semantics-unsupported", evidence: [] })]);
    expect(sourceRuntimeIdentity).toBeNull();
  });

  it("isolates, seals, and correlates real V2 opacity/lifetime evidence", { timeout: 60_000 }, async () => {
    const source = producerRequestFor(opacityLifetimeScene, "GatedOpacityLifetimeScene", 2);
    const request = new FastManimSandboxRequestBundleV1(source);
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    if (snapshot.kind !== "compiled") throw new Error("Expected compiled opacity/lifetime evidence.");
    expect(snapshot.bundle.scene).toMatchObject({
      duration: 6,
      requiredCapabilities: ["cubic-path-geometry", "opacity-animation"],
    });
    expect(snapshot.bundle.scene.entities[0]?.lifetimes).toEqual([{ end: 6, start: 1 }]);
    expect(snapshot.bundle.scene.animationChannels[0]).toMatchObject({
      entityId: `${source.sceneId}/entity:0`,
      keyframes: [
        { at: 1, value: 0 },
        { at: 3, value: 1 },
        { at: 4, value: 1 },
        { at: 6, value: 0 },
      ],
      kind: "opacity",
    });
    expect(sourceRuntimeIdentity?.mappings).toMatchObject([
      {
        binding: { name: "circle", ordinal: 1 },
        entityId: `${source.sceneId}/entity:0`,
      },
    ]);
  });

  it("isolates, seals, and correlates the real V2 affine fixture", { timeout: 60_000 }, async () => {
    const source = producerRequestFor(affineScene, "DynamicAffineScene", 2);
    const request = new FastManimSandboxRequestBundleV1(source);
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    if (snapshot.kind !== "compiled") throw new Error("Expected compiled affine evidence.");
    expect(snapshot.bundle.scene).toMatchObject({
      duration: 7,
      requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry"],
    });
    expect(snapshot.bundle.scene.entities).toHaveLength(7);
    expect(snapshot.bundle.scene.animationChannels).toHaveLength(6);
    expect(snapshot.bundle.scene.animationChannels.map((channel) => channel.kind)).toEqual(
      Array.from({ length: 6 }, () => "affine-transform"),
    );
    expect(snapshot.bundle.scene.animationChannels.at(-1)).toMatchObject({
      entityId: `${source.sceneId}/entity:6`,
      keyframes: [
        { at: 5, value: { m11: 1, m22: 1, tx: 0, ty: 0 } },
        { at: 6, value: { m11: -1, m22: 1, tx: 6, ty: 0 } },
      ],
      kind: "affine-transform",
    });
    expect(sourceRuntimeIdentity?.mappings.map((mapping) => mapping.binding.name)).toEqual([
      "sentinel",
      "translation",
      "rotation",
      "scale",
      "stretch",
      "shear",
      "reflection",
    ]);
  });

  it("isolates, seals, and correlates real V2 uniform-cubic path trims", { timeout: 60_000 }, async () => {
    const source = producerRequestFor(pathTrimScene, "DynamicPathTrimScene", 2);
    const request = new FastManimSandboxRequestBundleV1(source);
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    if (snapshot.kind !== "compiled") throw new Error("Expected compiled path-trim evidence.");
    expect(snapshot.bundle.scene.requiredCapabilities).toEqual(["cubic-path-geometry", "path-trim-animation"]);
    const pathTrimChannels = snapshot.bundle.scene.animationChannels.filter((channel) => channel.kind === "path-trim");
    expect(pathTrimChannels).toHaveLength(4);
    expect(pathTrimChannels.every((channel) => channel.parameterization === "uniform-cubic-parameter-v1")).toBe(true);
    expect(
      new Set(pathTrimChannels.map((channel) => channel.keyframes.map((keyframe) => keyframe.value).join(","))),
    ).toEqual(new Set(["0,1", "1,0", "0,1,0", "0,1,1,0"]));
    const entitiesById = new Map(snapshot.bundle.scene.entities.map((entity) => [entity.id, entity]));
    expect(
      pathTrimChannels.every((channel) => {
        const entity = entitiesById.get(channel.entityId);
        return (
          entity?.appearance.kind === "vector" && entity.appearance.fill === null && entity.appearance.stroke !== null
        );
      }),
    ).toBe(true);
    expect(sourceRuntimeIdentity?.mappings.map((mapping) => mapping.binding.name)).toEqual(
      expect.arrayContaining(["sentinel", "circle", "rectangle", "line"]),
    );
  });

  it("isolates and correlates real compatible path morphs", { timeout: 60_000 }, async () => {
    const source = producerRequestFor(pathMorphScene, "DynamicPathMorphScene", 2);
    const request = new FastManimSandboxRequestBundleV1(source);
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    if (snapshot.kind !== "compiled") throw new Error("Expected compiled path-morph evidence.");
    expect(snapshot.bundle.scene).toMatchObject({
      duration: 5,
      requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
    });
    expect(snapshot.bundle.scene.entities).toHaveLength(3);
    const channels = snapshot.bundle.scene.animationChannels;
    expect(channels).toHaveLength(2);
    const [shapeMorph, lineMorph] = channels;
    if (shapeMorph?.kind !== "path-morph" || lineMorph?.kind !== "path-morph") {
      throw new Error("Expected only path-morph channels.");
    }
    expect(shapeMorph.entityId).toBe(`${source.sceneId}/entity:1`);
    expect(shapeMorph.keyframes.map((keyframe) => keyframe.at)).toEqual([0, 1, 2, 3]);
    expect(shapeMorph.keyframes[0]?.value).toEqual(shapeMorph.keyframes[3]?.value);
    expect(shapeMorph.keyframes[0]?.value).not.toEqual(shapeMorph.keyframes[1]?.value);
    expect(shapeMorph.keyframes[1]?.value).toEqual(shapeMorph.keyframes[2]?.value);
    expect(lineMorph.entityId).toBe(`${source.sceneId}/entity:2`);
    expect(lineMorph.keyframes.map((keyframe) => keyframe.at)).toEqual([3, 4]);
    expect(lineMorph.keyframes[0]?.value).not.toEqual(lineMorph.keyframes[1]?.value);
    expect(sourceRuntimeIdentity?.mappings.map((mapping) => mapping.binding.name)).toEqual([
      "sentinel",
      "shape",
      "line",
    ]);
  });

  it("isolates and seals real open and closed MoveAlongPath channels", { timeout: 60_000 }, async () => {
    const source = producerRequestFor(motionPathScene, "DynamicMotionPathScene", 2);
    const request = new FastManimSandboxRequestBundleV1(source);
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    expect(execution.cleanupVerified).toBe(true);
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    if (snapshot.kind !== "compiled") throw new Error("Expected compiled motion-path evidence.");

    expect(snapshot.bundle.scene).toMatchObject({
      duration: 3,
      requiredCapabilities: ["cubic-path-geometry", "motion-path-animation"],
    });
    expect(snapshot.bundle.scene.entities).toHaveLength(3);
    expect(snapshot.bundle.scene.entities.map((entity) => entity.lifetimes)).toEqual([
      [{ end: 3, start: 0 }],
      [{ end: 3, start: 0 }],
      [{ end: 3, start: 1 }],
    ]);
    const channels = snapshot.bundle.scene.animationChannels;
    expect(channels).toHaveLength(2);
    expect(channels.map((channel) => channel.kind)).toEqual(["motion-path", "motion-path"]);
    for (const [index, channel] of channels.entries()) {
      if (channel.kind !== "motion-path") throw new Error("Expected only motion-path channels.");
      expect(channel).toMatchObject({
        entityId: `${source.sceneId}/entity:${index + 1}`,
        id: `${source.sceneId}/channel:motion-path:${index + 1}`,
        orientToPath: false,
        parameterization: "manim-point-from-proportion-v1",
        provenanceId: `${source.sceneId}/provenance:channel:motion-path:${index + 1}`,
      });
      expect(channel.keyframes.map(({ at, value }) => ({ at, value }))).toEqual([
        { at: index, value: 0 },
        { at: index + 1, value: 1 },
      ]);
    }
    if (channels[0]?.kind !== "motion-path" || channels[1]?.kind !== "motion-path") {
      throw new Error("Expected motion-path channel narrowing.");
    }
    expect(channels[0].path.subpaths[0]?.closed).toBe(false);
    expect(channels[0].path.subpaths[0]?.segments).toHaveLength(1);
    expect(channels[1].path.subpaths[0]?.closed).toBe(true);
    expect(channels[1].path.subpaths[0]?.segments).toHaveLength(8);
    expect(sourceRuntimeIdentity?.mappings.map((mapping) => mapping.binding.name)).toEqual([
      "sentinel",
      "rectangle",
      "circle",
    ]);
  });

  it("does not quarantine an abort observed after known-ID cleanup was verified", { timeout: 60_000 }, async () => {
    const executionController = new AbortController();
    let verifiedCleanupReached = false;
    const jobs = new FastManimGatedOciJobRunnerV1({
      cgroupKillPolicy: "best-effort",
      dockerClient: new FastManimGatedOciDockerClientV1(),
      executeJob: (options) =>
        runFastManimGatedOciJobV1({
          ...options,
          afterVerifiedCleanupForTesting: () => {
            verifiedCleanupReached = true;
            executionController.abort();
          },
        }),
      image,
    });
    const request = requestFor(staticScene, "GatedStaticScene");

    await expect(
      jobs.start(request, {
        ...context(executionController.signal),
        attestationDigest: "b".repeat(64),
      }).result,
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(verifiedCleanupReached).toBe(true);
    expect(jobs.health()).toBe("open");
    await expect(jobs.close()).resolves.toBeUndefined();
  });

  it("interrupts pre-launch execution and image inspection on abort", { timeout: 30_000 }, async () => {
    const request = requestFor(staticScene, "GatedStaticScene");
    const executionController = new AbortController();
    const execution = runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: executionController.signal,
    });
    executionController.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });

    const inspectionController = new AbortController();
    const inspection = assertFastManimGatedOciImageV1(
      image,
      new FastManimGatedOciDockerClientV1(),
      Date.now() + 30_000,
      inspectionController.signal,
    );
    inspectionController.abort();
    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects wrong digest, wrong length, early EOF, and trailing bytes at the entrypoint", {
    timeout: 60_000,
  }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const cases = [
      wire(body, { digest: Buffer.alloc(32, 0xa5) }),
      wire(body, { length: body.byteLength - 1 }),
      wire(body, { length: body.byteLength + 1 }),
      Buffer.concat([wire(body), Buffer.from("x")]),
    ];
    for (const bytes of cases) {
      const error = await runFastManimGatedOciJobV1({
        conformanceWire: { bytes, close: true },
        deadlineEpochMs: Date.now() + 15_000,
        image,
        requestBytes: body,
        signal: new AbortController().signal,
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(FastManimGatedOciError);
      expect(error).toMatchObject({ cleanupVerified: true, code: "producer-exit" });
    }
  });

  it("times out a body that never reaches EOF and still removes its PID and container", {
    timeout: 30_000,
  }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const error = await runFastManimGatedOciJobV1({
      conformanceWire: { bytes: wire(body), close: false },
      deadlineEpochMs: Date.now() + 1_200,
      image,
      requestBytes: body,
      signal: new AbortController().signal,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(FastManimGatedOciError);
    expect(error).toMatchObject({ cleanupVerified: true, code: "producer-timeout" });
  });

  it("aborts a gated body waiting for EOF and proves cleanup", { timeout: 30_000 }, async () => {
    const body = requestFor(staticScene, "GatedStaticScene").copyBytes();
    const controller = new AbortController();
    const running = runFastManimGatedOciJobV1({
      conformanceWire: { bytes: wire(body), close: false },
      deadlineEpochMs: Date.now() + 20_000,
      image,
      requestBytes: body,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 750).unref();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns the shared unsupported Scene as bounded structured evidence", { timeout: 60_000 }, async () => {
    const conformance = FAST_MANIM_SANDBOX_CONFORMANCE_CASES_V1.unsupported;
    const source = producerRequestFor(conformance.sourceText, conformance.sceneName, 1, conformance.sourcePath);
    const request = new FastManimSandboxRequestBundleV1(source);
    const execution = await runFastManimGatedOciJobV1({
      deadlineEpochMs: Date.now() + 30_000,
      image,
      requestBytes: request.copyBytes(),
      signal: new AbortController().signal,
    });
    const { snapshot, sourceRuntimeIdentity } = await verifyCombinedResult(execution.resultBytes, source);
    expect(snapshot).toMatchObject({ kind: conformance.expectedKind, requestId: `gated-${conformance.sceneName}` });
    if (snapshot.kind !== "unsupported") {
      throw new Error("Expected the shared unsupported conformance Scene to remain unsupported.");
    }
    expect(sourceRuntimeIdentity).toBeNull();
    expect(snapshot.issues.length).toBeGreaterThan(0);
    expect(snapshot.issues.every((issue) => issue.evidence.length === 0)).toBe(true);
    for (const sentinel of FAST_MANIM_SANDBOX_CONFORMANCE_LEAK_SENTINELS_V1) {
      expect(Buffer.from(execution.resultBytes).includes(Buffer.from(sentinel))).toBe(false);
    }
  });
});
