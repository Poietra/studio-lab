import { describe, expect, it } from "vitest";

import {
  type ClientExportFinalizeMetadataV1,
  clientExportPublicationVideoPathV1,
  decodeClientExportFinalizeBodyV1,
  encodeClientExportFinalizeBodyV1,
  MAX_CLIENT_EXPORT_FINALIZE_BODY_BYTES_V1,
  MAX_CLIENT_EXPORT_FINALIZE_METADATA_BYTES_V1,
  MAX_CLIENT_EXPORT_FINALIZE_VIDEO_BYTES_V1,
} from "./client-export-http-contract";

const VIDEO = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
const ENCODER_EVIDENCE = {
  codec: "h264-mp4",
  frameRate: 30,
  resolution: "854x480",
  schema: "poietra.browser-webcodecs-encoder-evidence",
  version: 1,
} as const;

function metadata(overrides: Partial<ClientExportFinalizeMetadataV1> = {}): ClientExportFinalizeMetadataV1 {
  return {
    byteSize: VIDEO.byteLength,
    contentDigest: "a".repeat(64),
    documentEpoch: "00000000-0000-4000-8000-000000000001",
    documentKey: "b".repeat(64),
    documentRevision: "0",
    encoderEvidence: ENCODER_EVIDENCE,
    exportProfile: { schema: "poietra.export-profile" },
    projectId: "project-1",
    publicationId: "00000000-0000-4000-8000-000000000002",
    schema: "poietra.client-export-finalize",
    sceneRevisionHash: "c".repeat(64),
    version: 1,
    ...overrides,
  };
}

describe("client export finalize envelope", () => {
  it("round-trips the exact metadata and video bytes through the versioned envelope", () => {
    const body = encodeClientExportFinalizeBodyV1(metadata(), VIDEO);
    const decoded = decodeClientExportFinalizeBodyV1(body);
    expect(decoded.metadata).toEqual(metadata());
    expect([...decoded.video]).toEqual([...VIDEO]);
  });

  it("keeps the total envelope bound aligned with the 128 MiB video and 64 KiB metadata bounds", () => {
    expect(MAX_CLIENT_EXPORT_FINALIZE_VIDEO_BYTES_V1).toBe(134_217_728);
    expect(MAX_CLIENT_EXPORT_FINALIZE_BODY_BYTES_V1).toBe(
      4 + MAX_CLIENT_EXPORT_FINALIZE_METADATA_BYTES_V1 + MAX_CLIENT_EXPORT_FINALIZE_VIDEO_BYTES_V1,
    );
  });

  it("refuses a metadata byte size that disagrees with the trailing video bytes", () => {
    expect(() => encodeClientExportFinalizeBodyV1(metadata({ byteSize: VIDEO.byteLength + 1 }), VIDEO)).toThrow(
      /byte size does not match/i,
    );
    const body = encodeClientExportFinalizeBodyV1(metadata(), VIDEO);
    expect(() => decodeClientExportFinalizeBodyV1(body.subarray(0, body.byteLength - 1))).toThrow(
      /byte size does not match/i,
    );
  });

  it("refuses truncated, oversized, and malformed metadata framing", () => {
    expect(() => decodeClientExportFinalizeBodyV1(new Uint8Array([0, 0]))).toThrow(/truncated/i);
    const oversized = new Uint8Array(8);
    new DataView(oversized.buffer).setUint32(0, MAX_CLIENT_EXPORT_FINALIZE_METADATA_BYTES_V1 + 1, false);
    expect(() => decodeClientExportFinalizeBodyV1(oversized)).toThrow(/length is out of bounds/i);
    const body = encodeClientExportFinalizeBodyV1(metadata(), VIDEO);
    const corrupted = body.slice();
    corrupted[4] = 0xff;
    expect(() => decodeClientExportFinalizeBodyV1(corrupted)).toThrow(/not valid JSON/i);
  });

  it("refuses metadata outside the strict versioned contract", () => {
    const body = encodeClientExportFinalizeBodyV1(metadata(), VIDEO);
    const decoded = decodeClientExportFinalizeBodyV1(body);
    const widened = { ...decoded.metadata, unknownField: true };
    const widenedBytes = new TextEncoder().encode(JSON.stringify(widened));
    const framed = new Uint8Array(4 + widenedBytes.byteLength + VIDEO.byteLength);
    new DataView(framed.buffer).setUint32(0, widenedBytes.byteLength, false);
    framed.set(widenedBytes, 4);
    framed.set(VIDEO, 4 + widenedBytes.byteLength);
    expect(() => decodeClientExportFinalizeBodyV1(framed)).toThrow(/versioned contract/i);
  });

  it("refuses unversioned or widened browser encoder evidence", () => {
    expect(() => encodeClientExportFinalizeBodyV1(metadata({ encoderEvidence: {} as never }), VIDEO)).toThrow();
    expect(() =>
      encodeClientExportFinalizeBodyV1(
        metadata({ encoderEvidence: { ...ENCODER_EVIDENCE, hardwareAcceleration: "prefer-software" } as never }),
        VIDEO,
      ),
    ).toThrow();
  });

  it("names the neutral video path for a publication", () => {
    expect(clientExportPublicationVideoPathV1("project-1", "00000000-0000-4000-8000-000000000002")).toBe(
      "/api/projects/project-1/exports/00000000-0000-4000-8000-000000000002/video",
    );
  });
});
