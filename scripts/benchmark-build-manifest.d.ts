export declare const BENCHMARK_BUILD_MANIFEST_FILENAME: string;
export declare const BENCHMARK_BUILD_MANIFEST_SCHEMA: string;
export declare const BENCHMARK_BUILD_MANIFEST_VERSION: number;

export type BenchmarkBuildManifestFile = Readonly<{ byteLength: number; path: string; sha256: string }>;
export type BenchmarkBuildManifest = Readonly<{
  commit: string;
  files: readonly BenchmarkBuildManifestFile[];
  generatedAtEpochMs: number;
  schema: string;
  treeState: "clean" | "dirty";
  version: number;
}>;

export declare function collectBenchmarkFilePaths(distDir: string): string[];
export declare function makeBenchmarkBuildManifest(
  distDir: string,
  identity: Readonly<{ commit: string; treeState: "clean" | "dirty" }>,
): BenchmarkBuildManifest;
export declare function writeBenchmarkBuildManifest(distDir: string): BenchmarkBuildManifest;
