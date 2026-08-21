import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StudioToolbar, type StudioToolbarProps } from "./studio-toolbar";

function props(overrides: Partial<StudioToolbarProps> = {}): StudioToolbarProps {
  return {
    authoringAvailable: true,
    coordinateInsertSettings: {
      height: 4,
      width: 6,
      xMaximum: 5,
      xMinimum: -5,
      xStep: 1,
      yMaximum: 3,
      yMinimum: -3,
      yStep: 1,
    },
    curveInsertSettings: {
      ellipseHeight: 2,
      ellipseWidth: 3,
      radius: 1,
      startDegrees: 0,
      sweepDegrees: 90,
    },
    insertValue: "",
    onCoordinateInsertSettingsChange: vi.fn(),
    onCurveInsertSettingsChange: vi.fn(),
    onInsertAtCenter: vi.fn(),
    onInsertValueChange: vi.fn(),
    onPolygonSidesChange: vi.fn(),
    onSelectionLayout: vi.fn(),
    onToolChange: vi.fn(),
    polygonSides: 6,
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
  it("offers Triangle and Regular Polygon with bounded creation-time sides", () => {
    const tools = renderToStaticMarkup(<StudioToolbar {...props()} />);
    const polygon = renderToStaticMarkup(<StudioToolbar {...props({ polygonSides: 6, tool: "RegularPolygon" })} />);

    expect(tools).toContain("Insert triangle (G)");
    expect(tools).toContain("Insert regular polygon (P)");
    expect(tools).toContain("Insert ellipse (E)");
    expect(tools).toContain("Insert arc (U)");
    expect(tools).toContain("Insert sector (S)");
    expect(polygon).toMatch(/aria-label="Polygon sides"[^>]*max="32"[^>]*min="3"/u);
    expect(polygon).toMatch(/aria-label="Polygon sides"[^>]*value="6"/u);
  });

  it("exposes bounded creation controls for curve primitives", () => {
    const ellipse = renderToStaticMarkup(<StudioToolbar {...props({ tool: "Ellipse" })} />);
    const arc = renderToStaticMarkup(<StudioToolbar {...props({ tool: "Arc" })} />);

    expect(ellipse).toContain('aria-label="Ellipse width"');
    expect(ellipse).toContain('aria-label="Ellipse height"');
    expect(arc).toContain('aria-label="Arc radius"');
    expect(arc).toContain('aria-label="Arc start angle"');
    expect(arc).toContain('aria-label="Arc sweep angle"');
  });

  it("exposes coordinate object tools and bounded range controls", () => {
    const tools = renderToStaticMarkup(<StudioToolbar {...props()} />);
    const line = renderToStaticMarkup(<StudioToolbar {...props({ tool: "NumberLine" })} />);
    const plane = renderToStaticMarkup(<StudioToolbar {...props({ tool: "NumberPlane" })} />);

    expect(tools).toContain("Insert number line (N)");
    expect(tools).toContain("Insert axes (X)");
    expect(tools).toContain("Insert number plane (B)");
    expect(line).toContain('aria-label="X minimum"');
    expect(line).not.toContain('aria-label="Y minimum"');
    expect(plane).toContain('aria-label="Y minimum"');
    expect(plane).toContain('aria-label="Display height"');
  });

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
