import { describe, expect, it, vi } from "vitest";

import { initializePoietraMathTexOutlineBindingsV1 } from "./mathtex-outline";

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
