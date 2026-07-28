import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import {
  createFastManimLocalOciProbeContainerV1,
  MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_STDOUT_BYTES_V1,
  runFastManimLocalOciConformanceV1,
  runFastManimLocalOciProbeContainerV1,
} from "./fast-manim-local-oci-conformance";
import { createFastManimOciBrokerDispatchV1 } from "./fast-manim-oci-sandbox-profile";
import { FastManimSandboxRequestBundleV1 } from "./fast-manim-sandbox-backend";
import {
  fastManimSnapshotResultV1Schema,
  MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
} from "./fast-manim-snapshot-contract";
import { sandboxProducerRequest } from "./test-fixtures/fast-manim-sandbox-backend-fixture";

const realLaneEnabled = process.env.POIETRA_RUN_FAST_MANIM_OCI_REAL === "1";
const dockerAvailable =
  !realLaneEnabled || spawnSync("docker", ["info", "--format={{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
const attestationPath = process.env.POIETRA_FAST_MANIM_OCI_ATTESTATION?.trim();
const profile = JSON.parse(readFileSync(resolve("sandbox/fast-manim-oci/profile.v1.json"), "utf8"));

if (realLaneEnabled && !dockerAvailable) {
  throw new Error("The real fast-manim OCI conformance lane requires an available Docker daemon.");
}

const staticSceneSource = `from manim import *

class ExampleScene(Scene):
    def construct(self):
        circle = Circle().set_fill(BLUE, opacity=1).set_stroke(width=0)
        rectangle = Rectangle().set_fill(GREEN, opacity=1).set_stroke(width=0)
        line = Line(LEFT, RIGHT).set_stroke(WHITE, width=4)
        self.add(circle, rectangle, line)
`;

const securityProbe = String.raw`
import ctypes
import errno
import json
import os
import socket
import stat
import threading

checks = {}

def denied(callable_):
    try:
        callable_()
        return False
    except OSError as error:
        return error.errno in (errno.EACCES, errno.EPERM, errno.EROFS, errno.ENOSYS)

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long

def syscall_denied(number, *arguments):
    ctypes.set_errno(0)
    result = libc.syscall(ctypes.c_long(number), *(ctypes.c_ulong(argument) for argument in arguments))
    return result == -1 and ctypes.get_errno() in (errno.EACCES, errno.EPERM, errno.ENOSYS)

checks["uid"] = os.getuid() == 65532 and os.geteuid() == 65532
checks["gid"] = os.getgid() == 65532 and os.getegid() == 65532 and all(group == 65532 for group in os.getgroups()) and len(os.getgroups()) <= 1
status = {}
with open("/proc/self/status", encoding="utf-8") as source:
    for line in source:
        if ":" in line:
            key, value = line.split(":", 1)
            status[key] = value.strip()
checks["capabilities_empty"] = all(int(status[name], 16) == 0 for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"))
checks["no_new_privileges"] = status.get("NoNewPrivs") == "1"
checks["private_pid_namespace"] = os.getpid() == 1
checks["setuid_root_denied"] = denied(lambda: os.setuid(0))

class CapabilityHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]
class CapabilityData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]
header = CapabilityHeader(0x20080522, 0)
data = (CapabilityData * 2)()
data[0].effective = 1 << 21
data[0].permitted = 1 << 21
ctypes.set_errno(0)
checks["capability_escalation_denied"] = libc.capset(ctypes.byref(header), ctypes.byref(data)) == -1 and ctypes.get_errno() == errno.EPERM

def append_byte(path):
    with open(path, "ab") as output:
        output.write(b"x")

checks["rootfs_read_only"] = denied(lambda: append_byte("/opt/poietra/profile.v1.json"))
checks["etc_not_writable"] = denied(lambda: append_byte("/etc/hosts"))
checks["proc_read_only"] = denied(lambda: append_byte("/proc/sys/kernel/hostname"))
runtime_probe = "/run/poietra/conformance-write"
with open(runtime_probe, "wb") as output:
    output.write(b"ok")
checks["request_tmpfs_writable"] = open(runtime_probe, "rb").read() == b"ok"
os.unlink(runtime_probe)
checks["request_tmpfs_size"] = os.statvfs("/run/poietra").f_blocks * os.statvfs("/run/poietra").f_frsize <= 16 * 1024 * 1024
checks["request_tmpfs_inodes"] = os.statvfs("/run/poietra").f_files <= 4096
checks["shm_tmpfs_size"] = os.statvfs("/dev/shm").f_blocks * os.statvfs("/dev/shm").f_frsize <= 4 * 1024 * 1024
checks["shm_tmpfs_inodes"] = os.statvfs("/dev/shm").f_files <= 1024
with open("/proc/self/mountinfo", encoding="utf-8") as source:
    mountinfo = source.read()
checks["tmpfs_mount_options"] = all(
    destination in mountinfo and all(option in next(line for line in mountinfo.splitlines() if f" {destination} " in line) for option in ("rw", "nodev", "noexec", "nosuid"))
    for destination in ("/run/poietra", "/dev/shm")
)
asset_root = "/opt/poietra/assets"
asset_manifest = asset_root + "/.poietra-assets.v1.json"
asset_root_status = os.lstat(asset_root)
asset_manifest_status = os.lstat(asset_manifest)
checks["asset_root_locked"] = stat.S_ISDIR(asset_root_status.st_mode) and stat.S_IMODE(asset_root_status.st_mode) == 0o555 and asset_root_status.st_uid == 0 and asset_root_status.st_gid == 0
checks["asset_manifest_locked"] = stat.S_ISREG(asset_manifest_status.st_mode) and stat.S_IMODE(asset_manifest_status.st_mode) == 0o444 and asset_manifest_status.st_uid == 0 and asset_manifest_status.st_gid == 0 and asset_manifest_status.st_nlink == 1
checks["asset_volume_read_only"] = denied(lambda: open(asset_root + "/write-probe", "wb")) and denied(lambda: os.chmod(asset_manifest, 0o644)) and denied(lambda: os.unlink(asset_manifest))
asset_mount_line = next(line for line in mountinfo.splitlines() if f" {asset_root} " in line)
checks["asset_mount_read_only"] = " ro," in asset_mount_line or " ro " in asset_mount_line
with open(asset_manifest, encoding="utf-8") as source:
    asset_manifest_value = json.load(source)
checks["asset_manifest_exact"] = asset_manifest_value == {"assets": [], "count": 0, "schema": "poietra.fast-manim-oci-asset-manifest", "version": 1}

checks["host_paths_absent"] = all(
    not os.path.exists(path)
    for path in ("/workspace", "/host", "/var/run/docker.sock", "/run/docker.sock", "/root/.aws", "/root/.config/gcloud")
)
checks["credentials_absent"] = all(
    name not in os.environ
    for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GITHUB_TOKEN", "DOCKER_HOST")
)
checks["private_home"] = os.environ.get("HOME") == "/run/poietra/home"

for name, family, kind in (
    ("ipv4_tcp", socket.AF_INET, socket.SOCK_STREAM),
    ("ipv4_udp", socket.AF_INET, socket.SOCK_DGRAM),
    ("ipv4_raw", socket.AF_INET, socket.SOCK_RAW),
    ("ipv6_tcp", socket.AF_INET6, socket.SOCK_STREAM),
    ("unix_socket", socket.AF_UNIX, socket.SOCK_STREAM),
):
    checks[f"socket_{name}_denied"] = denied(lambda family=family, kind=kind: socket.socket(family, kind))
checks["socketpair_denied"] = denied(socket.socketpair)
try:
    socket.getaddrinfo("example.com", 443)
    checks["dns_denied"] = False
except (OSError, socket.gaierror):
    checks["dns_denied"] = True

for name, number in (
    ("mount", 165),
    ("umount2", 166),
    ("ptrace", 101),
    ("perf_event_open", 298),
    ("open_by_handle_at", 304),
    ("setns", 308),
    ("bpf", 321),
    ("userfaultfd", 323),
    ("unshare", 272),
):
    checks[f"syscall_{name}_denied"] = syscall_denied(number, 0, 0, 0, 0, 0)

for name, flag in (
    ("NEWCGROUP", 0x02000000),
    ("NEWIPC", 0x08000000),
    ("NEWNET", 0x40000000),
    ("NEWNS", 0x00020000),
    ("NEWPID", 0x20000000),
    ("NEWTIME", 0x00000080),
    ("NEWUSER", 0x10000000),
    ("NEWUTS", 0x04000000),
):
    checks[f"clone_{name}_denied"] = syscall_denied(56, flag | 17, 0, 0, 0, 0)

thread_marker = []
thread = threading.Thread(target=lambda: thread_marker.append("ok"))
thread.start()
thread.join()
checks["ordinary_threads_work"] = thread_marker == ["ok"]

print(json.dumps({"checks": checks}, separators=(",", ":"), sort_keys=True))
`;

function loadAttestation() {
  if (!attestationPath) {
    throw new Error("POIETRA_FAST_MANIM_OCI_ATTESTATION is required when the real OCI conformance lane is enabled.");
  }
  return JSON.parse(readFileSync(resolve(attestationPath), "utf8"));
}

function jobContext() {
  return {
    attestationDigest: "a".repeat(64),
    deadlineEpochMs: Date.now() + 120_000,
    identity: { projectId: "default", requestId: "oci-real-request", tenantId: "oci-real-tenant" },
    signal: new AbortController().signal,
  };
}

describe.skipIf(!realLaneEnabled)("real fast-manim rootless OCI conformance", () => {
  it("runs the static Circle+Rectangle+Line producer through stdin with digest-injected assets", {
    timeout: 300_000,
  }, async () => {
    const sourceHash = createHash("sha256").update(staticSceneSource, "utf8").digest("hex");
    const request = new FastManimSandboxRequestBundleV1({
      ...sandboxProducerRequest(),
      sourceHash,
      sourceText: staticSceneSource,
    });
    const assetBytes = Buffer.from("unused immutable conformance asset", "utf8");
    const attestation = loadAttestation();
    const dispatch = createFastManimOciBrokerDispatchV1({
      assets: [{ bytes: assetBytes, sha256: createHash("sha256").update(assetBytes).digest("hex") }],
      attestation,
      context: jobContext(),
      profile,
      request,
    });
    const execution = await runFastManimLocalOciConformanceV1({
      attestation,
      dispatch,
      maximumStdoutBytes: MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_STDOUT_BYTES_V1,
      profile,
    });
    expect(execution.cleanupVerified).toBe(true);
    expect(execution.exitCode).toBe(0);
    const stdout = Buffer.from(execution.stdout);
    expect(stdout.byteLength).toBeLessThanOrEqual(MAX_FAST_MANIM_SOURCE_RUNTIME_IDENTITY_STDOUT_BYTES_V1);
    expect(stdout.at(-1)).toBe(0x0a);
    const canonicalOutput = stdout.subarray(0, -1).toString("utf8");
    const combined = JSON.parse(canonicalOutput) as {
      evidence?: { kind?: string; records?: readonly { status?: string }[]; snapshotDigest?: string };
      schema?: string;
      snapshot?: unknown;
      snapshotDigest?: string;
      version?: number;
    };
    expect(canonicalOutput.startsWith("{") && canonicalOutput.endsWith("}")).toBe(true);
    expect(Object.keys(combined).sort()).toEqual(["evidence", "schema", "snapshot", "snapshotDigest", "version"]);
    expect(combined.schema).toBe("poietra.fast-manim-source-runtime-identity");
    expect(combined.version).toBe(1);
    expect(combined.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(combined.evidence?.snapshotDigest).toBe(combined.snapshotDigest);
    expect(combined.evidence?.kind).toBe("complete");
    expect(combined.evidence?.records).toHaveLength(3);
    expect(combined.evidence?.records?.every((record) => record.status === "mapped")).toBe(true);
    expect(Buffer.byteLength(canonicalJsonV1(combined.snapshot), "utf8")).toBeLessThanOrEqual(
      MAX_FAST_MANIM_SNAPSHOT_RESULT_JSON_BYTES,
    );
    const result = fastManimSnapshotResultV1Schema.parse(combined.snapshot);
    expect(result.kind).toBe("compiled");
    if (result.kind !== "compiled") throw new Error("Expected a compiled static snapshot result.");
    const bundle = result.bundle as { scene?: { entities?: unknown[] } };
    expect(bundle.scene?.entities).toHaveLength(3);
  });

  it("denies escalation, networking, mount/ptrace, and every clone namespace bit while allowing threads", {
    timeout: 120_000,
  }, async () => {
    const attestation = loadAttestation();
    const probe = await createFastManimLocalOciProbeContainerV1({ attestation, profile, program: securityProbe });
    const execution = await runFastManimLocalOciProbeContainerV1(probe);
    expect(execution.code).toBe(0);
    const evidence = JSON.parse(execution.stdout.toString("utf8")) as { checks: Record<string, boolean> };
    expect(Object.keys(evidence.checks).length).toBeGreaterThan(35);
    expect(Object.entries(evidence.checks).filter(([, passed]) => !passed)).toEqual([]);
  });

  it("kills output overflow and proves container plus request-volume cleanup", { timeout: 120_000 }, async () => {
    const attestation = loadAttestation();
    const volumesBefore = spawnSync("docker", ["volume", "ls", "--quiet", "--filter", "name=^poietra-assets-"], {
      encoding: "utf8",
    }).stdout;
    const probe = await createFastManimLocalOciProbeContainerV1({
      attestation,
      profile,
      program: 'import os; os.write(1, b"x" * 2048)',
    });
    await expect(runFastManimLocalOciProbeContainerV1(probe, 1024)).rejects.toThrow(/byte budget/i);
    expect(spawnSync("docker", ["container", "inspect", probe.containerId]).status).not.toBe(0);
    const volumesAfter = spawnSync("docker", ["volume", "ls", "--quiet", "--filter", "name=^poietra-assets-"], {
      encoding: "utf8",
    }).stdout;
    expect(volumesAfter).toBe(volumesBefore);
  });
});
