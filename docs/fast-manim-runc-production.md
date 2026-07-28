# Production rootless runc and rootfs runbook

Status: operator preparation and an opt-in real-host lane are documented;
production server enablement and host evidence are not complete

## Scope

`createFastManimRuncProductionCompositionV1` constructs the closed runc
backend from host-owned inputs. It does not build or mount a root filesystem,
sign a release, provision subordinate IDs or cgroups, or automatically select
the backend in the production HTTP server. The example below is an embedding
configuration shape, not an environment-only enablement recipe.

The existing OCI build attestation is unsigned (`sbom.signed` is `false`). A
separate Ed25519 release signature authorizes the exact OCI digest, runtime and
profile digests, and mounted rootfs digest. Neither the build attestation nor a
manually packaged rootfs is production evidence by itself.

## Host prerequisites

Use a dedicated, unprivileged Linux service identity on an amd64 host. The
service must have:

- cgroup v2 and an exclusively delegated, empty
  `poietra-sandbox-v1` subtree as described in the
  [resource and reap runbook](fast-manim-sandbox-resources.md);
- the fixed runtime at `/usr/bin/runc`;
- canonical, root-owned, executable, setuid `/usr/bin/newuidmap` and
  `/usr/bin/newgidmap`, with neither helper group- nor world-writable;
- `NoNewPrivs: 0` for the host Studio service so those helpers can establish
  the user namespace. The sandboxed process still receives
  `noNewPrivileges: true` in its OCI spec;
- subordinate UID and GID ranges assigned to the service identity in
  `/etc/subuid` and `/etc/subgid`.

Container ID 0 must map to the Studio process's own non-root UID/GID. Container
IDs 1 through 65532 must map to operator-assigned subordinate ranges. For a
service account with UID/GID 1001, one valid illustrative allocation is:

```text
# /etc/subuid
poietra:100000:65532

# /etc/subgid
poietra:200000:65532
```

The corresponding application mapping is shown below. The readiness probe
validates the helpers and requires every configured non-self mapping interval
to be covered by this service user's actual `/etc/subuid` and `/etc/subgid`
entries.

Prepare three distinct path classes:

- the bundle root is owned by the service UID/GID and is not group- or
  world-writable;
- the runc state root is owned by the service UID/GID and has mode `0700`;
- the rootfs image, mount point, and every ancestor up to `/` use canonical
  paths. Rootfs/image ancestors are root-owned directories and are not group-
  or world-writable.

The rootfs image itself must be a root-owned regular file, have one hard link,
have no write bits, be at most 8 GiB, and match its configured lowercase SHA-256
digest. Do not place bundle or state data below the read-only rootfs mount.

## Build, package, sign, and mount

First verify and build the locked OCI image. The build loads the image locally
and writes an unsigned build attestation:

```sh
pnpm verify:fast-manim-oci

node scripts/fast-manim-oci-build.mjs build \
  --source-repo /path/to/fast-manim \
  --attestation /release/fast-manim-oci-attestation.json
```

On an isolated, root-owned release builder, fetch a digest-qualified registry
reference with pinned `skopeo` and `--preserve-digests`. Verify the OCI index,
manifest, config, and every layer blob against the attestation before unpacking
with pinned `umoci` into a fresh `0700`, non-shared filesystem. Preserve numeric
ownership, modes, links, xattrs, and capabilities, then reject device nodes,
sockets, and FIFOs. Do not use `docker export`: it injects container-specific
files and does not provide the metadata/reproducibility contract required here.

This repository does not yet provide or test that OCI-to-rootfs exporter. After
an audited tool has produced `/release/root-tree`, build twice with identical
inputs and require byte-identical results:

```sh
# Example only: replace with the verified build epoch in whole seconds.
export SOURCE_DATE_EPOCH=1785200000
mksquashfs /release/root-tree /release/rootfs-a.squashfs \
  -noappend -comp zstd -reproducible -all-time "$SOURCE_DATE_EPOCH" \
  -root-time "$SOURCE_DATE_EPOCH" -no-exports -processors 1 -xattrs
mksquashfs /release/root-tree /release/rootfs-b.squashfs \
  -noappend -comp zstd -reproducible -all-time "$SOURCE_DATE_EPOCH" \
  -root-time "$SOURCE_DATE_EPOCH" -no-exports -processors 1 -xattrs
cmp /release/rootfs-a.squashfs /release/rootfs-b.squashfs
sha256sum /release/rootfs-a.squashfs
```

Record the `skopeo`, `umoci`, and `mksquashfs` package versions, binary hashes,
and options with the release. Treat the missing checked-in exporter and recorded
two-build evidence as a rollout blocker, not as behavior supplied by Studio.

Create a release payload with these exact correlations:

```json
{
  "expiresAt": 1785300000000,
  "imageDigest": "sha256:<attestation image digest>",
  "issuedAt": 1785200000000,
  "keyId": "fast-manim-release-2026-01",
  "profileDigest": "<attestation profile digest>",
  "rootfsDigest": "<bare lowercase SHA-256 of the rootfs artifact>",
  "runtimeDigest": "<attestation runtime digest>",
  "sbomDigest": "<attestation SBOM digest>",
  "schema": "poietra.fast-manim-runc-release",
  "seccompDigest": "<attestation seccomp digest>",
  "version": 1
}
```

Use the offline signer to construct and sign those canonical payload bytes:

```sh
node scripts/sign-fast-manim-runc-release.mjs \
  --attestation /release/fast-manim-oci-attestation.json \
  --rootfs-digest "$(sha256sum /release/rootfs-a.squashfs | cut -d' ' -f1)" \
  --issued-at 1785200000000 \
  --expires-at 1785300000000 \
  --key-id fast-manim-release-2026-01 \
  --private-key /offline-keys/fast-manim-release.pem \
  --output /release/fast-manim-signed-release.json
```

The signer revalidates the canonical attestation and its runtime digest,
requires owner-controlled stable input files and an Ed25519 private key, and
creates a new `0600` output without overwriting an existing release. The online
service receives only the public PEM and key ID; keep the private key and signer
on the isolated release builder, outside the Studio host.

Install and mount the finished artifact before starting Studio:

```sh
sudo install -o root -g root -m 0444 \
  /release/rootfs-a.squashfs \
  /srv/poietra/images/fast-manim-2026-07.squashfs

sudo mount -t squashfs -o loop,ro,nodev,nosuid \
  /srv/poietra/images/fast-manim-2026-07.squashfs \
  /srv/poietra/rootfs/fast-manim-2026-07
```

The service must see exactly that mount in its mount namespace. The verifier
requires a read-only loop device with zero offset and size limit, `nodev`,
`nosuid`, no nested mounts below the rootfs, a stable loop-device identity, and
an exact backing-file path. A bind mount of a mutable directory is rejected.
Use new release-addressed image and mount paths for a rollout; never overwrite
the backing file or reuse a mount point while a server may hold a rootfs lease.

## Composition example

The following shows the required relationships; load release materials from
operator-controlled files or a secret/configuration service, not from a tenant
request:

```ts
const backend = await createFastManimRuncProductionCompositionV1({
  attestation: readJson("/etc/poietra/fast-manim-build-attestation.json"),
  bundleRoot: "/srv/poietra/runc/bundles",
  cgroup: {
    root: "/sys/fs/cgroup/system.slice/poietra-studio.service/poietra-sandbox-v1",
  },
  identityMap: {
    allowedUidRanges: [
      { start: 1001, size: 1 },
      { start: 100000, size: 65532 },
    ],
    uidMappings: [
      { containerID: 0, hostID: 1001, size: 1 },
      { containerID: 1, hostID: 100000, size: 65532 },
    ],
    allowedGidRanges: [
      { start: 1001, size: 1 },
      { start: 200000, size: 65532 },
    ],
    gidMappings: [
      { containerID: 0, hostID: 1001, size: 1 },
      { containerID: 1, hostID: 200000, size: 65532 },
    ],
  },
  limits: DEFAULT_FAST_MANIM_SANDBOX_RESOURCE_LIMITS_V1,
  profile: readJson("sandbox/fast-manim-oci/profile.v1.json"),
  releasePublicKeys: [
    { keyId: "fast-manim-release-2026-01", publicKeyPem: releasePublicKeyPem },
  ],
  rootfs: {
    format: "squashfs",
    imagePath: "/srv/poietra/images/fast-manim-2026-07.squashfs",
    rootfsDigest,
    rootfsPath: "/srv/poietra/rootfs/fast-manim-2026-07",
  },
  runtimeStateRoot: "/run/poietra/runc-state",
  seccomp: readJson("sandbox/fast-manim-oci/seccomp.v1.json"),
  signedRelease: readJson("/etc/poietra/fast-manim-signed-release.json"),
  startupSignal,
});
```

Construction acquires the process-global cgroup controller. Keep one backend
per server process and call `backend.close()` during shutdown. A failed rootfs
verification, uncertain cleanup, expired release, or changed mount/image must
leave readiness closed; replace or reconcile the host before retrying.

## Conditional verification

The deterministic composition test does not execute runc or prove host
isolation:

```sh
pnpm exec vitest run server/fast-manim-runc-production-composition.test.ts
```

Run the existing real lanes on a disposable, appropriately delegated Linux
host:

```sh
POIETRA_FAST_MANIM_OCI_ATTESTATION=/release/fast-manim-oci-attestation.json \
pnpm test:fast-manim-oci:real

POIETRA_CGROUP_V2_CONFORMANCE_ROOT=/sys/fs/cgroup/<delegated-parent>/poietra-sandbox-v1 \
pnpm test:sandbox:cgroup
```

The first lane uses Docker and the second exercises the kernel cgroup fixture.
Run the production composition lane with an operator-owned JSON configuration:

```sh
POIETRA_FAST_MANIM_RUNC_REAL_CONFIG=/etc/poietra/runc-real-test.json \
pnpm test:fast-manim-runc:real
```

The JSON contains the composition fields `attestation`, `bundleRoot`, `cgroup`,
`identityMap`, `releasePublicKeys`, `rootfs`, `runtimeStateRoot`, and
`signedRelease`. The test supplies the repository-locked profile and seccomp,
starts one Circle snapshot through the production backend, and requires the
runc state, bundle, and cgroup directories to be empty afterward.

This lane is opt-in because it needs the real host preparation above. Passing
it proves the happy-path production composition, not the adversarial
multi-tenant coverage in #84 or rollout controls in #85. Keep the production
HTTP snapshot route disabled until those gates and recorded host evidence pass.
