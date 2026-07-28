# Production Manim render sandbox

The production durable render worker executes source-only Manim scenes through a
separately supervised Unix-domain-socket broker. Studio never receives a Docker
socket and the broker accepts only sealed, fixed-profile requests. The shipped
profile renders 854×480 media at 15 fps and supports MP4 video and PNG thumbnail
jobs. A stable `(tenantId, sessionId, mediaKind)` identity makes submit,
reattach, and cancellation idempotent across lease-fence changes.

The broker runs as a distinct non-root user with rootless Docker, systemd cgroup
v2, the repository's immutable seccomp profile, no network, no capabilities, a
read-only root filesystem, and bounded CPU, memory, PIDs, files, and tmpfs. The
production service requires `cgroup.kill`; `best-effort` cgroup cleanup exists
only for local real-OCI conformance on hosts that cannot expose that control.

Untrusted source and rendered bytes stay inside container tmpfs until the fixed
PID 1 has killed and reaped every descendant. PID 1 then publishes correlated
terminal metadata and enters an image-owned process state. The broker verifies
that state and an exact one-process cgroup before and after each export. It uses
only `/bin/cat` with one fixed image path to stream media into a broker-owned
exclusive file descriptor. Both stdout and stderr are bounded, deadlines and
abort signals kill and reap the Docker CLI child, and the host validates media
size, signature, and SHA-256 through one `O_NOFOLLOW` descriptor. Raw media
never crosses the Studio UDS protocol. This stream is intentional: Docker's
`container cp` cannot read container tmpfs on supported containerd image-store
configurations.

`pnpm build:render-sandbox-broker` builds the standalone broker entry. It takes
one absolute path to an immutable, root-owned JSON configuration containing the
broker UID, Studio socket GID, rootless Docker socket, pinned image digest,
seccomp path, private staging root, and UDS path. `pnpm
sandbox:oci:render:build` builds the pinned image when
`POIETRA_FAST_MANIM_SOURCE_REPO` points at the exact Fast Manim checkout. The
opt-in real lane uses `POIETRA_MANIM_RENDER_GATED_OCI_IMAGE=<sha256:image-id>`
and proves multi-animation MP4/PNG output, hostile early output replacement,
refenced reattachment, active cancellation, and cleanup.

This first slice deliberately accepts no project asset bundle and mounts no host
project directory. Digest-bounded asset ingestion is follow-up work. Completed
media remains in private broker staging and the render session stores only an
opaque locator; durable S3 video/thumbnail publication and delivery URLs remain
Issue #136. Until then the production API can retain an isolated render result
but does not expose a final `videoUrl` or durable thumbnail.
