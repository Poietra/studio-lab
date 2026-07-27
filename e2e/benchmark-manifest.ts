import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * HTTP-side verification of the benchmark build manifest written by
 * scripts/benchmark-build-manifest.mjs. The harness fetches the manifest and
 * every listed file from the static server it is actually measuring against,
 * so the verified bytes are the served bytes — a stale, swapped, or
 * wrong-commit build is rejected instead of measured. Verification runs
 * before AND after measurement.
 */
export const BENCHMARK_BUILD_MANIFEST_PATH = "benchmark-build-manifest.json";

export const benchmarkBuildManifestSchema = z
  .object({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    files: z
      .array(
        z
          .object({
            byteLength: z.number().int().nonnegative(),
            path: z.string().min(1).max(500),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(3),
    generatedAtEpochMs: z.number().int().nonnegative(),
    schema: z.literal("poietra.benchmark-build-manifest"),
    treeState: z.enum(["clean", "dirty"]),
    version: z.literal(1),
  })
  .strict();

export type BenchmarkBuildManifest = z.infer<typeof benchmarkBuildManifestSchema>;

export type ServedFileFetcher = (path: string) => Promise<Uint8Array>;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Pure comparison so the verification rule itself is unit-testable. */
export function manifestFileMismatch(
  file: BenchmarkBuildManifest["files"][number],
  servedBytes: Uint8Array,
): string | null {
  if (servedBytes.byteLength !== file.byteLength) {
    return `served ${file.path} has ${servedBytes.byteLength} bytes, manifest expects ${file.byteLength}`;
  }
  const digest = sha256Hex(servedBytes);
  if (digest !== file.sha256) {
    return `served ${file.path} hashes to ${digest}, manifest expects ${file.sha256}`;
  }
  return null;
}

export async function verifyServedBuildManifest(
  fetchServedFile: ServedFileFetcher,
  expected: Readonly<{ headCommit: string; treeState: "clean" | "dirty" }>,
): Promise<BenchmarkBuildManifest> {
  const manifestBytes = await fetchServedFile(BENCHMARK_BUILD_MANIFEST_PATH);
  const manifest = benchmarkBuildManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (manifest.commit !== expected.headCommit) {
    throw new Error(
      `the served build manifest was built at commit ${manifest.commit}, but this run's HEAD is ${expected.headCommit}; rebuild through the canonical runner instead of measuring a stale build`,
    );
  }
  // Commit equality alone is not provenance: a build produced from a DIRTY
  // tree at the same HEAD contains bytes no commit describes. The manifest's
  // build-time tree state must match this run's tree state exactly, so a
  // clean (decision-candidate) run can only ever verify against a manifest
  // stamped by a clean-tree build.
  if (manifest.treeState !== expected.treeState) {
    throw new Error(
      `the served build manifest was built from a ${manifest.treeState} tree, but this run's tree is ${expected.treeState}; the served bytes cannot be attributed to this run's provenance — rebuild through the canonical runner`,
    );
  }
  for (const file of manifest.files) {
    const mismatch = manifestFileMismatch(file, await fetchServedFile(file.path));
    if (mismatch) throw new Error(`benchmark build verification failed: ${mismatch}`);
  }
  return manifest;
}

/**
 * One verifier per benchmark run: fetches the manifest and every listed file
 * over HTTP and checks them against the run's commit identity. Specs call it
 * before and after their measured spans so a mid-run redeploy cannot pass.
 */
export function makeServedBuildVerifier(
  request: Readonly<{ get(url: string): Promise<{ body(): Promise<Buffer>; ok(): boolean; status(): number }> }>,
  commitIdentity: Readonly<{ headCommit: string; treeState: "clean" | "dirty" }>,
): () => Promise<BenchmarkBuildManifest> {
  const fetchServedFile = async (path: string) => {
    const response = await request.get(`/${path}`);
    if (!response.ok()) throw new Error(`the static server did not serve ${path}: ${response.status()}`);
    return new Uint8Array(await response.body());
  };
  return () =>
    verifyServedBuildManifest(fetchServedFile, {
      headCommit: commitIdentity.headCommit,
      treeState: commitIdentity.treeState,
    });
}
