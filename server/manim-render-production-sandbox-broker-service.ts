import { assertFastManimProductionHostMaterialsV1 } from "./fast-manim-production-gated-oci-backend";
import { FastManimGatedOciDockerClientV1 } from "./fast-manim-gated-oci-job-runner";
import { ManimRenderGatedOciJobRunnerV1 } from "./manim-render-gated-oci-job-runner";
import { startManimRenderSandboxBrokerServerV1 } from "./manim-render-sandbox-broker-server";
import { ManimRenderGatedOciBackendV1 } from "./manim-render-sandbox-backend";
import { assertFastManimProductionBrokerSocketDirectoryV1 } from "./fast-manim-production-sandbox-transport";

export type ManimRenderProductionSandboxBrokerServiceOptionsV1 = Readonly<{
  brokerUserId: number;
  dockerSocketPath: string;
  imageDigest: string;
  seccompPath: string;
  socketGroupId: number;
  socketPath: string;
  stagingRoot: string;
}>;

function brokerIdentity(expected: number) {
  const actual = process.geteuid?.();
  if (!Number.isSafeInteger(expected) || expected <= 0 || actual === undefined || actual !== expected) {
    throw new TypeError("The render sandbox broker must run as its configured non-root user.");
  }
}

async function assertRootlessDocker(client: FastManimGatedOciDockerClientV1) {
  const result = await client.run(["info", "--format", "{{json .}}"]);
  if (result.code !== 0 || result.stdout.byteLength === 0 || result.stdout.byteLength > 32 * 1024) {
    throw new TypeError("The render sandbox Docker runtime is unavailable.");
  }
  let info: Record<string, unknown>;
  try {
    info = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new TypeError("The render sandbox Docker runtime report is malformed.");
  }
  if (
    info.OSType !== "linux" ||
    info.CgroupVersion !== "2" ||
    info.CgroupDriver !== "systemd" ||
    !Array.isArray(info.SecurityOptions) ||
    !info.SecurityOptions.includes("name=rootless")
  ) {
    throw new TypeError("The render sandbox requires rootless Docker with systemd cgroup v2.");
  }
}

/** Shipped broker composition: no executor or Docker transport injection seam is accepted. */
export async function startManimRenderProductionSandboxBrokerServiceV1(
  options: ManimRenderProductionSandboxBrokerServiceOptionsV1,
) {
  if (
    !options ||
    Object.keys(options).sort().join(",") !==
      "brokerUserId,dockerSocketPath,imageDigest,seccompPath,socketGroupId,socketPath,stagingRoot"
  ) {
    throw new TypeError("The production render broker configuration is invalid.");
  }
  brokerIdentity(options.brokerUserId);
  await Promise.all([
    assertFastManimProductionHostMaterialsV1(options.dockerSocketPath, options.seccompPath),
    assertFastManimProductionBrokerSocketDirectoryV1(options.socketPath, options.brokerUserId, options.socketGroupId),
  ]);
  const dockerClient = new FastManimGatedOciDockerClientV1({ socketPath: options.dockerSocketPath });
  await assertRootlessDocker(dockerClient);
  const runner = new ManimRenderGatedOciJobRunnerV1({
    cgroupKillPolicy: "required",
    dockerClient,
    image: options.imageDigest,
    seccompPath: options.seccompPath,
    stagingGroupId: options.socketGroupId,
    stagingRoot: options.stagingRoot,
  });
  const backend = new ManimRenderGatedOciBackendV1(runner);
  try {
    return await startManimRenderSandboxBrokerServerV1({
      backend,
      ownerDigest: runner.stagingRootDigest,
      reconcileOrphans: async () => {
        if (!(await runner.ready())) throw new TypeError("The fixed render OCI runtime is not ready.");
        await runner.reconcileOrphans();
      },
      socketGroupId: options.socketGroupId,
      socketPath: options.socketPath,
    });
  } catch (error) {
    try {
      await backend.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "The render broker failed to start and clean up.");
    }
    throw error;
  }
}
