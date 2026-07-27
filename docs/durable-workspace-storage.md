# Durable workspace/source storage

Status: production composition available for the workspace/source slice; durable snapshots and render sessions remain #134 and #135.

The built `manim-production-server.mjs` entry exports
`createDurablePostgresS3ProductionRuntimeV1`. The factory applies the embedded,
checksummed migration with a one-connection DDL pool, creates the bounded runtime
PostgreSQL pool and private S3 store, initializes the tenant, starts one explicit
tenant GC worker, and returns the adapter consumed by
`startProductionManimServer`.

The migration and runtime database configurations are deliberately separate so
the runtime credential does not need DDL authority. Both require an explicit TCP
host and a TLS object with `rejectUnauthorized: true`; connection strings, Unix
sockets, custom streams, and custom `pg` clients are rejected by the production
factory because they can bypass inspectable transport settings.

The source bucket must satisfy every readiness probe:

- versioning is enabled;
- the ACL grants only the bucket owner full control;
- no bucket policy exists, or S3 explicitly reports it as non-public;
- no lifecycle configuration exists; and
- a configured production endpoint is HTTPS and does not use path-style addressing.

Source writes use `If-None-Match: *` at the content-addressed key. An existing
object is read back and digest/size/UTF-8 checked, so normal duplicate writes reuse
one immutable version. Every published receipt fixes the key, version ID, ETag,
size, and SHA-256 digest, and every read revalidates all of them.

The GC worker probes PostgreSQL and bucket privacy before every sweep, runs one
bounded batch at a time, and schedules the next sweep only after the previous one
settles. It collects only S3 versions that were never published, such as uploads
left by a failed transaction or losing CAS. Deleted version receipts remain as
durable tombstones so a delayed publisher cannot resurrect a missing object.
Previously published blobs are retained until #135 supplies history/reference
semantics and an `orphaned_at` retention boundary; object creation time is not a
safe substitute for detachment time.

The composition remains intentionally unable to render or publish Scene snapshots.
Those routes fail explicitly until #134/#135 connect durable publications,
sessions, leases, and the external sandbox executor.
