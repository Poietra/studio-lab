import { describe, expect, it, vi } from "vitest";

import type { ProductionAdmissionRequest } from "../manim-production-server";
import { createOrganizationMembershipProductionAdmissionV1 } from "./organization-membership-admission";
import type {
  ExternalAccountIdentityV1,
  OrganizationMembershipRepositoryV1,
  ResolvedOrganizationMembershipV1,
} from "./organization-membership-repository";

const organizationId = "organization-a";
const userId = "00000000-0000-4000-8000-000000000001";
const identity: ExternalAccountIdentityV1 = {
  issuer: "https://identity.example",
  subject: "external-user-42",
};

function request(overrides: Partial<ProductionAdmissionRequest> = {}): ProductionAdmissionRequest {
  return {
    credentials: { authorization: "Bearer verified-token" },
    directPeerAddress: "127.0.0.1",
    forwardedHeaders: { immediatePeerTrusted: false, present: false },
    method: "GET",
    pathname: "/api/manim/projects",
    requestedOrganizationId: organizationId,
    ...overrides,
  };
}

function membership(overrides: Partial<ResolvedOrganizationMembershipV1> = {}): ResolvedOrganizationMembershipV1 {
  return {
    organizationId,
    role: "member",
    userId,
    version: 1n,
    ...overrides,
  };
}

function fixture(options: {
  authenticatedIdentity?: unknown;
  identitiesReady?: boolean;
  membership?: ResolvedOrganizationMembershipV1 | null;
  membershipsReady?: boolean;
}) {
  const authenticate = vi.fn(async () =>
    Object.hasOwn(options, "authenticatedIdentity") ? options.authenticatedIdentity : identity,
  );
  const identitiesReady = vi.fn(async () => options.identitiesReady ?? true);
  const membershipsClose = vi.fn(async () => undefined);
  const resolveActiveMembership = vi.fn(async () =>
    Object.hasOwn(options, "membership") ? (options.membership ?? null) : membership(),
  );
  const membershipsReady = vi.fn(async () => options.membershipsReady ?? true);
  const memberships: OrganizationMembershipRepositoryV1 = {
    close: membershipsClose,
    ready: membershipsReady,
    resolveActiveMembership,
  };
  const admission = createOrganizationMembershipProductionAdmissionV1({
    identities: { authenticate, ready: identitiesReady },
    memberships,
  });
  return { admission, authenticate, identitiesReady, membershipsClose, membershipsReady, resolveActiveMembership };
}

describe("organization membership production admission", () => {
  it("maps a verified external identity to only the repository-owned internal user and organization", async () => {
    const resolved = membership({ role: "admin" });
    const { admission, resolveActiveMembership } = fixture({ membership: resolved });
    const signal = new AbortController().signal;

    await expect(admission.authenticate(request({ method: "POST" }), signal)).resolves.toEqual({
      subjectId: userId,
      tenantId: organizationId,
    });
    expect(resolveActiveMembership).toHaveBeenCalledOnce();
    expect(resolveActiveMembership).toHaveBeenCalledWith(identity, organizationId, signal);
  });

  it("uses a verified session organization when browser-native requests cannot attach the selector header", async () => {
    const { admission, resolveActiveMembership } = fixture({
      authenticatedIdentity: { ...identity, sessionOrganizationId: organizationId },
    });
    const signal = new AbortController().signal;

    await expect(
      admission.authenticate(
        request({
          credentials: { cookie: "__Host-poietra-session=verified" },
          pathname: "/api/manim/renders/render-id/video",
          requestedOrganizationId: undefined,
        }),
        signal,
      ),
    ).resolves.toEqual({ subjectId: userId, tenantId: organizationId });
    expect(resolveActiveMembership).toHaveBeenCalledWith(identity, organizationId, signal);
  });

  it("treats an explicit selector as an untrusted override of the session organization", async () => {
    const { admission, resolveActiveMembership } = fixture({
      authenticatedIdentity: { ...identity, sessionOrganizationId: organizationId },
      membership: membership({ organizationId: "organization-b" }),
    });
    const signal = new AbortController().signal;

    await expect(
      admission.authenticate(request({ requestedOrganizationId: "organization-b" }), signal),
    ).resolves.toEqual({ subjectId: userId, tenantId: "organization-b" });
    expect(resolveActiveMembership).toHaveBeenCalledWith(identity, "organization-b", signal);
  });

  it("rejects invalid external identity output before consulting memberships", async () => {
    for (const authenticatedIdentity of [
      null,
      { issuer: "http://identity.example/", subject: identity.subject },
      { issuer: identity.issuer, subject: "unsafe\nsubject" },
      { ...identity, userId },
      { ...identity, sessionOrganizationId: "invalid organization" },
    ]) {
      const { admission, resolveActiveMembership } = fixture({ authenticatedIdentity });
      await expect(admission.authenticate(request(), new AbortController().signal)).rejects.toMatchObject({
        message: "Authentication is required.",
        status: 401,
      });
      expect(resolveActiveMembership).not.toHaveBeenCalled();
    }
  });

  it("denies a missing selector or an organization where the user has no active membership", async () => {
    const missingSelector = fixture({});
    await expect(
      missingSelector.admission.authenticate(
        request({ requestedOrganizationId: undefined }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(missingSelector.resolveActiveMembership).not.toHaveBeenCalled();

    const foreignOrganization = fixture({ membership: null });
    await expect(
      foreignOrganization.admission.authenticate(
        request({ requestedOrganizationId: "organization-b" }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ message: "Organization access is not available.", status: 403 });
    expect(foreignOrganization.resolveActiveMembership).toHaveBeenCalledWith(
      identity,
      "organization-b",
      expect.any(AbortSignal),
    );
  });

  it("does not grant the billing-only role access to read or mutate Manim resources", async () => {
    for (const method of ["GET", "HEAD", "POST"]) {
      const { admission } = fixture({ membership: membership({ role: "billing" }) });
      await expect(admission.authenticate(request({ method }), new AbortController().signal)).rejects.toMatchObject({
        status: 403,
      });
    }
  });

  it("fails closed when the repository returns malformed data or becomes unavailable", async () => {
    for (const malformed of [
      { ...membership(), organizationId: "organization-b" },
      { ...membership(), userId: "external-user-42" },
      { ...membership(), role: "future-role" },
      { ...membership(), version: 0n },
    ]) {
      const { admission } = fixture({ membership: malformed as ResolvedOrganizationMembershipV1 });
      await expect(admission.authenticate(request(), new AbortController().signal)).rejects.toMatchObject({
        message: "Organization access is temporarily unavailable.",
        status: 503,
      });
    }

    const unavailable = fixture({});
    unavailable.resolveActiveMembership.mockRejectedValueOnce(new Error("private database detail"));
    await expect(unavailable.admission.authenticate(request(), new AbortController().signal)).rejects.toMatchObject({
      message: "Organization access is temporarily unavailable.",
      status: 503,
    });

    const identityProviderUnavailable = fixture({});
    identityProviderUnavailable.authenticate.mockRejectedValueOnce(new Error("private identity provider detail"));
    await expect(
      identityProviderUnavailable.admission.authenticate(request(), new AbortController().signal),
    ).rejects.toMatchObject({ message: "Organization access is temporarily unavailable.", status: 503 });
    expect(identityProviderUnavailable.resolveActiveMembership).not.toHaveBeenCalled();
  });

  it("combines dependency readiness and propagates cancellation without calling adapters", async () => {
    const available = fixture({});
    await expect(available.admission.ready(new AbortController().signal)).resolves.toBe(true);
    expect(available.identitiesReady).toHaveBeenCalledOnce();
    expect(available.membershipsReady).toHaveBeenCalledOnce();

    for (const readiness of [
      { identitiesReady: false, membershipsReady: true },
      { identitiesReady: true, membershipsReady: false },
    ]) {
      const unavailable = fixture(readiness);
      await expect(unavailable.admission.ready(new AbortController().signal)).resolves.toBe(false);
    }

    const cancelled = fixture({});
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    controller.abort(reason);
    await expect(cancelled.admission.authenticate(request(), controller.signal)).rejects.toBe(reason);
    await expect(cancelled.admission.ready(controller.signal)).rejects.toBe(reason);
    expect(cancelled.authenticate).not.toHaveBeenCalled();
    expect(cancelled.identitiesReady).not.toHaveBeenCalled();
    expect(cancelled.membershipsReady).not.toHaveBeenCalled();
    expect(cancelled.resolveActiveMembership).not.toHaveBeenCalled();

    await available.admission.close?.();
    await available.admission.close?.();
    expect(available.membershipsClose).toHaveBeenCalledOnce();
  });
});
