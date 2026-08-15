import { _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { electronPackageLayout } from "./electron-package-layout.mjs";

const root = await mkdtemp(join(tmpdir(), "poietra-electron-startup-smoke-"));
const dataRoot = join(root, "data");
const userDataRoot = join(root, "electron-user-data");
const packageLayout = electronPackageLayout();

let electronApplication;
let failure = null;
let result;
try {
  electronApplication = await electron.launch({
    args: ["--headless", `--user-data-dir=${userDataRoot}`],
    env: {
      ...process.env,
      POIETRA_STUDIO_DATA_ROOT: dataRoot,
    },
    executablePath: packageLayout.executable,
    timeout: 60_000,
  });
  const actualUserDataRoot = await electronApplication.evaluate(({ app }) => app.getPath("userData"));
  if (resolve(actualUserDataRoot) !== resolve(userDataRoot)) {
    throw new Error(`Electron userData was not isolated under the smoke root: ${actualUserDataRoot}`);
  }

  const page = await electronApplication.firstWindow();
  result = await page.evaluate(async () => {
    const projectsResponse = await fetch("/api/manim/projects");
    return {
      bridgeAvailable: Boolean(window.poietraDesktop),
      projectsStatus: projectsResponse.status,
      title: document.title,
    };
  });
  if (result.title !== "Poietra Studio Lab") {
    throw new Error(`Packaged renderer loaded the wrong document title: ${result.title}`);
  }
  if (!result.bridgeAvailable) throw new Error("Packaged preload bridge is unavailable.");
  if (result.projectsStatus !== 200) {
    throw new Error(`Packaged local service returned status ${result.projectsStatus}.`);
  }
} catch (error) {
  failure = error;
}

try {
  await electronApplication?.close();
} catch (error) {
  failure ??= error;
}

try {
  await rm(root, { force: true, recursive: true });
} catch (error) {
  failure ??= error;
}

if (failure) throw failure;
process.stdout.write(`POIETRA_ELECTRON_STARTUP_SMOKE_RESULT ${JSON.stringify(result)}\n`);
