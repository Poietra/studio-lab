import { join, resolve } from "node:path";

export function electronPackageLayout(repositoryRoot = process.cwd()) {
  const outputRoot = resolve(repositoryRoot, "release", `electron-${process.platform}-${process.arch}`);
  if (process.platform === "darwin") {
    return {
      appRoot: join(outputRoot, "Electron.app", "Contents", "Resources", "app"),
      executable: join(outputRoot, "Electron.app", "Contents", "MacOS", "Electron"),
      outputRoot,
      resourcesRoot: join(outputRoot, "Electron.app", "Contents", "Resources"),
    };
  }
  return {
    appRoot: join(outputRoot, "resources", "app"),
    executable: join(outputRoot, process.platform === "win32" ? "electron.exe" : "electron"),
    outputRoot,
    resourcesRoot: join(outputRoot, "resources"),
  };
}
