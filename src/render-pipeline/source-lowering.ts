import type { CreateMotionRenderRequest } from "./contracts";

export type MotionAnchor = Readonly<{
  line: number;
  seconds: number;
}>;

export type LoweredMotionSource = Readonly<{
  anchorLine: number;
  insertedCode: string;
  source: string;
}>;

export class MotionLoweringError extends Error {
  constructor(
    readonly code: "anchor-missing" | "curved-path-unsupported" | "source-variable-missing" | "zero-delta",
    message: string,
  ) {
    super(message);
    this.name = "MotionLoweringError";
  }
}

const ANCHOR_PATTERN = /^\s*#\s*poietra:anchor\s+([0-9]+(?:\.[0-9]+)?)\s*$/;

export function findMotionAnchors(source: string): readonly MotionAnchor[] {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(ANCHOR_PATTERN);
    if (!match) return [];
    return [{ line: index + 1, seconds: Number(match[1]) }];
  });
}

function sceneBlock(source: string, sceneName: string) {
  const lines = source.split(/\r?\n/);
  const scenePattern = new RegExp(`^class\\s+${escapePattern(sceneName)}\\s*\\([^)]*Scene[^)]*\\)\\s*:`);
  const start = lines.findIndex((line) => scenePattern.test(line));
  if (start < 0) return null;
  const nextClassOffset = lines.slice(start + 1).findIndex((line) => /^class\s+[A-Za-z_]/.test(line));
  return {
    end: nextClassOffset < 0 ? lines.length : start + 1 + nextClassOffset,
    lines,
    start,
  };
}

export function findSceneMotionAnchors(source: string, sceneName: string): readonly MotionAnchor[] {
  const block = sceneBlock(source, sceneName);
  if (!block) return [];
  return block.lines.slice(block.start + 1, block.end).flatMap((line, index) => {
    const match = line.match(ANCHOR_PATTERN);
    if (!match) return [];
    return [{ line: block.start + index + 2, seconds: Number(match[1]) }];
  });
}

function formatAmount(value: number) {
  return Number(value.toFixed(4)).toString();
}

function shiftExpression(
  delta: Readonly<{ x: number; y: number }>,
  frame: Readonly<{ height: number; width: number }>,
  viewport: Readonly<{ height: number; width: number }>,
) {
  const worldX = (delta.x / viewport.width) * frame.width;
  const worldY = (-delta.y / viewport.height) * frame.height;
  const terms = [
    Math.abs(worldX) > 0.0001
      ? `${formatAmount(Math.abs(worldX))} * ${worldX > 0 ? "RIGHT" : "LEFT"}`
      : null,
    Math.abs(worldY) > 0.0001
      ? `${formatAmount(Math.abs(worldY))} * ${worldY > 0 ? "UP" : "DOWN"}`
      : null,
  ].filter((term): term is string => term !== null);
  if (terms.length === 0) {
    throw new MotionLoweringError("zero-delta", "CreateMotion has no visible displacement to render.");
  }
  return terms.join(" + ");
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function lowerCreateMotionSource(
  source: string,
  request: CreateMotionRenderRequest,
  frame: Readonly<{ height: number; width: number }>,
): LoweredMotionSource {
  const { operation } = request;
  if (Math.abs(operation.controlOffsetPixels.x) > 0.001 || Math.abs(operation.controlOffsetPixels.y) > 0.001) {
    throw new MotionLoweringError(
      "curved-path-unsupported",
      "Rendered validation currently supports straight CreateMotion paths only; reset the bend handle first.",
    );
  }

  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const block = sceneBlock(source, request.sceneName);
  const anchors = findSceneMotionAnchors(source, request.sceneName);
  const anchor = anchors.find((candidate) => Math.abs(candidate.seconds - operation.interval.start) < 0.0005);
  if (!anchor) {
    throw new MotionLoweringError(
      "anchor-missing",
      `No # poietra:anchor ${operation.interval.start.toFixed(3)} marker exists in ${request.sourcePath}.`,
    );
  }

  const markerLine = lines[anchor.line - 1] ?? "";
  const indentation = markerLine.match(/^\s*/)?.[0] ?? "";
  const sourceBeforeAnchor = lines.slice((block?.start ?? 0) + 1, anchor.line - 1).join(newline);
  for (const target of operation.targets) {
    const assignment = new RegExp(`^${escapePattern(indentation)}${escapePattern(target.sourceVariable)}\\s*=`, "m");
    if (!assignment.test(sourceBeforeAnchor)) {
      throw new MotionLoweringError(
        "source-variable-missing",
        `Source variable ${target.sourceVariable} is not defined before the ${operation.interval.start.toFixed(3)}s anchor.`,
      );
    }
  }

  const duration = operation.interval.end - operation.interval.start;
  const vector = shiftExpression(operation.deltaPixels, frame, operation.viewport);
  const insertedLines = [
    `${indentation}self.play(`,
    ...operation.targets.map((target) => `${indentation}    ${target.sourceVariable}.animate.shift(${vector}),`),
    `${indentation}    run_time=${formatAmount(duration)},`,
    `${indentation}    rate_func=smooth,`,
    `${indentation})  # poietra:transaction ${operation.transactionId}`,
  ];
  lines.splice(anchor.line, 0, ...insertedLines);
  return {
    anchorLine: anchor.line,
    insertedCode: insertedLines.join(newline),
    source: lines.join(newline),
  };
}
