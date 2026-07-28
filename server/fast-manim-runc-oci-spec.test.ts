import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalJsonV1 } from "../src/engine/fast-manim-snapshot-digest";
import type { LinuxCgroupV2LaunchEnvelopeV1 } from "./fast-manim-linux-cgroup-v2";
import { FastManimRuncOciSpecGeneratorV1 } from "./fast-manim-runc-oci-spec";

const profile = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/profile.v1.json", import.meta.url), "utf8"));
const seccomp = JSON.parse(readFileSync(new URL("../sandbox/fast-manim-oci/seccomp.v1.json", import.meta.url), "utf8"));
const seccompDigest = createHash("sha256").update(canonicalJsonV1(seccomp), "utf8").digest("hex");

function launch(overrides: Record<string, unknown> = {}) {
  return {
    cgroupsPath: "poietra-sandbox-v1/poietra-job-v1-aabbccdd-1",
    deadlineEpochMs: Date.now() + 60_000,
    mustStartInCgroup: true,
    productionMembership: { state: "requires-direct-start-verification" },
    rlimits: { cpuTimeSeconds: 30, fileBytes: 67_108_864, openFiles: 256 },
    tmpfs: {
      runtime: { maximumInodes: 4096, sizeBytes: 16_777_216 },
      sharedMemory: { maximumInodes: 1024, sizeBytes: 4_194_304 },
    },
    ...overrides,
  } as unknown as LinuxCgroupV2LaunchEnvelopeV1;
}

function generator(overrides: Record<string, unknown> = {}) {
  return new FastManimRuncOciSpecGeneratorV1({
    assetsSourcePath: "/srv/poietra/jobs/aabbccdd/assets",
    expectedSeccompDigest: seccompDigest,
    profile,
    rootfsPath: "/srv/poietra/images/runtime/rootfs",
    seccomp,
    ...overrides,
  });
}

describe("FastManimRuncOciSpecGeneratorV1", () => {
  it("emits one closed OCI config from immutable profile and resource inputs", () => {
    const spec = generator().generate(
      launch({
        argv: ["/bin/sh"],
        env: ["AWS_SECRET_ACCESS_KEY=request-controlled"],
        mounts: [{ destination: "/host", source: "/" }],
      }),
    );

    expect(spec).toMatchObject({
      hostname: "poietra-sandbox",
      linux: {
        cgroupsPath: "poietra-sandbox-v1/poietra-job-v1-aabbccdd-1",
        devices: [
          { fileMode: 0o666, gid: 0, major: 1, minor: 3, path: "/dev/null", type: "c", uid: 0 },
          { fileMode: 0o666, gid: 0, major: 1, minor: 5, path: "/dev/zero", type: "c", uid: 0 },
          { fileMode: 0o666, gid: 0, major: 1, minor: 7, path: "/dev/full", type: "c", uid: 0 },
          { fileMode: 0o666, gid: 0, major: 1, minor: 8, path: "/dev/random", type: "c", uid: 0 },
          { fileMode: 0o666, gid: 0, major: 1, minor: 9, path: "/dev/urandom", type: "c", uid: 0 },
          { fileMode: 0o666, gid: 0, major: 5, minor: 0, path: "/dev/tty", type: "c", uid: 0 },
        ],
        namespaces: [
          { type: "pid" },
          { type: "network" },
          { type: "mount" },
          { type: "ipc" },
          { type: "uts" },
          { type: "cgroup" },
        ],
        seccomp: {
          architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
          defaultAction: "SCMP_ACT_ERRNO",
          defaultErrnoRet: 1,
        },
        resources: {
          devices: [
            { access: "rwm", allow: false },
            { access: "rwm", allow: true, major: 1, minor: 3, type: "c" },
            { access: "rwm", allow: true, major: 1, minor: 5, type: "c" },
            { access: "rwm", allow: true, major: 1, minor: 7, type: "c" },
            { access: "rwm", allow: true, major: 1, minor: 8, type: "c" },
            { access: "rwm", allow: true, major: 1, minor: 9, type: "c" },
            { access: "rwm", allow: true, major: 5, minor: 0, type: "c" },
          ],
        },
      },
      ociVersion: "1.2.0",
      process: {
        args: [
          "/opt/venv/bin/python",
          "/opt/poietra/entrypoint.py",
          "/opt/venv/bin/python",
          "-m",
          "manim.renderer.source_runtime_identity",
        ],
        capabilities: { ambient: [], bounding: [], effective: [], inheritable: [], permitted: [] },
        cwd: "/run/poietra",
        noNewPrivileges: true,
        rlimits: [
          { hard: 0, soft: 0, type: "RLIMIT_CORE" },
          { hard: 30, soft: 30, type: "RLIMIT_CPU" },
          { hard: 67_108_864, soft: 67_108_864, type: "RLIMIT_FSIZE" },
          { hard: 256, soft: 256, type: "RLIMIT_NOFILE" },
        ],
        terminal: false,
        user: { additionalGids: [], gid: 65532, uid: 65532 },
      },
      root: { path: "/srv/poietra/images/runtime/rootfs", readonly: true },
    });
    expect(spec.process.env).toContain("PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin");
    expect(spec.process.env.some((entry) => entry.includes("AWS_SECRET"))).toBe(false);
    expect(spec.linux.seccomp.architectures).not.toContain("SCMP_ARCH_AARCH64");
    expect(spec.mounts).toEqual([
      { destination: "/proc", options: ["nosuid", "noexec", "nodev"], source: "proc", type: "proc" },
      {
        destination: "/dev",
        options: ["nosuid", "noexec", "strictatime", "mode=755", "size=65536"],
        source: "tmpfs",
        type: "tmpfs",
      },
      {
        destination: "/dev/pts",
        options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"],
        source: "devpts",
        type: "devpts",
      },
      {
        destination: "/run/poietra",
        options: ["nodev", "noexec", "nosuid", "mode=1777", "size=16777216", "nr_inodes=4096"],
        source: "tmpfs",
        type: "tmpfs",
      },
      {
        destination: "/dev/shm",
        options: ["nodev", "noexec", "nosuid", "mode=1777", "size=4194304", "nr_inodes=1024"],
        source: "tmpfs",
        type: "tmpfs",
      },
      {
        destination: "/opt/poietra/assets",
        options: ["rbind", "ro", "nosuid", "nodev", "noexec"],
        source: "/srv/poietra/jobs/aabbccdd/assets",
        type: "bind",
      },
    ]);
    expect(() => canonicalJsonV1(spec)).not.toThrow();
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.linux.seccomp.syscalls[0]?.names)).toBe(true);
  });

  it.each([
    ["relative/rootfs", "/srv/poietra/jobs/aabbccdd/assets"],
    ["/srv/poietra//rootfs", "/srv/poietra/jobs/aabbccdd/assets"],
    ["/srv/poietra/images/../rootfs", "/srv/poietra/jobs/aabbccdd/assets"],
    ["/srv/poietra/images/rootfs/", "/srv/poietra/jobs/aabbccdd/assets"],
    ["/", "/srv/poietra/jobs/aabbccdd/assets"],
    ["/srv/poietra/images/rootfs", "relative/assets"],
    ["/srv/poietra/images/rootfs", "/srv/poietra/jobs/../assets"],
    ["/srv/poietra/images/rootfs", "/"],
  ])("rejects non-canonical or non-absolute broker paths (%s, %s)", (rootfsPath, assetsSourcePath) => {
    expect(() => generator({ assetsSourcePath, rootfsPath })).toThrow(/canonical absolute/i);
  });

  it("verifies the Docker seccomp digest before converting its architecture map", () => {
    const changed = structuredClone(seccomp);
    changed.archMap[0].architecture = "SCMP_ARCH_AARCH64";
    expect(() => generator({ seccomp: changed })).toThrow(/digest/i);

    const changedDigest = createHash("sha256").update(canonicalJsonV1(changed), "utf8").digest("hex");
    expect(() => generator({ expectedSeccompDigest: changedDigest, seccomp: changed })).toThrow(/architecture/i);
  });

  it("rejects a non-canonical cgroupsPath and tmpfs limits beyond the locked profile", () => {
    expect(() => generator().generate(launch({ cgroupsPath: "/poietra-sandbox-v1/job" }))).toThrow(/cgroupsPath/i);
    expect(() => generator().generate(launch({ cgroupsPath: "poietra-sandbox-v1/../job" }))).toThrow(/cgroupsPath/i);
    expect(() =>
      generator().generate(
        launch({
          tmpfs: {
            runtime: { maximumInodes: 4096, sizeBytes: 16_777_217 },
            sharedMemory: { maximumInodes: 1024, sizeBytes: 4_194_304 },
          },
        }),
      ),
    ).toThrow(/exceeds/i);
  });

  it("rejects stale membership gates and expired launch envelopes", () => {
    expect(() =>
      generator().generate(launch({ productionMembership: { state: "not-connected", trackingIssue: 127 } })),
    ).toThrow(/launch envelope/i);
    expect(() => generator().generate(launch({ deadlineEpochMs: Date.now() - 1 }))).toThrow(/launch envelope/i);
    expect(() => generator().generate(launch({ deadlineEpochMs: 0 }))).toThrow(/launch envelope/i);
  });
});
