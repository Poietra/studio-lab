import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parseVerifiedSceneIrBundleV1 } from "./contracts";
import {
  createMoveSceneEntityCompilerV1,
  createRotateSceneEntityCompilerV1,
  type MoveSceneEntityCommandV1,
  type RotateSceneEntityCommandV1,
} from "./scene-authoring";

const command: RotateSceneEntityCommandV1 = {
  angleRadians: Math.PI / 6,
  entityId: "later",
  expectedBaseRevision: "a".repeat(64),
  nextRevision: "b".repeat(64),
  pivot: { x: 1.25, y: -0.5 },
  provenance: {
    evidence: ["Studio inspector rotation"],
    id: "studio-edit:rotation-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.rotate-scene-entity",
  version: 1,
};

const moveCommand: MoveSceneEntityCommandV1 = {
  delta: { x: 2.5, y: -1.5 },
  entityId: "later",
  expectedBaseRevision: "a".repeat(64),
  nextRevision: "c".repeat(64),
  provenance: {
    evidence: ["Studio direct move"],
    id: "studio-edit:move-1",
    origin: "studio-edit-program",
  },
  schema: "poietra.move-scene-entity",
  version: 1,
};

async function fixtureBundle() {
  const fixture = JSON.parse(
    await readFile(new URL("../../fixtures/engine-v1/shared-circle-opacity.json", import.meta.url), "utf8"),
  ) as Readonly<{ assets: unknown; scene: unknown }>;
  return parseVerifiedSceneIrBundleV1({ assets: fixture.assets, scene: fixture.scene });
}

describe("Scene authoring WASM adapter", () => {
  it("forwards one profile-free command and accepts only a verified complete bundle", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createRotateSceneEntityCompilerV1(async () => ({
      rotateSceneEntityV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, command);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(command);
  });

  it("forwards the exact profile-free move command and complete base snapshot", async () => {
    const bundle = await fixtureBundle();
    const calls: unknown[] = [];
    const compile = createMoveSceneEntityCompilerV1(async () => ({
      moveSceneEntityV1: (snapshotJson, commandJson) => {
        calls.push(
          JSON.parse(new TextDecoder().decode(snapshotJson)),
          JSON.parse(new TextDecoder().decode(commandJson)),
        );
        return new TextEncoder().encode(JSON.stringify(bundle));
      },
    }));

    const result = await compile(bundle, moveCommand);
    expect(result).toEqual(calls[0]);
    expect(calls[1]).toEqual(moveCommand);
  });

  it("rejects malformed or incomplete Rust responses", async () => {
    const bundle = await fixtureBundle();
    const compileRotation = createRotateSceneEntityCompilerV1(async () => ({
      rotateSceneEntityV1: () => new TextEncoder().encode('{"scene":{}}'),
    }));
    const compileMove = createMoveSceneEntityCompilerV1(async () => ({
      moveSceneEntityV1: () => new TextEncoder().encode("not JSON"),
    }));

    await expect(compileRotation(bundle, command)).rejects.toThrow();
    await expect(compileMove(bundle, moveCommand)).rejects.toThrow();
  });
});
