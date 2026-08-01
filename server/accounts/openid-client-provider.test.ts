import { ClientSecretPost, Configuration } from "openid-client";
import { describe, expect, it, vi } from "vitest";

const authorizationCodeGrant = vi.hoisted(() => vi.fn());
vi.mock("openid-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openid-client")>()),
  authorizationCodeGrant,
}));

import { createOpenIdClientIdentityProviderV1, discoverOpenIdClientIdentityProviderV1 } from "./openid-client-provider";

describe("openid-client identity provider configuration", () => {
  it.each([
    "http://identity.example/",
    "https://user:secret@identity.example/",
    "https://identity.example/?tenant=request-derived",
    "https://identity.example/#fragment",
  ])("rejects an unsafe or non-HTTPS issuer before discovery: %s", async (issuer) => {
    expect(() =>
      discoverOpenIdClientIdentityProviderV1({
        clientId: "poietra",
        clientSecret: "secret",
        issuer,
        publicOrigin: "https://studio.example",
      }),
    ).toThrow(/issuer/i);
  });

  it("builds a code-flow request with fixed redirect, PKCE S256, state, and nonce", async () => {
    const configuration = new Configuration(
      {
        authorization_endpoint: "https://identity.example/authorize",
        issuer: "https://identity.example",
        token_endpoint: "https://identity.example/token",
      },
      "poietra",
      {
        client_secret: "secret",
        redirect_uris: ["https://studio.example/auth/oidc/callback"],
        response_types: ["code"],
      },
      ClientSecretPost("secret"),
    );
    const provider = createOpenIdClientIdentityProviderV1(configuration, "https://studio.example/auth/oidc/callback");

    const url = await provider.authorizationUrl({
      codeChallenge: "c".repeat(43),
      nonce: "n".repeat(43),
      state: "s".repeat(43),
    });

    expect(url.origin).toBe("https://identity.example");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "poietra",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      nonce: "n".repeat(43),
      redirect_uri: "https://studio.example/auth/oidc/callback",
      response_type: "code",
      scope: "openid email",
      state: "s".repeat(43),
    });
  });

  it.each([
    [{ email: " Invited@Example.COM ", email_verified: true }, "invited@example.com"],
    [{ email: "invited@example.com", email_verified: false }, undefined],
    [{ email: "invalid", email_verified: true }, undefined],
  ])("returns only a valid provider-verified normalized email: %j", async (emailClaims, expected) => {
    const configuration = new Configuration(
      {
        authorization_endpoint: "https://identity.example/authorize",
        issuer: "https://identity.example",
        token_endpoint: "https://identity.example/token",
      },
      "poietra",
      { client_secret: "secret" },
      ClientSecretPost("secret"),
    );
    authorizationCodeGrant.mockResolvedValueOnce({
      claims: () => ({ iss: "https://identity.example", sub: "external-user", ...emailClaims }),
    });
    const provider = createOpenIdClientIdentityProviderV1(configuration, "https://studio.example/auth/oidc/callback");

    await expect(
      provider.exchange({
        callbackUrl: new URL(`https://studio.example/auth/oidc/callback?code=fake&state=${"s".repeat(43)}`),
        codeVerifier: "v".repeat(43),
        expectedNonce: "n".repeat(43),
        expectedState: "s".repeat(43),
      }),
    ).resolves.toEqual({
      issuer: "https://identity.example",
      subject: "external-user",
      ...(expected === undefined ? {} : { verifiedEmail: expected }),
    });
  });
});
