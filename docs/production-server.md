# Production server boundary

`pnpm build:server` emits `dist-server/manim-production-server.mjs`. The module
exports `startProductionManimServer`; it does not start a listener when imported.
The deploying service must supply both of these adapters:

- `ProductionRequestAdmission`, whose `ready` probe covers the authentication
  provider and whose `authenticate` method returns server-verified principal
  claims for authenticated API requests.
- `ProductionManimRuntimeAdapterV1`, whose `ready` probe covers its backing
  stores and a fresh external-sandbox attestation.

There is intentionally no environment-only or unauthenticated CLI. The current
`ManimProjectRegistry` launches Manim on the host and is therefore not a
production runtime adapter. The injected in-process adapter is trusted code:
its structured readiness result is an operational assertion after it verifies
the external sandbox, not an isolation proof verified by this HTTP layer. The
current contract is limited to one deployment-isolated tenant. Issue #117 owns
the isolated render adapter, #120 owns principal-to-tenant selection, and #118
owns durable shared state. Until those adapters exist, liveness can be served
but readiness and the Manim API must remain unavailable.

Each server instance remains a single-tenant cell: its runtime API declares one
server-owned tenant ID and at least one bounded absolute storage root. A
verified principal must resolve to that same tenant. Foreign tenants receive a
generic 403, and the development-only `studio-local` and `local-*` identities
are rejected by the production authenticator path. Existing-folder workspace
registration is disabled in production so a request cannot attach another
tenant's host path. Authentication readiness and principal verification run
before runtime readiness, preventing unauthenticated traffic from probing the
render/storage adapter. Issue #118 still owns replacing these process-local
stores with durable tenant-scoped state before horizontal scaling.

The transport configuration is strict and production-only. It requires one
public origin, an IP literal to bind, and bounded connection, header, body,
request, readiness, drain, and runtime-close limits. Port zero is rejected.
Non-loopback public origins require HTTPS. TLS may terminate at a reverse
proxy, but it must preserve the public `Host`; forwarded headers are rejected
unless the immediate peer IP is listed in `trustedProxyAddresses`. Raw
forwarded values are not passed to authentication—the admission adapter gets
only the direct peer, the verified transport facts, and the Authorization and
Cookie credentials. Mutation `Origin` is compared directly with the configured
public origin rather than the unencrypted proxy-to-Node socket.

Shutdown first stops new HTTP connections and drains tracked request tasks. It
rechecks the lifecycle after asynchronous readiness and admission so a request
cannot enter the runtime after draining begins. At the drain deadline,
remaining tasks are aborted, active connections are destroyed, and task
wrappers are joined before runtime close starts. Runtime close has its own
deadline. Either deadline breach rejects the returned promise so the process
supervisor can record an unclean shutdown. A valid adapter transfers runtime
ownership to the server; listener startup failure also performs bounded runtime
cleanup.
