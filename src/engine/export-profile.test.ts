import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  canonicalExportProfileV1,
  digestExportProfileV1,
  EXPORT_RESOLUTION_PIXELS_V1,
  type ExportProfileV1,
  exportProfileV1Schema,
  MAX_EXPORT_DURATION_SECONDS,
  MAX_EXPORT_OUTPUT_BYTES,
  parseExportProfileV1,
} from "./export-profile";

// The same fixture is deserialized by the Rust serde contract in
// engine/crates/poietra-scene-ir/tests/contracts.rs; canonical string and
// digest constants are asserted identically on both sides.
const SHARED_FIXTURE_URL = new URL("../../fixtures/engine-v1/shared-export-profile.json", import.meta.url);

const SHARED_CANONICAL_JSON =
  '{"codec":"h264-mp4","colorContractVersion":1,"frameRate":30,' +
  '"maxDurationSeconds":900,"maxOutputBytes":134217728,"resolution":"1920x1080",' +
  '"schema":"poietra.export-profile","version":1}';
const SHARED_DIGEST = "a6c8e0a9178087ae3ee29acc14a5d5e21fe596b440f1e90d61cdd91b2b87d70c";

const sharedProfile: ExportProfileV1 = {
  codec: "h264-mp4",
  colorContractVersion: 1,
  frameRate: 30,
  maxDurationSeconds: MAX_EXPORT_DURATION_SECONDS,
  maxOutputBytes: MAX_EXPORT_OUTPUT_BYTES,
  resolution: "1920x1080",
  schema: "poietra.export-profile",
  version: 1,
};

async function sharedFixture() {
  return JSON.parse(await readFile(SHARED_FIXTURE_URL, "utf8")) as unknown;
}

describe("ExportProfileV1", () => {
  it("accepts the fixture shared with the Rust serde contract", async () => {
    const profile = parseExportProfileV1(await sharedFixture());
    expect(profile).toEqual(sharedProfile);
    expect(EXPORT_RESOLUTION_PIXELS_V1[profile.resolution]).toEqual({ heightPx: 1080, widthPx: 1920 });
  });

  it("produces the canonical JSON and digest shared with the Rust contract", async () => {
    const profile = parseExportProfileV1(await sharedFixture());
    expect(canonicalExportProfileV1(profile)).toBe(SHARED_CANONICAL_JSON);
    await expect(digestExportProfileV1(profile)).resolves.toBe(SHARED_DIGEST);
  });

  it("is closed over every field", () => {
    expect(exportProfileV1Schema.safeParse(sharedProfile).success).toBe(true);
    const openDocuments: Record<string, unknown>[] = [
      { ...sharedProfile, encoderQueueDepth: 8 },
      { ...sharedProfile, codec: "av1-webm" },
      { ...sharedProfile, colorContractVersion: 2 },
      { ...sharedProfile, frameRate: 24 },
      { ...sharedProfile, frameRate: 59.94 },
      { ...sharedProfile, resolution: "640x360" },
      { ...sharedProfile, resolution: "3840x2160" },
      { ...sharedProfile, schema: "poietra.scene-ir" },
      { ...sharedProfile, version: 2 },
    ];
    for (const document of openDocuments) {
      expect(exportProfileV1Schema.safeParse(document).success).toBe(false);
    }
  });

  it("fail-closes the declared bounds at the v1 ceilings", () => {
    const bounds: Record<string, unknown>[] = [
      { ...sharedProfile, maxDurationSeconds: MAX_EXPORT_DURATION_SECONDS + 1 },
      { ...sharedProfile, maxDurationSeconds: 0 },
      { ...sharedProfile, maxDurationSeconds: 1.5 },
      { ...sharedProfile, maxOutputBytes: MAX_EXPORT_OUTPUT_BYTES + 1 },
      { ...sharedProfile, maxOutputBytes: 0 },
    ];
    for (const document of bounds) {
      expect(exportProfileV1Schema.safeParse(document).success).toBe(false);
    }
    expect(
      exportProfileV1Schema.safeParse({ ...sharedProfile, maxDurationSeconds: 1, maxOutputBytes: 1 }).success,
    ).toBe(true);
  });
});
