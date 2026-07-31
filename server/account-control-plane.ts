import {
  ACCOUNT_LOGOUT_ROUTE_V1,
  ACCOUNT_SESSION_ROUTE_V1,
  createAccountSessionActionFetchHandlerV1,
  createAccountSessionActionFetchRequestGuardV1,
  createAccountSessionFetchHandlerV1,
  createAccountSessionFetchRequestGuardV1,
} from "./accounts/account-session-fetch";
import type { AccountSessionControlRepositoryV1 } from "./accounts/account-session-repository";
import { createOidcLoginFetchHandlerV1, createOidcLoginFetchRequestGuardV1 } from "./accounts/oidc-login-fetch";
import type { OidcLoginRepositoryV1 } from "./accounts/oidc-login-repository";
import { createOidcLoginServiceV1 } from "./accounts/oidc-login-service";
import {
  discoverOpenIdClientIdentityProviderV1,
  type OidcIdentityProviderV1,
  type OidcProviderConfigV1,
} from "./accounts/openid-client-provider";

export type OidcAccountControlPlaneOptionsV1<Environment> = Readonly<{
  loginAttemptLifetimeMs?: number;
  oidc: OidcProviderConfigV1;
  /** Must create request-scoped storage; Cloudflare Hyperdrive connections cannot be held in global scope. */
  repository: (environment: Environment) => OidcLoginRepositoryV1;
  /** Separate session adapter keeps browser account access independent from OIDC provider availability. */
  sessionRepository: (environment: Environment) => AccountSessionControlRepositoryV1;
  sessionLifetimeMs?: number;
}>;

/** Keeps OIDC discovery cached globally while storage is created and closed once per Worker request. */
export function createOidcAccountControlPlaneV1<Environment>(options: OidcAccountControlPlaneOptionsV1<Environment>) {
  if (typeof options.repository !== "function" || typeof options.sessionRepository !== "function") {
    throw new TypeError("Account control plane requires storage factories.");
  }
  let provider: OidcIdentityProviderV1 | null = null;
  const oidcProvider = () => (provider ??= discoverOpenIdClientIdentityProviderV1(options.oidc));
  const oidcRequestGuard = createOidcLoginFetchRequestGuardV1(options.oidc.publicOrigin);
  const sessionRequestGuard = createAccountSessionFetchRequestGuardV1(options.oidc.publicOrigin);
  const sessionActionRequestGuard = createAccountSessionActionFetchRequestGuardV1(options.oidc.publicOrigin);
  const withService = async <T>(
    environment: Environment,
    operation: (service: ReturnType<typeof createOidcLoginServiceV1>) => Promise<T>,
  ) => {
    const configuredProvider = oidcProvider();
    const repository = options.repository(environment);
    let requestService: ReturnType<typeof createOidcLoginServiceV1> | null = null;
    try {
      requestService = createOidcLoginServiceV1({
        loginAttemptLifetimeMs: options.loginAttemptLifetimeMs,
        provider: configuredProvider,
        repository,
        sessionLifetimeMs: options.sessionLifetimeMs,
      });
      return await operation(requestService);
    } finally {
      if (requestService) await requestService.close();
      else await repository.close();
    }
  };
  const withSessionRepository = async <T>(
    environment: Environment,
    operation: (repository: AccountSessionControlRepositoryV1) => Promise<T>,
  ) => {
    const repository = options.sessionRepository(environment);
    try {
      return await operation(repository);
    } finally {
      await repository.close();
    }
  };
  return Object.freeze({
    fetch: (request: Request, environment: Environment) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === ACCOUNT_SESSION_ROUTE_V1 && request.method === "GET") {
        const rejected = sessionRequestGuard.reject(request);
        if (rejected) return Promise.resolve(rejected);
        return withSessionRepository(environment, (repository) =>
          createAccountSessionFetchHandlerV1(repository, options.oidc.publicOrigin).fetch(request),
        );
      }
      if (pathname === ACCOUNT_SESSION_ROUTE_V1 || pathname === ACCOUNT_LOGOUT_ROUTE_V1) {
        const rejected = sessionActionRequestGuard.reject(request);
        if (rejected) return Promise.resolve(rejected);
        return withSessionRepository(environment, (repository) =>
          createAccountSessionActionFetchHandlerV1(repository, options.oidc.publicOrigin).fetch(request),
        );
      }
      const rejected = oidcRequestGuard.reject(request);
      if (rejected) return Promise.resolve(rejected);
      return withService(environment, (requestService) =>
        createOidcLoginFetchHandlerV1(requestService, options.oidc.publicOrigin).fetch(request),
      );
    },
    ready: (environment: Environment, signal?: AbortSignal) =>
      withService(environment, (requestService) => requestService.ready(signal)),
  });
}

export { ACCOUNT_LOGOUT_ROUTE_V1, ACCOUNT_SESSION_ROUTE_V1 } from "./accounts/account-session-fetch";
export {
  OIDC_LOGIN_BINDING_COOKIE_NAME_V1,
  OIDC_LOGIN_CALLBACK_ROUTE_V1,
  OIDC_LOGIN_START_ROUTE_V1,
} from "./accounts/oidc-login-fetch";
export { PostgresAccountSessionRepositoryV1 } from "./storage/postgres/postgres-account-session-repository";
export { PostgresOidcLoginRepositoryV1 } from "./storage/postgres/postgres-oidc-login-repository";
