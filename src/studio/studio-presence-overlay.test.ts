import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  orderedStudioPeersV1,
  StudioPresenceOverlay,
  type StudioPresenceParticipantV1,
  studioPeerOrdinalV1,
} from "./studio-presence-overlay";

function participant(memberId: string, isSelf = false): StudioPresenceParticipantV1 {
  return { cursor: null, isSelf, memberId, selectedEntityIds: [] };
}

describe("Studio presence overlay", () => {
  it("orders only remote members without exposing connection order", () => {
    const participants = [participant("member-z"), participant("member-self", true), participant("member-a")];

    expect(orderedStudioPeersV1(participants).map(({ memberId }) => memberId)).toEqual(["member-a", "member-z"]);
    expect(studioPeerOrdinalV1(participants, "member-z")).toBe(2);
    expect(studioPeerOrdinalV1(participants, "member-self")).toBeNull();
  });

  it("renders a compact room count and only remote cursors", () => {
    const markup = renderToStaticMarkup(
      createElement(StudioPresenceOverlay, {
        participants: [
          participant("member-self", true),
          { ...participant("member-peer"), cursor: { x: 0.25, y: 0.75 } },
        ],
      }),
    );

    expect(markup).toContain('data-studio-presence-count="2"');
    expect(markup).toContain('data-studio-peer-cursor="1"');
    expect(markup).toContain("Editor 1");
    expect(markup).not.toContain("member-self");
    expect(markup).not.toContain("member-peer");
  });
});
