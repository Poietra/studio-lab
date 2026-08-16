import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { programRecord } from "./evaluator";
import { STUDIO_FIXTURE_SCENE } from "./fixture";
import type { ProjectedEntity } from "./model";
import type { StudioPreviewRuntimeTraceEditCandidate } from "./preview-temporal-rebase";
import {
  compensatePreparedGeometryForOverlayScales,
  StudioCanvas,
  type StudioCanvasProps,
  verifiedPreviewGeometryForStudioEntity,
} from "./studio-canvas";
import { StudioInspector } from "./studio-sidebars";
import { createDirectManipulationPositionProgram } from "./suggestion-program";
import type { StudioPreviewRendererView } from "./use-preview-renderer";

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
  rotationAvailable = false,
  opacityAvailable = false,
  opacityValue: number | null = null,
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
      onEntityOpacityChange={vi.fn()}
      onEntityRotate={vi.fn()}
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
      opacityAvailable={opacityAvailable}
      opacityValue={opacityValue}
      rotationAvailable={rotationAvailable}
      selectedEntity={entity}
      sourceExport={null}
      suggestion={null}
      workspace={null}
    />,
  );
}

function previewView(
  state: StudioPreviewRendererView["state"],
  interactionGeometry: StudioPreviewRendererView["interactionGeometry"] = null,
  sourceRuntimeIdentity: StudioPreviewRendererView["sourceRuntimeIdentity"] = null,
  interactionAuthority: StudioPreviewRendererView["interactionAuthority"] = { kind: "interactive" },
  runtimeTraceOpaqueSelectionEntities: StudioPreviewRendererView["runtimeTraceOpaqueSelectionEntities"] = [],
  runtimeTraceEditCandidates: StudioPreviewRendererView["runtimeTraceEditCandidates"] = [],
  runtimeTraceEditAnchor: StudioPreviewRendererView["runtimeTraceEditAnchor"] = null,
): StudioPreviewRendererView {
  return {
    attachCanvas: vi.fn(),
    boundEntityProjection: null,
    cameraCenter: null,
    creationProjection: null,
    epoch: 0,
    interactionGeometry,
    interactionAuthority,
    mathTexTransformProjection: null,
    motionProjection: null,
    persistentRemoveProjection: null,
    staticRootProjection: null,
    programAuthority: null,
    runtimeTraceEditAnchor,
    runtimeTraceEditCandidates,
    runtimeTraceOpaqueSelectionEntities,
    runtimeTraceProgramValidation: "not-applicable",
    sourceLabel: "verified fixture",
    sourceMetadataFailureKind: null,
    sourceMetadataPhase: "ready",
    sourceRuntimeIdentity,
    state,
    timelineProjection: null,
    verifiedSourceDuration: 2,
  };
}

describe("StudioCanvas retained preview layer", () => {
  it("cancels overlay CSS scales so sampled runtime bounds are applied exactly once", () => {
    expect(
      compensatePreparedGeometryForOverlayScales(
        { dimensions: { height: 2, width: 4 }, position: { x: 480, y: 90 } },
        2,
        0.5,
      ),
    ).toEqual({ dimensions: { height: 2, width: 4 }, position: { x: 400, y: 135 } });
  });

  it("uses the canonical Rust target ID for transformed entities before inherited source identity", () => {
    const transactionId = "math-transform";
    const entity: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      id: `tx:${transactionId}/entity:formula-b`,
      sourceIdentity: { kind: "known", value: "formula" },
      transactionId,
      type: "MathTex",
    };
    const geometry = { dimensions: { height: 1, width: 2 }, position: { x: 320, y: 180 } };
    const preview = previewView(
      {
        frame: {
          packetId: "formula-b",
          revision: "a".repeat(64),
          sampleTime: 1,
          viewport: { heightPx: 360, widthPx: 640 },
        },
        phase: "presented",
      },
      new Map([[entity.id, geometry]]),
      new Map([
        ["formula", { bindingId: "source-binding:formula", entityId: "source:formula", sourceName: "formula" }],
      ]),
    );

    expect(verifiedPreviewGeometryForStudioEntity(preview, new Map([["formula", null]]), entity)).toEqual({
      bindingId: null,
      geometry,
      runtimeEntityId: entity.id,
    });
  });

  it("renders no paint or interaction layer before the canonical provider is active", () => {
    const markup = renderToStaticMarkup(<StudioCanvas {...baseProps()} />);
    expect(markup).toContain('data-preview-renderer="off"');
    expect(markup).not.toContain("data-preview-revision");
    expect(markup).not.toContain("data-studio-preview-canvas");
    expect(markup).not.toContain("data-studio-preview-status");
  });

  it("exposes the whole-Scene failure without invoking a DOM renderer", () => {
    const markup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView({ detail: "wasm-load-failed: no module", phase: "fallback", reason: "install-failed" })}
      />,
    );
    expect(markup).toContain('data-preview-renderer="fallback"');
    expect(markup).toContain('data-preview-fallback-reason="install-failed"');
    expect(markup).not.toContain("data-preview-revision");
    expect(markup).toContain("WebGPU preview unavailable · snapshot install failed");
    expect(markup).toMatch(/<canvas[^>]*invisible/);
    expect(markup).toContain("data-studio-transform-layer");
    expect(markup).not.toContain("data-studio-semantic-paint");
    expect(markup).not.toContain('data-studio-entity="entity:circle_1"');
  });

  it("labels a presented frame as an editing preview without claiming render authority", () => {
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
            ["scene:runtime/entity:0", { dimensions: { height: 0.8, width: 1.4222 }, position: { x: 320, y: 180 } }],
          ]),
          new Map([
            [
              "circle_1",
              { bindingId: "source-binding:circle", entityId: "scene:runtime/entity:0", sourceName: "circle_1" },
            ],
          ]),
        )}
      />,
    );
    expect(markup).toContain('data-preview-renderer="presented"');
    // The exact presented packet is exposed so E2E can bind pixel evidence to
    // this frame and no other.
    expect(markup).toContain('data-preview-packet-id="canvas:2"');
    expect(markup).toContain(`data-preview-revision="${"a".repeat(64)}"`);
    expect(markup).not.toContain("data-preview-fallback-reason");
    expect(markup).toContain("WebGPU preview · verified fixture · editing preview only");
    expect(markup).not.toMatch(/<canvas[^>]*invisible/);
    expect(markup).toContain("data-studio-transform-layer");
    // A fully correlated presented frame replaces only the duplicate object
    // paint; the semantic hit target (the move button) stays in the
    // accessibility tree as a paint-free interaction overlay.
    expect(markup).not.toContain("data-studio-semantic-paint");
    expect(markup).toContain('data-studio-entity="entity:circle_1"');
    expect(markup).toContain("Move circle_1");
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
          reason: "source-runtime-identity-unverified",
        })}
        selectedIds={new Set([CIRCLE_ENTITY.id])}
      />,
    );
    expect(markup).toContain('data-preview-interaction="display-only"');
    expect(markup).toContain("WebGPU preview · verified fixture · display only");
    expect(markup).not.toContain('data-studio-entity="entity:circle_1"');
    expect(markup).not.toContain("Move circle_1");
    expect(markup).not.toContain("data-studio-resize-handle");

    const fallbackMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...baseProps()}
        preview={previewView({ detail: "device lost", phase: "fallback", reason: "renderer-failed" }, null, new Map(), {
          kind: "display-only",
          reason: "source-runtime-identity-unverified",
        })}
      />,
    );
    expect(fallbackMarkup).toContain('data-preview-interaction="display-only"');
    expect(fallbackMarkup).not.toContain('data-studio-entity="entity:circle_1"');

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
    expect(unverifiedMarkup).toContain("WebGPU preview · verified fixture · display only");
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
    // same render; stale prepared geometry does not mint a fallback target.
    expect(fallbackMarkup).not.toContain('data-studio-entity="entity:circle_1"');
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
    expect(markup).not.toContain("data-studio-semantic-paint");
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
            packetId: "canvas:line-joints-selection",
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
    expect(markup).toContain("WebGPU preview · verified fixture · selection only");
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
  });

  it("opens only the exact generic V3 root at the current editable endpoint", () => {
    const squareId = "source:scenes/staticsquare.py#StaticSquare:square";
    const otherId = "source:scenes/staticsquare.py#StaticSquare:other";
    const runtimeId = "scene:static/runtime-v3-root:0";
    const square: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      id: squareId,
      sourceIdentity: { kind: "known", value: "square" },
      type: "Square",
    };
    const other: ProjectedEntity = {
      ...CIRCLE_ENTITY,
      id: otherId,
      position: { x: 440, y: 180 },
      sourceIdentity: { kind: "known", value: "other" },
    };
    const candidate: StudioPreviewRuntimeTraceEditCandidate = {
      baseCenter: { x: 320, y: 180 },
      baseDimensions: { height: 2, width: 2 },
      baseOpacity: 1,
      bindingId: `source-binding:${"a".repeat(64)}`,
      capabilities: {
        paintOpacity: true,
        rotation: true,
        uniformScale: true,
      },
      duration: 0.1,
      entityProjection: {
        baseCenter: { x: 320, y: 180 },
        kind: "source-position-and-lifetime",
        lifetime: { end: 0.1, start: 0 },
      },
      phase: "construction",
      restrictionMessage:
        "Use the dedicated Rotate and Opacity controls for those edits; these Inspector fields support position and uniform scale only.",
      runtimeEntityId: runtimeId,
      sourceAnchor: 0,
      studioEntityId: squareId,
      studioSceneId: "scenes/staticsquare.py#StaticSquare",
      targetSourceName: "square",
      targetType: null,
    };
    const boundedAuthority = {
      editableRuntimeEntityIds: [runtimeId],
      kind: "bounded-interactive" as const,
      reason: "runtime-trace-edit" as const,
      sourceAnchor: 0 as const,
      verifiedRuntimeEntityIds: [runtimeId],
    };
    const props: StudioCanvasProps = {
      ...baseProps(),
      entities: [square, other],
      preview: previewView(
        {
          frame: {
            packetId: "canvas:generic-v3-construction",
            revision: "a".repeat(64),
            sampleTime: 0,
            viewport: { heightPx: 360, widthPx: 640 },
          },
          phase: "presented",
        },
        // Before the first prepared frame, the verified candidate endpoint is
        // the bootstrap geometry for its one bounded hit target.
        new Map(),
        new Map([["square", { bindingId: candidate.bindingId, entityId: runtimeId, sourceName: "square" }]]),
        boundedAuthority,
        [],
        [candidate],
        0,
      ),
      selectedIds: new Set([squareId]),
    };
    const tree = StudioCanvas(props);
    expect(findEntityButton(tree, squareId).props.onPointerMove).toBe(props.onEntityPointerMove);
    const markup = renderToStaticMarkup(<StudioCanvas {...props} />);
    expect(markup).toContain("Runtime Trace bounded editing");
    expect(markup).not.toContain(`data-studio-entity="${otherId}"`);
    expect(markup).toContain(`data-studio-runtime-entity="${runtimeId}"`);
    expect(markup).toContain('data-studio-entity-width="2.0000"');
    // The verified candidate root exposes exactly its uniform SE resize handle.
    expect(markup.match(/data-studio-resize-handle=/g)).toHaveLength(1);
    expect(markup).toContain(`data-studio-resize-handle="${squareId}"`);
    expect(markup.match(/data-resize-direction="se"/g)).toHaveLength(1);

    const movedMarkup = renderToStaticMarkup(
      <StudioCanvas
        {...props}
        preview={previewView(
          {
            frame: {
              packetId: "canvas:generic-v3-construction-moved",
              revision: "b".repeat(64),
              sampleTime: 0,
              viewport: { heightPx: 360, widthPx: 640 },
            },
            phase: "presented",
          },
          new Map([[runtimeId, { dimensions: { height: 2, width: 2 }, position: { x: 384, y: 144 } }]]),
          new Map([["square", { bindingId: candidate.bindingId, entityId: runtimeId, sourceName: "square" }]]),
          boundedAuthority,
          [],
          [candidate],
          0,
        )}
      />,
    );
    // A freshly prepared runtime projection is authoritative after the edit;
    // the candidate's pre-edit baseCenter is only a bootstrap fallback.
    expect(movedMarkup).toContain("left:60%;top:40%");
    expect(movedMarkup).toContain(`data-studio-runtime-entity="${runtimeId}"`);
    expect(movedMarkup).not.toContain("left:50%;top:50%");
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

  it("enables rotation controls only for an exact generic Runtime Trace target", () => {
    const disabled = renderSelectedInspector(CIRCLE_ENTITY, null);
    const enabled = renderSelectedInspector(CIRCLE_ENTITY, null, null, true);
    const clockwise = /<button aria-label="Rotate circle_1 clockwise by 15 degrees"[^>]*>/u;
    const counterclockwise = /<button aria-label="Rotate circle_1 counterclockwise by 15 degrees"[^>]*>/u;

    expect(disabled.match(clockwise)?.[0]).toContain('disabled=""');
    expect(disabled.match(counterclockwise)?.[0]).toContain('disabled=""');
    expect(enabled.match(clockwise)?.[0]).not.toContain('disabled=""');
    expect(enabled.match(counterclockwise)?.[0]).not.toContain('disabled=""');
  });

  it("enables opacity only for a static-paint generic Runtime Trace target", () => {
    const disabled = renderSelectedInspector(CIRCLE_ENTITY, null);
    const enabled = renderSelectedInspector(CIRCLE_ENTITY, null, null, false, true, 0.35);
    const mixed = renderSelectedInspector(CIRCLE_ENTITY, null, null, false, true, null);
    const control = /<input aria-label="Opacity circle_1"[^>]*>/u;

    expect(disabled.match(control)?.[0]).toContain('disabled=""');
    expect(enabled.match(control)?.[0]).not.toContain('disabled=""');
    expect(enabled.match(control)?.[0]).toContain('value="0.35"');
    expect(mixed.match(control)?.[0]).toContain('placeholder="Mixed"');
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
    expect(missingMap).not.toContain('data-studio-entity="entity:circle_1"');
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
