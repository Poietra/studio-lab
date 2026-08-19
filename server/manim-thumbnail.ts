import type {
  EntityContent,
  ProjectedEntity,
  PropertyChannel,
  PropertyValue,
  RuntimeEntity,
  RuntimeSceneState,
} from "../src/studio/model";
import { isPointValue, samplePropertyValue } from "../src/studio/property-sampling";

const THUMBNAIL_HEIGHT = 360;
const THUMBNAIL_WIDTH = 640;
const MAX_THUMBNAIL_ENTITIES = 32;
const MAX_THUMBNAIL_TEXT_ENTITIES = 16;
const MAX_THUMBNAIL_TEXT_LENGTH = 120;
const MIN_VISIBLE_OPACITY = 0.01;
const RENDERED_ENTITY_TYPES = new Set([
  "Arrow",
  "Circle",
  "Dot",
  "Line",
  "MathTex",
  "Rectangle",
  "RegularPolygon",
  "Square",
  "SurroundingRectangle",
  "Text",
]);

export const EMPTY_MANIM_THUMBNAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360"><rect width="640" height="360" fill="#09090b"/><rect x="216" y="130" width="208" height="100" rx="8" fill="none" stroke="#3f3f46" stroke-width="2"/><text x="320" y="185" fill="#71717a" font-family="ui-sans-serif,system-ui,sans-serif" font-size="18" text-anchor="middle">No scene preview</text></svg>`;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function formatNumber(value: number) {
  return Number(finiteOr(value, 0).toFixed(3)).toString();
}

function escapeXml(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, "�")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isContent(value: PropertyValue | undefined): value is EntityContent {
  return typeof value === "object" && value !== null && "displayLines" in value;
}

function channelAt(scene: RuntimeSceneState, entityId: string, key: PropertyChannel["key"], time: number) {
  return samplePropertyValue(scene.propertyChannels[`${entityId}/${key}`]?.samples ?? [], time);
}

function entityAt(scene: RuntimeSceneState, entity: RuntimeEntity, time: number): ProjectedEntity {
  const position = channelAt(scene, entity.id, "position", time);
  const appearance = channelAt(scene, entity.id, "appearance", time);
  const content = channelAt(scene, entity.id, "content", time);
  const presence = channelAt(scene, entity.id, "presence", time);
  const scale = channelAt(scene, entity.id, "scale", time);
  return {
    content: isContent(content) ? content : entity.content,
    geometry: entity.geometry ?? {
      dimensions: { kind: "known", value: {} },
      position: isPointValue(position)
        ? { kind: "known", value: position }
        : { kind: "unknown", reason: "No projected position is available." },
      scale:
        typeof scale === "number"
          ? { kind: "known", value: scale }
          : { kind: "unknown", reason: "No projected scale is available." },
      style: { kind: "known", value: {} },
    },
    id: entity.id,
    opacity: typeof appearance === "number" ? appearance : 1,
    position: isPointValue(position) ? position : { x: THUMBNAIL_WIDTH / 2, y: THUMBNAIL_HEIGHT / 2 },
    present: entity.lifetime.some((interval) => time >= interval.start && time < interval.end) && presence !== false,
    provisional: entity.provisional,
    scale: typeof scale === "number" ? scale : 1,
    sourceIdentity: entity.sourceIdentity,
    transactionId: entity.transactionId,
    type: entity.type,
  };
}

function isVisible(entity: ProjectedEntity) {
  return (
    entity.present &&
    Number.isFinite(entity.opacity) &&
    entity.opacity > MIN_VISIBLE_OPACITY &&
    Number.isFinite(entity.scale) &&
    entity.scale > 0 &&
    RENDERED_ENTITY_TYPES.has(entity.type)
  );
}

function candidateTimes(scene: RuntimeSceneState) {
  const duration = Math.max(0, finiteOr(scene.duration, 0));
  const boundaries = new Set<number>([0, duration]);
  for (const entity of Object.values(scene.objectGraph.entities)) {
    for (const interval of entity.lifetime) {
      if (Number.isFinite(interval.start)) boundaries.add(clamp(interval.start, 0, duration));
      if (Number.isFinite(interval.end)) boundaries.add(clamp(interval.end, 0, duration));
    }
  }
  for (const channel of Object.values(scene.propertyChannels)) {
    if (channel.key !== "appearance" && channel.key !== "presence") continue;
    for (const sample of channel.samples) {
      if (Number.isFinite(sample.interval.start)) boundaries.add(clamp(sample.interval.start, 0, duration));
      if (Number.isFinite(sample.interval.end)) boundaries.add(clamp(sample.interval.end, 0, duration));
    }
  }
  const orderedBoundaries = [...boundaries].sort((left, right) => left - right);
  const candidates = new Set<number>(orderedBoundaries.filter((time) => time < duration || duration === 0));
  for (let index = 0; index < orderedBoundaries.length - 1; index += 1) {
    const start = orderedBoundaries[index]!;
    const end = orderedBoundaries[index + 1]!;
    if (end > start) candidates.add(start + (end - start) / 2);
  }
  return [...candidates].sort((left, right) => left - right);
}

export function representativeManimSceneTime(scene: RuntimeSceneState) {
  let representativeTime = 0;
  let maximumVisibleEntities = -1;
  for (const time of candidateTimes(scene)) {
    const visibleEntities = Object.values(scene.objectGraph.entities)
      .map((entity) => entityAt(scene, entity, time))
      .filter(isVisible).length;
    if (visibleEntities > maximumVisibleEntities) {
      maximumVisibleEntities = visibleEntities;
      representativeTime = time;
    }
  }
  return representativeTime;
}

function entityText(entity: ProjectedEntity) {
  const content = entity.content;
  const value =
    entity.type === "MathTex"
      ? content?.displayLines.join(" ") || content?.texParts?.join(" ") || content?.label || "MathTex"
      : content?.text || content?.displayLines.join(" ") || content?.label || "Text";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_THUMBNAIL_TEXT_LENGTH);
}

function renderShape(entity: ProjectedEntity, canRenderText: boolean) {
  const stroke = "#d4d4d8";
  switch (entity.type) {
    case "Arrow":
      return `<path d="M -48 0 H 40 M 30 -9 L 42 0 L 30 9" fill="none" stroke="${stroke}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "Line":
      return `<line x1="-48" y1="0" x2="48" y2="0" stroke="${stroke}" stroke-width="3" stroke-linecap="round"/>`;
    case "Circle":
      return `<circle r="32" fill="none" stroke="${stroke}" stroke-width="3"/>`;
    case "Dot":
      return `<circle r="8" fill="#e4e4e7"/>`;
    case "Rectangle":
    case "SurroundingRectangle":
      return `<rect x="-64" y="-28" width="128" height="56" fill="none" stroke="${stroke}" stroke-width="3"/>`;
    case "Square":
      return `<rect x="-32" y="-32" width="64" height="64" fill="none" stroke="${stroke}" stroke-width="3"/>`;
    case "RegularPolygon":
      return `<polygon points="0,-36 31,-18 31,18 0,36 -31,18 -31,-18" fill="none" stroke="${stroke}" stroke-width="3"/>`;
    case "MathTex":
    case "Text":
      return canRenderText
        ? `<text x="0" y="0" fill="#f4f4f5" font-family="ui-sans-serif,system-ui,sans-serif" font-size="20" text-anchor="middle" dominant-baseline="middle">${escapeXml(entityText(entity))}</text>`
        : `<rect x="-40" y="-10" width="80" height="20" rx="4" fill="#27272a"/>`;
    default:
      return "";
  }
}

export function renderManimSceneThumbnailSvg(scene: RuntimeSceneState) {
  const time = representativeManimSceneTime(scene);
  const entities = Object.values(scene.objectGraph.entities)
    .map((entity, index) => ({ entity: entityAt(scene, entity, time), index }))
    .filter(({ entity }) => isVisible(entity))
    .sort((left, right) => {
      const leftOrdering = channelAt(scene, left.entity.id, "sourceZIndex", time);
      const rightOrdering = channelAt(scene, right.entity.id, "sourceZIndex", time);
      return (
        (typeof leftOrdering === "number" ? leftOrdering : left.index) -
          (typeof rightOrdering === "number" ? rightOrdering : right.index) ||
        left.entity.id.localeCompare(right.entity.id)
      );
    })
    .slice(0, MAX_THUMBNAIL_ENTITIES);
  let renderedTextEntities = 0;
  const body = entities
    .map(({ entity }) => {
      const isText = entity.type === "MathTex" || entity.type === "Text";
      const canRenderText = !isText || renderedTextEntities < MAX_THUMBNAIL_TEXT_ENTITIES;
      if (isText && canRenderText) renderedTextEntities += 1;
      const x = clamp(finiteOr(entity.position.x, THUMBNAIL_WIDTH / 2), 0, THUMBNAIL_WIDTH);
      const y = clamp(finiteOr(entity.position.y, THUMBNAIL_HEIGHT / 2), 0, THUMBNAIL_HEIGHT);
      const opacity = clamp(finiteOr(entity.opacity, 1), 0, 1);
      const scale = clamp(finiteOr(entity.scale, 1), 0.1, 4);
      return `<g transform="translate(${formatNumber(x)} ${formatNumber(y)}) scale(${formatNumber(scale)})" opacity="${formatNumber(opacity)}">${renderShape(entity, canRenderText)}</g>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360"><rect width="640" height="360" fill="#09090b"/>${body}</svg>`;
}
