export type StudioCommandId =
  | "copy"
  | "delete"
  | "duplicate"
  | "escape"
  | "insert-arrow"
  | "insert-circle"
  | "insert-line"
  | "insert-mathtex"
  | "insert-rectangle"
  | "insert-text"
  | "paste"
  | "play-pause"
  | "redo"
  | "select-all"
  | "select-tool"
  | "undo";

export type StudioCommandDefinition = Readonly<{
  id: StudioCommandId;
  label: string;
  shortcut: string;
}>;

export const STUDIO_COMMANDS: readonly StudioCommandDefinition[] = [
  { id: "select-tool", label: "Select tool", shortcut: "V" },
  { id: "insert-text", label: "Insert text", shortcut: "T" },
  { id: "insert-mathtex", label: "Insert equation", shortcut: "M" },
  { id: "insert-rectangle", label: "Insert rectangle", shortcut: "R" },
  { id: "insert-circle", label: "Insert circle", shortcut: "O" },
  { id: "insert-line", label: "Insert line", shortcut: "L" },
  { id: "insert-arrow", label: "Insert arrow", shortcut: "A" },
  { id: "undo", label: "Undo", shortcut: "Mod+Z" },
  { id: "redo", label: "Redo", shortcut: "Mod+Shift+Z" },
  { id: "delete", label: "Delete", shortcut: "Delete" },
  { id: "duplicate", label: "Duplicate", shortcut: "Mod+D" },
  { id: "copy", label: "Copy", shortcut: "Mod+C" },
  { id: "paste", label: "Paste", shortcut: "Mod+V" },
  { id: "select-all", label: "Select all", shortcut: "Mod+A" },
  { id: "play-pause", label: "Play or pause", shortcut: "Space" },
  { id: "escape", label: "Cancel", shortcut: "Escape" },
] as const;

export function studioCommand(id: StudioCommandId) {
  const command = STUDIO_COMMANDS.find((candidate) => candidate.id === id);
  if (!command) throw new Error(`Unknown Studio command ${id}.`);
  return command;
}

export function shortcutLabel(shortcut: string, platform = "") {
  const mac = /Mac|iPhone|iPad/.test(platform);
  return shortcut
    .replace("Mod+", mac ? "⌘" : "Ctrl+")
    .replace("Shift+", mac ? "⇧" : "Shift+");
}

type ShortcutEvent = Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}>;

export function commandForShortcut(event: ShortcutEvent): StudioCommandId | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  if (mod) {
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y" && !event.shiftKey) return "redo";
    if (event.shiftKey) return null;
    if (key === "a") return "select-all";
    if (key === "c") return "copy";
    if (key === "d") return "duplicate";
    if (key === "v") return "paste";
    return null;
  }
  if (event.shiftKey) return null;
  if (key === "delete" || key === "backspace") return "delete";
  if (key === "escape") return "escape";
  if (key === " " || key === "spacebar") return "play-pause";
  return {
    a: "insert-arrow",
    l: "insert-line",
    m: "insert-mathtex",
    o: "insert-circle",
    r: "insert-rectangle",
    t: "insert-text",
    v: "select-tool",
  }[key] as StudioCommandId | undefined ?? null;
}

export function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable
    || target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}
