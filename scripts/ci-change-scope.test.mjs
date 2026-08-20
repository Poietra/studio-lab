import assert from "node:assert/strict";
import test from "node:test";

import { classifyChangedPaths, selectScopes } from "./ci-change-scope.mjs";

const none = {
  browser: false,
  code: false,
  electron: false,
  engine_core: false,
  engine_wasm: false,
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

test("main pushes retain the full matrix when any code changes", () => {
  const expected = Object.fromEntries(Object.keys(none).map((name) => [name, true]));
  assert.deepEqual(selectScopes(["README.md", "src/app.tsx"], { fullForCode: true }), expected);
});
