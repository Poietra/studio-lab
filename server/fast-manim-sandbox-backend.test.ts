import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { createConfiguredFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import {
  copyFastManimSandboxUint8ArrayV1,
  FastManimSandboxRequestBundleV1,
  MAX_FAST_MANIM_SANDBOX_LEGACY_REQUEST_BYTES,
  MAX_FAST_MANIM_SANDBOX_PLAIN_REQUEST_BYTES,
  MAX_FAST_MANIM_SANDBOX_STATUS_RAW_JSON_BYTES,
  resolveFastManimSandboxReadiness,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";
import {
  createFastManimSnapshotProfileSelectionPolicyV1,
  createFastManimSnapshotProfileSelectionRequestV1,
} from "./fast-manim-snapshot-profile-selection";
import { MAX_PROJECT_PNG_BYTES_V1 } from "./storage/project-png-storage";
import {
  localSandboxReadyStatus,
  productionSandboxReadyStatus,
  sandboxProducerRequest,
  sandboxProducerRequestV9,
} from "./test-fixtures/fast-manim-sandbox-backend-fixture";
import { runtimeTraceRequestFixture } from "./test-fixtures/fast-manim-runtime-trace-fixture";
import { sandboxPngBytes, sandboxPngProducerRequest } from "./test-fixtures/fast-manim-sandbox-png-fixture";

function crc32(bytes: Uint8Array) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function apngFrom(png: Uint8Array) {
  const source = Buffer.from(png);
  const insertion = 8 + 12 + source.readUInt32BE(8);
  const data = Buffer.alloc(8);
  data.writeUInt32BE(1, 0);
  const typeAndData = Buffer.concat([Buffer.from("acTL", "ascii"), data]);
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeAndData.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typeAndData), 8 + data.byteLength);
  return Uint8Array.from(Buffer.concat([source.subarray(0, insertion), chunk, source.subarray(insertion)]));
}

describe("fast-manim sandbox request bundle", () => {
  it("canonicalizes bounded producer input into copy-on-read immutable bytes", () => {
    const producer = sandboxProducerRequest();
    const first = new FastManimSandboxRequestBundleV1(producer);
    const second = new FastManimSandboxRequestBundleV1({ ...sandboxProducerRequest() });
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.byteLength).toBe(first.copyBytes().byteLength);
    expect(first.version).toBe(1);
    expect(first.copyPngBytes()).toBeUndefined();
    expect(Buffer.from(first.copyBytes()).toString("utf8")).toBe(canonicalJsonV1(producer));
    expect(first.byteLength).toBeLessThanOrEqual(MAX_FAST_MANIM_SANDBOX_LEGACY_REQUEST_BYTES);
    expect(verifyFastManimSandboxRequestBundleV1(first)).toBe(true);

    const mutated = first.copyBytes();
    mutated[0] = 0;
    expect(first.copyBytes()[0]).not.toBe(0);
    expect(verifyFastManimSandboxRequestBundleV1(first)).toBe(true);
  });

  it("preserves profile V9 through the immutable no-asset sandbox envelope", () => {
    const producer = sandboxProducerRequestV9();
    const bundle = new FastManimSandboxRequestBundleV1(producer);
    const rebuilt = FastManimSandboxRequestBundleV1.fromBytes(bundle.copyBytes());

    expect(bundle.version).toBe(1);
    expect(rebuilt.requestDigest).toBe(bundle.requestDigest);
    expect(JSON.parse(Buffer.from(rebuilt.copyProducerRequestBytes()).toString("utf8"))).toEqual(producer);
    expect(producer.snapshotVersion).toBe(9);
    expect(producer.runtimeConfig.snapshotVersion).toBe(9);
  });

  it("round-trips a bounded Runtime Trace request without changing snapshot envelopes", () => {
    const producer = runtimeTraceRequestFixture();
    const bundle = new FastManimSandboxRequestBundleV1(producer);
    const rebuilt = FastManimSandboxRequestBundleV1.fromBytes(bundle.copyBytes());

    expect(bundle.version).toBe(1);
    expect(bundle.copyPngBytes()).toBeUndefined();
    expect(bundle.byteLength).toBeLessThanOrEqual(MAX_FAST_MANIM_SANDBOX_PLAIN_REQUEST_BYTES);
    expect(rebuilt.requestDigest).toBe(bundle.requestDigest);
    expect(JSON.parse(Buffer.from(rebuilt.copyProducerRequestBytes()).toString("utf8"))).toEqual(producer);
    expect(() => new FastManimSandboxRequestBundleV1(producer, { pngBytes: sandboxPngBytes() })).toThrow(
      /accepted only by producer profile 4/i,
    );
  });

  it("seals one profile-4 PNG into a V2 envelope while preserving strict producer JSON", () => {
    const producer = sandboxPngProducerRequest();
    const png = sandboxPngBytes();
    const bundle = new FastManimSandboxRequestBundleV1(producer, { pngBytes: png });
    expect(bundle.version).toBe(2);
    expect(Buffer.from(bundle.copyProducerRequestBytes()).toString("utf8")).toBe(canonicalJsonV1(producer));
    expect(bundle.copyPngBytes()).toEqual(png);
    expect(verifyFastManimSandboxRequestBundleV1(bundle)).toBe(true);

    const envelope = JSON.parse(Buffer.from(bundle.copyBytes()).toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["assets", "producerRequest", "schema", "version"]);
    expect(envelope).toMatchObject({
      assets: [
        {
          byteLength: png.byteLength,
          logicalPath: "image.png",
          mediaType: "image/png",
        },
      ],
      producerRequest: producer,
      schema: "poietra.fast-manim-sandbox-request",
      version: 2,
    });
    expect(Buffer.from(bundle.copyBytes()).toString("utf8")).not.toContain(process.cwd());

    const rebuilt = FastManimSandboxRequestBundleV1.fromBytes(bundle.copyBytes());
    expect(rebuilt.requestDigest).toBe(bundle.requestDigest);
    expect(rebuilt.copyPngBytes()).toEqual(png);
    const copied = bundle.copyPngBytes();
    copied?.fill(0);
    expect(bundle.copyPngBytes()).toEqual(png);
  });

  it("seals a PNG-capable profile selection into V3 and preserves raw no-asset selection", () => {
    const concrete = sandboxProducerRequest();
    const withPng = createFastManimSnapshotProfileSelectionRequestV1({
      policy: createFastManimSnapshotProfileSelectionPolicyV1(concrete.runtimeConfig.frame, { pngAvailable: true }),
      projectId: concrete.projectId,
      requestId: concrete.requestId,
      sceneId: concrete.sceneId,
      sceneName: concrete.sceneName,
      sourceHash: concrete.sourceHash,
      sourcePath: concrete.sourcePath,
      sourceText: concrete.sourceText,
    });
    const png = sandboxPngBytes();
    const bundle = new FastManimSandboxRequestBundleV1(withPng, { pngBytes: png });

    expect(bundle.version).toBe(3);
    expect(JSON.parse(Buffer.from(bundle.copyBytes()).toString("utf8"))).toMatchObject({
      producerRequest: withPng,
      schema: "poietra.fast-manim-sandbox-request",
      version: 3,
    });
    expect(FastManimSandboxRequestBundleV1.fromBytes(bundle.copyBytes()).requestDigest).toBe(bundle.requestDigest);
    expect(() => new FastManimSandboxRequestBundleV1(withPng)).toThrow(/requires one verified image[.]png/i);

    const withoutPng = createFastManimSnapshotProfileSelectionRequestV1({
      ...withPng,
      policy: createFastManimSnapshotProfileSelectionPolicyV1(concrete.runtimeConfig.frame, { pngAvailable: false }),
    });
    const raw = new FastManimSandboxRequestBundleV1(withoutPng);
    expect(raw.version).toBe(1);
    expect(JSON.parse(Buffer.from(raw.copyProducerRequestBytes()).toString("utf8"))).toEqual(withoutPng);
    expect(() => new FastManimSandboxRequestBundleV1(withoutPng, { pngBytes: png })).toThrow(
      /only by producer profile 4/i,
    );
  });

  it("keeps the legacy request byte ceiling after the V2 transport budget grows", () => {
    const sourceText = "\0".repeat(400_000);
    const producer = {
      ...sandboxProducerRequest(),
      sourceHash: createHash("sha256").update(sourceText, "utf8").digest("hex"),
      sourceText,
    };
    expect(Buffer.byteLength(canonicalJsonV1(producer), "utf8")).toBeGreaterThan(
      MAX_FAST_MANIM_SANDBOX_LEGACY_REQUEST_BYTES,
    );
    expect(() => new FastManimSandboxRequestBundleV1(producer)).toThrow(/byte budget/i);
  });

  it("fails closed for missing, cross-profile, mismatched, oversized, and APNG attachments", () => {
    const producer = sandboxPngProducerRequest();
    const png = sandboxPngBytes();
    expect(() => new FastManimSandboxRequestBundleV1(producer)).toThrow(/requires one verified image[.]png/i);
    expect(() => new FastManimSandboxRequestBundleV1(sandboxProducerRequest(), { pngBytes: png })).toThrow(
      /only by producer profile 4/i,
    );
    expect(
      () =>
        new FastManimSandboxRequestBundleV1(producer, {
          pngBytes: new Uint8Array(MAX_PROJECT_PNG_BYTES_V1 + 1),
        }),
    ).toThrow(/byte budget/i);
    expect(() => new FastManimSandboxRequestBundleV1(producer, { pngBytes: apngFrom(png) })).toThrow(/Animated PNG/i);

    const valid = new FastManimSandboxRequestBundleV1(producer, { pngBytes: png });
    const envelope = JSON.parse(Buffer.from(valid.copyBytes()).toString("utf8")) as {
      assets: Array<{ digest: string }>;
    };
    envelope.assets[0]!.digest = "0".repeat(64);
    const mismatched = Buffer.from(canonicalJsonV1(envelope), "utf8");
    expect(() => FastManimSandboxRequestBundleV1.fromBytes(mismatched)).toThrow();
  });

  it("never revisits the encoder byte surface after the intrinsic request copy", () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(Buffer, "from");
    if (!originalDescriptor || typeof originalDescriptor.value !== "function") {
      throw new Error("Buffer.from descriptor is unavailable.");
    }
    const originalFrom = originalDescriptor.value as (...args: unknown[]) => Buffer;
    let byteLengthReads = 0;
    let encoded: Buffer | undefined;
    let iteratorCalls = 0;
    Object.defineProperty(Buffer, "from", {
      ...originalDescriptor,
      value: (...args: unknown[]) => {
        const result = Reflect.apply(originalFrom, Buffer, args) as Buffer;
        if (encoded === undefined && typeof args[0] === "string") {
          encoded = result;
          Object.defineProperty(result, "byteLength", {
            get() {
              byteLengthReads += 1;
              return Number.MAX_SAFE_INTEGER;
            },
          });
          Object.defineProperty(result, Symbol.iterator, {
            value() {
              iteratorCalls += 1;
              throw new Error("encoder iterator must not run");
            },
          });
        }
        return result;
      },
    });

    let bundle: FastManimSandboxRequestBundleV1;
    try {
      bundle = new FastManimSandboxRequestBundleV1(sandboxProducerRequest());
    } finally {
      Object.defineProperty(Buffer, "from", originalDescriptor);
    }
    expect(bundle.byteLength).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(byteLengthReads).toBe(0);
    expect(iteratorCalls).toBe(0);
    encoded?.fill(0);
    expect(verifyFastManimSandboxRequestBundleV1(bundle)).toBe(true);
  });

  it("rejects malformed producer correlation before creating backend bytes", () => {
    expect(
      () => new FastManimSandboxRequestBundleV1({ ...sandboxProducerRequest(), sourceHash: "c".repeat(64) }),
    ).toThrow(/source text/i);
  });

  it("copies real fixed Uint8Array slots without consulting hostile surface properties", () => {
    let byteLengthReads = 0;
    let iteratorCalls = 0;
    class HostileUint8Array extends Uint8Array {
      static get [Symbol.species]() {
        throw new Error("species must not run");
      }

      override [Symbol.iterator](): ArrayIterator<number> {
        iteratorCalls += 1;
        throw new Error("iterator must not run");
      }
    }
    const source = new HostileUint8Array(3);
    source.set([1, 2, 3]);
    Object.defineProperty(source, "byteLength", {
      get() {
        byteLengthReads += 1;
        return Number.MAX_SAFE_INTEGER;
      },
    });

    const copied = copyFastManimSandboxUint8ArrayV1(source, 3);
    expect([...copied]).toEqual([1, 2, 3]);
    expect(byteLengthReads).toBe(0);
    expect(iteratorCalls).toBe(0);
    expect(() => copyFastManimSandboxUint8ArrayV1(source, 2)).toThrow(/byte budget/i);
  });

  it("fails closed for proxy, shared, resizable, and detached byte sources", () => {
    let prototypeTrapCalls = 0;
    const proxied = new Proxy(new Uint8Array([1]), {
      getPrototypeOf() {
        prototypeTrapCalls += 1;
        throw new Error("prototype trap must not run");
      },
    });
    expect(() => copyFastManimSandboxUint8ArrayV1(proxied, 1)).toThrow(/accepted fixed Uint8Array/i);
    expect(prototypeTrapCalls).toBe(0);

    const shared = new Uint8Array(new SharedArrayBuffer(1));
    expect(() => copyFastManimSandboxUint8ArrayV1(shared, 1)).toThrow(/accepted fixed Uint8Array/i);

    const ResizableArrayBuffer = ArrayBuffer as unknown as new (
      byteLength: number,
      options: { maxByteLength: number },
    ) => ArrayBuffer;
    const resizable = new ResizableArrayBuffer(1, { maxByteLength: 2 });
    expect(() => copyFastManimSandboxUint8ArrayV1(new Uint8Array(resizable), 1)).toThrow(/accepted fixed Uint8Array/i);

    const detachableBuffer = new ArrayBuffer(1);
    const detachable = new Uint8Array(detachableBuffer);
    structuredClone(detachableBuffer, { transfer: [detachableBuffer] });
    expect(() => copyFastManimSandboxUint8ArrayV1(detachable, 1)).toThrow();
  });
});

describe("fast-manim sandbox readiness", () => {
  it("accepts development-only local status outside production and rejects it in production", () => {
    expect(resolveFastManimSandboxReadiness(localSandboxReadyStatus(), "test").kind).toBe("ready");
    expect(resolveFastManimSandboxReadiness(localSandboxReadyStatus(), "production")).toEqual({
      code: "sandbox-attestation-rejected",
      kind: "failed",
    });
  });

  it("rejects expired, malformed, and capability-incomplete production attestations", () => {
    const expired = productionSandboxReadyStatus();
    if (expired.health !== "ready" || expired.attestation.trust !== "verified") throw new Error("Invalid fixture.");
    expect(
      resolveFastManimSandboxReadiness(
        { ...expired, attestation: { ...expired.attestation, expiresAt: new Date(Date.now() - 1).toISOString() } },
        "production",
      ),
    ).toMatchObject({ code: "sandbox-attestation-rejected" });
    expect(
      resolveFastManimSandboxReadiness({ ...productionSandboxReadyStatus(), capabilities: ["abort"] }, "production"),
    ).toMatchObject({ code: "sandbox-attestation-rejected" });
    expect(resolveFastManimSandboxReadiness({ health: "ready" }, "production")).toMatchObject({
      code: "sandbox-attestation-rejected",
    });
    expect(resolveFastManimSandboxReadiness(productionSandboxReadyStatus(), "production")).toMatchObject({
      code: "sandbox-attestation-rejected",
    });
    expect(
      resolveFastManimSandboxReadiness(productionSandboxReadyStatus(), "production", Date.now(), () => true).kind,
    ).toBe("ready");
  });

  it("requires canonical millisecond UTC attestations and rejects oversized timestamp fields", () => {
    const status = productionSandboxReadyStatus();
    if (status.health !== "ready" || status.attestation.trust !== "verified") throw new Error("Invalid fixture.");
    for (const issuedAt of [
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00.0000Z",
      "2026-01-01T00:00:00.000+00:00",
      `2026-01-01T00:00:00.${"0".repeat(100_000)}Z`,
    ]) {
      expect(
        resolveFastManimSandboxReadiness(
          { ...status, attestation: { ...status.attestation, issuedAt } },
          "production",
          Date.now(),
          () => true,
        ),
      ).toMatchObject({ code: "sandbox-attestation-rejected" });
    }
    expect(MAX_FAST_MANIM_SANDBOX_STATUS_RAW_JSON_BYTES).toBeGreaterThan(0);
  });

  it("rejects a local-process opt-in at production startup", () => {
    expect(() =>
      createConfiguredFastManimSandboxBackendV1({
        command: [process.execPath],
        deployment: "production",
        localProcessDevOptIn: true,
        projectRoot: process.cwd(),
      }),
    ).toThrow(/forbidden in production/i);
  });
});
