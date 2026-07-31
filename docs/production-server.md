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
current runtime contract is limited to one deployment-isolated tenant. The shipped
source-only render adapter and its trusted durable-media publisher use the
separate broker described in
[production-render-sandbox.md](./production-render-sandbox.md). Issue #298 owns
multi-organization account selection and edge-to-cell routing, while
digest-bounded input assets remain
follow-up work. Readiness stays unavailable unless the durable stores, the
staging-root correlation, and both external sandbox brokers pass their probes.

Migration v11 adds the account control-plane records required by request
admission: OIDC identities, organizations, and memberships. Invitations remain
deferred until their verified-email acceptance flow lands. The exported
`createOrganizationMembershipProductionAdmissionV1` composes an injected
external-identity verifier with `PostgresOrganizationMembershipRepositoryV1`.
`X-Poietra-Organization-Id` is only an untrusted organization selector; the
repository must resolve an active user, organization, and membership before it
returns the internal user UUID and tenant ID accepted by the existing API.
Browser-native requests that cannot attach this header (`<video>`,
`<a download>`, and WebSocket upgrades) may instead use the active organization
bound to the verified HttpOnly session. That value is still only a selector:
PostgreSQL membership is revalidated before every admitted request.
OIDC tenant and role claims are never authorization inputs. Owner, admin, and
member roles can enter the Manim API; the billing-only role cannot. The
membership admission exposes `close()`, transferring its owned PostgreSQL pool
to the server lifecycle. Admissions without `close()` remain caller-owned.

Each server instance remains a single-tenant cell: its runtime API declares one
server-owned tenant ID and at least one bounded absolute storage root. A
verified principal must resolve to that same tenant. Foreign tenants receive a
generic 403, and the development-only `studio-local` and `local-*` identities
are rejected by both production authentication and runtime startup. Existing-
folder workspace registration is disabled in production so a request cannot
attach another tenant's host path. Authentication readiness and principal
verification run
before runtime readiness, preventing unauthenticated API traffic from probing
the render/storage adapter; the public `/readyz` probe still checks both
dependencies. The shipped production composition stores tenant-scoped source,
session, snapshot, video, and thumbnail state in PostgreSQL plus a private,
versioned S3-compatible bucket. Filesystem-backed catalogs and process-local
publication stores remain confined to the Vite/Electron development paths.

The transport configuration is strict and production-only. It requires one
public origin, an IP literal to bind, and bounded connection, header, body,
request, readiness, drain, and runtime-close limits. Port zero is rejected.
Non-loopback public origins require HTTPS. TLS may terminate at a reverse
proxy, but it must preserve the public `Host`; forwarded headers are rejected
unless the immediate peer IP is listed in `trustedProxyAddresses`. Raw
forwarded values are not passed to authentication—the admission adapter gets
only the direct peer, the verified transport facts, the Authorization and
Cookie credentials, and the bounded organization selector. Mutation `Origin`
is compared directly with the configured public origin rather than the
unencrypted proxy-to-Node socket.

Shutdown first stops new HTTP connections and drains tracked request tasks. It
rechecks the lifecycle after asynchronous readiness and admission so a request
cannot enter the runtime after draining begins. At the drain deadline,
remaining tasks are aborted, active connections are destroyed, and task
wrappers are joined before owned admission and runtime adapters close. Adapter
close has its own deadline. Either deadline breach rejects the returned promise
so the process supervisor can record an unclean shutdown. A valid runtime
adapter transfers runtime ownership to the server; an admission implementing
`close()` transfers its lifecycle too. Listener startup failure performs
bounded cleanup for both.
