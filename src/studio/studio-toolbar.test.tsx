import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StudioToolbar, type StudioToolbarProps } from "./studio-toolbar";

function props(overrides: Partial<StudioToolbarProps> = {}): StudioToolbarProps {
  return {
    authoringAvailable: true,
    insertValue: "",
    onInsertAtCenter: vi.fn(),
    onInsertValueChange: vi.fn(),
    onSelectionLayout: vi.fn(),
    onToolChange: vi.fn(),
    selectionCount: 2,
    selectionLayoutUnavailableReason: null,
    tool: "select",
    ...overrides,
  };
}

function layoutButton(markup: string, command: string) {
  return markup.match(new RegExp(`<button(?=[^>]*data-selection-layout-command="${command}")[^>]*>`))?.[0];
}

describe("StudioToolbar selection layout", () => {
  it("offers alignment for two selected objects and requires three for distribution", () => {
    const markup = renderToStaticMarkup(<StudioToolbar {...props()} />);

    expect(markup.match(/data-selection-layout-command=/g)).toHaveLength(8);
    expect(layoutButton(markup, "align-left")).not.toMatch(/\sdisabled=/);
    expect(layoutButton(markup, "distribute-horizontal")).toMatch(/\sdisabled=/);
    expect(layoutButton(markup, "distribute-horizontal")).toContain("Select at least three objects");
  });

  it("disables the complete layout group with the supplied authority reason", () => {
    const reason = "Align and distribute currently support only applied Studio-created objects.";
    const markup = renderToStaticMarkup(
      <StudioToolbar {...props({ selectionCount: 3, selectionLayoutUnavailableReason: reason })} />,
    );

    expect(markup.match(/disabled=""/g)).toHaveLength(8);
    expect(layoutButton(markup, "align-left")).toContain(reason);
    expect(layoutButton(markup, "distribute-vertical")).toContain(reason);
  });
});
