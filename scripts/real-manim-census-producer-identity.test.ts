import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fastManimRuntimeTraceProducerEnvironment,
  TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY,
} from "../server/fast-manim-runtime-trace-producer-identity";
import { loadRealManimCensusManifest } from "./real-manim-census-report";
import {
  REAL_MANIM_EDITABILITY_MANIFEST_DIGEST,
  REAL_MANIM_EDITABILITY_PRODUCER_DIGEST,
} from "./real-manim-editability-census-report";
import { loadRealManimProjectCensusManifest } from "./real-manim-project-census";

const fixtureRoot = join(import.meta.dirname, "..", "fixtures");

describe("real-Manim census producer identity", () => {
  it.each([
    {
      manifest: join(fixtureRoot, "real-manim-census-v1", "manifest.json"),
      version: 1,
    },
    {
      manifest: join(fixtureRoot, "real-manim-census-v2", "manifest.json"),
      version: 2,
    },
  ])("keeps the v$version manifest and Studio trust anchor aligned", async ({ manifest, version }) => {
    const parsedManifest =
      version === 1 ? await loadRealManimCensusManifest(manifest) : await loadRealManimProjectCensusManifest(manifest);

    expect({
      fastManimCommit: parsedManifest.producer.revision,
      fastManimTree: parsedManifest.producer.tree,
    }).toEqual(TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY);
    expect(
      fastManimRuntimeTraceProducerEnvironment({
        fastManimCommit: parsedManifest.producer.revision,
        fastManimTree: parsedManifest.producer.tree,
      }),
    ).toEqual({
      POIETRA_FAST_MANIM_COMMIT: parsedManifest.producer.revision,
      POIETRA_FAST_MANIM_TREE: parsedManifest.producer.tree,
    });
  });

  it("keeps the reproduced v2 baseline on the verified producer", async () => {
    const manifest = await loadRealManimProjectCensusManifest(
      join(fixtureRoot, "real-manim-census-v2", "manifest.json"),
    );
    const baseline = JSON.parse(await readFile(join(fixtureRoot, "real-manim-census-v2", "baseline.json"), "utf8")) as {
      producerDigest?: unknown;
    };

    expect(baseline.producerDigest).toBe(manifest.producer.digest);
  });

  it("keeps the historical V1 playback floor bound to its original producer evidence", async () => {
    const [historicalBytes, playbackBaselineBytes, editabilityBaselineBytes, currentManifest] = await Promise.all([
      readFile(join(fixtureRoot, "real-manim-editability-census-v1", "playback-manifest.json")),
      readFile(join(fixtureRoot, "real-manim-census-v1", "baseline.json")),
      readFile(join(fixtureRoot, "real-manim-editability-census-v1", "baseline.json")),
      loadRealManimCensusManifest(join(fixtureRoot, "real-manim-census-v1", "manifest.json")),
    ]);
    const historical = JSON.parse(historicalBytes.toString("utf8")) as {
      producer: { digest: string; revision: string; tree: string };
    };
    const playbackBaseline = JSON.parse(playbackBaselineBytes.toString("utf8")) as {
      manifestDigest: string;
      producerDigest: string;
    };
    const editabilityBaseline = JSON.parse(editabilityBaselineBytes.toString("utf8")) as {
      manifestDigest: string;
      producerDigest: string;
    };
    const manifestDigest = createHash("sha256").update(JSON.stringify(historical)).digest("hex");

    expect(manifestDigest).toBe(REAL_MANIM_EDITABILITY_MANIFEST_DIGEST);
    expect(historical.producer.digest).toBe(REAL_MANIM_EDITABILITY_PRODUCER_DIGEST);
    expect(playbackBaseline).toMatchObject({
      manifestDigest,
      producerDigest: historical.producer.digest,
    });
    expect(editabilityBaseline).toMatchObject({
      manifestDigest,
      producerDigest: historical.producer.digest,
    });
    expect({
      revision: historical.producer.revision,
      tree: historical.producer.tree,
    }).not.toEqual({
      revision: currentManifest.producer.revision,
      tree: currentManifest.producer.tree,
    });
    expect(historical.producer.digest).not.toBe(currentManifest.producer.digest);
  });
});
