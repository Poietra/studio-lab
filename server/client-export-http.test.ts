import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1,
  type ClientExportFinalizeMetadataV1,
  encodeClientExportFinalizeBodyV1,
} from "../src/collaboration/client-export-http-contract";
import {
  type ClientExportHttpServiceV1,
  handleClientExportRequest,
  isClientExportFinalizeRequest,
  isClientExportRequest,
  isClientExportVideoRequest,
  isTenantCellStorageLaneClientExportRequest,
} from "./client-export-http";
import { authenticateManimPrincipal } from "./manim-request-principal";
import type { ClientExportPublicationV1 } from "./storage/client-export-contract";
import { clientExportObjectKeyV1 } from "./storage/client-export-contract";

const TENANT = "tenant-a";
const SUBJECT = "10000000-0000-4000-8000-000000000001";
const PROJECT = "project-a";
const PUBLICATION_ID = "20000000-0000-4000-8000-000000000002";
const OBJECT_LOCATOR_TOKEN = "30000000-0000-4000-8000-000000000003";
const ORIGIN = "https://studio.example";
const VIDEO = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 9, 9]);
const CONTENT_DIGEST = "a".repeat(64);
const ENCODER_EVIDENCE = {
  codec: "h264-mp4",
  frameRate: 30,
  resolution: "854x480",
  schema: "poietra.browser-webcodecs-encoder-evidence",
  version: 1,
} as const;
const servers: ReturnType<typeof createServer>[] = [];

function publication(): ClientExportPublicationV1 {
  return {
    artifact: {
      artifactId: "40000000-0000-4000-8000-000000000004",
      receipt: {
        byteSize: VIDEO.byteLength,
        contentDigest: CONTENT_DIGEST,
        etag: "etag-1",
        mediaType: "video/mp4",
        objectKey: clientExportObjectKeyV1(TENANT, CONTENT_DIGEST, OBJECT_LOCATOR_TOKEN),
        objectLocatorToken: OBJECT_LOCATOR_TOKEN,
      },
    },
    createdBySubjectId: SUBJECT,
    expiresAt: new Date("2026-08-20T00:00:00.000Z"),
    lineage: {
      documentEpoch: "50000000-0000-4000-8000-000000000005",
      documentKey: "b".repeat(64),
      documentRevision: 0n,
      encoderEvidence: ENCODER_EVIDENCE,
      encoderEvidenceVersion: 1,
      exportProfileHash: "c".repeat(64),
      producerKind: "browser-webcodecs",
      sceneContractVersion: 1,
      sceneRevisionHash: "d".repeat(64),
    },
    projectId: PROJECT,
    publicationId: PUBLICATION_ID,
    publishedAt: new Date("2026-08-16T00:00:00.000Z"),
    tenantId: TENANT,
  };
}

function metadata(overrides: Partial<ClientExportFinalizeMetadataV1> = {}): ClientExportFinalizeMetadataV1 {
  return {
    byteSize: VIDEO.byteLength,
    contentDigest: CONTENT_DIGEST,
    documentEpoch: "50000000-0000-4000-8000-000000000005",
    documentKey: "b".repeat(64),
    documentRevision: "0",
    encoderEvidence: ENCODER_EVIDENCE,
    exportProfile: { schema: "poietra.export-profile" },
    projectId: PROJECT,
    publicationId: PUBLICATION_ID,
    schema: "poietra.client-export-finalize",
    sceneRevisionHash: "d".repeat(64),
    version: 1,
    ...overrides,
  };
}

function asset() {
  return {
    byteSize: VIDEO.byteLength,
    close: vi.fn(async () => undefined),
    mediaType: "video/mp4" as const,
    open: vi.fn(async (range: Readonly<{ end: number; start: number }> | null) =>
      (async function* () {
        yield range === null ? VIDEO : VIDEO.subarray(range.start, range.end + 1);
      })(),
    ),
  };
}

function service(overrides: Partial<Record<"publish" | "publication" | "publicationVideo", unknown>> = {}) {
  return {
    publisher: {
      publish: vi.fn(async () =>
        "publish" in overrides ? overrides.publish : { publication: publication(), replayed: false },
      ),
    },
    reader: {
      publication: vi.fn(async () => ("publication" in overrides ? overrides.publication : publication())),
      publicationVideo: vi.fn(async () => ("publicationVideo" in overrides ? overrides.publicationVideo : asset())),
    },
    tenantId: TENANT,
  } as unknown as ClientExportHttpServiceV1 & {
    publisher: { publish: ReturnType<typeof vi.fn> };
    reader: { publication: ReturnType<typeof vi.fn>; publicationVideo: ReturnType<typeof vi.fn> };
  };
}

async function principal(subjectId = SUBJECT, tenantId = TENANT) {
  return authenticateManimPrincipal(
    { authenticate: async () => ({ subjectId, tenantId }) },
    null,
    new AbortController().signal,
  );
}

async function listen(
  serviceValue: ClientExportHttpServiceV1,
  options: Parameters<typeof handleClientExportRequest>[4] = {},
  principalValue?: Awaited<ReturnType<typeof principal>>,
) {
  const authenticated = principalValue ?? (await principal());
  const server = createServer((request, response) => {
    void handleClientExportRequest(serviceValue, authenticated, request, response, options).catch(() => {
      if (!response.writableEnded) {
        response.statusCode = 500;
        response.end('{"error":"failed"}');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function send(
  port: number,
  path: string,
  options: Readonly<{
    body?: Uint8Array;
    headers?: Record<string, string>;
    method?: string;
    signal?: AbortSignal;
  }> = {},
) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...(options.body === undefined ? {} : { body: options.body.slice().buffer }),
    headers: options.headers,
    method: options.method ?? "GET",
    signal: options.signal,
  });
  const raw = new Uint8Array(await response.arrayBuffer());
  let body: unknown = null;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    body = null;
  }
  return {
    allow: response.headers.get("allow"),
    body,
    contentType: response.headers.get("content-type"),
    raw,
    status: response.status,
  };
}

function finalizeHeaders(contentType = CLIENT_EXPORT_FINALIZE_MEDIA_TYPE_V1) {
  return { "content-type": contentType, origin: ORIGIN, "sec-fetch-site": "same-origin" };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      ),
  );
});

describe("client export route predicates", () => {
  it("classifies every client export route into the TenantCell storage lane", () => {
    expect(isClientExportRequest(`/api/projects/${PROJECT}/exports`)).toBe(true);
    expect(isClientExportRequest(`/api/projects/${PROJECT}/exports/${PUBLICATION_ID}`)).toBe(true);
    expect(isClientExportRequest(`/api/projects/${PROJECT}/exports/${PUBLICATION_ID}/video`)).toBe(true);
    expect(isClientExportRequest("/api/manim/projects")).toBe(false);
    expect(isClientExportFinalizeRequest("POST", `/api/projects/${PROJECT}/exports`)).toBe(true);
    expect(isClientExportFinalizeRequest("GET", `/api/projects/${PROJECT}/exports`)).toBe(false);
    expect(isClientExportVideoRequest("HEAD", `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}/video`)).toBe(true);
    expect(isTenantCellStorageLaneClientExportRequest("POST", `/api/projects/${PROJECT}/exports`)).toBe(true);
    expect(
      isTenantCellStorageLaneClientExportRequest("GET", `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}`),
    ).toBe(true);
    expect(
      isTenantCellStorageLaneClientExportRequest("HEAD", `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}/video`),
    ).toBe(true);
  });
});

describe("authenticated client export HTTP handler", () => {
  it("accepts a fresh finalize envelope with 201 and the publication view", async () => {
    const fake = service();
    const port = await listen(fake, { expectedMutationOrigin: ORIGIN });
    const result = await send(port, `/api/projects/${PROJECT}/exports`, {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders(),
      method: "POST",
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      byteSize: VIDEO.byteLength,
      contentDigest: CONTENT_DIGEST,
      documentRevision: "0",
      projectId: PROJECT,
      publicationId: PUBLICATION_ID,
      replayed: false,
      videoPath: `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}/video`,
    });
    expect(fake.publisher.publish).toHaveBeenCalledTimes(1);
    const input = fake.publisher.publish.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.createdBySubjectId).toBe(SUBJECT);
    expect(input.documentRevision).toBe(0n);
    expect(input.publicationId).toBe(PUBLICATION_ID);
    expect(input.tenantId).toBe(TENANT);
    expect([...(input.bytes as Uint8Array)]).toEqual([...VIDEO]);
  });

  it("returns 200 for a replayed finalize", async () => {
    const fake = service({ publish: { publication: publication(), replayed: true } });
    const port = await listen(fake, { expectedMutationOrigin: ORIGIN });
    const result = await send(port, `/api/projects/${PROJECT}/exports`, {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders(),
      method: "POST",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ replayed: true });
  });

  it("removes an aborted finalize waiter without occupying the publication queue", async () => {
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = service();
    vi.mocked(first.publisher.publish).mockImplementation(async () => {
      await firstMayFinish;
      return { publication: publication(), replayed: false };
    });
    const firstPort = await listen(first, { expectedMutationOrigin: ORIGIN });
    const firstRequest = send(firstPort, `/api/projects/${PROJECT}/exports`, {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders(),
      method: "POST",
    });
    await vi.waitFor(() => expect(first.publisher.publish).toHaveBeenCalledOnce());

    const abortedServerRequest = new AbortController();
    const abortedClientRequest = new AbortController();
    const second = service();
    const secondPort = await listen(second, {
      expectedMutationOrigin: ORIGIN,
      requestSignal: abortedServerRequest.signal,
    });
    const secondRequest = send(secondPort, `/api/projects/${PROJECT}/exports`, {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders(),
      method: "POST",
      signal: abortedClientRequest.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second.publisher.publish).not.toHaveBeenCalled();
    abortedServerRequest.abort(new Error("request cancelled"));
    abortedClientRequest.abort();
    await expect(secondRequest).rejects.toMatchObject({ name: "AbortError" });

    const third = service();
    const thirdPort = await listen(third, { expectedMutationOrigin: ORIGIN });
    const thirdRequest = send(thirdPort, `/api/projects/${PROJECT}/exports`, {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders(),
      method: "POST",
    });
    releaseFirst();

    await expect(firstRequest).resolves.toMatchObject({ status: 201 });
    await vi.waitFor(() => expect(third.publisher.publish).toHaveBeenCalledOnce(), { timeout: 1_000 });
    await expect(thirdRequest).resolves.toMatchObject({ status: 201 });
  });

  it("rejects a metadata project that does not match the path with 409", async () => {
    const fake = service();
    const port = await listen(fake, { expectedMutationOrigin: ORIGIN });
    const result = await send(port, "/api/projects/project-b/exports", {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders(),
      method: "POST",
    });
    expect(result).toMatchObject({
      body: { error: "The request project does not match the project endpoint." },
      status: 409,
    });
    expect(fake.publisher.publish).not.toHaveBeenCalled();
  });

  it("rejects a finalize without the versioned media type with 415", async () => {
    const port = await listen(service(), { expectedMutationOrigin: ORIGIN });
    const result = await send(port, `/api/projects/${PROJECT}/exports`, {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders("application/json"),
      method: "POST",
    });
    expect(result.status).toBe(415);
  });

  it("rejects a malformed envelope with 400", async () => {
    const port = await listen(service(), { expectedMutationOrigin: ORIGIN });
    const result = await send(port, `/api/projects/${PROJECT}/exports`, {
      body: new Uint8Array([0, 0]),
      headers: finalizeHeaders(),
      method: "POST",
    });
    expect(result).toMatchObject({
      body: { error: "The client export finalize envelope is truncated." },
      status: 400,
    });
  });

  it("requires an account actor for publication", async () => {
    const port = await listen(service(), { expectedMutationOrigin: ORIGIN }, await principal("machine-subject"));
    const result = await send(port, `/api/projects/${PROJECT}/exports`, {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders(),
      method: "POST",
    });
    expect(result).toMatchObject({
      body: { error: "Client export publication requires an account actor." },
      status: 403,
    });
  });

  it("refuses a principal outside the tenant-fixed service composition", async () => {
    const port = await listen(service(), {}, await principal(SUBJECT, "tenant-b"));
    const result = await send(port, `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}`);
    expect(result).toMatchObject({ body: { error: "Tenant access is not available." }, status: 403 });
  });

  it("serves the publication view", async () => {
    const fake = service();
    const port = await listen(fake);
    const result = await send(port, `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      documentKey: "b".repeat(64),
      producerKind: "browser-webcodecs",
      publicationId: PUBLICATION_ID,
      sceneContractVersion: 1,
    });
    expect(fake.reader.publication).toHaveBeenCalledWith(PROJECT, PUBLICATION_ID, undefined);
  });

  it("rejects an invalid publication identity with 400 and unknown endpoints with 404", async () => {
    const port = await listen(service());
    expect((await send(port, `/api/projects/${PROJECT}/exports/not-a-uuid`)).status).toBe(400);
    expect((await send(port, `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}/other`)).status).toBe(404);
  });

  it("answers 405 with an allow header for unsupported methods", async () => {
    const port = await listen(service());
    const collection = await send(port, `/api/projects/${PROJECT}/exports`, { method: "GET" });
    expect(collection).toMatchObject({ allow: "POST", status: 405 });
    const item = await send(port, `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}`, { method: "DELETE" });
    expect(item).toMatchObject({ allow: "GET", status: 405 });
  });

  it("streams the published video with range support and closes the read claim", async () => {
    const streamedAsset = asset();
    const fake = service({ publicationVideo: streamedAsset });
    const port = await listen(fake);
    const full = await send(port, `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}/video`);
    expect(full.status).toBe(200);
    expect(full.contentType).toBe("video/mp4");
    expect([...full.raw]).toEqual([...VIDEO]);
    expect(streamedAsset.close).toHaveBeenCalledTimes(1);

    const rangedAsset = asset();
    const ranged = service({ publicationVideo: rangedAsset });
    const rangedPort = await listen(ranged);
    const partial = await send(rangedPort, `/api/projects/${PROJECT}/exports/${PUBLICATION_ID}/video`, {
      headers: { range: "bytes=2-4" },
    });
    expect(partial.status).toBe(206);
    expect([...partial.raw]).toEqual([...VIDEO.subarray(2, 5)]);
    expect(rangedAsset.close).toHaveBeenCalledTimes(1);
  });

  it("surfaces named publisher refusals as their HTTP statuses", async () => {
    const fake = service();
    fake.publisher.publish.mockImplementationOnce(async () => {
      const { HttpError } = await import("./http/json");
      throw new HttpError("The client export publication quota is exhausted.", 429);
    });
    const port = await listen(fake, { expectedMutationOrigin: ORIGIN });
    const result = await send(port, `/api/projects/${PROJECT}/exports`, {
      body: encodeClientExportFinalizeBodyV1(metadata(), VIDEO),
      headers: finalizeHeaders(),
      method: "POST",
    });
    expect(result).toMatchObject({
      body: { error: "The client export publication quota is exhausted." },
      status: 429,
    });
  });
});
