import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FullConfig, FullResult, Reporter } from "@playwright/test/reporter";

import {
  realPreviewRunStateFromEnvironmentV1,
  realPreviewRunStateSummaryV1,
  reclaimRealPreviewRunStateV1,
} from "./real-preview-run-state";

/**
 * Global teardown for the real-preview lanes. It runs on `onExit`, after the
 * dev server that owns the run's workspace store has stopped, so one contract
 * covers V4, V7, V9, and every other mutable harness instead of each spec
 * reclaiming its own state. Cleanup problems are reported on their own line and
 * never rewrite the run status the tests produced.
 */
export default class RealPreviewRunReporter implements Reporter {
  #outputRoot = join(process.cwd(), "test-results");
  #status: FullResult["status"] = "interrupted";

  onBegin(config: FullConfig) {
    this.#outputRoot = config.projects[0]?.outputDir ?? this.#outputRoot;
  }

  onEnd(result: FullResult) {
    this.#status = result.status;
  }

  async onExit() {
    const namespace = realPreviewRunStateFromEnvironmentV1(process.env, this.#outputRoot, tmpdir());
    if (!namespace) return;
    let result: ReturnType<typeof reclaimRealPreviewRunStateV1>;
    try {
      result = reclaimRealPreviewRunStateV1({
        ...namespace,
        now: Date.now(),
        outcome: this.#status === "passed" ? "passed" : "failed",
      });
    } catch (cause) {
      process.stderr.write(`real-preview teardown failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      return;
    }
    process.stdout.write(`${realPreviewRunStateSummaryV1(result)}\n`);
    for (const failure of result.failures) process.stderr.write(`real-preview teardown failed: ${failure}\n`);
  }
}
