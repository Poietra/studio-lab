import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  STUDIO_GRADIENT_FRAGMENT_SOURCE_V1,
  STUDIO_TEXTURE_FRAGMENT_SOURCE_V1,
  STUDIO_WAVE_FRAGMENT_SOURCE_V1,
} from "../engine/fragment-material-registry";
import { STUDIO_TEXTURE_FRAGMENT_PARAMETER_SCHEMA_V1 } from "./fragment-material-authoring";
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
    expect(markup).toContain("Shader parameter schema");
    expect(markup).toContain("Unassign this material from 2 object(s) before editing its parameter schema.");
    expect(markup).toContain("parameters_0.x");
    expect(markup).toContain("parameters_0.y");
    expect(markup).toContain("Add scalar parameter");
    expect(markup).toContain("Add RGB parameter");
    expect(markup).toContain('aria-label="Default RGB parameter color"');
    expect(markup).toContain('name="default"');
    expect(markup).toContain('name="min"');
    expect(markup).toContain('name="max"');
    expect(markup).toContain('name="step"');
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

  it("renders native Cool and Warm color controls from their flat host parameter slots", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active
        assignedParameters={[0.75, 1.5, 0.2, 0.55, 1, 1, 0.3, 0.65]}
        assignedShaderId="gradient"
        assignedTexture={null}
        available
        compileError={null}
        materials={[
          {
            assignmentCount: 1,
            glslSource: null,
            name: "Gradient",
            parameterSchema: [
              { default: 0.75, name: "Angle", range: { max: 3.14, min: -3.14, step: 0.05 }, type: "f32" },
              { default: 1.5, name: "Spread", range: { max: 4, min: 0.25, step: 0.05 }, type: "f32" },
              { default: [0.2, 0.55, 1], name: "Cool", type: "rgb" },
              { default: [1, 0.3, 0.65], name: "Warm", type: "rgb" },
            ],
            revision: 1,
            shaderId: "gradient",
            source: STUDIO_GRADIENT_FRAGMENT_SOURCE_V1,
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

    expect(markup).toContain('aria-label="Cool material color"');
    expect(markup).toContain('aria-label="Warm material color"');
    expect(markup).toContain('type="color" value="#338cff"');
    expect(markup).toContain('type="color" value="#ff4da6"');
    expect(markup).toContain('aria-label="Angle material parameter"');
    expect(markup).toContain('aria-label="Spread material parameter"');
    expect(markup).toContain("RGB parameter");
    expect(markup).toContain('name="defaultColor"');
    expect(markup).toContain("parameters_0.x");
    expect(markup).toContain("parameters_1.w");
    expect(markup).toContain("All 8 slots used");
  });

  it("shows the selected object's project PNG and sampler for a texture material", () => {
    const markup = renderToStaticMarkup(
      <FragmentMaterialEditor
        active
        assignedParameters={[2, 1.5, 0.25, -0.1, 0.7]}
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
            parameterSchema: STUDIO_TEXTURE_FRAGMENT_PARAMETER_SCHEMA_V1,
            revision: 1,
            shaderId: "screen-texture",
            source: STUDIO_TEXTURE_FRAGMENT_SOURCE_V1,
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
    expect(markup).toContain('aria-label="Tiles X material parameter"');
    expect(markup).toContain('aria-label="Tiles Y material parameter"');
    expect(markup).toContain('aria-label="Offset X material parameter"');
    expect(markup).toContain('aria-label="Offset Y material parameter"');
    expect(markup).toContain('aria-label="Mix material parameter"');
    expect(markup).toContain("0.7");
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
