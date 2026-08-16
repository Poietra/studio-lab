# ADR 0005: Name SaaS platform owners before adding native export storage

- Status: Accepted
- Date: 2026-08-16
- Decision owner: Poietra Studio
- Issue: #702
- Related: #116, #298, #305, #560, #659, #693, #695, #710, #711,
  #712, #713, #714, #715, #716

## Context

ADR 0004 assigned authentication, tenancy, billing, and object storage to a
single `SaaS platform` row because its subject was Scene editing. That shorthand
is no longer sufficient. Client-side export, native thumbnails, and revised
billing are about to add durable contracts. The current durable model was built
around imported Python source and server-side Manim render sessions, so copying
its names or foreign keys would make obsolete implementation details part of the
new product model.

The existing implementation remains valid for its current imported-Manim lane.
This ADR does not rename tables, JSON fields, routes, or TypeScript files. It
defines the names and ownership rules that new storage uses and separates later
migrations into independently reversible changes.

## Decision

### Bounded contexts

| Context | Owns | Does not own |
| --- | --- | --- |
| Identity and Access | User, Organization, Membership, Role, Account Session, authentication, and authorization | tenant-local project data, billing usage, Scene edits |
| Tenancy | The authorized resource-scope key called `tenantId` and assignment of that scope to a Tenant Cell | Organization membership policy, a project's contents |
| Work Catalog | Project identity and lifecycle, project listing, and the relationship to Editor Documents | Scene mutation semantics, UI launcher state, object bytes |
| Edit History | `EditorDocument`, accepted `SceneEdit` history, epoch, revision, and CAS rules from ADR 0004 | source execution, rendered artifacts, private browser state |
| Artifact and Provenance | Immutable object metadata and the exact input lineage from which an artifact was derived | making an artifact addressable to a consumer, quota policy |
| Distribution | Publication, current heads, authenticated read claims, expiry, and future share links | artifact production and content encoding |
| Metering and Entitlement | Plans, immutable entitlement grants, flow quotas, stock quotas, reservations, allocations, and usage records | Stripe transport, artifact bytes, render execution |
| Manim Integration | Python source, Runtime Trace, imported snapshots, source lowering, and optional sandbox execution | native document identity, general project or export vocabulary |
| Collaboration | Replication and admission around an `EditorDocument` | ownership of the document's edit invariants |

`Workspace` is a product view over Projects available to the current principal.
It is not a durable aggregate and must not be used as the new storage name for a
Project. Existing `workspace_*` tables and routes keep their names until a
separate compatibility migration.

ADR 0004's Studio/Scene terms keep their existing owners:

| ADR 0004 term | Relationship to this ADR |
| --- | --- |
| `EditorDocument` / `SceneEdit` | Edit History authority; SaaS storage authenticates and persists them but does not redefine edit semantics. |
| Scene IR / Scene Snapshot | Rust Scene core materialization; a snapshot can become artifact lineage but is not itself a Publication. |
| `EngineSessionV1` | Transient Rust runtime holder, never an account, render, or editor session. |
| `Command` / `Projection` | Application invocation and derived read model; neither becomes durable merely by crossing a SaaS adapter. |
| Motion Program | Reserved future authoring concept; it is not used as an artifact, publication, quota, or billing name. |

### Authority and aggregate map

| Concern | Authority or aggregate | Boundary rule |
| --- | --- | --- |
| Organization membership | Identity and Access | A successful membership admission produces one tenant-scoped principal. |
| tenant-scoped routing | Tenancy | The admitted principal supplies the tenant scope; only the server-owned assignment selects its Tenant Cell. URL, body, and unverified headers never select a cell. |
| Project identity and deletion | `Project` | Project deletion gates access but does not rewrite immutable artifact history. |
| accepted edit history | `EditorDocument` | Epoch and revision remain the persistent CAS boundary defined by ADR 0004. |
| materialized Scene and frame sampling | Rust Scene core | Scene revision hashes are runtime preconditions, not Editor revisions. |
| immutable bytes and lineage | Artifact and Provenance | Content identity and derivation are immutable after acceptance. |
| durable addressability | `Publication` | Publication points at one accepted artifact and one exact lineage. |
| flow consumption | `FlowReservation` followed by an immutable `FlowUsageEvent` | Rejection or cancellation before the operation-specific consumption point releases; after that point it commits even if output fails. |
| stored bytes/items | `StockAllocation` | Represents current retained quantity; logical unpublication or expiry releases it. It has no usage-period key. |
| imported source patch/undo | Frozen `RenderSession` today; `SourceCommitTransaction` only if the feature survives | Applies only to the imported-Manim lane and does not own rendering or artifact publication. |
| optional sandbox work | Frozen `RenderSession` today; a future `ExecutionJob` only for an approved consumer | Lease and fence belong to execution and nowhere else; no successor table is authorized now. |

The infrastructure object currently named a runtime cell is not a domain
aggregate. It is a tenant-fixed composition and routing boundary. Its domain-neutral
name is **Tenant Cell**.

### Representative flows used to derive the model

The decision was checked by tracing four current flows to persistence and then
projecting only their decided successor steps. The compact traces below name the
target ownership boundaries; they do not claim that every successor is already
implemented.

```text
Studio-native
  Project -> EditorDocument -> SceneEdit revision
          -> local WebCodecs export
          -> optional upload/admission -> artifact + lineage + publication -> read claim

Imported Manim
  source blob/head -> Scene snapshot publication -> EditorDocument overlay
                   -> optional SourceCommitTransaction or client export

Billing
  EntitlementSnapshot -> FlowGrant -> reserve -> commit/release/expire
                      `-> StockGrant -> allocate -> release

Collaboration
  AccountSession -> membership admission -> tenant principal
                 -> EditorDocument CAS -> private EditorSessionSnapshot
```

The current native flow still injects a starter `.py`, derives the document key
from its source path and Scene, and lowers edits back to Python for server render.
That is compatibility behavior to retire, not the native persistence model. The
imported flow intentionally remains source-bound. The billing trace confirms
that period consumption and retained bytes have different lifecycles. The
collaboration trace confirms that Account Session, Editor Document, and private
Editor Session Snapshot are three different owners.

### Organization and tenant are deliberately different words

`Organization` is the user-visible account and membership boundary. `tenantId` is
the server-owned key that scopes data and infrastructure after authorization.
They are one-to-one today, and their identifier bytes are equal, but they are not
interchangeable concepts.

The only permitted conversion from a user-requested Organization selector is:

```text
authenticated subject + requested Organization
                    |
            membership admission
                    v
       tenant-scoped branded principal
```

Downstream project, storage, billing, collaboration, and cell code consumes the
branded principal or its tenant key. It does not repeat membership checks or
accept an unverified organization header as a tenant selector. The billing
control plane has its own organization-header transport normalization, but then
calls the same production membership admission as the Node transport. This is
duplicated selector parsing, not a second authorization authority. It may be
consolidated behind the existing wire contract; no new admission abstraction is
required.

Server-owned background bindings are a separate case: Stripe webhooks may resolve
a tenant from a previously verified checkout/customer binding, and workers may
consume a persisted tenant assignment. They do not impersonate a user membership
flow and must never treat untrusted Organization headers or Stripe metadata as a
tenant authority.

### Project and Editor Document identity

`Project` is the Work Catalog aggregate. A Project may contain one or more Editor
Documents. `EditorDocument` remains the edit-history aggregate, but source binding
is an origin property rather than part of every document's identity.

The existing 32-byte `documentKey` is the document's opaque, immutable identity.
For a new native document the server generates 32 cryptographically random bytes
once and returns their lower-hex representation. It is not derived from a
filename, Scene name, source path, source digest, or mutable display name. The
legacy imported lane may keep its deterministic source-path/Scene derivation for
compatibility. Within one tenant the key is scoped by `projectId`.

Document origins form a closed union:

| Origin | Required binding | Forbidden binding |
| --- | --- | --- |
| `studio-native` | `documentKey`, project, epoch | Python source path and source digest |
| `imported-manim` | `documentKey`, project, epoch, source path, exact source digest | none of the imported fields may be inferred from a display label |

Existing `document_key`, `source_path`, and `source_hash` fields remain unchanged
until the document-origin migration. The migration adds an explicit origin and
makes source fields conditionally nullable; it does not add a second document-ID
column. New native code must not create another source-derived key shape.

The managed native starter `.py` file is a compatibility bootstrap, not the
native document's authority. It can be retired once all of these are true:

1. a Studio-native Project opens an Editor Document without a source path;
2. that document can reconstruct an exact native Scene revision without reading
   `workspace_source_heads`;
3. local client export uses that revision without a Python source request; and
4. imported source export remains available through the explicit Manim lane.

### Artifact lineage and publication

An **artifact** is immutable content plus storage metadata. A **lineage** states
which exact document and Scene inputs produced it. A **publication** makes one
artifact durably addressable. These are separate concepts even when one database
transaction inserts all three.

New Studio-native export and thumbnail artifacts use Editor Document lineage,
not a fabricated Python `source_digest`:

```text
Project
  `-- EditorDocument(documentKey, epoch, revision)
        `-- Scene materialization(sceneRevisionHash)
              `-- Artifact(contentDigest, kind, mediaType, byteSize)
                    `-- Publication(publicationId, expiry)
```

The first migration may keep artifact and lineage columns in the same narrowly
named table. A generic artifact framework is not required. The required logical
schema for a client export is:

```text
ExportArtifact
  tenantId
  artifactId
  kind = video
  mediaType = video/mp4
  contentDigest             exact uploaded bytes
  byteSize
  object locator metadata
  createdAt

ExportLineage
  tenantId
  artifactId
  projectId
  documentKey
  documentEpoch
  documentRevision          Editor event sequence number
  sceneContractVersion = 1  version of the Scene hash preimage
  sceneRevisionHash         canonical Scene IR materialization
  exportProfileHash         canonical export settings
  producerKind = browser-webcodecs
  encoderEvidenceVersion = 1
  encoderEvidence           bounded, versioned WebCodecs evidence

ExportPublication
  tenantId
  publicationId
  artifactId
  projectId
  createdBySubjectId
  publishedAt
  expiresAt
```

The first physical schema is deliberately narrow rather than a generic artifact
framework:

| Surface | Required constraints |
| --- | --- |
| `client_export_artifacts` | Primary key `(tenant_id, artifact_id)` and tenant foreign key; immutable private object key, `objectLocatorId`, ETag, exact `contentDigest`, and `byteSize`; unique exact locator; `video/mp4`; `1 <= byteSize <= 128 MiB`. |
| `client_export_publications` | Primary key `(tenant_id, publication_id)`; foreign keys to Project, Editor Document identity `(tenant, project, documentKey, epoch)`, artifact, and creating User; unique `(tenant_id, artifact_id)` so v1 is artifact-to-publication 1:1; the lineage fields above; encoder evidence is a JSON object no larger than 16 KiB; `expiresAt > publishedAt`. |
| `client_export_read_claims` | Tenant-scoped claim identity, artifact foreign key, and bounded expiry. Expiry GC queues physical deletion only when no live claim pins the artifact. |
| `client_export_deletions` | One queue/tombstone row per artifact, copying the exact object key, `objectLocatorId`, ETag, `contentDigest`, and `byteSize`; a worker deletes only that receipt and records acknowledgement without resurrecting a later object version. |

The initial publication table may contain its lineage columns directly. It does
not need a generic lineage table, mutable head, status ledger, or upload-session
aggregate.

Acceptance takes an authenticated finalize request plus either the bytes or a
server-verifiable receipt for the exact private object. It locks the Editor
Document row, verifies `0 <= documentRevision <= currentRevision` in the named
epoch, parses the MP4 and its versioned provenance, validates the bounded encoder
evidence, recomputes the content digest and byte size, and inserts artifact,
publication, flow settlement, and stock allocation atomically. A later direct-R2
transport may use a short-lived signed upload grant, but that grant is not a
Publication, lease, or durable domain aggregate. No placeholder
`runtime_digest`, `request_digest`, or Python source row is inserted.

The lineage row references the owning Editor Document identity and records the
exact revision. Admission validates that revision in the same transaction. It
does not require a foreign key directly to `editor_edit_events`: revision zero
is a valid untouched document state but has no event row. This preserves both
revision-zero export and referential ownership without inventing a synthetic
event.

`publicationId` alone is the idempotency identity for the initial publication
contract. A replay with the same complete immutable payload, including artifact
content digest, returns the existing success; the same ID with any differing
field returns 409. There is no export head yet, so this schema does not invent an
expected head generation. If #696 later needs a mutable “latest published
export” pointer, that feature may add a separately named head and its own
generation.

Replay detection runs before a new flow reservation is settled or a stock
allocation is inserted, so an accepted retry never consumes quota twice. The
1:1 artifact/publication rule also makes retained-byte ownership and expiry
unambiguous; #696 shares the existing Publication rather than cloning it.

Imported snapshot lineage stays source-bound and Manim-specific. Manim
Integration owns how that lineage is produced; Artifact and Provenance owns the
accepted `snapshot_artifact_objects`, while Distribution owns
`snapshot_publications` and `snapshot_scene_heads`. Their source-bound schemas
are not the template for native export publication.

An imported document exported through the new client path also uses its exact
Editor Document identity as the export lineage root. Its immutable document epoch
already carries the source path and source hash, so the export row does not copy a
second `source_digest`. Native/headless Rust output remains a conformance and
golden-test lane until it has a product producer; the first publication contract
does not add a speculative `rust-native` producer enum.

### Split the current render session responsibilities

The current `render_sessions` aggregate combines three independent lifecycles:

1. patch, commit, and undo of Python source;
2. sandbox execution with attempts, leases, cancellation, progress, and fences;
3. acceptance, publication, and delivery of media artifacts.

It remains a frozen compatibility aggregate for the imported server-render lane.
New Studio-native paths do not add states or nullable columns to it.

- If imported Python patch/commit/undo survives the legacy lane, its successor is
  `SourceCommitTransaction`: source-head CAS and idempotent apply/revert only.
  This ADR does not create that table.
- If a future product deliberately retains server execution, its owner is an
  `ExecutionJob`; lease, fence, broker assignment, progress, and cancellation
  belong there. Current Option A creates no such product aggregate or table.
- `ExportPublication` owns admission of an already produced client artifact and
  its durable publication. `publicationId` identifies the request and the full
  immutable payload determines replay equivalence. It uses no execution lease,
  fence, or nonexistent head generation.
- `ReadClaim` remains a short-lived pin that prevents collection while an
  authenticated reader streams immutable bytes. A read claim is not a lease.

### Flow quota and stock quota are separate models

Flow and stock answer different questions and must not share one state machine.

| Model | Question | Time model | Write model |
| --- | --- | --- | --- |
| `FlowQuota` | How many admitted operations may this tenant consume in this billing period? | bounded `usagePeriodKey` | reserve, then commit/release/expire |
| `StockQuota` | How many bytes or retained items does this tenant currently hold? | current quantity, no period | allocate exact quantity, then release on deletion/expiry |

The v14 `usage_reservations` and `usage_events` tables remain the legacy render
flow implementation. Billing v2 introduces a closed operation-kind set with at
least `ai-suggestion` and `export-publication`; local export without upload is
free and creates no usage record. A legacy `render` kind may remain while the
server-render lane exists.

An immutable entitlement snapshot owns normalized grants rather than one growing
JSON blob:

```text
EntitlementFlowGrant(tenantId, entitlementSnapshotId, entitlementGeneration,
                     operationKind, usagePeriodKey, unitLimit)
EntitlementStockGrant(tenantId, entitlementSnapshotId, entitlementGeneration,
                      resourceKind = published-artifact-bytes, quantityLimit)
```

The initial closed flow-operation set is `render` for legacy compatibility,
`ai-suggestion`, and `export-publication`. Each consumes one unit. The existing
reservation/event lifecycle is extended to those names, while the v15 trigger
continues to concern `render_sessions` only.

The billing migration first backfills a `render` flow grant from every v14
entitlement snapshot. Only then does it widen reservation/event operation-kind
checks. A reservation references the exact `(snapshot, entitlement generation,
operation kind, usage period)` grant, and quota counting partitions by tenant,
operation kind, and usage period. `export-publication` commits its reservation in
the same transaction that accepts the publication. `ai-suggestion` commits when
the provider request crosses the billable cost point, whether or not a useful
model response returns; rejection before that point and expiry release it.

Stock accounting uses only exact allocations tied to retained publications:

```text
StockAllocation(tenantId, resourceKind, publicationId,
                quantity, allocatedAt, releasedAt)
```

Publication acceptance knows the final byte size, locks the existing tenant
billing-account row, sums unreleased allocations for the resource kind, rejects
`allocated + byteSize > quantityLimit`, and inserts the artifact, lineage,
publication, and allocation atomically. There is no cached `usedQuantity`
projection until measured scale requires one. Expiry or logical unpublication
sets `releasedAt`; later physical R2 deletion acknowledgement is not customer
stock. Period rollover does not reset stock, and a downgrade below current stock
blocks new allocation without deleting customer data. No `usagePeriodKey` or
artificial terminal usage event is added to this model.

The v15 trigger directly coupling `render_sessions` to a `render` reservation is
left in the legacy lane. New operation kinds receive constraints local to their
own aggregate transactions rather than extending that trigger with unrelated
tables.

### Tenant Cell decision

The current runtime cell already owns mostly durable repositories, object-store
adapters, readers, publication ledgers, and GC workers. Execution is structurally
separable from that composition, although the current V1 production-readiness
contract still requires the external sandbox. Splitting readiness is follow-up
work, not a claim about current deployment. The cell's stable reason to exist is:

- bind an admitted tenant to a server-owned tenant-fixed composition;
- rotate or disable that assignment without trusting client input;
- keep a bounded cache of tenant-fixed compositions; and
- close old resources only after in-flight leases drain.

The current implementation does **not** establish a database, object-store, or
failure-isolation boundary per cell. Provisioning selects by `tenantId`; current
cell IDs and generations control composition lifecycle and cache identity, while
the configured database and object-store endpoints may still be shared. A future
deployment may assign isolated resources, but readiness must attest that fact
before code or documentation claims it.

The assignment control plane has its own database pool, while current tenant data
repositories receive the same configured pool settings and independently create
connections. That pool multiplicity is an implementation detail and possible
optimization debt. It is not a Tenant Cell invariant or evidence of per-tenant
isolation.

The internal target name is `TenantCell`. Existing `runtime_cell_*` tables,
types, health fields, and error strings remain compatibility surfaces until a
separate internal rename. `executionBoundary` is split from storage readiness in
that migration; a Tenant Cell can be ready for projects, documents, and artifacts
without claiming a Manim sandbox is ready.

`generation` on the assignment remains appropriate: it is the monotonic CAS
counter for one tenant's cell assignment. Cell assignment is infrastructure
state, not part of Project or Organization domain state.

### Naming rules

These rules apply to new persisted or wire domain names. Upstream proper nouns
such as Stripe Checkout Session, verbs such as thumbnail generation, and
process-local stale-request tokens are not renamed to imitate the domain rules.
Existing exceptions are classified below and remain compatible until their own
migration.

| Suffix or noun | Reserved meaning |
| --- | --- |
| `*Digest` | SHA-256 of exact bytes. The serialization or byte source must be named. |
| `*Hash` | Digest of a canonical or semantic identity. The canonicalization must be named. Exact content bytes use `*Digest`. |
| `*Generation` | Monotonic CAS counter within one explicitly named aggregate head. A random locator nonce is not a generation. |
| `*Revision` | Position in one append-only logical event sequence. |
| `*Epoch` | Identity of a sealed/reopened history for one aggregate. |
| `*Version` | Row or wire optimistic-concurrency/schema version, never a history position. |
| `canonical` | Qualifies the named representation being canonicalized; it never appears alone in a new persisted name. |
| `Session` | A bounded interaction or work lifecycle; the owner must be part of the full name. |
| `Snapshot` | An immutable complete capture of named state; the captured owner must be part of the full name. |
| `Publication` | Durable addressability of an accepted immutable artifact or state capture. Dev caches are not publications. |
| `Lease` | Time-bounded exclusive work ownership. |
| `Fence` | Monotonic token that rejects output from superseded work ownership. |
| `Claim` | Time-bounded read or retention pin; it does not grant write ownership. |

New names include their owner when the short noun would be ambiguous, such as
`AccountSession`, `EditorSessionSnapshot`, `SceneSnapshotPublication`,
`EntitlementGrant`, and `TenantCellAssignmentGeneration`.

### API and compatibility policy

The `/api/manim/*` prefix is a legacy compatibility surface. New general Project,
Editor Document, artifact, export-publication, thumbnail, account, and
collaboration routes use neutral nouns. Runtime Trace, Python source export, and
Manim import/execution remain under the Manim integration namespace.

The later route migration adds neutral routes first, points both route families
at one handler, moves shipped clients, and removes aliases only in a versioned
cutover. This ADR does not add aliases or change any current request bytes.

## Current-name inventory and disposition

The tables below classify the production meanings rather than treating every
textual match in a test or comment as a separate domain concept. Layer `a` means
decision-only, `b` means new contracts use the decided name, and `c` means an
existing compatibility surface needs its own migration.

### `session`

| Current name | Actual meaning | Owner | Layer |
| --- | --- | --- | --- |
| `AccountSession`, `account_sessions`, session cookie | Login credential carrying the subject and active Organization | Identity and Access | a; keep the qualified name |
| `EditorSessionSnapshot`, `editor_session_snapshots` | Private `(document, subject)` editor-state checkpoint | Edit History | a/b; always qualify with `Editor` |
| browser `EditorSessionStore` and pending journal | Local cache and outbox for private editor state | Studio presentation | a; not a SaaS aggregate |
| `RenderSession`, `render_sessions` | Fused source patch, execution, artifact, and billing workflow | imported-Manim compatibility | a freeze; c retire after replacements |
| `EditorCollaborationSessionAuthorization` | Authorization view derived from an Account Session | Collaboration | a; not a new session aggregate |
| `verifiedSourceDurationBasis.sessionKey` | Wire-frozen per-Scene UI storage identity | Studio presentation | a; not an interaction session |
| Stripe Checkout/Portal Session | Upstream Stripe resource | Billing integration | a; retain the proper noun |
| render-trace session evidence | Runtime-object correlation inside a versioned Manim contract | Manim Integration | a; preserve contract bytes |
| `EngineSessionV1` | In-process owner of canonical Scene runtime state | Rust Scene core | a; ADR 0004 scope |
| PostgreSQL `idle_in_transaction_session_timeout` | Connection configuration | Infrastructure | a; outside domain vocabulary |

Evidence: migrations 0012, 0023, and 0002;
`account-session-authenticator.ts`, `editor-session-store.ts`,
`editor-collaboration-authorization-repository.ts`, `stripe-gateway.ts`, and
`fast-manim-snapshot-contract.ts`.

### `publication`

| Current name | Actual meaning | Owner | Layer |
| --- | --- | --- | --- |
| `SnapshotPublicationV1`, `snapshot_publications` | Durable addressability of an immutable imported Scene snapshot | Distribution | a/b; correct qualified use |
| `FastManimSnapshotPublicationStore` | Process-local LRU preview cache | Dev preview | a define as cache; c rename |
| `VerifiedArtifactPublisherV1` | Operation that verifies staged media and makes it durably readable | Distribution | a/b; correct operation name |
| `serverPublicationRevision`, durable `run.revision` | Preview freshness token derived from different counters | Preview adapter | a wire compatibility; c remove the semantic mismatch |
| “terminal ledger publication” | Comment describing a source-action ledger update | imported source mutation | a; not a separate aggregate |

Evidence: migration 0003; `fast-manim-snapshot-publication.ts`,
`verified-artifact-publisher.ts`, `preview-snapshot-provider.ts`,
`durable-fast-manim-snapshot-service.ts`, and
`manim-render-mutation-transaction.ts`.

### `snapshot`

| Current name | Actual meaning | Owner | Layer |
| --- | --- | --- | --- |
| `FastManimSnapshot*`, Scene snapshot | Sealed Scene IR bundle observed from execution | Manim Integration | a/b; call it a Scene Snapshot |
| `snapshot_artifact_objects` | Immutable object-storage form of that Scene Snapshot | Artifact and Provenance | a/b; qualified use |
| `SnapshotPublication*` | Distribution record/head for that object | Distribution | classified with publication |
| `EntitlementSnapshot`, `entitlement_snapshots` | Append-only capture of applied billing grants | Metering and Entitlement | a/b; always qualify |
| `EditorSessionSnapshot` | Subject-private working-state capture | Edit History | classified with session |
| `ManimSourceSnapshot`, `ImportedSourceSnapshot` | Stable source bytes or one static import result | Manim Integration | a; qualified local value |
| `presence-snapshot` | Complete room presence message | Collaboration protocol | a; protocol-specific name |
| authority/gesture/resize/canvas invalidation snapshots | In-memory point-in-time values | Presentation and adapters | a; outside SaaS ubiquitous language |

`Snapshot` therefore means an immutable point-in-time capture of a named owner;
it is not reserved to one global aggregate. Evidence includes migrations 0003,
0014, and 0023 plus `fast-manim-snapshot-contract.ts`, `manim-source-store.ts`,
`editor-live-contract.ts`, and the Studio gesture/canvas stores.

### `generation`

| Current name | Actual meaning | Owner | Layer |
| --- | --- | --- | --- |
| source-head `generation`, `originalGeneration`, publication `sourceGeneration` | Source-head CAS generation and pins to it | Work Catalog / Manim Integration | a/b; `SourceGeneration` |
| snapshot publication/head `generation` | Current-publication CAS generation for one imported Scene | Distribution | a/b; qualify it |
| `project_png_generations`, `projectPngGeneration` | Project-image head CAS generation | Artifact and Provenance | a; #695 must use a qualified new name |
| entitlement `appliedGeneration` and `sourceGeneration` | Applied entitlement stream generation | Metering and Entitlement | a; b use `EntitlementGeneration`; c rename misleading field |
| Stripe observation/reconcile generations | Ordered Stripe observation and reconciliation counters | Billing integration | a; already qualified |
| editor `session_generation` | Independent private-session CAS generation | Edit History | a/b; `EditorSessionGeneration` |
| runtime-cell assignment `generation` | Tenant assignment projection/ledger CAS generation | Tenancy infrastructure | a/b; `TenantCellAssignmentGeneration` |
| `objectGeneration` | Random UUID immutable-object locator nonce, not monotonic | Object Storage | a exception; b never repeat; c rename |
| request/render/update generation | Process-local latest-only stale-completion token | UI and adapters | a; outside persisted/wire rule |
| suggestion/thumbnail/token “generation” | The act of generating output | AI and adapters | a; a verb, not a counter |

Evidence: migrations 0001, 0003, 0005, 0014, 0016, 0020, 0023, and
0029; `immutable-object-contract.ts` proves that `objectGeneration` is a random
UUID locator.

### `revision`

| Current name | Actual meaning | Owner | Layer |
| --- | --- | --- | --- |
| Editor Document/event `revision`, `base_revision`, `document_revision` | Append-only edit-event position within an epoch | Edit History | a/b; canonical use |
| local FastManim `revision` | Process-global preview-cache sequence | Dev preview | a compatibility; c rename or retire |
| durable FastManim `run.revision` | Numeric view of a per-Scene publication generation | Distribution adapter | a wire compatibility; b do not repeat; c align semantics |
| `revisionHash`, `engineRevisionHash`, canvas worker `revision` | Scene-content digest and correlation key | Scene evaluation | a; ADR 0004 scope |
| `workingRevision` | Digest-like identity of serialized working edits | Studio authoring | a; ADR 0004 follow-up, not a SaaS counter |
| `statusRevision` and similar | React refresh counter | Presentation | a; outside domain vocabulary |

The local and durable meanings of FastManim `run.revision` are intentionally
documented as incompatible semantics behind one compatibility field. New APIs do
not copy it. Evidence includes migrations 0017, 0018, and 0023 plus
`fast-manim-snapshot-publication.ts`, `durable-fast-manim-snapshot-service.ts`,
`scene-ir.ts`, and `editor-revision-policy.ts`.

### Compound-name collisions

Two existing `sourceGeneration` names pin unrelated aggregate counters:

| Current name | Actual meaning | New-surface rule |
| --- | --- | --- |
| snapshot-publication `sourceGeneration` | Workspace source-head generation observed before imported Scene execution | Keep as the qualified source-head pin. |
| entitlement `sourceGeneration` | Billing account's applied-entitlement generation | New billing schemas use `entitlementGeneration`. |

Two existing `canonicalDigest` names also digest different serializations:

| Current name | Exact byte source | New-surface rule |
| --- | --- | --- |
| edit-event `canonicalDigest` | Canonically serialized Scene Edit program | Use `sceneEditDigest`. |
| billing-subscription `canonicalDigest` | Canonically serialized Stripe subscription state | Use `subscriptionStateDigest`. |

Both digest fields are valid content evidence. The defect is omitting the noun
that identifies the serialization; existing fields remain wire-compatible.

### Digest and hash inventory

The table groups aliases and database projections that share one preimage. It
excludes local comparison variables and non-cryptographic UI cache keys.

| Current persisted or wire family | Owner and preimage | Disposition |
| --- | --- | --- |
| `sourceHash` / `source_hash` and qualified variants; `sourceDigest` / `source_digest`; `original_digest`; `patched_digest` | Manim Integration / Work Catalog; exact Python source UTF-8 bytes | a keep; b use `sourceDigest`, `originalSourceDigest`, and other owner-qualified digest names for new exact-byte fields |
| `artifactDigest`, `resultDigest`, storage `contentDigest`, `project_png_digest` | Artifact and Provenance; exact PNG, MP4, snapshot, or object bytes | a keep; b prefer the artifact-kind noun or `contentDigest` over generic “result” |
| `snapshotDigest`, `session_snapshot_digest`, `producerDocumentDigest`, `requestDigest`, `payloadDigest` | Edit History, Manim Integration, Execution, or Billing transport; exact serialized snapshot/document/request/payload bytes | a keep; b fully qualify the owner, such as `editorSessionSnapshotDigest` or `stripeEventPayloadDigest` |
| edit-event and billing-subscription `canonicalDigest` | Edit History / Metering; canonical Scene Edit JSON bytes versus canonical Stripe subscription-state bytes | a compatibility; b use `sceneEditDigest` and `subscriptionStateDigest` |
| `runtimeConfigHash`, `snapshotHash`, `revisionHash`, `engineRevisionHash`, `sceneRevisionHash`, `policyHash`; existing `traceDigest` | Rust Scene core / Manim Integration; canonical runtime, Scene, revision, policy, or selected Runtime Trace identity | a keep; b new semantic trace identity uses `runtimeTraceHash` rather than another digest |
| asset `manifestDigest`, MathTex `contentDigest`, `toolchainDigest`, `fontDigest`, `selectionDigest` | Rust Scene/Rendering core; a mixture of canonical asset/MathTex/toolchain/selection identities and exact font-set bytes | a compatibility; b use semantic `assetManifestHash`, `mathTexInputHash`, `mathTexToolchainHash`, `profileSelectionHash`, and exact `mathTexFontSetDigest` |
| `profileDigest`, `runtimeDigest`, `attestationDigest`, `fenceDigest`, `executionDigest`, `stagingRootDigest`, `seccompDigest`, OCI `imageDigest` | Manim Integration / sandbox infrastructure; mostly canonical semantic descriptors; OCI image digest is an upstream exact content address | a keep; b new semantic names use `sandboxProfileHash`, `sandboxRuntimeHash`, `sandboxAttestationHash`, `cancellationFenceHash`, `renderExecutionHash`, `stagingRootHash`, and `seccompProfileHash`; keep upstream `imageDigest` |
| `sessionTokenHash`, `stateHash`, `browserBindingHash`, `tokenDigest`, `invitationTokenDigest` | Identity and Access; one-way lookup key over exact random token bytes | a keep; b use qualified exact-byte names such as `accountSessionTokenDigest`, `oidcStateDigest`, `browserBindingTokenDigest`, and `invitationTokenDigest` |

The identical SHA-256 primitive does not make these fields interchangeable.
New foreign keys, CAS, idempotency, and authorization checks compare different
families only when the owning contract explicitly defines the same preimage; a
matching 64-hex shape alone grants no equivalence.

## Migration boundaries

This ADR authorizes no mass rename. Follow-up work is split by compatibility and
aggregate boundary:

1. #710: native Editor Document identity and explicit origin;
2. #693: Studio-native artifact lineage and export publication;
3. #693: billing v2 flow grants, the entitlement-generation rename, and stock
   allocations;
4. #711: runtime-cell to Tenant Cell internal vocabulary and readiness split;
5. #712: neutral tenant API routes with legacy aliases;
6. #713: shared Organization-selector transport normalization for the existing
   single membership-admission path;
7. #714: process-local preview-cache publication/revision vocabulary;
8. #715: immutable-object locator UUID vocabulary; and
9. #716: legacy Render Session freeze, imported source-transaction decision,
   drain, and retirement.

#693 owns removing native export/publication and billing-v2 responsibilities
from `render_sessions`; it does not invent source-transaction or execution
successors. #716 owns the later legacy-lane decision and drain. #695 consumes the
same native artifact-lineage decision for thumbnails but does not own that
schema.

Each migration preserves existing bytes until its own versioned cutover. File
renames may accompany the owning migration but are not acceptance criteria by
themselves.

## Consequences

- Studio-native persistence and export no longer require a fabricated `.py`
  source row.
- Imported Manim workflows keep their exact source lineage and can be retired or
  retained independently.
- Local client export is not metered merely because the old product charged a
  render job.
- Published-byte limits cannot silently reset at a billing-period boundary.
- Tenant Cell routing remains useful after server-side rendering is removed.
- Existing migrations, routes, and wire payloads remain byte-for-byte unchanged
  in this decision PR.
- New concepts are limited to boundaries with immediate consumers. This ADR does
  not add a port hierarchy, repository factory, command bus, common module, or
  framework.

## Rejected alternatives

### Rename tenant to Organization everywhere

Rejected because authorization and resource scoping are different concerns even
while their identifiers are one-to-one. It would also spread membership language
through every storage key.

### Keep Python source as the native lineage root

Rejected because a generated starter file is not the authority for native edits
or client export. It creates false foreign-key evidence instead of provenance.

### Add a second native `documentId` and hash it into `documentKey`

Rejected because the existing 32-byte `documentKey` already is the opaque
document identity. Generating that key randomly for native documents gives the
required source-independent identity without storing two identifiers for one
concept.

### Anchor export lineage directly to the last edit-event row

Rejected because a document at revision zero is valid but has no edit-event row,
and a materialized revision represents the fold of an event prefix rather than
one last event. The publication transaction instead locks the Editor Document,
checks that the recorded revision exists in its epoch, and retains the document
identity as the referential anchor.

### Extend `render_sessions` for client export

Rejected because client export has no sandbox execution, lease, fence, patch, or
undo lifecycle. More nullable states would preserve the existing fusion.

### Put storage bytes in `usage_reservations`

Rejected because a period reservation models flow. Retained bytes are stock and
must survive period rollover until deletion or expiry.

### Cache a tenant's stock total before scale requires it

Rejected because a mutable `bytes_used` projection duplicates the allocation
ledger and introduces reconciliation work immediately. Admission initially sums
unreleased allocations under the existing tenant billing lock; a measured
performance limit can justify a transactional projection later.

### Define Tenant Cell by pool or failure isolation

Rejected because the current composition reuses configured database and object
store endpoints and does not prove those isolation properties. Tenant-fixed
routing, bounded lifecycle, rotation, and drain are the current guarantees;
deployment-specific isolation requires separate readiness evidence.

### Make SaaS platform one new framework package

Rejected because the contexts above already have concrete implementations and
different change reasons. The decision is about owners and contract names, not a
new dependency layer.
