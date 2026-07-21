import type { ClarificationOption } from "./edit-suggestions";
import type { PendingClarification } from "./clarification";

type ClarificationPanelProps = Readonly<{
  isLoading: boolean;
  isStale: boolean;
  onEditRequest: () => void;
  onSelect: (option: ClarificationOption) => void;
  pending: PendingClarification;
}>;

export function ClarificationPanel({
  isLoading,
  isStale,
  onEditRequest,
  onSelect,
  pending,
}: ClarificationPanelProps) {
  return (
    <div className="mb-2 border-y border-amber-950 py-2 text-[10px] leading-4">
      <div className="flex items-start justify-between gap-3">
        <div aria-live="polite" className="min-w-0">
          <p className="font-medium text-amber-300">More detail needed</p>
          <p
            className="mt-0.5 text-pretty text-zinc-300"
            id="magic-edit-clarification-question"
          >
            {pending.question}
          </p>
        </div>
        <button
          className="shrink-0 text-zinc-500 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-200"
          onClick={onEditRequest}
          type="button"
        >
          Edit request
        </button>
      </div>
      {pending.options.length > 0 ? (
        <div
          aria-label="Clarification choices"
          className="mt-2 grid gap-1.5"
          role="group"
        >
          {pending.options.map((option) => (
            <button
              className="group border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-left hover:border-sky-600 disabled:cursor-not-allowed"
              disabled={isLoading || isStale}
              key={option.id}
              onClick={() => onSelect(option)}
              type="button"
            >
              <span className="block font-medium text-sky-300 group-disabled:text-zinc-600">{option.label}</span>
              <span className="block text-pretty text-zinc-500 group-disabled:text-zinc-700">{option.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      <p className="mt-1.5 text-pretty text-zinc-500">
        {pending.options.length > 0
          ? "Choose an option, or type another answer below. A new preview will be generated before Apply."
          : "Type a short answer below. The original request and this question will be sent with it."}
      </p>
      {isStale ? (
        <p className="mt-1 text-pretty text-amber-300" role="alert">
          The Scene context changed after this question. Edit the original request and preview it again.
        </p>
      ) : null}
    </div>
  );
}
