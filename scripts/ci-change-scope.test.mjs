import assert from "node:assert/strict";
import test from "node:test";

import { classifyChangedPaths, selectScopes } from "./ci-change-scope.mjs";

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
  assert.equal(classifyChangedPaths(["src/studio/use-preview-renderer.ts"]).render_parity, true);
});

test("Electron adapter changes validate the selected desktop shell", () => {
  assert.deepEqual(classifyChangedPaths(["electron/app-main.ts"]), {
    ...none,
    browser: true,
    code: true,
    electron: true,
    engine_wasm: true,
    web: true,
  });
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
  assert.deepEqual(selectScopes(["README.md", "src/app.tsx"], { fullForCode: true }), expected);
});

test("manual dispatch selects every lane", () => {
  const expected = Object.fromEntries(Object.keys(none).map((name) => [name, true]));
  assert.deepEqual(selectScopes([], { forceAll: true }), expected);
});
