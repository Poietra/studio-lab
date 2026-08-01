import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "vite";

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with ${signal ?? code ?? "unknown status"}.`));
    });
  });
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "poietra-account-e2e-"));
const certificatePath = join(temporaryDirectory, "certificate.pem");
const keyPath = join(temporaryDirectory, "key.pem");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    rmSync(temporaryDirectory, { force: true, recursive: true });
    process.kill(process.pid, signal);
  });
}
const environment = {
  ...process.env,
  POIETRA_AI_DEBUG_LOG: "off",
  POIETRA_ACCOUNT_E2E_CERT: certificatePath,
  POIETRA_ACCOUNT_E2E_KEY: keyPath,
};
process.env.POIETRA_ACCOUNT_E2E_CERT = certificatePath;
process.env.POIETRA_ACCOUNT_E2E_KEY = keyPath;
process.env.POIETRA_AI_DEBUG_LOG = "off";

try {
  await run(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { env: environment, stdio: "ignore" },
  );
  await build({ configFile: resolve("e2e/account-production-vite.config.ts"), configLoader: "runner" });
  await run("pnpm", ["exec", "playwright", "test", "--config", "playwright.account.config.ts"], { env: environment });
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
