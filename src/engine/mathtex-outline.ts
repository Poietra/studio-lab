import { z } from "zod";
import { coordinateV1Schema, countCubicPathSegments, cubicPathV1Schema, sha256V1Schema } from "./primitives";

export const POIETRA_MATHTEX_OUTLINE_ABI_VERSION = 1 as const;
const MAX_MATHTEX_PARTS = 16;
const MAX_MATHTEX_CONTENT_LENGTH = 2_000;
const MAX_MATHTEX_REQUEST_JSON_BYTES = 16 * 1024;
const MAX_MATHTEX_RESPONSE_JSON_BYTES = 1024 * 1024;
const MAX_MATHTEX_OUTLINE_SEGMENTS = 2_048;
const MATHTEX_NORMALIZATION_TOLERANCE = 0.000_002;

const mathTexOutlineRequestV1Schema = z
  .object({
    schema: z.literal("poietra.mathtex-outline-request"),
    texParts: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_MATHTEX_CONTENT_LENGTH)
          .refine((part) => part.trim().length > 0, "MathTex parts cannot be blank."),
      )
      .min(1)
      .max(MAX_MATHTEX_PARTS)
      .refine(
        (parts) => parts.reduce((length, part) => length + part.length, 0) <= MAX_MATHTEX_CONTENT_LENGTH,
        `MathTex content accepts at most ${MAX_MATHTEX_CONTENT_LENGTH} characters.`,
      ),
    version: z.literal(1),
  })
  .strict();

export const mathTexOutlineArtifactV1Schema = z
  .object({
    bounds: z
      .object({
        bottom: coordinateV1Schema,
        left: coordinateV1Schema,
        right: coordinateV1Schema,
        top: coordinateV1Schema,
      })
      .strict()
      .refine(({ bottom, left, right, top }) => right > left && top > bottom, "MathTex ink bounds must be positive."),
    contentDigest: sha256V1Schema,
    fillRule: z.literal("nonzero"),
    fontDigest: sha256V1Schema,
    kind: z.literal("compiled"),
    path: cubicPathV1Schema,
    toolchainDigest: sha256V1Schema,
  })
  .strict()
  .superRefine(({ bounds, path }, context) => {
    if (countCubicPathSegments(path) > MAX_MATHTEX_OUTLINE_SEGMENTS) {
      context.addIssue({ code: "custom", message: "MathTex outlines accept at most 2,048 cubic segments." });
    }
    if (path.subpaths.some(({ closed }) => !closed)) {
      context.addIssue({ code: "custom", message: "MathTex outline contours must be closed." });
    }
    if (
      Math.abs(bounds.top - bounds.bottom - 1) > MATHTEX_NORMALIZATION_TOLERANCE ||
      Math.abs(bounds.left + bounds.right) > MATHTEX_NORMALIZATION_TOLERANCE ||
      Math.abs(bounds.bottom + bounds.top) > MATHTEX_NORMALIZATION_TOLERANCE
    ) {
      context.addIssue({ code: "custom", message: "MathTex outline bounds must use canonical centered unit height." });
    }
  });

const mathTexOutlineUnsupportedV1Schema = z
  .object({
    code: z.enum([
      "conversion-failed",
      "frame-item-unsupported",
      "internal-failure",
      "invalid-request",
      "layout-failed",
      "outline-invalid",
      "outline-limit-exceeded",
      "request-too-large",
      "response-too-large",
      "syntax-unsupported",
    ]),
    kind: z.literal("unsupported"),
    message: z.string().min(1).max(512),
  })
  .strict();

export const mathTexOutlineResponseV1Schema = z
  .object({
    result: z.discriminatedUnion("kind", [mathTexOutlineArtifactV1Schema, mathTexOutlineUnsupportedV1Schema]),
    schema: z.literal("poietra.mathtex-outline-response"),
    version: z.literal(1),
  })
  .strict();

export type MathTexOutlineArtifactV1 = z.infer<typeof mathTexOutlineArtifactV1Schema>;
export type MathTexOutlineResponseV1 = z.infer<typeof mathTexOutlineResponseV1Schema>;
export type MathTexOutlineCompilerV1 = (texParts: readonly string[]) => Promise<MathTexOutlineResponseV1>;

type PoietraMathTexOutlineWasmModuleV1 = Readonly<{
  compileMathTexOutlineV1: (requestJson: Uint8Array) => Uint8Array;
  default: (input?: unknown) => Promise<unknown>;
  poietraMathTexOutlineAbiVersion: () => number;
}>;

function browserModuleUrl() {
  if (typeof document === "undefined") return null;
  return new URL("./engine-wasm/mathtex-outline/poietra_mathtex_wasm.js", document.baseURI);
}

async function nodeAssetUrl(fileName: string) {
  const currentUrl = import.meta.url;
  const serverMarker = "/dist-server/";
  const electronMarker = "/dist-electron/";
  const serverIndex = currentUrl.lastIndexOf(serverMarker);
  if (serverIndex >= 0) {
    return new URL(`engine-wasm/mathtex-outline/${fileName}`, currentUrl.slice(0, serverIndex + serverMarker.length));
  }
  const electronIndex = currentUrl.lastIndexOf(electronMarker);
  if (electronIndex >= 0) {
    return new URL(`dist/engine-wasm/mathtex-outline/${fileName}`, currentUrl.slice(0, electronIndex + 1));
  }

  const pathSpecifier = "node:path";
  const urlSpecifier = "node:url";
  const [{ resolve }, { pathToFileURL }] = await Promise.all([
    import(/* @vite-ignore */ pathSpecifier) as Promise<typeof import("node:path")>,
    import(/* @vite-ignore */ urlSpecifier) as Promise<typeof import("node:url")>,
  ]);
  return pathToFileURL(resolve(process.cwd(), "public", "engine-wasm", "mathtex-outline", fileName));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

export async function initializePoietraMathTexOutlineBindingsV1(
  candidate: unknown,
  initInput?: unknown,
): Promise<PoietraMathTexOutlineWasmModuleV1> {
  if (!isRecord(candidate) || typeof candidate.default !== "function") {
    throw new Error("The MathTex outline module has no WASM initializer.");
  }
  if (initInput === undefined) await candidate.default();
  else await candidate.default(initInput);
  if (
    typeof candidate.poietraMathTexOutlineAbiVersion !== "function" ||
    candidate.poietraMathTexOutlineAbiVersion() !== POIETRA_MATHTEX_OUTLINE_ABI_VERSION ||
    typeof candidate.compileMathTexOutlineV1 !== "function"
  ) {
    throw new Error(
      `The MathTex outline module does not implement ABI version ${POIETRA_MATHTEX_OUTLINE_ABI_VERSION}.`,
    );
  }
  return candidate as PoietraMathTexOutlineWasmModuleV1;
}

let bindingsPromise: Promise<PoietraMathTexOutlineWasmModuleV1> | null = null;

async function loadPoietraMathTexOutlineBindingsV1() {
  bindingsPromise ??= (async () => {
    const browserUrl = browserModuleUrl();
    const moduleUrl = browserUrl ?? (await nodeAssetUrl("poietra_mathtex_wasm.js"));
    const candidate: unknown = await import(/* @vite-ignore */ moduleUrl.href);
    if (browserUrl) return initializePoietraMathTexOutlineBindingsV1(candidate);
    const fsSpecifier = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsSpecifier)) as typeof import("node:fs/promises");
    const wasmBytes = await readFile(await nodeAssetUrl("poietra_mathtex_wasm_bg.wasm"));
    return initializePoietraMathTexOutlineBindingsV1(candidate, { module_or_path: wasmBytes });
  })();
  return bindingsPromise;
}

function parseBoundedResponse(responseJson: Uint8Array): MathTexOutlineResponseV1 {
  if (
    !(responseJson instanceof Uint8Array) ||
    responseJson.byteLength === 0 ||
    responseJson.byteLength > MAX_MATHTEX_RESPONSE_JSON_BYTES
  ) {
    throw new Error("The MathTex outline module returned an invalid or oversized response.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseJson));
  } catch (cause) {
    throw new Error("The MathTex outline module returned malformed UTF-8 JSON.", { cause });
  }
  const parsed = mathTexOutlineResponseV1Schema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The MathTex outline module violated the v1 response contract.", { cause: parsed.error });
  }
  return parsed.data;
}

export const compileMathTexOutlineV1: MathTexOutlineCompilerV1 = async (texParts) => {
  const request = mathTexOutlineRequestV1Schema.parse({
    schema: "poietra.mathtex-outline-request",
    texParts: [...texParts],
    version: 1,
  });
  const requestJson = new TextEncoder().encode(JSON.stringify(request));
  if (requestJson.byteLength > MAX_MATHTEX_REQUEST_JSON_BYTES) {
    throw new Error("The MathTex outline request is oversized.");
  }
  const bindings = await loadPoietraMathTexOutlineBindingsV1();
  return parseBoundedResponse(bindings.compileMathTexOutlineV1(requestJson));
};
