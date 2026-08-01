import { manimTenantIdSchema } from "../manim-request-principal";

export const MAX_SNAPSHOT_ARTIFACT_BYTES_V1 = 16 * 1024 * 1024;
export const LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1 = "0".repeat(64);

const SNAPSHOT_SHA256_PATTERN_V1 = /^[0-9a-f]{64}$/;

export class SnapshotArtifactReadErrorV1 extends Error {
  readonly code: "corrupt" | "missing";

  constructor(code: "corrupt" | "missing") {
    super(code === "missing" ? "The snapshot artifact version is missing." : "The snapshot artifact is corrupt.");
    this.name = "SnapshotArtifactReadErrorV1";
    this.code = code;
  }
}

export type SnapshotArtifactIdentityV1 = Readonly<{
  profileDigest: string;
  resultDigest: string;
  runtimeConfigHash: string;
  runtimeDigest: string;
  sourceDigest: string;
}>;

function snapshotDigestV1(value: unknown, name: string) {
  if (typeof value !== "string" || !SNAPSHOT_SHA256_PATTERN_V1.test(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}

export function snapshotArtifactObjectKeyV1(tenantValue: string, identity: SnapshotArtifactIdentityV1) {
  const tenant = manimTenantIdSchema.safeParse(tenantValue);
  if (!tenant.success) throw new TypeError("Tenant ID is invalid.");
  const source = snapshotDigestV1(identity?.sourceDigest, "Snapshot source digest");
  const runtime = snapshotDigestV1(identity?.runtimeConfigHash, "Snapshot runtime-config hash");
  const profile = snapshotDigestV1(identity?.profileDigest, "Snapshot profile digest");
  const runtimeDigest = snapshotDigestV1(identity?.runtimeDigest, "Snapshot runtime digest");
  const result = snapshotDigestV1(identity?.resultDigest, "Snapshot result digest");
  if (runtimeDigest === LEGACY_SNAPSHOT_RUNTIME_DIGEST_V1) {
    return `tenants/${tenant.data}/snapshots/${source}/${runtime}/${profile}/${result}`;
  }
  return `tenants/${tenant.data}/snapshots/${source}/${runtime}/${profile}/${runtimeDigest}/${result}`;
}
