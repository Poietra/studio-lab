import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { ProjectedEntity } from "./model";
import { compensatePreviewGeometryForSemanticScalesV1, StudioCanvas, type StudioCanvasProps } from "./studio-canvas";
import { StudioInspector } from "./studio-sidebars";
import { createDirectManipulationPositionProgram } from "./suggestion-program";
import {
  projectStudioPreviewRuntimeTraceOpaqueSelectionEntitiesV1,
  type StudioPreviewRendererViewV1,
} from "./use-preview-renderer";

const CIRCLE_ENTITY: ProjectedEntity = {
  geometry: {
    dimensions: { kind: "known", value: { radius: 0.5 } },
    position: { kind: "known", value: { x: 320, y: 180 } },
    scale: { kind: "known", value: 1 },
    style: { kind: "known", value: {} },
  },
  id: "entity:circle_1",
  opacity: 1,
  position: { x: 320, y: 180 },
  present: true,
  provisional: false,
  scale: 1,
  sourceIdentity: { kind: "known", value: "circle_1" },
  type: "Circle",
};

function lineJointsTriangle(sourceName: "t1" | "t2" | "t3", x: number): ProjectedEntity {
  const runtimeOwned = (field: string) => ({ kind: "unknown" as const, reason: `VGroup owns runtime ${field}.` });
  return {
    geometry: {
      dimensions: runtimeOwned("dimensions"),
      position: runtimeOwned("position"),
      scale: runtimeOwned("scale"),
      style: runtimeOwned("paint"),
    },
    id: `source:example_scenes/basic.py#LineJoints:${sourceName}`,
    opacity: 1,
    position: { x, y: 180 },
    present: true,
    provisional: false,
    scale: 1,
    sourceIdentity: { kind: "known", value: sourceName },
    type: "Triangle",
  };
}

function findEntityButton(tree: ReactNode, entityId: string): ReactElement<Record<string, unknown>> {
  let result: ReactElement<Record<string, unknown>> | null = null;
  const visit = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (result || !isValidElement<Record<string, unknown>>(child)) return;
      if (child.type === "button" && child.props["data-studio-entity"] === entityId) {
        result = child;
        return;
      }
      visit(child.props.children as ReactNode);
    });
  };
  visit(tree);
  if (!result) throw new Error(`No Studio entity button exists for ${entityId}.`);
  return result;
}

function baseProps(): StudioCanvasProps {
  return {
    appliedTransactionIds: new Set<string>(),
    boundaryActive: false,
    cameraScale: 1,
    draftTransactionId: null,
    dragPreview: null,
    editableMotionIds: new Set<string>(),
    entities: [CIRCLE_ENTITY],
    frame: { height: 8, width: 14.222 },
    geometryPreview: null,
    incomingSceneName: null,
    insertTool: "select",
    interactionMode: "position",
    motionPaths: [],
    onCanvasPlace: vi.fn(),
    onEntityKeyDown: vi.fn(),
    onEntityPointerCancel: vi.fn(),
    onEntityPointerDown: vi.fn(),
    onEntityPointerMove: vi.fn(),
    onEntityPointerUp: vi.fn(),
    onEntityResizeCancel: vi.fn(),
    onEntityResizeKeyDown: vi.fn(),
    onEntityResizePointerDown: vi.fn(),
    onEntityResizePointerMove: vi.fn(),
    onEntityResizePointerUp: vi.fn(),
    onMotionControlChange: vi.fn(),
    onSelectEntity: vi.fn(),
    readOnly: false,
    sampleId: "sample-1",
    scalePreview: null,
    selectedIds: new Set<string>(),
  };
}

function renderSelectedInspector(
  entity: ProjectedEntity,
  draftError: string | null,
  draftProgram: Parameters<typeof StudioInspector>[0]["draftProgram"] = null,
) {
  return renderToStaticMarkup(
    <StudioInspector
      appliedProgramCount={0}
      draftApplyPending={false}
      draftError={draftError}
      draftOperation={null}
      draftProgram={draftProgram}
      inspectorReturnFocus={null}
      onApplyDraft={vi.fn()}
      onDiscardDraft={vi.fn()}
      onDraftOperationChange={vi.fn()}
      onEntityEdit={vi.fn()}
      onEntityScaleChange={vi.fn()}
      onInspectorFocusRestored={vi.fn()}
      onRenderSessionChange={vi.fn()}
      onSourceChanged={vi.fn()}
      onSourceMutationPendingChange={vi.fn()}
      renderCandidate={null}
      renderCandidateLifecycleBlocker={null}
      renderCandidateUnavailableReason="No render candidate."
      renderSession={null}
      replacingAppliedProgram={false}
      selectedEntity={entity}
      sourceExport={null}
      suggestion={null}
      workspace={null}
    />,
  );
}

function previewView(
  state: StudioPreviewRendererViewV1["state"],
  interactionGeometry: StudioPreviewRendererViewV1["interactionGeometry"] = null,
  sourceRuntimeIdentity: StudioPreviewRendererViewV1["sourceRuntimeIdentity"] = null,
  interactionAuthority: StudioPreviewRendererViewV1["interactionAuthority"] = { kind: "interactive" },
  initialEditRuntimeAuthority: StudioPreviewRendererViewV1["initialEditRuntimeAuthority"] = null,
  runtimeTraceTerminalEditAuthority: StudioPreviewRendererViewV1["runtimeTraceTerminalEditAuthority"] = null,
  runtimeTraceValidationPending: StudioPreviewRendererViewV1["runtimeTraceValidationPending"] = null,
  runtimeTraceBaseFrameRetained = runtimeTraceValidationPending?.baseFrameRetained === true,
  runtimeTraceOpaqueSelectionEntities: StudioPreviewRendererViewV1["runtimeTraceOpaqueSelectionEntities"] = [],
): StudioPreviewRendererViewV1 {
  return {
    attachCanvas: vi.fn(),
    cameraCenter: null,
    epoch: 0,
    initialEditRuntimeAuthority,
    interactionGeometry,
    interactionAuthority,
    runtimeTraceBaseFrameRetained,
    runtimeTraceTerminalEditAuthority,
    runtimeTraceOpaqueSelectionEntities,
    runtimeTraceValidationPending,
    sourceLabel: "verified fixture",
    sourceMetadataPhase: "ready",
    sourceRuntimeIdentity,
    state,
    syntheticInitialEditAnchor: null,
    verifiedSourceDuration: 2,
  };
}

describe("StudioCanvas retained preview layer", () => {
  it("cancels semantic CSS scales so sampled runtime bounds are applied exactly once", () => {
    expect(
      compensatePreviewGeometryForSemanticScalesV1(
        { dimensions: { height: 2, width: 4 }, position: { x: 480, y: 90 } },
        2,
        0.5,
      ),
    ).toEqual({ dimensions: { height: 2, width: 4 }, position: { x: 400, y: 135 } });
  });

  it("renders no canvas layer by default so the semantic preview stays authoritative", () => {
    const markup = renderToStaticMarkup(<StudioCanvas {...baseProps()} />);
    expect(markup).toContain('data-preview-renderer="off"');
    expect(markup).not.toContain("data-preview-revision");
    expect(markup).not.toContain("data-studio-preview-canvas");
    expect(markup).not.toContain("data-studio-preview-status");
  });

  it("exposes the whole-Scene fallback reason without hiding the semantic DOM", () => {
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView({ detail: "wasm-load-failed: no module", phase: "fallback", reason: "install-failed" })}
      />,
    );
    expect(markup).toContain('data-preview-renderer="fallback"');
    expect(markup).toContain('data-preview-fallback-reason="install-failed"');
    expect(markup).not.toContain("data-preview-revision");
    expect(markup).toContain("Canvas preview fallback · snapshot install failed");
    expect(markup).toMatch(/<canvas[^>]*invisible/);
    expect(markup).toContain("data-studio-transform-layer");
    // Fallback restores the semantic paint in the same render.
    expect(markup).toContain('data-studio-semantic-paint="painted"');
    expect(markup).not.toContain("deferred-to-canvas");
  });

  it("labels a presented frame as an editing preview without claiming render authority", () => {
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView({
          frame: {
            packetId: "canvas:2",
            revision: "a".repeat(64),
            sampleTime: 1,
            viewport: { heightPx: 90, widthPx: 160 },
          },
          phase: "presented",
        })}
      />,
    );
    expect(markup).toContain('data-preview-renderer="presented"');
    // The exact presented packet is exposed so E2E can bind pixel evidence to
    // this frame and no other.
    expect(markup).toContain('data-preview-packet-id="canvas:2"');
    expect(markup).toContain(`data-preview-revision="${"a".repeat(64)}"`);
    expect(markup).not.toContain("data-preview-fallback-reason");
    expect(markup).toContain("Canvas preview · verified fixture · editing preview only");
    expect(markup).not.toMatch(/<canvas[^>]*invisible/);
    expect(markup).toContain("data-studio-transform-layer");
    // A fully correlated presented frame replaces only the duplicate object
    // paint; the semantic hit target (the move button) stays in the
    // accessibility tree as a paint-free interaction overlay.
    expect(markup).toContain('data-studio-semantic-paint="deferred-to-canvas"');
    expect(markup).toContain('data-studio-entity="entity:circle_1"');
    expect(markup).toContain("Move circle_1");
  });

  it("offers the exact WarpSquare runtime target one uniform-scale handle instead of shape geometry handles", () => {
    const studioEntityId = "source:example_scenes/basic.py#WarpSquare:square";
    const runtimeEntityId = "scene:warp-square/entity:0";
    const square: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      geometry: {
        ...CIRCLE_ENTITY.geometry,
        dimensions: { kind: "known", value: { height: 2, width: 2 } },
      },
      id: studioEntityId,
      sourceIdentity: { kind: "known", value: "square" },
      type: "Square",
    };
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        entities={[square]}
        preview={previewView(
          {
            frame: {
              packetId: "canvas:warp-square",
              revision: "a".repeat(64),
              sampleTime: 0,
              viewport: { heightPx: 90, widthPx: 160 },
            },
            phase: "presented",
          },
          new Map([[runtimeEntityId, { dimensions: { height: 2, width: 2 }, position: { x: 320, y: 180 } }]]),
          new Map([
            [
              "square",
              { bindingId: `source-binding:${"b".repeat(64)}`, entityId: runtimeEntityId, sourceName: "square" },
            ],
          ]),
          { kind: "interactive" },
          {
            duration: 4,
            profile: "warp-square-v9",
            runtimeEntityId,
            studioEntityId,
            studioSceneId: "example_scenes/basic.py#WarpSquare",
          },
        )}
        selectedIds={new Set([studioEntityId])}
      />,
    );
    expect(markup).toContain('aria-label="Resize square from bottom-right corner"');
    expect(markup.match(/data-studio-resize-handle=/g)).toHaveLength(1);
  });

  it("presents display-only runtime pixels without enabling guessed authoring gestures", () => {
    const presented = {
      frame: {
        packetId: "canvas:v5",
        revision: "a".repeat(64),
        sampleTime: 1.5,
        viewport: { heightPx: 90, widthPx: 160 },
      },
      phase: "presented",
    } as const;
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView(presented, null, new Map(), {
          kind: "display-only",
          reason: "aggregate-mathtex-morph-lineage",
        })}
        selectedIds={new Set([CIRCLE_ENTITY.id])}
      />,
    );
    expect(markup).toContain('data-preview-interaction="display-only"');
    expect(markup).toContain("Canvas preview · verified fixture · display only");
    expect(markup).not.toContain('data-studio-entity="entity:circle_1"');
    expect(markup).not.toContain("Move circle_1");
    expect(markup).not.toContain("data-studio-resize-handle");

    const fallbackMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView({ detail: "device lost", phase: "fallback", reason: "renderer-failed" }, null, new Map(), {
          kind: "display-only",
          reason: "aggregate-mathtex-morph-lineage",
        })}
      />,
    );
    expect(fallbackMarkup).toContain('data-preview-interaction="display-only"');
    expect(fallbackMarkup).toMatch(/aria-label="Move circle_1"[^>]*disabled=""/);

    const unverifiedMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView(presented, null, null, {
          kind: "display-only",
          reason: "source-runtime-identity-unverified",
        })}
      />,
    );
    expect(unverifiedMarkup).toContain('data-preview-interaction="display-only"');
    expect(unverifiedMarkup).toContain("Canvas preview · verified fixture · display only");
    expect(unverifiedMarkup).not.toContain('data-studio-entity="entity:circle_1"');
  });

  it("moves hit targets to the verified snapshot's positions while presented", () => {
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView(
          {
            frame: {
              packetId: "canvas:2",
              revision: "a".repeat(64),
              sampleTime: 1,
              viewport: { heightPx: 90, widthPx: 160 },
            },
            phase: "presented",
          },
          new Map([
            [
              "scene:runtime/entity:0",
              { dimensions: { height: 0.8, width: 1.4222 }, position: { x: 0.4375 * 640, y: 180 } },
            ],
          ]),
          new Map([
            [
              "circle_1",
              {
                bindingId: `source-binding:${"b".repeat(64)}`,
                entityId: "scene:runtime/entity:0",
                sourceName: "circle_1",
              },
            ],
          ]),
        )}
      />,
    );
    // 0.4375 of the 640-wide Studio viewport = 43.75% — the IR position, not
    // the semantic projection's 50% center.
    expect(markup).toContain("left:43.75%");
    expect(markup).toContain('data-studio-runtime-entity="scene:runtime/entity:0"');
    expect(markup).toContain(`data-studio-runtime-binding="source-binding:${"b".repeat(64)}"`);
    expect(markup).toContain("height:10cqh;width:10cqw");
    const fallbackMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView(
          {
            detail: "An Edit Program changed the working revision.",
            phase: "fallback",
            reason: "snapshot-uncorrelated",
          },
          new Map([
            [
              "scene:runtime/entity:0",
              { dimensions: { height: 0.8, width: 1.4222 }, position: { x: 0.4375 * 640, y: 180 } },
            ],
          ]),
          new Map([
            [
              "circle_1",
              {
                bindingId: `source-binding:${"b".repeat(64)}`,
                entityId: "scene:runtime/entity:0",
                sourceName: "circle_1",
              },
            ],
          ]),
        )}
      />,
    );
    // An Edit Program makes snapshot pixels and their map uncorrelated in the
    // same render; hit targets return to semantic geometry even if the stale
    // map and runtime geometry are still retained in React state.
    expect(fallbackMarkup).toContain("left:50%");
    expect(fallbackMarkup).not.toContain("data-studio-runtime-entity");
  });

  it("sizes non-shape move targets from prepared visual bounds", () => {
    const textEntity: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      content: { displayLines: ["sample"], text: "sample" },
      geometry: {
        ...CIRCLE_ENTITY.geometry,
        dimensions: { kind: "unknown", reason: "Imported text dimensions are runtime-owned." },
      },
      type: "Text",
    };
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        entities={[textEntity]}
        preview={previewView(
          {
            frame: {
              packetId: "canvas:2",
              revision: "a".repeat(64),
              sampleTime: 1,
              viewport: { heightPx: 90, widthPx: 160 },
            },
            phase: "presented",
          },
          new Map([
            ["scene:runtime/entity:0", { dimensions: { height: 0.8, width: 1.4222 }, position: { x: 320, y: 180 } }],
          ]),
          new Map([
            [
              "circle_1",
              {
                bindingId: `source-binding:${"b".repeat(64)}`,
                entityId: "scene:runtime/entity:0",
                sourceName: "circle_1",
              },
            ],
          ]),
        )}
      />,
    );
    expect(markup).toMatch(/<button[^>]*style="height:10cqh;width:10cqw"/);
    expect(markup).toContain("pointer-events-none opacity-0");
  });

  it("keeps a verified ImageMobject selectable and aspect-resizable without semantic dimensions", () => {
    const imageEntity: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      content: { displayLines: ["image"], label: "image" },
      geometry: {
        ...CIRCLE_ENTITY.geometry,
        dimensions: { kind: "unknown", reason: "Imported image dimensions are runtime-owned." },
        position: { kind: "known", value: { x: 320, y: 180 } },
      },
      id: "entity:image",
      sourceIdentity: { kind: "known", value: "image" },
      type: "ImageMobject",
    };
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        entities={[imageEntity]}
        preview={previewView(
          {
            frame: {
              packetId: "canvas:image",
              revision: "a".repeat(64),
              sampleTime: 0,
              viewport: { heightPx: 90, widthPx: 160 },
            },
            phase: "presented",
          },
          new Map([["scene:image/entity:0", { dimensions: { height: 1, width: 2 }, position: { x: 320, y: 180 } }]]),
          new Map([
            [
              "image",
              {
                bindingId: `source-binding:${"c".repeat(64)}`,
                entityId: "scene:image/entity:0",
                sourceName: "image",
              },
            ],
          ]),
        )}
        selectedIds={new Set([imageEntity.id])}
      />,
    );
    expect(markup).toContain('aria-label="Move image"');
    expect(markup).not.toContain('aria-label="Move image" aria-pressed="true" disabled=""');
    expect(markup).toContain('data-studio-runtime-entity="scene:image/entity:0"');
    expect(markup).toContain("height:12.5cqh;width:14.0627");
    expect(markup).toContain('aria-label="Resize image from bottom-right corner"');
    expect(markup.match(/data-studio-resize-handle="entity:image"/g)).toHaveLength(1);
  });

  it("selects only the three LineJoints leaves without starting a source rewrite gesture", () => {
    const triangles = [lineJointsTriangle("t1", 120), lineJointsTriangle("t2", 320), lineJointsTriangle("t3", 520)];
    const selectionOnlyTriangles = triangles.map((entity) => ({ ...entity, present: false }));
    const groupRuntimeId = "scene:line-joints/entity:0";
    const leafRuntimeIds = [
      "scene:line-joints/entity:1",
      "scene:line-joints/entity:2",
      "scene:line-joints/entity:3",
    ] as const;
    const group: ProjectedEntity = {
      ...triangles[1]!,
      id: "source:example_scenes/basic.py#LineJoints:grp",
      sourceIdentity: { kind: "known", value: "grp" },
      type: "VGroup",
    };
    const interactionGeometry = new Map(
      leafRuntimeIds.map((runtimeEntityId, index) => [
        runtimeEntityId,
        { dimensions: { height: 3, width: 3 }, position: { x: 120 + index * 200, y: 180 } },
      ]),
    );
    const sourceRuntimeIdentity = new Map([
      ["grp", { bindingId: `source-binding:${"a".repeat(64)}`, entityId: groupRuntimeId, sourceName: "grp" }],
      ...triangles.map(
        (entity, index) =>
          [
            entity.sourceIdentity.kind === "known" ? entity.sourceIdentity.value : "",
            {
              bindingId: `source-binding:${String(index + 1).repeat(64)}`,
              entityId: leafRuntimeIds[index]!,
              sourceName: entity.sourceIdentity.kind === "known" ? entity.sourceIdentity.value : "",
            },
          ] as const,
      ),
    ]);
    const selected: ProjectedEntity[] = [];
    let draftError: string | null = null;
    const beginMutation = vi.fn(() => {
      draftError = "No safe .py source anchor exists before the playhead.";
    });
    const nudgeMutation = vi.fn();
    const props: StudioCanvasProps = {
      ...baseProps(),
      entities: [group, ...selectionOnlyTriangles],
      onEntityKeyDown: nudgeMutation,
      onEntityPointerDown: beginMutation,
      onSelectEntity: (entityId) => {
        const entity = selectionOnlyTriangles.find(({ id }) => id === entityId);
        if (entity) selected.push(entity);
      },
      preview: previewView(
        {
          frame: {
            packetId: "canvas:line-joints-v10",
            revision: "a".repeat(64),
            sampleTime: 0,
            viewport: { heightPx: 360, widthPx: 640 },
          },
          phase: "presented",
        },
        interactionGeometry,
        sourceRuntimeIdentity,
        { kind: "selection-only", reason: "source-edit-anchor-unavailable" },
      ),
      selectedIds: new Set([selectionOnlyTriangles[0]!.id]),
    };
    const tree = StudioCanvas(props);
    expect(() => findEntityButton(tree, group.id)).toThrow(/No Studio entity button/);

    for (const triangle of selectionOnlyTriangles) {
      const button = findEntityButton(tree, triangle.id);
      expect(button.props.disabled).toBe(false);
      expect(button.props.className).not.toContain("pointer-events-none");
      expect(button.props.onPointerMove).toBeUndefined();
      expect(button.props.onPointerUp).toBeUndefined();
      const stopPropagation = vi.fn();
      const pointerDown = button.props.onPointerDown as
        | ((event: Readonly<{ stopPropagation: () => void }>) => void)
        | undefined;
      expect(pointerDown).toBeTypeOf("function");
      pointerDown?.({ stopPropagation });
      expect(stopPropagation).toHaveBeenCalledOnce();

      const preventDefault = vi.fn();
      const keyDown = button.props.onKeyDown as
        | ((event: Readonly<{ key: string; preventDefault: () => void }>) => void)
        | undefined;
      keyDown?.({ key: "ArrowRight", preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
    }

    expect(selected).toEqual(selectionOnlyTriangles);
    expect(beginMutation).not.toHaveBeenCalled();
    expect(nudgeMutation).not.toHaveBeenCalled();
    expect(draftError).toBeNull();

    const markup = renderToStaticMarkup(<StudioCanvas {...props} />);
    expect(markup).toContain('data-preview-interaction="selection-only"');
    expect(markup).toContain("Canvas preview · verified fixture · selection only");
    expect(markup).not.toContain(groupRuntimeId);
    expect(markup).not.toContain(`data-studio-entity="${group.id}"`);
    expect(markup).not.toContain("Move grp");
    expect(markup.match(/data-studio-runtime-entity="scene:line-joints\/entity:[123]"/g)).toHaveLength(3);
    expect(markup).not.toContain("data-studio-resize-handle");

    for (const triangle of selected) {
      const inspector = renderSelectedInspector(triangle, draftError);
      if (triangle.sourceIdentity.kind !== "known") throw new Error("Expected a named Triangle source entity.");
      expect(inspector).toContain(`<dd class="truncate text-zinc-300">${triangle.sourceIdentity.value}</dd>`);
      expect(inspector).toContain('<dd class="text-zinc-300">Triangle</dd>');
    }

    const t2 = {
      ...triangles[1]!,
      geometry: {
        ...triangles[1]!.geometry,
        position: { kind: "known" as const, value: { x: 320, y: 180 } },
        scale: { kind: "known" as const, value: 1 },
      },
    };
    const beginAuthorizedMutation = vi.fn();
    const interactiveProps: StudioCanvasProps = {
      ...baseProps(),
      entities: [group, triangles[0]!, t2, triangles[2]!],
      onEntityPointerDown: beginAuthorizedMutation,
      preview: previewView(
        props.preview!.state,
        interactionGeometry,
        sourceRuntimeIdentity,
        { kind: "interactive" },
        {
          baseCenter: { x: 320, y: 180 },
          duration: 1,
          lifetime: { end: 1, start: 0 },
          profile: "line-joints-v10",
          relativeScale: 1,
          runtimeEntityId: leafRuntimeIds[1],
          studioEntityId: t2.id,
          studioSceneId: "example_scenes/basic.py#LineJoints",
        },
      ),
      selectedIds: new Set([t2.id]),
    };
    const interactiveTree = StudioCanvas(interactiveProps);
    expect(findEntityButton(interactiveTree, triangles[0]!.id).props.onPointerMove).toBeUndefined();
    const targetButton = findEntityButton(interactiveTree, t2.id);
    expect(targetButton.props.onPointerMove).toBe(interactiveProps.onEntityPointerMove);
    const targetPointerDown = targetButton.props.onPointerDown as ((event: unknown) => void) | undefined;
    targetPointerDown?.({});
    expect(beginAuthorizedMutation).toHaveBeenCalledWith({}, t2.id);

    const interactiveMarkup = renderToStaticMarkup(<StudioCanvas {...interactiveProps} />);
    expect(interactiveMarkup).not.toContain(`data-studio-entity="${group.id}"`);
    expect(interactiveMarkup.match(/data-studio-resize-handle=/g)).toHaveLength(1);
    expect(interactiveMarkup).toContain(`data-studio-resize-handle="${t2.id}"`);
  });

  it("opens only the Updaters Square at t=5 and labels its target-only validation ghost", () => {
    const squareId = "source:example_scenes/basic.py#UpdatersExample:square";
    const decimalId = "source:example_scenes/basic.py#UpdatersExample:decimal";
    const squareRuntimeId = "scene:updaters/runtime-root:square";
    const decimalRuntimeId = "scene:updaters/runtime-root:decimal";
    const square: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      geometry: {
        ...CIRCLE_ENTITY.geometry,
        dimensions: { kind: "known", value: { height: 2, width: 2 } },
      },
      id: squareId,
      sourceIdentity: { kind: "known", value: "square" },
      type: "Square",
    };
    const interactionGeometry = new Map([
      [squareRuntimeId, { dimensions: { height: 90, width: 90 }, position: { x: 320, y: 67.5 } }],
      [decimalRuntimeId, { dimensions: { height: 36, width: 130 }, position: { x: 440, y: 67.5 } }],
    ]);
    const sourceRuntimeIdentity = new Map([
      ["square", { bindingId: "source-binding:square", entityId: squareRuntimeId, sourceName: "square" }],
      ["decimal", { bindingId: "source-binding:decimal", entityId: decimalRuntimeId, sourceName: "decimal" }],
    ]);
    const terminalAuthority = {
      baseCenter: { x: 320, y: 67.5 },
      duration: 6 as const,
      profile: "updaters-terminal-v1" as const,
      relativeScale: 1 as const,
      runtimeEntityId: squareRuntimeId,
      sourceAnchor: 5 as const,
      sourceDimensions: { height: 2 as const, width: 2 as const },
      studioEntityId: squareId,
      studioSceneId: "example_scenes/basic.py#UpdatersExample",
    };
    const [decimal] = projectStudioPreviewRuntimeTraceOpaqueSelectionEntitiesV1({
      authority: terminalAuthority,
      interactionGeometry,
      sourceRuntimeIdentity,
    });
    if (!decimal || decimal.id !== decimalId) throw new Error("Expected the opaque runtime Decimal selector.");
    const boundedAuthority = {
      editableRuntimeEntityId: squareRuntimeId,
      kind: "bounded-interactive" as const,
      reason: "runtime-trace-terminal-edit" as const,
      sourceAnchor: 5 as const,
      verifiedRuntimeEntityIds: [squareRuntimeId, decimalRuntimeId],
    };
    const onPointerDown = vi.fn();
    const activeProps: StudioCanvasProps = {
      ...baseProps(),
      entities: [square, decimal],
      onEntityPointerDown: onPointerDown,
      preview: previewView(
        {
          frame: {
            packetId: "canvas:updaters-terminal",
            revision: "a".repeat(64),
            sampleTime: 5,
            viewport: { heightPx: 360, widthPx: 640 },
          },
          phase: "presented",
        },
        interactionGeometry,
        sourceRuntimeIdentity,
        boundedAuthority,
        null,
        terminalAuthority,
      ),
      selectedIds: new Set([squareId]),
    };
    const activeTree = StudioCanvas(activeProps);
    expect(findEntityButton(activeTree, squareId).props.onPointerMove).toBe(activeProps.onEntityPointerMove);
    expect(findEntityButton(activeTree, decimalId).props.onPointerMove).toBeUndefined();
    const activeMarkup = renderToStaticMarkup(<StudioCanvas {...activeProps} />);
    expect(activeMarkup).toContain("Square terminal edit at 5.00s");
    expect(activeMarkup.match(/data-studio-resize-handle=/g)).toHaveLength(1);
    expect(activeMarkup).toContain(`data-studio-resize-handle="${squareId}"`);

    const pendingSquare: ProjectedEntity = {
      ...square,
      geometry: {
        ...square.geometry,
        dimensions: { kind: "known", value: { height: 3, width: 3 } },
        position: { kind: "known", value: { x: 400, y: 90 } },
      },
      position: { x: 400, y: 90 },
    };
    const pendingMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...activeProps}
        entities={[pendingSquare, decimal]}
        preview={previewView(
          { detail: "Real Manim validation is pending.", phase: "fallback", reason: "snapshot-uncorrelated" },
          interactionGeometry,
          sourceRuntimeIdentity,
          {
            kind: "selection-only",
            reason: "runtime-trace-preview-only",
            verifiedRuntimeEntityIds: [squareRuntimeId, decimalRuntimeId],
          },
          null,
          null,
          {
            baseFrameRetained: true,
            dimensions: { height: 3, width: 3 },
            position: { x: 400, y: 90 },
            profile: "updaters-terminal-v1",
            sourceAnchor: 5,
            studioEntityId: squareId,
          },
        )}
      />,
    );
    expect(pendingMarkup).toContain("Draft ghost · dependent updater validation pending");
    expect(pendingMarkup).not.toContain('invisible" data-studio-preview-canvas');
    expect(pendingMarkup).toContain('data-studio-semantic-paint="painted"');
    expect(pendingMarkup.match(/data-studio-semantic-paint="deferred-to-canvas"/g)).toHaveLength(1);
    expect(pendingMarkup).toContain('data-studio-entity-width="3.0000"');
    expect(pendingMarkup).toContain("left:62.5%;top:25%");
    expect(pendingMarkup).not.toContain("data-studio-resize-handle");

    const scrubbedPendingMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...activeProps}
        entities={[pendingSquare, decimal]}
        preview={previewView(
          { detail: "Real Manim validation is pending.", phase: "fallback", reason: "snapshot-uncorrelated" },
          null,
          sourceRuntimeIdentity,
          {
            kind: "selection-only",
            reason: "runtime-trace-preview-only",
            verifiedRuntimeEntityIds: [squareRuntimeId, decimalRuntimeId],
          },
          null,
          null,
          {
            baseFrameRetained: false,
            dimensions: { height: 3, width: 3 },
            position: { x: 400, y: 90 },
            profile: "updaters-terminal-v1",
            sourceAnchor: 5,
            studioEntityId: squareId,
          },
        )}
      />,
    );
    expect(scrubbedPendingMarkup).toContain(`data-studio-entity="${squareId}"`);
    expect(scrubbedPendingMarkup).not.toContain(`data-studio-entity="${decimalId}"`);
    expect(scrubbedPendingMarkup).toContain("dependent updater validation pending");

    const transientMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...activeProps}
        dragPreview={{ delta: { x: 20, y: 10 }, entityIds: [squareId] }}
        preview={previewView(
          { detail: null, phase: "fallback", reason: "transient-edit" },
          interactionGeometry,
          sourceRuntimeIdentity,
          boundedAuthority,
          null,
          terminalAuthority,
          null,
          true,
        )}
      />,
    );
    expect(transientMarkup).not.toContain('invisible" data-studio-preview-canvas');
    expect(transientMarkup).toContain(`data-studio-entity="${decimalId}"`);
    expect(transientMarkup).toContain('data-studio-semantic-paint="painted"');

    const transientResizeMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...activeProps}
        preview={previewView(
          { detail: null, phase: "fallback", reason: "transient-edit" },
          interactionGeometry,
          sourceRuntimeIdentity,
          boundedAuthority,
          null,
          terminalAuthority,
          null,
          true,
        )}
        scalePreview={{ entityId: squareId, scale: 1.5 }}
      />,
    );
    expect(transientResizeMarkup).toContain('data-studio-entity-width="2.0000"');
    expect(transientResizeMarkup).toContain('style="scale:1.5"');
    expect(transientResizeMarkup).toContain('data-studio-semantic-paint="painted"');
  });

  it("opens only the OpeningManim grid title move at t=14 without resize handles", () => {
    const gridTitleId = "source:example_scenes/basic.py#OpeningManim:grid_title";
    const titleId = "source:example_scenes/basic.py#OpeningManim:title";
    const gridTitleRuntimeId = "scene:opening/runtime-root:grid-title";
    const titleRuntimeId = "scene:opening/runtime-root:title";
    const unknownDimensions = {
      evidence: ['Tex("This is a grid", font_size=72)'],
      kind: "unknown" as const,
      reason: "Tex dimensions depend on runtime layout.",
    };
    const gridTitle: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      geometry: { ...CIRCLE_ENTITY.geometry, dimensions: unknownDimensions },
      id: gridTitleId,
      sourceIdentity: { kind: "known", value: "grid_title" },
      type: "Tex",
    };
    const title: ProjectedEntity = {
      ...gridTitle,
      id: titleId,
      sourceIdentity: { kind: "known", value: "title" },
    };
    const interactionGeometry = new Map([
      [gridTitleRuntimeId, { dimensions: { height: 54, width: 305 }, position: { x: 145, y: 42 } }],
      [titleRuntimeId, { dimensions: { height: 48, width: 220 }, position: { x: 160, y: 55 } }],
    ]);
    const sourceRuntimeIdentity = new Map([
      [
        "grid_title",
        { bindingId: "source-binding:grid-title", entityId: gridTitleRuntimeId, sourceName: "grid_title" },
      ],
      ["title", { bindingId: "source-binding:title", entityId: titleRuntimeId, sourceName: "title" }],
    ]);
    const terminalAuthority = {
      baseCenter: { x: 145, y: 42 },
      duration: 15 as const,
      profile: "opening-grid-title-terminal-v2" as const,
      runtimeEntityId: gridTitleRuntimeId,
      sourceAnchor: 14 as const,
      studioEntityId: gridTitleId,
      studioSceneId: "example_scenes/basic.py#OpeningManim",
    };
    const boundedAuthority = {
      editableRuntimeEntityId: gridTitleRuntimeId,
      kind: "bounded-interactive" as const,
      reason: "runtime-trace-terminal-edit" as const,
      sourceAnchor: 14 as const,
      verifiedRuntimeEntityIds: [titleRuntimeId, gridTitleRuntimeId],
    };
    const activeProps: StudioCanvasProps = {
      ...baseProps(),
      entities: [gridTitle, title],
      preview: previewView(
        {
          frame: {
            packetId: "canvas:opening-terminal",
            revision: "a".repeat(64),
            sampleTime: 14,
            viewport: { heightPx: 360, widthPx: 640 },
          },
          phase: "presented",
        },
        interactionGeometry,
        sourceRuntimeIdentity,
        boundedAuthority,
        null,
        terminalAuthority,
      ),
      selectedIds: new Set([gridTitleId]),
    };
    const activeTree = StudioCanvas(activeProps);
    expect(findEntityButton(activeTree, gridTitleId).props.onPointerMove).toBe(activeProps.onEntityPointerMove);
    expect(findEntityButton(activeTree, titleId).props.onPointerMove).toBeUndefined();
    const activeMarkup = renderToStaticMarkup(<StudioCanvas {...activeProps} />);
    expect(activeMarkup).toContain("Grid title terminal edit at 14.00s");
    expect(activeMarkup).not.toContain("data-studio-resize-handle");

    const pendingGridTitle: ProjectedEntity = {
      ...gridTitle,
      geometry: {
        ...gridTitle.geometry,
        position: { kind: "known", value: { x: 169, y: 30 } },
      },
      position: { x: 169, y: 30 },
    };
    const pendingMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...activeProps}
        entities={[pendingGridTitle, title]}
        preview={previewView(
          { detail: "Real Manim validation is pending.", phase: "fallback", reason: "snapshot-uncorrelated" },
          interactionGeometry,
          sourceRuntimeIdentity,
          {
            kind: "selection-only",
            reason: "runtime-trace-preview-only",
            verifiedRuntimeEntityIds: [titleRuntimeId, gridTitleRuntimeId],
          },
          null,
          null,
          {
            baseFrameRetained: true,
            position: { x: 169, y: 30 },
            profile: "opening-grid-title-terminal-v2",
            sourceAnchor: 14,
            studioEntityId: gridTitleId,
          },
        )}
      />,
    );
    expect(pendingMarkup).toContain("Draft ghost · OpeningManim validation pending");
    expect(pendingMarkup).toContain('data-studio-entity-height="54.0000"');
    expect(pendingMarkup).toContain('data-studio-entity-width="305.0000"');
    expect(pendingMarkup).toContain("left:26.406249999999996%");
    expect(pendingMarkup).toContain("top:8.333333333333332%");
    expect(pendingMarkup).not.toContain("data-studio-resize-handle");
  });

  it("keeps an exact position refiner beside one direct-manipulation draft", () => {
    const entity: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      content: { displayLines: ["E = mc²"], texParts: ["E = mc^2"] },
      id: "equation_1",
      sourceIdentity: { kind: "known", value: "equation" },
      type: "MathTex",
    };
    const validation = createDirectManipulationPositionProgram({
      capturedPlayhead: 0,
      delta: { x: 56.25, y: 22.5 },
      positions: { equation_1: { x: 320, y: 180 } },
      scene: STUDIO_FIXTURE_SCENE,
      start: 0,
      targetEntityIds: [entity.id],
      transactionId: "studio-gesture-position-refinement",
    });
    const markup = renderSelectedInspector(entity, null, programRecord(validation.program, validation));

    expect(markup).toContain('aria-label="Refine draft position of equation_1"');
    expect(markup).toContain('aria-label="X draft position of equation_1"');
    expect(markup).toContain('value="376.25"');
    expect(markup).toContain('aria-label="Y draft position of equation_1"');
    expect(markup).toContain('value="202.5"');
    expect(markup).toContain("Update draft position");
  });

  it("never guesses a runtime entity from geometry or a duplicated current source name", () => {
    const state = {
      frame: {
        packetId: "canvas:2",
        revision: "a".repeat(64),
        sampleTime: 1,
        viewport: { heightPx: 90, widthPx: 160 },
      },
      phase: "presented" as const,
    };
    const runtimeGeometry = new Map([
      ["scene:runtime/entity:0", { dimensions: { height: 1, width: 1 }, position: { x: 100, y: 100 } }],
    ]);
    const verifiedIdentity = new Map([
      [
        "circle_1",
        {
          bindingId: `source-binding:${"b".repeat(64)}`,
          entityId: "scene:runtime/entity:0",
          sourceName: "circle_1",
        },
      ],
    ]);
    const missingMap = renderToStaticMarkup(
      <StudioCanvas {...baseProps()} preview={previewView(state, runtimeGeometry)} />,
    );
    expect(missingMap).toContain("left:50%");
    expect(missingMap).not.toContain("data-studio-runtime-entity");

    const duplicate = { ...CIRCLE_ENTITY, id: "entity:circle_2" };
    const duplicateSource = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        entities={[CIRCLE_ENTITY, duplicate]}
        preview={previewView(state, runtimeGeometry, verifiedIdentity)}
      />,
    );
    expect(duplicateSource).not.toContain("left:15.625%");
    expect(duplicateSource).not.toContain("data-studio-runtime-entity");
  });
});
