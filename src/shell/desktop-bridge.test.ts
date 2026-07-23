import { afterEach, describe, expect, it, vi } from "vitest";

import { savePythonSourceWithDesktop } from "./desktop-bridge";

afterEach(() => vi.unstubAllGlobals());

describe("desktop bridge", () => {
  it("leaves browser exports on the browser path", async () => {
    vi.stubGlobal("window", {});

    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).resolves.toBeNull();
  });

  it("reports native save and cancellation without returning a filesystem path", async () => {
    const savePythonSource = vi
      .fn()
      .mockResolvedValueOnce({ cancelled: false })
      .mockResolvedValueOnce({ cancelled: true });
    vi.stubGlobal("window", {
      poietraDesktop: {
        registerExistingWorkspace: vi.fn(),
        savePythonSource,
      },
    });

    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).resolves.toBe(true);
    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).resolves.toBe(false);
    expect(savePythonSource).toHaveBeenCalledWith("scene.py", "print('ok')\n");
  });

  it("rejects malformed preload results", async () => {
    vi.stubGlobal("window", {
      poietraDesktop: {
        registerExistingWorkspace: vi.fn(),
        savePythonSource: vi.fn(async () => ({ path: "/private/export.py" })),
      },
    });

    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).rejects.toThrow(
      /invalid Python export result/i,
    );
  });
});
