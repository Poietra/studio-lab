import katex from "katex";

import { cn } from "../lib/cn";

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
    <span
      className={cn(
        "block whitespace-nowrap text-center font-serif",
        lines.length === 1 ? "text-3xl" : "text-sm leading-5",
      )}
    >
      {rows.length > 0
        ? rows.map((row, index) => {
            const html = renderMath(row.tex);
            return html ? (
              <span
                className="block"
                dangerouslySetInnerHTML={{ __html: html }}
                data-rendered-math
                key={`${index}-${row.tex}`}
              />
            ) : (
              <span className="block" key={`${index}-${row.fallback}`}>
                {row.fallback}
              </span>
            );
          })
        : lines.map((line, index) => (
            <span className="block" key={`${index}-${line}`}>
              {line}
            </span>
          ))}
    </span>
  );
}
