import type { Interval, RuntimeSceneState } from "./model";
import type { CanonicalEditProgram } from "./operations";
import { workingTimeToSourceTime } from "./program-composition";

function sourceInterval(
  programs: readonly CanonicalEditProgram[],
  interval: Interval,
): Interval {
  const start = workingTimeToSourceTime(programs, interval.start);
  return {
    end: Math.max(start, workingTimeToSourceTime(programs, interval.end)),
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
  programs: readonly CanonicalEditProgram[],
): RuntimeSceneState {
  if (programs.length === 0) return scene;
  return {
    ...scene,
    duration: workingTimeToSourceTime(programs, scene.duration),
    eventTrack: {
      events: scene.eventTrack.events.map((event) => ({
        ...event,
        at: event.at === undefined
          ? undefined
          : workingTimeToSourceTime(programs, event.at),
        interval: event.interval
          ? sourceInterval(programs, event.interval)
          : undefined,
      })),
    },
    objectGraph: {
      entities: Object.fromEntries(Object.entries(scene.objectGraph.entities).map(([id, entity]) => [id, {
        ...entity,
        lifetime: entity.lifetime.map((interval) => sourceInterval(programs, interval)),
      }])),
      lineage: scene.objectGraph.lineage.map((lineage) => ({
        ...lineage,
        at: workingTimeToSourceTime(programs, lineage.at),
      })),
    },
    propertyChannels: Object.fromEntries(Object.entries(scene.propertyChannels).map(([id, channel]) => [id, {
      ...channel,
      samples: channel.samples.map((sample) => ({
        ...sample,
        interval: sourceInterval(programs, sample.interval),
      })),
    }])),
  };
}
