import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MATHTEX_ARTIFACT_BUILD_ATTEMPTS_V1,
  MATHTEX_ARTIFACT_BUILD_SCRIPT_V1,
  MATHTEX_ARTIFACT_BUILDER_IMAGE_V1,
  MATHTEX_ARTIFACT_DERIVATION_SCHEMA_V1,
  MATHTEX_ARTIFACT_FILE_V1,
  MATHTEX_ARTIFACT_RUST_VERSION_V1,
  mathTexArtifactContainerArguments,
  parseMathTexArtifactDerivationArguments,
  parseMathTexArtifactDerivationReport,
  removeMathTexArtifactContainer,
  withMathTexArtifactBuildContext,
} from "./derive-mathtex-artifact.mjs";

const input = Object.freeze({
  engineArchiveSha256: "a".repeat(64),
  engineCommit: "b".repeat(40),
  engineTree: "c".repeat(40),
});

function report(overrides: Readonly<Record<string, unknown>> = {}) {
  return Buffer.from(
    JSON.stringify({
      artifactFile: MATHTEX_ARTIFACT_FILE_V1,
      artifactSha256: "d".repeat(64),
      artifactSizeBytes: 4_657_248,
      builderImage: MATHTEX_ARTIFACT_BUILDER_IMAGE_V1,
      cleanBuilds: 2,
      engineArchiveSha256: input.engineArchiveSha256,
      engineCommit: input.engineCommit,
      engineTree: input.engineTree,
      rustVersion: MATHTEX_ARTIFACT_RUST_VERSION_V1,
      schema: MATHTEX_ARTIFACT_DERIVATION_SCHEMA_V1,
      target: "x86_64-unknown-linux-gnu",
      version: 1,
      ...overrides,
    }),
  );
}

describe("MathTex artifact derivation", () => {
  it("accepts only full immutable engine pins", () => {
    expect(
      parseMathTexArtifactDerivationArguments([input.engineCommit, input.engineTree, input.engineArchiveSha256]),
    ).toEqual(input);
    for (const invalid of [
      [],
      [input.engineCommit, input.engineTree],
      [input.engineCommit.toUpperCase(), input.engineTree, input.engineArchiveSha256],
      [input.engineCommit, "c".repeat(39), input.engineArchiveSha256],
      [input.engineCommit, input.engineTree, "d".repeat(63)],
    ]) {
      expect(() => parseMathTexArtifactDerivationArguments(invalid)).toThrow();
    }
  });

  it("constructs only an ephemeral pinned-builder container without an image build", () => {
    const arguments_ = mathTexArtifactContainerArguments(
      input,
      "/tmp/poietra-context/studio-engine.tar.gz",
      "/tmp/poietra-output",
      "poietra-mathtex-artifact-context-first",
    );
    expect(arguments_).toEqual(
      expect.arrayContaining([
        "run",
        "--rm",
        "--pull",
        "never",
        "--platform",
        "linux/amd64",
        "--name",
        "poietra-mathtex-artifact-context-first",
        MATHTEX_ARTIFACT_BUILDER_IMAGE_V1,
        MATHTEX_ARTIFACT_BUILD_SCRIPT_V1,
      ]),
    );
    expect(arguments_).toEqual(
      expect.arrayContaining([
        "CARGO_HOME=/opt/poietra-build/cargo-home",
        "CARGO_INCREMENTAL=0",
        "CARGO_TARGET_DIR=/opt/poietra-build/target",
        "PYO3_NO_PYTHON=1",
        "SOURCE_DATE_EPOCH=0",
        `STUDIO_ENGINE_ARCHIVE_SHA256=${input.engineArchiveSha256}`,
        `STUDIO_ENGINE_COMMIT=${input.engineCommit}`,
        `STUDIO_ENGINE_TREE=${input.engineTree}`,
      ]),
    );
    expect(arguments_).not.toContain("build");
    expect(arguments_).not.toContain("--tag");
    expect(() =>
      mathTexArtifactContainerArguments(
        input,
        "relative",
        "/tmp/poietra-output",
        "poietra-mathtex-artifact-context-first",
      ),
    ).toThrow();
    expect(() =>
      mathTexArtifactContainerArguments(
        input,
        "/tmp/poietra-context/studio-engine.tar.gz",
        "/tmp/poietra-output",
        "unscoped",
      ),
    ).toThrow();
  });

  it("fixes two distinct clean builder attempts", () => {
    expect(MATHTEX_ARTIFACT_BUILD_ATTEMPTS_V1).toEqual(["first", "second"]);
    expect(new Set(MATHTEX_ARTIFACT_BUILD_ATTEMPTS_V1).size).toBe(2);
  });

  it("removes only the exact named derivation container and proves it is gone", async () => {
    const containerId = "e".repeat(64);
    const calls: string[][] = [];
    let listCalls = 0;
    await removeMathTexArtifactContainer(
      "poietra-mathtex-artifact-context-first",
      async (_command: string, arguments_: readonly string[]) => {
        calls.push([...arguments_]);
        if (arguments_[1] === "ls") {
          listCalls += 1;
          return listCalls === 1 ? containerId : "";
        }
        return "";
      },
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("name=^/poietra-mathtex-artifact-context-first$");
    expect(calls[0]).toContain("label=io.poietra.mathtex-artifact-derivation=v1");
    expect(calls[1]).toEqual(["container", "rm", "--force", containerId]);
    await expect(
      removeMathTexArtifactContainer("poietra-mathtex-artifact-context-first", async () => "unexpected"),
    ).rejects.toThrow("unexpected container");
  });

  it("validates a bounded exact report and rejects provenance drift", () => {
    expect(parseMathTexArtifactDerivationReport(report(), input)).toMatchObject({
      artifactSha256: "d".repeat(64),
      cleanBuilds: 2,
      ...input,
    });
    for (const invalid of [
      report({ cleanBuilds: 1 }),
      report({ engineCommit: "e".repeat(40) }),
      report({ builderImage: "rust:latest" }),
      report({ artifactSha256: "not-a-digest" }),
      report({ unexpected: true }),
      Buffer.alloc(4 * 1024 + 1),
    ]) {
      expect(() => parseMathTexArtifactDerivationReport(invalid, input)).toThrow();
    }
  });

  it("removes its bounded temporary context after success and failure", async () => {
    let successfulPath = "";
    await withMathTexArtifactBuildContext(async (contextPath) => {
      successfulPath = contextPath;
      await writeFile(`${contextPath}/evidence`, "ok", { encoding: "utf8", mode: 0o600 });
      expect(existsSync(contextPath)).toBe(true);
    });
    expect(existsSync(successfulPath)).toBe(false);

    let failedPath = "";
    await expect(
      withMathTexArtifactBuildContext(async (contextPath) => {
        failedPath = contextPath;
        throw new Error("expected failure");
      }),
    ).rejects.toThrow("expected failure");
    expect(existsSync(failedPath)).toBe(false);
  });

  it("keeps ephemeral derivation on the production builder and exact Cargo contract", () => {
    const derivationSource = readFileSync(
      fileURLToPath(new URL("./derive-mathtex-artifact.mjs", import.meta.url)),
      "utf8",
    );
    const productionContainerfile = readFileSync(
      fileURLToPath(new URL("../sandbox/fast-manim-gated-oci/Containerfile", import.meta.url)),
      "utf8",
    );
    for (const contract of [
      MATHTEX_ARTIFACT_BUILDER_IMAGE_V1,
      MATHTEX_ARTIFACT_RUST_VERSION_V1,
      "CARGO_HOME=/opt/poietra-build/cargo-home",
      "CARGO_INCREMENTAL=0",
      "CARGO_TARGET_DIR=/opt/poietra-build/target",
      "PYO3_NO_PYTHON=1",
      "SOURCE_DATE_EPOCH=0",
      "STUDIO_ENGINE_ARCHIVE_SHA256",
      "STUDIO_ENGINE_COMMIT",
      "STUDIO_ENGINE_TREE",
      "/opt/poietra-build/studio-engine.tar.gz",
      "/opt/poietra-build/studio",
      "env -u MATHTEX_EXTENSION_SHA256 cargo build --locked",
      "--profile mathtex-python-release",
      "--package poietra-mathtex-py",
      "--manifest-path /opt/poietra-build/studio/engine/Cargo.toml",
      "--target x86_64-unknown-linux-gnu",
    ]) {
      expect(derivationSource).toContain(contract);
      expect(productionContainerfile).toContain(contract);
    }
    expect(derivationSource).toContain("for (const attempt of MATHTEX_ARTIFACT_BUILD_ATTEMPTS_V1)");
    expect(derivationSource).not.toContain("manimcommunity/manim");
  });
});
