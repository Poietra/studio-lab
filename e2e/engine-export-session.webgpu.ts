import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";

import { exportProfileHashV1, parseExportProfileV1 } from "../src/engine/export-profile";

/**
 * Composed browser MP4 export proof (issue #722).
 *
 * Installs the shared validated fixture Scene into the real WASM export
 * session and drives the complete pipeline — offscreen WebGPU frame
 * sequence → WebCodecs H.264 encoder → Rust MP4 muxer — inside a dedicated
 * worker, then asserts the produced bytes structurally: `ftyp` at offset 4,
 * the labeled provenance `uuid` box, one non-empty `mdat` per frame,
 * trailing `moov` with sane duration, keyframe-first `stss`, and the
 * `avcC`/`colr` sample-entry boxes. The invalid-profile admission refusal is
 * asserted unconditionally; the real encode proof self-skips with the
 * probe's named refusal when this Chromium ships no H.264 encoder.
 */

const FIXTURE_REVISION = "a".repeat(64);
const EXPORT_PROFILE = parseExportProfileV1({
  codec: "h264-mp4",
  colorContractVersion: 1,
  frameRate: 30,
  maxDurationSeconds: 900,
  maxOutputBytes: 134_217_728,
  resolution: "854x480",
  schema: "poietra.export-profile",
  version: 1,
});
/** ceil(duration 2 s * 30 fps) frames on the uniform export grid. */
const EXPECTED_FRAME_COUNT = 60;
const H264_CODEC_LADDER = ["avc1.64002A", "avc1.640028", "avc1.42E01F"] as const;
const PROVENANCE_UUID_LABEL = "poietra-prov-v01";

type ExportResultV1 = Readonly<Record<string, unknown>> & Readonly<{ kind: string }>;

type ExportSessionProofV1 = Readonly<{
  invalidProfileRejection: Readonly<{ message: string; name: string }> | null;
  kind: "export-session-proof";
  mp4Base64: string | null;
  probe: Readonly<{ result: ExportResultV1; schema: string; version: number }>;
  progress: readonly ExportResultV1[];
  run: ExportResultV1 | null;
}>;

type Mp4BoxV1 = Readonly<{ payloadEnd: number; payloadStart: number; size: number; start: number; type: string }>;

function readBoxes(bytes: Uint8Array, start: number, end: number): Mp4BoxV1[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Mp4BoxV1[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) throw new Error(`Truncated box header at offset ${offset}.`);
    let size = view.getUint32(offset);
    const type = new TextDecoder("ascii").decode(bytes.subarray(offset + 4, offset + 8));
    let payloadStart = offset + 8;
    if (size === 0) {
      size = end - offset;
    } else if (size === 1) {
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Unsupported oversized box.");
      size = Number(largeSize);
      payloadStart = offset + 16;
    }
    if (size < payloadStart - offset || offset + size > end) {
      throw new Error(`Box ${type} at offset ${offset} exceeds its container.`);
    }
    boxes.push({ payloadEnd: offset + size, payloadStart, size, start: offset, type });
    offset += size;
  }
  return boxes;
}

function childBox(bytes: Uint8Array, parent: Mp4BoxV1, type: string): Mp4BoxV1 {
  const child = readBoxes(bytes, parent.payloadStart, parent.payloadEnd).find((box) => box.type === type);
  if (!child) throw new Error(`Container ${parent.type} holds no ${type} box.`);
  return child;
}

function descendantBox(bytes: Uint8Array, root: Mp4BoxV1, path: readonly string[]): Mp4BoxV1 {
  let current = root;
  for (const type of path) current = childBox(bytes, current, type);
  return current;
}

async function proveExportSession(page: Page, snapshotJson: string, profileJson: string) {
  await page.goto("/");
  return page.evaluate(
    async ({ profileJson, snapshotJson }) => {
      const worker = new Worker("/e2e/engine-export-session.worker.ts", { type: "module" });
      type WorkerProof = Omit<ExportSessionProofV1, "mp4Base64"> & Readonly<{ mp4: ArrayBuffer | null }>;
      const response = new Promise<WorkerProof>((resolve, reject) => {
        worker.addEventListener(
          "error",
          (event) => reject(new Error(event.message || "The export session worker crashed.")),
          { once: true },
        );
        worker.addEventListener(
          "message",
          (event: MessageEvent<WorkerProof | Readonly<{ kind: "error"; message: string }>>) => {
            if (event.data.kind === "error") {
              reject(new Error(event.data.message));
              return;
            }
            resolve(event.data);
          },
          { once: true },
        );
      });
      const snapshotBytes = new TextEncoder().encode(snapshotJson);
      worker.postMessage(
        {
          kind: "prove-export-session",
          profileJson,
          snapshotJson: snapshotBytes.buffer,
          wasmModuleUrl: new URL("/engine-wasm/poietra_wasm.js", location.href).href,
        },
        [snapshotBytes.buffer],
      );
      try {
        const proof = await response;
        let mp4Base64: string | null = null;
        if (proof.mp4) {
          const bytes = new Uint8Array(proof.mp4);
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          mp4Base64 = btoa(binary);
        }
        return {
          invalidProfileRejection: proof.invalidProfileRejection,
          kind: proof.kind,
          mp4Base64,
          probe: proof.probe,
          progress: proof.progress,
          run: proof.run,
        } satisfies ExportSessionProofV1;
      } finally {
        worker.terminate();
      }
    },
    { profileJson, snapshotJson },
  );
}

test("the composed export session muxes the fixture Scene into a structurally valid MP4", async ({ page }) => {
  test.setTimeout(300_000);
  const fixture = JSON.parse(await readFile("fixtures/engine-v1/shared-circle-opacity.json", "utf8")) as Readonly<{
    assets: unknown;
    scene: unknown;
  }>;
  const snapshotJson = JSON.stringify({ assets: fixture.assets, scene: fixture.scene });
  const profileJson = JSON.stringify(EXPORT_PROFILE);

  const proof = await proveExportSession(page, snapshotJson, profileJson);

  // The named admission refusal holds in every environment, with or without
  // a usable H.264 encoder.
  expect(proof.invalidProfileRejection).not.toBeNull();
  expect(proof.invalidProfileRejection?.name).toBe("PoietraExportSessionRefused");
  expect(proof.invalidProfileRejection?.message).toMatch(/^invalid-profile: /);

  expect(proof.probe.schema).toBe("poietra.export-encoder-response");
  test.skip(
    proof.probe.result.kind !== "supported",
    `The fail-closed probe refused H.264 encoding here: ${JSON.stringify(proof.probe.result)}`,
  );

  const run = proof.run;
  expect(run).not.toBeNull();
  if (!run) throw new Error("unreachable: the supported probe produced no run result.");
  expect(run.kind, `run result: ${JSON.stringify(run)}`).toBe("finished");
  expect(run.frameCount).toBe(EXPECTED_FRAME_COUNT);
  expect(run.chunkCount).toBe(EXPECTED_FRAME_COUNT);
  expect(run.keyFrameCount).toBeGreaterThanOrEqual(1);
  expect(run.sceneRevisionHash).toBe(FIXTURE_REVISION);
  expect(run.exportProfileHash).toBe(await exportProfileHashV1(EXPORT_PROFILE));
  expect(H264_CODEC_LADDER).toContain(run.codec);
  const color = run.color as Readonly<{ source: string }>;
  expect(["measured", "mixed", "requested"]).toContain(color.source);
  test.info().annotations.push(
    { description: String(run.codec), type: "export-codec" },
    { description: JSON.stringify(run.color), type: "export-colr" },
  );

  // Progress envelopes advance monotonically to the full grid.
  expect(proof.progress.length).toBe(EXPECTED_FRAME_COUNT);
  let previousFramesEncoded = 0;
  for (const progress of proof.progress) {
    expect(progress.kind).toBe("progress");
    expect(progress.frameCount).toBe(EXPECTED_FRAME_COUNT);
    expect(progress.framesEncoded).toBeGreaterThan(previousFramesEncoded);
    previousFramesEncoded = progress.framesEncoded as number;
  }
  expect(previousFramesEncoded).toBe(EXPECTED_FRAME_COUNT);

  expect(proof.mp4Base64).not.toBeNull();
  const mp4 = new Uint8Array(Buffer.from(proof.mp4Base64 ?? "", "base64"));
  expect(mp4.byteLength).toBe(run.outputByteLength);
  expect(mp4.byteLength).toBeLessThanOrEqual(EXPORT_PROFILE.maxOutputBytes);

  // ftyp at offset 4, exactly as the server-side signature checks expect.
  expect(new TextDecoder("ascii").decode(mp4.subarray(4, 8))).toBe("ftyp");

  // Top-level layout: ftyp | uuid (provenance) | one mdat per frame | moov.
  const topLevel = readBoxes(mp4, 0, mp4.byteLength);
  expect(topLevel.map((box) => box.type)).toEqual([
    "ftyp",
    "uuid",
    ...Array.from({ length: EXPECTED_FRAME_COUNT }, () => "mdat"),
    "moov",
  ]);
  for (const mdat of topLevel.filter((box) => box.type === "mdat")) {
    expect(mdat.payloadEnd - mdat.payloadStart).toBeGreaterThan(0);
  }

  // The labeled provenance uuid box carries the canonical JSON payload.
  const uuid = topLevel[1];
  if (!uuid) throw new Error("unreachable: the uuid box was asserted above.");
  const uuidLabel = new TextDecoder("ascii").decode(mp4.subarray(uuid.payloadStart, uuid.payloadStart + 16));
  expect(uuidLabel).toBe(PROVENANCE_UUID_LABEL);
  const provenance = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(mp4.subarray(uuid.payloadStart + 16, uuid.payloadEnd)),
  ) as Readonly<Record<string, unknown>>;
  expect(provenance.schema).toBe("poietra.export-provenance");
  expect(provenance.sceneRevisionHash).toBe(FIXTURE_REVISION);
  expect(provenance.exportProfileHash).toBe(await exportProfileHashV1(EXPORT_PROFILE));
  expect(typeof provenance.engineVersion).toBe("string");
  expect(typeof provenance.engineAbiVersion).toBe("number");

  // moov duration sanity: microsecond timescale, ~2 seconds of media.
  const moov = topLevel.at(-1);
  if (!moov) throw new Error("unreachable: the moov box was asserted above.");
  const mvhd = childBox(mp4, moov, "mvhd");
  const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
  const mvhdVersion = view.getUint8(mvhd.payloadStart);
  const timescale = mvhdVersion === 1 ? view.getUint32(mvhd.payloadStart + 20) : view.getUint32(mvhd.payloadStart + 12);
  const duration =
    mvhdVersion === 1 ? Number(view.getBigUint64(mvhd.payloadStart + 24)) : view.getUint32(mvhd.payloadStart + 16);
  expect(timescale).toBe(1_000_000);
  expect(duration).toBeGreaterThanOrEqual(1_900_000);
  expect(duration).toBeLessThanOrEqual(2_100_000);

  // Keyframe-first: the sync-sample table starts at sample 1, and the sample
  // entry carries the avcC decoder configuration plus the colr nclx box.
  const stbl = descendantBox(mp4, moov, ["trak", "mdia", "minf", "stbl"]);
  const stss = childBox(mp4, stbl, "stss");
  const stssEntryCount = view.getUint32(stss.payloadStart + 4);
  expect(stssEntryCount).toBeGreaterThanOrEqual(1);
  expect(view.getUint32(stss.payloadStart + 8)).toBe(1);
  const stsz = childBox(mp4, stbl, "stsz");
  expect(view.getUint32(stsz.payloadStart + 8)).toBe(EXPECTED_FRAME_COUNT);
  const stsdText = new TextDecoder("latin1").decode(mp4.subarray(stbl.payloadStart, stbl.payloadEnd));
  expect(stsdText).toContain("avc1");
  expect(stsdText).toContain("avcC");
  expect(stsdText).toContain("colr");
  expect(stsdText).toContain("nclx");
});
