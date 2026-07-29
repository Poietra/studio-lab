# Production Manim render sandbox

The production durable render worker executes Manim scenes and their optional,
session-pinned `image.png` through a separately supervised Unix-domain-socket
broker. Studio never receives a Docker socket and the broker accepts only sealed,
fixed-profile requests. The shipped
profile renders 854×480 media at 15 fps and supports MP4 video and PNG thumbnail
jobs from the canonical 8×(128/9) scene frame. Custom frames fail closed until
the trusted renderer can apply them explicitly. The descriptor version is bound
to both the profile digest and an inspected image label, so mixed rollouts fail
readiness before admission. A stable
`(tenantId, sessionId, mediaKind)` identity makes submit,
reattach, and cancellation idempotent across lease-fence changes.

The broker runs as a distinct non-root user with rootless Docker, systemd cgroup
v2, the repository's immutable seccomp profile, no network, no capabilities, a
read-only root filesystem, and bounded CPU, memory, PIDs, files, and tmpfs. The
profile allows one aggregate CPU and 30,000,000 microseconds of cumulative
`cpu.stat usage_usec` per video or thumbnail job. The broker samples that fresh
job cgroup while waiting and once more after freezing it before publication, so
forked or detached descendants share the same budget and a threshold race cannot
publish media. Missing or malformed kernel counters fail closed. The
production service requires `cgroup.kill`; `best-effort` cgroup cleanup exists
only for local real-OCI conformance on hosts that cannot expose that control.

Untrusted source, the fixed PNG asset, and rendered bytes stay inside container
tmpfs. The sealed request binds the PNG bytes, length, dimensions, MIME, logical
path, and SHA-256 to the request digest. PID 1 independently decodes and
validates the bounded static PNG before creating only
`/run/poietra/tmp/image.png`; no host project mount or object-storage credential
enters the container. Before it spawns the same-UID Scene process, fixed PID 1
makes itself non-dumpable. It
then kills and reaps every descendant before using image-owned PyAV/Pillow code
to fully decode and validate the fixed stream count, codec, pixel format,
dimensions, frame rate, duration, or PNG dimensions. PID 1 then publishes correlated
terminal metadata and enters an image-owned process state. The broker verifies
that state and an exact one-process cgroup before and after each export. It uses
only `/bin/cat` with one fixed image path to stream media into a broker-owned
exclusive file descriptor. Scene stdin/stdout/stderr are fixed to `/dev/null`
and the container log driver is `none`, so untrusted output is never retained.
The gate attach accepts exactly one fixed readiness marker; any other control
output remains a sticky `result-rejected` failure after cleanup. Artifact export
stdout is byte-capped, stderr must stay empty, deadlines and abort signals kill
and reap the Docker CLI child, and the host independently validates media size,
signature, and SHA-256 through a separately reopened `O_NOFOLLOW` descriptor
under the pinned private staging-root identity. Raw media
never crosses the Studio UDS protocol. The broker reports a digest of the
canonical staging root, and Studio refuses readiness unless it exactly matches
the root configured for trusted publication. This stream is intentional: Docker's
`container cp` cannot read container tmpfs on supported containerd image-store
configurations.

`pnpm build:render-sandbox-broker` builds the standalone broker entry. It takes
one absolute path to an immutable, root-owned JSON configuration containing a
deployment-unique `brokerShardId`, the broker UID, Studio socket GID, rootless
Docker socket, pinned image digest, seccomp path, private staging root, and UDS path. `pnpm
sandbox:oci:render:build` builds the pinned image when
`POIETRA_FAST_MANIM_SOURCE_REPO` points at the exact Fast Manim checkout. The
opt-in real lane uses `POIETRA_MANIM_RENDER_GATED_OCI_IMAGE=<sha256:image-id>`.
Run the fail-required local lane with an image built from the current checkout:

```sh
POIETRA_MANIM_RENDER_GATED_OCI_IMAGE=sha256:<64-hex-image-id> \
  pnpm test:render-sandbox:oci:required
```

Unlike the generic test suite, this command fails when the immutable image is
missing or malformed. To collect production-host evidence, also set both
`POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET` and
`POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION`; requesting only one is an error.
When `POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET` and the matching
`POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION` are also set, that same lane
requires a rootless/systemd/cgroup-v2 host and `cgroup.kill` cleanup;
without them it remains an explicitly local `best-effort` conformance run.
This direct-runner lane is evidence for the required cleanup policy; broker
identity, UDS permissions, and signed release admission remain covered by the
production service boundary and its own deployment checks.
At startup the broker first acquires a host-kernel singleton keyed by the
staging-root digest, then its socket lease. Only while holding both does it
remove prior containers in that owner namespace, including one with a future
deadline, and let the durable worker resubmit it; another staging root on the
same Docker daemon is never reconciled. Broker processes that share a host must
therefore share its network namespace so the abstract-socket ownership lease is
effective. Private staging pins its directory identity,
checks trusted ancestors, reserves worst-case bytes for active jobs, enforces
count and byte caps, and schedules expiry from each artifact deadline. In
production the root is owned by `broker:Studio-group` with mode `0750`, and
published media files are broker-owned with mode `0640`; Studio has read but not
write authority. The real lane proves multi-animation MP4/PNG output, semantic
rejection of forged MP4, denial of Scene access to `/proc/1/mem`, hostile early
output replacement, fenced reattachment, owner-isolated concurrent brokers,
restart cleanup, active cancellation, exact descriptor/file/tmpfs byte and inode
limits, cumulative CPU exhaustion across `fork`/`setsid` descendants, successful
Manim-leader exit with a detached `setsid` pipe holder, and cleanup.

Each broker has an explicit deployment-unique `brokerShardId` in its immutable,
root-owned configuration. Status and cancellation acknowledgements carry that
identity, and Studio rejects an old or mismatched broker before admission. The
first PostgreSQL lease claim permanently binds a render job to one shard;
recovery workers can only reclaim unowned jobs or jobs already bound to their
own shard.

User cancellation is registered as a durable PostgreSQL intent before any API
success is returned. A credentialed relay for the owner shard aborts local
worker I/O, asks its credential-free UDS broker to persist the job-wide fence,
verifies the correlated `{brokerShardId, fenceDigest}` acknowledgement, and
atomically records that acknowledgement while changing the session to
`cancelled`. API replicas wait for that durable result, so a request received on
another shard cannot acknowledge cancellation early. Pending intents block
lease completion, artifact publication, and late video or thumbnail admission;
delivery leases make replay idempotent across API, relay, worker, and broker
restart. Intent capacity and expiry match the broker's global/per-tenant caps
and immutable render deadline plus cleanup grace, without evicting a live
cancellation. Normal publication cleanup remains a separate non-fencing
operation, and PostgreSQL/S3 credentials never enter the broker.

Migration v7 intentionally refuses to install while a legacy `rendering` row
has no broker shard. Drain those rows before applying it. Once installed, the
database rejects shardless legacy claims and unsafe legacy terminal transitions,
so a mixed rollout fails closed until every worker uses owner-shard delivery.

Migration v9 and the CPU-budget profile require an atomic, drained rollout;
they are deliberately not rolling-compatible with v8 readers. An old API or
worker does not recognize a persisted `cpu-limit` row and will reject it rather
than silently reinterpret it. Stop new admission, let every active lease,
broker job, and cancellation complete, then stop all old API and worker
processes. Apply migration v9 only after that drain, and start only the new API,
worker, relay, and broker generation. Never overlap v8 readers with a v9 writer.
Resume admission only after the new generation passes readiness.

Before upgrading from a build that predates owner-scoped container names and
labels, stop every old broker and drain its `poietra-render-<staging-id>`
containers. The new broker deliberately refuses to claim or delete those
unattributed containers; only containers bearing its exact staging-owner digest
are eligible for automatic reconciliation.

A render-profile digest change also requires a drained broker rollout. Stop new
admission, wait for active sessions and cancellation-fence deadlines to expire,
stop the old broker, empty its staged media root, and then start the new broker.
An old-profile manifest is deliberately not reinterpreted by a new broker.

This slice deliberately accepts only the single validated `image.png` generation
already pinned atomically with the source in PostgreSQL. Generic project asset
bundles remain follow-up work, and no host project directory is mounted.
Completed staging locators are consumed only by the trusted Studio
publisher: it verifies broker ownership, mode, inode stability, locator
correlation, size, signature, and digest; uploads the exact video and thumbnail
versions to private S3; and atomically commits both receipts in PostgreSQL under
the current render lease fence. Only then does the durable session expose its
`videoUrl` and the project expose its durable thumbnail. Authenticated video
HEAD/range streams hold renewable PostgreSQL read claims, and expiry plus the
artifact GC remove logical visibility before version-pinned physical deletion.

The real storage lane can be combined with
`POIETRA_MANIM_RENDER_GATED_OCI_IMAGE=<sha256:image-id>` to exercise the complete
fixed-image render → broker staging → trusted publisher → MinIO/PostgreSQL → HTTP
HEAD/range path. It also proves that process loss after publication does not
lose either artifact. Required rootless `cgroup.kill` deployment evidence
remains separate Issue #117 acceptance work.
