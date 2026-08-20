import { describe, expect, it } from "vitest";

import { commandForShortcut, shortcutLabel } from "./commands";

function key(key: string, overrides: Partial<Parameters<typeof commandForShortcut>[0]> = {}) {
  return commandForShortcut({
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  });
}

describe("Studio command shortcuts", () => {
  it("maps PowerPoint-like authoring keys", () => {
    expect(key("v")).toBe("select-tool");
    expect(key("t")).toBe("insert-text");
    expect(key("r")).toBe("insert-rectangle");
    expect(key("Delete")).toBe("delete");
    expect(key(" ")).toBe("play-pause");
  });

  it("supports Ctrl and Command modifier conventions", () => {
    expect(key("z", { ctrlKey: true })).toBe("undo");
    expect(key("z", { metaKey: true, shiftKey: true })).toBe("redo");
    expect(key("a", { ctrlKey: true })).toBe("select-all");
    expect(key("g", { ctrlKey: true })).toBe("group");
    expect(key("g", { metaKey: true, shiftKey: true })).toBe("ungroup");
    expect(key("a")).toBe("insert-arrow");
  });

  it("maps non-conflicting selection layout shortcuts", () => {
    expect(key("l", { altKey: true, shiftKey: true })).toBe("align-left");
    expect(key("c", { altKey: true, shiftKey: true })).toBe("align-horizontal-center");
    expect(key("h", { altKey: true, shiftKey: true })).toBe("distribute-horizontal");
    expect(key("v", { altKey: true, code: "KeyV", shiftKey: true })).toBe("distribute-vertical");
    expect(key("l", { altKey: true })).toBeNull();
    expect(key("l", { altKey: true, ctrlKey: true, shiftKey: true })).toBeNull();
  });

  it("formats shortcut labels for the current platform", () => {
    expect(shortcutLabel("Mod+Shift+Z", "MacIntel")).toBe("⌘⇧Z");
    expect(shortcutLabel("Mod+Shift+Z", "Linux x86_64")).toBe("Ctrl+Shift+Z");
    expect(shortcutLabel("Alt+Shift+L", "MacIntel")).toBe("⌥⇧L");
    expect(shortcutLabel("Alt+Shift+L", "Linux x86_64")).toBe("Alt+Shift+L");
  });
});
