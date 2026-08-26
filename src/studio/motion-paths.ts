import type { StudioCubicBezierPath } from "../engine/cubic-bezier-authoring";
import type { Interval, Point, RuntimeSceneState } from "./model";
import { isPointValue } from "./property-sampling";

type StudioMotionPathBase = Readonly<{
  control: Point;
  end: Point;
  entityId: string;
  interval: Interval;
  motionId: string;
  start: Point;
}>;

export type StudioMotionPath =
  | (StudioMotionPathBase & Readonly<{ kind: "quadratic" }>)
  | (Omit<StudioMotionPathBase, "control"> &
      Readonly<{
        kind: "cubic";
        path: StudioCubicBezierPath;
        pathEntityId: string;
      }>);

export function projectMotionPaths(
  scene: RuntimeSceneState,
  selectedEntityIds: ReadonlySet<string>,
  time: number,
): readonly StudioMotionPath[] {
  return Object.values(scene.propertyChannels).flatMap((channel) => {
    if (channel.key !== "position" || !selectedEntityIds.has(channel.entityId)) return [];
    return channel.samples.flatMap<StudioMotionPath>((sample, index) => {
      if (
        sample.kind !== "animated" ||
        !isPointValue(sample.from) ||
        !isPointValue(sample.value) ||
        time < sample.interval.start ||
        time >= sample.interval.end
      )
        return [];
      if (sample.pathMotion) {
        return [
          {
            end: sample.value,
            entityId: channel.entityId,
            interval: sample.interval,
            kind: "cubic" as const,
            motionId: sample.operationId ?? sample.provenanceId ?? `${channel.entityId}/motion/${index}`,
            path: sample.pathMotion.path,
            pathEntityId: sample.pathMotion.pathEntityId,
            start: sample.from,
          },
        ];
      }
      return [
        {
          control: sample.control ?? {
            x: (sample.from.x + sample.value.x) / 2,
            y: (sample.from.y + sample.value.y) / 2,
          },
          end: sample.value,
          entityId: channel.entityId,
          interval: sample.interval,
          kind: "quadratic" as const,
          motionId: sample.operationId ?? sample.provenanceId ?? `${channel.entityId}/motion/${index}`,
          start: sample.from,
        },
      ];
    });
  });
}

export function quadraticPathData(
  path: Pick<Extract<StudioMotionPath, { kind: "quadratic" }>, "control" | "end" | "start">,
) {
  return `M ${path.start.x} ${path.start.y} Q ${path.control.x} ${path.control.y} ${path.end.x} ${path.end.y}`;
}
