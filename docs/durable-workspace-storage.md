# Durable workspace/source storage

Status: production composition is available for durable workspace/source and
render-session storage, snapshot publication, isolated Manim execution, and
verified video/thumbnail publication. Digest-bounded input assets remain
follow-up work.

The built `manim-production-server.mjs` entry exports
`createDurablePostgresS3ProductionRuntimeV1`. The factory applies the embedded,
checksummed migrations with a one-connection DDL pool, creates bounded workspace
and render-session PostgreSQL repositories plus the private versioned S3 stores,
initializes the tenant, and starts the render queue consumer and the source,
project-image, snapshot, and render-artifact GC workers plus terminal-session
retention. It returns the adapter consumed by
`startProductionManimServer`.

Render sessions store immutable original/patched source receipts, a DB-clock
execution deadline, monotonically increasing lease fences, and an idempotent
Commit/Undo action ledger. The worker uses the stable `(tenantId, sessionId)` job
identity to submit or reattach through the concrete UDS sandbox executor. PostgreSQL rejects
stale lease publication, expires timed-out work even while the executor is
unavailable, and preserves terminal interrupted sessions for inspection. The
full runtime readiness attestation is false unless the render repository and
executor both pass their probes. Load-balancer readiness uses the narrower
durable workspace probe so Studio remains reachable and can report a bounded
render outage; render and media routes still fail closed on the full probe. An
injected or in-process host-spawn fallback is not part of the production
composition.

The migration and runtime database configurations are deliberately separate so
the runtime credential does not need DDL authority. Both require an explicit TCP
host and a TLS object with `rejectUnauthorized: true`; connection strings, Unix
sockets, custom streams, and custom `pg` clients are rejected by the production
factory because they can bypass inspectable transport settings.
All shipped SQL names the `public` schema explicitly, and owned pools force
`search_path=pg_catalog,public`; caller-supplied startup options are not accepted
by the production factory.

Snapshot runtime-digest migration v10 is intentionally not rolling-compatible.
Stop old API replicas and snapshot GC workers, apply v10 once, start the new
generation, and resume traffic only after its readiness probe succeeds. The
migration invalidates old snapshot heads instead of guessing which runtime made
them. It retains their immutable objects with the reserved all-zero runtime
digest so only the new GC can remove them; they are never eligible for API reads.

The source bucket must satisfy every readiness probe:

- versioning is enabled;
- the ACL grants only the bucket owner full control;
- no bucket policy exists, or S3 explicitly reports it as non-public;
- no lifecycle configuration exists; and
- a configured production endpoint is HTTPS and does not use path-style addressing.

Production S3 configuration must set `ignoreConfiguredEndpointUrls: true` so an
environment variable or shared AWS config cannot replace the inspected endpoint.
Custom request handlers, endpoint providers, URL parsers, TLS hooks, and dynamic
path-style providers are rejected. Each bounded S3 request has a 30-second
header deadline. Authorized media body streams retain their caller cancellation
signal and are additionally bounded by the production server's idle and
absolute media deadlines.

Source writes use `If-None-Match: *` at the content-addressed key. An existing
object is read back and digest/size/UTF-8 checked, so normal duplicate writes reuse
one immutable version. Every published receipt fixes the key, version ID, ETag,
size, and SHA-256 digest, and every read revalidates all of them.

Each GC worker probes PostgreSQL and bucket privacy before every sweep, runs one
bounded batch at a time, and schedules the next sweep only after the previous one
settles. Each sweep also has an explicit deployment-configured deadline. Its opaque
listing cursor advances across sweeps and wraps at the end, so retained published
versions at the front of a large bucket cannot starve later orphan cleanup. It
collects only S3 versions that were never published, such as uploads
left by a failed transaction or losing CAS. Deleted version receipts remain as
durable tombstones so a delayed publisher cannot resurrect a missing object.
Render sessions retain explicit project/source references, so their original and
patched receipts and pinned project `image.png` generation cannot be collected
while the session is active or within its configured input-retention window.
After a terminal session's deadline and retention window have elapsed, one
transaction detaches those references and records a DB-clock release boundary.
Committed, leased, running-action, and still-readable media sessions are never
detached. Source and project-image GC use that boundary—not object creation
time—as the start of their grace period, recheck every reference under the same
database locks used by publishers, and delete only the exact unreferenced S3
version. Released session/action audit rows are purged later under a separately
configured retention window and only after their media links are gone.

Render media uses a separate trusted-publication transaction. The broker writes
only to one canonical capability directory owned by `broker:Studio-group` with
mode `0750`; staged media is broker-owned mode `0640`. The Studio publisher
reopens each file with `O_NOFOLLOW`, pins the directory and file identities, and
checks the tenant, session, lease fence, source/runtime/profile/request digests,
size, signature, and SHA-256 from the opaque locator. Video and thumbnail bytes
are uploaded serially to content-addressed tenant keys in private versioned S3.
PostgreSQL then makes both receipts, the session video link, the current project
thumbnail, and the ready session visible in one fenced transaction. A partial
upload, stale fence, or publication crash therefore exposes neither half of a
bundle; an unregistered version remains eligible for GC.

The durable session view exposes `/api/manim/renders/:sessionId/video` only after
that transaction commits. The route supports authenticated `GET`, `HEAD`, and a
single byte range, returns `416` for an unsatisfiable range, and always opens the
exact S3 version from PostgreSQL. Project thumbnails are read through the same
tenant-fixed repository. PostgreSQL read claims cover HEAD and the full stream
lifetime, renew during slow reads, and block GC; expiry removes API visibility
immediately even if physical deletion has not run yet. Advisory locks and
durable deletion tombstones order claim renewal, publication, and deletion so a
late writer cannot resurrect an exact object version.

`renderArtifacts.stagingRoot` is the single Studio-side staging setting. The
production client hashes that canonical path, and readiness remains unavailable
unless the broker status attests the same digest as well as the pinned image
runtime and media profile. Operators must also configure artifact retention,
read-claim duration, and the bounded render-artifact GC schedule. A successful
worker publication removes its staging pair; a retryable publication failure
leaves the broker-owned pair available for reattachment. PostgreSQL and S3
remain authoritative across Studio process loss, while startup reconciliation
removes untracked broker containers and expired staging.
