import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptRoot, "..");
const profileRoot = join(repositoryRoot, "sandbox", "fast-manim-oci");
const lockPath = join(profileRoot, "build-lock.v1.json");
const sha256Pattern = /^[a-f0-9]{64}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const pinnedImagePattern = /^[a-z0-9./-]+@sha256:[a-f0-9]{64}$/;

const expectedContextFiles = Object.freeze([
  "Containerfile",
  "apt-snapshot.sources",
  "asset-installer.py",
  "build-requirements.txt",
  "compiler-wrapper.sh",
  "entrypoint.py",
  "profile.v1.json",
  "runtime-inventory.py",
  "seccomp.v1.json",
]);
const forbiddenSyscalls = new Set([
  "bpf",
  "clone3",
  "mount",
  "mount_setattr",
  "open_by_handle_at",
  "perf_event_open",
  "pivot_root",
  "process_vm_readv",
  "process_vm_writev",
  "ptrace",
  "setns",
  "socket",
  "socketcall",
  "socketpair",
  "umount",
  "umount2",
  "unshare",
  "userfaultfd",
]);

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain JSON object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} has an unexpected field set.`);
}

function exactStringArray(value, expected, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} must be a string array.`);
  }
  if (canonicalJson(value) !== canonicalJson(expected)) fail(`${label} does not match the locked value.`);
}

function parseJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid UTF-8 JSON.`);
  }
  if (!isPlainObject(value)) fail(`${label} must be a JSON object.`);
  return value;
}

async function readRegularFile(path, label) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) fail(`${label} must be a regular, non-symlink file.`);
  return readFile(path);
}

function validateLock(lock) {
  exactKeys(
    lock,
    ["baseRuntime", "buildContext", "fastManim", "operatingSystem", "platform", "schema", "version"],
    "OCI build lock",
  );
  if (lock.schema !== "poietra.fast-manim-oci-build-lock" || lock.version !== 1) {
    fail("The OCI build lock schema/version is unsupported.");
  }
  if (lock.platform !== "linux/amd64") fail("The locked OCI platform must be linux/amd64.");
  exactKeys(lock.baseRuntime, ["python", "uv"], "Locked base runtime");
  for (const tool of [lock.baseRuntime?.python, lock.baseRuntime?.uv]) {
    exactKeys(tool, ["platformManifestDigest", "reference", "version"], "Locked build image");
    if (!isPlainObject(tool) || !pinnedImagePattern.test(tool.reference)) {
      fail("Every build image must use a registry reference pinned by a multi-arch manifest digest.");
    }
    if (!imageDigestPattern.test(tool.platformManifestDigest)) {
      fail("Every build image must lock its selected platform manifest digest.");
    }
  }
  exactKeys(
    lock.fastManim,
    ["archive", "commit", "pyprojectSha256", "repository", "sourceDateEpoch", "tree", "uvLockSha256"],
    "Locked fast-manim source",
  );
  exactKeys(lock.fastManim.archive, ["format", "prefix", "sha256"], "Locked source archive");
  if (lock.fastManim.repository !== "Poietra/fast-manim") fail("The locked source repository is unexpected.");
  for (const field of ["commit", "tree"]) {
    if (!/^[a-f0-9]{40}$/.test(lock.fastManim[field])) fail(`fastManim.${field} must be a full Git SHA.`);
  }
  for (const field of ["pyprojectSha256", "uvLockSha256"]) {
    if (!sha256Pattern.test(lock.fastManim[field])) fail(`fastManim.${field} must be SHA-256.`);
  }
  if (!sha256Pattern.test(lock.fastManim.archive?.sha256)) fail("The source archive must be SHA-256 locked.");
  if (
    lock.fastManim.archive?.format !== "git-archive-tar-gzip-v1" ||
    lock.fastManim.archive?.prefix !== "fast-manim/"
  ) {
    fail("The source archive format/prefix is not the deterministic v1 form.");
  }
  if (!Number.isSafeInteger(lock.fastManim.sourceDateEpoch) || lock.fastManim.sourceDateEpoch <= 0) {
    fail("The source date epoch must be a positive integer.");
  }
  exactKeys(lock.buildContext, ["files", "sourceArchiveFile"], "Locked build context");
  exactKeys(lock.buildContext.files, expectedContextFiles, "Build-context files");
  for (const digest of Object.values(lock.buildContext.files)) {
    if (!sha256Pattern.test(digest)) fail("Every build-context file must be SHA-256 locked.");
  }
  if (lock.buildContext.sourceArchiveFile !== "fast-manim.tar.gz") {
    fail("The source archive filename is not locked to fast-manim.tar.gz.");
  }
  exactKeys(lock.operatingSystem, ["builderPackages", "runtimePackages", "snapshot"], "Locked operating system");
  for (const [label, packages] of [
    ["builder", lock.operatingSystem.builderPackages],
    ["runtime", lock.operatingSystem.runtimePackages],
  ]) {
    if (!isPlainObject(packages) || Object.keys(packages).length === 0) fail(`Locked ${label} packages are missing.`);
    for (const [name, version] of Object.entries(packages)) {
      if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name) || typeof version !== "string" || version.length === 0) {
        fail(`Locked ${label} package metadata is invalid.`);
      }
    }
  }
  if (!/^\d{8}T\d{6}Z$/.test(lock.operatingSystem.snapshot)) {
    fail("The Debian repository must use one immutable snapshot timestamp.");
  }
}

function validateProfile(profile) {
  exactKeys(
    profile,
    [
      "assets",
      "capabilities",
      "environment",
      "hostExposure",
      "identity",
      "namespaces",
      "network",
      "noNewPrivileges",
      "platform",
      "proc",
      "process",
      "rootFilesystem",
      "schema",
      "seccomp",
      "version",
      "writableFilesystems",
    ],
    "OCI profile",
  );
  if (profile.schema !== "poietra.fast-manim-oci-profile" || profile.version !== 1) {
    fail("The OCI isolation profile schema/version is unsupported.");
  }
  if (profile.platform !== "linux/amd64") fail("The OCI profile platform is not locked.");
  if (
    profile.identity?.uid !== 65532 ||
    profile.identity?.gid !== 65532 ||
    profile.identity?.username !== "poietra-sandbox"
  ) {
    fail("The OCI profile must use the fixed unprivileged identity 65532:65532.");
  }
  exactKeys(profile.identity, ["gid", "groups", "uid", "username"], "OCI identity");
  exactKeys(profile.capabilities, ["ambient", "bounding", "effective", "inheritable", "permitted"], "OCI capabilities");
  exactStringArray(profile.identity.groups, [], "Supplementary groups");
  for (const setName of ["ambient", "bounding", "effective", "inheritable", "permitted"]) {
    exactStringArray(profile.capabilities?.[setName], [], `Capability set ${setName}`);
  }
  if (profile.noNewPrivileges !== true || profile.rootFilesystem?.readOnly !== true) {
    fail("The OCI profile must enforce no-new-privileges and a read-only root filesystem.");
  }
  if (!isPlainObject(profile.hostExposure) || Object.values(profile.hostExposure).some((value) => value !== false)) {
    fail("Host mounts, sockets, credentials, and environment inheritance must be unrepresentable.");
  }
  exactKeys(
    profile.hostExposure,
    ["credentialForwarding", "environmentInheritance", "genericMounts", "projectRootMount", "runtimeSocketMount"],
    "OCI host exposure",
  );
  const expectedEnvironment = {
    HOME: "/run/poietra/home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    MKL_NUM_THREADS: "1",
    NUMEXPR_NUM_THREADS: "1",
    OMP_NUM_THREADS: "1",
    OPENBLAS_NUM_THREADS: "1",
    PATH: "/opt/venv/bin:/usr/local/bin:/usr/bin:/bin",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONHASHSEED: "0",
    PYTHONNOUSERSITE: "1",
    TMPDIR: "/run/poietra/tmp",
    TZ: "UTC",
    VECLIB_MAXIMUM_THREADS: "1",
    XDG_CACHE_HOME: "/run/poietra/cache",
    XDG_CONFIG_HOME: "/run/poietra/config",
    XDG_DATA_HOME: "/run/poietra/data",
  };
  if (canonicalJson(profile.environment) !== canonicalJson(expectedEnvironment)) {
    fail("The OCI runtime environment must be fixed and credential-free.");
  }
  if (
    profile.process?.requestTransport !== "stdin" ||
    profile.process?.workingDirectory !== "/run/poietra" ||
    canonicalJson(profile.process?.launcher) !==
      canonicalJson(["/opt/venv/bin/python", "/opt/poietra/entrypoint.py"]) ||
    canonicalJson(profile.process?.target) !==
      canonicalJson(["/opt/venv/bin/python", "-m", "manim.renderer.source_runtime_identity"])
  ) {
    fail("The OCI process must accept only stdin bytes at the fixed snapshot entrypoint.");
  }
  exactKeys(profile.process, ["launcher", "requestTransport", "target", "workingDirectory"], "OCI process");
  exactKeys(
    profile.assets,
    [
      "controlFile",
      "destinationRoot",
      "injection",
      "manifestSchema",
      "maximumAssetBytes",
      "maximumAssets",
      "maximumTotalAssetBytes",
      "readOnlyAtExecution",
    ],
    "OCI asset contract",
  );
  if (
    profile.assets?.controlFile !== ".poietra-assets.v1.json" ||
    profile.assets?.destinationRoot !== "/opt/poietra/assets" ||
    profile.assets?.injection !== "digest-verified-read-only-request-volume" ||
    profile.assets?.manifestSchema !== "poietra.fast-manim-oci-asset-manifest" ||
    profile.assets?.readOnlyAtExecution !== true ||
    profile.assets?.maximumAssets !== 64 ||
    profile.assets?.maximumAssetBytes !== 16 * 1024 * 1024 ||
    profile.assets?.maximumTotalAssetBytes !== 16 * 1024 * 1024
  ) {
    fail("The immutable asset injection contract is incomplete.");
  }
  exactKeys(
    profile.network,
    ["dns", "loopback", "metadata", "mode", "socketSyscalls", "unixSockets"],
    "OCI network contract",
  );
  if (
    profile.network?.mode !== "none" ||
    ["dns", "loopback", "metadata", "socketSyscalls", "unixSockets"].some((field) => profile.network?.[field] !== false)
  ) {
    fail("The OCI profile must disable every network and socket surface.");
  }
  const filesystems = profile.writableFilesystems;
  if (!Array.isArray(filesystems) || filesystems.length !== 2) fail("Exactly two bounded tmpfs mounts are permitted.");
  const expectedTmpfs = new Map([
    ["/dev/shm", { maximumInodes: 1024, sizeBytes: 4 * 1024 * 1024 }],
    ["/run/poietra", { maximumInodes: 4096, sizeBytes: 16 * 1024 * 1024 }],
  ]);
  for (const filesystem of filesystems) {
    exactKeys(filesystem, ["destination", "maximumInodes", "mode", "options", "sizeBytes", "type"], "OCI tmpfs");
    const expected = expectedTmpfs.get(filesystem.destination);
    if (
      !isPlainObject(filesystem) ||
      filesystem.type !== "tmpfs" ||
      filesystem.mode !== 0o1777 ||
      filesystem.sizeBytes !== expected?.sizeBytes ||
      filesystem.maximumInodes !== expected?.maximumInodes
    ) {
      fail("A writable filesystem is not one of the locked bounded tmpfs mounts.");
    }
    exactStringArray(filesystem.options, ["nodev", "noexec", "nosuid"], `tmpfs ${filesystem.destination} options`);
    expectedTmpfs.delete(filesystem.destination);
  }
  if (expectedTmpfs.size !== 0) fail("A required bounded tmpfs mount is missing.");
  if (profile.seccomp?.required !== true || profile.seccomp?.profile !== "seccomp.v1.json") {
    fail("The locked seccomp profile is mandatory.");
  }
  exactKeys(profile.seccomp, ["profile", "required"], "OCI seccomp reference");
  exactKeys(profile.rootFilesystem, ["readOnly"], "OCI root filesystem");
  exactKeys(profile.namespaces, ["cgroup", "ipc", "network", "pid", "uts"], "OCI namespaces");
  for (const namespace of ["cgroup", "ipc", "pid", "uts"]) {
    if (profile.namespaces?.[namespace] !== "private") fail(`The ${namespace} namespace must be private.`);
  }
  if (profile.namespaces?.network !== "isolated-none") fail("The network namespace must be isolated and empty.");
  if (!Array.isArray(profile.proc?.maskedPaths) || !Array.isArray(profile.proc?.readOnlyPaths)) {
    fail("The masked/read-only proc contract is missing.");
  }
  exactKeys(profile.proc, ["maskedPaths", "readOnlyPaths"], "OCI proc contract");
  exactStringArray(
    profile.proc.maskedPaths,
    [
      "/proc/acpi",
      "/proc/asound",
      "/proc/interrupts",
      "/proc/kcore",
      "/proc/keys",
      "/proc/latency_stats",
      "/proc/sched_debug",
      "/proc/scsi",
      "/proc/timer_list",
      "/proc/timer_stats",
      "/sys/devices/virtual/powercap",
      "/sys/firmware",
    ],
    "OCI masked paths",
  );
  exactStringArray(
    profile.proc.readOnlyPaths,
    ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
    "OCI read-only paths",
  );
}

function validateSeccomp(seccomp) {
  exactKeys(
    seccomp,
    ["archMap", "defaultAction", "defaultErrnoRet", "listenerMetadata", "listenerPath", "syscalls"],
    "seccomp profile",
  );
  if (seccomp.defaultAction !== "SCMP_ACT_ERRNO" || seccomp.defaultErrnoRet !== 1) {
    fail("The seccomp profile must default-deny unknown syscalls with EPERM.");
  }
  const expectedArchMap = [
    { architecture: "SCMP_ARCH_X86_64", subArchitectures: ["SCMP_ARCH_X86", "SCMP_ARCH_X32"] },
    { architecture: "SCMP_ARCH_AARCH64", subArchitectures: ["SCMP_ARCH_ARM"] },
  ];
  if (canonicalJson(seccomp.archMap) !== canonicalJson(expectedArchMap))
    fail("The seccomp architecture map is not locked.");
  if (seccomp.listenerMetadata !== "" || seccomp.listenerPath !== "") {
    fail("The seccomp profile must not expose a userspace notification listener.");
  }
  if (!Array.isArray(seccomp.syscalls) || seccomp.syscalls.length !== 3) {
    fail("The seccomp syscall rules are not the closed v1 set.");
  }
  const allowed = new Set();
  let restrictedClone = false;
  let clone3Fallback = false;
  for (const [index, rule] of seccomp.syscalls.entries()) {
    if (!Array.isArray(rule.names)) fail("Every seccomp rule must name its syscalls.");
    if (rule.action === "SCMP_ACT_ERRNO") {
      exactKeys(rule, ["action", "errnoRet", "names"], "clone3 seccomp rule");
      clone3Fallback =
        rule.errnoRet === 38 && rule.names.length === 1 && rule.names[0] === "clone3" && rule.args === undefined;
      if (!clone3Fallback) fail("The only explicit seccomp errno rule may be clone3 -> ENOSYS.");
      continue;
    }
    if (rule.action !== "SCMP_ACT_ALLOW") fail("The seccomp profile may contain only explicit allow rules.");
    exactKeys(rule, index === 0 ? ["action", "names"] : ["action", "args", "names"], "seccomp allow rule");
    for (const name of rule.names) allowed.add(name);
    if (rule.names.includes("clone")) {
      restrictedClone =
        rule.names.length === 1 &&
        canonicalJson(rule.args) ===
          canonicalJson([{ index: 0, op: "SCMP_CMP_MASKED_EQ", value: 2114060416, valueTwo: 0 }]);
    }
  }
  if (
    allowed.size !==
    seccomp.syscalls.filter((rule) => rule.action === "SCMP_ACT_ALLOW").flatMap((rule) => rule.names).length
  ) {
    fail("The seccomp allowlist must not contain duplicate syscalls.");
  }
  const broadAllowRule = seccomp.syscalls[0];
  if (
    broadAllowRule.action !== "SCMP_ACT_ALLOW" ||
    broadAllowRule.names.includes("clone") ||
    sha256(Buffer.from(canonicalJson(broadAllowRule.names))) !==
      "f0d4fff9674ab545b441ff4de13bd34229c726e2e88d06caa4a131ab96891c38"
  ) {
    fail("The seccomp allowlist does not match the closed v1 syscall set.");
  }
  for (const name of forbiddenSyscalls) {
    if (allowed.has(name)) fail(`The seccomp profile must deny ${name}.`);
  }
  if (!restrictedClone) fail("clone must permit threads while denying every namespace flag.");
  if (!clone3Fallback) fail("clone3 must return ENOSYS so libc can fall back to the restricted clone rule.");
}

function validateSortedUniqueRecords(records, label, keyFor) {
  if (!Array.isArray(records)) fail(`${label} must be an array.`);
  let previous;
  const seen = new Set();
  for (const record of records) {
    const key = keyFor(record);
    if (typeof key !== "string" || key.length === 0) fail(`${label} contains an invalid record.`);
    if (seen.has(key)) fail(`${label} contains a duplicate record.`);
    if (previous !== undefined && previous >= key) fail(`${label} must be sorted canonically.`);
    seen.add(key);
    previous = key;
  }
}

function validateRuntimeInventory(inventory, lock) {
  exactKeys(
    inventory,
    ["artifacts", "build", "kind", "operatingSystem", "python", "schema", "signed", "toolchain", "version"],
    "Runtime SBOM",
  );
  if (
    inventory.schema !== "poietra.fast-manim-oci-sbom" ||
    inventory.version !== 1 ||
    inventory.kind !== "unsigned-package-inventory" ||
    inventory.signed !== false
  ) {
    fail("The embedded runtime SBOM has an unsupported or misleading trust claim.");
  }
  exactKeys(
    inventory.build,
    ["fastManimArchiveSha256", "fastManimCommit", "fastManimTree", "sourceDateEpoch", "uvLockSha256"],
    "Runtime SBOM build material",
  );
  const expectedBuild = {
    fastManimArchiveSha256: lock.fastManim.archive.sha256,
    fastManimCommit: lock.fastManim.commit,
    fastManimTree: lock.fastManim.tree,
    sourceDateEpoch: lock.fastManim.sourceDateEpoch,
    uvLockSha256: lock.fastManim.uvLockSha256,
  };
  if (canonicalJson(inventory.build) !== canonicalJson(expectedBuild)) {
    fail("The runtime SBOM source material does not match the build lock.");
  }
  exactKeys(
    inventory.toolchain,
    [
      "buildRequirementsSha256",
      "debianSnapshot",
      "pythonImage",
      "pythonPlatformManifestDigest",
      "uvImage",
      "uvPlatformManifestDigest",
    ],
    "Runtime SBOM toolchain",
  );
  const expectedToolchain = {
    buildRequirementsSha256: lock.buildContext.files["build-requirements.txt"],
    debianSnapshot: lock.operatingSystem.snapshot,
    pythonImage: lock.baseRuntime.python.reference,
    pythonPlatformManifestDigest: lock.baseRuntime.python.platformManifestDigest,
    uvImage: lock.baseRuntime.uv.reference,
    uvPlatformManifestDigest: lock.baseRuntime.uv.platformManifestDigest,
  };
  if (canonicalJson(inventory.toolchain) !== canonicalJson(expectedToolchain)) {
    fail("The runtime SBOM toolchain does not match the build lock.");
  }
  exactKeys(inventory.operatingSystem, ["packages"], "Runtime operating-system inventory");
  validateSortedUniqueRecords(inventory.operatingSystem.packages, "Runtime operating-system packages", (record) => {
    exactKeys(record, ["name", "version"], "Runtime operating-system package");
    if (typeof record.name !== "string" || typeof record.version !== "string" || record.version.length === 0) return "";
    return record.name;
  });
  const osPackages = new Map(inventory.operatingSystem.packages.map((record) => [record.name, record.version]));
  for (const [name, version] of Object.entries(lock.operatingSystem.runtimePackages)) {
    if (osPackages.get(name) !== version)
      fail(`The runtime SBOM does not contain locked OS package ${name}=${version}.`);
  }
  exactKeys(inventory.python, ["implementation", "packages", "version"], "Runtime Python inventory");
  if (inventory.python.implementation !== "CPython" || inventory.python.version !== lock.baseRuntime.python.version) {
    fail("The runtime Python implementation/version does not match the build lock.");
  }
  validateSortedUniqueRecords(inventory.python.packages, "Runtime Python packages", (record) => {
    exactKeys(record, ["name", "version"], "Runtime Python package");
    if (typeof record.name !== "string" || typeof record.version !== "string" || record.version.length === 0) return "";
    return record.name;
  });
  const pythonPackages = new Map(inventory.python.packages.map((record) => [record.name, record.version]));
  if (pythonPackages.get("fast-manim") !== "0.20.1") {
    fail("The runtime SBOM does not contain the expected native fast-manim wheel.");
  }
  exactKeys(inventory.artifacts, ["native"], "Runtime native-artifact inventory");
  validateSortedUniqueRecords(inventory.artifacts.native, "Runtime native artifacts", (record) => {
    exactKeys(record, ["path", "sha256"], "Runtime native artifact");
    if (
      typeof record.path !== "string" ||
      record.path.startsWith("/") ||
      record.path.split("/").includes("..") ||
      !sha256Pattern.test(record.sha256)
    ) {
      return "";
    }
    return record.path;
  });
  const nativePaths = inventory.artifacts.native.map((record) => record.path);
  for (const extension of ["_manim_native_cairo", "_manim_native_snapshot"]) {
    if (!nativePaths.some((path) => path.split("/").at(-1)?.startsWith(`${extension}.`) && path.endsWith(".so"))) {
      fail(`The runtime SBOM does not identify ${extension}.`);
    }
  }
  if (!nativePaths.some((path) => path.includes(".so."))) {
    fail("The runtime SBOM omits bundled versioned native runtime dependencies.");
  }
}

async function verifyTrackedInputs() {
  const lockBytes = await readRegularFile(lockPath, "OCI build lock");
  const lock = parseJson(lockBytes, "OCI build lock");
  validateLock(lock);
  const bytesByName = new Map();
  for (const name of expectedContextFiles) {
    const bytes = await readRegularFile(join(profileRoot, name), `OCI input ${name}`);
    if (sha256(bytes) !== lock.buildContext.files[name]) fail(`OCI input ${name} does not match its locked digest.`);
    bytesByName.set(name, bytes);
  }
  const profile = parseJson(bytesByName.get("profile.v1.json"), "OCI profile");
  const seccomp = parseJson(bytesByName.get("seccomp.v1.json"), "seccomp profile");
  validateProfile(profile);
  validateSeccomp(seccomp);
  const aptSources = bytesByName.get("apt-snapshot.sources").toString("utf8");
  if (!aptSources.includes(lock.operatingSystem.snapshot) || /deb\.debian\.org|\blatest\b/i.test(aptSources)) {
    fail("APT sources must use only the locked Debian snapshot.");
  }
  const containerfile = bytesByName.get("Containerfile").toString("utf8");
  for (const image of [lock.baseRuntime.python.reference, lock.baseRuntime.uv.reference]) {
    if (!containerfile.includes(image)) fail(`Containerfile does not use locked image ${image}.`);
  }
  for (const [name, version] of Object.entries({
    ...lock.operatingSystem.builderPackages,
    ...lock.operatingSystem.runtimePackages,
  })) {
    if (!containerfile.includes(`${name}=${version}`)) fail(`Containerfile does not pin ${name}=${version}.`);
  }
  if (/\b(?:ADD|RUN)\s+https?:|\bcurl\b|\bwget\b|docker\.sock|--mount=/i.test(containerfile)) {
    fail("Containerfile must not fetch source, accept generic mounts, or expose a runtime socket.");
  }
  return {
    bytesByName,
    lock,
    lockDigest: sha256(Buffer.from(canonicalJson(lock))),
    profile,
    profileDigest: sha256(Buffer.from(canonicalJson(profile))),
    seccomp,
    seccompDigest: sha256(Buffer.from(canonicalJson(seccomp))),
  };
}

async function verifyLockedBaseImagePlatforms(lock) {
  for (const [name, image] of Object.entries(lock.baseRuntime)) {
    const inspected = await run("docker", ["buildx", "imagetools", "inspect", "--raw", image.reference]);
    const rawIndex = Buffer.from(inspected.stdout, "utf8");
    const referenceDigest = image.reference.split("@sha256:").at(-1);
    if (sha256(rawIndex) !== referenceDigest) {
      fail(`The registry bytes for the locked ${name} image do not match its multi-arch digest.`);
    }
    const index = parseJson(rawIndex, `Locked ${name} image index`);
    if (!Array.isArray(index.manifests)) fail(`The locked ${name} image is not a multi-arch OCI index.`);
    const platformDescriptors = index.manifests.filter(
      (descriptor) =>
        isPlainObject(descriptor) &&
        descriptor.platform?.os === "linux" &&
        descriptor.platform?.architecture === "amd64" &&
        (descriptor.platform?.variant === undefined || descriptor.platform.variant === ""),
    );
    if (
      platformDescriptors.length !== 1 ||
      platformDescriptors[0].digest !== image.platformManifestDigest ||
      !imageDigestPattern.test(platformDescriptors[0].digest)
    ) {
      fail(`The locked ${name} image does not resolve to its recorded linux/amd64 platform manifest.`);
    }
  }
}

function run(command, arguments_, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env ?? { PATH: process.env.PATH },
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (result.code !== 0) {
        rejectRun(
          new Error(`${command} failed (${result.code}${signal ? `/${signal}` : ""}): ${result.stderr.trim()}`),
        );
      } else {
        resolveRun(result);
      }
    });
  });
}

async function writeGitArchive(repository, lock, destination) {
  const canonicalRepository = resolve(repository);
  const repositoryStatus = await lstat(canonicalRepository);
  if (!repositoryStatus.isDirectory()) fail("The fast-manim source repository is not a directory.");
  const commitResult = await run("git", ["-C", canonicalRepository, "rev-parse", `${lock.fastManim.commit}^{commit}`]);
  if (commitResult.stdout.trim() !== lock.fastManim.commit)
    fail("The source repository does not contain the locked commit.");
  const treeResult = await run("git", ["-C", canonicalRepository, "rev-parse", `${lock.fastManim.commit}^{tree}`]);
  if (treeResult.stdout.trim() !== lock.fastManim.tree) fail("The locked fast-manim commit has an unexpected tree.");
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const child = spawn(
    "git",
    [
      "-C",
      canonicalRepository,
      "archive",
      "--format=tar.gz",
      `--prefix=${lock.fastManim.archive.prefix}`,
      lock.fastManim.commit,
    ],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const childCompletion = new Promise((resolveArchive, rejectArchive) => {
    child.once("error", rejectArchive);
    child.once("close", (code, signal) => {
      if (code === 0) resolveArchive();
      else {
        rejectArchive(
          new Error(
            `git archive failed (${code ?? 1}${signal ? `/${signal}` : ""}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      }
    });
  });
  try {
    await Promise.all([pipeline(child.stdout, output), childCompletion]);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function verifySourceArchive(path, lock) {
  const bytes = await readRegularFile(path, "fast-manim source archive");
  if (sha256(bytes) !== lock.fastManim.archive.sha256) {
    fail("The fast-manim source archive does not match the locked SHA-256 digest.");
  }
  const listing = await run("tar", ["--list", "--gzip", `--file=${path}`]);
  const entries = listing.stdout.split("\n").filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => !entry.startsWith(lock.fastManim.archive.prefix) || entry.includes("../"))
  ) {
    fail("The fast-manim source archive contains a path outside its fixed prefix.");
  }
}

async function assembleContext(verified, options) {
  let context;
  let temporary = false;
  if (options.contextDir) {
    context = resolve(options.contextDir);
    await mkdir(context, { mode: 0o700 });
  } else {
    context = await mkdtemp(join(tmpdir(), "poietra-fast-manim-oci-"));
    temporary = true;
  }
  try {
    for (const name of expectedContextFiles) {
      await copyFile(join(profileRoot, name), join(context, name), constants.COPYFILE_EXCL);
    }
    const archivePath = join(context, verified.lock.buildContext.sourceArchiveFile);
    if (options.sourceRepository) await writeGitArchive(options.sourceRepository, verified.lock, archivePath);
    else if (options.sourceArchive)
      await copyFile(resolve(options.sourceArchive), archivePath, constants.COPYFILE_EXCL);
    else fail("A locked source repository or preassembled source archive is required.");
    await verifySourceArchive(archivePath, verified.lock);
    const actual = (await readdir(context)).sort();
    const expected = [...expectedContextFiles, verified.lock.buildContext.sourceArchiveFile].sort();
    if (canonicalJson(actual) !== canonicalJson(expected))
      fail("The assembled build context contains an unexpected file.");
    return { context, temporary };
  } catch (error) {
    if (temporary) await rm(context, { force: true, recursive: true });
    throw error;
  }
}

async function extractInventory(imageDigest, lock) {
  const extractionRoot = await mkdtemp(join(tmpdir(), "poietra-fast-manim-inventory-"));
  let containerId;
  try {
    const created = await run("docker", ["container", "create", imageDigest]);
    containerId = created.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(containerId)) fail("Docker returned an invalid temporary container ID.");
    const destination = join(extractionRoot, "sbom.v1.json");
    await run("docker", ["container", "cp", `${containerId}:/opt/poietra/sbom.v1.json`, destination]);
    const bytes = await readRegularFile(destination, "runtime SBOM");
    const inventory = parseJson(bytes, "runtime SBOM");
    if (Buffer.from(`${canonicalJson(inventory)}\n`).compare(bytes) !== 0) {
      fail("The embedded runtime SBOM is not canonical JSON.");
    }
    validateRuntimeInventory(inventory, lock);
    const embeddedProfilePath = join(extractionRoot, "profile.v1.json");
    await run("docker", ["container", "cp", `${containerId}:/opt/poietra/profile.v1.json`, embeddedProfilePath]);
    const embeddedProfileBytes = await readRegularFile(embeddedProfilePath, "embedded OCI profile");
    const embeddedProfile = parseJson(embeddedProfileBytes, "embedded OCI profile");
    return {
      digest: sha256(Buffer.from(canonicalJson(inventory))),
      embeddedProfileDigest: sha256(Buffer.from(canonicalJson(embeddedProfile))),
      inventory,
    };
  } finally {
    if (containerId) await run("docker", ["container", "rm", "--force", containerId]).catch(() => undefined);
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

async function inspectLoadedImage(imageDigest, imageConfigDigest) {
  let localReference = imageDigest;
  let inspected;
  let usedConfigFallback = false;
  try {
    inspected = await run("docker", ["image", "inspect", imageDigest]);
  } catch {
    // Docker's containerd image store indexes the loaded manifest digest,
    // while the classic store may expose only the config digest from iidfile.
    // Both remain immutable; only the manifest digest leaves this local seam.
    localReference = imageConfigDigest;
    usedConfigFallback = true;
    inspected = await run("docker", ["image", "inspect", imageConfigDigest]);
  }
  const images = JSON.parse(inspected.stdout);
  if (
    !Array.isArray(images) ||
    images.length !== 1 ||
    (usedConfigFallback
      ? images[0]?.Id !== imageConfigDigest
      : ![imageDigest, imageConfigDigest].includes(images[0]?.Id))
  ) {
    fail("The locally loaded image does not match its config/manifest digest pair.");
  }
  return { config: images[0].Config, localReference };
}

async function buildImage(verified, assembled, noCache) {
  const buildRoot = await mkdtemp(join(tmpdir(), "poietra-fast-manim-build-"));
  try {
    const iidPath = join(buildRoot, "image.id");
    const metadataPath = join(buildRoot, "metadata.json");
    await run(
      "docker",
      [
        "buildx",
        "build",
        "--file",
        join(assembled.context, "Containerfile"),
        "--iidfile",
        iidPath,
        "--metadata-file",
        metadataPath,
        "--build-arg",
        `LOCKED_SOURCE_DATE_EPOCH=${verified.lock.fastManim.sourceDateEpoch}`,
        "--build-arg",
        `SOURCE_DATE_EPOCH=${verified.lock.fastManim.sourceDateEpoch}`,
        "--load",
        ...(noCache ? ["--no-cache"] : []),
        "--platform",
        verified.lock.platform,
        "--provenance=false",
        "--progress=plain",
        assembled.context,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    const imageConfigDigest = (await readFile(iidPath, "utf8")).trim();
    const metadata = parseJson(await readFile(metadataPath), "OCI build metadata");
    const imageDigest = metadata["containerimage.digest"];
    if (
      !imageDigestPattern.test(imageConfigDigest) ||
      !imageDigestPattern.test(imageDigest) ||
      metadata["containerimage.config.digest"] !== imageConfigDigest ||
      metadata["containerimage.descriptor"]?.digest !== imageDigest
    ) {
      fail("The OCI build did not return locked config and manifest digests.");
    }
    const loadedImage = await inspectLoadedImage(imageDigest, imageConfigDigest);
    const config = loadedImage.config;
    if (
      config?.User !== `${verified.profile.identity.uid}:${verified.profile.identity.gid}` ||
      config?.WorkingDir !== verified.profile.process.workingDirectory ||
      canonicalJson(config?.Entrypoint) !== canonicalJson(verified.profile.process.launcher) ||
      canonicalJson(config?.Cmd) !== canonicalJson(verified.profile.process.target)
    ) {
      fail("The image process configuration does not match the locked launcher/target profile.");
    }
    const imageEnvironment = Object.fromEntries((config.Env ?? []).map((entry) => entry.split(/=(.*)/s).slice(0, 2)));
    const expectedImageEnvironment = {
      GPG_KEY: "7169605F62C751356D054A26A821E680E5FA6305",
      PYTHON_SHA256: "c30bb24b7f1e9a19b11b55a546434f74e739bb4c271a3e3a80ff4380d49f7adb",
      PYTHON_VERSION: "3.12.11",
      ...verified.profile.environment,
    };
    if (canonicalJson(imageEnvironment) !== canonicalJson(expectedImageEnvironment)) {
      fail("The image environment is not the locked base metadata plus the fixed runtime allowlist.");
    }
    const inventory = await extractInventory(loadedImage.localReference, verified.lock);
    if (inventory.embeddedProfileDigest !== verified.profileDigest) {
      fail("The image-embedded runtime profile does not match the attested profile.");
    }
    const runtimeMaterial = {
      imageDigest,
      imageConfigDigest,
      inventoryDigest: inventory.digest,
      lockDigest: verified.lockDigest,
      profileDigest: verified.profileDigest,
      seccompDigest: verified.seccompDigest,
    };
    const attestation = {
      buildLockDigest: verified.lockDigest,
      fastManim: {
        archiveSha256: verified.lock.fastManim.archive.sha256,
        commit: verified.lock.fastManim.commit,
        tree: verified.lock.fastManim.tree,
      },
      imageConfigDigest,
      imageDigest,
      platform: verified.lock.platform,
      profileDigest: verified.profileDigest,
      runtimeDigest: sha256(Buffer.from(canonicalJson(runtimeMaterial))),
      sbom: {
        digest: inventory.digest,
        schema: inventory.inventory.schema,
        signed: false,
        toolchainDigest: sha256(Buffer.from(canonicalJson(inventory.inventory.toolchain))),
      },
      schema: "poietra.fast-manim-oci-build-attestation",
      seccompDigest: verified.seccompDigest,
      version: 1,
    };
    return {
      attestation,
      nativeArtifacts: inventory.inventory.artifacts.native,
    };
  } finally {
    await rm(buildRoot, { force: true, recursive: true });
  }
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["assemble", "build", "verify", "verify-platforms", "verify-reproducibility"].includes(command)) {
    fail(
      "Usage: fast-manim-oci-build.mjs <verify|verify-platforms|verify-reproducibility|assemble|build> [--source-repo PATH|--source-archive PATH] [--context-dir PATH] [--attestation PATH] [--no-cache true]",
    );
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--"))
      fail("Every OCI build option requires one value.");
    const name = {
      "--attestation": "attestation",
      "--context-dir": "contextDir",
      "--no-cache": "noCache",
      "--source-archive": "sourceArchive",
      "--source-repo": "sourceRepository",
    }[key];
    if (!name || options[name] !== undefined) fail(`Unknown or duplicate OCI build option: ${key}`);
    options[name] = value;
  }
  if (options.sourceArchive && options.sourceRepository) fail("Choose exactly one fast-manim source input.");
  if (["verify", "verify-platforms"].includes(command) && Object.keys(options).length !== 0) {
    fail(`${command} does not accept source or output options.`);
  }
  if (command === "assemble" && options.attestation) fail("assemble cannot emit a runtime attestation.");
  if (command === "verify-reproducibility" && (options.attestation || options.contextDir || options.noCache)) {
    fail("verify-reproducibility accepts only one locked source input.");
  }
  if (options.noCache !== undefined && (command !== "build" || options.noCache !== "true")) {
    fail("--no-cache accepts only the literal true on build.");
  }
  return { command, options };
}

async function writeNewFile(path, bytes) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const verified = await verifyTrackedInputs();
  if (command === "verify") {
    process.stdout.write(
      `${canonicalJson({ lockDigest: verified.lockDigest, profileDigest: verified.profileDigest, schema: "poietra.fast-manim-oci-verification", seccompDigest: verified.seccompDigest, version: 1 })}\n`,
    );
    return;
  }
  if (command === "verify-platforms") {
    await verifyLockedBaseImagePlatforms(verified.lock);
    process.stdout.write(
      `${canonicalJson({ platform: verified.lock.platform, schema: "poietra.fast-manim-oci-platform-verification", version: 1 })}\n`,
    );
    return;
  }
  await verifyLockedBaseImagePlatforms(verified.lock);
  const assembled = await assembleContext(verified, options);
  if (command === "assemble") {
    process.stdout.write(`${assembled.context}\n`);
    return;
  }
  try {
    if (command === "verify-reproducibility") {
      const first = await buildImage(verified, assembled, true);
      const second = await buildImage(verified, assembled, true);
      const nativeArtifactDigest = sha256(Buffer.from(canonicalJson(first.nativeArtifacts)));
      if (
        canonicalJson(first.nativeArtifacts) !== canonicalJson(second.nativeArtifacts) ||
        canonicalJson(first.attestation) !== canonicalJson(second.attestation)
      ) {
        fail("Cold OCI builds did not reproduce the installed native artifacts and attestation.");
      }
      process.stdout.write(
        `${canonicalJson({ imageConfigDigest: first.attestation.imageConfigDigest, imageDigest: first.attestation.imageDigest, nativeArtifactCount: first.nativeArtifacts.length, nativeArtifactDigest, runtimeDigest: first.attestation.runtimeDigest, sbomDigest: first.attestation.sbom.digest, schema: "poietra.fast-manim-oci-reproducibility", version: 1 })}\n`,
      );
      return;
    }
    const built = await buildImage(verified, assembled, options.noCache === "true");
    const output = `${canonicalJson(built.attestation)}\n`;
    if (options.attestation) await writeNewFile(options.attestation, output);
    else process.stdout.write(output);
  } finally {
    if (assembled.temporary) await rm(assembled.context, { force: true, recursive: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown OCI build failure.";
  process.stderr.write(`fast-manim OCI build failed: ${message}\n`);
  process.exitCode = 1;
});
