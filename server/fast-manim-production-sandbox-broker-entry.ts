import { pathToFileURL } from "node:url";

import { z } from "zod";

import { fastManimGatedOciSignedReleaseV1Schema } from "./fast-manim-gated-oci-release";
import {
  type FastManimProductionSandboxBrokerServiceOptionsV1,
  startFastManimProductionSandboxBrokerServiceV1,
} from "./fast-manim-production-sandbox-broker-service";
import { readRootOwnedProductionConfigV1 } from "./root-owned-production-config";

const keyIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const configSchema = z
  .object({
    brokerUserId: z.number().int().positive().max(0xffff_ffff),
    dockerSocketPath: z.string().min(1).max(4_096),
    publicKeys: z
      .array(z.object({ keyId: keyIdSchema, publicKeyPem: z.string().min(1).max(16_384) }).strict())
      .min(1)
      .max(32),
    seccompPath: z.string().min(1).max(4_096),
    signedRelease: fastManimGatedOciSignedReleaseV1Schema,
    socketGroupId: z.number().int().nonnegative().max(0xffff_ffff),
    socketPath: z.string().min(1).max(4_096),
  })
  .strict();

export async function readFastManimProductionSandboxBrokerConfigV1(path: string) {
  return readRootOwnedProductionConfigV1(path, configSchema);
}

export async function startFastManimProductionSandboxBrokerEntryV1(configPath: string) {
  const config = await readFastManimProductionSandboxBrokerConfigV1(configPath);
  const controller = new AbortController();
  let broker: Awaited<ReturnType<typeof startFastManimProductionSandboxBrokerServiceV1>> | undefined;
  let shutdownRequest: Promise<void> | undefined;
  const removeSignals = () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  const onSignal = () => {
    controller.abort();
    if (broker) {
      shutdownRequest ??= broker.close().finally(removeSignals);
      void shutdownRequest.catch(() => {
        process.exitCode = 1;
      });
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    broker = await startFastManimProductionSandboxBrokerServiceV1({
      ...(config as FastManimProductionSandboxBrokerServiceOptionsV1),
      signal: controller.signal,
    });
    void broker.fatal.then(() => {
      if (controller.signal.aborted) return;
      process.exitCode = 1;
      shutdownRequest ??= broker!.close().finally(removeSignals);
      void shutdownRequest.catch(() => undefined);
    });
    if (controller.signal.aborted) await broker.close();
    return broker;
  } catch (error) {
    removeSignals();
    throw error;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const [configPath, extra] = process.argv.slice(2);
  if (!configPath || extra) {
    console.error("Usage: fast-manim-sandbox-broker <absolute-config-path>");
    process.exitCode = 2;
  } else {
    void startFastManimProductionSandboxBrokerEntryV1(configPath).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("The production sandbox broker failed closed.");
      process.exitCode = 1;
    });
  }
}
