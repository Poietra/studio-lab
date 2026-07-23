export type DesktopProjectRegistrationResult =
  | Readonly<{ cancelled: true }>
  | Readonly<{ body: unknown; cancelled: false; status: number }>;

export type DesktopPythonSaveResult = Readonly<{ cancelled: boolean }>;

export type PoietraDesktopBridge = Readonly<{
  registerExistingWorkspace: (name: string) => Promise<DesktopProjectRegistrationResult>;
  savePythonSource: (fileName: string, source: string) => Promise<DesktopPythonSaveResult>;
}>;

declare global {
  interface Window {
    poietraDesktop?: PoietraDesktopBridge;
  }
}

export function desktopBridge() {
  if (typeof window === "undefined") return null;
  const bridge = window.poietraDesktop;
  return bridge
    && typeof bridge.registerExistingWorkspace === "function"
    && typeof bridge.savePythonSource === "function"
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
