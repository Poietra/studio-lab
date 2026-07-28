import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { digestAssetManifestV1, type SceneIrBundleV1, sceneIrBundleV1Schema } from "../src/engine/contracts";
import {
  digestFastManimSnapshotBundleV1,
  expectedFastManimSnapshotCorrelationV1Schema,
  type ExpectedFastManimSnapshotCorrelationV1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1,
  FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2,
  FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1,
  fastManimSnapshotOpacityChannelIdV2,
  fastManimSnapshotOpacityChannelProvenanceIdV2,
  fastManimSnapshotRunViewV1Schema,
  fastManimSnapshotSceneIdV1,
  isCanonicalFastManimLineSegmentV1,
  MAX_FAST_MANIM_SNAPSHOT_ARRAY_ITEMS,
  MAX_FAST_MANIM_SNAPSHOT_BUNDLE_JSON_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
  parseAndSealFastManimSnapshotProducerJsonV1,
  parseVerifiedFastManimSnapshotResultV1,
  ZERO_SHA256,
} from "./fast-manim-snapshot-contract";

const expected = {
  frame: { height: 8, width: 14.222222222222221 },
  projectId: "workspace-a",
  requestId: "snapshot-request-a",
  runtimeConfigHash: "b".repeat(64),
  snapshotVersion: 1,
  sceneId: fastManimSnapshotSceneIdV1("examples/scene.py", "ExampleScene"),
  sceneName: "ExampleScene",
  sourceHash: "a".repeat(64),
  sourcePath: "examples/scene.py",
} satisfies ExpectedFastManimSnapshotCorrelationV1;

// The wire correlation fields a producer result envelope carries: the frame
// is server-side expected state only and never appears on the wire.
const { frame: _serverOnlyFrame, snapshotVersion: _serverOnlySnapshotVersion, ...wireCorrelation } = expected;

type FixtureIdRecord = Record<string, unknown> & {
  entityId?: string;
  id: string;
  kind?: string;
  parentId?: string | null;
  provenanceId?: string;
  sceneOrder?: number;
};

async function importedBundle(): Promise<SceneIrBundleV1> {
  // The exporter's static v1 shape: cubic-path-only entities, no animation
  // channels, 1-second duration — never the shared animated engine fixture.
  const url = new URL("./test-fixtures/fast-manim-static-bundle.json", import.meta.url);
  const fixture = JSON.parse(await readFile(url, "utf8")) as {
    assets: Record<string, unknown>;
    scene: Record<string, unknown> & { entities: FixtureIdRecord[] };
  };
  // Every identifier is the exact deterministic ID the mutual
  // exporter/server rule derives from the Scene identity and the validated
  // enumerate order: `entity:${sceneOrder}`, `manifest`, one
  // `provenance:scene` record, and one `provenance:entity:${sceneOrder}`
  // record per entity in order.
  const ns = (suffix: string) => `${expected.sceneId}/${suffix}`;
  const entityProvenanceId = (sceneOrder: number) => ns(`provenance:entity:${sceneOrder}`);
  const manifestId = ns("manifest");
  const manifestDigest = await digestAssetManifestV1({
    assets: [],
    manifestDigest: ZERO_SHA256,
    manifestId,
    schema: "poietra.asset-manifest",
    version: 1,
  });
  const draft = sceneIrBundleV1Schema.parse({
    assets: { assets: [], manifestDigest, manifestId, schema: "poietra.asset-manifest", version: 1 },
    scene: {
      ...fixture.scene,
      animationChannels: [],
      assetManifest: { manifestDigest, manifestId },
      entities: fixture.scene.entities.map((entity, index) => ({
        ...entity,
        id: ns(`entity:${index}`),
        parentId: null,
        provenanceId: entityProvenanceId(index),
      })),
      provenance: [
        {
          evidence: ["fast-manim static snapshot"],
          id: ns("provenance:scene"),
          origin: "fast-manim-server-snapshot",
        },
        ...fixture.scene.entities.map((_, index) => ({
          evidence: ["fast-manim static snapshot"],
          id: entityProvenanceId(index),
          origin: "fast-manim-server-snapshot",
        })),
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

async function dynamicOpacityBundle(): Promise<SceneIrBundleV1> {
  const base = await importedBundle();
  const duration = 6;
  const entity = { ...base.scene.entities[0]!, lifetimes: [{ end: duration, start: 1 }] };
  const channelProvenanceId = fastManimSnapshotOpacityChannelProvenanceIdV2(expected.sceneId, 0);
  return sceneIrBundleV1Schema.parse({
    ...base,
    scene: {
      ...base.scene,
      animationChannels: [
        {
          entityId: entity.id,
          id: fastManimSnapshotOpacityChannelIdV2(expected.sceneId, 0),
          keyframes: [
            { at: 1, easingToNext: { kind: "linear" }, value: 0 },
            { at: 3, easingToNext: { kind: "linear" }, value: 1 },
            { at: 4, easingToNext: { kind: "linear" }, value: 1 },
            { at: 6, easingToNext: null, value: 0 },
          ],
          kind: "opacity",
          provenanceId: channelProvenanceId,
        },
      ],
      duration,
      entities: [entity],
      provenance: [
        base.scene.provenance[0],
        base.scene.provenance[1],
        {
          evidence: ["producer-authored opacity evidence must be normalized"],
          id: channelProvenanceId,
          origin: "fast-manim-server-snapshot",
        },
      ],
      requiredCapabilities: ["cubic-path-geometry", "opacity-animation"],
      source: { ...base.scene.source, snapshotVersion: 2 },
    },
  });
}

function compiled(bundle: SceneIrBundleV1) {
  if (bundle.scene.source.kind !== "imported-manim-server-snapshot") throw new Error("Expected imported source.");
  return {
    ...wireCorrelation,
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

function offsetRawF64Bits(value: number, offset: bigint) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value);
  buffer.writeBigUInt64BE(buffer.readBigUInt64BE() + offset);
  return buffer.readDoubleBE();
}

describe("canonical fast-manim Line cubic", () => {
  const start = { x: -4, y: 2 };
  const end = { x: 4, y: 2 };
  const canonical = {
    control1: { x: start.x + (end.x - start.x) / 3, y: 2 },
    control2: { x: start.x + ((end.x - start.x) * 2) / 3, y: 2 },
    end,
  };

  it("accepts the actual exporter control that differs by one ordered-f64 ULP", () => {
    expect(
      isCanonicalFastManimLineSegmentV1(start, {
        ...canonical,
        control1: { x: -1.3333333333333337, y: 2 },
        control2: { x: 1.333333333333333, y: 2 },
      }),
    ).toBe(true);
  });

  it("rejects two ULP drift and arbitrary collinear controls", () => {
    expect(
      isCanonicalFastManimLineSegmentV1(start, {
        ...canonical,
        control1: { ...canonical.control1, x: offsetRawF64Bits(canonical.control1.x, 2n) },
      }),
    ).toBe(false);
    expect(isCanonicalFastManimLineSegmentV1(start, { control1: start, control2: end, end })).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite control at the helper boundary (%s)",
    (value) => {
      expect(
        isCanonicalFastManimLineSegmentV1(start, {
          ...canonical,
          control2: { ...canonical.control2, y: value },
        }),
      ).toBe(false);
    },
  );
});

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
    expect(sealed.bundle.scene.provenance[0]?.evidence).toEqual([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V1]);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expected)).resolves.toEqual(sealed);
    await expect(parseProducer(sealed, expected)).rejects.toMatchObject({
      code: "snapshot-not-unsealed",
    });
    await expect(
      parseProducer(
        {
          ...wireCorrelation,
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

  it("seals a bounded variable-duration V2 still while keeping versions correlated", async () => {
    const v1 = await importedBundle();
    const duration = 2.5;
    const v2 = sceneIrBundleV1Schema.parse({
      ...v1,
      scene: {
        ...v1.scene,
        duration,
        entities: v1.scene.entities.map((entity) => ({ ...entity, lifetimes: [{ start: 0, end: duration }] })),
        source: { ...v1.scene.source, snapshotVersion: 2 },
      },
    });
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const sealed = await parseProducer(compiled(v2), expectedV2);
    if (sealed.kind !== "compiled" || sealed.bundle.scene.source.kind !== "imported-manim-server-snapshot") {
      throw new Error("Expected a compiled V2 snapshot.");
    }
    expect(sealed.bundle.scene.duration).toBe(duration);
    expect(sealed.bundle.scene.entities.every((entity) => entity.lifetimes[0]?.end === duration)).toBe(true);
    expect(sealed.bundle.scene.source.snapshotVersion).toBe(2);
    expect(sealed.bundle.scene.provenance[0]?.evidence).toEqual([FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2]);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV2)).resolves.toEqual(sealed);
    const floatLexeme = JSON.stringify(compiled(v2)).replace('"snapshotVersion":2', '"snapshotVersion":2.0');
    await expect(parseAndSealFastManimSnapshotProducerJsonV1(floatLexeme, expectedV2)).resolves.toMatchObject({
      kind: "compiled",
    });
    await expect(parseProducer(compiled(v2), expected)).rejects.toMatchObject({ code: "snapshot-source-mismatch" });
    await expect(parseProducer(compiled(v1), expectedV2)).rejects.toMatchObject({ code: "snapshot-source-mismatch" });

    const legacyDuration = 0.51;
    const legacyFrozenWait = sceneIrBundleV1Schema.parse({
      ...v2,
      scene: {
        ...v2.scene,
        duration: legacyDuration,
        entities: v2.scene.entities.map((entity) => ({
          ...entity,
          lifetimes: [{ end: legacyDuration, start: 0 }],
        })),
      },
    });
    await expect(parseProducer(compiled(legacyFrozenWait), expectedV2)).resolves.toMatchObject({ kind: "compiled" });

    const tooLong = {
      ...v2,
      scene: {
        ...v2.scene,
        duration: 3_600.001,
        entities: v2.scene.entities.map((entity) => ({ ...entity, lifetimes: [{ start: 0, end: 3_600.001 }] })),
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(tooLong), expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("seals producer-shaped V2 membership and linear opacity evidence", async () => {
    const bundle = await dynamicOpacityBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const sealed = await parseProducer(compiled(bundle), expectedV2);
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled dynamic V2 snapshot.");

    expect(sealed.bundle.scene.duration).toBe(6);
    expect(sealed.bundle.scene.entities[0]?.lifetimes).toEqual([{ end: 6, start: 1 }]);
    expect(sealed.bundle.scene.animationChannels).toEqual(bundle.scene.animationChannels);
    expect(sealed.bundle.scene.provenance.every((record) => record.evidence.length === 1)).toBe(true);
    expect(
      sealed.bundle.scene.provenance.every(
        (record) => record.evidence[0] === FAST_MANIM_SNAPSHOT_PROVENANCE_EVIDENCE_V2,
      ),
    ).toBe(true);
    await expect(parseVerifiedFastManimSnapshotResultV1(sealed, expectedV2)).resolves.toEqual(sealed);

    const membershipOnly = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        animationChannels: [],
        duration: 3,
        entities: bundle.scene.entities.map((entity) => ({ ...entity, lifetimes: [{ end: 3, start: 1 }] })),
        provenance: bundle.scene.provenance.slice(0, 2),
        requiredCapabilities: ["cubic-path-geometry"],
      },
    });
    await expect(parseProducer(compiled(membershipOnly), expectedV2)).resolves.toMatchObject({ kind: "compiled" });

    const cumulativeDuration = 23 / 60;
    const cumulativeGrid = sceneIrBundleV1Schema.parse({
      ...bundle,
      scene: {
        ...bundle.scene,
        animationChannels: bundle.scene.animationChannels.map((channel) => ({
          ...channel,
          keyframes: [
            { at: 0, easingToNext: { kind: "linear" }, value: 0 },
            { at: 22 / 60, easingToNext: null, value: 1 },
          ],
        })),
        duration: cumulativeDuration,
        entities: bundle.scene.entities.map((entity) => ({
          ...entity,
          lifetimes: [{ end: cumulativeDuration, start: 0 }],
        })),
      },
    });
    await expect(parseProducer(compiled(cumulativeGrid), expectedV2)).resolves.toMatchObject({ kind: "compiled" });
  });

  it("rejects schema-valid opacity/lifetime evidence outside the exact producer profile", async () => {
    const bundle = await dynamicOpacityBundle();
    const expectedV2 = { ...expected, snapshotVersion: 2 } as const;
    const scene = bundle.scene;
    const channel = scene.animationChannels[0]!;
    if (channel.kind !== "opacity") throw new Error("Expected the opacity fixture channel.");
    const mutate = (patch: Partial<typeof scene>) => ({ ...bundle, scene: { ...scene, ...patch } }) as SceneIrBundleV1;
    const mutateChannel = (patch: Partial<typeof channel>) =>
      mutate({ animationChannels: [{ ...channel, ...patch }] } as Partial<typeof scene>);

    await expect(
      parseProducer(
        compiled(mutate({ provenance: [scene.provenance[0]!, scene.provenance[2]!, scene.provenance[1]!] })),
        expectedV2,
      ),
    ).rejects.toMatchObject({
      code: "profile-violation",
      message:
        "Dynamic profile V2 provenance must be exactly the derived scene, per-entity, and per-opacity-channel records in order.",
    });

    const profileViolations = [
      mutate({ duration: 6.01 } as Partial<typeof scene>),
      mutate({
        entities: scene.entities.map((entity) => ({ ...entity, lifetimes: [{ end: 6, start: 1.01 }] })),
      } as Partial<typeof scene>),
      mutateChannel({ id: `${expected.sceneId}/channel:opacity:999` }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) => (index === 1 ? { ...keyframe, value: 0.5 } : keyframe)),
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === 0 ? { ...keyframe, easingToNext: { kind: "smooth" as const } } : keyframe,
        ),
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) => (index === 1 ? { ...keyframe, at: 3.01 } : keyframe)),
      }),
      mutateChannel({
        keyframes: [
          { at: 1, easingToNext: { kind: "linear" }, value: 0 },
          { at: 2, easingToNext: { kind: "linear" }, value: 1 },
          { at: 3, easingToNext: { kind: "linear" }, value: 0 },
          { at: 4, easingToNext: { kind: "linear" }, value: 1 },
          { at: 6, easingToNext: null, value: 0 },
        ],
      }),
      mutateChannel({
        keyframes: channel.keyframes.map((keyframe, index) =>
          index === channel.keyframes.length - 1 ? { ...keyframe, at: 5 } : keyframe,
        ),
      }),
      mutateChannel({
        keyframes: [
          { at: 1, easingToNext: { kind: "linear" }, value: 0 },
          { at: 83 / 60, easingToNext: { kind: "linear" }, value: 1 },
          { at: 4, easingToNext: { kind: "linear" }, value: 1 },
          { at: 6, easingToNext: null, value: 0 },
        ],
      }),
    ];
    for (const invalid of profileViolations) {
      await expect(parseProducer(compiled(invalid), expectedV2)).rejects.toMatchObject({ code: "profile-violation" });
    }
  });

  it("defaults legacy persisted correlation metadata to profile V1 only", () => {
    const { snapshotVersion: _snapshotVersion, ...legacy } = expected;
    expect(expectedFastManimSnapshotCorrelationV1Schema.parse(legacy).snapshotVersion).toBe(1);
    expect(() => expectedFastManimSnapshotCorrelationV1Schema.parse({ ...legacy, snapshotVersion: 3 })).toThrow();
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
            scene: { ...value.bundle.scene, source: { ...value.bundle.scene.source, snapshotVersion: 3 } },
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
          ...wireCorrelation,
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
      { sceneId: fastManimSnapshotSceneIdV1("examples/scene.py", "OtherScene") },
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

  it("rejects producer-chosen ID suffixes and unreferenced provenance records", async () => {
    const bundle = await importedBundle();
    // The `stroke` entity (sceneOrder 2) is not referenced by any channel, so
    // its ID is exactly the kind of free string an exfiltrating producer
    // would abuse; the profile requires the exact derived identifier.
    const exfilEntity = {
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: bundle.scene.entities.map((entity) =>
          entity.sceneOrder === 2 ? { ...entity, id: `${expected.sceneId}/ghp_EXFILTRATED_SECRET` } : entity,
        ),
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(exfilEntity))).rejects.toMatchObject({ code: "profile-violation" });

    const exfilProvenance = {
      ...bundle,
      scene: {
        ...bundle.scene,
        provenance: [
          ...bundle.scene.provenance,
          {
            evidence: ["unreferenced"],
            id: `${expected.sceneId}/ghp_EXFILTRATED_SECRET`,
            origin: "fast-manim-server-snapshot" as const,
          },
        ],
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(exfilProvenance))).rejects.toMatchObject({ code: "profile-violation" });

    const wrongEntityOrder = {
      ...bundle,
      scene: {
        ...bundle.scene,
        entities: bundle.scene.entities.map((entity) =>
          entity.sceneOrder === 2 ? { ...entity, id: `${expected.sceneId}/entity:99` } : entity,
        ),
      },
    } as SceneIrBundleV1;
    await expect(parseProducer(compiled(wrongEntityOrder))).rejects.toMatchObject({ code: "profile-violation" });
  });

  it("rejects every deviation from the exporter's static v1 Scene shape", async () => {
    const bundle = await importedBundle();
    const scene = bundle.scene;
    const mutate = (patch: Partial<typeof scene>) => ({ ...bundle, scene: { ...scene, ...patch } }) as SceneIrBundleV1;
    const mutateEntity = (index: number, patch: Record<string, unknown>) =>
      mutate({
        entities: scene.entities.map((entity, at) => (at === index ? { ...entity, ...patch } : entity)),
      } as Partial<typeof scene>);
    const line = scene.entities[2]!;
    if (line.geometry.kind !== "cubic-path") throw new Error("Expected the Line cubic fixture.");
    const lineSubpath = line.geometry.path.subpaths[0]!;
    const lineSegment = lineSubpath.segments[0]!;
    const mutateLineSegment = (patch: Partial<typeof lineSegment>) =>
      mutateEntity(2, {
        geometry: {
          ...line.geometry,
          path: {
            subpaths: [{ ...lineSubpath, segments: [{ ...lineSegment, ...patch }] }],
          },
        },
      });

    const profileViolations: SceneIrBundleV1[] = [
      // Not the canonical 1-second static duration.
      mutate({ duration: 2 } as Partial<typeof scene>),
      // Entity lifetime shorter than the full static duration.
      mutateEntity(0, { lifetimes: [{ end: 0.5, start: 0 }] }),
      // Parent references are outside the static profile.
      mutateEntity(1, { parentId: scene.entities[0]!.id }),
      // Non-identity transform.
      mutateEntity(0, { transform: { m11: 1, m12: 0, m21: 0, m22: 1, tx: 1, ty: 0 } }),
      // Non-unit appearance opacity.
      mutateEntity(0, { appearance: { ...scene.entities[0]!.appearance, opacity: 0.5 } }),
      // Raw primitive geometry instead of the canonical cubic-path lowering.
      mutate({
        entities: scene.entities.map((entity, at) =>
          at === 0 ? { ...entity, geometry: { center: { x: 0, y: 0 }, kind: "circle", radius: 1 } } : entity,
        ),
        requiredCapabilities: ["cubic-path-geometry", "shape-primitives"],
      } as Partial<typeof scene>),
      // Any animation channel, even schema-valid with matching capabilities.
      mutate({
        animationChannels: [
          {
            entityId: scene.entities[0]!.id,
            id: `${expected.sceneId}/channel:opacity:0`,
            keyframes: [
              { at: 0, easingToNext: { kind: "linear" }, value: 0 },
              { at: 1, easingToNext: null, value: 1 },
            ],
            kind: "opacity",
            provenanceId: scene.provenance[1]!.id,
          },
        ],
        requiredCapabilities: ["cubic-path-geometry", "opacity-animation"],
      } as Partial<typeof scene>),
      // Camera not centered at the origin.
      mutate({
        camera: { ...scene.camera, view: { ...scene.camera.view, center: { x: 1, y: 0 } } },
      } as Partial<typeof scene>),
      // Camera frame differing from the request's runtimeConfig frame.
      mutate({
        camera: { ...scene.camera, view: { ...scene.camera.view, frameWidth: 16 } },
      } as Partial<typeof scene>),
      // Non-canonical fill winding rule.
      mutateEntity(0, {
        appearance: {
          ...scene.entities[0]!.appearance,
          fill: { ...(scene.entities[0]!.appearance as { fill: object }).fill, rule: "evenodd" },
        },
      }),
      // Non-canonical stroke shape on the Line lowering.
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: { ...(scene.entities[2]!.appearance as { stroke: object }).stroke, cap: "round" },
        },
      }),
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: { ...(scene.entities[2]!.appearance as { stroke: object }).stroke, miterLimit: 5 },
        },
      }),
      // Only join='miter' is producer-exact for the Line lowering.
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: { ...(scene.entities[2]!.appearance as { stroke: object }).stroke, join: "bevel" },
        },
      }),
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: { ...(scene.entities[2]!.appearance as { stroke: object }).stroke, join: "round" },
        },
      }),
      // Collinearity alone is insufficient: the renderer accepts only the
      // exporter's canonical 1/3 and 2/3 Line controls within one f64 ULP.
      mutateLineSegment({ control1: lineSubpath.start, control2: lineSegment.end }),
      // Fully transparent fill: the exporter never emits invisible paint.
      mutateEntity(0, {
        appearance: {
          ...scene.entities[0]!.appearance,
          fill: {
            ...(scene.entities[0]!.appearance as { fill: { color: object } }).fill,
            color: { ...(scene.entities[0]!.appearance as { fill: { color: object } }).fill.color, alpha: 0 },
          },
        },
      }),
      // Fully transparent stroke on the Line lowering.
      mutateEntity(2, {
        appearance: {
          ...scene.entities[2]!.appearance,
          stroke: {
            ...(scene.entities[2]!.appearance as { stroke: { color: object } }).stroke,
            color: { ...(scene.entities[2]!.appearance as { stroke: { color: object } }).stroke.color, alpha: 0 },
          },
        },
      }),
      // Reordered entities: sceneOrder no longer equals the array index.
      mutate({ entities: [scene.entities[1]!, scene.entities[0]!, scene.entities[2]!] } as Partial<typeof scene>),
      // A gap in the enumerate order (0, 2) with matching derived IDs.
      mutate({
        entities: [
          scene.entities[0]!,
          {
            ...scene.entities[1]!,
            id: `${expected.sceneId}/entity:2`,
            provenanceId: `${expected.sceneId}/provenance:entity:2`,
            sceneOrder: 2,
          },
        ],
        provenance: [
          scene.provenance[0]!,
          scene.provenance[1]!,
          { ...scene.provenance[2]!, id: `${expected.sceneId}/provenance:entity:2` },
        ],
      } as Partial<typeof scene>),
    ];
    for (const [index, deviated] of profileViolations.entries()) {
      await expect(parseProducer(compiled(deviated)), `deviation ${index}`).rejects.toMatchObject({
        code: "profile-violation",
      });
    }

    // Duplicate sceneOrder is rejected before the profile even runs.
    const duplicated = mutate({
      entities: [scene.entities[0]!, { ...scene.entities[1]!, sceneOrder: 0 }],
      provenance: scene.provenance.slice(0, 3),
    } as Partial<typeof scene>);
    await expect(parseProducer(compiled(duplicated))).rejects.toThrow();

    // A non-canonical coordinate space never even reaches the profile: the
    // scene-ir schema pins every coordinateSpace field to a single literal.
    const driftedSpace = {
      ...bundle,
      scene: { ...scene, coordinateSpace: { ...scene.coordinateSpace, cpuPrecision: "f32" } },
    } as unknown as SceneIrBundleV1;
    await expect(parseProducer(compiled(driftedSpace))).rejects.toThrow();
  });

  it("locks the verified run-view arm to compiled snapshots", async () => {
    const sealed = await parseProducer(compiled(await importedBundle()));
    if (sealed.kind !== "compiled") throw new Error("Expected a compiled snapshot.");
    const runViewBase = {
      projectId: expected.projectId,
      requestId: expected.requestId,
      runtimeConfigHash: expected.runtimeConfigHash,
      sceneName: expected.sceneName,
      schema: "poietra.fast-manim-snapshot-run",
      sourcePath: expected.sourcePath,
      version: 1,
    };
    const verifiedView = {
      ...runViewBase,
      publishedAt: new Date().toISOString(),
      revision: 1,
      snapshot: sealed,
      status: "verified",
    };
    expect(fastManimSnapshotRunViewV1Schema.parse(verifiedView)).toMatchObject({ status: "verified" });
    // An unsupported result must never ride a "verified" status, even when it
    // is otherwise well-formed: the wire schema itself refuses it.
    const unsupportedResult = {
      ...wireCorrelation,
      issues: [
        {
          code: "runtime-semantics-unsupported",
          evidence: [],
          message: FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1["runtime-semantics-unsupported"],
        },
      ],
      kind: "unsupported",
      schema: "poietra.fast-manim-snapshot-result",
      version: 1,
    };
    expect(() => fastManimSnapshotRunViewV1Schema.parse({ ...verifiedView, snapshot: unsupportedResult })).toThrow();
  });

  it("rejects hostile producer diagnostics in the unsupported run-view wire schema", () => {
    const runViewBase = {
      fallback: { kind: "server-authoritative-render" },
      projectId: expected.projectId,
      requestId: expected.requestId,
      runtimeConfigHash: expected.runtimeConfigHash,
      sceneName: expected.sceneName,
      schema: "poietra.fast-manim-snapshot-run",
      sourcePath: expected.sourcePath,
      status: "unsupported",
      version: 1,
    };
    const normalizedIssue = {
      code: "runtime-semantics-unsupported" as const,
      evidence: [] as string[],
      message: FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1["runtime-semantics-unsupported"],
    };
    expect(fastManimSnapshotRunViewV1Schema.parse({ ...runViewBase, issues: [normalizedIssue] })).toMatchObject({
      status: "unsupported",
    });
    // The wire schema itself — not just runtime normalization — refuses
    // producer strings: free evidence, host paths, runtime object identities,
    // non-owned messages, and unsorted or duplicated codes.
    const hostile = [
      [{ ...normalizedIssue, evidence: ["/home/builder/private.py"] }],
      [{ ...normalizedIssue, runtimeObjectId: "leaked-runtime-object" }],
      [{ ...normalizedIssue, message: "Traceback from /home/builder/private.py with secret-9f8e" }],
      [normalizedIssue, normalizedIssue],
      [
        normalizedIssue,
        {
          code: "geometry-evidence-incomplete" as const,
          evidence: [] as string[],
          message: FAST_MANIM_SNAPSHOT_UNSUPPORTED_MESSAGES_V1["geometry-evidence-incomplete"],
        },
      ],
    ];
    for (const issues of hostile) {
      expect(() => fastManimSnapshotRunViewV1Schema.parse({ ...runViewBase, issues })).toThrow();
    }
  });
});
