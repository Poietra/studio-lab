import { describe, expect, it } from "vitest";

import { makePnpmInvocation, resolvePnpmJsEntry } from "../../scripts/run-engine-webgpu-benchmark.mjs";

describe("WebGPU benchmark pnpm invocation", () => {
  it("runs the pnpm JavaScript entry through Node on Windows", () => {
    const pnpmEntry = String.raw`C:\actions\pnpm\bin\pnpm.cjs`;
    const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`;

    expect(
      makePnpmInvocation(["exec", "vite", "build"], {
        environment: { npm_execpath: pnpmEntry },
        nodeExecutable,
        platform: "win32",
      }),
    ).toEqual({
      args: [pnpmEntry, "exec", "vite", "build"],
      executable: nodeExecutable,
    });
  });

  it("rejects command wrappers instead of relying on a shell", () => {
    expect(() => resolvePnpmJsEntry({ npm_execpath: String.raw`C:\actions\pnpm\pnpm.cmd` }, "win32")).toThrow(
      /standalone pnpm executable/,
    );
  });

  it("runs a standalone POSIX pnpm executable directly", () => {
    expect(
      makePnpmInvocation(["build:canvas:wasm"], {
        environment: { npm_execpath: "/opt/pnpm/pnpm" },
        platform: "linux",
      }),
    ).toEqual({ args: ["build:canvas:wasm"], executable: "/opt/pnpm/pnpm" });
  });

  it("runs the standalone Windows pnpm executable directly without a shell", () => {
    for (const name of ["pnpm.exe", "PNPM.EXE"]) {
      const pnpmEntry = `${String.raw`C:\tools\pnpm`}\\${name}`;
      expect(
        makePnpmInvocation(["exec", "vite", "build"], {
          environment: { npm_execpath: pnpmEntry },
          nodeExecutable: String.raw`C:\Program Files\nodejs\node.exe`,
          platform: "win32",
        }),
      ).toEqual({ args: ["exec", "vite", "build"], executable: pnpmEntry });
    }
  });

  it("rejects non-pnpm and relative lifecycle executables", () => {
    expect(() => resolvePnpmJsEntry({ npm_execpath: "/usr/bin/npm-cli.js" }, "linux")).toThrow(/pnpm lifecycle/);
    expect(() => resolvePnpmJsEntry({ npm_execpath: "pnpm.cjs" }, "linux")).toThrow(/absolute pnpm/);
    for (const entry of [
      String.raw`C:\tools\pnpm\pnpm.cmd`,
      String.raw`C:\tools\pnpm\pnpm.bat`,
      String.raw`C:\tools\npm\npm.exe`,
      "pnpm.exe",
    ]) {
      expect(() => makePnpmInvocation([], { environment: { npm_execpath: entry }, platform: "win32" })).toThrow();
    }
  });
});
