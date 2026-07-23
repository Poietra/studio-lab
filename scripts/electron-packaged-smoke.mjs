import { _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { electronPackageLayout } from "./electron-package-layout.mjs";

const root = await mkdtemp(join(tmpdir(), "poietra-electron-packaged-smoke-"));
const workspaceRoot = join(root, "workspace");
const dataRoot = join(root, "data");
const exportPath = join(root, "packaged-smoke.py");
const shutdownMarker = join(root, "shutdown-render.json");
const packageLayout = electronPackageLayout();
const fakeRenderer = fileURLToPath(new URL("../server/test-fixtures/fake-manim.mjs", import.meta.url));
const source = `from manim import *

class GroupedEquation(Scene):
    def construct(self):
        circle = Circle()
        self.add(circle)
        self.wait(1)
        # poietra:anchor 1.000
        self.wait(1)
`;

await mkdir(workspaceRoot);
await writeFile(join(workspaceRoot, "scene.py"), source, "utf8");

let electronApplication;
let result;
let shutdownProcess = null;
let failure = null;
try {
  electronApplication = await electron.launch({
    args: ["--headless"],
    env: {
      ...process.env,
      POIETRA_MANIM_COMMAND: JSON.stringify([
        process.execPath,
        fakeRenderer,
        "--shutdown-marker",
        shutdownMarker,
        "--slow-transaction",
        "shutdown-smoke",
      ]),
      POIETRA_STUDIO_DATA_ROOT: dataRoot,
    },
    executablePath: packageLayout.executable,
    timeout: 60_000,
  });
  await electronApplication.evaluate(({ dialog }, input) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.workspaceRoot] });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.exportPath });
  }, { exportPath, workspaceRoot });
  const page = await electronApplication.firstWindow();
  result = await page.evaluate(async () => {
    const readJson = async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
      return body;
    };
    const bridge = window.poietraDesktop;
    if (!bridge) throw new Error("Packaged preload bridge is unavailable.");
    const bypass = await fetch("/api/manim/projects", {
      body: JSON.stringify({ kind: "existing", name: "Renderer bypass", root: "/tmp/renderer-controlled" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (bypass.status !== 403) {
      throw new Error(`Packaged HTTP accepted an existing-folder path with status ${bypass.status}.`);
    }
    const registration = await bridge.registerExistingWorkspace("Packaged Smoke");
    if (registration.cancelled) throw new Error("Packaged folder selection was unexpectedly cancelled.");
    if (registration.status !== 201) throw new Error(`Workspace registration failed with ${registration.status}.`);
    const project = registration.body?.project;
    if (!project?.id) throw new Error("Workspace registration did not return an opaque project ID.");

    const workspace = await readJson(await fetch(`/api/manim/projects/${project.id}/workspace`));
    const importedSource = workspace.sources[0];
    const scene = importedSource?.scenes[0];
    const entityId = Object.entries(scene?.sourceVariables ?? {})
      .find(([, variable]) => variable === "circle")?.[0];
    if (!importedSource || !scene || !entityId) {
      throw new Error("Packaged workspace import did not discover the smoke Circle.");
    }
    const operation = {
      controlOffset: { x: 0, y: 0 },
      delta: { x: 32, y: 0 },
      dependsOn: [],
      easing: "smooth",
      id: "tx:packaged-smoke/operation:motion",
      interval: { end: 1.5, start: 1 },
      kind: "CreateMotion",
      provenance: { evidence: [], origin: "direct-manipulation" },
      targetEntityIds: [entityId],
    };
    const program = {
      anchor: {
        capturedPlayhead: 1,
        evidence: [],
        resolvedSeconds: 1,
        source: { kind: "playhead", referenceSeconds: 1 },
      },
      intentCount: 1,
      loweringStatus: "supported",
      operations: [operation],
      provenance: { evidence: [], origin: "direct-manipulation" },
      requestedExecution: "sequence",
      schedule: { edges: [], mode: "sequence", order: [operation.id] },
      transactionId: "packaged-smoke",
      version: 1,
    };
    const request = {
      destination: null,
      program,
      projectId: project.id,
      sceneName: scene.name,
      sourceBindings: [{ entityId, sourceVariable: "circle" }],
      sourceHash: scene.sourceHash,
      sourcePath: importedSource.path,
      viewport: { height: 360, width: 640 },
    };

    const started = await readJson(await fetch(`/api/manim/projects/${project.id}/renders`, {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    let rendered = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      rendered = await readJson(await fetch(`/api/manim/renders/${started.id}`));
      if (["cancelled", "failed", "ready"].includes(rendered.status)) break;
      await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 20));
    }
    if (rendered?.status !== "ready") {
      throw new Error(`Packaged render failed: ${rendered?.error ?? rendered?.status}`);
    }
    const video = await fetch(`/api/manim/renders/${started.id}/video`);
    if (!video.ok || (await video.arrayBuffer()).byteLength === 0) {
      throw new Error("Packaged render returned no MP4 bytes.");
    }

    const exported = await fetch(`/api/manim/projects/${project.id}/export`, {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!exported.ok) throw new Error(`Packaged export failed with ${exported.status}.`);
    const exportedSource = await exported.text();
    if (!exportedSource.includes('poietra:transaction "packaged-smoke"')) {
      throw new Error("Packaged export did not contain the lowered transaction.");
    }
    const saved = await bridge.savePythonSource("packaged-smoke.py", exportedSource);
    if (saved.cancelled) throw new Error("Packaged Save dialog was unexpectedly cancelled.");

    const action = async (name) => readJson(await fetch(
      `/api/manim/renders/${started.id}/${name}`,
      { method: "POST" },
    ));
    if ((await action("commit")).status !== "committed") throw new Error("Packaged commit failed.");
    if ((await action("undo")).status !== "undone") throw new Error("Packaged Undo failed.");
    if ((await action("discard")).status !== "discarded") throw new Error("Packaged discard failed.");

    const renamed = await readJson(await fetch(`/api/manim/projects/${project.id}`, {
      body: JSON.stringify({ name: "Packaged Renamed" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    }));
    if (renamed.project.name !== "Packaged Renamed") throw new Error("Packaged rename failed.");
    await readJson(await fetch(`/api/manim/projects/${project.id}`, { method: "DELETE" }));
    const finalCatalog = await readJson(await fetch("/api/manim/projects"));
    if (finalCatalog.projects.length !== 0) {
      throw new Error("Packaged remove left a workspace registration behind.");
    }

    const shutdownRegistration = await bridge.registerExistingWorkspace("Shutdown Smoke");
    if (shutdownRegistration.cancelled || shutdownRegistration.status !== 201) {
      throw new Error(`Shutdown workspace registration failed with ${shutdownRegistration.status}.`);
    }
    const shutdownProject = shutdownRegistration.body?.project;
    if (!shutdownProject?.id) throw new Error("Shutdown workspace registration returned no project ID.");
    const shutdownWorkspace = await readJson(await fetch(`/api/manim/projects/${shutdownProject.id}/workspace`));
    const shutdownSource = shutdownWorkspace.sources[0];
    const shutdownScene = shutdownSource?.scenes[0];
    const shutdownEntityId = Object.entries(shutdownScene?.sourceVariables ?? {})
      .find(([, variable]) => variable === "circle")?.[0];
    if (!shutdownSource || !shutdownScene || !shutdownEntityId) {
      throw new Error("Shutdown workspace did not import the smoke Circle.");
    }
    const shutdownOperation = {
      ...operation,
      id: "tx:shutdown-smoke/operation:motion",
      targetEntityIds: [shutdownEntityId],
    };
    const shutdownProgram = {
      ...program,
      operations: [shutdownOperation],
      schedule: { edges: [], mode: "sequence", order: [shutdownOperation.id] },
      transactionId: "shutdown-smoke",
    };
    const shutdownRequest = {
      ...request,
      program: shutdownProgram,
      projectId: shutdownProject.id,
      sceneName: shutdownScene.name,
      sourceBindings: [{ entityId: shutdownEntityId, sourceVariable: "circle" }],
      sourceHash: shutdownScene.sourceHash,
      sourcePath: shutdownSource.path,
    };
    const activeRender = await readJson(await fetch(`/api/manim/projects/${shutdownProject.id}/renders`, {
      body: JSON.stringify(shutdownRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    }));
    const activeRenderStatus = await readJson(await fetch(`/api/manim/renders/${activeRender.id}`));
    if (!["preparing", "rendering"].includes(activeRenderStatus.status)) {
      throw new Error(`Shutdown render was not active: ${activeRenderStatus.status}.`);
    }

    return {
      activeRenderStatus: activeRenderStatus.status,
      exportedBytes: new TextEncoder().encode(exportedSource).byteLength,
      projectIdOpaque: !project.id.includes("/") && !project.id.includes("\\"),
      renderStatus: rendered.status,
      title: document.title,
    };
  });
  if (result.renderStatus !== "ready" || result.projectIdOpaque !== true || result.exportedBytes <= 0) {
    throw new Error(`Electron packaged smoke returned an invalid result: ${JSON.stringify(result)}`);
  }
  const exported = await readFile(exportPath, "utf8");
  if (!exported.includes('poietra:transaction "packaged-smoke"')) {
    throw new Error("Electron packaged smoke did not save the exported Python source.");
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      shutdownProcess = JSON.parse(await readFile(shutdownMarker, "utf8"));
      break;
    } catch {
      await new Promise((resolveWaiter) => setTimeout(resolveWaiter, 20));
    }
  }
  if (
    !shutdownProcess
    || !Number.isSafeInteger(shutdownProcess.pid)
    || typeof shutdownProcess.tempRoot !== "string"
  ) {
    throw new Error("The active shutdown render did not publish its process marker.");
  }
} catch (error) {
  failure = error;
}

try {
  await electronApplication?.close();
} catch (error) {
  failure ??= error;
}

if (shutdownProcess) {
  try {
    process.kill(shutdownProcess.pid, 0);
    throw new Error("Packaged shutdown left the active render process running.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
      failure ??= error;
    }
  }
  try {
    await stat(shutdownProcess.tempRoot);
    failure ??= new Error("Packaged shutdown left the active render temporary directory behind.");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      failure ??= error;
    }
  }
}

for (const cleanupRoot of [root, packageLayout.outputRoot]) {
  try {
    await rm(cleanupRoot, { force: true, recursive: true });
  } catch (error) {
    failure ??= error;
  }
}

if (failure) throw failure;
process.stdout.write(`POIETRA_ELECTRON_SMOKE_RESULT ${JSON.stringify(result)}\n`);
