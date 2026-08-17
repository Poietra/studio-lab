import { afterEach, describe, expect, it, vi } from "vitest";

import { savePythonSourceWithDesktop, saveVideoFileWithDesktop } from "./desktop-bridge";

afterEach(() => vi.unstubAllGlobals());

const MP4_BYTES = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);

describe("desktop bridge", () => {
  it("leaves browser exports on the browser path", async () => {
    vi.stubGlobal("window", {});

    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).resolves.toBeNull();
    await expect(saveVideoFileWithDesktop("scene.mp4", MP4_BYTES)).resolves.toBeNull();
  });

  it("keeps existing desktop features available when the video channel is absent", async () => {
    vi.stubGlobal("window", {
      poietraDesktop: {
        registerExistingWorkspace: vi.fn(),
        savePythonSource: vi.fn(async () => ({ cancelled: false })),
      },
    });

    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).resolves.toBe(true);
    await expect(saveVideoFileWithDesktop("scene.mp4", MP4_BYTES)).resolves.toBeNull();
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
        saveVideoFile: vi.fn(),
      },
    });

    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).resolves.toBe(true);
    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).resolves.toBe(false);
    expect(savePythonSource).toHaveBeenCalledWith("scene.py", "print('ok')\n");
  });

  it("reports native video save and cancellation without returning a filesystem path", async () => {
    const saveVideoFile = vi
      .fn()
      .mockResolvedValueOnce({ cancelled: false })
      .mockResolvedValueOnce({ cancelled: true });
    vi.stubGlobal("window", {
      poietraDesktop: {
        registerExistingWorkspace: vi.fn(),
        savePythonSource: vi.fn(),
        saveVideoFile,
      },
    });

    await expect(saveVideoFileWithDesktop("scene.mp4", MP4_BYTES)).resolves.toBe(true);
    await expect(saveVideoFileWithDesktop("scene.mp4", MP4_BYTES)).resolves.toBe(false);
    expect(saveVideoFile).toHaveBeenCalledWith("scene.mp4", MP4_BYTES);
  });

  it("rejects malformed preload results", async () => {
    vi.stubGlobal("window", {
      poietraDesktop: {
        registerExistingWorkspace: vi.fn(),
        savePythonSource: vi.fn(async () => ({ path: "/private/export.py" })),
        saveVideoFile: vi.fn(async () => ({ path: "/private/export.mp4" })),
      },
    });

    await expect(savePythonSourceWithDesktop("scene.py", "print('ok')\n")).rejects.toThrow(
      /invalid Python export result/i,
    );
    await expect(saveVideoFileWithDesktop("scene.mp4", MP4_BYTES)).rejects.toThrow(/invalid video save result/i);
  });
});
