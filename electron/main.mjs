import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function evaluationUrl() {
  const value = process.env.POIETRA_SHELL_EVALUATION_URL;
  if (!value || app.isPackaged) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("POIETRA_SHELL_EVALUATION_URL must use loopback HTTP.");
  }
  return url.href;
}

async function printEvaluationResult(window) {
  const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const poll = () => {
      if (window.__POIETRA_SHELL_EVALUATION__) resolve(window.__POIETRA_SHELL_EVALUATION__);
      else if (Date.now() >= deadline) reject(new Error("Shell workload timed out."));
      else setTimeout(poll, 50);
    };
    poll();
  })`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.quit();
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#09090b",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  if (app.isPackaged) {
    void window.loadFile(path.join(currentDirectory, "..", "dist", "index.html"));
    return;
  }
  const workloadUrl = evaluationUrl();
  const navigation = window.loadURL(workloadUrl ?? "http://127.0.0.1:5173");
  if (workloadUrl) {
    void navigation
      .then(() => printEvaluationResult(window))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        app.exit(1);
      });
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
