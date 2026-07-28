import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const entrypointPath = resolve("sandbox/fast-manim-oci/entrypoint.py");
const harness = String.raw`
import importlib.util
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("fast_manim_oci_entrypoint", sys.argv[1])
entrypoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entrypoint)
entrypoint.RUNTIME_ROOT = Path(sys.argv[2])
raise SystemExit(entrypoint._supervise_target([sys.executable, "-c", sys.argv[3]], dict(os.environ)))
`;

function runTarget(program: string) {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "poietra-oci-entrypoint-"));
  mkdirSync(join(runtimeRoot, "tmp"), { mode: 0o700 });
  try {
    return spawnSync("python3", ["-c", harness, entrypointPath, runtimeRoot, program], {
      encoding: "utf8",
    });
  } finally {
    rmSync(runtimeRoot, { force: true, recursive: true });
  }
}

describe("fast-manim OCI entrypoint supervisor", () => {
  it("publishes stdout only after the fixed target exits successfully", () => {
    const result = runTarget('import sys; print("result", end=""); print("diagnostic", end="", file=sys.stderr)');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("result");
    expect(result.stderr).toBe("diagnostic");
  });

  it("withholds stdout from a target that exits nonzero, including a parent-fd bypass attempt", () => {
    const result = runTarget(String.raw`
import os
import sys
print("untrusted-result", end="")
print("diagnostic", end="", file=sys.stderr)
try:
    descriptor = os.open(f"/proc/{os.getppid()}/fd/1", os.O_WRONLY)
    os.write(descriptor, b"bypass")
except OSError:
    pass
raise SystemExit(23)
`);

    expect(result.status).toBe(23);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("diagnostic");
  });
});
