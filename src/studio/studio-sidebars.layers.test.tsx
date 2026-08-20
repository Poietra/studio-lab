import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { importManimScene } from "../render-pipeline/source-import";
import type { ManimWorkspaceScene } from "./imported-workspace";
import type { StudioLayerEntry } from "./layer-order";
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
      },
      {
        canMove: { back: false, backward: false, forward: true, front: true },
        entity: back,
        readOnlyReason: "Imported Manim object: z-order round-trip is not supported yet.",
        sceneOrder: 0,
        sourceAnchor: 0,
        sourceZIndex: 1,
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
        onToggleEntity={vi.fn()}
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
});
