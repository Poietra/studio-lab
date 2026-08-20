import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { importManimScene } from "../render-pipeline/source-import";
import type { ManimWorkspaceScene } from "./imported-workspace";
import { projectStudioLayers, type StudioLayerEntry } from "./layer-order";
import type { ProjectedEntity } from "./model";
import { WorkspaceSidebar } from "./studio-sidebars";

function entity(id: string): ProjectedEntity {
  return {
    geometry: {
      dimensions: { kind: "known", value: { radius: 1 } },
      position: { kind: "known", value: { x: 0, y: 0 } },
      scale: { kind: "known", value: 1 },
      style: { kind: "known", value: {} },
    },
    id,
    opacity: 1,
    position: { x: 0, y: 0 },
    present: true,
    provisional: false,
    scale: 1,
    sourceIdentity: { kind: "unknown", reason: "Studio-created" },
    type: "Circle",
  };
}

function activeScene(): ManimWorkspaceScene {
  const imported = importManimScene(
    "from manim import *\nclass LayerScene(Scene):\n    def construct(self):\n        self.wait(1)\n",
    "scene.py",
    "LayerScene",
  );
  if (!imported) throw new Error("Expected LayerScene to import.");
  return { ...imported, nextSceneId: null, sourcePath: "scene.py" };
}

describe("WorkspaceSidebar Layers", () => {
  it("lists the verified native image.png with Add and an explicit source-export boundary", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene()}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={1}
        durationError={null}
        durationMinimum={0.1}
        editingAppliedTransactionId={null}
        entities={[]}
        imageAssets={[
          {
            byteLength: 74,
            bytes: new ArrayBuffer(74),
            image: {
              asset: { assetId: "image-scene/asset:image.png", sha256: "4".repeat(64) },
              localRect: { bottom: -0.5, left: -1, right: 1, top: 0.5 },
              sampler: "nearest",
            },
            label: "image.png",
            pixelHeight: 1,
            pixelWidth: 2,
          },
        ]}
        nextScene={null}
        onAddImageAsset={vi.fn()}
        onDurationChange={vi.fn()}
        onEditAppliedProgram={vi.fn()}
        onRedo={vi.fn()}
        onToggleEntity={vi.fn()}
        onUndo={vi.fn()}
        redoCount={0}
        selectedIds={new Set()}
        sourceImportOutcomes={[]}
      />,
    );

    expect(markup).toContain("Assets");
    expect(markup).toContain("Images");
    expect(markup).toContain("image.png");
    expect(markup).toContain('alt="image.png"');
    expect(markup).toContain("2 × 1");
    expect(markup).toContain("+ Add");
    expect(markup).toContain("Manim source export is unsupported");
  });

  it("renders a native Images empty state without a verified manifest asset", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene()}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={1}
        durationError={null}
        durationMinimum={0.1}
        editingAppliedTransactionId={null}
        entities={[]}
        nextScene={null}
        onDurationChange={vi.fn()}
        onEditAppliedProgram={vi.fn()}
        onRedo={vi.fn()}
        onToggleEntity={vi.fn()}
        onUndo={vi.fn()}
        redoCount={0}
        selectedIds={new Set()}
        sourceImportOutcomes={[]}
      />,
    );

    expect(markup).toContain("No verified project image is available in this Scene.");
    expect(markup).not.toContain("Add image.png");
  });

  it("offers bounded local PNG import only when the native workspace supplies the action", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene()}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={1}
        durationError={null}
        durationMinimum={0.1}
        editingAppliedTransactionId={null}
        entities={[]}
        imageImportError="The PNG could not be decoded."
        nextScene={null}
        onDurationChange={vi.fn()}
        onEditAppliedProgram={vi.fn()}
        onImportImageFile={vi.fn()}
        onRedo={vi.fn()}
        onToggleEntity={vi.fn()}
        onUndo={vi.fn()}
        redoCount={0}
        selectedIds={new Set()}
        sourceImportOutcomes={[]}
      />,
    );

    expect(markup).toContain("+ Import PNG");
    expect(markup).toContain('accept="image/png,.png"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The PNG could not be decoded.");
  });

  it("uses canonical front-first rows and reflects the shared Canvas selection", () => {
    const front = entity("front");
    const back = entity("back");
    const layers: readonly StudioLayerEntry[] = [
      {
        canMove: { back: true, backward: true, forward: false, front: false },
        entity: front,
        readOnlyReason: null,
        sceneOrder: 1,
        sourceAnchor: 0,
        sourceZIndex: 2,
        visibilityReadOnlyReason: null,
        visible: true,
      },
      {
        canMove: { back: false, backward: false, forward: true, front: true },
        entity: back,
        readOnlyReason: "Imported Manim object: z-order round-trip is not supported yet.",
        sceneOrder: 0,
        sourceAnchor: 0,
        sourceZIndex: 1,
        visibilityReadOnlyReason: "Imported Manim object: visibility round-trip is not supported yet.",
        visible: true,
      },
    ];

    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene()}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={1}
        durationError={null}
        durationMinimum={0.1}
        editingAppliedTransactionId={null}
        entities={[back, front]}
        layers={layers}
        nextScene={null}
        onDurationChange={vi.fn()}
        onEditAppliedProgram={vi.fn()}
        onLayerOrder={vi.fn()}
        onLayerReorder={vi.fn()}
        onRedo={vi.fn()}
        onToggleLayerGroupVisibility={vi.fn()}
        onToggleEntity={vi.fn()}
        onToggleEntityVisibility={vi.fn()}
        onUndo={vi.fn()}
        redoCount={0}
        selectedIds={new Set(["front"])}
        sourceImportOutcomes={[]}
      />,
    );

    expect(markup).toContain("Layers");
    expect(markup.indexOf("Select front")).toBeLessThan(markup.indexOf("Select back"));
    expect(markup).toMatch(/aria-label="Select front"[^>]*checked=""/);
    expect(markup).toMatch(/draggable="true"[^>]*title="Drag to reorder this layer"/);
    expect(markup.match(/draggable="true"/g)).toHaveLength(1);
    expect(markup).toContain('title="Imported Manim object: z-order round-trip is not supported yet."');
    expect(markup).toContain('aria-label="Backward front"');
    expect(markup).toMatch(/aria-label="Front front"[^>]*disabled=""/);
    expect(markup).toMatch(/aria-label="Hide back"[^>]*disabled=""/);
  });

  it("keeps a user-locked row selectable and disables its authoring controls", () => {
    const front = entity("front");
    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene()}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={1}
        durationError={null}
        durationMinimum={0.1}
        editingAppliedTransactionId={null}
        entities={[front]}
        layers={[
          {
            canMove: { back: true, backward: true, forward: true, front: true },
            entity: front,
            readOnlyReason: null,
            sceneOrder: 0,
            sourceAnchor: 0,
            sourceZIndex: 1,
            visibilityReadOnlyReason: null,
            visible: true,
          },
        ]}
        lockedEntityIds={new Set(["front"])}
        nextScene={null}
        onDurationChange={vi.fn()}
        onEditAppliedProgram={vi.fn()}
        onLayerOrder={vi.fn()}
        onLayerReorder={vi.fn()}
        onRedo={vi.fn()}
        onToggleEntity={vi.fn()}
        onToggleEntityLock={vi.fn()}
        onToggleEntityVisibility={vi.fn()}
        onUndo={vi.fn()}
        redoCount={0}
        selectedIds={new Set(["front"])}
        sourceImportOutcomes={[]}
      />,
    );

    const lockButton = markup.match(/<button aria-label="Unlock front"[^>]*>/)?.[0];
    expect(lockButton).toContain('aria-pressed="true"');
    expect(lockButton).toContain('draggable="false"');
    expect(markup).toMatch(/aria-label="Select front"[^>]*checked=""/);
    expect(markup).toMatch(/aria-label="Back front"[^>]*disabled=""/);
    expect(markup).toContain("Unlock this object before reordering it.");
    expect(markup).toContain("Locked");
  });

  it("exposes lock-only Undo and Redo history without requiring an applied Program", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene()}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={1}
        durationError={null}
        durationMinimum={0.1}
        editingAppliedTransactionId={null}
        entities={[]}
        nextScene={null}
        onDurationChange={vi.fn()}
        onEditAppliedProgram={vi.fn()}
        onRedo={vi.fn()}
        onToggleEntity={vi.fn()}
        onUndo={vi.fn()}
        redoCount={1}
        selectedIds={new Set()}
        sourceImportOutcomes={[]}
        undoAvailable
      />,
    );

    expect(markup).toContain('aria-label="Undo latest editor action"');
    expect(markup).toContain('aria-label="Redo latest editor action"');
  });

  it("keeps a hidden row selectable and exposes an accessible Show action", () => {
    const hidden = entity("hidden");
    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene()}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={1}
        durationError={null}
        durationMinimum={0.1}
        editingAppliedTransactionId={null}
        entities={[hidden]}
        layers={[
          {
            canMove: { back: false, backward: false, forward: false, front: false },
            entity: hidden,
            readOnlyReason: null,
            sceneOrder: 0,
            sourceAnchor: 0,
            sourceZIndex: 1,
            visibilityReadOnlyReason: null,
            visible: false,
          },
        ]}
        nextScene={null}
        onDurationChange={vi.fn()}
        onEditAppliedProgram={vi.fn()}
        onRedo={vi.fn()}
        onToggleEntity={vi.fn()}
        onToggleEntityVisibility={vi.fn()}
        onUndo={vi.fn()}
        redoCount={0}
        selectedIds={new Set(["hidden"])}
        sourceImportOutcomes={[]}
      />,
    );

    expect(markup).toMatch(/aria-label="Select hidden"[^>]*checked=""/);
    expect(markup).toMatch(/aria-label="Show hidden"[^>]*aria-pressed="true"/);
    expect(markup).toContain("Hidden");
  });

  it("disables every z-order control while a Studio logical group is active", () => {
    const first = entity("first");
    const second = entity("second");
    const outside = entity("outside");
    const layers = projectStudioLayers({
      canonicalEntities: [
        { geometry: { kind: "group" }, id: "tx:group/entity:group", sceneOrder: 3, sourceZIndex: 1 },
        { id: "first", parentId: "tx:group/entity:group", sceneOrder: 0, sourceZIndex: 0 },
        { id: "second", parentId: "tx:group/entity:group", sceneOrder: 1, sourceZIndex: 1 },
        { id: "outside", sceneOrder: 2, sourceZIndex: 2 },
      ],
      creationSourceAnchors: new Map([
        ["first", 0],
        ["second", 0],
        ["outside", 0],
      ]),
      entities: [first, second, outside],
      sourceRuntimeIdentity: null,
    });
    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene()}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={1}
        durationError={null}
        durationMinimum={0.1}
        editingAppliedTransactionId={null}
        entities={[first, second, outside]}
        layers={layers}
        nextScene={null}
        onDurationChange={vi.fn()}
        onEditAppliedProgram={vi.fn()}
        onLayerOrder={vi.fn()}
        onLayerReorder={vi.fn()}
        onRedo={vi.fn()}
        onToggleLayerGroupVisibility={vi.fn()}
        onToggleEntity={vi.fn()}
        onUndo={vi.fn()}
        redoCount={0}
        selectedIds={new Set(["outside"])}
        sourceImportOutcomes={[]}
      />,
    );

    expect(markup).not.toContain('draggable="true"');
    expect(markup).toContain('aria-label="Hide group of 2 objects"');
    expect(markup).toContain('title="Hide group"');
    expect(markup).toMatch(/aria-label="Back outside"[^>]*disabled=""/);
    expect(markup).toContain("atomic group reordering is not available yet");
  });
});
