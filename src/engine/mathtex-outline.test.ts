import { describe, expect, it, vi } from "vitest";

import {
  canonicalTextOutlineInputV1,
  initializePoietraMathTexOutlineBindingsV1,
  POIETRA_TEXT_OUTLINE_ABI_VERSION,
} from "./mathtex-outline";

function candidate(initialize: (input?: unknown) => Promise<unknown>) {
  return {
    compileMathTexOutlineV1: () => new Uint8Array(),
    default: initialize,
    poietraMathTexOutlineAbiVersion: () => 1,
  };
}

describe("MathTex outline WASM initialization", () => {
  it("uses the generated module's browser initializer without an explicit asset", async () => {
    const initialize = vi.fn(async () => undefined);

    await initializePoietraMathTexOutlineBindingsV1(candidate(initialize));

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize).toHaveBeenCalledWith();
  });

  it("passes Node-loaded WASM bytes to the generated initializer", async () => {
    const initialize = vi.fn(async () => undefined);
    const input = { module_or_path: new Uint8Array([0, 97, 115, 109]) };

    await initializePoietraMathTexOutlineBindingsV1(candidate(initialize), input);

    expect(initialize).toHaveBeenCalledWith(input);
  });
});

describe("plain Text outline input", () => {
  it("pins the closed font-family and weight request ABI", () => {
    expect(POIETRA_TEXT_OUTLINE_ABI_VERSION).toBe(5);
  });

  it("accepts bounded Japanese multiline text and canonicalizes CRLF", () => {
    expect(canonicalTextOutlineInputV1("日本語で動画を作る\r\nこんにちは")).toBe("日本語で動画を作る\nこんにちは");
    expect(canonicalTextOutlineInputV1("supplementary: 🚀")).toBe("supplementary: 🚀");
  });

  it.each([
    "tab\tcharacter",
    ["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n"),
    "a".repeat(129),
    String.fromCharCode(0xd800),
    String.fromCharCode(0xdc00),
  ])("rejects text outside the bounded multiline contract: %s", (text) =>
    expect(canonicalTextOutlineInputV1(text)).toBeNull(),
  );
});
