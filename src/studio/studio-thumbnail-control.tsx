import { useEffect, useRef, useState } from "react";

import {
  type ClientThumbnailPublicationClientV1,
  FetchClientThumbnailPublicationClientV1,
} from "../collaboration/client-thumbnail-client";
import type { ClientThumbnailFinalizeMetadataV1 } from "../collaboration/client-thumbnail-http-contract";
import {
  type CapturedStudioExportPublicationV1,
  captureStudioExportPublicationV1,
  type StudioExportPublicationAvailabilityV1,
} from "./studio-export-publication";

const defaultClient = new FetchClientThumbnailPublicationClientV1();

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function publishStudioThumbnailV1(
  input: Readonly<{
    capture: CapturedStudioExportPublicationV1;
    client: ClientThumbnailPublicationClientV1;
    generate: (signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
    signal?: AbortSignal;
  }>,
) {
  const png = await input.generate(input.signal);
  input.signal?.throwIfAborted();
  const contentDigest = await sha256Hex(png);
  input.signal?.throwIfAborted();
  const { context } = input.capture;
  const metadata: ClientThumbnailFinalizeMetadataV1 = {
    byteSize: png.byteLength,
    contentDigest,
    documentEpoch: context.documentEpoch,
    documentKey: context.documentKey,
    documentRevision: context.documentRevision,
    producerKind: "browser-wasm-wgpu",
    projectId: context.projectId,
    publicationId: input.capture.publicationId,
    representativeFrameRule: "last-representable-in-duration",
    sceneContractVersion: 1,
    sceneRevisionHash: context.sceneRevisionHash,
    schema: "poietra.client-thumbnail-finalize",
    version: 1,
  };
  return input.client.publish({ metadata, organizationId: context.organizationId, png }, input.signal);
}

export function StudioThumbnailControl({
  client = defaultClient,
  disabled: externallyDisabled = false,
  generate,
  publication,
}: Readonly<{
  client?: ClientThumbnailPublicationClientV1;
  disabled?: boolean;
  generate: ((signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>) | null;
  publication: StudioExportPublicationAvailabilityV1;
}>) {
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<"failed" | "idle" | "published" | "publishing">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const disabled = externallyDisabled || !generate || publication.kind !== "available" || state === "publishing";
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
    },
    [],
  );

  async function publish() {
    if (disabled || !generate || publication.kind !== "available" || active.current) return;
    const capture = captureStudioExportPublicationV1(publication);
    if (!capture) return;
    const controller = new AbortController();
    active.current = controller;
    setState("publishing");
    setMessage(null);
    try {
      await publishStudioThumbnailV1({ capture, client, generate, signal: controller.signal });
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

  const unavailable = externallyDisabled
    ? "Thumbnail updates are unavailable while the Editor session changes."
    : publication.kind === "unavailable"
      ? publication.reason
      : !generate
        ? "Wait for the canonical preview before updating the thumbnail."
        : null;
  return (
    <div data-studio-thumbnail-state={state}>
      <button
        className="min-h-9 border border-zinc-700 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:text-zinc-600"
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
      {unavailable ? <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">{unavailable}</p> : null}
      {message ? (
        <p className="mt-2 text-pretty text-xs leading-5 text-red-300" role="alert">
          Thumbnail update failed: {message}
        </p>
      ) : null}
    </div>
  );
}
