import { inspectProjectPngBytesV1 } from "./storage/project-png-storage";

const MAX_PNG_VERSION_TOKEN_UTF8_BYTES_V1 = 2_048;

export type FastManimSnapshotPngCandidateV1 = Readonly<{
  bytes: Uint8Array;
  versionToken: string;
}>;

export type FastManimSnapshotPngReadV1 = Readonly<{
  byteSize: number;
  bytes: Uint8Array;
  digest: string;
  height: number;
  versionToken: string;
  width: number;
}>;

export interface FastManimSnapshotPngProviderV1 {
  readVerified(signal?: AbortSignal): Promise<FastManimSnapshotPngCandidateV1>;
}

/** Revalidates provider bytes locally and owns the exact immutable run input. */
export async function readFastManimSnapshotPngV1(
  provider: FastManimSnapshotPngProviderV1,
  signal?: AbortSignal,
): Promise<FastManimSnapshotPngReadV1> {
  signal?.throwIfAborted();
  const candidate = await provider.readVerified(signal);
  signal?.throwIfAborted();
  if (
    typeof candidate.versionToken !== "string" ||
    candidate.versionToken.length < 1 ||
    Buffer.byteLength(candidate.versionToken, "utf8") > MAX_PNG_VERSION_TOKEN_UTF8_BYTES_V1
  ) {
    throw new TypeError("The verified project image.png version token is invalid.");
  }
  const inspected = inspectProjectPngBytesV1(candidate.bytes);
  return { ...inspected, versionToken: candidate.versionToken };
}

export function sameFastManimSnapshotPngReadV1(left: FastManimSnapshotPngReadV1, right: FastManimSnapshotPngReadV1) {
  return (
    left.versionToken === right.versionToken &&
    left.byteSize === right.byteSize &&
    left.digest === right.digest &&
    left.height === right.height &&
    left.width === right.width
  );
}
