import { describe, expect, it } from "vitest";

import { analyzePythonSource } from "./python-source-analysis";

describe("Python source lexical analysis", () => {
  it.each(["f", "F", "fr", "rf", "r", "b", "br", "rb", "u"])(
    "does not expose the %s string prefix as a code identifier",
    (prefix) => {
      const analysis = analyzePythonSource(`message = ${prefix}"equation"`);

      expect(analysis.valid).toBe(true);
      expect(analysis.lines[0]?.code).not.toMatch(new RegExp(`\\b${prefix}\\b`, "i"));
      expect(analysis.lines[0]?.code.trim()).toBe("message =");
    },
  );

  it("keeps the same letters when they are ordinary Python identifiers", () => {
    const analysis = analyzePythonSource("f = r + b");

    expect(analysis.lines[0]?.code).toBe("f = r + b");
  });
});
