import type { RefObject } from "react";
import { m, useDragControls } from "motion/react";

import type { PendingClarification } from "../ai/clarification";
import { ClarificationPanel } from "../ai/clarification-panel";
import type { ClarificationOption } from "../ai/edit-suggestions";
import { cn } from "../lib/cn";

export type SuggestionStatus = "clarification" | "error" | "idle" | "loading" | "ready";

export function MagicEditPanel({
  aiEndpointConfigured,
  clarificationIsStale,
  currentTime,
  instruction,
  message,
  onEditRequest,
  onHide,
  onInstructionChange,
  onRequest,
  onSelect,
  pendingClarification,
  sceneName,
  selectedCount,
  status,
  workspaceBounds,
}: Readonly<{
  aiEndpointConfigured: boolean;
  clarificationIsStale: boolean;
  currentTime: number;
  instruction: string;
  message: string | null;
  onEditRequest: () => void;
  onHide: () => void;
  onInstructionChange: (instruction: string) => void;
  onRequest: () => void;
  onSelect: (option: ClarificationOption) => void;
  pendingClarification: PendingClarification | null;
  sceneName: string | null;
  selectedCount: number;
  status: SuggestionStatus;
  workspaceBounds: RefObject<HTMLElement | null>;
}>) {
  const dragControls = useDragControls();
  const isLoading = status === "loading";
  return (
    <m.section
      className="fixed z-30 w-[min(25rem,calc(100vw-2rem))] border border-zinc-700 bg-zinc-950 shadow-xl"
      drag
      dragConstraints={workspaceBounds}
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      id="studio-magic-edit"
      style={{
        right: "max(1.5rem, env(safe-area-inset-right))",
        top: "max(4rem, env(safe-area-inset-top))",
      }}
    >
      <div className="flex cursor-grab items-center justify-between border-b border-zinc-800 px-3 py-2 active:cursor-grabbing">
        <button
          aria-label="Move Magic Edit panel"
          className="min-w-0 flex-1 cursor-grab text-left active:cursor-grabbing"
          onPointerDown={(event) => dragControls.start(event)}
          type="button"
        >
          <span className="block text-balance text-xs font-medium text-zinc-200">Magic Edit</span>
          <span className="block truncate text-[10px] text-zinc-600">{sceneName ?? "No Scene"} · {currentTime.toFixed(2)}s</span>
        </button>
        <button
          aria-label="Hide Magic Edit"
          className="px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={onHide}
          type="button"
        >
          Hide
        </button>
      </div>
      <form
        className="p-3"
        onSubmit={(event) => {
          event.preventDefault();
          onRequest();
        }}
      >
        {pendingClarification ? (
          <ClarificationPanel
            isLoading={isLoading}
            isStale={clarificationIsStale}
            onEditRequest={onEditRequest}
            onSelect={onSelect}
            pending={pendingClarification}
          />
        ) : null}
        <label className="sr-only" htmlFor="magic-edit-instruction">Describe an edit</label>
        <textarea
          aria-describedby={pendingClarification ? "magic-edit-clarification-question" : undefined}
          className="min-h-20 w-full resize-y border border-zinc-700 bg-zinc-900 p-2 text-sm leading-5 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500 disabled:text-zinc-600"
          disabled={!aiEndpointConfigured || isLoading || clarificationIsStale}
          id="magic-edit-instruction"
          maxLength={2_000}
          onChange={(event) => onInstructionChange(event.currentTarget.value)}
          placeholder={pendingClarification ? "Answer this question…" : "Describe an edit"}
          value={instruction}
        />
        {message ? (
          <p className={cn(
            "mt-2 text-pretty text-[10px] leading-4",
            status === "error" ? "text-red-300" : "text-zinc-500",
          )} role={status === "error" ? "alert" : undefined}>
            {message}
          </p>
        ) : null}
        {!aiEndpointConfigured ? (
          <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-300">Configure VITE_POIETRA_AI_ENDPOINT to enable remote inference.</p>
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="truncate text-[10px] text-zinc-600">
            {selectedCount > 0 ? `${selectedCount} selected` : "No selection · creation is available"}
          </span>
          <button
            className="bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            disabled={!aiEndpointConfigured || !instruction.trim() || isLoading || clarificationIsStale}
            type="submit"
          >
            {isLoading ? "Thinking…" : pendingClarification ? "Answer" : "Preview"}
          </button>
        </div>
      </form>
    </m.section>
  );
}
