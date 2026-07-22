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
    expect(key("a")).toBe("insert-arrow");
  });

  it("formats shortcut labels for the current platform", () => {
    expect(shortcutLabel("Mod+Shift+Z", "MacIntel")).toBe("⌘⇧Z");
    expect(shortcutLabel("Mod+Shift+Z", "Linux x86_64")).toBe("Ctrl+Shift+Z");
  });
});
