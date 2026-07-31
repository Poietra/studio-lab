import { createOidcLoginFetchHandlerV1, createOidcLoginFetchRequestGuardV1 } from "./accounts/oidc-login-fetch";
import type { OidcLoginRepositoryV1 } from "./accounts/oidc-login-repository";
import { createOidcLoginServiceV1 } from "./accounts/oidc-login-service";
import { discoverOpenIdClientIdentityProviderV1, type OidcProviderConfigV1 } from "./accounts/openid-client-provider";

export type OidcAccountControlPlaneOptionsV1<Environment> = Readonly<{
  loginAttemptLifetimeMs?: number;
  oidc: OidcProviderConfigV1;
  /** Must create request-scoped storage; Cloudflare Hyperdrive connections cannot be held in global scope. */
  repository: (environment: Environment) => OidcLoginRepositoryV1;
  sessionLifetimeMs?: number;
}>;

/** Keeps OIDC discovery cached globally while storage is created and closed once per Worker request. */
export function createOidcAccountControlPlaneV1<Environment>(options: OidcAccountControlPlaneOptionsV1<Environment>) {
  if (typeof options.repository !== "function") throw new TypeError("Account control plane requires storage factory.");
  const provider = discoverOpenIdClientIdentityProviderV1(options.oidc);
  const requestGuard = createOidcLoginFetchRequestGuardV1(options.oidc.publicOrigin);
  const withService = async <T>(
    environment: Environment,
    operation: (service: ReturnType<typeof createOidcLoginServiceV1>) => Promise<T>,
  ) => {
    const repository = options.repository(environment);
    let requestService: ReturnType<typeof createOidcLoginServiceV1> | null = null;
    try {
      requestService = createOidcLoginServiceV1({
        loginAttemptLifetimeMs: options.loginAttemptLifetimeMs,
        provider,
        repository,
        sessionLifetimeMs: options.sessionLifetimeMs,
      });
      return await operation(requestService);
    } finally {
      if (requestService) await requestService.close();
      else await repository.close();
    }
  };
  return Object.freeze({
    fetch: (request: Request, environment: Environment) => {
      const rejected = requestGuard.reject(request);
      if (rejected) return Promise.resolve(rejected);
      return withService(environment, (requestService) =>
        createOidcLoginFetchHandlerV1(requestService, options.oidc.publicOrigin).fetch(request),
      );
    },
    ready: (environment: Environment, signal?: AbortSignal) =>
      withService(environment, (requestService) => requestService.ready(signal)),
  });
}

export {
  OIDC_LOGIN_BINDING_COOKIE_NAME_V1,
  OIDC_LOGIN_CALLBACK_ROUTE_V1,
  OIDC_LOGIN_START_ROUTE_V1,
} from "./accounts/oidc-login-fetch";
export { PostgresOidcLoginRepositoryV1 } from "./storage/postgres/postgres-oidc-login-repository";
