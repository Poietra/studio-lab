import type {
  CreateExplanationSuggestion,
  CreateSceneTransitionSuggestion,
  CreateTransformSuggestion,
  EditProgramSuggestion,
  SuggestionTimeAnchor,
} from "../ai/edit-suggestions";

export type EditMode = "position" | "animate";
export type PlanId = "whole-followers" | "play-followers" | "new-move" | "play-target";
export type ObjectId = "equation_1" | "label_1" | "arrow_1" | "proof_box";
export type Point = { x: number; y: number };
export type Interval = { start: number; end: number };
export type EasingName = "smooth";

export type MotionRecord = {
  control: Point;
  easing: EasingName;
  end: Point;
  id: string;
  interval: Interval;
  label: string;
  objectIds: readonly ObjectId[];
  start: Point;
};

export type AppliedEdit = {
  affected: readonly ObjectId[];
  delta: Point;
  endByObject: Partial<Record<ObjectId, number>>;
  groupId?: string;
  motion: Interval;
  objectIds: readonly ObjectId[];
  pathBend: Point;
  planId: PlanId;
  stepIndex?: number;
  start: number;
};

export type TransformEdit = {
  anchor: SuggestionTimeAnchor;
  easing: EasingName;
  groupId?: string;
  identityAfter: "target-replaces-source";
  interval: Interval;
  mismatchMode: "transform";
  sourceObjectId: ObjectId;
  strategy: "transform-matching-tex";
  stepIndex?: number;
  target: CreateTransformSuggestion["target"];
  targetRuntimeId: string;
};

export type ExplanationEdit = {
  anchor: SuggestionTimeAnchor;
  animation: "fade-in";
  groupId?: string;
  interval: Interval;
  objectKind: "text";
  placement: CreateExplanationSuggestion["placement"];
  runtimeId: string;
  stepIndex?: number;
  targetObjectId: ObjectId;
  text: string;
};

export type SceneTransitionEdit = {
  anchor: SuggestionTimeAnchor;
  color: CreateSceneTransitionSuggestion["color"];
  destination: "next-scene";
  easing: EasingName;
  groupId?: string;
  interval: Interval;
  runtimeId: string;
  shape: CreateSceneTransitionSuggestion["shape"];
  style: "cover-reveal";
};

export type DraftEditProgram = {
  anchor: SuggestionTimeAnchor;
  execution: EditProgramSuggestion["execution"];
  groupId: string;
  operationKinds: readonly EditProgramSuggestion["operations"][number]["kind"][];
};

export type EditPlan = {
  id: PlanId;
  rank: string;
  title: string;
  description: string;
  temporalScope: "whole" | "from-now" | "motion";
  followers: boolean;
  affected: readonly ObjectId[];
};

export type ObjectGroup = {
  id: string;
  name: string;
  objectIds: readonly ObjectId[];
};

export type SceneObjectInfo = {
  id: ObjectId;
  type: string;
  displayName: string;
  mathTex: {
    displayLines: readonly string[];
    texParts: readonly string[];
  } | null;
  variableName: string;
  source: string;
};

export const FRAME = { width: 640, height: 360 } as const;
export const EQUATION = { x: 320, y: 146 } as const;
export const LABEL = { x: 320, y: 236 } as const;
export const PROOF_BOX = { x: 320, y: 147 } as const;
export const SCENE_DURATION = 12;
const ANIMATION_SHIFT = 64;
export const ORIGINAL_EQUATION_LINES = ["E = mc²"] as const;
export const ORIGINAL_EQUATION_TEX_PARTS = ["E", "=", "m", "c^2"] as const;
export const PLAY_SEGMENTS = [
  { name: "Introduce", start: 0, end: 2 },
  { name: "Explain", start: 2, end: 4 },
  { name: "Move equation", start: 4, end: 7 },
  { name: "Outro", start: 7, end: 12 },
] as const;

export const SOURCE_MOTIONS: readonly MotionRecord[] = [
  {
    id: "move-equation",
    label: "Move equation",
    objectIds: ["equation_1"],
    interval: { start: 4, end: 7 },
    start: EQUATION,
    control: { x: EQUATION.x + ANIMATION_SHIFT / 2, y: EQUATION.y - 20 },
    end: { x: EQUATION.x + ANIMATION_SHIFT, y: EQUATION.y },
    easing: "smooth",
  },
];

export const SCENE_OBJECTS: readonly SceneObjectInfo[] = [
  {
    id: "equation_1",
    type: "MathTex",
    displayName: "equation",
    mathTex: { displayLines: ORIGINAL_EQUATION_LINES, texParts: ORIGINAL_EQUATION_TEX_PARTS },
    variableName: "equation",
    source: 'equation = MathTex("E", "=", "m", "c^2")',
  },
  {
    id: "label_1",
    type: "Text",
    displayName: "label",
    mathTex: null,
    variableName: "label",
    source: 'label = Text("energy").next_to(equation, DOWN)',
  },
  {
    id: "arrow_1",
    type: "Arrow",
    displayName: "arrow",
    mathTex: null,
    variableName: "arrow",
    source: "arrow = Arrow(label.get_top(), equation.get_bottom())",
  },
  {
    id: "proof_box",
    type: "Rectangle",
    displayName: "proof box",
    mathTex: null,
    variableName: "proof_box",
    source: "proof_box = SurroundingRectangle(equation)",
  },
] as const;

const DEPENDENTS: Readonly<Record<ObjectId, readonly ObjectId[]>> = {
  equation_1: ["label_1", "arrow_1"],
  label_1: ["arrow_1"],
  arrow_1: [],
  proof_box: [],
};

export const OBJECT_HALF_SIZE: Readonly<Record<ObjectId, Point>> = {
  equation_1: { x: 62, y: 24 },
  label_1: { x: 34, y: 14 },
  arrow_1: { x: 18, y: 36 },
  proof_box: { x: 115, y: 31 },
};

export const OBJECT_LIFETIMES: Readonly<Record<ObjectId, readonly Interval[]>> = {
  equation_1: [{ start: 0, end: SCENE_DURATION }],
  label_1: [{ start: 0, end: 9.5 }],
  arrow_1: [{ start: 0, end: 9.5 }],
  proof_box: [{ start: 0, end: 10.5 }],
};

export function lifetimeAt(objectId: ObjectId, time: number): Interval | undefined {
  return OBJECT_LIFETIMES[objectId].find((interval) => time >= interval.start && time < interval.end);
}

export function isObjectPresentAt(objectId: ObjectId, time: number) {
  return lifetimeAt(objectId, time) !== undefined;
}

export function lifetimeEndFor(objectId: ObjectId, time: number) {
  return lifetimeAt(objectId, time)?.end ?? time;
}

export function isObjectId(value: string): value is ObjectId {
  return SCENE_OBJECTS.some((object) => object.id === value);
}

export function sameObjects(left: readonly ObjectId[], right: readonly ObjectId[]) {
  return left.length === right.length && left.every((objectId) => right.includes(objectId));
}

export function plansFor(
  objectIds: readonly ObjectId[],
  currentTime: number,
  editMode: EditMode,
  moveDuration: number,
  name?: string,
): readonly EditPlan[] {
  const presentObjectIds = objectIds.filter((objectId) => isObjectPresentAt(objectId, currentTime));
  const selected = new Set(presentObjectIds);
  const dependentSet = new Set<ObjectId>();
  for (const objectId of presentObjectIds) {
    for (const dependent of DEPENDENTS[objectId]) {
      if (!selected.has(dependent) && isObjectPresentAt(dependent, currentTime)) dependentSet.add(dependent);
    }
  }
  const connected = SCENE_OBJECTS
    .map((object) => object.id)
    .filter((objectId) => selected.has(objectId) || dependentSet.has(objectId));
  const selectionLabel = name ?? (objectIds.length === 1
    ? SCENE_OBJECTS.find((object) => object.id === objectIds[0])!.displayName
    : `${objectIds.length} selected objects`);
  const connectedDescription = dependentSet.size > 0
    ? `Move ${selectionLabel} for the whole video. ${dependentSet.size} connected ${dependentSet.size === 1 ? "object moves" : "objects move"} with it.`
    : `Move ${selectionLabel} by the same amount for the whole video.`;
  if (editMode === "position") return [
    {
      id: "play-followers",
      rank: "Recommended",
      title: "From this frame",
      description: `Leave earlier frames unchanged. From ${currentTime.toFixed(2)}s, keep ${selectionLabel} at the dragged offset until each object leaves the scene.`,
      temporalScope: "from-now",
      followers: dependentSet.size > 0,
      affected: connected,
    },
    {
      id: "whole-followers",
      rank: "Alternative",
      title: "Whole video",
      description: connectedDescription,
      temporalScope: "whole",
      followers: dependentSet.size > 0,
      affected: connected,
    },
  ];

  const availableDuration = connected.length > 0
    ? Math.min(...connected.map((objectId) => lifetimeEndFor(objectId, currentTime) - currentTime))
    : 0;
  const newMoveDuration = Math.max(0, Math.min(moveDuration, availableDuration));
  const result: EditPlan[] = [
    {
      id: "new-move",
      rank: "New",
      title: "Create movement",
      description: `Animate ${selectionLabel} from its position at ${currentTime.toFixed(2)}s to the dragged destination over ${newMoveDuration.toFixed(2)}s.`,
      temporalScope: "motion",
      followers: dependentSet.size > 0,
      affected: connected,
    },
  ];

  const sourceMotion = SOURCE_MOTIONS.find((motion) => (
    sameObjects(motion.objectIds, presentObjectIds)
    && currentTime >= motion.interval.start
    && currentTime < motion.interval.end
  ));
  if (sourceMotion) {
    result.push({
      id: "play-target",
      rank: "Existing",
      title: `Edit “${sourceMotion.label}”`,
      description: `Change the stored path that already runs from ${sourceMotion.interval.start.toFixed(2)}s to ${sourceMotion.interval.end.toFixed(2)}s.`,
      temporalScope: "motion",
      followers: false,
      affected: sourceMotion.objectIds,
    });
  }

  return result;
}
