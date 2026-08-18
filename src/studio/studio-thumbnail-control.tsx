import { useRef, useState } from "react";

import {
  type ClientThumbnailPublicationClientV1,
  FetchClientThumbnailPublicationClientV1,
} from "../collaboration/client-thumbnail-client";
import type { ClientThumbnailFinalizeMetadataV1 } from "../collaboration/client-thumbnail-http-contract";
import type { StudioExportPublicationAvailabilityV1 } from "./studio-export-publication";

const defaultClient = new FetchClientThumbnailPublicationClientV1();

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function StudioThumbnailControl({
  client = defaultClient,
  generate,
  publication,
}: Readonly<{
  client?: ClientThumbnailPublicationClientV1;
  generate: (() => Promise<Uint8Array<ArrayBuffer>>) | null;
  publication: StudioExportPublicationAvailabilityV1;
}>) {
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<"failed" | "idle" | "published" | "publishing">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const disabled = !generate || publication.kind !== "available" || state === "publishing";

  async function publish() {
    if (disabled || !generate || publication.kind !== "available" || active.current) return;
    const context = publication.context;
    const publicationId = globalThis.crypto.randomUUID();
    const controller = new AbortController();
    active.current = controller;
    setState("publishing");
    setMessage(null);
    try {
      const png = await generate();
      controller.signal.throwIfAborted();
      const metadata: ClientThumbnailFinalizeMetadataV1 = {
        byteSize: png.byteLength,
        contentDigest: await sha256Hex(png),
        documentEpoch: context.documentEpoch,
        documentKey: context.documentKey,
        documentRevision: context.documentRevision,
        producerKind: "browser-wasm-wgpu",
        projectId: context.projectId,
        publicationId,
        representativeFrameRule: "last-representable-in-duration",
        sceneContractVersion: 1,
        sceneRevisionHash: context.sceneRevisionHash,
        schema: "poietra.client-thumbnail-finalize",
        version: 1,
      };
      await client.publish({ metadata, organizationId: context.organizationId, png }, controller.signal);
      if (active.current === controller) setState("published");
    } catch (error) {
      if (!controller.signal.aborted && active.current === controller) {
        setState("failed");
        setMessage(error instanceof Error ? error.message : "The thumbnail could not be published.");
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  const unavailable = publication.kind === "unavailable" ? publication.reason : null;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="border border-zinc-700 px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:text-zinc-600"
        disabled={disabled}
        onClick={() => void publish()}
        title={unavailable ?? undefined}
        type="button"
      >
        {state === "publishing"
          ? "Updating thumbnail…"
          : state === "published"
            ? "Thumbnail updated"
            : "Update thumbnail"}
      </button>
      {message ? <span className="max-w-48 truncate text-[10px] text-red-300">{message}</span> : null}
    </span>
  );
}
