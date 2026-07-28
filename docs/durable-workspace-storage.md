# Durable workspace/source storage

Status: production composition is available for durable workspace/source and
render-session storage, snapshot publication, and source-only isolated Manim
execution. Verified video/thumbnail publication remains #136, and
digest-bounded render assets remain follow-up work.

The built `manim-production-server.mjs` entry exports
`createDurablePostgresS3ProductionRuntimeV1`. The factory applies the embedded,
checksummed migrations with a one-connection DDL pool, creates bounded workspace
and render-session PostgreSQL repositories plus the private S3 store, initializes
the tenant, starts one render queue consumer and one explicit tenant GC worker,
and returns the adapter consumed by
`startProductionManimServer`.

Render sessions store immutable original/patched source receipts, a DB-clock
execution deadline, monotonically increasing lease fences, and an idempotent
Commit/Undo action ledger. The worker uses the stable `(tenantId, sessionId)` job
identity to submit or reattach through the concrete UDS sandbox executor. PostgreSQL rejects
stale lease publication, expires timed-out work even while the executor is
unavailable, and preserves terminal interrupted sessions for inspection. The
production readiness attestation is false unless the render repository and
executor both pass their probes. An injected or in-process host-spawn fallback
is not part of the production composition.

The migration and runtime database configurations are deliberately separate so
the runtime credential does not need DDL authority. Both require an explicit TCP
host and a TLS object with `rejectUnauthorized: true`; connection strings, Unix
sockets, custom streams, and custom `pg` clients are rejected by the production
factory because they can bypass inspectable transport settings.
All shipped SQL names the `public` schema explicitly, and owned pools force
`search_path=pg_catalog,public`; caller-supplied startup options are not accepted
by the production factory.

The source bucket must satisfy every readiness probe:

- versioning is enabled;
- the ACL grants only the bucket owner full control;
- no bucket policy exists, or S3 explicitly reports it as non-public;
- no lifecycle configuration exists; and
- a configured production endpoint is HTTPS and does not use path-style addressing.

Production S3 configuration must set `ignoreConfiguredEndpointUrls: true` so an
environment variable or shared AWS config cannot replace the inspected endpoint.
Custom request handlers, endpoint providers, URL parsers, TLS hooks, and dynamic
path-style providers are rejected. Each complete S3 operation, including streamed
body validation and bounded pagination, has a 30-second deadline.

Source writes use `If-None-Match: *` at the content-addressed key. An existing
object is read back and digest/size/UTF-8 checked, so normal duplicate writes reuse
one immutable version. Every published receipt fixes the key, version ID, ETag,
size, and SHA-256 digest, and every read revalidates all of them.

The GC worker probes PostgreSQL and bucket privacy before every sweep, runs one
bounded batch at a time, and schedules the next sweep only after the previous one
settles. Each sweep also has an explicit deployment-configured deadline. Its opaque
listing cursor advances across sweeps and wraps at the end, so retained published
versions at the front of a large bucket cannot starve later orphan cleanup. It
collects only S3 versions that were never published, such as uploads
left by a failed transaction or losing CAS. Deleted version receipts remain as
durable tombstones so a delayed publisher cannot resurrect a missing object.
Render sessions now retain explicit project/source references, so their original
and patched receipts cannot be collected while the session is retained. Terminal
session retention, reference detachment, and the DB-clock `orphaned_at` boundary
remain #144; object creation time is not a safe substitute for detachment time.

The composition intentionally does not publish browser video or thumbnail
assets yet. Isolated completion stores only a private opaque staging locator;
those delivery routes fail explicitly until #136 adds durable media
publication.
