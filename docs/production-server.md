# Production server boundary

`pnpm build:server` emits `dist-server/manim-production-server.mjs`. The module
exports `startProductionManimServer`; it does not start a listener when imported.
The deploying service must supply both of these adapters:

- `ProductionRequestAdmission`, whose `ready` probe covers the authentication
  provider and whose `admit` method denies unauthenticated API requests.
- `IsolatedManimRuntimeV1`, whose `ready` probe covers its backing stores and
  sandbox and whose capability asserts that every Python process runs inside
  that isolation boundary.

There is intentionally no environment-only or unauthenticated CLI. The current
`ManimProjectRegistry` launches Manim on the host and is therefore not a
production runtime adapter. Issue #117 owns the isolated render adapter, #120
owns principal-to-tenant selection, and #118 owns durable shared state. Until
those adapters exist, liveness can be served but readiness and the Manim API
must remain unavailable.

The transport configuration is strict and production-only. It requires one
public origin, an IP literal to bind, and bounded connection, header, body,
request, readiness, and shutdown limits. Non-loopback public origins require
HTTPS. TLS may terminate at a reverse proxy, but it must preserve the public
`Host`; forwarded headers are rejected unless the immediate peer IP is listed
in `trustedProxyAddresses`. Mutation `Origin` is compared directly with the
configured public origin rather than the unencrypted proxy-to-Node socket.

Shutdown first stops new HTTP connections and closes idle connections while
the runtime begins closing jobs and resources. At the configured grace
deadline, remaining requests are aborted and active connections are destroyed;
the returned promise rejects so the process supervisor can record an unclean
shutdown.
