import type { Interval, Point, RuntimeSceneState } from "./model";
import { isPointValue } from "./property-sampling";

export type StudioMotionPath = Readonly<{
  control: Point;
  end: Point;
  entityId: string;
  interval: Interval;
  motionId: string;
  start: Point;
}>;

export function projectMotionPaths(
  scene: RuntimeSceneState,
  selectedEntityIds: ReadonlySet<string>,
  time: number,
): readonly StudioMotionPath[] {
  return Object.values(scene.propertyChannels).flatMap((channel) => {
    if (channel.key !== "position" || !selectedEntityIds.has(channel.entityId)) return [];
    return channel.samples.flatMap((sample, index) => {
      if (
        sample.kind !== "animated"
        || !isPointValue(sample.from)
        || !isPointValue(sample.value)
        || time < sample.interval.start
        || time >= sample.interval.end
      ) return [];
      return [{
        control: sample.control ?? {
          x: (sample.from.x + sample.value.x) / 2,
          y: (sample.from.y + sample.value.y) / 2,
        },
        end: sample.value,
        entityId: channel.entityId,
        interval: sample.interval,
        motionId: sample.operationId ?? sample.provenanceId ?? `${channel.entityId}/motion/${index}`,
        start: sample.from,
      }];
    });
  });
}

export function quadraticPathData(path: Pick<StudioMotionPath, "control" | "end" | "start">) {
  return `M ${path.start.x} ${path.start.y} Q ${path.control.x} ${path.control.y} ${path.end.x} ${path.end.y}`;
}
