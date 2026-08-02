import { createHash } from "node:crypto";

import { calculatePKCECodeChallenge } from "openid-client";
import { describe, expect, it, vi } from "vitest";

import type { OidcLoginRepositoryV1 } from "./oidc-login-repository";
import { createOidcLoginServiceV1, type OidcLoginErrorV1 } from "./oidc-login-service";
import type { OidcIdentityProviderV1 } from "./openid-client-provider";

const now = Date.UTC(2026, 6, 31, 12, 0, 0);

function opaque(byte: number) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function digest(byte: number) {
  return new Uint8Array(createHash("sha256").update(Buffer.alloc(32, byte)).digest());
}

function fixture(overrides: Partial<OidcLoginRepositoryV1> = {}) {
  const createLoginAttempt = vi.fn<OidcLoginRepositoryV1["createLoginAttempt"]>(async () => ({
    expiresAt: new Date(now + 10 * 60_000),
  }));
  const consumeLoginAttempt = vi.fn<OidcLoginRepositoryV1["consumeLoginAttempt"]>(async () => ({
    codeVerifier: opaque(3),
    invitationTokenDigest: null,
    nonce: opaque(2),
  }));
  const issueAccountSession = vi.fn<OidcLoginRepositoryV1["issueAccountSession"]>(async () => ({
    expiresAt: new Date(now + 7 * 24 * 60 * 60_000),
  }));
  const issueInvitedAccountSession = vi.fn<OidcLoginRepositoryV1["issueInvitedAccountSession"]>(async () => ({
    expiresAt: new Date(now + 7 * 24 * 60 * 60_000),
  }));
  const repository: OidcLoginRepositoryV1 = {
    close: vi.fn(async () => undefined),
    createLoginAttempt,
    consumeLoginAttempt,
    issueAccountSession,
    issueInvitedAccountSession,
    ready: vi.fn(async () => true),
    ...overrides,
  };
  const authorizationUrl = vi.fn<OidcIdentityProviderV1["authorizationUrl"]>(async (input) => {
    const url = new URL("https://identity.example/authorize");
    for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value);
    return url;
  });
  const exchange = vi.fn<OidcIdentityProviderV1["exchange"]>(async () => ({
    issuer: "https://identity.example",
    subject: "external-user",
  }));
  const provider: OidcIdentityProviderV1 = { authorizationUrl, exchange };
  let generated = 0;
  const service = createOidcLoginServiceV1({
    now: () => now,
    provider,
    randomBytes: () => Buffer.alloc(32, ++generated),
    randomUuid: () => "00000000-0000-4000-8000-000000000001",
    repository,
  });
  return {
    authorizationUrl,
    consumeLoginAttempt,
    createLoginAttempt,
    exchange,
    issueAccountSession,
    issueInvitedAccountSession,
    repository,
    service,
  };
}

describe("OIDC login service", () => {
  it("persists only hashed state and browser binding while retaining PKCE inputs", async () => {
    const { authorizationUrl, createLoginAttempt, service } = fixture();

    const started = await service.start();

    expect(started.browserBindingToken).toBe(opaque(4));
    expect(started.browserBindingTtlSeconds).toBe(600);
    expect(createLoginAttempt).toHaveBeenCalledWith(
      {
        browserBindingHash: digest(4),
        codeVerifier: opaque(3),
        lifetimeMs: 600_000,
        nonce: opaque(2),
        stateHash: digest(1),
      },
      undefined,
    );
    expect(authorizationUrl).toHaveBeenCalledWith({
      codeChallenge: await calculatePKCECodeChallenge(opaque(3)),
      nonce: opaque(2),
      state: opaque(1),
    });
  });

  it("binds an invitation digest to the one-time login attempt without persisting the raw token", async () => {
    const { createLoginAttempt, service } = fixture();

    await service.start({ invitationToken: opaque(9) });

    expect(createLoginAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ invitationTokenDigest: digest(9) }),
      undefined,
    );
    expect(createLoginAttempt.mock.calls[0]?.[0]).not.toHaveProperty("invitationToken");
  });

  it("rejects malformed invitation tokens before provider or storage access", async () => {
    const { authorizationUrl, createLoginAttempt, service } = fixture();

    await expect(service.start({ invitationToken: "not-a-token" })).rejects.toMatchObject({
      kind: "invalid-callback",
    });
    expect(authorizationUrl).not.toHaveBeenCalled();
    expect(createLoginAttempt).not.toHaveBeenCalled();
  });

  it("consumes the browser-bound attempt before exchange and stores only the session hash", async () => {
    const { consumeLoginAttempt, exchange, issueAccountSession, service } = fixture();
    const callbackUrl = new URL(`https://studio.example/auth/oidc/callback?code=code&state=${opaque(7)}`);

    const completed = await service.complete({
      browserBindingToken: opaque(8),
      callbackUrl,
      state: opaque(7),
    });

    expect(completed).toEqual({
      sessionToken: opaque(1),
      sessionTtlSeconds: 7 * 24 * 60 * 60,
    });
    expect(consumeLoginAttempt).toHaveBeenCalledWith(
      { browserBindingHash: digest(8), stateHash: digest(7) },
      undefined,
    );
    expect(exchange).toHaveBeenCalledWith({
      callbackUrl,
      codeVerifier: opaque(3),
      expectedNonce: opaque(2),
      expectedState: opaque(7),
    });
    expect(issueAccountSession).toHaveBeenCalledWith(
      {
        identity: { issuer: "https://identity.example", subject: "external-user" },
        lifetimeMs: 7 * 24 * 60 * 60_000,
        sessionTokenHash: digest(1),
      },
      undefined,
    );
  });

  it("rejects replay or browser mismatch before contacting the provider", async () => {
    const consumeLoginAttempt = vi.fn(async () => null);
    const { exchange, issueAccountSession, service } = fixture({ consumeLoginAttempt });

    await expect(
      service.complete({
        browserBindingToken: opaque(8),
        callbackUrl: new URL(`https://studio.example/auth/oidc/callback?code=code&state=${opaque(7)}`),
        state: opaque(7),
      }),
    ).rejects.toMatchObject({ kind: "invalid-callback" });
    expect(exchange).not.toHaveBeenCalled();
    expect(issueAccountSession).not.toHaveBeenCalled();
  });

  it("consumes an IdP cancellation without exchanging or issuing a session", async () => {
    const { consumeLoginAttempt, exchange, issueAccountSession, service } = fixture();

    await expect(
      service.complete({
        browserBindingToken: opaque(8),
        callbackUrl: new URL(`https://studio.example/auth/oidc/callback?error=access_denied&state=${opaque(7)}`),
        state: opaque(7),
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<OidcLoginErrorV1>>({ kind: "access-denied" }));
    expect(consumeLoginAttempt).toHaveBeenCalledOnce();
    expect(exchange).not.toHaveBeenCalled();
    expect(issueAccountSession).not.toHaveBeenCalled();
  });

  it("does not issue a cookie-capable result for an unknown local identity", async () => {
    const issueAccountSession = vi.fn(async () => null);
    const { service } = fixture({ issueAccountSession });

    await expect(
      service.complete({
        browserBindingToken: opaque(8),
        callbackUrl: new URL(`https://studio.example/auth/oidc/callback?code=code&state=${opaque(7)}`),
        state: opaque(7),
      }),
    ).rejects.toMatchObject({ kind: "access-denied" });
  });

  it("atomically provisions an invited membership only for a verified matching email", async () => {
    const invitationTokenDigest = digest(9);
    const consumeLoginAttempt = vi.fn(async () => ({
      codeVerifier: opaque(3),
      invitationTokenDigest,
      nonce: opaque(2),
    }));
    const { exchange, issueAccountSession, issueInvitedAccountSession, service } = fixture({ consumeLoginAttempt });
    exchange.mockResolvedValue({
      issuer: "https://identity.example",
      subject: "new-user",
      verifiedEmail: "invited@example.com",
    });

    await expect(
      service.complete({
        browserBindingToken: opaque(8),
        callbackUrl: new URL(`https://studio.example/auth/oidc/callback?code=code&state=${opaque(7)}`),
        state: opaque(7),
      }),
    ).resolves.toMatchObject({ sessionToken: opaque(1) });
    expect(issueAccountSession).not.toHaveBeenCalled();
    expect(issueInvitedAccountSession).toHaveBeenCalledWith(
      {
        identity: {
          issuer: "https://identity.example",
          subject: "new-user",
          verifiedEmail: "invited@example.com",
        },
        invitationTokenDigest,
        lifetimeMs: 7 * 24 * 60 * 60_000,
        newUserDisplayName: "New member",
        newUserId: "00000000-0000-4000-8000-000000000001",
        sessionTokenHash: digest(1),
        verifiedEmail: "invited@example.com",
      },
      undefined,
    );
  });

  it("denies an invitation callback without a verified email", async () => {
    const consumeLoginAttempt = vi.fn(async () => ({
      codeVerifier: opaque(3),
      invitationTokenDigest: digest(9),
      nonce: opaque(2),
    }));
    const { issueAccountSession, issueInvitedAccountSession, service } = fixture({ consumeLoginAttempt });

    await expect(
      service.complete({
        browserBindingToken: opaque(8),
        callbackUrl: new URL(`https://studio.example/auth/oidc/callback?code=code&state=${opaque(7)}`),
        state: opaque(7),
      }),
    ).rejects.toMatchObject({ kind: "access-denied" });
    expect(issueAccountSession).not.toHaveBeenCalled();
    expect(issueInvitedAccountSession).not.toHaveBeenCalled();
  });

  it("delegates readiness and closes storage idempotently", async () => {
    const { repository, service } = fixture();

    await expect(service.ready()).resolves.toBe(true);
    await service.close();
    await service.close();
    expect(repository.ready).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
  });
});
