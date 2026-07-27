# Fast-manim sandbox backend boundary

Status: contract implemented; local rootful OCI conformance slice available; production backend unavailable

## Safety outcome

`FastManimSnapshotRunner` no longer starts a host child process. It passes a
copy-on-read immutable byte bundle to one `FastManimSandboxBackendV1` job handle.
The bundle is canonical JSON for the bounded producer-request v1 schema and is
bound to a SHA-256 digest. It contains verified source text, logical relative
source identity, Scene name, runtime configuration, and their correlation
digests. It never contains the host project root, inherited server environment,
credentials, HOME, temp path, or socket path.

The lifecycle context is out of band from those bytes and carries only bounded
opaque tenant, project, and request IDs, the request deadline, the expected
attestation digest, and an abort signal. Health/attestation reads receive the
same opaque identity plus their own short deadline and abort signal. The runner
calls the job handle's abort operation for request cancellation and server
shutdown.

The runner does not trust a backend merely because it advertises deadline and
abort capabilities. It creates an epoch deadline for the backend plus an
independent monotonic deadline for every status read and job result. The
monotonic deadline is checked both by a timer and again when the foreign promise
settles, so an event-loop delay cannot turn a late fulfillment or rejection into
an accepted result. Settlement priority is caller/server-shutdown abort, then
deadline, then backend outcome. The runner propagates cancellation through
derived signals and gives terminal reporting/cleanup only a bounded grace after
the execution deadline. A result delivered during that grace is observed only
for settlement and cleanup; both late success and late failure remain a
server-owned timeout.
A status or job that still does not settle is retained as outstanding work and
quarantines that backend: no new job is started. Shutdown also bounds
`backend.close()`; a backend that reports successful close while tracked work
remains is rejected. Browser responses and logs receive only fixed server-owned
failure messages/event metadata.

The synchronous portions of `status()`, `start()`, the job handle's `abort()`,
and `close()` are control-plane operations and must return without blocking;
remote work belongs to native promises. Studio observes those promises through
captured Promise intrinsics into server-owned settlement records. It reads a job
handle's `abort` and `result` properties once and never calls a backend-owned
`.then` method. Non-native promises and malformed handles terminally quarantine
the backend.

JavaScript timers cannot preempt a same-thread adapter that blocks
synchronously. The settlement recheck rejects an operation after such a block,
but cannot make the blocked interval disappear. A production adapter must not
perform IPC, process waits, or cleanup synchronously in any lifecycle method.
Actual isolation and independent scheduling that enforce this requirement are
part of #82; the in-process contract alone is not that isolation boundary.

Every backend is untrusted for output correctness. Before publication, Studio
requires the backend result to repeat the exact request and attestation digests,
reads the actual `%TypedArray%` byte length through captured intrinsics, enforces
the byte cap before allocation, and copies accepted fixed-buffer `Uint8Array`
bytes with the intrinsic `set` operation into server-owned memory. It does not
consult a backend byte view's own `byteLength`, iterator, or species. Proxy,
shared, resizable, detached, or otherwise uncopyable views fail closed. Studio
then checks the backend
attestation again after execution, parses the copy through the existing bounded
snapshot contract, correlates it with server-held source and runtime state,
normalizes diagnostics, and applies the server-owned seal.

## Modes and fail-closed rules

- No backend is the default. Snapshot execution returns the bounded
  `sandbox-unavailable` fallback and does not read or execute workspace Python.
- An embedding that omits its deployment is treated as `production`. Vite's
  development server passes `development` explicitly, and tests pass `test`
  explicitly; omission can never enable the local adapter.
- `LocalProcessFastManimSandboxBackendV1` is a development/test compatibility
  adapter. Its status is permanently marked `development-only`; production
  readiness rejects it even if its command is configured.
- The local adapter is created only when
  `POIETRA_FAST_MANIM_SNAPSHOT_DEV_OPT_IN=1` and
  `POIETRA_FAST_MANIM_SNAPSHOT_COMMAND` is explicit. Setting that opt-in in a
  production Vite mode is a startup configuration error.
- A production adapter must report ready health, all required lifecycle
  capabilities, a production backend kind, and a current verified attestation.
  Studio must also have an independently configured attestation verifier; a
  backend cannot make itself trusted by setting the wire `trust` field alone.
  Missing, malformed, expired, future-issued, capability-incomplete, or changed
  attestation data fails closed before publication.
- Verified attestation times use exactly the canonical 24-byte millisecond UTC
  form (`YYYY-MM-DDTHH:mm:ss.sssZ`). Every variable status field and the
  canonical status object have explicit UTF-8 byte caps. A production adapter
  must additionally cap its raw status response at
  `MAX_FAST_MANIM_SANDBOX_STATUS_RAW_JSON_BYTES` before `JSON.parse`; the
  canonical post-parse cap is not a substitute for a wire-response limit.

For local exporter development only:

```sh
POIETRA_FAST_MANIM_SNAPSHOT_DEV_OPT_IN=1 \
POIETRA_FAST_MANIM_SNAPSHOT_COMMAND='["/path/to/python","-m","manim.renderer.scene_snapshot"]' \
pnpm dev:web
```

This is not a production enablement recipe. The child-process adapter filters
environment and uses a private runtime directory, but it is not an OS isolation
boundary and cannot contain every fork/setsid escape.

Embedding/tests may explicitly supply extra `producerEnv` entries to the local
adapter for a trusted developer runtime. Those values are never serialized into
the immutable request or copied to structured logs, but they do enter the local
child environment and therefore must not be treated as a credential transport.
`HOME`, `TEMP`, `TMP`, and `TMPDIR` are rejected as reserved, and
`PYTHONHASHSEED` remains pinned; the private per-job directory always wins.

## Rootful gated OCI conformance slice

`FastManimLocalGatedOciBackendV1` is a separate, opt-in development evidence
driver. It is not connected to the Studio server composition, reports
`development-only` attestation with a `local-process` backend kind, and its
factory returns an unavailable backend for every production deployment.

Build the immutable local image from the pinned fast-manim commit already
present in a local checkout:

```sh
POIETRA_FAST_MANIM_SOURCE_REPO=/path/to/fast-manim \
pnpm sandbox:oci:gated:build
```

The build is network-independent (`--pull=false`), verifies the source commit,
tree, archive SHA-256, lockfile and project metadata, pins the base image by
digest, and prints the resulting immutable image ID. The real conformance lane
is explicit:

```sh
POIETRA_FAST_MANIM_GATED_OCI_IMAGE=sha256:<local-image-id> \
pnpm exec vitest run server/fast-manim-local-gated-oci-backend.test.ts
```

The local driver creates one non-restarting container per request with no
mounts, no network, a read-only root filesystem, all capabilities dropped,
`no-new-privileges`, private PID/cgroup namespaces, a private 16 MiB tmpfs,
fixed CPU/memory/pid/fd/core limits, and Docker logging disabled. A trusted PID
1 entrypoint checks the effective runtime confinement before emitting READY.
Studio then inspects the actual container configuration, PID, cgroup v2 files,
and `/proc/<pid>/limits` before releasing a length- and SHA-256-bound request.
The request becomes sealed memfd stdin for the fixed producer. Result and
diagnostic streams are independently capped; accepted result bytes must be one
LF-terminated, canonical UTF-8, compact and recursively key-sorted JSON object.
Every path force-removes the container and verifies that its original PID is no
longer in that cgroup.

This slice deliberately does **not** claim #82 complete. It uses the host's
rootful Docker daemon and an operator-supplied local image ID; it has no
separate broker identity or Unix-socket protocol, rootless host configuration,
custom seccomp profile, signed image allowlist/attestation, production adapter,
asset transport, or cross-tenant adversarial evidence. The static fast-manim
snapshot profile also refuses reflective host APIs before Scene execution; the
OCI boundary remains defense in depth, not permission to broaden that source
profile. #83 must prove resource ownership and descendant lifecycle against
the eventual broker/runtime instead of treating this development driver as
production isolation.

## Production enablement dependencies

Production remains disabled until all of the following provide conformance
evidence through this interface:

1. #82: digest-pinned rootless OCI/microVM isolation and machine-readable
   profile/runtime attestation;
2. #83: hard CPU, memory, pid, fd, disk/output limits and whole-job descendant
   reaping;
3. #84: tenant-owned artifacts plus adversarial isolation and leak tests;
4. #85: attestation verification, rollout gate, kill switches, monitoring, and
   incident response.

The Studio server must not expose snapshot execution to untrusted traffic merely
because a local producer command succeeds.

The existing relative `sourcePath` remains producer correlation identity in
request v1; it is not a host path. Changing output/source identity or the Studio
hit-test contract remains #91 and is intentionally outside this boundary.

## Operator fail-closed procedure

Until #85 supplies the production control plane, the safe incident action is to
remove the local development opt-in (or leave the production backend
unconfigured) and restart the Studio service. New snapshot jobs then return
`sandbox-unavailable`; runner shutdown aborts active job handles and, provided
the adapter obeys the non-blocking synchronous contract, waits only through its
server-owned cleanup bound. A timeout, quarantined backend, close
failure, or tracked operation remaining after close is an isolation incident:
keep execution disabled and replace/restart the adapter before accepting new
jobs. Preserve only bounded server-owned event names and reason codes. Never
copy raw backend health text, stderr, traceback, source text, environment, or
host paths into browser responses or structured logs.
