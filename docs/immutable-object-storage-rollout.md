# Immutable object storage rollout

This runbook covers the rolling move from provider-generated S3 `VersionId`
locators to application-owned immutable generation keys. It applies to source
blobs, project `image.png`, snapshots, videos, and thumbnails.

## Invariants

- A published database row contains exactly one locator: legacy `version_id`
  or immutable `object_generation`.
- An immutable key ends in `/g/<object_generation>` and is created only with
  `If-None-Match: *`. A collision is retried with a new generation; the
  collided key is never adopted or read as the candidate upload.
- PostgreSQL is the publication and deletion authority. Provider listing is
  used only for bounded orphan reconciliation.
- Existing locator rows are never inferred, rewritten, or copied by the
  migration. A reader must reject a malformed, mixed, or unsupported locator.

## Provider preparation

Create a private R2 bucket and an API token scoped to that bucket's object
read/write operations. Do not enable an `r2.dev` URL or a public custom domain.
Studio does not use bucket versioning, ACL, bucket policy, lifecycle, or public
object URLs.

Set the deployment provider to `cloudflare-r2` with the account ID, bucket,
access key ID, secret access key, and optional jurisdiction. Before routing
traffic, run:

```sh
POIETRA_R2_ACCOUNT_ID=... \
POIETRA_R2_BUCKET=... \
POIETRA_R2_ACCESS_KEY_ID=... \
POIETRA_R2_SECRET_ACCESS_KEY=... \
pnpm test:storage:r2:required
```

The required lane fails when credentials are absent and exercises authenticated
conditional PUT, exact HEAD, full GET, Range GET, bounded listing, and exact-key
delete through the production R2 configuration. The same command also runs a
one-shot store-level shadow probe: it uploads source, PNG, snapshot, video, and
thumbnail fixtures through the shipped immutable adapters, exact-reads and
compares every payload, compares a nontrivial video Range, and then deletes and
proves the absence of every generated key. The probe uses a unique tenant prefix
and sweeps that prefix during bounded failure cleanup.

The shadow probe never publishes a PostgreSQL row, reads or writes the legacy
lane, or installs a runtime dual-write path. Its receipts exist only for the
duration of the command. Repeat this one-shot command externally for the chosen
observation window and record every result; do not treat one successful run as
the cutover decision. Bucket privacy remains an IaC and Cloudflare control-plane
invariant; the S3-compatible data API cannot prove that `r2.dev` and
custom-domain publication are disabled.

## Deployment sequence

1. Record the current migration version, database backup, object-store target,
   and the row count of all nine locator-bearing object/deletion tables.
2. Stop migration concurrency and apply migration v20 with the bounded
   migration credential. It takes `ACCESS EXCLUSIVE` locks on all nine tables
   and replaces the project-PNG primary key, so schedule a maintenance window
   proportional to the existing `project_png_objects` table. The configured
   lock and statement timeout is the hard stop; do not remove it to force the
   migration through.
3. Deploy dual-locator repositories while keeping new writes on the legacy
   store. Confirm every replica reports the exact v20 checksum and can read the
   existing legacy rows. Old writers remain schema-compatible during this
   expand phase.
4. Drain every pre-v20 reader before enabling any immutable database write. An
   old reader treats nullable `version_id` as impossible and must never observe
   an immutable row.
5. In shadow mode, upload a fresh immutable generation, exact-read and compare
   its bytes and identity, then discard or queue that unpublished object. Keep
   the legacy receipt authoritative. Require zero mismatches for source, PNG,
   snapshot, video, thumbnail, and authenticated Range reads over the chosen
   observation window.
6. Enable immutable publication for a canary tenant. Confirm that publication,
   render-session input pinning, read claims, and DB tombstones all retain the
   exact `object_generation`. Do not start immutable deletion workers yet.
7. Expand immutable publication to all tenants, then enable DB-first deletion
   workers. ListObjectsV2 reconciliation must remain page-bounded and may only
   queue unpublished candidates after the configured grace period.
8. After the retention window and parity review, remove legacy writes. Keep
   legacy reads and deletion handling until no legacy object or tombstone rows
   remain.

## Render-media tombstone v21 boundary

Migration v21 additively gives `render_artifact_deletions` a nullable
`deleted_at` acknowledgement marker and a partial pending-queue index. Existing
deletion rows remain pending after the migration. The v21 repository retains an
acknowledged row permanently, excludes it from later physical-delete scans, and
rejects any delayed publication of that exact locator.

The schema change is compatible with pre-v21 inserts, but the old media GC is
not behaviorally compatible: its acknowledgement deletes the tombstone. Drain
and stop every pre-v21 media GC replica before applying v21, then deploy only
replicas whose render-artifact readiness requires the exact v21 checksum. Do
not enable immutable media writes or resume media GC until that probe is green
on every replica. A pre-v21 acknowledger must never run after this boundary.

## Rollback boundaries

- Before step 4, roll back the application and leave v20 installed. Existing
  rows are unchanged and old writers remain compatible with the expanded
  schema.
- During shadow mode, disable shadow uploads and delete only their exact
  unpublished generation keys. No publication row changes are required.
- After the first immutable row is published, never roll back to a pre-v20
  reader. Roll back only to the last dual-locator build, disable new immutable
  writes, and keep immutable reads and tombstone processing available.
- Never convert an immutable locator into a guessed legacy provider version, or
  replace a content digest's chosen generation in place. Repair requires an
  explicitly verified new publication transaction.

For every rollback, stop GC first, retain deletion tombstones, and verify one
source, PNG, snapshot, full video, video Range, and thumbnail read before
restoring normal traffic.
