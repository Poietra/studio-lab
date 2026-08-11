# Production server boundary

`pnpm build:server` emits `dist-server/manim-production-server.mjs`. The module
exports `startProductionManimServer`; it does not start a listener when imported.
The deploying service must supply request admission and exactly one runtime
selection path:

- `ProductionRequestAdmission`, whose `ready` probe covers the authentication
  provider and whose `authenticate` method returns server-verified principal
  claims for authenticated API requests.
- `ProductionManimRuntimeCellResolverV1`, which resolves a branded, verified
  Organization principal through a durable server-owned assignment and returns
  a tenant-fixed `ProductionManimRuntimeAdapterV1` lease. During migration or
  rollback, `runtime` supplies one pinned adapter and is wrapped by the same
  resolver contract.

There is intentionally no environment-only or unauthenticated CLI. The current
`ManimProjectRegistry` launches Manim on the host and is therefore not a
production runtime adapter. The injected in-process adapter is trusted code:
its structured readiness result is an operational assertion after it verifies
the external sandbox, not an isolation proof verified by this HTTP layer. The
shipped source-only render adapter and its trusted durable-media publisher use the
separate broker described in
[production-render-sandbox.md](./production-render-sandbox.md). The dynamic
resolver validates an opaque assignment on every acquire, bounds constructed
cells, and provisions only from deployment-owned database, object-store, and
sandbox configuration. The untrusted Organization selector is consumed only by
membership admission; it is never a runtime URL, cell ID, or provisioner input.
Digest-bounded input assets remain follow-up work. The load-balancer readiness
probe covers admission and the resolver control plane without enumerating or
provisioning every Organization. Each authenticated request separately checks
the selected cell's exact workspace, editor, render, or full boundary. Render,
snapshot, and media routes remain unavailable unless their
durable stores, staging-root correlation, and external sandbox brokers pass the
full runtime probe.

Migration v11 adds the account control-plane records required by request
admission: OIDC identities, organizations, and memberships. Migration v22 adds
bounded organization invitations and binds their digest to the one-time OIDC
attempt. Migration v24 indexes the durable tenant/actor invitation issuance
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
never accepted as authority. Signed-out browsers submit the invitation token
through a bounded same-origin `application/x-www-form-urlencoded` POST to
`/auth/oidc/start`; the ordinary sign-in link remains a GET. A successful POST
returns 303 and binds only the token digest to the one-time login attempt while
the browser receives the existing HttpOnly binding cookie. Raw invitation
tokens must not be placed in URLs, browser storage, logs, or telemetry.

OIDC discovery is lazy and caches only a successful configuration. The edge
login routes can therefore return 503 during an IdP outage without entering a
tenant cell or making existing PostgreSQL-backed sessions unavailable. Issuer,
client authentication method, and client credentials are
trusted startup configuration; the redirect URI is always derived from
`publicOrigin`, and the post-login redirect is fixed to `/`. The OIDC routes are
exposed only through the account-control-plane Fetch handler; Vite, Electron,
and the Node render server do not host them. The account bootstrap
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
memberships, invitations, or one-time login state. Apply the bundled catalog
with `pnpm storage:migrate` before deploying this Worker: it must reach at
least v28. `GET` and `PATCH /api/account/session` resolve through the v28
`account_organization_switch_mutations` table, so at v24 they fail on the
missing relation while `POST /api/account/logout` still succeeds — a partial
outage rather than a clean failure. The invitation repository additionally
requires the exact v24 quota migration, while the OIDC repository requires the
exact v22 invitation migration. The Worker routes must remain limited to the
same-origin `/auth/oidc/*` path and the exact `/api/account/session`,
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
Object. Migration v26 gives each session a database-generated, non-secret UUID
used only to revalidate an admitted socket; neither the raw cookie, session
token, nor token hash enters a Durable Object header or attachment. Each socket
attachment carries the exact room identity, subject, session and membership
versions, capabilities, and an authorization lease of at most 60 seconds. The
Durable Object schedules one alarm for the room's earliest lease and performs
one bounded batch revalidation after hibernation. An expired sender cannot
publish, and expired recipients are removed before head, presence, roster, or
snapshot delivery. Logout, active-organization switching, inactive users or
organizations, membership changes, project deletion, and document sealing are
therefore observed within the lease bound. A missing, malformed, foreign, or
unavailable revalidation result closes the affected sockets with a generic
policy failure; it never extends the previous lease. Use a caching-disabled
Hyperdrive configuration for both the edge Worker and Durable Object: revoked
sessions, memberships, sealed documents, and deleted projects must not be
admitted from a stale cache. The connect limiter is checked before PostgreSQL
and again against the authenticated
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

The opt-in Stripe Sandbox evidence lane exercises Hosted Checkout, a temporary
Stripe CLI signing secret, canonical Subscription reconciliation, render quota,
an actual Customer Portal Session, exact webhook replay, and immediate
cancellation. Install the Stripe CLI and a Playwright Chromium browser, then
provide a dedicated disposable PostgreSQL database, one active recurring
Sandbox Price, and one fixed test-mode Customer Portal configuration:

```sh
POIETRA_STRIPE_E2E_SECRET_KEY="$STRIPE_SANDBOX_SECRET" \
POIETRA_STRIPE_E2E_PRICE_ID="$STRIPE_SANDBOX_PRO_PRICE" \
POIETRA_STRIPE_E2E_PORTAL_CONFIGURATION_ID="$STRIPE_SANDBOX_PORTAL_CONFIGURATION" \
POIETRA_STRIPE_E2E_DATABASE_URL="$STRIPE_SANDBOX_DATABASE_URL" \
pnpm test:billing:stripe:required
```

`POIETRA_STRIPE_E2E_STRIPE_CLI` can select a non-default CLI executable and
`POIETRA_STRIPE_E2E_TEST_EMAIL` can override the generated test address. The
required command rejects missing settings and every key except `sk_test_...`
before opening Stripe or PostgreSQL. The default test suites skip the live lane
and never contact Stripe. CLI output, its ephemeral `whsec_...` value, payment
fields, signed raw bodies, Stripe secrets, and the ephemeral Portal URL are
retained only in memory and are not emitted as evidence artifacts. The Portal
smoke uses the durable server-bound Customer, the configured Portal ID, and the
server-owned return URL; it validates the credential-free HTTPS response but
does not persist, log, or navigate to it. The lane uses bounded requests and
best-effort cancellation/Customer deletion; a passing local run is still not a
claim that production billing credentials or routes are configured.

## Runtime server process

`pnpm build:production-runtime` bundles `server/production-runtime-entry.ts` to
`dist-production-runtime/poietra-production-runtime.mjs`, and
`pnpm start:production-runtime -- /etc/poietra/runtime.json` runs it. That entry
is the only supported way to start the Node runtime server: it is the
composition root that turns one reviewed config file into the admission
adapter, the runtime-cell resolver, and the server itself.

The config path must be canonical and absolute, and the file must be
root-owned and not group- or world-writable, exactly like the sandbox broker's
config. Everything the process needs is plain data in that file, so no
credential ever reaches an environment variable, a command line, or a log. The
process prints nothing but a fixed failure sentence on stderr; the structured
log is the operator's channel.

Database endpoints are expressed as fields, never as a connection string,
because `assertProductionPoolConfig` refuses a connection string, a socket
host, a custom stream, and unverified TLS. The entry builds two pools from
those fields: a `max: 1` migration pool and the request pool, so a migration
can never contend with request traffic. Apply the catalog with
`pnpm storage:migrate` before starting the process.

Only endpoints and identities are required. Sweep intervals, batch sizes,
retention windows, and lease durations all carry defaults, so a minimal config
names the database, the object storage bucket and provider, the two sandbox
broker sockets, the render staging root, the namespace, and the listening
socket. Unknown keys are rejected rather than ignored.

Exit codes distinguish the two failures an operator must tell apart: `2` means
the command line was wrong, `1` means the process failed closed. `SIGINT` and
`SIGTERM` drain the server first and only then close the repositories behind
it.

## Bundled durable-storage migrations

Every Worker and runtime-server deployment described in this document requires
the bundled catalog to be applied first. `pnpm storage:migrate` is the only
supported way to do that. It reads the same `PG*` environment the other
operator tools read, so no connection string is ever passed on the command line
or written to the report it prints on stdout.

```sh
PGHOST=... PGPORT=5432 PGDATABASE=... PGUSER=... PGPASSWORD=... \
  pnpm storage:migrate -- --dry-run
```

`PGHOST` must name a TCP endpoint; a socket path is rejected. The connection
always verifies TLS (`rejectUnauthorized`), so the host's CA must already be
trusted by the operator machine — export `NODE_EXTRA_CA_CERTS` when the
provider issues a private CA. Every `PG*` value must be an explicit non-empty
setting without an embedded NUL, because the PostgreSQL startup packet would
truncate rather than reject one. Pass `PGPASSWORD` from the operator secret
store rather than shell history.

Run `--dry-run` first: it applies nothing and reports `recorded` (what the
database already has) and `pending` (what this bundle would add).

The default target is the catalog head. That default is for a database with no
live process attached to it — a freshly provisioned staging or production
instance, or a cell whose traffic is already drained. It is not a general
upgrade command: several bundled migrations are stop-the-world cutovers whose
own sections in this document own the sequence, including v10 and v25, the
v14/v15 billing pair, the v18 editor cutover, and v19. Where such a section
applies, its drain-and-stop sequence takes precedence, and `--through <version>`
is how you land one migration at a time within it. A staged report carries
`"atHead":false` so a partial stage can never read as a finished one.

The tool fails closed rather than repairing state. It refuses to run when the
database records a migration this bundle does not carry, which means the
deployment artifact is older than the database and must not be promoted. It
also re-reads the recorded inventory after applying and refuses to report
success unless every version through the target is present.

Pin operator tooling against `BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1` rather
than a literal version. A literal goes stale the moment a migration is added,
and because the applier always runs the catalog to its head, a stale literal
rejects every run instead of failing visibly at review time.

## Runtime cell routing

Every runtime API remains tenant-fixed, but one server may now own a bounded
pool of those cells. `BoundedProductionManimRuntimeCellResolverV1` accepts only
the branded principal returned after membership authorization. It passes that
principal's tenant ID to `ProductionRuntimeCellAssignmentSourceV1`, validates
the returned tenant, opaque cell ID, monotonic generation, and active state,
then calls `ProductionManimRuntimeCellProvisionerV1`. Request headers, URL
paths, project IDs, query parameters, and browser state are unavailable to both
contracts.

The first shipped topology is a shared multi-tenant process with a bounded
tenant-fixed runtime cache. `createDurablePostgresS3ProductionRuntimeCellProvisionerV1`
reuses deployment-owned PostgreSQL, private object-storage, and sandbox
configuration while injecting only the validated assignment tenant ID. It does
not select regions, runtime URLs, credentials, or storage endpoints. Assignment
lookup runs on every acquire; a higher generation constructs a replacement and
drains the old cell after its last request lease. Missing, disabled, malformed,
stale, cross-tenant, conflicting, or over-capacity assignments return the same
bounded tenant-unavailable response. Idle cells are evicted least-recently used;
an active cell is never torn down to admit another request.

Apply bundled durable-storage migration v29 before deploying a process that
constructs the PostgreSQL-backed dynamic resolver. Keep the previous pinned
runtime serving while the migration is applied, verify the recorded v29
checksum, and only then enable the dynamic resolver. Its assignment repository
readiness probe fails closed when the schema or checksum is absent, so rolling
out the new code before the migration makes the dynamic lane unavailable rather
than falling back to a client-selected tenant. The pinned `runtime` composition
remains the rollback path and does not depend on an assignment row.

Create, rotate, and disable assignment mutations are server-owned control-plane
operations. Do not expose their repository methods through runtime request
headers, URLs, project payloads, browser state, or an Organization member API.
Each mutation carries a server-generated idempotency key; an exact retry returns
the durable result, while reuse with a different operation, cell ID, or expected
generation is rejected. Generation is the cache-invalidation token. Because the
resolver reads PostgreSQL on every acquire, rotation sends new leases to the new
generation and retires the previous adapter only after its outstanding leases
are released. Disable denies new leases and drains the prior adapter the same
way. No process-local assignment cache is authoritative, and a restarted process
reconstructs routing solely from the durable rows.

Existing single-cell deployments pass `runtime` as before. The server wraps it
with `createPinnedProductionManimRuntimeCellResolverV1`, preserving the former
foreign-tenant 403 and readiness behavior. To migrate, first create a durable
generation-1 assignment for the existing Organization, deploy the dynamic
resolver with a capacity of at least two, verify two Organization principals
through one origin, and only then add further assignments. Rollback stops new
assignments, drains dynamic leases, and redeploys the pinned `runtime`; it must
not rewrite tenant IDs or redirect requests with a client-visible cell route.

Provisioning managed staging PostgreSQL or Hyperdrive, defining their
least-privilege deployment roles, rotating their secrets, and proving the live
staging cutover remain the explicit non-goals tracked by #431. This composition
covers the local durable repository and transaction contract only; it does not
claim that the #431 infrastructure exists.

The development-only `studio-local` and `local-*` identities are rejected by
both production authentication and every provisioned runtime. Existing-folder
workspace registration is disabled in production so a request cannot attach
another tenant's host path. Authentication and membership verification run
before cell resolution, preventing unauthenticated traffic from probing the
assignment or render/storage adapter. The public `/readyz` probe checks
admission and resolver control-plane readiness; authenticated requests then
probe only their selected cell. The shipped production composition stores
tenant-scoped source, editor, render session, snapshot, video, and thumbnail
state in PostgreSQL plus private object storage. Filesystem-backed catalogs and
process-local publication stores remain confined to Vite/Electron development
paths.

## Snapshot publication tombstone retention

Apply bundled durable-storage migration v27 before starting code that enables
snapshot publication tombstone compaction. Migration v27 adds the required
partial index and is compatible with the previous code, while the new
repository readiness check requires its exact checksum and fails closed when it
is absent. Schedule and observe the index creation on a large
`snapshot_scene_heads` table, verify migration v27, and only then start the new
code.

Each successful snapshot artifact GC sweep attempts at most 64 tombstones per
tenant. For a configured sweep interval of `intervalMs`, the upper-bound
throughput for one worker instance is `64 * 86,400,000 / intervalMs` tombstones
per day. For example, an interval of 60,000 ms can compact at most 64 per minute,
3,840 per hour, or
92,160 per day. This is a capacity ceiling rather than a guaranteed rate: a
partial object-deletion sweep failure skips compaction, and any pending object
deletion closes the tenant-wide SQL gate, so compaction throughput is zero
until the deletion queue is healthy. Connect the required
`onTombstoneCompactionMetrics` callback to the deployment's metrics sink and
monitor `compactedPublicationTombstones`,
`deferredPublicationTombstoneCompactions`, and `tombstoneRetentionMs`; these
counters intentionally expose no artifact or publication identity. Deletion
sweep failures continue to be reported through `onFailure`.

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
