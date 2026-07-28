# Production Fast Manim sandbox broker

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

The service must run as the configured dedicated non-root broker user. Its
rootless Docker socket must be owned by that user with mode `0600` in a private
directory. Install `sandbox/fast-manim-gated-oci/seccomp.v1.json` under a
root-owned, non-writable directory with a read-only mode. The Studio-facing
broker socket is group-owned with mode `0660`; Studio never receives access to
the Docker socket.

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
or default-Docker-socket fallback.

The optional real integration lane requires
`POIETRA_FAST_MANIM_PRODUCTION_DOCKER_SOCKET`,
`POIETRA_FAST_MANIM_PRODUCTION_IMAGE`,
`POIETRA_FAST_MANIM_PRODUCTION_SECCOMP`, and
`POIETRA_FAST_MANIM_PRODUCTION_DOCKER_VERSION`.
