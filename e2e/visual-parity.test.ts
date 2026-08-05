import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import { digestFastManimSnapshotBundleV1 } from "../server/fast-manim-snapshot-contract";
import { sceneIrBundleV1Schema } from "../src/engine/contracts";
import { sceneIrSourceRevisionHash } from "../src/engine/scene-ir";
import { manimCompositorReferenceV1Schema } from "./manim-compositor-parity";
import { verifyManimCompositorParityEvidenceV1 } from "./manim-compositor-parity-evidence";
import { encodeRgbaPngV1 } from "./png-rgba";
import { thresholdsForEntryV1, visualParityCorpusV1Schema, visualParityReportV1Schema } from "./visual-parity-contract";
import { compareVisualParityFramesV1, makeOpaqueVisualParityDiffV1 } from "./visual-parity-metrics";

async function corpusFixture() {
  return visualParityCorpusV1Schema.parse(JSON.parse(await readFile("fixtures/visual-parity-v1/corpus.json", "utf8")));
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("visual parity v1 contracts", () => {
  it("pins the independent real Manim/Cairo compositor reference", async () => {
    const root = "fixtures/manim-compositor-parity-v1";
    const reference = manimCompositorReferenceV1Schema.parse(
      JSON.parse(await readFile(`${root}/reference.json`, "utf8")),
    );
    expect(reference).toMatchObject({
      frame: { sampleTime: 0, viewport: { heightPx: 468, widthPx: 832 } },
      producer: {
        cairoVersion: "1.18.0",
        fastManimCommit: "d2480e8096a5cac64f7f86ed1d0d01f5c87839e3",
        manimVersion: "0.20.1",
        pillowVersion: "12.2.0",
        pycairoVersion: "1.29.0",
        renderer: "cairo",
      },
      rendererConfig: {
        antialias: "default",
        backgroundColor: "#000000",
        backgroundOpacity: 1,
        cairoCompositor: false,
        cairoCompositorFades: false,
        cairoForkWorkers: 0,
        cairoStaticLayers: false,
        disableCaching: true,
        frameRate: 60,
        saveLastFrame: true,
        transparent: false,
        writeToMovie: false,
      },
      scene: {
        className: "RealPreviewScene",
        sourcePath: "fixtures/real-preview-harness/scene.py",
        sourceSha256: "be19c7339d0a33f31ad48ff8770b09ad4bd8b186363f1ccf5e2db9469d2e82b5",
      },
    });
    const png = new Uint8Array(await readFile(`${root}/${reference.png.path}`));
    expect(png.byteLength).toBe(reference.png.byteLength);
    expect(sha256(png)).toBe(reference.png.sha256);
    expect(sha256(new Uint8Array(await readFile(reference.scene.sourcePath)))).toBe(reference.scene.sourceSha256);
  });

  it("revalidates the promoted real Manim compositor evidence", async () => {
    const directory = "docs/evidence/manim-compositor-parity-2026-07-31";
    await expect(verifyManimCompositorParityEvidenceV1(directory)).resolves.toMatchObject({
      gate: { passed: true },
      schema: "poietra.manim-compositor-parity-report",
      version: 1,
    });
  });

  it("pins the corpus order and existing dynamic semantic digest to the default gate", async () => {
    const corpus = await corpusFixture();
    expect(corpus.entries.map(({ id }) => id)).toEqual([
      "dynamic-affine-camera--a-first",
      "png-alpha-edge-camera--midpoint",
      "mathtex-nested-radical-fraction--static",
      "generic-stroke-topology--sample",
      "real-mathtex-morph-v5--a-initial",
      "real-mathtex-morph-v5--outbound-midpoint",
      "real-mathtex-morph-v5--maxwell-hold",
      "real-mathtex-morph-v5--return-midpoint",
      "real-mathtex-morph-v5--a-restored",
      "real-generic-vmobject-v6--static",
      "real-square-to-circle-v8--create-midpoint",
      "real-square-to-circle-v8--square",
      "real-square-to-circle-v8--analytic-winding-root",
      "real-square-to-circle-v8--circle",
      "real-square-to-circle-v8--fade-midpoint",
      "real-warp-square-v9--source",
      "real-warp-square-v9--quarter",
      "real-warp-square-v9--midpoint",
      "real-warp-square-v9--target",
      "real-warp-square-v9--hold",
      "real-spiral-in-v11--start",
      "real-spiral-in-v11--early-reveal",
      "real-spiral-in-v11--spiral-midpoint",
      "real-spiral-in-v11--spiral-end",
      "real-spiral-in-v11--hold",
      "real-spiral-in-v11--group-fade-midpoint",
      "real-spiral-in-v11--end",
      "real-line-joints-v10--static",
      "real-line-joints-v10-edited--static",
      "real-write-stuff-v12--start",
      "real-write-stuff-v12--tex-early",
      "real-write-stuff-v12--tex-midpoint",
      "real-write-stuff-v12--math-start",
      "real-write-stuff-v12--math-midpoint",
      "real-write-stuff-v12--math-end",
      "real-write-stuff-v12--hold",
      "real-write-stuff-v12--end",
      "real-write-stuff-v12-edited--hold",
    ]);
    const entry = corpus.entries.find(({ id }) => id === "dynamic-affine-camera--a-first");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("The dynamic visual parity entry is missing.");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-dynamic-affine-camera",
        revision: { sha256: "1641641641641641641641641641641641641641641641641641641641641641" },
      },
      id: "dynamic-affine-camera--a-first",
      sample: {
        id: "a-first",
        semanticDigest: "c29280443cc17ea9fed6882527d3a624865296a864e4f14a0aa791d656ba4a19",
        viewport: { heightPx: 90, widthPx: 160 },
      },
      thresholdException: null,
    });
    expect(thresholdsForEntryV1(corpus, entry)).toEqual({
      maximumPixelFractionAboveThreshold: 0.005,
      minimumSsim: 0.995,
    });
  });

  it("requires both a non-empty reason and explicit thresholds for every exception", async () => {
    const corpus = await corpusFixture();
    const entry = corpus.entries[0]!;
    const invalid = {
      ...corpus,
      entries: [{ ...entry, thresholdException: { reason: "", thresholdOverride: corpus.defaultThresholds } }],
    };
    expect(visualParityCorpusV1Schema.safeParse(invalid).success).toBe(false);
    expect(
      visualParityCorpusV1Schema.safeParse({
        ...corpus,
        entries: [{ ...entry, thresholdException: { reason: "temporary adapter variance" } }],
      }).success,
    ).toBe(false);
  });

  it("pins PNG alpha-edge bytes and its independent full-frame reference", async () => {
    const corpus = await corpusFixture();
    const entry = corpus.entries.find(({ id }) => id === "png-alpha-edge-camera--midpoint");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-png-alpha-edge-camera",
        revision: { sha256: "e7f8dcbd4eabd88861b101575fdb6b420ec4447173622bf6f9c7bbf6381160fc" },
      },
      sample: {
        id: "midpoint",
        sampleTime: 0.5,
        semanticDigest: "d9b5ec588d4366327c73fde436597f008b615450aa0a35824618e81573ebcec6",
        viewport: { heightPx: 4, widthPx: 8 },
      },
      thresholdException: null,
    });

    const fixture = JSON.parse(await readFile("fixtures/engine-v1/png-alpha-edge-camera.json", "utf8"));
    const payload = fixture.assetPayloads[0];
    const asset = fixture.assets.assets[0];
    const reference = fixture.analyticReferences.midpoint;
    expect(payload.assetId).toBe(asset.id);
    expect(payload.encodedBytes).toHaveLength(asset.byteLength);
    expect(sha256(Uint8Array.from(payload.encodedBytes))).toBe(asset.sha256);
    expect(reference.viewport).toEqual({ heightPx: 4, widthPx: 8 });
    expect(reference.rgba).toHaveLength(4 * 8 * 4);
    expect(sha256(Uint8Array.from(reference.rgba))).toBe(
      "bd57ff57b18706b3d25886038a568d3a2904ec3987b365860aa0471bc7119b8b",
    );
    expect(reference.sha256).toBe("bd57ff57b18706b3d25886038a568d3a2904ec3987b365860aa0471bc7119b8b");
    expect(reference.derivation).toContain("Pixel centers");
  });

  it("pins the Studio-created nested radical fraction to the default full-RGBA gate", async () => {
    const corpus = await corpusFixture();
    const entry = corpus.entries.find(({ id }) => id === "mathtex-nested-radical-fraction--static");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-mathtex-nested-radical-fraction",
        revision: { sha256: "43fa43f9445110f25284bce82d11982379f82a05c6d6621864725edd806451e0" },
      },
      sample: {
        id: "static",
        sampleTime: 0.5,
        semanticDigest: "b5d2a54ee6b837f2bbb5e9427ac4a7acfc55b674a6dd55e20050627f076752a3",
        viewport: { heightPx: 360, widthPx: 640 },
      },
      thresholdException: null,
    });
    if (!entry) throw new Error("The MathTex visual parity entry is missing.");
    expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);

    const fixture = JSON.parse(await readFile("fixtures/engine-v1/mathtex-nested-radical-fraction.json", "utf8"));
    expect(sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene }).scene.entities).toHaveLength(
      1,
    );
    expect(fixture.scene.source.revisionHash).toBe(entry.fixture.revision.sha256);
    expect(fixture.samples).toContainEqual(
      expect.objectContaining({
        expected: { semanticDigest: entry.sample.semanticDigest },
        id: entry.sample.id,
        sampleTime: entry.sample.sampleTime,
        viewport: entry.sample.viewport,
      }),
    );
    const manimCorpus = JSON.parse(await readFile("fixtures/mathtex-manim-parity-v1/corpus.json", "utf8"));
    const manimCase = manimCorpus.cases.find(({ id }: { id: string }) => id === fixture.mathTexReference.id);
    expect(manimCase).toMatchObject({
      provenance: fixture.mathTexReference.provenance,
      svgFile: "references/nested-radical-fraction.svg",
      svgSha256: fixture.mathTexReference.svgSha256,
      texParts: fixture.mathTexReference.texParts,
    });
    expect(sha256(new Uint8Array(await readFile(fixture.mathTexReference.svgFile)))).toBe(
      fixture.mathTexReference.svgSha256,
    );
  });

  it("pins the server-sealed real MathTex morph V5 timeline to the default full-RGBA gate", async () => {
    const fixtureRevision = "05c0318c662004e9b1898a4018eaedef3a11b0926be9a166daa621145f645cbf";
    const corpus = await corpusFixture();
    const expectedSamples = [
      [
        "real-mathtex-morph-v5--a-initial",
        "a-initial",
        0.5,
        "204357f09544d3de5022e59929cc97cf1451f3507ca300557b95ed92bd450928",
      ],
      [
        "real-mathtex-morph-v5--outbound-midpoint",
        "outbound-midpoint",
        1.5,
        "1e7f5357fe7c3d53cdf38cd249fe9e0d1ecc34f0ffbb1270bb14c1fbe0d07709",
      ],
      [
        "real-mathtex-morph-v5--maxwell-hold",
        "maxwell-hold",
        2.25,
        "fbbe1b4d440c13d04506565ba80dc47473c5bfce3709e10cd03038ddd6d9fe9c",
      ],
      [
        "real-mathtex-morph-v5--return-midpoint",
        "return-midpoint",
        3.5,
        "37419bcecc1f39f128ac5225ffb7b35fea52b6b988d7b0138d43a3b3658242ed",
      ],
      [
        "real-mathtex-morph-v5--a-restored",
        "a-restored",
        5,
        "204357f09544d3de5022e59929cc97cf1451f3507ca300557b95ed92bd450928",
      ],
    ] as const;
    const entries = expectedSamples.map(([entryId]) => {
      const entry = corpus.entries.find(({ id }) => id === entryId);
      if (!entry) throw new Error(`The real MathTex morph corpus entry ${entryId} is missing.`);
      return entry;
    });
    for (const [index, entry] of entries.entries()) {
      const [entryId, sampleId, sampleTime, semanticDigest] = expectedSamples[index]!;
      expect(entry).toMatchObject({
        fixture: {
          id: "eng-v1-real-mathtex-morph-v5",
          path: "fixtures/engine-v1/real-mathtex-morph-v5.json",
          revision: { kind: "imported-manim-server-snapshot", sha256: fixtureRevision },
        },
        id: entryId,
        sample: {
          id: sampleId,
          sampleTime,
          semanticDigest,
          viewport: { heightPx: 360, widthPx: 640 },
        },
        thresholdException: null,
      });
      expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);
    }

    const fixtureBytes = new Uint8Array(await readFile("fixtures/engine-v1/real-mathtex-morph-v5.json"));
    expect(fixtureBytes.byteLength).toBeLessThanOrEqual(256 * 1024);
    const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene).toMatchObject({
      duration: 5.5,
      requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
      source: {
        kind: "imported-manim-server-snapshot",
        snapshotHash: fixtureRevision,
        snapshotVersion: 5,
        sourceHash: "f03e0c5eed2c2c35047e8d0ee9ef0aa3f0fc00cd5ecd83ce36c3cf21e46e9dd6",
      },
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(fixtureRevision);
    expect(sceneIrSourceRevisionHash(bundle.scene)).toBe(fixtureRevision);
    expect(bundle.scene.entities).toHaveLength(1);
    expect(bundle.scene.animationChannels).toHaveLength(1);
    expect(fixture.producerReference).toMatchObject({
      engineCommit: "be671c1ddcfc8466548c8822956e19579256e581",
      fastManimCommit: "3083db9ed9a9a93c2808ee3f51189ceca92d230b",
      kind: "server-sealed-real-fast-manim-profile-v5",
      snapshotHash: fixtureRevision,
      sourcePath: "fixtures/real-preview-harness/scene_mathtex_morph.py",
      sourceSha256: "f03e0c5eed2c2c35047e8d0ee9ef0aa3f0fc00cd5ecd83ce36c3cf21e46e9dd6",
    });
    expect(sha256(new Uint8Array(await readFile(fixture.producerReference.sourcePath)))).toBe(
      fixture.producerReference.sourceSha256,
    );
    expect(fixture.samples.map(({ id, sampleTime }: { id: string; sampleTime: number }) => [id, sampleTime])).toEqual(
      expectedSamples.map(([, sampleId, sampleTime]) => [sampleId, sampleTime]),
    );
    for (const [index, sample] of fixture.samples.entries()) {
      expect(sample).toMatchObject({
        expected: { semanticDigest: entries[index]!.sample.semanticDigest },
        id: entries[index]!.sample.id,
        sampleTime: entries[index]!.sample.sampleTime,
        viewport: entries[index]!.sample.viewport,
      });
    }
    const browserPayload = JSON.stringify(bundle);
    expect(browserPayload).not.toContain("E = mc^2");
    expect(browserPayload).not.toContain("\\nabla");
  });

  it("pins the server-sealed real generic VMobject V6 scene to the default full-RGBA gate", async () => {
    const corpus = await corpusFixture();
    const entry = corpus.entries.find(({ id }) => id === "real-generic-vmobject-v6--static");
    if (!entry) throw new Error("The real generic VMobject V6 corpus entry is missing.");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-real-generic-vmobject-v6",
        path: "fixtures/engine-v1/real-generic-vmobject-v6.json",
        revision: { kind: "imported-manim-server-snapshot" },
      },
      sample: { id: "static", sampleTime: 0.5, viewport: { heightPx: 360, widthPx: 640 } },
      thresholdException: null,
    });
    expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);

    const fixtureBytes = new Uint8Array(await readFile(entry.fixture.path));
    expect(fixtureBytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-server-snapshot",
      snapshotHash: entry.fixture.revision.sha256,
      snapshotVersion: 6,
      sourceHash: fixture.producerReference.sourceSha256,
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(entry.fixture.revision.sha256);
    expect(sceneIrSourceRevisionHash(bundle.scene)).toBe(entry.fixture.revision.sha256);
    expect(bundle.scene.entities).toHaveLength(3);
    expect(bundle.scene.animationChannels).toHaveLength(0);
    expect(fixture.producerReference).toMatchObject({
      engineCommit: "7d5ff0a9b0a3a2ab148669310261be982a3f8843",
      fastManimCommit: "d2480e8096a5cac64f7f86ed1d0d01f5c87839e3",
      kind: "server-sealed-real-fast-manim-profile-v6",
      snapshotHash: entry.fixture.revision.sha256,
      sourcePath: "fixtures/real-preview-harness/scene_generic_vmobject.py",
      sourceSha256: "b9b921b1e9aba717c3f6fa3b90672f2d4f268d19310c3c9d1ebaf1e9d3b44159",
    });
    expect(sha256(new Uint8Array(await readFile(fixture.producerReference.sourcePath)))).toBe(
      fixture.producerReference.sourceSha256,
    );
    expect(fixture.samples).toEqual([
      expect.objectContaining({
        expected: { semanticDigest: entry.sample.semanticDigest },
        id: entry.sample.id,
        sampleTime: entry.sample.sampleTime,
        viewport: entry.sample.viewport,
      }),
    ]);
  });

  it("pins the server-sealed real SquareToCircle V8 timeline to the default full-RGBA gate", async () => {
    const fixtureRevision = "de7db7be8e1c633bd5668ed13b4daf3c3e945026db107bddc70e5366b0af80f1";
    const corpus = await corpusFixture();
    const expectedSamples = [
      [
        "real-square-to-circle-v8--create-midpoint",
        "create-midpoint",
        0.5,
        "2c894c6d88d7c14cc8f3b06c1df1b3b53ea3d6f715368cc5cac11d60135fd6d7",
      ],
      [
        "real-square-to-circle-v8--square",
        "square",
        1,
        "30f8fa1d7a9b844eba679f06e70aa0ee40ba3e0239f705515aa327930670985d",
      ],
      [
        "real-square-to-circle-v8--analytic-winding-root",
        "analytic-winding-root",
        1.5119159473817447,
        "b2573ce64a89fc3639fd9338672f58f64feb9e33d76076cb616129699d37e77d",
      ],
      [
        "real-square-to-circle-v8--circle",
        "circle",
        2,
        "cee317729cdea55294e3450710191d85e11a72519612dd67f78316a1ba091d2c",
      ],
      [
        "real-square-to-circle-v8--fade-midpoint",
        "fade-midpoint",
        2.5,
        "1f44bd7fbc2c7310fdcf1ec3b964bbd996ee65078c54dd0e7a39ac509215a00a",
      ],
    ] as const;
    const entries = expectedSamples.map(([entryId]) => {
      const entry = corpus.entries.find(({ id }) => id === entryId);
      if (!entry) throw new Error(`The SquareToCircle V8 corpus entry ${entryId} is missing.`);
      return entry;
    });
    for (const [index, entry] of entries.entries()) {
      const [entryId, sampleId, sampleTime, semanticDigest] = expectedSamples[index]!;
      expect(entry).toMatchObject({
        fixture: {
          id: "eng-v1-real-square-to-circle-v8",
          path: "fixtures/engine-v1/real-square-to-circle-v8.json",
          revision: { kind: "imported-manim-server-snapshot", sha256: fixtureRevision },
        },
        id: entryId,
        sample: {
          id: sampleId,
          sampleTime,
          semanticDigest,
          viewport: { heightPx: 360, widthPx: 640 },
        },
        thresholdException: null,
      });
      expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);
    }

    const fixtureBytes = new Uint8Array(await readFile("fixtures/engine-v1/real-square-to-circle-v8.json"));
    expect(fixtureBytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene).toMatchObject({
      duration: 3,
      requiredCapabilities: [
        "cubic-path-geometry",
        "opacity-animation",
        "path-morph-animation",
        "path-trim-animation",
        "vector-appearance-animation",
      ],
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: "9650b633875a68d2e6c000e89cb21bdffabe2b6fbf08f2262b54842344e000a2",
        snapshotHash: fixtureRevision,
        snapshotVersion: 8,
        sourceHash: "ef874f1ab5899aadf870956ec71ce71653d373366b23e40c2ee8b070ad193c40",
      },
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(fixtureRevision);
    expect(sceneIrSourceRevisionHash(bundle.scene)).toBe(fixtureRevision);
    expect(bundle.scene.entities).toHaveLength(1);
    expect(bundle.scene.animationChannels.map(({ kind }) => kind)).toEqual([
      "opacity",
      "path-morph",
      "vector-appearance",
      "path-trim",
    ]);
    expect(fixture.producerReference).toEqual({
      engineCommit: "1f195ba48d4e2ea92dd45b3cac4928342da320c9",
      fastManimCommit: "a1e886fb854268ad7d06b00168f9a5ce3339857d",
      kind: "server-sealed-real-fast-manim-profile-v8",
      snapshotHash: fixtureRevision,
      sourcePath: "fixtures/real-preview-harness/scene_square_to_circle.py",
      sourceSha256: "ef874f1ab5899aadf870956ec71ce71653d373366b23e40c2ee8b070ad193c40",
    });
    expect(sha256(new Uint8Array(await readFile(fixture.producerReference.sourcePath)))).toBe(
      fixture.producerReference.sourceSha256,
    );
    expect(fixture.samples).toEqual(
      expectedSamples.map(([, sampleId, sampleTime, semanticDigest]) => ({
        expected: { semanticDigest },
        id: sampleId,
        packetId: `real-square-to-circle-v8:${sampleId}`,
        sampleTime,
        viewport: { heightPx: 360, widthPx: 640 },
      })),
    );
  });

  it("pins the server-sealed real WarpSquare V9 timeline to the default full-RGBA gate", async () => {
    const fixtureRevision = "b8854f07baa588b01a2a5694d8ade2800601f1e26b6e12d626cc170ffa1be9ed";
    const corpus = await corpusFixture();
    const expectedSamples = [
      ["real-warp-square-v9--source", "source", 0, "d24ea70236f94d36ed65366c08d6bbadd8fe30b1b72e056bc82de9c4e947f153"],
      [
        "real-warp-square-v9--quarter",
        "quarter",
        0.75,
        "9dae6e42538f0e050f58d26c8c5515d2d5320734fa3feda3df6f36b3995892e6",
      ],
      [
        "real-warp-square-v9--midpoint",
        "midpoint",
        1.5,
        "2cfbcd7131ac221ec9be671f5dd54ede561de6be85b85051ef93ce7868d5ab78",
      ],
      ["real-warp-square-v9--target", "target", 3, "611374aa721b2dd289b9cbf55e692777656549e941faf0ff22aa7138f2e71e90"],
      ["real-warp-square-v9--hold", "hold", 3.5, "611374aa721b2dd289b9cbf55e692777656549e941faf0ff22aa7138f2e71e90"],
    ] as const;
    const entries = expectedSamples.map(([entryId]) => {
      const entry = corpus.entries.find(({ id }) => id === entryId);
      if (!entry) throw new Error(`The WarpSquare V9 corpus entry ${entryId} is missing.`);
      return entry;
    });
    for (const [index, entry] of entries.entries()) {
      const [entryId, sampleId, sampleTime, semanticDigest] = expectedSamples[index]!;
      expect(entry).toMatchObject({
        fixture: {
          id: "eng-v1-real-warp-square-v9",
          path: "fixtures/engine-v1/real-warp-square-v9.json",
          revision: { kind: "imported-manim-server-snapshot", sha256: fixtureRevision },
        },
        id: entryId,
        sample: {
          id: sampleId,
          sampleTime,
          semanticDigest,
          viewport: { heightPx: 360, widthPx: 640 },
        },
        thresholdException: null,
      });
      expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);
    }

    const fixtureBytes = new Uint8Array(await readFile("fixtures/engine-v1/real-warp-square-v9.json"));
    expect(fixtureBytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene).toMatchObject({
      duration: 4,
      requiredCapabilities: ["cubic-path-geometry", "path-morph-animation"],
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: "a2a789613c64b68c4b9b0c3542975b334b3b03388b7c8b0b903f690cca69c38a",
        snapshotHash: fixtureRevision,
        snapshotVersion: 9,
        sourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      },
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(fixtureRevision);
    expect(sceneIrSourceRevisionHash(bundle.scene)).toBe(fixtureRevision);
    expect(bundle.scene.entities).toHaveLength(1);
    expect(bundle.scene.animationChannels.map(({ kind }) => kind)).toEqual(["path-morph"]);
    expect(fixture.producerReference).toEqual({
      engineCommit: "0b331ce781411f38185dcabccdffdccee02d4376",
      fastManimCommit: "2c1e56287193e3acddbe6779f6ecd4bd91094588",
      kind: "server-sealed-real-fast-manim-profile-v9",
      snapshotHash: fixtureRevision,
      sourcePath: "example_scenes/basic.py",
      sourceSha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
    });
    expect(
      sha256(new Uint8Array(await readFile(`fixtures/real-preview-harness/${fixture.producerReference.sourcePath}`))),
    ).toBe(fixture.producerReference.sourceSha256);
    for (const [, sampleId, sampleTime, semanticDigest] of expectedSamples) {
      expect(fixture.samples).toContainEqual({
        expected: { semanticDigest },
        id: sampleId,
        packetId: `real-warp-square-v9:${sampleId}`,
        sampleTime,
        viewport: { heightPx: 360, widthPx: 640 },
      });
    }
  });

  it("pins the official SpiralIn V11 timeline to native/browser and independent Cairo gates", async () => {
    const fixtureRevision = "fccc297be458cb3a066842d0f94f8d60575dd5492371c82d6d8be1e53b01d1e0";
    const corpus = await corpusFixture();
    const expectedSamples = [
      ["real-spiral-in-v11--start", "start", 0, "4a58d3347663fa01846422ac73cf1e530659f8e487e90545a7a3cc8a6db09a47"],
      [
        "real-spiral-in-v11--early-reveal",
        "early-reveal",
        0.1,
        "9f1edd6f1c65d352b0995e870b4aa7f1dd611501a3aa91ae2ddd2d8da59fdcc7",
      ],
      [
        "real-spiral-in-v11--spiral-midpoint",
        "spiral-midpoint",
        0.5,
        "269e56232ec150380d5f8c204eed7674c892615130952c16124c2bb3aaef4d51",
      ],
      [
        "real-spiral-in-v11--spiral-end",
        "spiral-end",
        1,
        "d01cda09c83d16964eed3fa580672cc5ea0438f13d35536e0e354f4a37aeeddc",
      ],
      ["real-spiral-in-v11--hold", "hold", 1.5, "d01cda09c83d16964eed3fa580672cc5ea0438f13d35536e0e354f4a37aeeddc"],
      [
        "real-spiral-in-v11--group-fade-midpoint",
        "group-fade-midpoint",
        2.5,
        "d3e732049a2025c84b1ed263e86aed2da07856fc0dd255c1b3e8ff6b0fb923d7",
      ],
      ["real-spiral-in-v11--end", "end", 3, "53313d7e0bfa86225f8b4f998f8dd91bb1574398f5b18172bdfb7fcf09faedb2"],
    ] as const;
    for (const [entryId, sampleId, sampleTime, semanticDigest] of expectedSamples) {
      const entry = corpus.entries.find(({ id }) => id === entryId);
      if (!entry) throw new Error(`The SpiralIn V11 corpus entry ${entryId} is missing.`);
      expect(entry).toMatchObject({
        fixture: {
          id: "eng-v1-real-spiral-in-v11",
          path: "fixtures/engine-v1/real-spiral-in-v11.json",
          revision: { kind: "imported-manim-server-snapshot", sha256: fixtureRevision },
        },
        sample: {
          id: sampleId,
          sampleTime,
          semanticDigest,
          viewport: { heightPx: 360, widthPx: 640 },
        },
        thresholdException: null,
      });
      expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);
    }

    const fixtureBytes = new Uint8Array(await readFile("fixtures/engine-v1/real-spiral-in-v11.json"));
    expect(fixtureBytes.byteLength).toBeLessThanOrEqual(128 * 1024);
    const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene).toMatchObject({
      duration: 3,
      requiredCapabilities: ["affine-transform-animation", "cubic-path-geometry", "logical-group", "opacity-animation"],
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: "5e5999869eec1e504524113678df6b55f38cc850efa4fbda569e2f2601beb520",
        snapshotHash: fixtureRevision,
        snapshotVersion: 11,
        sourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      },
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(fixtureRevision);
    expect(sceneIrSourceRevisionHash(bundle.scene)).toBe(fixtureRevision);
    expect(bundle.scene.entities).toHaveLength(6);
    expect(bundle.scene.entities[0]?.geometry).toEqual({ kind: "group" });
    expect(bundle.scene.entities.slice(1).every(({ geometry }) => geometry.kind === "cubic-path")).toBe(true);
    expect(bundle.scene.animationChannels).toHaveLength(11);
    expect(bundle.scene.animationChannels.map(({ kind }) => kind).sort()).toEqual([
      "affine-transform",
      "affine-transform",
      "affine-transform",
      "affine-transform",
      "affine-transform",
      "opacity",
      "opacity",
      "opacity",
      "opacity",
      "opacity",
      "opacity",
    ]);
    expect(fixture.producerReference).toEqual({
      engineCommit: "e5423a8cb79a8326d42337e204ed12784750cdf1",
      fastManimCommit: "4a6eaf1b4085ed643698da5116dd23814411eb5b",
      fastManimTree: "6fad77addc72e1a97440265e27d02630cf5b37b4",
      kind: "server-sealed-real-fast-manim-profile-v11",
      producerSnapshotDigest: "f10b64b47c0aa8d663a01dfb58a6d20057608a0c324f97b436a9c13becefcbea",
      snapshotHash: fixtureRevision,
      sourcePath: "example_scenes/basic.py",
      sourceSha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
    });
    for (const [, sampleId, sampleTime, semanticDigest] of expectedSamples) {
      expect(fixture.samples).toContainEqual({
        expected: { semanticDigest },
        id: sampleId,
        packetId: `real-spiral-in-v11:${sampleId}`,
        sampleTime,
        viewport: { heightPx: 360, widthPx: 640 },
      });
    }
  });

  it("pins the official WriteStuff V12 timeline to native/browser and independent Cairo gates", async () => {
    const fixtureRevision = "b4cb36f1756e1204d6093f9fd838f75eb6810429b5aad30abc68af4c7d7c2594";
    const corpus = await corpusFixture();
    const expectedSamples = [
      ["real-write-stuff-v12--start", "start", 0, "2451c0c9c441b2c3672ea4cd4dc7c0a29eebb3eb896d45b57c7e35df5fbd5b70"],
      [
        "real-write-stuff-v12--tex-early",
        "tex-early",
        0.25,
        "411329ac0a55560693e9278f35db572bd3f0ee9389041c6cfdaf4d325fd8cb42",
      ],
      [
        "real-write-stuff-v12--tex-midpoint",
        "tex-midpoint",
        1,
        "51249211b7697d8337ac1b85fde08c9e1c965904f8a227036078b6b3c6a89da9",
      ],
      [
        "real-write-stuff-v12--math-start",
        "math-start",
        2,
        "3139f1f7d8598c514a42b8be305209821b00da677e3b72cf1cdaf89c3c1fa1bc",
      ],
      [
        "real-write-stuff-v12--math-midpoint",
        "math-midpoint",
        2.5,
        "aa924b5981023a906e4c14fc91d3f6b3dd29db3ed3d2fd20a92283584abb638a",
      ],
      [
        "real-write-stuff-v12--math-end",
        "math-end",
        3,
        "73f15e65f384a42358b5dbf61f22de23332c0c6da3697a91d6acdbaafc2c9ff9",
      ],
      ["real-write-stuff-v12--hold", "hold", 3.5, "73f15e65f384a42358b5dbf61f22de23332c0c6da3697a91d6acdbaafc2c9ff9"],
      ["real-write-stuff-v12--end", "end", 4, "73f15e65f384a42358b5dbf61f22de23332c0c6da3697a91d6acdbaafc2c9ff9"],
    ] as const;
    for (const [entryId, sampleId, sampleTime, semanticDigest] of expectedSamples) {
      const entry = corpus.entries.find(({ id }) => id === entryId);
      if (!entry) throw new Error(`The WriteStuff V12 corpus entry ${entryId} is missing.`);
      expect(entry).toMatchObject({
        fixture: {
          id: "eng-v1-real-write-stuff-v12",
          path: "fixtures/engine-v1/real-write-stuff-v12.json",
          revision: { kind: "imported-manim-server-snapshot", sha256: fixtureRevision },
        },
        sample: {
          id: sampleId,
          sampleTime,
          semanticDigest,
          viewport: { heightPx: 360, widthPx: 640 },
        },
        thresholdException: null,
      });
      expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);
    }

    const fixtureBytes = new Uint8Array(await readFile("fixtures/engine-v1/real-write-stuff-v12.json"));
    expect(fixtureBytes.byteLength).toBeLessThanOrEqual(1_024 * 1_024);
    const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene).toMatchObject({
      duration: 4,
      requiredCapabilities: [
        "cubic-path-geometry",
        "logical-group",
        "path-trim-animation",
        "vector-appearance-animation",
      ],
      source: {
        kind: "imported-manim-server-snapshot",
        runtimeConfigHash: "2022ea1ccebb06668fc92386455c4d4928305e72a5a5459d103e3d86261a4593",
        snapshotHash: fixtureRevision,
        snapshotVersion: 12,
        sourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      },
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(fixtureRevision);
    expect(sceneIrSourceRevisionHash(bundle.scene)).toBe(fixtureRevision);
    expect(bundle.scene.entities).toHaveLength(61);
    expect(bundle.scene.entities.filter(({ geometry }) => geometry.kind === "group")).toHaveLength(3);
    expect(bundle.scene.entities.filter(({ geometry }) => geometry.kind === "cubic-path")).toHaveLength(58);
    expect(bundle.scene.animationChannels).toHaveLength(58);
    expect(bundle.scene.animationChannels.map(({ kind }) => kind).sort()).toEqual([
      ...Array(29).fill("path-trim"),
      ...Array(29).fill("vector-appearance"),
    ]);
    expect(fixture.producerReference).toMatchObject({
      fastManimCommit: "044a61aa0d868fc9e799588f2eb88006594b6c44",
      fastManimTree: "996ad2b7375a6f911b1b00747eaad38834bde25c",
      kind: "server-sealed-real-fast-manim-profile-v12",
      producerSnapshotDigest: "dd6ca2c3e1015718f9fa9b8ad0e926de8260013eb85d17574c3c7fdeaba89817",
      snapshotHash: fixtureRevision,
      sourcePath: "example_scenes/basic.py",
      sourceSha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
    });
    for (const [, sampleId, sampleTime, semanticDigest] of expectedSamples) {
      expect(fixture.samples).toContainEqual({
        expected: { semanticDigest },
        id: sampleId,
        packetId: `real-write-stuff-v12:${sampleId}`,
        sampleTime,
        viewport: { heightPx: 360, widthPx: 640 },
      });
    }
  });

  it("pins the actual producer snapshot after the Studio WriteStuff equation edit", async () => {
    const fixtureRevision = "0b7fe0cef87705b148916bdb857d61c177e4edb121f7883db5122f439f706d48";
    const sourceHash = "37179e2a50fc22e784962d26a7778f5c273c296d5fcbccf04d89fb7e55885d98";
    const corpus = await corpusFixture();
    const entry = corpus.entries.find(({ id }) => id === "real-write-stuff-v12-edited--hold");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-real-write-stuff-v12-edited",
        path: "fixtures/engine-v1/real-write-stuff-v12-edited.json",
        revision: { kind: "imported-manim-server-snapshot", sha256: fixtureRevision },
      },
      sample: {
        id: "hold",
        sampleTime: 3.5,
        semanticDigest: "0d55846a1d4c4dd5556dd40d6c5deb34b4ed0e42a29bbb3ee31596262e3839cc",
        viewport: { heightPx: 360, widthPx: 640 },
      },
      thresholdException: null,
    });
    if (!entry) throw new Error("The edited WriteStuff V12 visual-parity entry is missing.");
    expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);

    const fixtureBytes = new Uint8Array(await readFile(entry.fixture.path));
    expect(fixtureBytes.byteLength).toBeLessThanOrEqual(1_024 * 1_024);
    const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-server-snapshot",
      runtimeConfigHash: "2022ea1ccebb06668fc92386455c4d4928305e72a5a5459d103e3d86261a4593",
      snapshotHash: fixtureRevision,
      snapshotVersion: 12,
      sourceHash,
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(fixtureRevision);
    expect(sceneIrSourceRevisionHash(bundle.scene)).toBe(fixtureRevision);
    expect(bundle.scene.entities).toHaveLength(61);
    expect(bundle.scene.animationChannels).toHaveLength(58);

    const officialFixture = JSON.parse(await readFile("fixtures/engine-v1/real-write-stuff-v12.json", "utf8"));
    const official = sceneIrBundleV1Schema.parse({ assets: officialFixture.assets, scene: officialFixture.scene });
    expect(bundle.scene.entities.map(({ id, parentId }) => ({ id, parentId }))).toEqual(
      official.scene.entities.map(({ id, parentId }) => ({ id, parentId })),
    );
    expect(bundle.scene.animationChannels).toEqual(official.scene.animationChannels);
    const mathBounds = (scene: typeof bundle.scene) => {
      const points = scene.entities.slice(33).flatMap(({ geometry }) => {
        if (geometry.kind !== "cubic-path") throw new Error("WriteStuff MathTex roles must be cubic paths.");
        return geometry.path.subpaths.flatMap((subpath) => [
          subpath.start,
          ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
        ]);
      });
      const xs = points.map(({ x }) => x);
      const ys = points.map(({ y }) => y);
      return {
        center: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
        height: Math.max(...ys) - Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
      };
    };
    const editedBounds = mathBounds(bundle.scene);
    const officialBounds = mathBounds(official.scene);
    expect(editedBounds.center.x).toBeCloseTo(1.25, 12);
    expect(editedBounds.center.y).toBeCloseTo(-0.5, 12);
    expect(editedBounds.width / officialBounds.width).toBeCloseTo(0.5, 12);
    expect(editedBounds.height / officialBounds.height).toBeCloseTo(0.5, 12);

    const officialSource = await readFile("fixtures/real-preview-harness/example_scenes/basic.py", "utf8");
    const anchor = '        group.width = config["frame_width"] - 2 * LARGE_BUFF\n';
    const editedSource = officialSource.replace(
      anchor,
      `${anchor}        example_tex.move_to((1.25, -0.5, 0))\n        example_tex.scale(0.5)\n`,
    );
    expect(editedSource).not.toBe(officialSource);
    expect(sha256(new TextEncoder().encode(editedSource))).toBe(sourceHash);
    expect(fixture.producerReference).toEqual({
      engineCommit: "7b25d1ca96b8e6c3369344622de3ef5c32ac06fb",
      fastManimCommit: "8a1a4feb68c3ba47a2ff26c83b9bed4a6b095063",
      fastManimTree: "f1a5ef1b69711cf41c3424dd697ab75591942905",
      kind: "server-sealed-real-fast-manim-profile-v12",
      producerSnapshotDigest: "49e7491506b1514da26e70d035bf4b4cc34248ac17ac2688e801cf3459e98a24",
      snapshotHash: fixtureRevision,
      sourcePath: "example_scenes/basic.py",
      sourceSha256: sourceHash,
    });
    expect(fixture.samples).toEqual([
      {
        expected: { semanticDigest: "0d55846a1d4c4dd5556dd40d6c5deb34b4ed0e42a29bbb3ee31596262e3839cc" },
        id: "hold",
        packetId: "real-write-stuff-v12-edited:hold",
        sampleTime: 3.5,
        viewport: { heightPx: 360, widthPx: 640 },
      },
    ]);
  });

  it("pins the server-sealed real LineJoints V10 scene to native/browser and independent Cairo gates", async () => {
    const fixtureRevision = "53fd284f9fd30f8223f90dfc9c291d571bab25d61b55170d5e57cf346e1b2827";
    const corpus = await corpusFixture();
    const entry = corpus.entries.find(({ id }) => id === "real-line-joints-v10--static");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-real-line-joints-v10",
        path: "fixtures/engine-v1/real-line-joints-v10.json",
        revision: { kind: "imported-manim-server-snapshot", sha256: fixtureRevision },
      },
      sample: {
        id: "static",
        sampleTime: 0.5,
        semanticDigest: "25199374e0078a2fe619e48af3ace591f35d0468b93a7b1fec39fa004e41c73e",
        viewport: { heightPx: 360, widthPx: 640 },
      },
      thresholdException: null,
    });
    if (!entry) throw new Error("The LineJoints V10 visual-parity entry is missing.");
    expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);

    const fixture = JSON.parse(await readFile(entry.fixture.path, "utf8"));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-server-snapshot",
      runtimeConfigHash: "b99127c213f9e049ffd247c8287bfba4f8d12d77e89bee5b1308bafc2527e9ec",
      snapshotHash: fixtureRevision,
      snapshotVersion: 10,
      sourceHash: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(fixtureRevision);
    expect(bundle.scene.entities).toHaveLength(4);
    expect(bundle.scene.entities[0]?.geometry).toEqual({ kind: "group" });
    expect(
      bundle.scene.entities
        .slice(1)
        .map((entity) => (entity.appearance.kind === "vector" ? entity.appearance.stroke?.join : null)),
    ).toEqual(["miter", "round", "bevel"]);
    expect(fixture.producerReference).toMatchObject({
      fastManimCommit: "29d21a2bd213df8ffeed0454278aa86289d190b8",
      kind: "server-sealed-real-fast-manim-profile-v10",
      snapshotHash: fixtureRevision,
      sourcePath: "example_scenes/basic.py",
      sourceSha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
    });
  });

  it("pins the actual producer snapshot after the Studio LineJoints move-and-scale edit", async () => {
    const fixtureRevision = "3de97161c0f5ff210f2a0b7e461bc7067dcc8a0eb92c66f02d3a870dfbd27a7f";
    const sourceHash = "d95608a27f48b4cc2b9d7a5201cf455d38c400a91bd975b4a0d62575cf6ab027";
    const corpus = await corpusFixture();
    const entry = corpus.entries.find(({ id }) => id === "real-line-joints-v10-edited--static");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-real-line-joints-v10-edited",
        path: "fixtures/engine-v1/real-line-joints-v10-edited.json",
        revision: { kind: "imported-manim-server-snapshot", sha256: fixtureRevision },
      },
      sample: {
        id: "static",
        sampleTime: 0.5,
        semanticDigest: "7653377ca65bb58905c119a980b8849865511aa641345b9f8c5b4a5a501f4ade",
        viewport: { heightPx: 360, widthPx: 640 },
      },
      thresholdException: null,
    });
    if (!entry) throw new Error("The edited LineJoints V10 visual-parity entry is missing.");
    expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);

    const fixtureBytes = new Uint8Array(await readFile(entry.fixture.path));
    expect(fixtureBytes.byteLength).toBeLessThanOrEqual(16 * 1024);
    const fixture = JSON.parse(new TextDecoder().decode(fixtureBytes));
    const bundle = sceneIrBundleV1Schema.parse({ assets: fixture.assets, scene: fixture.scene });
    expect(bundle.scene.source).toMatchObject({
      kind: "imported-manim-server-snapshot",
      runtimeConfigHash: "b99127c213f9e049ffd247c8287bfba4f8d12d77e89bee5b1308bafc2527e9ec",
      snapshotHash: fixtureRevision,
      snapshotVersion: 10,
      sourceHash,
    });
    expect(digestFastManimSnapshotBundleV1(bundle)).toBe(fixtureRevision);
    expect(sceneIrSourceRevisionHash(bundle.scene)).toBe(fixtureRevision);
    expect(bundle.scene.entities).toHaveLength(4);
    expect(
      bundle.scene.entities
        .slice(1)
        .map((entity) => (entity.appearance.kind === "vector" ? entity.appearance.stroke?.join : null)),
    ).toEqual(["miter", "round", "bevel"]);

    const officialFixture = JSON.parse(await readFile("fixtures/engine-v1/real-line-joints-v10.json", "utf8"));
    const editedTarget = bundle.scene.entities[2];
    const officialTarget = sceneIrBundleV1Schema.parse({
      assets: officialFixture.assets,
      scene: officialFixture.scene,
    }).scene.entities[2];
    if (editedTarget?.geometry.kind !== "cubic-path" || officialTarget?.geometry.kind !== "cubic-path") {
      throw new Error("Both LineJoints fixtures must retain the central Triangle path.");
    }
    const bounds = (geometry: typeof editedTarget.geometry) => {
      const points = geometry.path.subpaths.flatMap((subpath) => [
        subpath.start,
        ...subpath.segments.flatMap(({ control1, control2, end }) => [control1, control2, end]),
      ]);
      const xs = points.map(({ x }) => x);
      const ys = points.map(({ y }) => y);
      return {
        center: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
        height: Math.max(...ys) - Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
      };
    };
    const editedBounds = bounds(editedTarget.geometry);
    const officialBounds = bounds(officialTarget.geometry);
    expect(editedBounds.center.x).toBeCloseTo(1.25, 12);
    expect(editedBounds.center.y).toBeCloseTo(-0.5, 12);
    expect(editedBounds.width / officialBounds.width).toBeCloseTo(0.5, 12);
    expect(editedBounds.height / officialBounds.height).toBeCloseTo(0.5, 12);

    const officialSource = await readFile("fixtures/real-preview-harness/example_scenes/basic.py", "utf8");
    const editedSource = officialSource.replace(
      "        grp.set(width=config.frame_width - 1)\n\n        self.add(grp)",
      "        grp.set(width=config.frame_width - 1)\n        t2.move_to((1.25, -0.5, 0))\n        t2.scale(0.5)\n\n        self.add(grp)",
    );
    expect(editedSource).not.toBe(officialSource);
    expect(sha256(new TextEncoder().encode(editedSource))).toBe(sourceHash);
    expect(fixture.producerReference).toEqual({
      engineCommit: "f11f6278466c54055d7c7043e0f32bec68a12a16",
      fastManimCommit: "cd0cb237606b240a3c795b1171d61eeb3cef5305",
      fastManimTree: "8007d53a31d2918e81116c675c352edc761a6ef2",
      kind: "server-sealed-real-fast-manim-profile-v10",
      producerSnapshotDigest: "6262b10ed9af78be6ad939987f043ed52d6500b392c4d0007070937bc1abaac8",
      snapshotHash: fixtureRevision,
      sourcePath: "example_scenes/basic.py",
      sourceSha256: sourceHash,
    });
  });

  it("compares all four sRGB byte channels and uses a strict >8 pixel classification", async () => {
    const corpus = await corpusFixture();
    const expected = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const within = Uint8Array.from([18, 12, 38, 32, 58, 52, 78, 72]);
    const metricsWithin = compareVisualParityFramesV1(
      expected,
      within,
      { heightPx: 1, widthPx: 2 },
      corpus.metricContract,
    );
    expect(metricsWithin.pixelCountAboveThreshold).toBe(0);

    const alphaOutside = Uint8Array.from(within);
    alphaOutside[7] = 71;
    const metricsOutside = compareVisualParityFramesV1(
      expected,
      alphaOutside,
      { heightPx: 1, widthPx: 2 },
      corpus.metricContract,
    );
    expect(metricsOutside.pixelCountAboveThreshold).toBe(1);
    expect(metricsOutside.pixelFractionAboveThreshold).toBe(0.5);
    expect(
      compareVisualParityFramesV1(expected, expected, { heightPx: 1, widthPx: 2 }, corpus.metricContract).ssim,
    ).toBe(1);
  });

  it("encodes stable RGBA PNG bytes and an opaque max-channel diff", () => {
    const expected = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
    const actual = Uint8Array.from([9, 1, 1, 12, 2, 8, 6, 7]);
    const diff = makeOpaqueVisualParityDiffV1(expected, actual);
    expect([...diff]).toEqual([9, 9, 9, 255, 3, 3, 3, 255]);

    const pngA = encodeRgbaPngV1(expected, 2, 1);
    const pngB = encodeRgbaPngV1(expected, 2, 1);
    expect(pngA).toEqual(pngB);
    expect([...pngA.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const idatLength = Buffer.from(pngA).readUInt32BE(33);
    const scanlines = inflateSync(pngA.subarray(41, 41 + idatLength));
    expect([...scanlines]).toEqual([0, ...expected]);
  });

  it("keeps the report schema strict", () => {
    expect(
      visualParityReportV1Schema.safeParse({
        schema: "poietra.visual-parity-report",
        version: 1,
        silentlyBypass: true,
      }).success,
    ).toBe(false);
  });

  it("rejects internally inconsistent report gates, fractions, and RGBA lengths", async () => {
    const corpus = await corpusFixture();
    const digest = "a".repeat(64);
    const valid = {
      artifacts: { actualPng: "actual.png", diffPng: "diff.png", expectedPng: "expected.png" },
      browser: {
        capturePolicy: "exactly-one-render-submit",
        renderSubmissionCount: 1,
        rgbaByteLength: 8,
        rgbaSha256: digest,
        surfaceFormat: "rgba8unorm",
        viewFormat: "Rgba8UnormSrgb",
      },
      corpus: {
        entryId: "fixture--sample",
        metricSchema: "poietra.visual-parity-metric",
        metricVersion: 1,
        schema: "poietra.visual-parity-corpus",
        version: 1,
      },
      fixture: {
        fixtureId: "fixture",
        fixturePath: "fixtures/example.json",
        fixtureRevision: digest,
        sampleId: "sample",
        sampleTime: 0,
        semanticDigest: digest,
        viewport: { heightPx: 1, widthPx: 2 },
      },
      gate: {
        maximumPixelFractionAboveThreshold: 0.005,
        minimumSsim: 0.995,
        passed: true,
        thresholdException: null,
      },
      metricContract: corpus.metricContract,
      metrics: { pixelCount: 2, pixelCountAboveThreshold: 0, pixelFractionAboveThreshold: 0, ssim: 1 },
      native: {
        adapter: {
          backend: "Vulkan",
          device: 0,
          deviceType: "Cpu",
          driver: "fixture",
          driverInfo: "fixture",
          fallbackRequested: true,
          name: "fixture adapter",
          vendor: 0,
        },
        format: "Rgba8UnormSrgb",
        metadataSha256: digest,
        rgbaByteLength: 8,
        rgbaSha256: digest,
      },
      schema: "poietra.visual-parity-report",
      version: 1,
    };
    expect(visualParityReportV1Schema.safeParse(valid).success).toBe(true);
    expect(
      visualParityReportV1Schema.safeParse({
        ...valid,
        browser: { ...valid.browser, viewFormat: "Rgba8Unorm" },
        native: { ...valid.native, format: "Rgba8Unorm" },
      }).success,
    ).toBe(true);
    expect(
      visualParityReportV1Schema.safeParse({
        ...valid,
        browser: { ...valid.browser, viewFormat: "Rgba8Unorm" },
      }).success,
    ).toBe(false);
    expect(visualParityReportV1Schema.safeParse({ ...valid, gate: { ...valid.gate, passed: false } }).success).toBe(
      false,
    );
    expect(
      visualParityReportV1Schema.safeParse({
        ...valid,
        metrics: { ...valid.metrics, pixelFractionAboveThreshold: 0.25 },
      }).success,
    ).toBe(false);
    expect(
      visualParityReportV1Schema.safeParse({
        ...valid,
        browser: { ...valid.browser, rgbaByteLength: 4 },
      }).success,
    ).toBe(false);
  });

  it("pins generic stroke topology and composition to the default full-RGBA gate", async () => {
    const corpus = await corpusFixture();
    const entry = corpus.entries.find(({ id }) => id === "generic-stroke-topology--sample");
    expect(entry).toMatchObject({
      fixture: {
        id: "eng-v1-generic-stroke-topology",
        revision: { sha256: "c".repeat(64) },
      },
      sample: {
        id: "sample",
        sampleTime: 0.5,
        semanticDigest: "168d5dd63f8e50c8b79bd25fd34de99b5cde9280088771e0f2a7850e693af252",
        viewport: { heightPx: 90, widthPx: 160 },
      },
      thresholdException: null,
    });
    if (!entry) throw new Error("The generic stroke visual parity entry is missing.");
    expect(thresholdsForEntryV1(corpus, entry)).toEqual(corpus.defaultThresholds);

    const fixture = JSON.parse(await readFile("fixtures/engine-v1/generic-stroke-topology.json", "utf8"));
    expect(fixture.scene.source.revisionHash).toBe(entry.fixture.revision.sha256);
    expect(fixture.sample).toMatchObject({
      expected: { semanticDigest: entry.sample.semanticDigest },
      id: entry.sample.id,
      sampleTime: entry.sample.sampleTime,
      viewport: entry.sample.viewport,
    });
    expect(Object.keys(fixture.reference.samples)).toHaveLength(10);
  });
});
