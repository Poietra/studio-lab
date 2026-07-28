import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  digestFastManimOciProfileV1,
  FAST_MANIM_OCI_ASSET_CONTROL_FILE_V1,
  FAST_MANIM_OCI_ASSET_MANIFEST_SCHEMA_V1,
  type FastManimOciBrokerAssetCopyV1,
  FastManimOciBrokerDispatchV1,
  fastManimOciBuildAttestationV1Schema,
  fastManimOciJobDescriptorV1Schema,
  fastManimOciProfileV1Schema,
} from "./fast-manim-oci-sandbox-profile";

const SECCOMP_PATH = fileURLToPath(new URL("../sandbox/fast-manim-oci/seccomp.v1.json", import.meta.url));
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONFORMANCE_STDERR_LIMIT = 64 * 1024;
const DOCKER_CONTROL_TIMEOUT_MS = 30_000;
const DOCKER_EXECUTION_MAX_TIMEOUT_MS = 5 * 60_000;
const ASSET_ROOT = "/opt/poietra/assets";
const ASSET_INSTALLER = "/opt/poietra/asset-installer.py";
const ASSET_VOLUME_NAME_PATTERN = /^poietra-assets-[a-f0-9]{24}$/;
const CONTAINER_NAME_PATTERN = /^poietra-(?:conformance|probe|asset-installer)-[a-f0-9]{24}$/;
export const MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_STDOUT_BYTES_V1 = 8 * 1024 * 1024 + 1;

type DockerResult = Readonly<{ code: number; stderr: Buffer; stdout: Buffer }>;

function runDocker(
  arguments_: readonly string[],
  options: Readonly<{
    abortSignal?: AbortSignal;
    input?: Uint8Array;
    maximumStdoutBytes?: number;
    timeoutMs?: number;
    tolerateExitFailure?: boolean;
  }> = {},
): Promise<DockerResult> {
  const timeoutMs = options.timeoutMs ?? DOCKER_CONTROL_TIMEOUT_MS;
  const maximumStdoutBytes = options.maximumStdoutBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOCKER_EXECUTION_MAX_TIMEOUT_MS) {
    throw new RangeError("Local OCI conformance Docker timeout is outside its fixed budget.");
  }
  if (
    !Number.isSafeInteger(maximumStdoutBytes) ||
    maximumStdoutBytes < 0 ||
    maximumStdoutBytes > MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_STDOUT_BYTES_V1
  ) {
    throw new RangeError("Local OCI conformance Docker stdout limit is outside its fixed budget.");
  }
  if (options.abortSignal?.aborted) throw new Error("Local OCI conformance Docker operation was aborted.");
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("docker", arguments_, {
      env: { PATH: process.env.PATH },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let timedOut = false;
    let aborted = false;
    let stdinFailed = false;
    let settled = false;
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", abortOperation);
      rejectRun(error);
    };
    const abortOperation = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    options.abortSignal?.addEventListener("abort", abortOperation, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumStdoutBytes) {
        overflowed = true;
        child.kill("SIGKILL");
      } else stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > CONFORMANCE_STDERR_LIMIT) {
        overflowed = true;
        child.kill("SIGKILL");
      } else stderr.push(chunk);
    });
    child.stdin?.once("error", () => {
      stdinFailed = true;
      child.kill("SIGKILL");
    });
    child.once("error", () => settleReject(new Error("Local OCI conformance Docker command could not start.")));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", abortOperation);
      if (timedOut) {
        rejectRun(new Error("Local OCI conformance Docker command exceeded its fixed deadline."));
        return;
      }
      if (aborted) {
        rejectRun(new Error("Local OCI conformance Docker operation was aborted."));
        return;
      }
      if (overflowed) {
        rejectRun(new Error("Local OCI conformance Docker output exceeded its byte budget."));
        return;
      }
      if (stdinFailed) {
        rejectRun(new Error("Local OCI conformance Docker stdin transport failed."));
        return;
      }
      const result = { code: code ?? 1, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) };
      if (result.code !== 0 && !options.tolerateExitFailure) {
        const operation = [arguments_[0], arguments_[1]].filter(Boolean).join(" ");
        rejectRun(new Error(`Local OCI conformance Docker ${operation} operation failed.`));
      } else resolveRun(result);
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length !== length - 1) throw new RangeError("OCI asset metadata does not fit a ustar field.");
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function createCanonicalUstarEntry(name: string, bytes: Uint8Array) {
  const isVisibleAscii =
    name.length > 0 &&
    name.length <= 100 &&
    Array.from(name).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7e;
    });
  if (!isVisibleAscii || Buffer.byteLength(name, "ascii") !== name.length) {
    throw new TypeError("OCI asset archive paths must be short ASCII names.");
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  writeTarOctal(header, 100, 8, 0o444);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const payload = Buffer.from(bytes);
  const padding = Buffer.alloc((512 - (payload.byteLength % 512)) % 512);
  return Buffer.concat([header, payload, padding]);
}

/** Creates one root-owned 0444 ustar entry whose path is exactly its digest. */
export function createFastManimOciAssetTarV1(asset: FastManimOciBrokerAssetCopyV1) {
  if (asset.descriptor.fileName !== asset.descriptor.sha256 || !/^[a-f0-9]{64}$/.test(asset.descriptor.fileName)) {
    throw new TypeError("OCI asset tar paths must be digest names only.");
  }
  if (asset.bytes.byteLength !== asset.descriptor.byteLength)
    throw new TypeError("OCI asset length changed before tar injection.");
  if (createHash("sha256").update(asset.bytes).digest("hex") !== asset.descriptor.sha256) {
    throw new TypeError("OCI asset bytes changed and no longer match their digest before tar injection.");
  }
  return Buffer.concat([createCanonicalUstarEntry(asset.descriptor.fileName, asset.bytes), Buffer.alloc(1024)]);
}

function createAssetArchive(
  descriptors: readonly FastManimOciBrokerAssetCopyV1["descriptor"][],
  assets: readonly FastManimOciBrokerAssetCopyV1[],
) {
  if (assets.length !== descriptors.length) throw new TypeError("OCI asset copies do not match the closed descriptor.");
  const manifest = {
    assets: descriptors.map((asset) => ({
      byteLength: asset.byteLength,
      fileName: asset.fileName,
      sha256: asset.sha256,
    })),
    count: descriptors.length,
    schema: FAST_MANIM_OCI_ASSET_MANIFEST_SCHEMA_V1,
    version: 1,
  };
  const entries = [
    createCanonicalUstarEntry(FAST_MANIM_OCI_ASSET_CONTROL_FILE_V1, Buffer.from(canonicalJsonV1(manifest), "utf8")),
  ];
  for (const [index, asset] of assets.entries()) {
    if (canonicalJsonV1(asset.descriptor) !== canonicalJsonV1(descriptors[index])) {
      throw new TypeError("OCI asset copy metadata changed before archive injection.");
    }
    entries.push(createFastManimOciAssetTarV1(asset).subarray(0, -1024));
  }
  entries.push(Buffer.alloc(1024));
  return Buffer.concat(entries);
}

export function createFastManimOciAssetArchiveV1(dispatch: FastManimOciBrokerDispatchV1) {
  const descriptor = fastManimOciJobDescriptorV1Schema.parse(dispatch.descriptor);
  return createAssetArchive(descriptor.assets, dispatch.copyAssets());
}

function createEmptyFastManimOciAssetArchiveV1() {
  return createAssetArchive([], []);
}

function dockerCreateArguments(
  profileValue: unknown,
  localImageReference: string,
  containerName: string,
  assetVolumeName: string,
  probeProgram?: string,
): readonly string[] {
  const profile = fastManimOciProfileV1Schema.parse(profileValue);
  if (!IMAGE_DIGEST_PATTERN.test(localImageReference))
    throw new TypeError("Local OCI images must use a digest reference.");
  if (!ASSET_VOLUME_NAME_PATTERN.test(assetVolumeName))
    throw new TypeError("Local OCI asset volumes must use opaque request-scoped names.");
  const arguments_ = [
    "container",
    "create",
    `--name=${containerName}`,
    "--interactive",
    "--pull=never",
    `--platform=${profile.platform}`,
    `--user=${profile.identity.uid}:${profile.identity.gid}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    `--security-opt=seccomp=${SECCOMP_PATH}`,
    "--read-only",
    "--network=none",
    "--cgroupns=private",
    "--ipc=private",
    "--log-driver=none",
    `--mount=type=volume,src=${assetVolumeName},dst=${ASSET_ROOT},readonly,volume-nocopy`,
    ...profile.writableFilesystems.map(
      (filesystem) =>
        `--tmpfs=${filesystem.destination}:rw,${filesystem.options.join(",")},size=${filesystem.sizeBytes},nr_inodes=${filesystem.maximumInodes},mode=${filesystem.mode.toString(8)}`,
    ),
  ];
  if (probeProgram !== undefined) arguments_.push("--entrypoint=/opt/venv/bin/python");
  arguments_.push(localImageReference);
  if (probeProgram !== undefined) arguments_.push("-c", probeProgram);
  return Object.freeze(arguments_);
}

function assetInstallerCreateArguments(
  profileValue: unknown,
  localImageReference: string,
  containerName: string,
  assetVolumeName: string,
): readonly string[] {
  const profile = fastManimOciProfileV1Schema.parse(profileValue);
  if (!IMAGE_DIGEST_PATTERN.test(localImageReference) || !ASSET_VOLUME_NAME_PATTERN.test(assetVolumeName)) {
    throw new TypeError("Local OCI asset installer references are not closed identifiers.");
  }
  return Object.freeze([
    "container",
    "create",
    `--name=${containerName}`,
    "--interactive",
    "--pull=never",
    `--platform=${profile.platform}`,
    "--user=0:0",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    `--security-opt=seccomp=${SECCOMP_PATH}`,
    "--read-only",
    "--network=none",
    "--cgroupns=private",
    "--ipc=private",
    "--log-driver=none",
    `--mount=type=volume,src=${assetVolumeName},dst=${ASSET_ROOT},volume-nocopy`,
    "--entrypoint=/opt/venv/bin/python",
    localImageReference,
    ASSET_INSTALLER,
  ]);
}

async function verifyContainerConfiguration(
  containerId: string,
  containerName: string,
  localImageReference: string,
  assetVolumeName: string,
  profileValue: unknown,
  attestationValue: unknown,
  probeProgram?: string,
) {
  const profile = fastManimOciProfileV1Schema.parse(profileValue);
  const attestation = fastManimOciBuildAttestationV1Schema.parse(attestationValue);
  const result = await runDocker(["container", "inspect", containerId]);
  const documents: unknown = JSON.parse(result.stdout.toString("utf8"));
  if (
    !Array.isArray(documents) ||
    documents.length !== 1 ||
    typeof documents[0] !== "object" ||
    documents[0] === null
  ) {
    throw new Error("Docker returned malformed conformance container metadata.");
  }
  const document = documents[0] as Record<string, unknown>;
  const config = document.Config as Record<string, unknown>;
  const host = document.HostConfig as Record<string, unknown>;
  const expectedEnvironment = {
    GPG_KEY: "7169605F62C751356D054A26A821E680E5FA6305",
    PYTHON_SHA256: "c30bb24b7f1e9a19b11b55a546434f74e739bb4c271a3e3a80ff4380d49f7adb",
    PYTHON_VERSION: "3.12.11",
    ...profile.environment,
  };
  const environment = Object.fromEntries(
    ((config.Env as readonly string[]) ?? []).map((entry) => entry.split(/=(.*)/s).slice(0, 2)),
  );
  const securityOptions = host.SecurityOpt;
  if (
    !Array.isArray(securityOptions) ||
    securityOptions.length !== 2 ||
    securityOptions[0] !== "no-new-privileges=true"
  ) {
    throw new Error("Docker did not apply the locked no-new-privileges/seccomp options.");
  }
  const serializedSeccomp = securityOptions[1];
  if (typeof serializedSeccomp !== "string" || !serializedSeccomp.startsWith("seccomp=")) {
    throw new Error("Docker did not embed the locked seccomp profile.");
  }
  const appliedSeccomp = JSON.parse(serializedSeccomp.slice("seccomp=".length));
  const appliedSeccompDigest = createHash("sha256").update(canonicalJsonV1(appliedSeccomp), "utf8").digest("hex");
  const configuredMounts = host.Mounts;
  const runtimeMounts = document.Mounts;
  const configuredAssetMount =
    Array.isArray(configuredMounts) && configuredMounts.length === 1 ? configuredMounts[0] : null;
  const runtimeAssetMount = Array.isArray(runtimeMounts) && runtimeMounts.length === 1 ? runtimeMounts[0] : null;
  const assetMountMatches =
    typeof configuredAssetMount === "object" &&
    configuredAssetMount !== null &&
    configuredAssetMount.Type === "volume" &&
    configuredAssetMount.Source === assetVolumeName &&
    configuredAssetMount.Target === ASSET_ROOT &&
    configuredAssetMount.ReadOnly === true &&
    typeof configuredAssetMount.VolumeOptions === "object" &&
    configuredAssetMount.VolumeOptions !== null &&
    configuredAssetMount.VolumeOptions.NoCopy === true &&
    typeof runtimeAssetMount === "object" &&
    runtimeAssetMount !== null &&
    runtimeAssetMount.Type === "volume" &&
    runtimeAssetMount.Name === assetVolumeName &&
    runtimeAssetMount.Destination === ASSET_ROOT &&
    runtimeAssetMount.RW === false;
  const expectedTmpfs = Object.fromEntries(
    profile.writableFilesystems.map((filesystem) => [
      filesystem.destination,
      `rw,${filesystem.options.join(",")},size=${filesystem.sizeBytes},nr_inodes=${filesystem.maximumInodes},mode=${filesystem.mode.toString(8)}`,
    ]),
  );
  const expectedEntrypoint = probeProgram === undefined ? profile.process.launcher : ["/opt/venv/bin/python"];
  const expectedCommand = probeProgram === undefined ? profile.process.target : ["-c", probeProgram];
  const checks = {
    capabilities:
      canonicalJsonV1(host.CapDrop) === canonicalJsonV1(["ALL"]) && host.CapAdd === null && host.Privileged === false,
    cgroupNamespace: host.CgroupnsMode === "private",
    devices: canonicalJsonV1(host.Devices) === canonicalJsonV1([]) && host.DeviceRequests === null,
    environment: canonicalJsonV1(environment) === canonicalJsonV1(expectedEnvironment),
    hostname: config.Hostname === containerId.slice(0, 12),
    identity: config.User === `${profile.identity.uid}:${profile.identity.gid}` && host.GroupAdd === null,
    image: document.Image === localImageReference,
    ipcNamespace: host.IpcMode === "private",
    labels: canonicalJsonV1(config.Labels) === canonicalJsonV1({}),
    name: document.Name === `/${containerName}`,
    logging: canonicalJsonV1(host.LogConfig) === canonicalJsonV1({ Config: {}, Type: "none" }),
    bindMountsAbsent: host.Binds === null,
    fixedReadOnlyAssetVolume: assetMountMatches,
    network:
      host.NetworkMode === "none" &&
      host.ExtraHosts === null &&
      host.Dns === null &&
      canonicalJsonV1(host.DnsOptions) === canonicalJsonV1([]) &&
      canonicalJsonV1(host.DnsSearch) === canonicalJsonV1([]) &&
      canonicalJsonV1(host.PortBindings) === canonicalJsonV1({}) &&
      host.PublishAllPorts === false,
    noNewPrivileges: securityOptions[0] === "no-new-privileges=true",
    pidNamespace: host.PidMode === "",
    proc:
      canonicalJsonV1(host.MaskedPaths) === canonicalJsonV1(profile.proc.maskedPaths) &&
      canonicalJsonV1(host.ReadonlyPaths) === canonicalJsonV1(profile.proc.readOnlyPaths),
    process:
      canonicalJsonV1(config.Entrypoint) === canonicalJsonV1(expectedEntrypoint) &&
      canonicalJsonV1(config.Cmd) === canonicalJsonV1(expectedCommand) &&
      config.WorkingDir === profile.process.workingDirectory &&
      config.OpenStdin === true &&
      config.Tty === false,
    readOnlyRoot: host.ReadonlyRootfs === true,
    volumesFromAbsent: host.VolumesFrom === null,
    seccomp: appliedSeccompDigest === attestation.seccompDigest,
    tmpfs: canonicalJsonV1(host.Tmpfs) === canonicalJsonV1(expectedTmpfs),
    utsNamespace: host.UTSMode === "",
  };
  const drift = Object.entries(checks)
    .filter(([, matches]) => !matches)
    .map(([name]) => name);
  if (drift.length > 0) {
    throw new Error(`Docker conformance container configuration drifted from locked fields: ${drift.join(", ")}.`);
  }
}

async function verifyAssetInstallerConfiguration(
  containerId: string,
  containerName: string,
  localImageReference: string,
  assetVolumeName: string,
  profileValue: unknown,
  attestationValue: unknown,
) {
  const profile = fastManimOciProfileV1Schema.parse(profileValue);
  const attestation = fastManimOciBuildAttestationV1Schema.parse(attestationValue);
  const result = await runDocker(["container", "inspect", containerId]);
  const documents: unknown = JSON.parse(result.stdout.toString("utf8"));
  if (
    !Array.isArray(documents) ||
    documents.length !== 1 ||
    typeof documents[0] !== "object" ||
    documents[0] === null
  ) {
    throw new Error("Docker returned malformed asset installer metadata.");
  }
  const document = documents[0] as Record<string, unknown>;
  const config = document.Config as Record<string, unknown>;
  const host = document.HostConfig as Record<string, unknown>;
  const securityOptions = host.SecurityOpt;
  const expectedEnvironment = {
    GPG_KEY: "7169605F62C751356D054A26A821E680E5FA6305",
    PYTHON_SHA256: "c30bb24b7f1e9a19b11b55a546434f74e739bb4c271a3e3a80ff4380d49f7adb",
    PYTHON_VERSION: "3.12.11",
    ...profile.environment,
  };
  const environment = Object.fromEntries(
    ((config.Env as readonly string[]) ?? []).map((entry) => entry.split(/=(.*)/s).slice(0, 2)),
  );
  const serializedSeccomp = Array.isArray(securityOptions) ? securityOptions[1] : undefined;
  const appliedSeccompDigest =
    typeof serializedSeccomp === "string" && serializedSeccomp.startsWith("seccomp=")
      ? createHash("sha256")
          .update(canonicalJsonV1(JSON.parse(serializedSeccomp.slice("seccomp=".length))), "utf8")
          .digest("hex")
      : "";
  const configuredMounts = host.Mounts;
  const runtimeMounts = document.Mounts;
  const configuredAssetMount =
    Array.isArray(configuredMounts) && configuredMounts.length === 1 ? configuredMounts[0] : null;
  const runtimeAssetMount = Array.isArray(runtimeMounts) && runtimeMounts.length === 1 ? runtimeMounts[0] : null;
  const checks = {
    capabilities:
      canonicalJsonV1(host.CapDrop) === canonicalJsonV1(["ALL"]) && host.CapAdd === null && host.Privileged === false,
    cgroupNamespace: host.CgroupnsMode === "private",
    environment: canonicalJsonV1(environment) === canonicalJsonV1(expectedEnvironment),
    fixedProcess:
      config.User === "0:0" &&
      canonicalJsonV1(config.Entrypoint) === canonicalJsonV1(["/opt/venv/bin/python"]) &&
      canonicalJsonV1(config.Cmd) === canonicalJsonV1([ASSET_INSTALLER]) &&
      config.WorkingDir === profile.process.workingDirectory &&
      config.OpenStdin === true &&
      config.Tty === false,
    identity: host.GroupAdd === null,
    image: document.Image === localImageReference,
    ipcNamespace: host.IpcMode === "private",
    labels: canonicalJsonV1(config.Labels) === canonicalJsonV1({}),
    logging: canonicalJsonV1(host.LogConfig) === canonicalJsonV1({ Config: {}, Type: "none" }),
    mount:
      typeof configuredAssetMount === "object" &&
      configuredAssetMount !== null &&
      configuredAssetMount.Type === "volume" &&
      configuredAssetMount.Source === assetVolumeName &&
      configuredAssetMount.Target === ASSET_ROOT &&
      configuredAssetMount.ReadOnly === undefined &&
      typeof configuredAssetMount.VolumeOptions === "object" &&
      configuredAssetMount.VolumeOptions !== null &&
      configuredAssetMount.VolumeOptions.NoCopy === true &&
      typeof runtimeAssetMount === "object" &&
      runtimeAssetMount !== null &&
      runtimeAssetMount.Type === "volume" &&
      runtimeAssetMount.Name === assetVolumeName &&
      runtimeAssetMount.Destination === ASSET_ROOT &&
      runtimeAssetMount.RW === true,
    name: document.Name === `/${containerName}`,
    namespaces: host.PidMode === "" && host.UTSMode === "",
    network:
      host.NetworkMode === "none" &&
      host.ExtraHosts === null &&
      host.Dns === null &&
      canonicalJsonV1(host.DnsOptions) === canonicalJsonV1([]) &&
      canonicalJsonV1(host.DnsSearch) === canonicalJsonV1([]) &&
      canonicalJsonV1(host.PortBindings) === canonicalJsonV1({}) &&
      host.PublishAllPorts === false,
    noHostSurfaces:
      host.Binds === null &&
      host.VolumesFrom === null &&
      canonicalJsonV1(host.Devices) === canonicalJsonV1([]) &&
      host.DeviceRequests === null,
    noNewPrivileges:
      Array.isArray(securityOptions) && securityOptions.length === 2 && securityOptions[0] === "no-new-privileges=true",
    readOnlyRoot: host.ReadonlyRootfs === true,
    seccomp: appliedSeccompDigest === attestation.seccompDigest,
    tmpfsAbsent: host.Tmpfs === undefined || host.Tmpfs === null || canonicalJsonV1(host.Tmpfs) === canonicalJsonV1({}),
  };
  const drift = Object.entries(checks)
    .filter(([, matches]) => !matches)
    .map(([name]) => name);
  if (drift.length > 0) {
    throw new Error(`Docker asset installer configuration drifted from locked fields: ${drift.join(", ")}.`);
  }
}

function randomContainerName(kind: "asset-installer" | "conformance" | "probe") {
  const name = `poietra-${kind}-${randomBytes(12).toString("hex")}`;
  if (!CONTAINER_NAME_PATTERN.test(name)) throw new Error("Local OCI random container name generation failed.");
  return name;
}

function randomAssetVolumeName() {
  const name = `poietra-assets-${randomBytes(12).toString("hex")}`;
  if (!ASSET_VOLUME_NAME_PATTERN.test(name)) throw new Error("Local OCI random volume name generation failed.");
  return name;
}

async function removeContainer(containerReference: string) {
  const removed = await runDocker(["container", "rm", "--force", containerReference], { tolerateExitFailure: true });
  if (removed.code !== 0) throw new Error("Local OCI conformance cleanup failed; this run is not verified.");
}

async function createAssetVolume(volumeName: string) {
  if (!ASSET_VOLUME_NAME_PATTERN.test(volumeName)) throw new TypeError("The OCI asset volume name is invalid.");
  const created = await runDocker(["volume", "create", volumeName]);
  if (created.stdout.toString("utf8").trim() !== volumeName) {
    throw new Error("Docker did not return the requested opaque asset volume name.");
  }
}

async function removeAssetVolume(volumeName: string) {
  if (!ASSET_VOLUME_NAME_PATTERN.test(volumeName)) throw new TypeError("The OCI asset volume name is invalid.");
  const removed = await runDocker(["volume", "rm", "--force", volumeName], { tolerateExitFailure: true });
  if (removed.code === 0 && removed.stdout.toString("utf8").trim() === volumeName) return;
  const absence = await runDocker(["volume", "ls", "--quiet", "--filter", `name=^${volumeName}$`], {
    tolerateExitFailure: true,
  });
  if (absence.code !== 0 || absence.stdout.toString("utf8").trim() !== "") {
    throw new Error("Local OCI conformance asset volume cleanup failed; this run is not verified.");
  }
}

async function createContainer(arguments_: readonly string[], containerName: string) {
  try {
    return await runDocker(arguments_);
  } catch (error) {
    const inspected = await runDocker(["container", "inspect", containerName], { tolerateExitFailure: true });
    if (inspected.code === 0) await removeContainer(containerName);
    throw error;
  }
}

async function resolveLocalImageReference(attestationValue: unknown) {
  const attestation = fastManimOciBuildAttestationV1Schema.parse(attestationValue);
  const inspected = await runDocker(["image", "inspect", attestation.imageDigest], { tolerateExitFailure: true });
  if (inspected.code === 0) return attestation.imageDigest;
  const configOnly = await runDocker(["image", "inspect", attestation.imageConfigDigest], {
    tolerateExitFailure: true,
  });
  if (configOnly.code === 0) {
    throw new Error(
      "The classic Docker image store exposes only the config digest and cannot prove the attested manifest/config pair; this conformance run is unsupported.",
    );
  }
  throw new Error("The attested OCI image is not present in the local Docker image store.");
}

async function installAssets(
  localImageReference: string,
  assetVolumeName: string,
  profileValue: unknown,
  attestationValue: unknown,
  archive: Uint8Array,
  deadlineEpochMs: number,
  abortSignal?: AbortSignal,
) {
  const containerName = randomContainerName("asset-installer");
  const created = await createContainer(
    assetInstallerCreateArguments(profileValue, localImageReference, containerName, assetVolumeName),
    containerName,
  );
  const containerId = created.stdout.toString("utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) {
    await removeContainer(containerName);
    throw new Error("Docker returned an invalid asset installer container ID.");
  }
  let failure: unknown;
  try {
    await verifyAssetInstallerConfiguration(
      containerId,
      containerName,
      localImageReference,
      assetVolumeName,
      profileValue,
      attestationValue,
    );
    const remainingMs = deadlineEpochMs - Date.now();
    const execution = await runDocker(["container", "start", "--attach", "--interactive", containerId], {
      abortSignal,
      input: archive,
      maximumStdoutBytes: 0,
      timeoutMs: Math.min(60_000, remainingMs),
      tolerateExitFailure: true,
    });
    if (execution.code !== 0 || execution.stdout.byteLength !== 0) {
      throw new Error("The fixed OCI asset installer rejected the closed request archive.");
    }
    const stateResult = await runDocker(["container", "inspect", "--format={{json .State}}", containerId]);
    const state: unknown = JSON.parse(stateResult.stdout.toString("utf8"));
    if (
      typeof state !== "object" ||
      state === null ||
      !("ExitCode" in state) ||
      state.ExitCode !== 0 ||
      execution.code !== state.ExitCode
    ) {
      throw new Error("Docker asset installer exit status correlation failed.");
    }
  } catch (error) {
    failure = error;
  }
  try {
    await removeContainer(containerId);
  } catch (cleanupError) {
    throw new Error("Local OCI asset installer cleanup failed; this run is not verified.", { cause: cleanupError });
  }
  if (failure !== undefined) throw failure;
}

export type FastManimLocalOciConformanceResultV1 = Readonly<{
  cleanupVerified: true;
  exitCode: number;
  stderr: Uint8Array;
  stdout: Uint8Array;
}>;

/**
 * Local Docker is a conformance adapter only. Production Studio code receives
 * no Docker socket and dispatches the closed broker descriptor instead.
 */
export async function runFastManimLocalOciConformanceV1(
  options: Readonly<{
    attestation: unknown;
    dispatch: FastManimOciBrokerDispatchV1;
    maximumStdoutBytes: number;
    profile: unknown;
  }>,
): Promise<FastManimLocalOciConformanceResultV1> {
  if (options.maximumStdoutBytes !== MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_STDOUT_BYTES_V1) {
    throw new RangeError("The fixed source runtime identity stdout budget must include only one CLI newline.");
  }
  if (!(options.dispatch instanceof FastManimOciBrokerDispatchV1)) {
    throw new TypeError("Local OCI conformance requires a validated, server-owned broker dispatch.");
  }
  const profileDigest = digestFastManimOciProfileV1(options.profile);
  const attestation = fastManimOciBuildAttestationV1Schema.parse(options.attestation);
  const descriptor = fastManimOciJobDescriptorV1Schema.parse(options.dispatch.descriptor);
  if (
    profileDigest !== attestation.profileDigest ||
    descriptor.imageDigest !== attestation.imageDigest ||
    descriptor.profileDigest !== profileDigest ||
    descriptor.runtimeDigest !== attestation.runtimeDigest ||
    descriptor.sbomDigest !== attestation.sbom.digest ||
    descriptor.seccompDigest !== attestation.seccompDigest
  ) {
    throw new TypeError("Local OCI conformance descriptor does not match every attested runtime digest.");
  }
  const requestBytes = options.dispatch.copyRequestBytes();
  if (
    requestBytes.byteLength !== descriptor.request.byteLength ||
    createHash("sha256").update(requestBytes).digest("hex") !== descriptor.request.sha256
  ) {
    throw new TypeError("Local OCI conformance stdin bytes do not match the closed request descriptor.");
  }
  const localImageReference = await resolveLocalImageReference(attestation);
  const assetVolumeName = randomAssetVolumeName();
  const containerName = randomContainerName("conformance");
  let volumeProvisionAttempted = false;
  let containerId: string | undefined;
  let execution: DockerResult | undefined;
  let failure: unknown;
  try {
    volumeProvisionAttempted = true;
    await createAssetVolume(assetVolumeName);
    await installAssets(
      localImageReference,
      assetVolumeName,
      options.profile,
      attestation,
      createFastManimOciAssetArchiveV1(options.dispatch),
      options.dispatch.context.deadlineEpochMs,
      options.dispatch.context.signal,
    );
    const created = await createContainer(
      dockerCreateArguments(options.profile, localImageReference, containerName, assetVolumeName),
      containerName,
    );
    containerId = created.stdout.toString("utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      await removeContainer(containerName);
      containerId = undefined;
      throw new Error("Docker returned an invalid conformance container ID.");
    }
    await verifyContainerConfiguration(
      containerId,
      containerName,
      localImageReference,
      assetVolumeName,
      options.profile,
      attestation,
    );
    const executionTimeoutMs = Math.min(
      DOCKER_EXECUTION_MAX_TIMEOUT_MS,
      options.dispatch.context.deadlineEpochMs - Date.now(),
    );
    if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs <= 0) {
      throw new Error("Local OCI conformance execution deadline expired before container start.");
    }
    execution = await runDocker(["container", "start", "--attach", "--interactive", containerId], {
      abortSignal: options.dispatch.context.signal,
      input: requestBytes,
      maximumStdoutBytes: options.maximumStdoutBytes,
      timeoutMs: executionTimeoutMs,
      tolerateExitFailure: true,
    });
    const stateResult = await runDocker(["container", "inspect", "--format={{json .State}}", containerId]);
    const state: unknown = JSON.parse(stateResult.stdout.toString("utf8"));
    if (
      typeof state !== "object" ||
      state === null ||
      !("ExitCode" in state) ||
      typeof state.ExitCode !== "number" ||
      state.ExitCode !== execution.code
    ) {
      throw new Error("Docker CLI/container exit status correlation failed.");
    }
  } catch (error) {
    failure = error;
  }
  const cleanupFailures: unknown[] = [];
  if (containerId !== undefined) {
    try {
      await removeContainer(containerId);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (volumeProvisionAttempted) {
    try {
      await removeAssetVolume(assetVolumeName);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new Error("Local OCI conformance cleanup failed; this run is not verified.", {
      cause: cleanupFailures[0],
    });
  }
  if (failure !== undefined) throw failure;
  if (!execution) throw new Error("Local OCI conformance execution did not settle.");
  return Object.freeze({
    cleanupVerified: true as const,
    exitCode: execution.code,
    stderr: Uint8Array.from(execution.stderr),
    stdout: Uint8Array.from(execution.stdout),
  });
}

export type FastManimLocalOciProbeHandleV1 = Readonly<{ containerId: string }>;
const probeResources = new WeakMap<object, Readonly<{ assetVolumeName: string; containerId: string }>>();

export async function createFastManimLocalOciProbeContainerV1(
  options: Readonly<{
    attestation: unknown;
    profile: unknown;
    program: string;
  }>,
) {
  const attestation = fastManimOciBuildAttestationV1Schema.parse(options.attestation);
  if (digestFastManimOciProfileV1(options.profile) !== attestation.profileDigest) {
    throw new TypeError("Local OCI probe profile does not match the attestation.");
  }
  const localImageReference = await resolveLocalImageReference(attestation);
  const assetVolumeName = randomAssetVolumeName();
  const containerName = randomContainerName("probe");
  let volumeProvisionAttempted = false;
  let containerId: string | undefined;
  let failure: unknown;
  try {
    volumeProvisionAttempted = true;
    await createAssetVolume(assetVolumeName);
    await installAssets(
      localImageReference,
      assetVolumeName,
      options.profile,
      attestation,
      createEmptyFastManimOciAssetArchiveV1(),
      Date.now() + 60_000,
    );
    const created = await createContainer(
      dockerCreateArguments(options.profile, localImageReference, containerName, assetVolumeName, options.program),
      containerName,
    );
    containerId = created.stdout.toString("utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
      await removeContainer(containerName);
      containerId = undefined;
      throw new Error("Docker returned an invalid probe container ID.");
    }
    await verifyContainerConfiguration(
      containerId,
      containerName,
      localImageReference,
      assetVolumeName,
      options.profile,
      attestation,
      options.program,
    );
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    const cleanupFailures: unknown[] = [];
    if (containerId !== undefined) {
      try {
        await removeContainer(containerId);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (volumeProvisionAttempted) {
      try {
        await removeAssetVolume(assetVolumeName);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new Error("Local OCI probe setup cleanup failed; this run is not verified.", { cause: cleanupFailures[0] });
    }
    throw failure;
  }
  if (containerId === undefined) throw new Error("Local OCI probe setup did not produce a container.");
  const handle = Object.freeze({ containerId });
  probeResources.set(handle, Object.freeze({ assetVolumeName, containerId }));
  return handle;
}

export async function runFastManimLocalOciProbeContainerV1(
  handle: FastManimLocalOciProbeHandleV1,
  maximumStdoutBytes = 1024 * 1024,
) {
  const resources = probeResources.get(handle);
  if (!resources || resources.containerId !== handle.containerId) {
    throw new TypeError("The OCI probe handle is invalid or already consumed.");
  }
  probeResources.delete(handle);
  let result: DockerResult | undefined;
  let failure: unknown;
  try {
    result = await runDocker(["container", "start", "--attach", resources.containerId], {
      maximumStdoutBytes,
      timeoutMs: 60_000,
      tolerateExitFailure: true,
    });
  } catch (error) {
    failure = error;
  }
  const cleanupFailures: unknown[] = [];
  try {
    await removeContainer(resources.containerId);
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await removeAssetVolume(resources.assetVolumeName);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length > 0) {
    throw new Error("Local OCI probe cleanup failed; this run is not verified.", { cause: cleanupFailures[0] });
  }
  if (failure !== undefined) throw failure;
  if (!result) throw new Error("Local OCI probe execution did not settle.");
  return result;
}
