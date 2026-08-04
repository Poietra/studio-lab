import { describe, expect, it } from "vitest";

import {
  EDITOR_COLLABORATION_AUTHORIZATION_LEASE_MS_V1,
  editorCollaborationAuthorizationLeaseV1,
} from "./editor-collaboration-authorization";

const now = 2_000_000_000_000;
const grant = {
  authorizationId: "11111111-1111-4111-8111-111111111111",
  canWrite: true,
  documentKey: "a".repeat(64),
  epoch: "22222222-2222-4222-8222-222222222222",
  membershipVersion: 3,
  organizationId: "organization-a",
  projectId: "project-a",
  sessionExpiresAtMs: now + 120_000,
  sessionVersion: 4,
  subjectId: "33333333-3333-4333-8333-333333333333",
} as const;

describe("editor collaboration authorization lease", () => {
  it("clamps a valid database grant to the fixed room authorization interval", () => {
    const { sessionExpiresAtMs: _sessionExpiresAtMs, ...leaseIdentity } = grant;
    expect(editorCollaborationAuthorizationLeaseV1(grant, now)).toEqual({
      ...leaseIdentity,
      leaseExpiresAtMs: now + EDITOR_COLLABORATION_AUTHORIZATION_LEASE_MS_V1,
    });
  });

  it("never extends beyond session expiry and rejects expired or malformed grants", () => {
    expect(editorCollaborationAuthorizationLeaseV1({ ...grant, sessionExpiresAtMs: now + 10 }, now)).toMatchObject({
      leaseExpiresAtMs: now + 10,
    });
    expect(editorCollaborationAuthorizationLeaseV1({ ...grant, sessionExpiresAtMs: now }, now)).toBeNull();
    expect(editorCollaborationAuthorizationLeaseV1({ ...grant, authorizationId: "not-a-uuid" }, now)).toBeNull();
  });
});
