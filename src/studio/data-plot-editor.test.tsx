import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DataPlotEditor, type DataPlotInspectorAuthoring, dataPlotEditorAuthorityKey } from "./data-plot-editor";

describe("DataPlotEditor", () => {
  it("changes its authority key when Undo restores another stored series", () => {
    const authoring = {
      dimensions: {},
      entityId: "plot-1",
      initialDataSeries: {
        interpolation: "smooth",
        points: [
          { x: -1, y: 0 },
          { x: 1, y: 2 },
        ],
      },
      mode: "update",
      onSubmit: vi.fn(() => true),
      unavailableReason: null,
    } satisfies DataPlotInspectorAuthoring;
    const updated = {
      ...authoring,
      initialDataSeries: {
        ...authoring.initialDataSeries,
        points: [
          { x: -1, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    } satisfies DataPlotInspectorAuthoring;

    expect(dataPlotEditorAuthorityKey(updated)).not.toBe(dataPlotEditorAuthorityKey(authoring));
    expect(dataPlotEditorAuthorityKey({ ...updated })).toBe(dataPlotEditorAuthorityKey(updated));
  });

  it("shows stored CSV and interpolation for an owning DataPlot", () => {
    const markup = renderToStaticMarkup(
      <DataPlotEditor
        authoring={{
          dimensions: {
            coordinateSystem: {
              x: { maximum: 5, minimum: -5, step: 1 },
              y: { maximum: 3, minimum: -3, step: 1 },
            },
            height: 4,
            width: 6,
          },
          entityId: "plot-1",
          initialDataSeries: {
            interpolation: "smooth",
            points: [
              { x: -1, y: 0 },
              { x: 1, y: 2 },
            ],
          },
          mode: "update",
          onSubmit: vi.fn(() => true),
          unavailableReason: null,
        }}
      />,
    );

    expect(markup).toContain("Data plot sample points");
    expect(markup).toContain("-1,0\n1,2");
    expect(markup).toContain('<option value="smooth" selected="">Smooth</option>');
    expect(markup).toContain("Update data plot");
  });

  it("keeps unsupported imported Axes visible with a clear disabled reason", () => {
    const markup = renderToStaticMarkup(
      <DataPlotEditor
        authoring={{
          dimensions: {},
          entityId: "imported-axes",
          initialDataSeries: null,
          mode: "add",
          onSubmit: vi.fn(() => false),
          unavailableReason: "Data plots currently require a Studio-created Axes object.",
        }}
      />,
    );

    expect(markup).toContain("Data plots currently require a Studio-created Axes object.");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Add data plot");
  });
});
