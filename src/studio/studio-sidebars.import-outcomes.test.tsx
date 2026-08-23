import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { importManimScene } from "../render-pipeline/source-import";
import type { ManimWorkspaceScene } from "./imported-workspace";
import { WorkspaceSidebar } from "./studio-sidebars";

describe("WorkspaceSidebar source import outcomes", () => {
  it("shows an omitted constructor as read-only without an object selection control", () => {
    const source = `from manim import *

class MixedScene(Scene):
    def construct(self):
        custom = CustomMobject()
        self.add(custom)
`;
    const imported = importManimScene(source, "scene.py", "MixedScene");
    if (!imported) throw new Error("Expected MixedScene to import.");
    const activeScene: ManimWorkspaceScene = {
      ...imported,
      nextSceneId: null,
      sourcePath: "scene.py",
    };

    const markup = renderToStaticMarkup(
      <WorkspaceSidebar
        activeScene={activeScene}
        appliedProgramReadOnlyReasons={{}}
        appliedEdits={[]}
        appliedTransactionIds={new Set()}
        draftActive={false}
        duration={5}
        durationBlocker="Later authored content follows the Studio-added wait."
        durationError={null}
        durationMinimum={4.2}
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
        sourceImportOutcomes={imported.importOutcomes}
      />,
    );

    expect(markup).toContain('aria-label="Read-only source bindings"');
    expect(markup).toContain("Source-only bindings");
    expect(markup).toContain("custom");
    expect(markup).toContain("Read-only");
    expect(markup).toContain('min="4.2"');
    expect(markup).toContain("Later authored content follows the Studio-added wait.");
    expect(markup).not.toContain('type="checkbox"');
  });
});
