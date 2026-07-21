import katex from "katex";
import { m } from "motion/react";

import { cn } from "../lib/cn";
import type { ObjectId } from "./prototype-fixture";

export function SceneObject({
  name,
  type,
  selected = false,
  affected = false,
  present = true,
  onToggle,
}: {
  name: ObjectId;
  type: string;
  selected?: boolean;
  affected?: boolean;
  present?: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs",
          present || selected ? "cursor-pointer" : "cursor-not-allowed",
          selected
            ? "bg-sky-950 text-sky-200"
            : present
              ? "text-zinc-400 hover:bg-zinc-800"
              : "text-zinc-600",
        )}
      >
        <input
          aria-label={`Select ${name}`}
          checked={selected}
          className="size-3.5 shrink-0 accent-sky-400"
          disabled={!present && !selected}
          onChange={onToggle}
          type="checkbox"
        />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className={cn("shrink-0 text-[11px]", affected ? "text-sky-400" : "text-zinc-600")}>
          {type}
          {!present ? " · off screen" : ""}
        </span>
      </label>
    </li>
  );
}

type EquationContentProps = Readonly<{
  lines: readonly string[];
  texParts?: readonly string[];
}>;

type EquationRow = Readonly<{
  fallback: string;
  tex: string;
}>;

const mathHtmlCache = new Map<string, string | null>();
const MAX_MATH_CACHE_ENTRIES = 128;

function equationRows(lines: readonly string[], texParts: readonly string[]): readonly EquationRow[] {
  if (texParts.length === 0) return [];
  if (lines.length <= 1) {
    return [{ fallback: lines[0] ?? texParts.join(" "), tex: texParts.join(" ") }];
  }
  if (texParts.length === 1) {
    return [{ fallback: lines.join(" "), tex: texParts[0] }];
  }
  if (texParts.length === lines.length) {
    return texParts.map((tex, index) => ({ fallback: lines[index], tex }));
  }
  return [];
}

function renderMath(tex: string) {
  if (mathHtmlCache.has(tex)) return mathHtmlCache.get(tex) ?? null;
  let html: string | null = null;
  try {
    html = katex.renderToString(tex, {
      displayMode: false,
      maxExpand: 100,
      maxSize: 12,
      output: "htmlAndMathml",
      strict: "error",
      throwOnError: true,
      trust: false,
    });
  } catch {
    html = null;
  }
  if (mathHtmlCache.size >= MAX_MATH_CACHE_ENTRIES) {
    const oldest = mathHtmlCache.keys().next().value;
    if (oldest !== undefined) mathHtmlCache.delete(oldest);
  }
  mathHtmlCache.set(tex, html);
  return html;
}

export function EquationContent({ lines, texParts = [] }: EquationContentProps) {
  const rows = equationRows(lines, texParts);
  return (
    <span className={cn(
      "block whitespace-nowrap text-center font-serif",
      lines.length === 1 ? "text-3xl" : "text-sm leading-5",
    )}>
      {rows.length > 0
        ? rows.map((row, index) => {
            const html = renderMath(row.tex);
            return html
              ? (
                  <span
                    className="block"
                    dangerouslySetInnerHTML={{ __html: html }}
                    data-rendered-math
                    key={`${index}-${row.tex}`}
                  />
                )
              : <span className="block" key={`${index}-${row.fallback}`}>{row.fallback}</span>;
          })
        : lines.map((line, index) => (
            <span className="block" key={`${index}-${line}`}>{line}</span>
          ))}
    </span>
  );
}

export function EquationMorphContent({
  progress,
  sourceLines,
  sourceTexParts,
  targetLines,
  targetTexParts,
}: {
  progress: number;
  sourceLines: readonly string[];
  sourceTexParts: readonly string[];
  targetLines: readonly string[];
  targetTexParts: readonly string[];
}) {
  const normalizedProgress = Math.max(0, Math.min(1, progress));
  return (
    <span aria-label={`${sourceLines.join(" ")} to ${targetLines.join(" ")}`} role="img">
      <span aria-hidden="true" className="grid place-items-center motion-reduce:hidden">
        <m.span className="col-start-1 row-start-1" style={{ opacity: 1 - normalizedProgress }}>
          <EquationContent lines={sourceLines} texParts={sourceTexParts} />
        </m.span>
        <m.span className="col-start-1 row-start-1" style={{ opacity: normalizedProgress }}>
          <EquationContent lines={targetLines} texParts={targetTexParts} />
        </m.span>
      </span>
      <span aria-hidden="true" className="hidden motion-reduce:block">
        <EquationContent
          lines={normalizedProgress < 1 ? sourceLines : targetLines}
          texParts={normalizedProgress < 1 ? sourceTexParts : targetTexParts}
        />
      </span>
    </span>
  );
}
