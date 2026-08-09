import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fastManimRuntimeTraceProducerEnvironment,
  TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY,
} from "../server/fast-manim-runtime-trace-producer-identity";
import { loadRealManimCensusManifest } from "./real-manim-census-report";
import { loadRealManimProjectCensusManifest } from "./real-manim-project-census";

const fixtureRoot = join(import.meta.dirname, "..", "fixtures");

describe("real-Manim census producer identity", () => {
  it.each([
    {
      baseline: join(fixtureRoot, "real-manim-census-v1", "baseline.json"),
      manifest: join(fixtureRoot, "real-manim-census-v1", "manifest.json"),
      version: 1,
    },
    {
      baseline: join(fixtureRoot, "real-manim-census-v2", "baseline.json"),
      manifest: join(fixtureRoot, "real-manim-census-v2", "manifest.json"),
      version: 2,
    },
  ])(
    "keeps the v$version manifest, baseline, and Studio trust anchor aligned",
    async ({ baseline, manifest, version }) => {
      const parsedManifest =
        version === 1
          ? await loadRealManimCensusManifest(manifest)
          : await loadRealManimProjectCensusManifest(manifest);
      const parsedBaseline = JSON.parse(await readFile(baseline, "utf8")) as { producerDigest?: unknown };
      const manifestIdentity = {
        fastManimCommit: parsedManifest.producer.revision,
        fastManimTree: parsedManifest.producer.tree,
      };

      expect(manifestIdentity).toEqual(TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY);
      expect(fastManimRuntimeTraceProducerEnvironment(manifestIdentity)).toEqual({
        POIETRA_FAST_MANIM_COMMIT: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimCommit,
        POIETRA_FAST_MANIM_TREE: TRUSTED_FAST_MANIM_RUNTIME_TRACE_PRODUCER_IDENTITY.fastManimTree,
      });
      expect(parsedBaseline.producerDigest).toBe(parsedManifest.producer.digest);
    },
  );
});
