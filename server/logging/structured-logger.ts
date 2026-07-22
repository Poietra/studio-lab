import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type StructuredLogRecord = Readonly<{
  context: Readonly<Record<string, unknown>>;
  data?: unknown;
  event: string;
  level: LogLevel;
  timestamp: string;
}>;

export type LogSink = Readonly<{
  write: (record: StructuredLogRecord) => void;
}>;

export type StructuredLogger = Readonly<{
  child: (context: Readonly<Record<string, unknown>>) => StructuredLogger;
  debug: (event: string, data?: unknown) => void;
  error: (event: string, data?: unknown) => void;
  info: (event: string, data?: unknown) => void;
  warn: (event: string, data?: unknown) => void;
}>;

export type RotatingJsonlSink = LogSink & Readonly<{ path: string }>;

type LoggerOptions = Readonly<{
  context?: Readonly<Record<string, unknown>>;
  now?: () => Date;
  sinks: readonly LogSink[];
}>;

type JsonlSinkOptions = Readonly<{
  logPath: string;
  maxBytes?: number;
  root: string;
}>;

type ConsoleSinkOptions = Readonly<{
  includeData?: boolean;
  prefix?: string;
}>;

const SENSITIVE_FIELD = /^(?:(?:x[-_])?api[-_]?key|(?:proxy[-_])?authorization|cookie|set[-_]?cookie|password|passwd|secret|client[-_]?secret|token|(?:access|refresh|id)[-_]?token)$/i;

function sanitize(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_FIELD.test(key)) return "[REDACTED]";
  if (value instanceof Error) {
    return { message: value.message, name: value.name, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const sanitized = Array.isArray(value)
    ? value.map((item) => sanitize(item, "", seen))
    : Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          sanitize(entryValue, entryKey, seen),
        ]),
      );
  seen.delete(value);
  return sanitized;
}

export function createStructuredLogger(options: LoggerOptions): StructuredLogger {
  const context = sanitize(options.context ?? {}) as Readonly<Record<string, unknown>>;
  const emit = (level: LogLevel, event: string, data?: unknown) => {
    const record: StructuredLogRecord = {
      context,
      ...(data === undefined ? {} : { data: sanitize(data) }),
      event,
      level,
      timestamp: (options.now ?? (() => new Date()))().toISOString(),
    };
    for (const sink of options.sinks) {
      try {
        sink.write(record);
      } catch (error) {
        console.warn("[poietra] A structured log sink failed.", error);
      }
    }
  };

  return {
    child(childContext) {
      return createStructuredLogger({
        ...options,
        context: { ...context, ...childContext },
      });
    },
    debug: (event, data) => emit("debug", event, data),
    error: (event, data) => emit("error", event, data),
    info: (event, data) => emit("info", event, data),
    warn: (event, data) => emit("warn", event, data),
  };
}

export function createConsoleJsonSink(options: ConsoleSinkOptions = {}): LogSink {
  return {
    write(record) {
      const consoleRecord = options.includeData === false
        ? { ...record, data: undefined }
        : record;
      const line = `[${options.prefix ?? "poietra"}] ${JSON.stringify(consoleRecord)}`;
      if (record.level === "error") console.error(line);
      else if (record.level === "warn") console.warn(line);
      else console.info(line);
    },
  };
}

export function createRotatingJsonlSink(options: JsonlSinkOptions): RotatingJsonlSink {
  const path = isAbsolute(options.logPath)
    ? options.logPath
    : resolve(options.root, options.logPath);
  const previousPath = `${path}.previous`;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("Structured log rotation size must be a positive integer.");
  }
  mkdirSync(dirname(path), { recursive: true });

  return {
    path,
    write(record) {
      const line = `${JSON.stringify(record)}\n`;
      if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > maxBytes) {
        if (existsSync(previousPath)) unlinkSync(previousPath);
        renameSync(path, previousPath);
      }
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    },
  };
}

export const nullLogger: StructuredLogger = createStructuredLogger({ sinks: [] });
