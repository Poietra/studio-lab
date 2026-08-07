import { canonicalJsonV1 } from "../engine/fast-manim-snapshot-digest";

/** Canonical finite IEEE-754 scalar shared by V3 server and browser seals. */
export function canonicalRuntimeTraceF64HexV3(value: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Runtime Trace V3 scalar canonicalization requires a finite number.");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return `f64:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function runtimeTraceDigestValueV3(value: unknown): unknown {
  if (typeof value === "number") return canonicalRuntimeTraceF64HexV3(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(runtimeTraceDigestValueV3);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, runtimeTraceDigestValueV3(entry)]));
  }
  throw new TypeError("Runtime Trace V3 digest input must be finite plain JSON.");
}

/** Exact canonical JSON hashed by the cross-runtime V3 domain digest. */
export function canonicalRuntimeTraceDomainJsonV3(domain: string, value: unknown) {
  return canonicalJsonV1({ domain, value: runtimeTraceDigestValueV3(value) });
}
