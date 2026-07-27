import { describe, expect, it } from "vitest";
import { createConfiguredFastManimSandboxBackendV1 } from "./fast-manim-local-process-sandbox-backend";
import {
  copyFastManimSandboxUint8ArrayV1,
  FastManimSandboxRequestBundleV1,
  MAX_FAST_MANIM_SANDBOX_STATUS_RAW_JSON_BYTES,
  resolveFastManimSandboxReadiness,
  verifyFastManimSandboxRequestBundleV1,
} from "./fast-manim-sandbox-backend";
import {
  localSandboxReadyStatus,
  productionSandboxReadyStatus,
  sandboxProducerRequest,
} from "./test-fixtures/fast-manim-sandbox-backend-fixture";

describe("fast-manim sandbox request bundle", () => {
  it("canonicalizes bounded producer input into copy-on-read immutable bytes", () => {
    const first = new FastManimSandboxRequestBundleV1(sandboxProducerRequest());
    const second = new FastManimSandboxRequestBundleV1({ ...sandboxProducerRequest() });
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.byteLength).toBe(first.copyBytes().byteLength);
    expect(verifyFastManimSandboxRequestBundleV1(first)).toBe(true);

    const mutated = first.copyBytes();
    mutated[0] = 0;
    expect(first.copyBytes()[0]).not.toBe(0);
    expect(verifyFastManimSandboxRequestBundleV1(first)).toBe(true);
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
