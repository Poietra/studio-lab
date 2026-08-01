import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CanonicalEditProgram } from "../studio/operations";
import { EditorDocumentAuthorityV1 } from "./editor-document-authority";
import type { EditorDocumentClientV1 } from "./editor-document-client";
import { type EditorEditEventViewV1, editorDocumentOpenResultViewSchemaV1 } from "./editor-document-http-contract";
import { applyEditorEditMutationV1 } from "./editor-edit-mutation";
import type { EditorLiveClientV1, EditorLiveConnectionCallbacksV1 } from "./editor-live-client";
import type { EditorLiveIdentityV1 } from "./editor-live-contract";
import { EditorRemoteHeadQueueV1 } from "./editor-remote-head-queue";

const organizationId = "organization-a";
const projectId = "project-a";
const epoch = "11111111-1111-4111-8111-111111111111";
const sourceHash = "b".repeat(64);
const sourcePath = "scene.py";
const sceneName = "Demo";
const sceneDigest = createHash("sha256").update(`${sourcePath}\0${sceneName}`, "utf8").digest("hex");
const documentKey = createHash("sha256")
  .update(`poietra.editor-document.v1\0${sourcePath}\0scene:${sceneDigest}`, "utf8")
  .digest("hex");
const authorityIdentity = { organizationId, projectId, sceneName, sourceHash, sourcePath } as const;

function program(transactionId: string): CanonicalEditProgram {
  const operationId = `${transactionId}/wait`;
  return {
    anchor: {
      capturedPlayhead: 0,
      evidence: [],
      resolvedSeconds: 0,
      source: { kind: "absolute", seconds: 0 },
    },
    intentCount: 1,
    loweringStatus: "supported",
    operations: [
      {
        dependsOn: [],
        eventKind: "wait",
        id: operationId,
        interval: { end: 1, start: 0 },
        kind: "InsertTimelineEvent",
        label: transactionId,
        provenance: { evidence: [], origin: "studio-default" },
      },
    ],
    provenance: { evidence: [], origin: "studio-default" },
    requestedExecution: "sequence",
    schedule: { edges: [], mode: "sequence", order: [operationId] },
    transactionId,
    version: 1,
  };
}

function memoryAuthorityClients() {
  let programs: readonly CanonicalEditProgram[] = [];
  const events: EditorEditEventViewV1[] = [];
  const document = () => ({
    documentKey,
    epoch,
    openedAt: "2026-08-02T00:00:00.000Z",
    projectId,
    revision: String(events.length),
    sealedAt: null,
    sourceHash,
    sourcePath,
    tenantId: organizationId,
    updatedAt: "2026-08-02T00:00:01.000Z",
  });
  const createClient = (subjectId: string): EditorDocumentClientV1 => ({
    async commit(_identity, _documentKey, request) {
      if (request.baseRevision !== String(events.length)) {
        return { currentRevision: String(events.length), kind: "conflict", reason: "revision-mismatch" };
      }
      const applied = applyEditorEditMutationV1(programs, request.mutation);
      if (applied.kind !== "applied") return { kind: "conflict", reason: "invalid-mutation" };
      const revision = events.length + 1;
      const event: EditorEditEventViewV1 = {
        baseRevision: request.baseRevision,
        byteSize: 100,
        clientMutationId: request.clientMutationId,
        committedAt: "2026-08-02T00:00:01.000Z",
        digest: "c".repeat(64),
        documentKey,
        epoch,
        mutation: request.mutation,
        projectId,
        revision: String(revision),
        subjectId,
        tenantId: organizationId,
      };
      programs = applied.programs;
      events.push(event);
      return { document: document(), event, kind: "committed", replayed: false };
    },
    async open() {
      return editorDocumentOpenResultViewSchemaV1.parse({
        created: false,
        document: document(),
        kind: "opened",
        projection: { programs, revision: String(events.length) },
      });
    },
    async tail(_identity, _documentKey, request) {
      const after = Number(request.afterRevision);
      return { document: document(), events: events.slice(after, after + Number(request.limit ?? "32")) };
    },
  });
  return { createClient };
}

function liveHub(): EditorLiveClientV1 {
  const peers = new Set<EditorLiveConnectionCallbacksV1>();
  return {
    connect(_identity: EditorLiveIdentityV1, callbacks: EditorLiveConnectionCallbacksV1) {
      peers.add(callbacks);
      return {
        close: () => peers.delete(callbacks),
        publishHead: (revision: string) => {
          for (const peer of peers) if (peer !== callbacks) peer.onHead(revision);
        },
      };
    },
  };
}

describe("Editor live two-browser vertical slice", () => {
  it("converges Browser B from PostgreSQL tail after Browser A broadcasts only a head hint", async () => {
    const store = memoryAuthorityClients();
    const authorityA = new EditorDocumentAuthorityV1(
      store.createClient("22222222-2222-4222-8222-222222222222"),
      authorityIdentity,
    );
    const authorityB = new EditorDocumentAuthorityV1(
      store.createClient("33333333-3333-4333-8333-333333333333"),
      authorityIdentity,
    );
    await Promise.all([authorityA.open(), authorityB.open()]);

    let browserBPrograms: readonly CanonicalEditProgram[] = [];
    const queueB = new EditorRemoteHeadQueueV1(
      () => true,
      async () => {
        const result = await authorityB.reconcile();
        browserBPrograms = result.snapshot.programs;
        return true;
      },
    );
    const hub = liveHub();
    const liveIdentity = { documentKey, epoch, organizationId, projectId };
    const socketA = hub.connect(liveIdentity, { onHead: vi.fn() });
    hub.connect(liveIdentity, { onHead: () => queueB.notify() });
    const sharedProgram = program("shared-edit");

    const accepted = await authorityA.commit({ kind: "append", program: sharedProgram });
    expect(accepted.kind).toBe("committed");
    // The hint is deliberately forged ahead. Browser B still installs only
    // the exact event returned by its authenticated authority tail.
    socketA.publishHead("999");

    await vi.waitFor(() => expect(browserBPrograms).toEqual([sharedProgram]));
  });
});
