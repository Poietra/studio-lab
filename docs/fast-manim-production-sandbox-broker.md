# Production Fast Manim sandbox broker

Status: broker infrastructure slice. The signed rootless backend, standalone
broker, and independently verified Studio client factory are implemented here.
The durable Studio runtime does not import that client yet: snapshot routes
still return `503` until #134 connects durable source/publication storage. This
slice does not close #127.

Build the standalone broker with:

```sh
pnpm build:sandbox-broker
```

The output is `dist-sandbox-broker/fast-manim-sandbox-broker.mjs`. It accepts
exactly one absolute JSON config path. The config file and every parent must be
root-owned and non-writable; the file itself must be read-only. Configuration
is not read from environment variables.

The JSON fields are `brokerUserId`, `dockerSocketPath`, `publicKeys`,
`seccompPath`, `signedRelease`, `socketGroupId`, and `socketPath`. The signed
Ed25519 release binds the immutable image ID, Docker server version, fixed OCI
profile digest, custom seccomp digest, validity interval, and signing key ID.
The fixed profile now includes exact image labels for the hermetic MathTex
provider: pinned Studio engine commit/tree/archive, native artifact SHA-256,
ABI version, `linux-amd64` target, font and compiler-toolchain digests, and the
third-party-notice digest. The expected label set is part of the canonical
profile whose digest the release signs alongside the immutable image ID. A
runtime label mismatch is rejected; changing an expected provenance value
requires a new profile digest and signed release. Image inspection must match
the complete label set before readiness and again before dispatch.

The service must run as the configured dedicated non-root broker user. Its
rootless Docker socket must be owned by that user with mode `0600` in a private
directory. Install `sandbox/fast-manim-gated-oci/seccomp.v1.json` under a
root-owned, non-writable directory with a read-only mode. The direct parent of
the Studio-facing socket must be owned by `brokerUserId:socketGroupId` with
exact mode `0750`; every ancestor must be canonical, root/broker-owned and
non-writable. A root-owned sticky ancestor such as `/tmp` is the sole writable
exception. The socket is `brokerUserId:socketGroupId` mode `0660`. Studio must
run under a different effective UID that belongs to `socketGroupId`; it never
receives access to the Docker socket.

At startup, the broker verifies the release signature. Before listener
readiness and before every dispatch, it rechecks:

- release validity through the verified release capability;
- rootless Linux Docker, cgroup v2, and the systemd cgroup driver;
- Docker server version and immutable image labels;
- Docker socket ownership and path ancestry;
- root-owned seccomp path ancestry and canonical document digest.

SIGINT and SIGTERM perform bounded broker cleanup. An internal listener or job
cleanup failure closes the listener and makes the standalone process exit
non-zero so its supervisor can restart or quarantine it. There is no rootful
or default-Docker-socket fallback. Production client and broker cleanup use the
same fixed 30-second bound, longer than the normal OCI kill/remove/proof budget.
Production fixes descendant `cgroup.kill` enforcement to `required`.

The optional real integration lane requires
`POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET`,
`POIETRA_FAST_MANIM_PRODUCTION_IMAGE`,
`POIETRA_FAST_MANIM_PRODUCTION_SECCOMP`, and
`POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION`.
Run it only after the following order is complete:

1. build the pinned `linux/amd64` snapshot image with
   `pnpm sandbox:oci:gated:build` and retain the emitted immutable digest;
2. run the rootful development conformance against that digest when local
   build evidence is required;
3. make the exact image digest available to the dedicated rootless Docker
   daemon, install the canonical seccomp file under a root-owned non-writable
   path, and obtain that daemon's exact server version;
4. pass those four explicit values to the fail-required production lane:

```sh
POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET=/run/user/<broker-uid>/docker.sock \
POIETRA_FAST_MANIM_PRODUCTION_IMAGE=sha256:<64-hex-image-id> \
POIETRA_FAST_MANIM_PRODUCTION_SECCOMP=/absolute/root-owned/seccomp.v1.json \
POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION=<exact-server-version> \
pnpm test:snapshot-sandbox:production:required
```

The build helper currently invokes the Docker CLI's default daemon and does not
select the production socket. When build and broker daemons differ, load or pull
the exact emitted image into the rootless daemon before step 4; do not substitute
a rebuilt mutable tag.

The required lane creates a short-lived signed release for the supplied image
and fixed profile, executes the existing V1 supported Scene, verifies a real
V3 `MathTex("E = mc^2")` snapshot through a separate client/runner, checks the
V1 unsupported result, and then requires bounded cleanup of both clients and
the broker. Missing or malformed inputs fail the required command rather than
silently skipping it.

Because that lane starts broker and client in one process, it deliberately uses
the generic UDS transport. It proves broker/runtime behavior, not the required
cross-UID Studio principal boundary; deterministic unit tests cover the latter.
It also cannot run against an ordinary rootful `/var/run/docker.sock`: the
executing principal must be non-root, the rootless socket must be owned by that
principal with mode `0600` in a private directory, and Docker must report Linux,
cgroup v2, the systemd cgroup driver, `name=rootless`, and usable
`cgroup.kill`. The seccomp file must be root-owned and non-writable through its
ancestor chain. A normal developer Docker installation or GitHub-hosted runner
does not satisfy this production-host evidence contract; use the rootful lane
for local image conformance and a dedicated rootless host for this required
lane.
