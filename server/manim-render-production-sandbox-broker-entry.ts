import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  type ManimRenderProductionSandboxBrokerServiceOptionsV1,
  startManimRenderProductionSandboxBrokerServiceV1,
} from "./manim-render-production-sandbox-broker-service";
import { readRootOwnedProductionConfigV1 } from "./root-owned-production-config";

export const manimRenderProductionSandboxBrokerConfigV1Schema = z
  .object({
    brokerUserId: z.number().int().positive().max(0xffff_ffff),
    dockerSocketPath: z.string().min(1).max(4_096),
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    seccompPath: z.string().min(1).max(4_096),
    socketGroupId: z.number().int().nonnegative().max(0xffff_ffff),
    socketPath: z.string().min(1).max(4_096),
    stagingRoot: z.string().min(1).max(4_096),
  })
  .strict();

export function parseManimRenderProductionSandboxBrokerConfigV1(value: unknown) {
  return manimRenderProductionSandboxBrokerConfigV1Schema.parse(value);
}

export function readManimRenderProductionSandboxBrokerConfigV1(path: string) {
  return readRootOwnedProductionConfigV1(path, manimRenderProductionSandboxBrokerConfigV1Schema);
}

export async function startManimRenderProductionSandboxBrokerEntryV1(configPath: string) {
  const config = await readManimRenderProductionSandboxBrokerConfigV1(configPath);
  let broker: Awaited<ReturnType<typeof startManimRenderProductionSandboxBrokerServiceV1>> | undefined;
  let shutdownRequested = false;
  let shutdown: Promise<void> | undefined;
  const removeSignals = () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  const beginShutdown = () => {
    shutdownRequested = true;
    if (broker) shutdown ??= broker.close().finally(removeSignals);
    return shutdown;
  };
  const onSignal = () => {
    void beginShutdown()?.catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    broker = await startManimRenderProductionSandboxBrokerServiceV1(
      config as ManimRenderProductionSandboxBrokerServiceOptionsV1,
    );
    void broker.fatal.then(() => {
      process.exitCode = 1;
      void beginShutdown()?.catch(() => undefined);
    });
    if (shutdownRequested) await beginShutdown();
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
    console.error("Usage: manim-render-sandbox-broker <absolute-config-path>");
    process.exitCode = 2;
  } else {
    void startManimRenderProductionSandboxBrokerEntryV1(configPath).catch(() => {
      console.error("The production render sandbox broker failed closed.");
      process.exitCode = 1;
    });
  }
}
