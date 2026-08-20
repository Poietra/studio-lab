import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { STUDIO_WAVE_FRAGMENT_SOURCE_V1 } from "../engine/fragment-material-registry";
import {
  FragmentMaterialEditor,
  type FragmentMaterialEditorItem,
  fragmentMaterialsMatchingName,
} from "./fragment-material-editor";

const searchableMaterials = [
  { name: "Ocean Wave", shaderId: "wave" },
  { name: "warm GLOW", shaderId: "glow" },
  { name: "Paper", shaderId: "paper" },
].map(
  ({ name, shaderId }): FragmentMaterialEditorItem => ({
    assignmentCount: 0,
    glslSource: null,
    name,
    parameterSchema: [],
    revision: 1,
    shaderId,
    source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
  }),
);

describe("FragmentMaterialEditor", () => {
  it("filters project materials by name without changing their identity", () => {
    expect(fragmentMaterialsMatchingName(searchableMaterials, "  WAvE ")).toEqual([searchableMaterials[0]]);
    expect(fragmentMaterialsMatchingName(searchableMaterials, "glow")).toEqual([searchableMaterials[1]]);
    expect(fragmentMaterialsMatchingName(searchableMaterials, "missing")).toEqual([]);
    expect(fragmentMaterialsMatchingName(searchableMaterials, " ")).toBe(searchableMaterials);
  });

  it("renders named assets, object assignment, and the in-use deletion guard", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active
        assignedParameters={[0.65, 12]}
        assignedShaderId="project-material-1"
        assignedTexture={null}
        available
        compileError={null}
        materials={[
          {
            assignmentCount: 2,
            glslSource: null,
            name: "Ocean wave",
            parameterSchema: [
              { default: 0.35, name: "Speed", range: { max: 2, min: -2, step: 0.05 }, type: "f32" },
              { default: 8, name: "Bands", range: { max: 24, min: 1, step: 1 }, type: "f32" },
            ],
            revision: 3,
            shaderId: "project-material-1",
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
          },
          {
            assignmentCount: 0,
            glslSource: { entryPoint: "main", source: "#version 450\nvoid main() {}" },
            name: "Warm glow",
            parameterSchema: [],
            revision: 1,
            shaderId: "project-material-2",
            source: `${STUDIO_WAVE_FRAGMENT_SOURCE_V1}\n// warm`,
          },
        ]}
        onAssign={vi.fn()}
        onCreate={vi.fn(() => null)}
        onCreatePreset={vi.fn(() => null)}
        onCreateTexturePreset={vi.fn(() => null)}
        onDuplicate={vi.fn(() => null)}
        onImportGlsl={vi.fn(async () => undefined)}
        onRemoveAsset={vi.fn()}
        onRename={vi.fn()}
        onUpdateSource={vi.fn()}
        onUpdateParameter={vi.fn()}
        onUpdateTexture={vi.fn()}
        textureAssets={[]}
      />,
    );

    expect(markup).toContain('aria-label="Assigned fragment material"');
    expect(markup).toContain('aria-label="Search project materials"');
    expect(markup).toContain('aria-controls="fragment-material-asset"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("2 project materials");
    expect(markup).toContain('aria-label="Material asset"');
    expect(markup).toContain("Ocean wave");
    expect(markup).toContain("Warm glow");
    expect(markup).toContain("Assigned to 2 object(s). Unassign all uses before deleting.");
    expect(markup).toContain("Unassign this material from 2 object(s) before deleting it.");
    expect(markup).toContain('aria-label="Fragment material WGSL source"');
    expect(markup).toContain("Built-in presets");
    expect(markup).toContain("Wave preset");
    expect(markup).toContain("Gradient preset");
    expect(markup).toContain("Pulse preset");
    expect(markup).toContain("Create &amp; apply");
    expect(markup).toContain('aria-label="Speed material parameter"');
    expect(markup).toContain('aria-label="Bands material parameter"');
    expect(markup).toContain("0.65");
    expect(markup).toContain("12");
    expect(markup).toContain("Import Vulkan GLSL 450");
    expect(markup).toContain('aria-label="Vulkan GLSL fragment source"');
    expect(markup).toContain("#version 450");
  });

  it("shows an active Scene material failure while the selected object is unassigned", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active={false}
        assignedParameters={null}
        assignedShaderId={null}
        assignedTexture={null}
        available
        compileError="WGSL compilation failed"
        materials={[
          {
            assignmentCount: 1,
            glslSource: {
              diagnostic: "material.glsl:2:12: expected ')'",
              entryPoint: "main",
              source: "#version 450\nvoid main( {",
            },
            name: "Broken wave",
            parameterSchema: [],
            revision: 2,
            shaderId: "project-material-1",
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
          },
        ]}
        onAssign={vi.fn()}
        onCreate={vi.fn(() => null)}
        onCreatePreset={vi.fn(() => null)}
        onCreateTexturePreset={vi.fn(() => null)}
        onDuplicate={vi.fn(() => null)}
        onImportGlsl={vi.fn(async () => undefined)}
        onRemoveAsset={vi.fn()}
        onRename={vi.fn()}
        onUpdateSource={vi.fn()}
        onUpdateParameter={vi.fn()}
        onUpdateTexture={vi.fn()}
        textureAssets={[]}
      />,
    );

    expect(markup).toContain("Rejected");
    expect(markup).toContain("WGSL compilation failed");
    expect(markup).toContain("material.glsl:2:12: expected &#x27;)&#x27;");
    expect(markup).toContain("void main( {");
  });

  it("shows the selected object's project PNG and sampler for a texture material", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active
        assignedParameters={[]}
        assignedShaderId="screen-texture"
        assignedTexture={{
          asset: { assetId: "asset:diagram", sha256: "a".repeat(64) },
          sampler: "nearest",
        }}
        available
        compileError={null}
        materials={[
          {
            assignmentCount: 1,
            glslSource: null,
            name: "Screen texture",
            parameterSchema: [],
            revision: 1,
            shaderId: "screen-texture",
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
            textureSlot: "texture2d",
          },
        ]}
        onAssign={vi.fn()}
        onCreate={vi.fn(() => null)}
        onCreatePreset={vi.fn(() => null)}
        onCreateTexturePreset={vi.fn(() => null)}
        onDuplicate={vi.fn(() => null)}
        onImportGlsl={vi.fn(async () => undefined)}
        onRemoveAsset={vi.fn()}
        onRename={vi.fn()}
        onUpdateSource={vi.fn()}
        onUpdateParameter={vi.fn()}
        onUpdateTexture={vi.fn()}
        textureAssets={[{ assetId: "asset:diagram", label: "Diagram (640×360)" }]}
      />,
    );

    expect(markup).toContain('aria-label="Material texture"');
    expect(markup).toContain("Diagram (640×360)");
    expect(markup).toContain('<option value="nearest" selected="">Nearest</option>');
    expect(markup).toContain("Texture materials use canonical WGSL");
  });

  it("identifies a missing project PNG and keeps replacement available", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active={false}
        assignedParameters={[]}
        assignedShaderId="screen-texture"
        assignedTexture={{
          asset: { assetId: "asset:deleted", sha256: "a".repeat(64) },
          sampler: "linear",
        }}
        available={false}
        compileError="The material texture asset is unavailable."
        materials={[
          {
            assignmentCount: 1,
            glslSource: null,
            name: "Screen texture",
            parameterSchema: [],
            revision: 1,
            shaderId: "screen-texture",
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
            textureSlot: "texture2d",
          },
        ]}
        onAssign={vi.fn()}
        onCreate={vi.fn(() => null)}
        onCreatePreset={vi.fn(() => null)}
        onCreateTexturePreset={vi.fn(() => null)}
        onDuplicate={vi.fn(() => null)}
        onImportGlsl={vi.fn(async () => undefined)}
        onRemoveAsset={vi.fn()}
        onRename={vi.fn()}
        onUpdateSource={vi.fn()}
        onUpdateParameter={vi.fn()}
        onUpdateTexture={vi.fn()}
        textureAssets={[{ assetId: "asset:replacement", label: "Replacement (320×180)" }]}
      />,
    );

    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("Missing PNG: asset:deleted");
    expect(markup).toContain("Choose an available project PNG to repair this material.");
    expect(markup).toContain("Replacement (320×180)");
    const texturePicker = markup.match(/<select[^>]*id="fragment-material-texture-asset"[^>]*>/)?.[0];
    expect(texturePicker).not.toContain(' disabled=""');
    expect(markup).toContain('disabled="" id="fragment-material-texture-filter"');
  });

  it("does not let a missing texture repair bypass an object lock", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active={false}
        assignedParameters={[]}
        assignedShaderId="screen-texture"
        assignedTexture={{
          asset: { assetId: "asset:deleted", sha256: "a".repeat(64) },
          sampler: "linear",
        }}
        available={false}
        compileError="The material texture asset is unavailable."
        materials={[
          {
            assignmentCount: 1,
            glslSource: null,
            name: "Screen texture",
            parameterSchema: [],
            revision: 1,
            shaderId: "screen-texture",
            source: STUDIO_WAVE_FRAGMENT_SOURCE_V1,
            textureSlot: "texture2d",
          },
        ]}
        objectEditingDisabled
        onAssign={vi.fn()}
        onCreate={vi.fn(() => null)}
        onCreatePreset={vi.fn(() => null)}
        onCreateTexturePreset={vi.fn(() => null)}
        onDuplicate={vi.fn(() => null)}
        onImportGlsl={vi.fn(async () => undefined)}
        onRemoveAsset={vi.fn()}
        onRename={vi.fn()}
        onUpdateSource={vi.fn()}
        onUpdateParameter={vi.fn()}
        onUpdateTexture={vi.fn()}
        textureAssets={[{ assetId: "asset:replacement", label: "Replacement (320×180)" }]}
      />,
    );

    const texturePicker = markup.match(/<select[^>]*id="fragment-material-texture-asset"[^>]*>/)?.[0];
    expect(texturePicker).toContain('disabled=""');
    expect(markup).toContain("Unlock this object in Layers before changing its material.");
  });
});
