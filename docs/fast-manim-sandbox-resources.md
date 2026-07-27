# Fast-manim sandbox resource and reap runbook

Status: outer resource controller implemented; production composition remains gated by #82, #84, and #85

## Security outcome

`FastManimSandboxResourceRegistryV1` is the process-global admission ledger and
`LinuxCgroupV2ResourceControllerV1` owns one Linux cgroup v2 directory per job.
Admission reserves active-job, memory-plus-swap, output, and tmpfs budgets
atomically. A job succeeds only after the controller has issued `cgroup.kill`,
observed `cgroup.events` report `populated 0`, closed all bounded output
producers, removed the job cgroup, and released the reservation. Leader exit is
only a cleanup trigger; it is never proof that a forked or daemonized descendant
has stopped.

Cleanup uncertainty is fail-closed. A failed kill, counter read, output close,
empty proof, or cgroup removal quarantines the registry and retains the
reservation. New work remains disabled until the server and its exclusively
delegated subtree are reconciled by a clean restart. Browser responses and
structured metrics use only bounded server-owned reason codes. Job and cgroup
names contain a random server boot ID plus a monotonic sequence; tenant IDs,
source, host paths, commands, and raw stderr are not accepted.

## Production preconditions

The filesystem controller accepts exactly one canonical, exclusively delegated
cgroup v2 domain subtree named `poietra-sandbox-v1`. The production factory
further requires it to be below `/sys/fs/cgroup`; for example:

```text
/sys/fs/cgroup/system.slice/poietra-studio.service/poietra-sandbox-v1
```

Before Studio starts accepting work, an operator or service manager must ensure:

- the host uses unified cgroup v2 and the configured path resolves to itself,
  rather than through a symlink;
- the `poietra-sandbox-v1` root is a `domain` cgroup, its `cgroup.procs` is
  empty, and it is used by no other application;
- `cpu`, `memory`, and `pids` are delegated to the Studio service, and Studio
  can update `cgroup.subtree_control`, create/remove child cgroups, write
  `cgroup.kill`, and read the controller event files;
- the Studio server remains in the parent service cgroup, never in the empty
  delegated root;
- the OCI orchestrator starts the trusted wrapper directly in the exact relative
  `job.launch.cgroupsPath` before any untrusted Python runs. Moving an already
  running untrusted PID into the cgroup is not a production launch path;
- the orchestrator applies the returned CPU/file/fd rlimits and the exact
  runtime/shared-memory tmpfs byte and inode caps. The outer envelope may not be
  looser than the immutable #82 OCI profile;
- stdout, stderr, and result writers install the exact descriptor caps before
  admission and can return server-owned proof that all three writers are closed.

A systemd unit should use cgroup delegation for the service (at minimum CPU,
memory, and pids) and create the named empty child beneath the service cgroup.
Do not point this controller at `/sys/fs/cgroup`, a service cgroup containing the
Studio process, a tenant-selected path, or a shared subtree. The controller
rejects these layouts or fails startup reconciliation.

`createProcessLinuxCgroupV2ResourceControllerV1` is the production constructor.
It accepts only the delegated root and bounded timing values, derives the
orchestrator-relative path, and uses the one process-global registry. The lower
level class accepts fake stores and clocks for deterministic tests; production
composition must not expose those injection points.

## Enforced lifecycle

Startup first validates the root, enables all required controllers, and lists
its children. Only server-generated job names are eligible for reconciliation.
Every eligible orphan is killed, proven empty, and removed before admission is
opened; an unknown directory quarantines startup without killing it.

For each admitted job the controller writes `memory.oom.group`, `memory.max`,
`memory.swap.max`, `pids.max`, and `cpu.max`, records baseline CPU/OOM/pids
counters, and starts its own watchdog. The watchdog uses a monotonic deadline
for wall time and control-operation bounds even if the epoch clock moves
backwards. It also stops the job on cumulative CPU time, memory/OOM events, and
pids events without relying on caller polling. File size and open-file limits,
tmpfs capacity, and bounded output are enforced by the launch/output envelope
and mapped to the same closed reason vocabulary.

Abort, deadline, output overflow, launch failure, and shutdown all enter one
idempotent termination path. `cgroup.kill` is deliberately first so it reaches
forked, setsid, daemonized, and inherited-pipe descendants. One absolute cleanup
deadline covers kill, output close, the `populated 0` wait, and removal.

## Evidence split

The default fake-controller tests prove contract and orchestration properties:

- strict safe-integer schemas and atomic process-global admission;
- memory-plus-swap/output/tmpfs reservation accounting;
- startup orphan reconciliation and unknown-child fail-closed behavior;
- exact cgroup writes, baseline deltas, automatic watchdog behavior, and
  monotonic deadlines;
- shutdown joining pending and active jobs;
- no reservation release before both cgroup-empty and output-closed evidence;
- bounded cleanup timeout, quarantine, production-factory closure, and exact
  relative `cgroupsPath` correlation.

They do not prove kernel enforcement. The opt-in real-kernel lane keeps an
explicit adversarial matrix for memory, cumulative CPU, pids/fork flood, fd,
file size, tmpfs bytes, tmpfs inodes, stdout, stderr, and result floods. It also
covers a setsid daemon holding inherited pipes, caller abort, and controller
shutdown. The trusted local wrapper self-stops before it is attached; production
still must use direct-in-cgroup OCI launch.

## Running the real-kernel lane

Run the test inside a Linux service/session that owns a correctly delegated,
empty root. Set only the host-side test environment variable below:

```sh
POIETRA_CGROUP_V2_CONFORMANCE_ROOT=/sys/fs/cgroup/<delegated-parent>/poietra-sandbox-v1 \
pnpm test:sandbox:cgroup
```

The test process itself must run inside the delegated parent's cgroup (for
example, a delegated systemd service or scope); an unrelated shell cannot move
its wrapper across a cgroup delegation boundary.

The probe requires the same `/sys/fs/cgroup/.../poietra-sandbox-v1` production
shape, canonical realpath, cgroup v2 domain, empty root, delegated controllers,
writable control files, `prlimit`, and a user/mount namespace capable of mounting
bounded tmpfs. It never returns or prints the configured path. When the host
cannot supply the lane, Vitest explicitly skips every real-kernel case using one
of these bounded codes:

```text
linux-required
cgroup-root-not-configured
cgroup-root-invalid
not-cgroup-v2
cgroup-root-not-exclusive
cgroup-runner-outside-delegation
cgroup-controllers-unavailable
cgroup-delegation-not-writable
local-tools-unavailable
mount-namespace-unavailable
```

Two unskipped gate tests still verify the bounded skip contract and the complete
fixture matrix. A skipped local run is not production evidence; capture a passing
run from a delegated Linux host before changing the production gate.

The harness reports stderr only as a bounded byte count and SHA-256 digest. Do
not add commands, raw stderr, source, tenant data, or host paths to test names,
metrics, browser errors, or production logs.

## Coordination

#82 owns the immutable OCI image and isolation profile; this module owns the
outer resource envelope and descendant lifecycle. The #82 adapter must consume
`job.launch` without weakening its caps. #84 owns tenant artifact isolation and
cross-tenant adversarial evidence. #85 owns rollout, monitoring, kill switches,
and incident response, so this controller alone does not enable production
snapshot execution.

The current result cap follows the snapshot contract on this branch. #91 is
merged after #83 and must rebase the resource/output reservation tests when it
raises the combined result limit to 8 MiB plus its framing byte.
