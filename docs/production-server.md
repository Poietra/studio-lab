# Production server boundary

`pnpm build:server` emits `dist-server/manim-production-server.mjs`. The module
exports `startProductionManimServer`; it does not start a listener when imported.
The deploying service must supply both of these adapters:

- `ProductionRequestAdmission`, whose `ready` probe covers the authentication
  provider and whose `authenticate` method returns server-verified principal
  claims for authenticated API requests.
- `ProductionManimRuntimeAdapterV1`, whose `apiReady` probe covers the source
  stores needed by ordinary workspace APIs and whose stricter `ready` probe
  additionally covers durable media, snapshots, maintenance, and a fresh
  external-sandbox attestation.

There is intentionally no environment-only or unauthenticated CLI. The current
`ManimProjectRegistry` launches Manim on the host and is therefore not a
production runtime adapter. The injected in-process adapter is trusted code:
its structured readiness result is an operational assertion after it verifies
the external sandbox, not an isolation proof verified by this HTTP layer. The
current contract is limited to one deployment-isolated tenant. The shipped
source-only render adapter and its trusted durable-media publisher use the
separate broker described in
[production-render-sandbox.md](./production-render-sandbox.md). Issue #120 owns
principal-to-tenant selection, while digest-bounded input assets remain
follow-up work. The full render-conformance probe stays unavailable unless the
durable stores, staging-root correlation, and both external sandbox brokers
pass their probes. A render outage is instead reported to Studio through the
bounded workspace `renderCapability`, so source editing and export remain
available while Render is disabled.

Each server instance remains a single-tenant cell: its runtime API declares one
server-owned tenant ID and at least one bounded absolute storage root. A
verified principal must resolve to that same tenant. Foreign tenants receive a
generic 403, and the development-only `studio-local` and `local-*` identities
are rejected by both production authentication and runtime startup. Existing-
folder workspace registration is disabled in production so a request cannot
attach another tenant's host path. Authentication readiness and principal
verification run
before API readiness, preventing unauthenticated API traffic from probing the
storage adapter. The public `/readyz` probe checks authentication plus the
source stores required to serve the workspace; it deliberately does not make a
temporary render-executor outage evict an otherwise usable Studio instance.
The public `/render-readyz` probe exposes the adapter's stricter `ready` result
as a separate render-health signal without taking the editing API out of
rotation. The shipped production composition stores tenant-scoped source,
session, snapshot, video, and thumbnail state in PostgreSQL plus a private,
versioned S3-compatible bucket. Filesystem-backed catalogs and process-local
publication stores remain confined to the Vite/Electron development paths.
Browser video playback and the direct MP4 download link reuse the authenticated
same-origin media endpoint, so browser admission must support an HttpOnly
same-origin session cookie (or replace the endpoint with a bounded signed URL);
an Authorization-header-only session cannot authenticate native media elements.

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
