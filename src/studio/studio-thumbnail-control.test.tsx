import { createHash } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ClientThumbnailPublicationClientV1 } from "../collaboration/client-thumbnail-client";
import type {
  CapturedStudioExportPublicationV1,
  StudioExportPublicationAvailabilityV1,
} from "./studio-export-publication";
import { publishStudioThumbnailV1, StudioThumbnailControl } from "./studio-thumbnail-control";

const capture: CapturedStudioExportPublicationV1 = {
  context: {
    documentEpoch: "00000000-0000-4000-8000-000000000001",
    documentKey: "a".repeat(64),
    documentRevision: "7",
    organizationId: "organization-a",
    projectId: "project-a",
    sceneRevisionHash: "b".repeat(64),
    sourceHash: "c".repeat(64),
    sourcePath: "scene.py",
    workingRevision: "pristine",
  },
  publicationId: "00000000-0000-4000-8000-000000000002",
};

describe("StudioThumbnailControl", () => {
  it("publishes the exact generated PNG with the synchronously captured lineage", async () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    const publish = vi.fn<ClientThumbnailPublicationClientV1["publish"]>(async () => ({}) as never);
    const generate = vi.fn(async () => png);

    await publishStudioThumbnailV1({ capture, client: { publish }, generate });

    expect(generate).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      {
        metadata: {
          byteSize: png.byteLength,
          contentDigest: createHash("sha256").update(png).digest("hex"),
          documentEpoch: capture.context.documentEpoch,
          documentKey: capture.context.documentKey,
          documentRevision: capture.context.documentRevision,
          producerKind: "browser-wasm-wgpu",
          projectId: capture.context.projectId,
          publicationId: capture.publicationId,
          representativeFrameRule: "last-representable-in-duration",
          sceneContractVersion: 1,
          sceneRevisionHash: capture.context.sceneRevisionHash,
          schema: "poietra.client-thumbnail-finalize",
          version: 1,
        },
        organizationId: capture.context.organizationId,
        png,
      },
      undefined,
    );
  });

  it("does not publish a failed generation and renders unavailable lineage as disabled", async () => {
    const publish = vi.fn<ClientThumbnailPublicationClientV1["publish"]>();
    await expect(
      publishStudioThumbnailV1({
        capture,
        client: { publish },
        generate: async () => {
          throw new Error("GPU readback failed");
        },
      }),
    ).rejects.toThrow("GPU readback failed");
    expect(publish).not.toHaveBeenCalled();

    const controller = new AbortController();
    await expect(
      publishStudioThumbnailV1({
        capture,
        client: { publish },
        generate: async (signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort();
          return new Uint8Array([1]);
        },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(publish).not.toHaveBeenCalled();

    const publication: StudioExportPublicationAvailabilityV1 = {
      kind: "unavailable",
      reason: "Wait for the canonical preview before publishing.",
    };
    const markup = renderToStaticMarkup(
      <StudioThumbnailControl generate={async () => new Uint8Array()} publication={publication} />,
    );
    expect(markup).toContain('data-studio-thumbnail-state="idle"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Wait for the canonical preview before publishing.");
  });
});
