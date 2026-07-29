import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createRotatingJsonlSink, createStructuredLogger, type StructuredLogRecord } from "./structured-logger";

describe("structured logger", () => {
  it("binds request context and redacts sensitive fields", () => {
    const records: StructuredLogRecord[] = [];
    const logger = createStructuredLogger({
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      sinks: [{ write: (record) => records.push(record) }],
    }).child({ requestId: "request-1", route: "/api/example" });

    logger.info("request.received", {
      accessToken: "access-secret",
      authorization: "Bearer secret",
      clarification: { answer: { kind: "text", text: "はい" } },
      password: "password-secret",
      "x-api-key": "key-secret",
    });

    expect(records).toEqual([
      {
        context: { requestId: "request-1", route: "/api/example" },
        data: {
          accessToken: "[REDACTED]",
          authorization: "[REDACTED]",
          clarification: { answer: { kind: "text", text: "はい" } },
          password: "[REDACTED]",
          "x-api-key": "[REDACTED]",
        },
        event: "request.received",
        level: "info",
        timestamp: "2026-07-21T00:00:00.000Z",
      },
    ]);
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

  it("removes executable and private failure details before records reach a sink", () => {
    const root = mkdtempSync(join(tmpdir(), "poietra-error-log-"));
    const sentinel = "/private/SECRET_ERROR_PATH/source.py\nSECRET_TRACEBACK";
    try {
      const error = new Error(sentinel, { cause: new Error(`nested ${sentinel}`) });
      Object.defineProperties(error, {
        detail: { enumerable: true, value: { source: sentinel } },
        name: {
          configurable: true,
          get() {
            throw new Error("Error.name must not be evaluated while sanitizing logs.");
          },
        },
        stack: { configurable: true, value: `Error: ${sentinel}` },
      });
      const fail = (): never => {
        throw new Error(`Log sanitization evaluated executable input: ${sentinel}`);
      };
      const proxyError = new Proxy(error, {
        get: fail,
        getOwnPropertyDescriptor: fail,
        ownKeys: fail,
      });
      const customSerialization = { toJSON: fail };
      const accessorValue = {};
      Object.defineProperty(accessorValue, "privatePath", {
        enumerable: true,
        get: fail,
      });
      const records: StructuredLogRecord[] = [];
      const sink = createRotatingJsonlSink({ logPath: "api.jsonl", root });
      const logger = createStructuredLogger({
        context: { failure: error },
        now: () => new Date("2026-07-21T00:00:00.000Z"),
        sinks: [{ write: (record) => records.push(record) }, sink],
      }).child(accessorValue);

      logger.error("request.failed", {
        accessorValue,
        customSerialization,
        error,
        executable: fail,
        nested: [{ failure: error }],
        proxyError,
      });

      expect(records).toEqual([
        {
          context: { failure: "[Error]", privatePath: "[Accessor]" },
          data: {
            accessorValue: { privatePath: "[Accessor]" },
            customSerialization: { toJSON: "[Function]" },
            error: "[Error]",
            executable: "[Function]",
            nested: [{ failure: "[Error]" }],
            proxyError: "[Proxy]",
          },
          event: "request.failed",
          level: "error",
          timestamp: "2026-07-21T00:00:00.000Z",
        },
      ]);
      const persisted = readFileSync(sink.path, "utf8");
      expect(persisted).toContain('"error":"[Error]"');
      expect(`${JSON.stringify(records)}\n${persisted}`).not.toContain(sentinel);
      expect(persisted).not.toContain("SECRET_TRACEBACK");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("reports sink failures without forwarding the error, path, or stack", () => {
    const sentinel = "/private/SECRET_LOG_PATH/api.jsonl";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = createStructuredLogger({
      sinks: [
        {
          write() {
            throw new Error(`EACCES: ${sentinel}\nSECRET_TRACEBACK`);
          },
        },
      ],
    });

    logger.error("request.failed", { failure: "internal" });

    expect(warn).toHaveBeenCalledExactlyOnceWith("[poietra] structured-log-sink.failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET_TRACEBACK");
    warn.mockRestore();
  });
});
