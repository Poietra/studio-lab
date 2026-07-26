import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";
import {
  digestFastManimSnapshotBundleV1,
  type ExpectedFastManimSnapshotCorrelationV1,
  MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS,
  MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";

const expected = {
  projectId: "workspace-a",
  requestId: "snapshot-request-a",
  runtimeConfigHash: "b".repeat(64),
  sceneId: "examples/scene.py#ExampleScene",
  sceneName: "ExampleScene",
  sourceHash: "a".repeat(64),
  sourcePath: "examples/scene.py",
} satisfies ExpectedFastManimSnapshotCorrelationV1;

async function importedBundle(): Promise<SceneIrBundleV1> {
  const url = new URL("../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as { assets: unknown; scene: Record<string, unknown> };
  const draft = sceneIrBundleV1Schema.parse({
    assets: fixture.assets,
    scene: {
      ...fixture.scene,
      provenance: [
        {
          evidence: ["fast-manim static snapshot"],
          id: "fixture",
          origin: "fast-manim-server-snapshot",
        },
      ],
      sceneId: expected.sceneId,
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: expected.runtimeConfigHash,
        snapshotHash: ZERO_SHA256,
        snapshotVersion: 1,
        sourceHash: expected.sourceHash,
      },
    },
  });
  return draft;
}

function compiled(bundle: SceneIrBundleV1) {
  if (bundle.scene.source.kind !== "imported-manim-server-snapshot") throw new Error("Expected imported source.");
  return {
    ...expected,
    bundle,
    kind: "compiled" as const,
    schema: "poietra.fast-manim-snapshot-result" as const,
    snapshotHash: bundle.scene.source.snapshotHash,
    version: 1 as const,
  };
}

function parseProducer(value: unknown, expectedValue: ExpectedFastManimSnapshotCorrelationV1 = expected) {
  return parseAndSealFastManimSnapshotProducerJsonV1(JSON.stringify(value), expectedValue);
}

describe("fast-manim snapshot result v1", () => {
  it("verifies a compiled Scene bundle and accepts a closed unsupported result", async () => {
    const bundle = await importedBundle();
    const sealed = await parseProducer(compiled(bundle), expected);
    expect(sealed).toMatchObject({ kind: "compiled" });
    if (sealed.kind !== "compiled" || sealed.bundle.scene.source.kind !== "imported-manim-server-snapshot") {
      throw new Error("Expected a compiled imported snapshot.");
    }
    expect(sealed.snapshotHash).not.toBe(ZERO_SHA256);
    expect(sealed.bundle.scene.source.snapshotHash).toBe(sealed.snapshotHash);
    expect(digestFastManimSnapshotBundleV1(sealed.bundle)).toBe(sealed.snapshotHash);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expected)).resolves.toEqual(sealed);
    await expect(parseProducer(sealed, expected)).rejects.toMatchObject({
      code: "snapshot-not-unsealed",
    });
    await expect(
      parseProducer(
        {
          ...expected,
          issues: [
            {
              code: "geometry-evidence-incomplete",
              evidence: ["RenderTrace v0 exposes only a bounding box and hash"],
              message: "Complete cubic geometry is unavailable.",
            },
          ],
          kind: "unsupported",
          schema: "poietra.fast-manim-snapshot-result",
          version: 1,
        },
        expected,
      ),
    ).resolves.toMatchObject({ kind: "unsupported" });
  });

  it("rejects unknown fields and newer envelope versions", async () => {
    const value = compiled(await importedBundle());
    await expect(parseProducer({ ...value, unexpected: true }, expected)).rejects.toThrow();
    await expect(parseProducer({ ...value, version: 2 }, expected)).rejects.toThrow();
    await expect(
      parseProducer({ ...value, sceneName: `S${"x".repeat(240)}` }, { ...expected, sceneName: `S${"x".repeat(240)}` }),
    ).rejects.toThrow();
    await expect(
      parseProducer(
        { ...value, bundle: { ...value.bundle, scene: { ...value.bundle.scene, unexpected: true } } },
        expected,
      ),
    ).rejects.toThrow();
    await expect(
      parseProducer(
        {
          ...value,
          bundle: {
            ...value.bundle,
            scene: { ...value.bundle.scene, source: { ...value.bundle.scene.source, snapshotVersion: 2 } },
          },
        },
        expected,
      ),
    ).rejects.toThrow();
  });

  it("rejects bundles above the initial snapshot budget before structural parsing", async () => {
    const value = compiled(await importedBundle());
    await expect(
      parseProducer({ ...value, bundle: "x".repeat(MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES) }, expected),
    ).rejects.toThrow(/encoded bytes/i);
  });

  it("bounds raw producer bytes and structural complexity before Zod parsing", async () => {
    expect(() =>
      parseAndSealFastManimSnapshotProducerJsonV1(" ".repeat(MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES + 1), expected),
    ).toThrowError(expect.objectContaining({ code: "result-too-large" }));
    expect(() => parseAndSealFastManimSnapshotProducerJsonV1(new Uint8Array([0xff]), expected)).toThrowError(
      expect.objectContaining({ code: "result-malformed" }),
    );

    const value = compiled(await importedBundle());
    const amplified = {
      ...value,
      bundle: {
        ...value.bundle,
        scene: {
          ...value.bundle.scene,
          entities: Array<null>(MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS + 1).fill(null),
        },
      },
    };
    await expect(parseProducer(amplified)).rejects.toMatchObject({ code: "result-too-complex" });

    const wideObject = {
      ...value,
      bundle: Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`field-${index}`, index])),
    };
    await expect(parseProducer(wideObject)).rejects.toMatchObject({ code: "result-too-complex" });
  });

  it("validates the exact JSON wire representation used for byte limits", async () => {
    const wireBundle = await importedBundle();
    const disguisedBundle = structuredClone(wireBundle);
    disguisedBundle.scene.camera.background.red = 0.75;
    Object.defineProperty(disguisedBundle, "toJSON", {
      enumerable: false,
      value: () => wireBundle,
    });

    const sealed = await parseProducer(compiled(disguisedBundle), expected);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    expect(sealed.bundle.scene.camera.background.red).toBe(wireBundle.scene.camera.background.red);
  });

  it("bounds the total encoded unsupported evidence", async () => {
    const issue = {
      code: "geometry-evidence-incomplete",
      evidence: Array<string>(64).fill("x".repeat(500)),
      message: "Complete geometry is unavailable.",
    };
    await expect(
      parseProducer(
        {
          ...expected,
          issues: Array<typeof issue>(9).fill(issue),
          kind: "unsupported",
          schema: "poietra.fast-manim-snapshot-result",
          version: 1,
        },
        expected,
      ),
    ).rejects.toThrow(/encoded bytes/i);
  });

  it("rejects stale outer request and source correlation", async () => {
    const value = compiled(await importedBundle());
    for (const stale of [
      { requestId: "snapshot-request-b" },
      { sceneId: "examples/scene.py#OtherScene" },
      { sourceHash: "c".repeat(64) },
      { runtimeConfigHash: "d".repeat(64) },
    ]) {
      await expect(parseProducer({ ...value, ...stale }, expected)).rejects.toMatchObject({
        code: "correlation-mismatch",
      });
    }

    await expect(
      parseProducer({ ...value, sourceHash: "c".repeat(64) }, { ...expected, sourceHash: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "snapshot-source-mismatch" });
  });

  it("rejects non-imported source evidence and missing fast-manim provenance", async () => {
    const bundle = await importedBundle();
    const studioSource = {
      ...bundle,
      scene: {
        ...bundle.scene,
        source: { editProgramVersion: 1 as const, kind: "studio-edit-program" as const, revisionHash: "e".repeat(64) },
      },
    };
    await expect(parseProducer({ ...compiled(bundle), bundle: studioSource }, expected)).rejects.toMatchObject({
      code: "source-kind-mismatch",
    });

    const withoutProvenance = {
      ...bundle,
      scene: {
        ...bundle.scene,
        provenance: bundle.scene.provenance.map((record) => ({ ...record, origin: "fixture" as const })),
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(withoutProvenance), expected)).rejects.toMatchObject({
      code: "provenance-missing",
    });

    const unreferencedFastProvenance = {
      ...bundle,
      scene: {
        ...bundle.scene,
        provenance: [
          ...bundle.scene.provenance.map((record) => ({ ...record, origin: "fixture" as const })),
          { evidence: ["unreferenced"], id: "dummy", origin: "fast-manim-server-snapshot" as const },
        ],
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(unreferencedFastProvenance))).rejects.toMatchObject({
      code: "provenance-missing",
    });
  });

  it("rejects canonical snapshot tampering, malformed bundles, and invalid manifest digests", async () => {
    const bundle = await importedBundle();
    const value = compiled(bundle);
    const sealed = await parseProducer(value);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    const tampered = {
      ...sealed,
      bundle: {
        ...sealed.bundle,
        scene: {
          ...sealed.bundle.scene,
          camera: {
            ...sealed.bundle.scene.camera,
            background: { ...sealed.bundle.scene.camera.background, red: 0.5 },
          },
        },
      },
    };
    await expect(parseVerifiedFastManimSnapshotResultV1(tampered, expected)).rejects.toMatchObject({
      code: "snapshot-digest-mismatch",
    });

    const downgraded = {
      ...tampered,
      bundle: {
        ...tampered.bundle,
        scene: {
          ...tampered.bundle.scene,
          source: { ...tampered.bundle.scene.source, snapshotHash: ZERO_SHA256 },
        },
      },
      snapshotHash: ZERO_SHA256,
    };
    await expect(parseVerifiedFastManimSnapshotResultV1(downgraded, expected)).rejects.toMatchObject({
      code: "snapshot-not-sealed",
    });
    await expect(parseProducer({ ...value, bundle: null }, expected)).rejects.toThrow();

    const manifestDigest = "f".repeat(64);
    const invalidManifest = {
      ...bundle,
      assets: { ...bundle.assets, manifestDigest },
      scene: { ...bundle.scene, assetManifest: { ...bundle.scene.assetManifest, manifestDigest } },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(invalidManifest), expected)).rejects.toThrow(/manifest digest/i);
  });
});
