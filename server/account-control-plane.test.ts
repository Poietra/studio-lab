import { describe, expect, it, vi } from "vitest";
import { createOidcAccountControlPlaneV1 } from "./account-control-plane";
import type { AccountInvitationRepositoryV1 } from "./accounts/account-invitation-repository";
import type { AccountOrganizationRepositoryV1 } from "./accounts/account-organization-repository";
import type { AccountSessionControlRepositoryV1 } from "./accounts/account-session-repository";
import type { OidcLoginRepositoryV1 } from "./accounts/oidc-login-repository";

function repository() {
  const close = vi.fn(async () => undefined);
  const value: OidcLoginRepositoryV1 = {
    close,
    consumeLoginAttempt: vi.fn(async () => null),
    createLoginAttempt: vi.fn(async () => ({ expiresAt: new Date(Date.now() + 60_000) })),
    issueAccountSession: vi.fn(async () => null),
    issueInvitedAccountSession: vi.fn(async () => null),
    ready: vi.fn(async () => true),
  };
  return { close, value };
}

function sessionRepository() {
  const close = vi.fn(async () => undefined);
  const account = {
    activeOrganizationId: "organization-a",
    organizationSwitch: null,
    organizations: [{ displayName: "Organization A", id: "organization-a", role: "billing" as const }],
    user: { displayName: "Ada Lovelace", id: "6b0cd2da-7b88-4542-87ea-e48e73b33df3" },
    version: 4,
  };
  const mutation = {
    mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
    organizationId: "organization-a",
    version: 4,
  };
  const value: AccountSessionControlRepositoryV1 = {
    close,
    revokeAccountSession: vi.fn(async () => undefined),
    resolveAccountSession: vi.fn(async () => account),
    switchActiveOrganization: vi.fn(async () => ({ account, kind: "updated" as const, mutation })),
  };
  return { close, value };
}

function invitationRepository() {
  const close = vi.fn(async () => undefined);
  const value: AccountInvitationRepositoryV1 = {
    close,
    createInvitation: vi.fn(async () => null),
    ready: vi.fn(async () => true),
    revokeInvitation: vi.fn(async () => false),
  };
  return { close, value };
}

function organizationRepository() {
  const close = vi.fn(async () => undefined);
  const value: AccountOrganizationRepositoryV1 = {
    close,
    createOrganization: vi.fn(async (input) => ({
      kind: "applied" as const,
      mutationId: input.mutationId,
      organization: { displayName: input.displayName, id: input.organizationId, role: "owner" as const },
      replayed: false,
      version: input.expectedVersion + 1,
    })),
    ready: vi.fn(async () => true),
  };
  return { close, value };
}

describe("OIDC account control-plane composition", () => {
  it("creates and closes request-scoped storage only for accepted routes", async () => {
    const created: ReturnType<typeof repository>[] = [];
    const invitationCreated: ReturnType<typeof invitationRepository>[] = [];
    const organizationCreated: ReturnType<typeof organizationRepository>[] = [];
    const sessionCreated: ReturnType<typeof sessionRepository>[] = [];
    const controlPlane = createOidcAccountControlPlaneV1({
      invitationRepository: (environment: { hyperdrive: string }) => {
        expect(environment).toEqual({ hyperdrive: "request-scoped" });
        const next = invitationRepository();
        invitationCreated.push(next);
        return next.value;
      },
      oidc: {
        clientId: "poietra",
        clientSecret: "secret",
        issuer: "https://identity.example",
        publicOrigin: "https://studio.example",
      },
      organizationRepository: (environment: { hyperdrive: string }) => {
        expect(environment).toEqual({ hyperdrive: "request-scoped" });
        const next = organizationRepository();
        organizationCreated.push(next);
        return next.value;
      },
      repository: (environment: { hyperdrive: string }) => {
        expect(environment).toEqual({ hyperdrive: "request-scoped" });
        const next = repository();
        created.push(next);
        return next.value;
      },
      sessionRepository: (environment: { hyperdrive: string }) => {
        expect(environment).toEqual({ hyperdrive: "request-scoped" });
        const next = sessionRepository();
        sessionCreated.push(next);
        return next.value;
      },
    });

    const environment = { hyperdrive: "request-scoped" };
    await expect(controlPlane.ready(environment)).resolves.toBe(true);
    await expect(
      controlPlane.fetch(new Request("https://attacker.example/auth/oidc/start"), environment),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      controlPlane.fetch(new Request("https://studio.example/auth/oidc/start", { method: "PUT" }), environment),
    ).resolves.toMatchObject({ status: 405 });
    await expect(
      controlPlane.fetch(new Request("https://studio.example/auth/oidc/callback?state=invalid"), environment),
    ).resolves.toMatchObject({ status: 400 });
    const token = "A".repeat(43);
    await expect(
      controlPlane.fetch(
        new Request(`https://studio.example/auth/oidc/callback?state=${token}&code=authorization-code`, {
          headers: { cookie: `__Host-poietra_oidc_login=${token}` },
        }),
        environment,
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      controlPlane.fetch(
        new Request("https://studio.example/api/account/session", {
          headers: { cookie: `__Host-poietra_session=${token}` },
        }),
        environment,
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      controlPlane.fetch(
        new Request("https://studio.example/api/account/session", {
          body: JSON.stringify({
            expectedVersion: 4,
            mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
            organizationId: "organization-a",
          }),
          headers: {
            "content-type": "application/json",
            cookie: `__Host-poietra_session=${token}`,
            origin: "https://studio.example",
          },
          method: "PATCH",
        }),
        environment,
      ),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      controlPlane.fetch(
        new Request("https://studio.example/api/account/logout", {
          headers: { cookie: `__Host-poietra_session=${token}`, origin: "https://studio.example" },
          method: "POST",
        }),
        environment,
      ),
    ).resolves.toMatchObject({ status: 204 });
    await expect(
      controlPlane.fetch(
        new Request("https://studio.example/api/account/invitations", {
          body: JSON.stringify({ email: "member@example.com", role: "member" }),
          headers: {
            "content-type": "application/json",
            cookie: `__Host-poietra_session=${token}`,
            origin: "https://studio.example",
          },
          method: "POST",
        }),
        environment,
      ),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      controlPlane.fetch(
        new Request("https://studio.example/api/account/organizations", {
          body: JSON.stringify({
            displayName: "Research Team",
            expectedVersion: 4,
            mutationId: "8adbe79b-41af-4caf-bb6f-84fd13a4ca6b",
            organizationId: "research-team",
          }),
          headers: {
            "content-type": "application/json",
            cookie: `__Host-poietra_session=${token}`,
            origin: "https://studio.example",
          },
          method: "POST",
        }),
        environment,
      ),
    ).resolves.toMatchObject({ status: 201 });

    expect(created).toHaveLength(2);
    expect(invitationCreated).toHaveLength(1);
    expect(organizationCreated).toHaveLength(1);
    expect(sessionCreated).toHaveLength(3);
    expect(created[0]?.value.ready).toHaveBeenCalledOnce();
    expect(created[1]?.value.consumeLoginAttempt).toHaveBeenCalledOnce();
    expect(created.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
    expect(invitationCreated[0]?.close).toHaveBeenCalledOnce();
    expect(organizationCreated[0]?.close).toHaveBeenCalledOnce();
    expect(sessionCreated.map(({ close }) => close.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("does not initialize OIDC configuration for an existing account session", async () => {
    const session = sessionRepository();
    const oidcRepository = vi.fn(() => {
      throw new Error("OIDC storage must not be opened");
    });
    const controlPlane = createOidcAccountControlPlaneV1({
      oidc: {
        clientId: "",
        clientSecret: "",
        issuer: "not-an-issuer",
        publicOrigin: "https://studio.example",
      },
      repository: oidcRepository,
      sessionRepository: () => session.value,
    });
    const token = "A".repeat(43);

    const response = await controlPlane.fetch(
      new Request("https://studio.example/api/account/session", {
        headers: { cookie: `__Host-poietra_session=${token}` },
      }),
      { hyperdrive: "request-scoped" },
    );

    expect(response.status).toBe(200);
    expect(oidcRepository).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
    await expect(
      controlPlane.fetch(new Request("https://studio.example/auth/oidc/start"), { hyperdrive: "request-scoped" }),
    ).rejects.toThrow();
    expect(oidcRepository).not.toHaveBeenCalled();
  });
});
