import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { STUDIO_WAVE_FRAGMENT_SOURCE_V1 } from "../engine/fragment-material-registry";
import { FragmentMaterialEditor } from "./fragment-material-editor";

describe("FragmentMaterialEditor", () => {
  it("renders named assets, object assignment, and the in-use deletion guard", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active
        assignedShaderId="project-material-1"
        available
        compileError={null}
        materials={[
          {
            assignmentCount: 2,
            name: "Ocean wave",
            revision: 3,
            shaderId: "project-material-1",
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
          },
          {
            assignmentCount: 0,
            name: "Warm glow",
            revision: 1,
            shaderId: "project-material-2",
            source: `${STUDIO_WAVE_FRAGMENT_SOURCE_V1}\n// warm`,
          },
        ]}
        onAssign={vi.fn()}
        onCreate={vi.fn(() => null)}
        onDuplicate={vi.fn(() => null)}
        onRemoveAsset={vi.fn()}
        onRename={vi.fn()}
        onUpdateSource={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Assigned fragment material"');
    expect(markup).toContain('aria-label="Material asset"');
    expect(markup).toContain("Ocean wave");
    expect(markup).toContain("Warm glow");
    expect(markup).toContain("Assigned to 2 object(s). Unassign all uses before deleting.");
    expect(markup).toContain("Unassign this material from 2 object(s) before deleting it.");
    expect(markup).toContain('aria-label="Fragment material WGSL source"');
  });
});
