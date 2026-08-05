import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  MANIM_TEX_NATURAL_METRICS_GENERATOR_V1,
  MANIM_TEX_NATURAL_METRICS_ROOT_V1,
  manimTexNaturalMetricsReferenceV1Schema,
  readManimTexNaturalMetricsReferenceV1,
} from "./manim-tex-natural-metrics";

const execFileAsync = promisify(execFile);

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withFixtureCopy(run: (root: string) => Promise<void>) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "poietra-manim-tex-metrics-test-"));
  const fixtureRoot = join(temporaryRoot, "fixture");
  try {
    await cp(MANIM_TEX_NATURAL_METRICS_ROOT_V1, fixtureRoot, { recursive: true });
    await run(fixtureRoot);
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

describe("Manim Tex natural metrics reference v1", () => {
  it("pins independent source/toolchain identity and ordered glyph/rule families", async () => {
    const reference = await readManimTexNaturalMetricsReferenceV1();
    expect(reference).toMatchObject({
      producer: {
        fastManimCommit: "842cdecc97a5ba32c2a30e0254c5f5dcd74382f0",
        fastManimTree: "6fad77addc72e1a97440265e27d02630cf5b37b4",
        manimVersion: "0.20.1",
        sceneConfig: { frameHeight: 8, frameWidth: 128 / 9 },
        texTemplate: { compiler: "latex", outputFormat: ".dvi" },
        uvLockSha256: "3244a21383800a8a1049438f24c54121c483b1a4ab24ae8523d8c852b7431753",
      },
      schema: "poietra.manim-tex-natural-metrics-reference",
      source: {
        className: "WriteStuff",
        repository: "Poietra/fast-manim",
        sourcePath: "example_scenes/basic.py",
        sourceSha256: "d75fa2596a5dd2c15d833bdb41846006b931617998dc87f88b723048a323af4f",
      },
      version: 1,
    });
    const officialText = reference.cases[3];
    const officialMath = reference.cases[4];
    expect(officialText.naturalMetrics.familyCount).toBe(15);
    expect(officialText.naturalMetrics.families.slice(11).map(({ paint }) => paint.fillColor)).toEqual(
      Array.from({ length: 4 }, () => "#F7D96F"),
    );
    expect(officialMath.naturalMetrics.familyCount).toBe(14);
    expect(officialText.naturalMetrics.families.map(({ familyPath }) => familyPath)).toEqual(
      Array.from({ length: 15 }, (_, order) => [0, order]),
    );
    expect(officialMath.naturalMetrics.families.map(({ familyPath }) => familyPath)).toEqual(
      Array.from({ length: 14 }, (_, order) => [0, order]),
    );
    expect(officialMath.naturalMetrics.families.filter(({ kind }) => kind === "rule")).toMatchObject([
      { kind: "rule", order: 6, size: { height: 0.0199242, width: 0.49847935 } },
      { kind: "rule", order: 12, size: { height: 0.0199242, width: 0.52528925 } },
    ]);
    expect(manimTexNaturalMetricsReferenceV1Schema.safeParse({ ...reference, unverifiedMetric: true }).success).toBe(
      false,
    );
  });

  it("proves font-size scaling and source scale/shift without double application", async () => {
    const { cases } = await readManimTexNaturalMetricsReferenceV1();
    const [pi48, pi72, piTransformed] = cases;
    expect(pi48.naturalMetrics.size).toEqual({ height: 0.22017435, width: 0.2689913 });
    expect(pi72.naturalMetrics.size).toEqual({ height: 0.330261525, width: 0.40348695 });
    expect(pi72.naturalMetrics.size.width / pi48.naturalMetrics.size.width).toBe(1.5);
    expect(pi72.naturalMetrics.size.height / pi48.naturalMetrics.size.height).toBe(1.5);
    expect(piTransformed.naturalMetrics).toEqual(pi48.naturalMetrics);
    expect(piTransformed.worldMetrics).toMatchObject({
      center: { x: -2.25, y: 1.5, z: 0 },
      size: { height: 1.54122045, width: 1.8829391 },
    });
  });

  it("pins official WriteStuff arrange(DOWN) and group-width layout", async () => {
    const { layout } = await readManimTexNaturalMetricsReferenceV1();
    expect(layout).toMatchObject({
      afterArrange: {
        children: [
          { center: { y: 0.8145358 }, size: { height: 0.35118305, width: 4.12697785 } },
          { center: { y: -0.300591525 }, size: { height: 1.3790716, width: 2.6486779 } },
        ],
        group: { size: { height: 1.98025465, width: 4.12697785 } },
      },
      afterWidth: {
        children: [
          { center: { y: 2.412282768989 }, size: { height: 1.040043691482, width: 12.222222222222 } },
          { center: { y: -0.890214716482 }, size: { height: 4.084179796496, width: 7.844173403763 } },
        ],
        group: { size: { height: 5.86460922946, width: 12.222222222222 } },
      },
      arrange: { buffer: 0.25, direction: { x: 0, y: -1 } },
      targetWidth: 12.222222222222221,
      uniformScale: 2.9615429659314083,
    });
  });

  it("rejects byte tampering and semantically invalid re-sealed font metrics", async () => {
    await withFixtureCopy(async (root) => {
      const referencePath = join(root, "reference.json");
      await writeFile(referencePath, `${await readFile(referencePath, "utf8")} `);
      await expect(readManimTexNaturalMetricsReferenceV1(root)).rejects.toThrow(/hashes to/);
    });
    await withFixtureCopy(async (root) => {
      const reference = structuredClone(await readManimTexNaturalMetricsReferenceV1(root));
      for (const snapshot of [reference.cases[1].naturalMetrics, reference.cases[1].worldMetrics]) {
        for (const geometry of [snapshot, ...snapshot.families]) {
          geometry.anchorBounds.left *= 1.01;
          geometry.anchorBounds.right *= 1.01;
          geometry.center.x *= 1.01;
          geometry.tightBounds.left *= 1.01;
          geometry.tightBounds.right *= 1.01;
          geometry.size.width *= 1.01;
        }
      }
      const encoded = `${canonicalJsonV1(reference)}\n`;
      await Promise.all([
        writeFile(join(root, "reference.json"), encoded),
        writeFile(join(root, "reference.json.sha256"), `${sha256(encoded)}  reference.json\n`),
      ]);
      await expect(readManimTexNaturalMetricsReferenceV1(root)).rejects.toThrow(/72px font scaling/);
    });
  });

  it.runIf(Boolean(process.env.POIETRA_MANIM_TEX_METRICS_REPOSITORY))(
    "regenerates byte-identical evidence twice from pinned fast-manim",
    async () => {
      const fastManim = process.env.POIETRA_MANIM_TEX_METRICS_REPOSITORY;
      if (!fastManim) throw new Error("POIETRA_MANIM_TEX_METRICS_REPOSITORY is required");
      const python = process.env.POIETRA_MANIM_TEX_METRICS_PYTHON ?? join(fastManim, ".venv", "bin", "python");
      const temporaryRoot = await mkdtemp(join(tmpdir(), "poietra-manim-tex-metrics-real-"));
      try {
        const hostileCwd = join(temporaryRoot, "hostile-cwd");
        await mkdir(hostileCwd);
        await writeFile(join(hostileCwd, "manim.cfg"), "[CLI]\nframe_width = 23\nframe_height = 13\n");
        const generator = resolve(MANIM_TEX_NATURAL_METRICS_GENERATOR_V1);
        const repository = resolve(fastManim);
        for (const output of ["first", "second"]) {
          await execFileAsync(
            python,
            [generator, "--fast-manim", repository, "--output", join(temporaryRoot, output)],
            {
              cwd: output === "second" ? hostileCwd : undefined,
              env: { ...process.env, PYTHONHASHSEED: "0" },
            },
          );
        }
        for (const file of ["reference.json", "reference.json.sha256"]) {
          const [first, second, pinned] = await Promise.all([
            readFile(join(temporaryRoot, "first", file)),
            readFile(join(temporaryRoot, "second", file)),
            readFile(join(MANIM_TEX_NATURAL_METRICS_ROOT_V1, file)),
          ]);
          expect(first).toEqual(second);
          expect(first).toEqual(pinned);
        }
      } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
      }
    },
  );
});
