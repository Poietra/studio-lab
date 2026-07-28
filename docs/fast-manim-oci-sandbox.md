# Fast-manim OCI sandbox profile

Status: local conformance implemented; production execution remains disabled

## Boundary and outcome

The v1 profile runs only:

```text
/opt/venv/bin/python -m manim.renderer.source_runtime_identity
```

The production-facing job descriptor contains the attested image, runtime,
profile, seccomp, and SBOM digests; bounded stdin request metadata; and sorted
digest-only asset metadata. It cannot represent argv, environment overrides,
generic mounts, a host path, a runtime socket, or tenant/source text. Descriptor
objects and arrays are server-owned and deeply frozen before broker dispatch.

Studio does not receive a Docker socket. Docker is used only by the explicit
local conformance adapter. A production broker must project an equivalent or
stronger read-only request asset volume and enforce the closed descriptor in a
separately scheduled runtime.

## Locked image build

The tracked build lock pins:

- the linux/amd64 platform and the multi-arch plus selected-platform digests of
  Python 3.12.11 and uv 0.9.26;
- one Debian snapshot and exact builder/runtime package versions;
- fast-manim commit `ac143dc46ebe314095ae7864a32efa289a0afe96`, its tree,
  deterministic archive, `uv.lock`, and `pyproject.toml` digests;
- every non-secret build-context file by SHA-256.

The private source archive is assembled in a new temporary context and is never
tracked. The build refuses a different commit/tree/archive, a dirty replacement
archive, symlinks, an existing output context, or missing source bytes. No source
credential is accepted as an option or copied into the image.

```sh
pnpm verify:fast-manim-oci

node scripts/fast-manim-oci-build.mjs build \
  --source-repo /path/to/fast-manim \
  --attestation /tmp/fast-manim-oci-attestation.json
```

Cold reproducibility builds disable every Docker build cache and directly
compare the installed native-artifact inventory, image manifest/config digests,
SBOM, runtime digest, and complete unsigned attestation:

```sh
node scripts/fast-manim-oci-build.mjs verify-reproducibility \
  --source-repo /path/to/fast-manim
```

The native compiler wrapper maps the actual isolated build directory to a fixed
logical path, preventing uv's random sdist directory from entering extension
modules or GNU build IDs.

## Runtime isolation

The main container uses UID/GID 65532, no supplementary groups or capabilities,
`no-new-privileges`, the locked seccomp allowlist, an isolated network, private
IPC/cgroup namespaces, a read-only root filesystem, and bounded tmpfs mounts for
request scratch data and shared memory. The fixed environment contains no
inherited server variables or credentials.

Assets use a request-scoped opaque volume name. A fixed installer from the same
attested image runs with UID 0 but no capabilities, no network, no-new-privileges,
the same seccomp profile, a read-only root, and exactly one writable volume. It
accepts only the server-generated canonical ustar stream, verifies the exact
manifest count/name/length/hash set and the 64-file/16 MiB logical caps, then
writes root-owned 0444 files beneath a root-owned 0555 directory. The installer
is removed before the main container is created. The main container receives
exactly that volume read-only and independently rejects missing, extra, linked,
mis-sized, mis-owned, or digest-mismatched files before target exec.

All Docker control calls have fixed deadlines and bounded stdout/stderr. Target
stdout is capped at the upstream 8 MiB canonical payload plus one CLI newline;
the embedded legacy Studio snapshot keeps its separate bounded contract. An
abort, timeout, output overflow, failed create/start, or rejected archive still
forces container/helper/volume cleanup. If absence cannot be proven, the run is
not reported as verified.

## Local conformance

The real lane requires Docker, a locally loaded attested image, and an explicit
attestation path:

```sh
POIETRA_FAST_MANIM_OCI_ATTESTATION=/tmp/fast-manim-oci-attestation.json \
pnpm test:fast-manim-oci:real
```

It exercises a Circle + Rectangle + Line scene, digest asset injection, the
combined snapshot/source-identity envelope, root/capability/network/syscall and
namespace attacks, read-only asset enforcement, output-overflow killing, and
cleanup evidence. Enabling the lane without Docker or the attestation is a hard
failure; otherwise the file is skipped.

The local adapter intentionally supports only Docker's containerd image store,
where create and container inspect preserve the attested manifest digest. A
classic store exposing only a config-digest lookup is rejected as unsupported;
the adapter never silently accepts either digest.

## Trust and remaining production gates

The embedded SBOM and build attestation are explicitly unsigned. Schema parsing
proves shape and digest correlation only; it does not confer trust or permit an
image to execute in production. Issue #85 must verify a signed statement and an
operator allowlist before constructing a production dispatch. Resource policy,
tenant artifact handling, rollout controls, monitoring, and incident response
remain tracked by #83-#85. Until those gates land, production stays fail-closed.
