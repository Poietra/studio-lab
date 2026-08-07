import { createHash } from "node:crypto";

import type { SourceBindingV1 } from "../engine/source-runtime-identity";
import { fastManimSourceBindingIdentityPayloadV1 } from "./source-runtime-identity-preimage";

export function sourceRuntimeSceneIdentifierV1(sourcePath: string, sceneName: string) {
  return `scene:${createHash("sha256").update(`${sourcePath}\0${sceneName}`).digest("hex")}`;
}

export function fastManimSourceBindingIdentifierV1(
  sourceHash: string,
  sceneId: string,
  binding: Readonly<{ name: string; ordinal: number; span: SourceBindingV1["span"] }>,
) {
  const payload = fastManimSourceBindingIdentityPayloadV1(sourceHash, sceneId, binding);
  return `source-binding:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}
