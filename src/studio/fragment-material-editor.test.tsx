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
            glslSource: null,
            name: "Ocean wave",
            revision: 3,
            shaderId: "project-material-1",
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
          },
          {
            assignmentCount: 0,
            glslSource: { entryPoint: "main", source: "#version 450\nvoid main() {}" },
            name: "Warm glow",
            revision: 1,
            shaderId: "project-material-2",
            source: `${STUDIO_WAVE_FRAGMENT_SOURCE_V1}\n// warm`,
          },
        ]}
        onAssign={vi.fn()}
        onCreate={vi.fn(() => null)}
        onDuplicate={vi.fn(() => null)}
        onImportGlsl={vi.fn(async () => undefined)}
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
    expect(markup).toContain("Import Vulkan GLSL 450");
    expect(markup).toContain('aria-label="Vulkan GLSL fragment source"');
    expect(markup).toContain("#version 450");
  });

  it("shows an active Scene material failure while the selected object is unassigned", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active={false}
        assignedShaderId={null}
        available
        compileError="WGSL compilation failed"
        materials={[
          {
            assignmentCount: 1,
            glslSource: null,
            name: "Broken wave",
            revision: 2,
            shaderId: "project-material-1",
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
          },
        ]}
        onAssign={vi.fn()}
        onCreate={vi.fn(() => null)}
        onDuplicate={vi.fn(() => null)}
        onImportGlsl={vi.fn(async () => undefined)}
        onRemoveAsset={vi.fn()}
        onRename={vi.fn()}
        onUpdateSource={vi.fn()}
      />,
    );

    expect(markup).toContain("Rejected");
    expect(markup).toContain("WGSL compilation failed");
  });
});
