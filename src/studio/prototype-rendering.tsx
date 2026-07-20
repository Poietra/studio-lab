import { m } from "motion/react";

import { cn } from "../lib/cn";
import type { ObjectId } from "./prototype-fixture";
import { clamp } from "./prototype-helpers";

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

export function EquationContent({ lines }: { lines: readonly string[] }) {
  return (
    <span className={cn(
      "block whitespace-nowrap text-center font-serif",
      lines.length === 1 ? "text-3xl" : "text-sm leading-5",
    )}>
      {lines.map((line, index) => <span className="block" key={`${index}-${line}`}>{line}</span>)}
    </span>
  );
}

export function EquationMorphContent({
  progress,
  sourceLines,
  targetLines,
}: {
  progress: number;
  sourceLines: readonly string[];
  targetLines: readonly string[];
}) {
  const normalizedProgress = clamp(progress, 0, 1);
  const canMatchCharacters = sourceLines.length === 1 && targetLines.length === 1;

  if (!canMatchCharacters) {
    return (
      <span aria-label={`${sourceLines.join(" ")} to ${targetLines.join(" ")}`} role="img">
        <span aria-hidden="true" className="grid place-items-center motion-reduce:hidden">
          <m.span className="col-start-1 row-start-1" style={{ opacity: 1 - normalizedProgress }}>
            <EquationContent lines={sourceLines} />
          </m.span>
          <m.span className="col-start-1 row-start-1" style={{ opacity: normalizedProgress }}>
            <EquationContent lines={targetLines} />
          </m.span>
        </span>
        <span aria-hidden="true" className="hidden motion-reduce:block">
          <EquationContent lines={normalizedProgress < 1 ? sourceLines : targetLines} />
        </span>
      </span>
    );
  }

  const sourceCharacters = [...sourceLines[0].normalize("NFC")].filter((character) => !/\s/u.test(character));
  const targetCharacters = [...targetLines[0].normalize("NFC")].filter((character) => !/\s/u.test(character));
  const claimedTargets = new Set<number>();
  const sourceMatches = sourceCharacters.map((character) => {
    const targetIndex = targetCharacters.findIndex((candidate, index) => (
      candidate === character && !claimedTargets.has(index)
    ));
    if (targetIndex >= 0) claimedTargets.add(targetIndex);
    return targetIndex >= 0 ? targetIndex : null;
  });
  const slot = (index: number, count: number) => (index - (count - 1) / 2) * 0.78;
  const width = Math.max(4, Math.max(sourceCharacters.length, targetCharacters.length) * 0.86);

  return (
    <span aria-label={`${sourceLines[0]} to ${targetLines[0]}`} role="img">
      <span
        aria-hidden="true"
        className="relative block h-10 font-serif text-3xl motion-reduce:hidden"
        data-semantic-morph-preview
        style={{ width: `${width}em` }}
      >
        {sourceCharacters.map((character, index) => {
          const targetIndex = sourceMatches[index];
          const startX = slot(index, sourceCharacters.length);
          const endX = targetIndex === null ? startX : slot(targetIndex, targetCharacters.length);
          const x = startX + (endX - startX) * normalizedProgress;
          const y = targetIndex === null ? -0.2 * normalizedProgress : 0;
          return (
            <m.span
              className="absolute left-1/2 top-1/2"
              key={`source-${index}-${character}`}
              style={{
                opacity: targetIndex === null ? 1 - normalizedProgress : 1,
                transform: `translate(-50%, -50%) translate(${x}em, ${y}em)`,
              }}
            >
              {character}
            </m.span>
          );
        })}
        {targetCharacters.map((character, index) => claimedTargets.has(index) ? null : (
          <m.span
            className="absolute left-1/2 top-1/2"
            key={`target-${index}-${character}`}
            style={{
              opacity: normalizedProgress,
              transform: `translate(-50%, -50%) translate(${slot(index, targetCharacters.length)}em, ${0.2 * (1 - normalizedProgress)}em)`,
            }}
          >
            {character}
          </m.span>
        ))}
      </span>
      <span aria-hidden="true" className="hidden motion-reduce:block">
        <EquationContent lines={normalizedProgress < 1 ? sourceLines : targetLines} />
      </span>
    </span>
  );
}
