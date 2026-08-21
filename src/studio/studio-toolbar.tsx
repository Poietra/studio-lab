import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import type { InsertEntityType } from "./authoring-commands";
import { type StudioCommandId, shortcutLabel, studioCommand } from "./commands";
import { STUDIO_CREATION_TEXT_CONTRACT, STUDIO_CREATION_TEXT_MAX_LENGTH } from "./editable-content";
import {
  SELECTION_LAYOUT_COMMANDS,
  type SelectionLayoutCommand,
  selectionLayoutMinimumCount,
} from "./selection-layout";
import { markStudioRenderBoundary } from "./studio-render-profiler";

export type StudioTool = "select" | InsertEntityType;

const TOOL_COMMANDS: readonly Readonly<{
  commandId: StudioCommandId;
  label: string;
  tool: StudioTool;
}>[] = [
  { commandId: "select-tool", label: "Select", tool: "select" },
  { commandId: "insert-text", label: "Text", tool: "Text" },
  { commandId: "insert-mathtex", label: "Math", tool: "MathTex" },
  { commandId: "insert-rectangle", label: "Rectangle", tool: "Rectangle" },
  { commandId: "insert-circle", label: "Circle", tool: "Circle" },
  { commandId: "insert-triangle", label: "Triangle", tool: "Triangle" },
  { commandId: "insert-regular-polygon", label: "Polygon", tool: "RegularPolygon" },
  { commandId: "insert-line", label: "Line", tool: "Line" },
  { commandId: "insert-arrow", label: "Arrow", tool: "Arrow" },
] as const;

const LAYOUT_BUTTON_LABELS: Readonly<Record<SelectionLayoutCommand, string>> = {
  "align-bottom": "Bottom",
  "align-horizontal-center": "H center",
  "align-left": "Left",
  "align-right": "Right",
  "align-top": "Top",
  "align-vertical-middle": "V middle",
  "distribute-horizontal": "H distribute",
  "distribute-vertical": "V distribute",
};

export type StudioToolbarProps = Readonly<{
  authoringAvailable: boolean;
  insertValue: string;
  onInsertAtCenter: () => void;
  onInsertValueChange: (value: string) => void;
  onPolygonSidesChange: (sides: number) => void;
  onSelectionLayout: (command: SelectionLayoutCommand) => void;
  onToolChange: (tool: StudioTool) => void;
  polygonSides: number;
  selectionCount: number;
  selectionLayoutUnavailableReason: string | null;
  tool: StudioTool;
}>;

export function StudioToolbar({
  authoringAvailable,
  insertValue,
  onInsertAtCenter,
  onInsertValueChange,
  onPolygonSidesChange,
  onSelectionLayout,
  onToolChange,
  polygonSides,
  selectionCount,
  selectionLayoutUnavailableReason,
  tool,
}: StudioToolbarProps) {
  markStudioRenderBoundary("toolbar");
  const requiresContent = tool === "Text" || tool === "MathTex";
  const requiresPolygonSides = tool === "RegularPolygon";
  const [polygonSidesDraft, setPolygonSidesDraft] = useState(String(polygonSides));
  useEffect(() => setPolygonSidesDraft(String(polygonSides)), [polygonSides]);
  const parsedPolygonSides = Number(polygonSidesDraft);
  const polygonSidesDraftIsValid =
    Number.isInteger(parsedPolygonSides) && parsedPolygonSides >= 3 && parsedPolygonSides <= 32;
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return (
    <section aria-label="Studio tools" className="shrink-0 border-b border-zinc-800 bg-zinc-950 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1" role="toolbar">
        {TOOL_COMMANDS.map((item) => {
          const command = studioCommand(item.commandId);
          const shortcut = shortcutLabel(command.shortcut, platform);
          return (
            <button
              aria-keyshortcuts={command.shortcut.replace("Mod", platform.includes("Mac") ? "Meta" : "Control")}
              aria-label={`${command.label} (${shortcut})`}
              aria-pressed={tool === item.tool}
              className={cn(
                "h-8 border px-2.5 text-xs",
                tool === item.tool
                  ? "border-sky-700 bg-sky-950 text-sky-200"
                  : "border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100",
              )}
              key={item.tool}
              disabled={!authoringAvailable && item.tool !== "select"}
              onClick={() => onToolChange(item.tool)}
              title={`${command.label} · ${shortcut}`}
              type="button"
            >
              {item.label}
            </button>
          );
        })}
        <span className="ml-2 hidden text-pretty text-[10px] text-zinc-600 md:inline">
          {tool === "select" ? "Select and move objects" : "Click the canvas to place the object"}
        </span>
        {selectionCount > 1 ? (
          <div aria-label="Selection layout" className="ml-2 flex flex-wrap items-center gap-1" role="group">
            {SELECTION_LAYOUT_COMMANDS.map((commandId) => {
              const command = studioCommand(commandId);
              const shortcut = shortcutLabel(command.shortcut, platform);
              const countReason =
                selectionCount < selectionLayoutMinimumCount(commandId)
                  ? "Select at least three objects to distribute them."
                  : null;
              const unavailableReason = selectionLayoutUnavailableReason ?? countReason;
              return (
                <button
                  aria-keyshortcuts={command.shortcut}
                  aria-label={`${command.label} (${shortcut})`}
                  className="h-8 border border-zinc-700 px-2 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-700"
                  data-selection-layout-command={commandId}
                  disabled={unavailableReason !== null}
                  key={commandId}
                  onClick={() => onSelectionLayout(commandId)}
                  title={unavailableReason ?? `${command.label} · ${shortcut}`}
                  type="button"
                >
                  {LAYOUT_BUTTON_LABELS[commandId]}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      {requiresContent || requiresPolygonSides ? (
        <form
          className="mt-2 flex max-w-xl items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (requiresPolygonSides && !polygonSidesDraftIsValid) return;
            onInsertAtCenter();
          }}
        >
          {requiresContent ? (
            <label className="min-w-0 flex-1 text-[10px] text-zinc-500">
              {tool === "Text" ? "Text content" : "MathTex"}
              <input
                autoComplete="off"
                className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-sky-500"
                maxLength={tool === "Text" ? STUDIO_CREATION_TEXT_MAX_LENGTH : undefined}
                onChange={(event) => onInsertValueChange(event.currentTarget.value)}
                placeholder={tool === "Text" ? "Type text" : String.raw`e.g. E = mc^2`}
                title={tool === "Text" ? STUDIO_CREATION_TEXT_CONTRACT : undefined}
                value={insertValue}
                disabled={!authoringAvailable}
              />
            </label>
          ) : (
            <label className="w-28 text-[10px] text-zinc-500">
              Polygon sides
              <input
                aria-label="Polygon sides"
                className="mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs tabular-nums text-zinc-100 outline-none focus:border-sky-500"
                disabled={!authoringAvailable}
                max={32}
                min={3}
                onChange={(event) => {
                  const draft = event.currentTarget.value;
                  const sides = Number(draft);
                  setPolygonSidesDraft(draft);
                  if (Number.isInteger(sides) && sides >= 3 && sides <= 32) onPolygonSidesChange(sides);
                }}
                onBlur={() => {
                  if (!polygonSidesDraftIsValid) setPolygonSidesDraft(String(polygonSides));
                }}
                step={1}
                type="number"
                value={polygonSidesDraft}
              />
            </label>
          )}
          <button
            className="h-8 bg-sky-500 px-3 text-xs font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
            disabled={!authoringAvailable || (requiresPolygonSides && !polygonSidesDraftIsValid)}
            type="submit"
          >
            Insert at center
          </button>
        </form>
      ) : null}
    </section>
  );
}
