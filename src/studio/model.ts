import type { EngineEasingV1 } from "../engine/easing";
import type { SceneEditValidationIssue } from "./operations";
import type { SceneEdit } from "./scene-edit-contract";

export const STUDIO_STATE_VERSION = 1 as const;

export type Point = Readonly<{ x: number; y: number }>;

export type Interval = Readonly<{ end: number; start: number }>;

export type MotionEasing = "linear" | "smooth";

export function isMotionEasing(value: string): value is MotionEasing {
  return value === "linear" || value === "smooth";
}

export type Known<T> = Readonly<{ kind: "known"; value: T }>;

export type Unknown = Readonly<{
  evidence?: readonly string[];
  kind: "unknown";
  reason: string;
}>;

export type Knowledge<T> = Known<T> | Unknown;

export type EntityDimensions = Readonly<{
  height?: number;
  radius?: number;
  width?: number;
}>;

export type EntityStyle = Readonly<{
  color?: string;
  fillColor?: string;
  strokeColor?: string;
}>;

export type TextLayout = Readonly<{
  alignment: "center" | "left" | "right";
  fontSize: number;
  fontWeight: "bold" | "regular";
  lineHeight: number;
}>;

export type EntityGeometryKnowledge = Readonly<{
  dimensions: Knowledge<EntityDimensions>;
  position: Knowledge<Point>;
  scale: Knowledge<number>;
  style: Knowledge<EntityStyle>;
}>;

export type SourceSnapshot = Readonly<{
  configId: string;
  hash: string;
  sourceId: string;
  version: typeof STUDIO_STATE_VERSION;
}>;

export type StaticSemanticEntity = Readonly<{
  sourceIdentity: string;
  runtimeIdentities: Knowledge<readonly string[]>;
  type: Knowledge<string>;
}>;

export type StaticSemanticState = Readonly<{
  entities: readonly StaticSemanticEntity[];
  unknowns: readonly Unknown[];
  version: typeof STUDIO_STATE_VERSION;
}>;

export type EntityContent = Readonly<{
  displayLines: readonly string[];
  label?: string;
  texParts?: readonly string[];
  text?: string;
  textLayout?: TextLayout;
}>;

export type RuntimeEntity = Readonly<{
  content?: EntityContent;
  geometry?: EntityGeometryKnowledge;
  id: string;
  lifetime: readonly Interval[];
  provisional: boolean;
  sourceIdentity: Knowledge<string>;
  transactionId?: string;
  type: string;
}>;

export type IdentityLineage = Readonly<{
  at: number;
  from: string;
  operationId: string;
  relation: "created" | "replaces" | "removed";
  to: string;
}>;

export type ObjectGraph = Readonly<{
  entities: Readonly<Record<string, RuntimeEntity>>;
  lineage: readonly IdentityLineage[];
}>;

export type PropertyValue = boolean | number | string | Point | EntityDimensions | EntityContent | readonly string[];

export type PropertyChannelSample = Readonly<{
  control?: Point;
  easing?: EngineEasingV1 | MotionEasing | "manim-smooth";
  from?: PropertyValue;
  interval: Interval;
  kind: "animated" | "exact";
  knowledge?: Knowledge<EntityDimensions | number | Point>;
  operationId?: string;
  provenanceId: string;
  relative?: boolean;
  sameAnchorOrder?: "before-studio-insertion";
  value: PropertyValue;
}>;

export type PropertyChannel = Readonly<{
  entityId: string;
  key:
    | "appearance"
    | "camera"
    | "content"
    | "dimensions"
    | "fillColor"
    | "sourceZIndex"
    | "position"
    | "presence"
    | "rotation"
    | "scale"
    | "strokeColor"
    | "visibility";
  samples: readonly PropertyChannelSample[];
}>;

export type PropertyChannels = Readonly<Record<string, PropertyChannel>>;

export type TimelineEvent = Readonly<{
  at?: number;
  id: string;
  interval?: Interval;
  kind: "operation" | "play" | "scene-boundary" | "wait";
  label: string;
  operationId?: string;
  transactionId?: string;
}>;

export type EventTrack = Readonly<{
  events: readonly TimelineEvent[];
}>;

export type TimelineObjectTrack = Readonly<{
  animatedChannels: readonly Readonly<{
    interval: Interval;
    key: PropertyChannel["key"];
    operationId?: string;
  }>[];
  entityId: string;
  label: string;
  lifetimes: readonly Interval[];
  provisional: boolean;
  transactionId?: string;
  type: string;
}>;

export type SceneConstraint = Readonly<{
  id: string;
  mode: "live" | "snapshot";
  operationId: string;
  relation: "next-to";
  sourceEntityId: string;
  targetEntityId: string;
}>;

export type ConstraintGraph = Readonly<{
  constraints: readonly SceneConstraint[];
}>;

export type ProvenanceRecord = Readonly<{
  evidence: readonly string[];
  id: string;
  operationId?: string;
  origin: "direct-manipulation" | "fixture" | "import" | "remote-model" | "studio-default";
  transactionId?: string;
}>;

export type ProvenanceGraph = Readonly<{
  records: readonly ProvenanceRecord[];
}>;

export type RuntimeSceneState = Readonly<{
  constraintGraph: ConstraintGraph;
  duration: number;
  eventTrack: EventTrack;
  objectGraph: ObjectGraph;
  propertyChannels: PropertyChannels;
  provenanceGraph: ProvenanceGraph;
  sceneId: string;
  version: typeof STUDIO_STATE_VERSION;
}>;

export type EditorContext = Readonly<{
  activeSceneId: string;
  capturedGesture?: Readonly<{ entityIds: readonly string[]; pointerDelta: Point }>;
  capturedLanguage?: Readonly<{ prompt: string }>;
  playhead: number;
  selection: readonly string[];
  version: typeof STUDIO_STATE_VERSION;
  viewport: Readonly<{ height: number; width: number }>;
}>;

export type ProgramRecord = Readonly<{
  program: SceneEdit;
  validation: Readonly<{
    issues: readonly SceneEditValidationIssue[];
    status: "invalid" | "valid";
  }>;
}>;

export type StudioEditProjectionAuthority = "rust-authorized-batch" | "source-bound-endpoint" | "static-imported-root";

export type WorkingState = Readonly<{
  appliedEdits: readonly ProgramRecord[];
  editorContext: EditorContext;
  runtimeSceneState: RuntimeSceneState;
  sourceSnapshot: SourceSnapshot;
  stagedEdits: readonly ProgramRecord[];
  staticSemanticState: StaticSemanticState;
  version: typeof STUDIO_STATE_VERSION;
}>;

export type ProposedState = Readonly<{
  base: WorkingState;
  evaluatedScene: RuntimeSceneState;
  issues: readonly SceneEditValidationIssue[];
  programs: readonly ProgramRecord[];
  version: typeof STUDIO_STATE_VERSION;
}>;

export type ProjectedEntity = Readonly<{
  content?: EntityContent;
  geometry: EntityGeometryKnowledge;
  id: string;
  opacity: number;
  position: Point;
  present: boolean;
  provisional: boolean;
  scale: number;
  sourceIdentity: Knowledge<string>;
  transactionId?: string;
  type: string;
}>;

export type ProposedStateProjection = Readonly<{
  camera: Readonly<{ sampleId: string; scale: number }>;
  canvas: Readonly<{ entities: readonly ProjectedEntity[]; sampleId: string }>;
  inspector: Readonly<{
    entities: readonly ProjectedEntity[];
    issues: readonly SceneEditValidationIssue[];
    sampleId: string;
  }>;
  objectList: Readonly<{ entities: readonly ProjectedEntity[]; sampleId: string }>;
  semanticThumbnail: Readonly<{ entities: readonly ProjectedEntity[]; sampleId: string }>;
  sourcePreview: Readonly<{
    lowering: readonly Readonly<{ status: "illustrative" | "supported" | "unsupported"; transactionId: string }>[];
    sampleId: string;
  }>;
  time: number;
  timeline: Readonly<{
    events: readonly TimelineEvent[];
    objectTracks: readonly TimelineObjectTrack[];
    sampleId: string;
  }>;
  workingPlayback: Readonly<{ entities: readonly ProjectedEntity[]; sampleId: string }>;
}>;
