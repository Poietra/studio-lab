import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, type Session, session } from "electron";

import { type ElectronShellServer, startElectronShellServer } from "../server/electron-shell-server";
import { HttpError } from "../server/http/json";
import { createConsoleJsonSink, createStructuredLogger } from "../server/logging/structured-logger";
import { parseManimCommand, parseManimProjects } from "../server/manim-render-pipeline";
import { manimProjectNameSchema } from "../src/render-pipeline/contracts";
import { parseSaveVideoFileRequestV1, saveVideoFileAtomicallyV1 } from "./save-video-file";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const preloadPath = resolve(currentDirectory, "../electron/preload.cjs");
const copiedPackageMode = currentDirectory === resolve(process.resourcesPath, "app", "dist-electron");
const packagedMode = app.isPackaged || copiedPackageMode;
const logger = createStructuredLogger({
  context: { component: "electron-shell" },
  sinks: [createConsoleJsonSink({ includeData: false, prefix: "poietra-electron" })],
});

let activeOrigin = "";
let allowQuit = false;
let mainWindow: BrowserWindow | null = null;
let rendererSession: Session | null = null;
let shellServer: ElectronShellServer | null = null;
let shutdownRequest: Promise<void> | null = null;

function developmentOrigin() {
  const value = process.env.POIETRA_ELECTRON_DEV_URL ?? "http://127.0.0.1:5173";
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("POIETRA_ELECTRON_DEV_URL must use loopback HTTP.");
  }
  return url.origin;
}

async function startShellService() {
  if (!packagedMode) return developmentOrigin();
  const configuredProjects =
    parseManimProjects(process.env.POIETRA_MANIM_PROJECTS) ??
    (process.env.POIETRA_MANIM_PROJECT_ROOT ? [{ root: process.env.POIETRA_MANIM_PROJECT_ROOT }] : []);
  shellServer = await startElectronShellServer({
    command: parseManimCommand(process.env.POIETRA_MANIM_COMMAND),
    dataRoot: resolve(process.env.POIETRA_STUDIO_DATA_ROOT ?? join(app.getPath("userData"), "studio-data")),
    distRoot: resolve(currentDirectory, "../dist"),
    frame: {
      height: process.env.POIETRA_MANIM_FRAME_HEIGHT ? Number(process.env.POIETRA_MANIM_FRAME_HEIGHT) : 8,
      width: process.env.POIETRA_MANIM_FRAME_WIDTH ? Number(process.env.POIETRA_MANIM_FRAME_WIDTH) : 14.222,
    },
    logger,
    projects: configuredProjects,
  });
  rendererSession = session.fromPartition(`poietra-studio-${randomUUID()}`);
  rendererSession.webRequest.onBeforeSendHeaders({ urls: [`${shellServer.origin}/*`] }, (details, callback) =>
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        "X-Poietra-Shell-Capability": shellServer!.capability,
      },
    }),
  );
  return shellServer.origin;
}

function trustedSender(event: Electron.IpcMainInvokeEvent) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const senderUrl = event.senderFrame?.url;
  if (!senderWindow || senderWindow.isDestroyed() || !senderUrl || new URL(senderUrl).origin !== activeOrigin) {
    throw new Error("Electron rejected a request from an untrusted renderer.");
  }
  return senderWindow;
}

function registerNativeHandlers() {
  ipcMain.handle("poietra:register-existing-workspace", async (event, input: unknown) => {
    const senderWindow = trustedSender(event);
    const parsedName = manimProjectNameSchema.safeParse(input);
    if (!parsedName.success) {
      return { body: { error: "Workspace name must contain 1 to 120 characters." }, cancelled: false, status: 400 };
    }
    const selection = await dialog.showOpenDialog(senderWindow, {
      buttonLabel: "Add workspace",
      properties: ["openDirectory"],
      title: "Choose a Manim workspace folder",
    });
    if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
    if (!shellServer) {
      return { body: { error: "The packaged workspace service is unavailable." }, cancelled: false, status: 503 };
    }
    try {
      return {
        body: shellServer.registry.createProject(parsedName.data, selection.filePaths[0]),
        cancelled: false,
        status: 201,
      };
    } catch (error) {
      if (error instanceof HttpError) {
        return { body: { error: error.message }, cancelled: false, status: error.status };
      }
      logger.error("workspace.native_registration_failed", { error });
      return { body: { error: "The selected workspace could not be registered." }, cancelled: false, status: 500 };
    }
  });

  ipcMain.handle("poietra:save-python-source", async (event, input: unknown) => {
    const senderWindow = trustedSender(event);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("Python export input is invalid.");
    }
    const { fileName, source } = input as Record<string, unknown>;
    if (
      typeof fileName !== "string" ||
      basename(fileName) !== fileName ||
      !fileName.toLowerCase().endsWith(".py") ||
      fileName.length > 200 ||
      typeof source !== "string" ||
      Buffer.byteLength(source) > 2 * 1024 * 1024
    ) {
      throw new TypeError("Python export input is invalid.");
    }
    const selection = await dialog.showSaveDialog(senderWindow, {
      defaultPath: fileName,
      filters: [{ extensions: ["py"], name: "Python source" }],
      title: "Export Manim source",
    });
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    await writeFile(selection.filePath, source, { encoding: "utf8", mode: 0o600 });
    return { cancelled: false };
  });

  ipcMain.handle("poietra:save-video-file", async (event, input: unknown) => {
    const senderWindow = trustedSender(event);
    const { bytes, fileName } = parseSaveVideoFileRequestV1(input);
    const selection = await dialog.showSaveDialog(senderWindow, {
      defaultPath: fileName,
      filters: [{ extensions: ["mp4"], name: "MP4 video" }],
      title: "Save exported video",
    });
    if (selection.canceled || !selection.filePath) return { cancelled: true };
    await saveVideoFileAtomicallyV1(selection.filePath, bytes);
    return { cancelled: false };
  });
}

function secureWindow(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const preventUntrustedNavigation = (event: { preventDefault: () => void }, targetUrl: string) => {
    try {
      if (new URL(targetUrl).origin !== activeOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  window.webContents.on("will-navigate", preventUntrustedNavigation);
  window.webContents.on("will-redirect", preventUntrustedNavigation);
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function createWindow() {
  const window = new BrowserWindow({
    backgroundColor: "#09090b",
    height: 900,
    minHeight: 640,
    minWidth: 960,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      ...(packagedMode ? { preload: preloadPath } : {}),
      sandbox: true,
      session: rendererSession ?? session.defaultSession,
      webSecurity: true,
    },
    width: 1440,
  });
  secureWindow(window);
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  void window.loadURL(activeOrigin).catch((error: unknown) => {
    logger.error("window.load_failed", { error });
    app.exit(1);
  });
  mainWindow = window;
}

function shutdown() {
  shutdownRequest ??= (async () => {
    ipcMain.removeHandler("poietra:register-existing-workspace");
    ipcMain.removeHandler("poietra:save-python-source");
    ipcMain.removeHandler("poietra:save-video-file");
    await shellServer?.close();
  })();
  return shutdownRequest;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void shutdown()
      .catch((error: unknown) => {
        logger.error("shutdown.failed", { error });
      })
      .finally(() => {
        allowQuit = true;
        app.quit();
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  void app
    .whenReady()
    .then(async () => {
      activeOrigin = await startShellService();
      if (packagedMode) registerNativeHandlers();
      createWindow();
      app.on("activate", () => {
        if (!mainWindow) createWindow();
      });
    })
    .catch((error: unknown) => {
      logger.error("startup.failed", { error });
      app.exit(1);
    });
}
