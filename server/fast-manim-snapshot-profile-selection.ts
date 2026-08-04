import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import { opaqueIdV1Schema, sha256V1Schema, sourceIdentityV1Schema } from "../src/engine/primitives";
import {
  manimProjectIdSchema,
  manimSceneNameSchema,
  manimSourcePathSchema,
} from "../src/render-pipeline/manim-identity-contract";
import {
  digestFastManimSnapshotRuntimeConfigV1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V8,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V9,
  FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V10,
  FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
  type FastManimSnapshotProfileVersionV1,
  type FastManimSnapshotRuntimeConfigV1,
  fastManimSnapshotProfileVersionV1Schema,
  fastManimSnapshotRuntimeConfigV1Schema,
  fastManimSnapshotSceneIdV1,
  MAX_FAST_MANIM_PROFILE_SELECTION_DOCUMENT_BASE64_BYTES,
  MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES,
} from "./fast-manim-snapshot-contract";

export const FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_REQUEST_SCHEMA_V1 =
  "poietra.fast-manim-snapshot-profile-selection-request" as const;
export const FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_RESULT_SCHEMA_V1 =
  "poietra.fast-manim-snapshot-profile-selection-result" as const;
export const FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_POLICY_SCHEMA_V1 =
  "poietra.fast-manim-snapshot-profile-selection-policy" as const;
export const FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_POLICY_ID_V1 = "bounded-source-scene-profile-v1" as const;
export const MAX_FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_ENVELOPE_BYTES_V1 = 64 * 1024;

const selectionCorrelationShape = {
  projectId: manimProjectIdSchema,
  requestId: opaqueIdV1Schema,
  sceneId: sourceIdentityV1Schema,
  sceneName: manimSceneNameSchema,
  sourceHash: sha256V1Schema,
  sourcePath: manimSourcePathSchema,
};

export const fastManimSnapshotProfileCandidateV1Schema = z
  .object({
    runtimeConfig: fastManimSnapshotRuntimeConfigV1Schema,
    runtimeConfigHash: sha256V1Schema,
    snapshotVersion: fastManimSnapshotProfileVersionV1Schema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.runtimeConfig.snapshotVersion !== candidate.snapshotVersion) {
      context.addIssue({
        code: "custom",
        message: "A profile candidate must bind one exact snapshot version.",
        path: ["snapshotVersion"],
      });
    }
    if (digestFastManimSnapshotRuntimeConfigV1(candidate.runtimeConfig) !== candidate.runtimeConfigHash) {
      context.addIssue({
        code: "custom",
        message: "A profile candidate must bind the canonical runtime configuration digest.",
        path: ["runtimeConfigHash"],
      });
    }
  });

export type FastManimSnapshotProfileCandidateV1 = z.infer<typeof fastManimSnapshotProfileCandidateV1Schema>;

export const fastManimSnapshotProfileIdentityV1Schema = z
  .object({
    runtimeConfigHash: sha256V1Schema,
    snapshotVersion: fastManimSnapshotProfileVersionV1Schema,
  })
  .strict();

export type FastManimSnapshotProfileIdentityV1 = z.infer<typeof fastManimSnapshotProfileIdentityV1Schema>;

export const fastManimSnapshotProfileSelectionPolicyV1Schema = z
  .object({
    candidates: z
      .array(fastManimSnapshotProfileCandidateV1Schema)
      .min(1)
      .max(10)
      .refine(
        (candidates) =>
          candidates.every(
            (candidate, index) => index === 0 || candidates[index - 1]!.snapshotVersion < candidate.snapshotVersion,
          ),
        "Profile candidates must be sorted by version and unique.",
      ),
    policyId: z.literal(FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_POLICY_ID_V1),
    schema: z.literal(FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_POLICY_SCHEMA_V1),
    version: z.literal(1),
  })
  .strict();

export type FastManimSnapshotProfileSelectionPolicyV1 = z.infer<typeof fastManimSnapshotProfileSelectionPolicyV1Schema>;

export function digestFastManimSnapshotProfileSelectionPolicyV1(value: FastManimSnapshotProfileSelectionPolicyV1) {
  const policy = fastManimSnapshotProfileSelectionPolicyV1Schema.parse(value);
  return createHash("sha256")
    .update(
      canonicalJsonV1({
        ...policy,
        candidates: policy.candidates.map(({ runtimeConfigHash, snapshotVersion }) => ({
          runtimeConfigHash,
          snapshotVersion,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

export function fastManimSnapshotRuntimeConfigForProfileV1(
  snapshotVersion: FastManimSnapshotProfileVersionV1,
  frame: Readonly<{ height: number; width: number }>,
  capabilities?: readonly FastManimSnapshotRuntimeConfigV1["capabilities"][number][],
): FastManimSnapshotRuntimeConfigV1 {
  return fastManimSnapshotRuntimeConfigV1Schema.parse({
    capabilities: [
      ...(capabilities ??
        (snapshotVersion === 4
          ? (["png-image"] as const)
          : snapshotVersion === 8
            ? FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V8
            : snapshotVersion === 9
              ? FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V9
              : snapshotVersion === 10
                ? FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V10
                : FAST_MANIM_SNAPSHOT_RUNTIME_CAPABILITIES_V1)),
    ],
    frame,
    randomSeed: 0,
    schema: FAST_MANIM_SNAPSHOT_RUNTIME_CONFIG_SCHEMA_V1,
    snapshotVersion,
    version: 1,
  });
}

export function fastManimSnapshotProfileCandidateV1(
  snapshotVersion: FastManimSnapshotProfileVersionV1,
  frame: Readonly<{ height: number; width: number }>,
  capabilities?: readonly FastManimSnapshotRuntimeConfigV1["capabilities"][number][],
): FastManimSnapshotProfileCandidateV1 {
  const runtimeConfig = fastManimSnapshotRuntimeConfigForProfileV1(snapshotVersion, frame, capabilities);
  return Object.freeze({
    runtimeConfig,
    runtimeConfigHash: digestFastManimSnapshotRuntimeConfigV1(runtimeConfig),
    snapshotVersion,
  });
}

/**
 * Builds Studio's bounded runtime offer in numeric order. Ordering is only a
 * canonical wire rule: the producer owns the source/Scene selection policy
 * and must not use registration order as precedence.
 */
export function createFastManimSnapshotProfileSelectionPolicyV1(
  frame: Readonly<{ height: number; width: number }>,
  options: Readonly<{
    capabilities?: readonly FastManimSnapshotRuntimeConfigV1["capabilities"][number][];
    pngAvailable: boolean;
  }>,
): FastManimSnapshotProfileSelectionPolicyV1 {
  const candidates = ([1, 2, 3, 5, 6, 7] as const).map((snapshotVersion) =>
    fastManimSnapshotProfileCandidateV1(snapshotVersion, frame, options.capabilities),
  );
  if (options.pngAvailable) candidates.push(fastManimSnapshotProfileCandidateV1(4, frame));
  for (const snapshotVersion of [8, 9, 10] as const) {
    try {
      candidates.push(fastManimSnapshotProfileCandidateV1(snapshotVersion, frame));
    } catch {
      // V8-V10 have exact frame contracts. A server configured with another
      // frame does not advertise a runtime configuration it cannot verify.
    }
  }
  candidates.sort((left, right) => left.snapshotVersion - right.snapshotVersion);
  return fastManimSnapshotProfileSelectionPolicyV1Schema.parse({
    candidates,
    policyId: FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_POLICY_ID_V1,
    schema: FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_POLICY_SCHEMA_V1,
    version: 1,
  });
}

export const fastManimSnapshotProfileSelectionRequestV1Schema = z
  .object({
    ...selectionCorrelationShape,
    policy: fastManimSnapshotProfileSelectionPolicyV1Schema,
    policyHash: sha256V1Schema,
    schema: z.literal(FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_REQUEST_SCHEMA_V1),
    sourceText: z
      .string()
      .refine((sourceText) => Buffer.byteLength(sourceText, "utf8") <= MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES, {
        message: `Profile selection source text accepts at most ${MAX_FAST_MANIM_SNAPSHOT_SOURCE_BYTES} UTF-8 bytes.`,
      }),
    version: z.literal(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (digestFastManimSnapshotProfileSelectionPolicyV1(request.policy) !== request.policyHash) {
      context.addIssue({
        code: "custom",
        message: "The profile selection policy does not match its canonical digest.",
        path: ["policyHash"],
      });
    }
    if (createHash("sha256").update(request.sourceText, "utf8").digest("hex") !== request.sourceHash) {
      context.addIssue({
        code: "custom",
        message: "The profile selection source text does not match its source hash.",
        path: ["sourceHash"],
      });
    }
    if (fastManimSnapshotSceneIdV1(request.sourcePath, request.sceneName) !== request.sceneId) {
      context.addIssue({
        code: "custom",
        message: "The profile selection Scene ID does not match its canonical derivation.",
        path: ["sceneId"],
      });
    }
  });

export type FastManimSnapshotProfileSelectionRequestV1 = z.infer<
  typeof fastManimSnapshotProfileSelectionRequestV1Schema
>;

const selectionResultBase = {
  ...selectionCorrelationShape,
  policyHash: sha256V1Schema,
  schema: z.literal(FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_RESULT_SCHEMA_V1),
  version: z.literal(1),
};

export const fastManimSnapshotProfileSelectionResultV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      ...selectionResultBase,
      kind: z.literal("selected"),
      producerDocumentBase64: z
        .string()
        .min(4)
        .max(MAX_FAST_MANIM_PROFILE_SELECTION_DOCUMENT_BASE64_BYTES)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
      producerDocumentDigest: sha256V1Schema,
      selected: fastManimSnapshotProfileIdentityV1Schema,
      selectionDigest: sha256V1Schema,
    })
    .strict(),
  z
    .object({
      ...selectionResultBase,
      kind: z.literal("unresolved"),
      reason: z.enum(["ambiguous", "unsupported"]),
    })
    .strict(),
]);

export type FastManimSnapshotProfileSelectionResultV1 = z.infer<typeof fastManimSnapshotProfileSelectionResultV1Schema>;

function fastManimSnapshotProfileSelectionDigestV1(
  request: FastManimSnapshotProfileSelectionRequestV1,
  selected: FastManimSnapshotProfileIdentityV1,
) {
  return createHash("sha256")
    .update(
      canonicalJsonV1({
        policyHash: request.policyHash,
        runtimeConfigHash: selected.runtimeConfigHash,
        sceneId: request.sceneId,
        sceneName: request.sceneName,
        schema: FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_RESULT_SCHEMA_V1,
        snapshotVersion: selected.snapshotVersion,
        sourceHash: request.sourceHash,
        sourcePath: request.sourcePath,
        version: 1,
      }),
      "utf8",
    )
    .digest("hex");
}

function sameSelectionCorrelation(
  result: FastManimSnapshotProfileSelectionResultV1,
  request: FastManimSnapshotProfileSelectionRequestV1,
) {
  return (
    result.projectId === request.projectId &&
    result.requestId === request.requestId &&
    result.sceneId === request.sceneId &&
    result.sceneName === request.sceneName &&
    result.sourceHash === request.sourceHash &&
    result.sourcePath === request.sourcePath &&
    result.policyHash === request.policyHash
  );
}

/** Strictly verifies producer-owned selection before the embedded result is interpreted. */
export function parseFastManimSnapshotProfileSelectionResultV1(
  value: Uint8Array,
  requestValue: FastManimSnapshotProfileSelectionRequestV1,
) {
  const request = fastManimSnapshotProfileSelectionRequestV1Schema.parse(requestValue);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw new TypeError("The profile selection result is not UTF-8 JSON.", { cause });
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (cause) {
    throw new TypeError("The profile selection result is malformed JSON.", { cause });
  }
  const result = fastManimSnapshotProfileSelectionResultV1Schema.parse(parsedJson);
  const canonicalText = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (canonicalJsonV1(result) !== canonicalText) {
    throw new TypeError("The profile selection result is not canonical JSON.");
  }
  if (!sameSelectionCorrelation(result, request)) {
    throw new TypeError("The profile selection result belongs to a different request or source.");
  }
  if (result.kind === "unresolved") return result;
  const offered = request.policy.candidates.find(
    (candidate) =>
      candidate.snapshotVersion === result.selected.snapshotVersion &&
      candidate.runtimeConfigHash === result.selected.runtimeConfigHash,
  );
  if (!offered) {
    throw new TypeError("The producer selected a runtime profile Studio did not offer.");
  }
  if (result.selectionDigest !== fastManimSnapshotProfileSelectionDigestV1(request, result.selected)) {
    throw new TypeError("The selected profile identity does not match its deterministic digest.");
  }
  const producerDocumentBytes = Buffer.from(result.producerDocumentBase64, "base64");
  if (
    producerDocumentBytes.toString("base64") !== result.producerDocumentBase64 ||
    producerDocumentBytes.byteLength > MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_RESULT_JSON_BYTES - 1 ||
    createHash("sha256").update(producerDocumentBytes).digest("hex") !== result.producerDocumentDigest
  ) {
    throw new TypeError("The selected producer document bytes do not match their bounded canonical identity.");
  }
  return { ...result, producerDocumentBytes, selected: offered };
}

export function createFastManimSnapshotProfileSelectionRequestV1(
  input: Omit<FastManimSnapshotProfileSelectionRequestV1, "policyHash" | "schema" | "version">,
) {
  return fastManimSnapshotProfileSelectionRequestV1Schema.parse({
    ...input,
    policyHash: digestFastManimSnapshotProfileSelectionPolicyV1(input.policy),
    schema: FAST_MANIM_SNAPSHOT_PROFILE_SELECTION_REQUEST_SCHEMA_V1,
    version: 1,
  });
}

/** Exported for the producer conformance fixture and cross-runtime tests. */
export function createFastManimSnapshotSelectedProfileDigestV1(
  request: FastManimSnapshotProfileSelectionRequestV1,
  selected: FastManimSnapshotProfileCandidateV1,
) {
  return fastManimSnapshotProfileSelectionDigestV1(
    fastManimSnapshotProfileSelectionRequestV1Schema.parse(request),
    fastManimSnapshotProfileCandidateV1Schema.parse(selected),
  );
}
