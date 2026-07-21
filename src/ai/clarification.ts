import type { RuntimeEntity } from "../studio/model";
import type { ClarificationOption } from "./edit-suggestions";

export type PendingClarification = Readonly<{
  contextFingerprint: string;
  options: readonly ClarificationOption[];
  originalPrompt: string;
  question: string;
}>;

export function createClarificationContextFingerprint(input: Readonly<{
  entities: readonly RuntimeEntity[];
  playhead: number;
  selection: readonly string[];
}>) {
  return JSON.stringify({
    entities: input.entities
      .map((entity) => ({
        content: entity.content,
        id: entity.id,
        lifetime: entity.lifetime,
        type: entity.type,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    playhead: input.playhead.toFixed(3),
    selection: [...input.selection].sort(),
  });
}
