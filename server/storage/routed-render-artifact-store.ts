import { manimTenantIdSchema } from "../manim-request-principal";
import {
  isImmutableRenderArtifactReceiptV1,
  isVersionedRenderArtifactReceiptV1,
  parseRenderArtifactReceiptV1,
  type RenderArtifactIdentityV1,
  type RenderArtifactObjectPageV1,
  type RenderArtifactReceiptV1,
  type RenderArtifactStoreV1,
} from "./render-artifact-repository";

const MAX_CURSOR_BYTES_V1 = 8_192;

export type RenderArtifactWriteLaneV1 = "immutable" | "versioned";

export type RoutedRenderArtifactStoreOptionsV1 = Readonly<{
  immutable: RenderArtifactStoreV1;
  legacy?: RenderArtifactStoreV1;
  writeLane: RenderArtifactWriteLaneV1;
}>;

type CursorV1 = Readonly<{
  lane: RenderArtifactWriteLaneV1;
  providerCursor: string | null;
}>;

function tenantIdV1(value: string) {
  const parsed = manimTenantIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Render artifact router tenant ID is invalid.");
  return parsed.data;
}

function decodeCursorV1(value: string | null | undefined, tenantId: string): CursorV1 | null {
  if (value === null || value === undefined) return null;
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES_V1) {
    throw new TypeError("Routed render artifact cursor is invalid.");
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > MAX_CURSOR_BYTES_V1) throw new Error();
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== "render-artifact-router-v1" ||
      parsed[1] !== tenantId ||
      (parsed[2] !== "versioned" && parsed[2] !== "immutable") ||
      (parsed[3] !== null &&
        (typeof parsed[3] !== "string" || Buffer.byteLength(parsed[3], "utf8") > MAX_CURSOR_BYTES_V1))
    ) {
      throw new Error();
    }
    return { lane: parsed[2], providerCursor: parsed[3] };
  } catch {
    throw new TypeError("Routed render artifact cursor is invalid.");
  }
}

function encodeCursorV1(tenantId: string, lane: RenderArtifactWriteLaneV1, providerCursor: string | null) {
  if (
    providerCursor !== null &&
    (typeof providerCursor !== "string" || Buffer.byteLength(providerCursor, "utf8") > MAX_CURSOR_BYTES_V1)
  ) {
    throw new Error("A render artifact provider returned an invalid cursor.");
  }
  const encoded = Buffer.from(
    JSON.stringify(["render-artifact-router-v1", tenantId, lane, providerCursor]),
    "utf8",
  ).toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES_V1) {
    throw new Error("A render artifact provider cursor exceeds the routed cursor limit.");
  }
  return encoded;
}

function validatePageV1(page: RenderArtifactObjectPageV1, maximum: number) {
  if (!page || !Array.isArray(page.objects) || page.objects.length > maximum) {
    throw new Error("A render artifact provider returned an invalid page.");
  }
  if (page.nextCursor !== null && typeof page.nextCursor !== "string") {
    throw new Error("A render artifact provider returned an invalid cursor.");
  }
  return page;
}

/**
 * Rolling media adapter: new writes select one explicit lane while reads,
 * deletion and GC continue to route old receipts to their original provider.
 */
export class RoutedRenderArtifactStoreV1 implements RenderArtifactStoreV1 {
  readonly #immutable: RenderArtifactStoreV1;
  readonly #legacy: RenderArtifactStoreV1 | null;
  readonly #writeLane: RenderArtifactWriteLaneV1;
  #closeRequest: Promise<void> | null = null;

  constructor(options: RoutedRenderArtifactStoreOptionsV1) {
    if (!options || typeof options !== "object" || !options.immutable) {
      throw new TypeError("An immutable render artifact store is required.");
    }
    if (options.writeLane !== "immutable" && options.writeLane !== "versioned") {
      throw new TypeError("Render artifact write lane is invalid.");
    }
    if (options.writeLane === "versioned" && !options.legacy) {
      throw new TypeError("The versioned render artifact write lane requires a legacy store.");
    }
    this.#immutable = options.immutable;
    this.#legacy = options.legacy ?? null;
    this.#writeLane = options.writeLane;
  }

  #storeForReceipt(tenantId: string, receiptValue: RenderArtifactReceiptV1) {
    const receipt = parseRenderArtifactReceiptV1(tenantId, receiptValue);
    if (isImmutableRenderArtifactReceiptV1(receipt)) return { receipt, store: this.#immutable } as const;
    if (!this.#legacy) throw new Error("The legacy render artifact lane is unavailable for this receipt.");
    return { receipt, store: this.#legacy } as const;
  }

  async put(
    tenantValue: string,
    input: RenderArtifactIdentityV1 & Readonly<{ bytes: Uint8Array }>,
    signal?: AbortSignal,
  ) {
    const tenantId = tenantIdV1(tenantValue);
    const target = this.#writeLane === "immutable" ? this.#immutable : this.#legacy!;
    const receipt = parseRenderArtifactReceiptV1(tenantId, await target.put(tenantId, input, signal));
    const correctLane =
      this.#writeLane === "immutable"
        ? isImmutableRenderArtifactReceiptV1(receipt)
        : isVersionedRenderArtifactReceiptV1(receipt);
    if (!correctLane) throw new Error("The render artifact write provider returned a receipt for the wrong lane.");
    return receipt;
  }

  async head(tenantId: string, receiptValue: RenderArtifactReceiptV1, signal?: AbortSignal) {
    const { receipt, store } = this.#storeForReceipt(tenantIdV1(tenantId), receiptValue);
    await store.head(tenantId, receipt, signal);
  }

  async open(
    tenantId: string,
    receiptValue: RenderArtifactReceiptV1,
    range: Readonly<{ end: number; start: number }> | null,
    signal?: AbortSignal,
  ) {
    const routed = this.#storeForReceipt(tenantIdV1(tenantId), receiptValue);
    return routed.store.open(tenantId, routed.receipt, range, signal);
  }

  async deleteObject(tenantId: string, receiptValue: RenderArtifactReceiptV1, signal?: AbortSignal) {
    const routed = this.#storeForReceipt(tenantIdV1(tenantId), receiptValue);
    await routed.store.deleteObject(tenantId, routed.receipt, signal);
  }

  async listObjects(
    tenantValue: string,
    cutoff: Date,
    maximum: number,
    cursorValue?: string | null,
    signal?: AbortSignal,
  ) {
    const tenantId = tenantIdV1(tenantValue);
    if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) {
      throw new TypeError("Routed render artifact cutoff is invalid.");
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) {
      throw new RangeError("Routed render artifact maximum must be between 1 and 256.");
    }
    const cursor = decodeCursorV1(cursorValue, tenantId);
    const lane = cursor?.lane ?? (this.#legacy ? "versioned" : "immutable");
    if (lane === "versioned") {
      if (!this.#legacy) throw new Error("The legacy render artifact lane is unavailable for this cursor.");
      const page = validatePageV1(
        await this.#legacy.listObjects(tenantId, cutoff, maximum, cursor?.providerCursor, signal),
        maximum,
      );
      if (page.nextCursor !== null) {
        return { ...page, nextCursor: encodeCursorV1(tenantId, "versioned", page.nextCursor) };
      }
      if (page.objects.length > 0) {
        return { ...page, nextCursor: encodeCursorV1(tenantId, "immutable", null) };
      }
    }
    const page = validatePageV1(
      await this.#immutable.listObjects(
        tenantId,
        cutoff,
        maximum,
        lane === "immutable" ? cursor?.providerCursor : null,
        signal,
      ),
      maximum,
    );
    return {
      ...page,
      nextCursor: page.nextCursor === null ? null : encodeCursorV1(tenantId, "immutable", page.nextCursor),
    };
  }

  async ready(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const stores = this.#legacy ? [this.#immutable, this.#legacy] : [this.#immutable];
    const readiness = await Promise.all(stores.map((store) => store.ready(signal)));
    signal?.throwIfAborted();
    return readiness.every(Boolean);
  }

  close() {
    this.#closeRequest ??= (async () => {
      const stores = [...new Set([this.#immutable, ...(this.#legacy ? [this.#legacy] : [])])];
      const results = await Promise.allSettled(stores.map((store) => store.close()));
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length > 0) throw new AggregateError(errors, "Could not close every routed render artifact store.");
    })();
    return this.#closeRequest;
  }
}
