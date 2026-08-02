# Production server boundary

`pnpm build:server` emits `dist-server/manim-production-server.mjs`. The module
exports `startProductionManimServer`; it does not start a listener when imported.
The deploying service must supply both of these adapters:

- `ProductionRequestAdmission`, whose `ready` probe covers the authentication
  provider and whose `authenticate` method returns server-verified principal
  claims for authenticated API requests.
- `ProductionManimRuntimeAdapterV1`, whose `workspaceReady` probe covers the
  durable source workspace and whose `ready` probe additionally covers media,
  snapshots, and a fresh external-sandbox attestation.

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
follow-up work. The load-balancer readiness probe depends on authentication and
the durable source workspace, so a render outage can still be reported inside
Studio. Render, snapshot, and media routes remain unavailable unless their
durable stores, staging-root correlation, and external sandbox brokers pass the
full runtime probe.

Migration v11 adds the account control-plane records required by request
admission: OIDC identities, organizations, and memberships. Migration v22 adds
bounded organization invitations and binds their digest to the one-time OIDC
attempt. Migration v23 indexes the durable tenant/actor invitation issuance
window used by the account-control-plane quota. The exported
`createOrganizationMembershipProductionAdmissionV1` composes an injected
external-identity verifier with `PostgresOrganizationMembershipRepositoryV1`.
`X-Poietra-Organization-Id` is only an untrusted organization selector; the
repository must resolve an active user, organization, and membership before it
returns the internal user UUID and tenant ID accepted by the existing API.
Browser-native requests that cannot attach this header (`<video>`,
`<a download>`, and WebSocket upgrades) may instead use the active organization
bound to the verified HttpOnly session. That value is still only a selector:
PostgreSQL membership is revalidated before every admitted request.
Migration v12 adds the minimal browser-session read path. The fixed
`__Host-poietra_session` cookie contains one canonical 256-bit opaque token;
only its SHA-256 hash is stored. Expired, revoked, malformed, or inactive-user
sessions fail authentication before membership admission, and deleting a
membership cascades its sessions. Bearer credentials are not a fallback for
this browser authenticator. Migration v13 and the Fetch API account-control-plane
handler add `/auth/oidc/start`, `/auth/oidc/callback`, browser bootstrap
`GET /api/account/session`, version-fenced active-organization switching through
same-origin `PATCH /api/account/session`, and current-session logout through same-origin
`POST /api/account/logout`. Login uses Authorization
Code, PKCE S256, state, nonce, and a separate short-lived browser-binding cookie.
PostgreSQL stores only the state and binding hashes; `DELETE ... RETURNING`
consumes the verifier and nonce exactly once. A successful callback issues a new
opaque session only for an existing active OIDC identity with an active
organization membership. The sole provisioning exception is a pending,
unexpired invitation: an owner or admin creates an `admin`, `member`, or
`billing` invitation through same-origin `POST /api/account/invitations`, and
the callback must carry an `email_verified: true` claim whose normalized ASCII
email exactly matches the stored target. The raw 256-bit invitation token is
returned only by that create response; PostgreSQL stores only its SHA-256
digest. The invitation row, new user when needed, membership, consumed status,
and browser session are committed in one transaction. Revocation uses an empty
same-origin `DELETE /api/account/invitations/:id` and is scoped to the actor's
active organization. Member and billing roles cannot issue or revoke
invitations, owner cannot be an invited role, and IdP role or tenant claims are
never accepted as authority.

OIDC discovery is lazy and caches only a successful configuration. The edge
login routes can therefore return 503 during an IdP outage without entering a
tenant cell or making existing PostgreSQL-backed sessions unavailable. Issuer,
client authentication method, and client credentials are
trusted startup configuration; the redirect URI is always derived from
`publicOrigin`, and the post-login redirect is fixed to `/`. The OIDC routes are
exposed only through the account-control-plane Fetch handler; Vite, Electron,
and the single-tenant Node render server do not host them. The account bootstrap
reads the opaque cookie through a separate request-scoped PostgreSQL adapter,
returns only the user display identity plus bounded active organization
memberships, and does not consult OIDC discovery, its rate limits, or
`CF-Connecting-IP`. Switching accepts only a bounded JSON organization ID,
revalidates the active membership and organization in PostgreSQL, and returns
the same account view. Logout revokes only the presented opaque session and
expires its fixed HttpOnly cookie; missing, unknown, and already-revoked
sessions remain idempotent. These account-session routes stay available during
an IdP outage. General self-signup remains a later #309 slice; an invitation is
not a self-signup credential and cannot choose its tenant or role. Cloudflare
Worker/BFF deployment must rate-limit `/auth/oidc/start`,
`/auth/oidc/callback`, and invitation create/revoke mutations at the edge; an
in-process per-isolate limiter is not a meaningful abuse boundary. The
Cloudflare counters are PoP-local and eventually consistent, so the serialized
PostgreSQL pending and issuance-window quota remains the durable authority. A
syntactically valid but unknown callback still performs the
one-time-state lookup, so callback limits protect PostgreSQL as well as the IdP.
OIDC tenant and role claims are never authorization inputs. Owner, admin, and
member roles can enter the Manim API; the billing-only role cannot. The
membership admission exposes `close()`, transferring its owned PostgreSQL pool
to the server lifecycle. Admissions without `close()` remain caller-owned.

The deployable Cloudflare entry is
`server/cloudflare-account-control-plane-worker.ts`. Copy
`wrangler.account-control-plane.example.jsonc` to the ignored
`wrangler.account-control-plane.jsonc`, then replace its example route, zone,
Hyperdrive ID, rate-limit namespace IDs, and non-secret OIDC values. Every
rate-limit namespace must be distinct from the others and from other
environments. Store `POIETRA_OIDC_CLIENT_SECRET` with
`pnpm exec wrangler secret put POIETRA_OIDC_CLIENT_SECRET --config wrangler.account-control-plane.jsonc`;
never add it to `vars`, an environment file in source control, or CI output.
`pnpm build:account-worker` validates and bundles the committed example without
deploying it. `pnpm deploy:account-worker` intentionally requires the ignored
production configuration.

Authentication must use a dedicated Hyperdrive configuration created or
updated with `--caching-disabled`; stale reads are not acceptable for sessions,
memberships, invitations, or one-time login state. Apply bundled migrations
through v23 before deploying this Worker. The invitation repository requires
the exact v23 quota migration, while the OIDC repository requires the exact v22
invitation migration. The Worker routes must remain limited to the same-origin
`/auth/oidc/*` path and the exact `/api/account/session`,
`/api/account/logout`, and `/api/account/invitations[/<id>]` paths, with
`workers_dev` and preview URLs off.
Set those security-critical routes to fail closed in Cloudflare before promotion.
Invocation logs and traces remain disabled because callback URLs contain OIDC
codes and state, invitation requests contain invited email addresses, and
invitation responses contain raw invitation tokens. Do
not attach raw Worker Tail, Logpush, request-body logging, or request-URL logging
to this Worker; zone Logpush must omit full request URIs for these routes. Use a
sentinel callback and invitation to verify that code, state, nonce, cookies,
invitation tokens, and secrets do not appear in production logs. The Worker
limits OIDC start, OIDC callback, invitation creation, and invitation revocation
independently before it opens PostgreSQL storage; missing bindings, invalid
configuration, rate-limit errors, and missing Cloudflare client IPs fail closed
with a generic 503.

Realtime Editor head notification is a third, separately deployed edge at
`server/cloudflare-editor-collaboration-worker.ts`. Copy
`wrangler.editor-collaboration.example.jsonc` to the ignored
`wrangler.editor-collaboration.jsonc`, then replace its route, zone, Hyperdrive
ID, and the three account-unique rate-limit namespace IDs. Run
`pnpm build:collaboration-worker` for a local dry-run bundle
and `pnpm deploy:collaboration-worker` only with the reviewed deployment file.
The route must remain limited to same-origin `/api/collaboration/*`; Worker
preview URLs, invocation logs, and traces stay disabled.

The collaboration Worker accepts only an exact WebSocket upgrade carrying the
server-issued HttpOnly session cookie. It resolves the session's active
Organization, revalidates the PostgreSQL membership and project, then routes
the exact Organization/project/document/epoch tuple to one hibernatable Durable
Object. Use a caching-disabled Hyperdrive configuration: revoked sessions,
memberships, and deleted projects must not be admitted from a stale cache. The
connect limiter is checked before PostgreSQL and again against the authenticated
member; a separate head limiter bounds notification-to-tail-read amplification.
The per-connection presence limiter separately bounds ephemeral cursor,
selection, and playhead fanout without making a member's second tab consume the
first tab's budget. Presence is reconstructed only from bounded hibernated socket
attachments: up to 32 members and 64 connections are admitted to one exact
document epoch, duplicate tabs collapse to one member, and no presence value is
written to PostgreSQL or advances the Editor revision. Missing or malformed
limiter bindings fail closed. The
Durable Object persists no Program, event, or revision. Its strict head message
is only a lossy wake-up; every browser applies changes exclusively by reading
the authenticated PostgreSQL event tail. Consequently a duplicate, stale, or
forged-ahead head cannot install state. Reconnect always wakes the same tail
reconciler so DO eviction and missed broadcasts converge from PostgreSQL.
Actual append/replace/remove mutations continue through the production Editor
HTTP endpoint, which revalidates membership and performs the revision CAS.

The Stripe billing edge is a separate deployment at
`server/cloudflare-billing-control-plane-worker.ts`; do not add its routes or
secrets to the OIDC Worker. Copy `wrangler.billing-control-plane.example.jsonc`
to the ignored `wrangler.billing-control-plane.jsonc`, replace its route, zone,
Hyperdrive ID, rate-limit namespace IDs, Pro price ID, render limit, and
expected `test` or `live` mode. Set `POIETRA_STRIPE_PORTAL_CONFIGURATION_ID`
to one fixed Customer Portal configuration from the same Stripe mode, then
store both secrets without printing them:

```sh
pnpm exec wrangler secret put POIETRA_STRIPE_SECRET_KEY --config wrangler.billing-control-plane.jsonc
pnpm exec wrangler secret put POIETRA_STRIPE_WEBHOOK_SECRET --config wrangler.billing-control-plane.jsonc
```

`pnpm build:billing-worker` bundles the committed example without deploying;
`pnpm deploy:billing-worker` requires the ignored production configuration.
Apply bundled durable-storage migration v19 before deploying the Worker. Every
request scope verifies the exact billing migration v16 checksum and returns
unavailable rather than serving against an older or modified schema.
Migration v19 expands `render_sessions.scene_name` to the canonical 240-character
Manim Scene boundary; new render processes remain unready until that migration is present.
Drain old render processes before applying v19 and keep them stopped until the
migration and new deployment finish. Validation scans `render_sessions` without
holding an `ACCESS EXCLUSIVE` lock for the duration, but it should still be scheduled
and observed on a large table. Old processes enforce the former 128-character
repository boundary.
Migration v18 is a coordinated editor cutover, not a rolling mixed-version
upgrade. Drain every process that reads or writes the v17 editor event ledger,
keep editor traffic unavailable while applying v18, and then start only
v18-aware processes. A v17 process cannot interpret replace/remove events and
its legacy inserts intentionally fail once v18 removes the append default.
Use a dedicated Hyperdrive configuration with caching disabled. The Worker
accepts only the exact `/api/billing/status`, `/api/billing/checkout`,
`/api/billing/portal`, and `/api/billing/stripe/webhook` routes. Checkout uses
Stripe's `hosted_page` UI. Portal Session URLs are created on demand from the
durably bound Customer and must never be persisted or logged. Configure that
Portal configuration with subscription plan switching and quantity changes
disabled; the local entitlement model supports exactly one fixed Price with a
quantity of one. Checkout and Portal share one edge rate-limit binding but use
distinct per-route keys; webhook traffic has a separate binding. All mutation
limits run before request-scoped PostgreSQL adapters are opened. Status
requires `billing:read`; Checkout and Portal require `billing:manage`. The
webhook intentionally bypasses browser session admission and instead verifies
the Stripe signature against the unmodified raw request bytes.

Configure the Stripe webhook endpoint as
`https://<public-origin>/api/billing/stripe/webhook` with endpoint API version
`2026-03-25.dahlia`. Subscribe only to the Checkout completion and customer
subscription create, update, and delete events used by the service. Stripe
events are wake-ups: access is granted only after the service retrieves and
persists the canonical Subscription. Keep Workers preview URLs, invocation
logs, traces, request-body logging, and raw Tail/Logpush disabled for this
deployment. The Stripe key, webhook secret, signature header, and webhook body
must never enter application logs or error responses.

Each server instance remains a single-tenant cell: its runtime API declares one
server-owned tenant ID and at least one bounded absolute storage root. A
verified principal must resolve to that same tenant. Foreign tenants receive a
generic 403, and the development-only `studio-local` and `local-*` identities
are rejected by both production authentication and runtime startup. Existing-
folder workspace registration is disabled in production so a request cannot
attach another tenant's host path. Authentication readiness and principal
verification run
before full runtime readiness, preventing unauthenticated API traffic from
probing the render/storage adapter. The public `/readyz` probe checks admission
and durable workspace readiness; authenticated project/workspace GETs can then
surface a bounded render-capability outage while mutations and execution routes
continue to require full readiness. The shipped production composition stores
tenant-scoped source, session, snapshot, video, and thumbnail state in
PostgreSQL plus a private, versioned S3-compatible bucket. Filesystem-backed
catalogs and process-local publication stores remain confined to the
Vite/Electron development paths.

## Billing-entitlement rollout

Migration v14 adds metered entitlements, and migration v15 makes every new
render session prove its matching usage lifecycle at transaction commit. This
changes the safety contract of the running binary, so the pair must not be
applied as a normal rolling migration. Applying them while an old API or render
worker remains live is forbidden. Migration v15 makes an old binary's
unmetered insert or terminal transition fail closed, but an old/new mixed
deployment can still strand work. Rollback to an old binary is forbidden for
the same reason.

Use this mandatory rollout sequence for each single-tenant cell:

1. Stop new render admission at the load balancer or deployment control plane.
2. Drain all active preparing and rendering sessions, including outstanding
   cancellation delivery and acknowledgement work.
3. Stop every old API and render-worker process for the cell.
4. Run the operator CLI below. It applies the bundled migrations, seeds the
   tenant's generation-1 entitlement, and reads the current head back for an
   exact, active-state verification.
5. Start only the new generation and wait for its normal readiness probes.
6. Resume traffic only when the CLI emitted `"promotionReady":true` and the new
   generation is ready.

The CLI does not stop admission, drain work, start processes, change a load
balancer, or modify Cloudflare configuration. `/readyz` is also not an
entitlement-promotion gate; operators must complete the sequence above.

Create one strict JSON specification per cell. The UUID must be a stable,
operator-assigned UUIDv4 so rerunning the same command can prove an exact replay:

```json
{
  "tenantId": "tenant-a",
  "snapshotId": "00000000-0000-4000-8000-000000000001",
  "planKey": "starter",
  "usagePeriodKey": "2026-08",
  "renderJobLimit": 100,
  "periodStart": "2026-08-01T00:00:00.000Z",
  "accessUntil": "2026-08-31T00:00:00.000Z",
  "periodEnd": "2026-09-01T00:00:00.000Z"
}
```

Run it with an explicit TLS PostgreSQL endpoint. Supply the database password
only through the process environment; do not put it in the specification,
arguments, logs, or shell history. Use `NODE_EXTRA_CA_CERTS` when the database
CA is not already trusted by Node:

```sh
PGHOST=db.example.internal \
PGPORT=5432 \
PGDATABASE=poietra \
PGUSER=poietra_rollout \
PGPASSWORD="$POIETRA_ROLLOUT_DATABASE_PASSWORD" \
NODE_EXTRA_CA_CERTS=/run/secrets/database-ca.pem \
pnpm billing:entitlement:rollout -- --spec /run/poietra/tenant-a-entitlement.json
```

The command is deliberately single-tenant and generation-1-only. It has no
bulk mode and no `--force` escape hatch. A fresh apply reports `"status":"seeded"`;
an idempotent rerun reports `"status":"already-current"` only when every
persisted field still exactly matches. A different generation, snapshot,
period, plan, quota, inactive organization, or expired grant fails closed and
must be investigated rather than overwritten.

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
