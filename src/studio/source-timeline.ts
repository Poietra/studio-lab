import type { StudioTimelineProjectionV1 } from "../engine/scene-authoring";
import type { Interval, RuntimeSceneState } from "./model";
import { isSceneDurationOperation } from "./operations";
import { workingTimeToSourceTime as workingTimeToSourceTimeWithoutTimeline } from "./program-composition";
import type { SceneEdit } from "./scene-edit-contract";
import {
  isSceneDurationProgramBatch,
  workingTimeToSourceTime as workingTimeToSourceTimeFromProjection,
} from "./timeline-projection";

function sourceInterval(interval: Interval, workingTimeToSourceTime: (time: number) => number): Interval {
  const start = workingTimeToSourceTime(interval.start);
  return {
    end: Math.max(start, workingTimeToSourceTime(interval.end)),
    start,
  };
}

/**
 * Projects an evaluated, insertion-expanded Scene back onto original source
 * time. New Programs are authored in source coordinates, but their targets may
 * have been created by earlier Programs and therefore live at expanded working
 * timestamps. Validation must compare both sides in the same coordinate space.
 */
export function projectRuntimeSceneToSourceTimeline(
  scene: RuntimeSceneState,
  programs: readonly SceneEdit[],
  timelineProjection: StudioTimelineProjectionV1 | null = null,
): RuntimeSceneState {
  if (programs.length === 0) return scene;
  const containsSceneDurationOperation = programs.some((program) => program.operations.some(isSceneDurationOperation));
  if (containsSceneDurationOperation && !isSceneDurationProgramBatch(programs)) {
    throw new TypeError("A source timeline projection must not mix Scene duration and other Programs.");
  }
  if (containsSceneDurationOperation && !timelineProjection) {
    throw new TypeError("A Rust timeline projection is required to map a Scene duration edit back to source time.");
  }
  const toSourceTime = timelineProjection
    ? (time: number) => workingTimeToSourceTimeFromProjection(timelineProjection.transforms, time)
    : (time: number) => workingTimeToSourceTimeWithoutTimeline(programs, time);
  return {
    ...scene,
    duration: toSourceTime(scene.duration),
    eventTrack: {
      events: scene.eventTrack.events.map((event) => ({
        ...event,
        at: event.at === undefined ? undefined : toSourceTime(event.at),
        interval: event.interval ? sourceInterval(event.interval, toSourceTime) : undefined,
      })),
    },
    objectGraph: {
      entities: Object.fromEntries(
        Object.entries(scene.objectGraph.entities).map(([id, entity]) => [
          id,
          {
            ...entity,
            lifetime: entity.lifetime.map((interval) => sourceInterval(interval, toSourceTime)),
          },
        ]),
      ),
      lineage: scene.objectGraph.lineage.map((lineage) => ({
        ...lineage,
        at: toSourceTime(lineage.at),
      })),
    },
    propertyChannels: Object.fromEntries(
      Object.entries(scene.propertyChannels).map(([id, channel]) => [
        id,
        {
          ...channel,
          samples: channel.samples.map((sample) => ({
            ...sample,
            interval: sourceInterval(sample.interval, toSourceTime),
          })),
        },
      ]),
    ),
  };
}
