import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ProductionAdmissionRequest } from "../manim-production-server";
import {
  ACCOUNT_SESSION_COOKIE_NAME_V1,
  createAccountSessionIdentityAuthenticatorV1,
} from "./account-session-authenticator";
import type { AccountSessionRepositoryV1 } from "./account-session-repository";

const tokenBytes = Buffer.alloc(32, 7);
const token = tokenBytes.toString("base64url");
const session = {
  issuer: "https://identity.example/",
  sessionOrganizationId: "organization-a",
  subject: "external-user",
} as const;

function request(cookie?: string): ProductionAdmissionRequest {
  return {
    credentials: {
      authorization: "Bearer must-not-be-used",
      ...(cookie === undefined ? {} : { cookie }),
    },
    directPeerAddress: "127.0.0.1",
    forwardedHeaders: { immediatePeerTrusted: false, present: false },
    method: "GET",
    pathname: "/api/manim/projects",
  };
}

function fixture() {
  const close = vi.fn(async () => undefined);
  const ready = vi.fn(async () => true);
  const resolveActiveSession = vi.fn(async () => session);
  const repository: AccountSessionRepositoryV1 = { close, ready, resolveActiveSession };
  return {
    authenticator: createAccountSessionIdentityAuthenticatorV1(repository),
    close,
    ready,
    resolveActiveSession,
  };
}

describe("account session identity authenticator", () => {
  it("hashes one canonical opaque cookie and ignores bearer credentials", async () => {
    const { authenticator, resolveActiveSession } = fixture();
    const signal = new AbortController().signal;

    await expect(
      authenticator.authenticate(
        request(`unrelated=value=with=equals; ${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}; theme=dark`),
        signal,
      ),
    ).resolves.toEqual(session);
    expect(resolveActiveSession).toHaveBeenCalledWith(createHash("sha256").update(tokenBytes).digest(), signal);
  });

  it("rejects absent, noncanonical, duplicated, or unbounded cookies before storage", async () => {
    const invalid = [
      undefined,
      "",
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}=`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}; ${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1} =${token}`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token.slice(1)}`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}a`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}=`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}="${token}"`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}=%${token}`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}; ${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}`,
      `${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}; oversized=${"x".repeat(8 * 1_024)}`,
      Array.from({ length: 65 }, (_, index) => `cookie${index}=value`).join("; "),
    ];
    for (const cookie of invalid) {
      const { authenticator, resolveActiveSession } = fixture();
      await expect(authenticator.authenticate(request(cookie), new AbortController().signal)).resolves.toBeNull();
      expect(resolveActiveSession).not.toHaveBeenCalled();
    }
  });

  it("propagates cancellation before hashing or querying", async () => {
    const { authenticator, resolveActiveSession } = fixture();
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    controller.abort(reason);

    await expect(
      authenticator.authenticate(request(`${ACCOUNT_SESSION_COOKIE_NAME_V1}=${token}`), controller.signal),
    ).rejects.toBe(reason);
    expect(resolveActiveSession).not.toHaveBeenCalled();
  });

  it("owns repository readiness and idempotent cleanup", async () => {
    const { authenticator, close, ready } = fixture();
    const signal = new AbortController().signal;

    await expect(authenticator.ready(signal)).resolves.toBe(true);
    expect(ready).toHaveBeenCalledWith(signal);
    await authenticator.close?.();
    await authenticator.close?.();
    expect(close).toHaveBeenCalledOnce();
  });
});
