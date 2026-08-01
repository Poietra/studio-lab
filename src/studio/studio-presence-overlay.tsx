export type StudioPresenceParticipantV1 = Readonly<{
  cursor: Readonly<{ x: number; y: number }> | null;
  isSelf: boolean;
  memberId: string;
  selectedEntityIds: readonly string[];
}>;

function boundedUnit(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function orderedStudioPeersV1(participants: readonly StudioPresenceParticipantV1[]) {
  return participants
    .filter((participant) => !participant.isSelf)
    .toSorted((left, right) => (left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0));
}

export function studioPeerOrdinalV1(participants: readonly StudioPresenceParticipantV1[], memberId: string) {
  const index = orderedStudioPeersV1(participants).findIndex((participant) => participant.memberId === memberId);
  return index < 0 ? null : index + 1;
}

export function StudioPresenceOverlay({
  participants,
}: Readonly<{ participants: readonly StudioPresenceParticipantV1[] }>) {
  if (participants.length === 0) return null;
  const peers = orderedStudioPeersV1(participants);
  return (
    <>
      <div
        aria-label={`${participants.length} ${participants.length === 1 ? "editor" : "editors"} in this Scene`}
        className="pointer-events-none absolute left-2 top-2 z-40 border border-zinc-700 bg-zinc-950/90 px-2 py-1 text-[10px] tabular-nums text-zinc-300"
        data-studio-presence-count={participants.length}
        role="status"
      >
        {participants.length === 1 ? "Only you" : `${participants.length} editors`}
      </div>
      {peers.map((participant, index) =>
        participant.cursor ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-40 -translate-x-1 -translate-y-1 text-sky-300"
            data-studio-peer-cursor={index + 1}
            key={participant.memberId}
            style={{
              left: `${boundedUnit(participant.cursor.x) * 100}%`,
              top: `${boundedUnit(participant.cursor.y) * 100}%`,
            }}
          >
            <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 16 16">
              <path d="M2 1.5 13 8l-5 .8L5.5 13Z" fill="currentColor" stroke="#082f49" strokeWidth="1" />
            </svg>
            <span className="ml-2 block max-w-24 truncate border border-sky-900 bg-sky-950 px-1 py-0.5 text-[10px] text-sky-200">
              Editor {index + 1}
            </span>
          </div>
        ) : null,
      )}
    </>
  );
}
