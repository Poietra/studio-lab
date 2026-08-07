import { describe, expect, it } from "vitest";

import { canonicalRuntimeTraceDomainJsonV3, canonicalRuntimeTraceF64HexV3 } from "./runtime-trace-v3-digest";

describe("Runtime Trace V3 cross-runtime digest input", () => {
  it("preserves exact finite f64 bits in canonical domain JSON", () => {
    expect(canonicalRuntimeTraceF64HexV3(1)).toBe("f64:3ff0000000000000");
    expect(canonicalRuntimeTraceF64HexV3(-0)).toBe("f64:8000000000000000");
    expect(canonicalRuntimeTraceF64HexV3(5e-324)).toBe("f64:0000000000000001");
    expect(canonicalRuntimeTraceDomainJsonV3("example", { z: 1, a: -0 })).toBe(
      '{"domain":"example","value":{"a":"f64:8000000000000000","z":"f64:3ff0000000000000"}}',
    );
    expect(() => canonicalRuntimeTraceF64HexV3(Number.NaN)).toThrow("finite number");
  });
});
