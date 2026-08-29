import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  StudioEmptyWorkspace,
  type StudioEmptyWorkspaceEntityType,
  studioNativeWorkspaceOnboardingAvailable,
} from "./studio-empty-workspace";

function findActionButton(
  tree: ReactNode,
  type: StudioEmptyWorkspaceEntityType,
): ReactElement<Record<string, unknown>> {
  let result: ReactElement<Record<string, unknown>> | null = null;
  const visit = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (result || !isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "button" && child.props["data-studio-empty-workspace-action"] === type) {
        result = child;
        return;
      }
      visit(child.props.children as ReactNode);
    });
  };
  visit(tree);
  if (!result) throw new Error(`No empty-workspace action exists for ${type}.`);
  return result;
}

describe("StudioEmptyWorkspace", () => {
  it("limits onboarding to a native workspace with no authored objects or draft", () => {
    expect(
      studioNativeWorkspaceOnboardingAvailable({
        authoredObjectCount: 0,
        draftActive: false,
        nativeSceneActive: true,
        scenePostEffectCount: 0,
      }),
    ).toBe(true);
    expect(
      studioNativeWorkspaceOnboardingAvailable({
        authoredObjectCount: 1,
        draftActive: false,
        nativeSceneActive: true,
        scenePostEffectCount: 0,
      }),
    ).toBe(false);
    expect(
      studioNativeWorkspaceOnboardingAvailable({
        authoredObjectCount: 0,
        draftActive: true,
        nativeSceneActive: true,
        scenePostEffectCount: 0,
      }),
    ).toBe(false);
    expect(
      studioNativeWorkspaceOnboardingAvailable({
        authoredObjectCount: 0,
        draftActive: false,
        nativeSceneActive: false,
        scenePostEffectCount: 0,
      }),
    ).toBe(false);
    expect(
      studioNativeWorkspaceOnboardingAvailable({
        authoredObjectCount: 0,
        draftActive: false,
        nativeSceneActive: true,
        scenePostEffectCount: 1,
      }),
    ).toBe(false);
  });

  it("offers canonical Text, Circle, and Rectangle creation actions", () => {
    const onCreateEntity = vi.fn();
    const tree = StudioEmptyWorkspace({ onCreateEntity });

    for (const type of ["Text", "Circle", "Rectangle"] as const) {
      const button = findActionButton(tree, type);
      (button.props.onClick as () => void)();
    }

    expect(onCreateEntity.mock.calls).toEqual([["Text"], ["Circle"], ["Rectangle"]]);
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain('aria-label="Empty canvas"');
    expect(markup).toContain("Create your first object");
    expect(markup).not.toContain("Add starter composition");
  });

  it("retains the existing starter composition as an optional secondary action", () => {
    const onCreateStarterComposition = vi.fn();
    const markup = renderToStaticMarkup(
      <StudioEmptyWorkspace onCreateEntity={vi.fn()} onCreateStarterComposition={onCreateStarterComposition} />,
    );

    expect(markup).toContain("Add starter composition");
  });
});
