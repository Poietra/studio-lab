import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { STUDIO_CREATION_TEXT_MAX_LENGTH } from "./editable-content";
import type { Point } from "./model";
import { viewportPositionStyle } from "./studio-viewport-geometry";

export type StudioInlineTextEditorSession = Readonly<{
  entityId?: string;
  initialValue: string;
  kind: "create" | "edit";
  point: Point;
}>;

export type StudioInlineTextKeyAction = "cancel" | "commit" | null;

export function studioInlineTextKeyAction(
  key: string,
  composing: boolean,
  commitModifier = false,
): StudioInlineTextKeyAction {
  if (composing) return null;
  if (key === "Enter" && commitModifier) return "commit";
  if (key === "Escape") return "cancel";
  return null;
}

export function studioInlineTextBlurCommits(composing: boolean) {
  return !composing;
}

export function StudioInlineTextEditor({
  onCancel,
  onCommit,
  session,
}: Readonly<{
  onCancel: () => void;
  onCommit: (text: string) => boolean;
  session: StudioInlineTextEditorSession;
}>) {
  const [value, setValue] = useState(session.initialValue);
  const composing = useRef(false);
  const committing = useRef(false);
  const editor = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    editor.current?.focus();
    if (session.kind === "edit") editor.current?.select();
  }, [session.kind]);

  function commit() {
    if (committing.current) return;
    committing.current = true;
    try {
      if (!onCommit(value)) committing.current = false;
    } catch (error) {
      committing.current = false;
      throw error;
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    event.stopPropagation();
    const action = studioInlineTextKeyAction(
      event.key,
      composing.current || event.nativeEvent.isComposing,
      event.ctrlKey || event.metaKey,
    );
    if (!action) return;
    event.preventDefault();
    if (action === "cancel") {
      committing.current = true;
      onCancel();
    } else commit();
  }

  return (
    <div
      className="absolute z-40 -translate-x-1/2 -translate-y-1/2"
      data-studio-inline-text-editor={session.kind}
      style={viewportPositionStyle(session.point)}
    >
      <label className="block min-w-48 border border-sky-400 bg-zinc-950/95 p-1 shadow-xl shadow-black/40">
        <span className="sr-only">{session.kind === "create" ? "New text" : "Edit text"}</span>
        <textarea
          aria-label={session.kind === "create" ? "New text content" : "Edit text content"}
          autoComplete="off"
          className="block min-h-8 w-full resize-none bg-transparent px-1 py-1 text-sm leading-5 text-zinc-100 outline-none"
          maxLength={STUDIO_CREATION_TEXT_MAX_LENGTH}
          onBlur={(event) => {
            event.stopPropagation();
            if (studioInlineTextBlurCommits(composing.current)) commit();
            else composing.current = false;
          }}
          onChange={(event) => setValue(event.currentTarget.value)}
          onCompositionEnd={(event) => {
            event.stopPropagation();
            composing.current = false;
          }}
          onCompositionStart={(event) => {
            event.stopPropagation();
            composing.current = true;
          }}
          onCompositionUpdate={(event) => event.stopPropagation()}
          onKeyDown={handleKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
          ref={editor}
          rows={2}
          value={value}
        />
        <span className="block px-1 text-[9px] leading-4 text-zinc-500">
          Enter for new line · Ctrl/⌘+Enter to commit · Escape to cancel
        </span>
      </label>
    </div>
  );
}
