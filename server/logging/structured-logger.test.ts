import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createRotatingJsonlSink,
  createStructuredLogger,
  type StructuredLogRecord,
} from "./structured-logger";

describe("structured logger", () => {
  it("binds request context and redacts sensitive fields", () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      sinks: [{ write: (record) => records.push(record) }],
    }).child({ requestId: "request-1", route: "/api/example" });

    logger.info("request.received", {
      authorization: "Bearer secret",
      clarification: { answer: { kind: "text", text: "はい" } },
    });

    expect(records).toEqual([{
      context: { requestId: "request-1", route: "/api/example" },
      data: {
        authorization: "[REDACTED]",
        clarification: { answer: { kind: "text", text: "はい" } },
      },
      event: "request.received",
      level: "info",
      timestamp: "2026-07-21T00:00:00.000Z",
    }]);
  });

  it("rotates JSONL output at the configured size", () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-log-"));
    try {
      const sink = createRotatingJsonlSink({ logPath: "api.jsonl", maxBytes: 220, root });
      const logger = createStructuredLogger({ sinks: [sink] });
      logger.info("first", { value: "a".repeat(80) });
      logger.info("second", { value: "b".repeat(80) });

      expect(readFileSync(`${sink.path}.previous`, "utf8")).toContain('"event":"first"');
      expect(readFileSync(sink.path, "utf8")).toContain('"event":"second"');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
