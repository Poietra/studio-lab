import { MANIM_PROJECT_ID_PATTERN } from "../src/render-pipeline/contracts";
import type { FastManimSnapshotProfileVersionV1 } from "./fast-manim-snapshot-contract";
import type { ManimProjectSeed } from "./manim-project-catalog";

export type ManimProjectConfig = ManimProjectSeed;

export type ManimRenderPipelineOptions = Readonly<{
  command?: string;
  frameHeight?: number;
  frameWidth?: number;
  projects?: readonly ManimProjectConfig[];
  projectRoot?: string;
  snapshotSandboxDeployment?: "development" | "production" | "test";
  snapshotProducerCommand?: readonly string[];
  snapshotProducerDevOptIn?: boolean;
  snapshotVersion?: FastManimSnapshotProfileVersionV1;
  workspaceDataRoot?: string;
}>;

export function parseManimCommand(value: string | undefined): readonly string[] {
  const normalized = value?.trim();
  if (!normalized) return ["manim"];
  if (normalized.startsWith("[")) {
    const parsed = JSON.parse(normalized) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw new Error("POIETRA_MANIM_COMMAND must be a non-empty JSON array of command arguments.");
    }
    return parsed;
  }
  return normalized.split(/\s+/);
}

/**
 * The fast-manim snapshot producer has no default executable: until
 * Poietra/fast-manim#4 ships an exporter, leaving this unset keeps the
 * endpoint truthfully gated on the server-authoritative render fallback.
 */
export function parseFastManimSnapshotProducerCommand(value: string | undefined): readonly string[] | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return parseManimCommand(normalized);
}

export function parseFastManimSnapshotVersion(value: string | undefined): FastManimSnapshotProfileVersionV1 {
  const normalized = value?.trim();
  if (!normalized || normalized === "1") return 1;
  if (normalized === "2") return 2;
  if (normalized === "3") return 3;
  throw new TypeError("POIETRA_FAST_MANIM_SNAPSHOT_VERSION must be 1, 2, or 3.");
}

export function parseManimProjects(value: string | undefined): readonly ManimProjectConfig[] | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const parsed = JSON.parse(normalized) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) {
    throw new TypeError("POIETRA_MANIM_PROJECTS must be a JSON array containing 1 to 64 configured projects.");
  }
  return parsed.map((entry, index) => {
    if (typeof entry === "string" && entry.trim()) return { root: entry.trim() };
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}] must be a root string or project object.`);
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["id", "name", "root"].includes(key))) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}] contains an unsupported field.`);
    }
    if (typeof record.root !== "string" || !record.root.trim()) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}].root must be a non-empty path.`);
    }
    if (record.id !== undefined && (typeof record.id !== "string" || !MANIM_PROJECT_ID_PATTERN.test(record.id))) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}].id must be an opaque lower-case identifier.`);
    }
    if (
      record.name !== undefined &&
      (typeof record.name !== "string" || !record.name.trim() || record.name.trim().length > 120)
    ) {
      throw new TypeError(`POIETRA_MANIM_PROJECTS[${index}].name must contain 1 to 120 characters.`);
    }
    return {
      ...(record.id === undefined ? {} : { id: record.id }),
      ...(record.name === undefined ? {} : { name: record.name.trim() }),
      root: record.root.trim(),
    };
  });
}
