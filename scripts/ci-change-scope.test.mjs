import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { changedPaths, classifyChangedPaths, selectScopes } from "./ci-change-scope.mjs";

const none = {
  account_browser: false,
  browser: false,
  code: false,
  electron: false,
  engine_core: false,
  engine_wasm: false,
  render_parity: false,
  storage: false,
  tauri: false,
  tests: false,
  web: false,
};

test("documentation changes select no code lanes", () => {
  assert.deepEqual(
    classifyChangedPaths(["README.md", "docs/testing-strategy.md", "docs/assets/poietra-architecture.png"]),
    none,
  );
});

test("engine changes validate Rust and every browser consumer", () => {
  assert.deepEqual(classifyChangedPaths(["engine/crates/poietra-core/src/lib.rs"]), {
    ...none,
    browser: true,
    code: true,
    engine_core: true,
    engine_wasm: true,
    render_parity: true,
    tests: true,
    web: true,
  });
});

test("storage changes include the durable storage boundary", () => {
  assert.deepEqual(classifyChangedPaths(["server/storage/project-repository.ts"]), {
    ...none,
    browser: true,
    code: true,
    engine_wasm: true,
    storage: true,
    tests: true,
    web: true,
  });
});

test("account changes select the production-account browser lane", () => {
  assert.deepEqual(classifyChangedPaths(["src/accounts/account-client.ts"]), {
    ...none,
    account_browser: true,
    browser: true,
    code: true,
    engine_wasm: true,
    tests: true,
    web: true,
  });
  assert.equal(classifyChangedPaths(["server/account-control-plane.ts"]).account_browser, true);
  assert.equal(
    classifyChangedPaths(["server/storage/postgres/postgres-account-session-repository.ts"]).account_browser,
    true,
  );
  assert.equal(
    classifyChangedPaths(["server/storage/postgres/migrations/0034_account_organization_lifecycle.sql"])
      .account_browser,
    true,
  );
  assert.equal(classifyChangedPaths(["server/manim-production-server.ts"]).account_browser, true);
  assert.equal(classifyChangedPaths(["e2e/editor-document-postgres-fixture.ts"]).account_browser, true);
  assert.equal(classifyChangedPaths(["src/studio/editor-session-store.ts"]).account_browser, true);
});

test("render-pipeline changes select native and browser parity", () => {
  assert.deepEqual(classifyChangedPaths(["src/render-pipeline/source-lowering.ts"]), {
    ...none,
    browser: true,
    code: true,
    engine_wasm: true,
    render_parity: true,
    tests: true,
    web: true,
  });
  assert.equal(classifyChangedPaths(["server/fast-manim-snapshot-runner.ts"]).render_parity, true);
  assert.equal(classifyChangedPaths(["src/app.tsx"]).render_parity, true);
  assert.equal(classifyChangedPaths(["src/studio/operation-registry.ts"]).render_parity, true);
  assert.equal(classifyChangedPaths(["src/studio/workspace-projection.ts"]).render_parity, true);
  assert.equal(classifyChangedPaths(["src/studio/use-preview-renderer.ts"]).render_parity, true);
});

test("Electron adapter changes validate the selected desktop shell", () => {
  assert.deepEqual(classifyChangedPaths(["electron/app-main.ts"]), {
    ...none,
    browser: true,
    code: true,
    electron: true,
    engine_wasm: true,
    tests: true,
    web: true,
  });
});

test("deleted code remains visible to the lane selector", () => {
  const repository = mkdtempSync(join(tmpdir(), "poietra-ci-scope-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    mkdirSync(join(repository, "src"));
    writeFileSync(join(repository, "src", "deleted.ts"), "export const deleted = true;\n");
    execFileSync("git", ["add", "--all"], { cwd: repository });
    execFileSync(
      "git",
      ["-c", "user.name=Poietra CI", "-c", "user.email=ci@poietra.local", "commit", "--quiet", "-m", "base"],
      { cwd: repository },
    );
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    rmSync(join(repository, "src", "deleted.ts"));
    execFileSync("git", ["add", "--all"], { cwd: repository });
    execFileSync(
      "git",
      ["-c", "user.name=Poietra CI", "-c", "user.email=ci@poietra.local", "commit", "--quiet", "-m", "delete"],
      { cwd: repository },
    );
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

    const paths = changedPaths(baseSha, headSha, repository);
    assert.deepEqual(paths, ["src/deleted.ts"]);
    assert.equal(classifyChangedPaths(paths).tests, true);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("the retained Tauri experiment is checked only when it changes", () => {
  assert.deepEqual(classifyChangedPaths(["src-tauri/src/lib.rs"]), { ...none, code: true, tauri: true });
});

test("workflow and dependency changes run every lane", () => {
  const expected = Object.fromEntries(Object.keys(none).map((name) => [name, true]));
  assert.deepEqual(classifyChangedPaths([".github/workflows/ci.yml"]), expected);
  assert.deepEqual(classifyChangedPaths(["pnpm-lock.yaml"]), expected);
});

test("main pushes skip the full matrix for documentation-only changes", () => {
  assert.deepEqual(selectScopes(["README.md", "docs/assets/architecture.png"], { fullForCode: true }), none);
});

test("main pushes retain regular lanes but keep expensive specialized suites change-scoped", () => {
  const expected = Object.fromEntries(Object.keys(none).map((name) => [name, true]));
  expected.account_browser = false;
  expected.render_parity = false;
  assert.deepEqual(selectScopes(["README.md", "src/shell/desktop-bridge.ts"], { fullForCode: true }), expected);
});

test("manual dispatch selects every lane", () => {
  const expected = Object.fromEntries(Object.keys(none).map((name) => [name, true]));
  assert.deepEqual(selectScopes([], { forceAll: true }), expected);
});
