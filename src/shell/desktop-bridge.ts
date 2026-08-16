export type DesktopProjectRegistrationResult =
  | Readonly<{ cancelled: true }>
  | Readonly<{ body: unknown; cancelled: false; status: number }>;

export type DesktopPythonSaveResult = Readonly<{ cancelled: boolean }>;

export type DesktopVideoSaveResult = Readonly<{ cancelled: boolean }>;

export type PoietraDesktopBridge = Readonly<{
  registerExistingWorkspace: (name: string) => Promise<DesktopProjectRegistrationResult>;
  savePythonSource: (fileName: string, source: string) => Promise<DesktopPythonSaveResult>;
  saveVideoFile: (fileName: string, bytes: Uint8Array) => Promise<DesktopVideoSaveResult>;
}>;

declare global {
  interface Window {
    poietraDesktop?: PoietraDesktopBridge;
  }
}

export function desktopBridge() {
  if (typeof window === "undefined") return null;
  const bridge = window.poietraDesktop;
  return bridge &&
    typeof bridge.registerExistingWorkspace === "function" &&
    typeof bridge.savePythonSource === "function" &&
    typeof bridge.saveVideoFile === "function"
    ? bridge
    : null;
}

export async function savePythonSourceWithDesktop(fileName: string, source: string) {
  const bridge = desktopBridge();
  if (!bridge) return null;
  const result = await bridge.savePythonSource(fileName, source);
  if (typeof result !== "object" || result === null || typeof result.cancelled !== "boolean") {
    throw new Error("The desktop shell returned an invalid Python export result.");
  }
  return !result.cancelled;
}

/**
 * Saves one exported MP4 through the desktop shell's native dialog (#723).
 *
 * Returns `null` when no desktop bridge is present (the browser Blob download
 * stays the fallback), `true` after a native save, and `false` when the user
 * cancelled the save dialog.
 */
export async function saveVideoFileWithDesktop(fileName: string, bytes: Uint8Array) {
  const bridge = desktopBridge();
  if (!bridge) return null;
  const result = await bridge.saveVideoFile(fileName, bytes);
  if (typeof result !== "object" || result === null || typeof result.cancelled !== "boolean") {
    throw new Error("The desktop shell returned an invalid video save result.");
  }
  return !result.cancelled;
}
