import type { EditSuggestionOperation } from "../ai/edit-suggestions";
import {
  changeSuggestionExecution,
  editableSuggestionSteps,
  replaceSuggestionStep,
  type EditableSuggestionStep,
} from "../ai/draft-operation";
import { cn } from "../lib/cn";
import type { ProgramRecord } from "./model";
import { programExecutionCapabilities } from "./operation-registry";
import { EquationContent } from "./prototype-rendering";

type DraftInspectorProps = Readonly<{
  error: string | null;
  onApply: () => void;
  onDiscard: () => void;
  onOperationChange: (operation: EditSuggestionOperation) => void;
  operation: EditSuggestionOperation | null;
  record: ProgramRecord;
}>;

const inputClass = "mt-1 h-8 w-full border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-sky-500";
const textareaClass = "mt-1 min-h-20 w-full resize-y border border-zinc-700 bg-zinc-950 p-2 text-xs leading-5 text-zinc-200 outline-none focus:border-sky-500";

function minimumDuration(step: EditableSuggestionStep) {
  return step.kind === "create-scene-transition" ? 0.4 : 0.1;
}

function retimeStep(step: EditableSuggestionStep, start: number, duration: number): EditableSuggestionStep {
  const normalizedDuration = Math.max(minimumDuration(step), duration);
  return { ...step, end: start + normalizedDuration, start } as EditableSuggestionStep;
}

function StepEditor({
  index,
  onChange,
  step,
}: Readonly<{
  index: number;
  onChange: (step: EditableSuggestionStep) => void;
  step: EditableSuggestionStep;
}>) {
  const duration = step.end - step.start;
  return (
    <section className="border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="truncate text-balance text-xs font-medium text-zinc-200">
          {index + 1}. {step.kind}
        </h4>
        <span className="shrink-0 tabular-nums text-[10px] text-zinc-500">
          {step.start.toFixed(2)}–{step.end.toFixed(2)}s
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-[10px] text-zinc-500">
          Start
          <input
            className={inputClass}
            min="0"
            onChange={(event) => onChange(retimeStep(step, Number(event.currentTarget.value), duration))}
            step="0.1"
            type="number"
            value={step.start}
          />
        </label>
        <label className="text-[10px] text-zinc-500">
          Duration
          <input
            className={inputClass}
            min={minimumDuration(step)}
            onChange={(event) => onChange(retimeStep(step, step.start, Number(event.currentTarget.value)))}
            step="0.1"
            type="number"
            value={Number(duration.toFixed(3))}
          />
        </label>
      </div>

      {step.kind === "create-equation" || step.kind === "create-explained-equation" || step.kind === "create-transform" ? (
        <>
          <label className="mt-3 block text-[10px] text-zinc-500">
            Equation label
            <input
              className={inputClass}
              maxLength={120}
              onChange={(event) => onChange({
                ...step,
                target: { ...step.target, label: event.currentTarget.value },
              })}
              value={step.target.label}
            />
          </label>
          <label className="mt-2 block text-[10px] text-zinc-500">
            MathTex parts · one per line
            <textarea
              className={cn(textareaClass, "font-mono")}
              maxLength={2_000}
              onChange={(event) => {
                const parts = event.currentTarget.value.split("\n");
                onChange({
                  ...step,
                  target: { ...step.target, displayLines: parts, texParts: parts },
                });
              }}
              value={step.target.texParts.join("\n")}
            />
          </label>
          <div className="mt-2 overflow-x-auto border border-zinc-800 p-2 text-zinc-100">
            <EquationContent lines={step.target.displayLines} texParts={step.target.texParts} />
          </div>
        </>
      ) : null}

      {step.kind === "create-equation" || step.kind === "create-explained-equation" ? (
        <label className="mt-2 block text-[10px] text-zinc-500">
          Equation placement
          <select
            className={inputClass}
            onChange={(event) => onChange({ ...step, placement: event.currentTarget.value as "center" | "right" })}
            value={step.placement}
          >
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
      ) : null}

      {step.kind === "create-explained-equation" ? (
        <>
          <label className="mt-2 block text-[10px] text-zinc-500">
            Explanation
            <textarea
              className={textareaClass}
              maxLength={240}
              onChange={(event) => onChange({
                ...step,
                explanation: { ...step.explanation, text: event.currentTarget.value },
              })}
              value={step.explanation.text}
            />
          </label>
          <label className="mt-2 block text-[10px] text-zinc-500">
            Explanation placement
            <select
              className={inputClass}
              onChange={(event) => onChange({
                ...step,
                explanation: {
                  ...step.explanation,
                  placement: event.currentTarget.value as "above" | "below" | "left" | "right",
                },
              })}
              value={step.explanation.placement}
            >
              <option value="above">Above</option>
              <option value="below">Below</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
        </>
      ) : null}

      {step.kind === "create-explanation" ? (
        <>
          <label className="mt-3 block text-[10px] text-zinc-500">
            Explanation
            <textarea
              className={textareaClass}
              maxLength={240}
              onChange={(event) => onChange({ ...step, text: event.currentTarget.value })}
              value={step.text}
            />
          </label>
          <label className="mt-2 block text-[10px] text-zinc-500">
            Placement
            <select
              className={inputClass}
              onChange={(event) => onChange({
                ...step,
                placement: event.currentTarget.value as "above" | "below" | "left" | "right",
              })}
              value={step.placement}
            >
              <option value="above">Above</option>
              <option value="below">Below</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
        </>
      ) : null}

      {step.kind === "create-text-transform" ? (
        <label className="mt-3 block text-[10px] text-zinc-500">
          Replacement text
          <textarea
            className={textareaClass}
            maxLength={240}
            onChange={(event) => onChange({ ...step, text: event.currentTarget.value })}
            value={step.text}
          />
        </label>
      ) : null}

      {step.kind === "create-scene-transition" ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-[10px] text-zinc-500">
            Shape
            <select
              className={inputClass}
              onChange={(event) => onChange({ ...step, shape: event.currentTarget.value as "circle" | "diamond" | "hexagon" })}
              value={step.shape}
            >
              <option value="circle">Circle</option>
              <option value="diamond">Diamond</option>
              <option value="hexagon">Hexagon</option>
            </select>
          </label>
          <label className="text-[10px] text-zinc-500">
            Color
            <select
              className={inputClass}
              onChange={(event) => onChange({ ...step, color: event.currentTarget.value as "black" | "sky" | "white" })}
              value={step.color}
            >
              <option value="black">Black</option>
              <option value="sky">Sky</option>
              <option value="white">White</option>
            </select>
          </label>
        </div>
      ) : null}

      {step.kind === "create-motion" ? (
        <div className="mt-3">
          <dl className="grid grid-cols-2 gap-2 tabular-nums text-[10px]">
            <div><dt className="text-zinc-600">Delta X</dt><dd className="text-zinc-300">{step.delta.x.toFixed(1)}px</dd></div>
            <div><dt className="text-zinc-600">Delta Y</dt><dd className="text-zinc-300">{step.delta.y.toFixed(1)}px</dd></div>
          </dl>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[10px] text-zinc-500">
              Curve X
              <input
                className={inputClass}
                max="160"
                min="-160"
                onChange={(event) => onChange({
                  ...step,
                  controlOffset: { ...step.controlOffset, x: Number(event.currentTarget.value) },
                })}
                step="1"
                type="number"
                value={step.controlOffset.x}
              />
            </label>
            <label className="text-[10px] text-zinc-500">
              Curve Y
              <input
                className={inputClass}
                max="100"
                min="-100"
                onChange={(event) => onChange({
                  ...step,
                  controlOffset: { ...step.controlOffset, y: Number(event.currentTarget.value) },
                })}
                step="1"
                type="number"
                value={step.controlOffset.y}
              />
            </label>
          </div>
          <button
            className="mt-2 text-[10px] text-zinc-500 underline underline-offset-2 hover:text-zinc-200"
            disabled={step.controlOffset.x === 0 && step.controlOffset.y === 0}
            onClick={() => onChange({ ...step, controlOffset: { x: 0, y: 0 } })}
            type="button"
          >
            Reset to straight path
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function DraftInspector({
  error,
  onApply,
  onDiscard,
  onOperationChange,
  operation,
  record,
}: DraftInspectorProps) {
  const steps = operation ? editableSuggestionSteps(operation) : [];
  const execution = programExecutionCapabilities(record.program);
  const validationError = record.validation.status === "invalid"
    ? record.validation.issues.find((issue) => issue.severity === "error")?.message
      ?? "This Program is invalid and cannot be applied."
    : null;
  const applyStatus = record.validation.status === "valid" ? execution.apply : "blocked";
  const displayedError = execution.applyBlocker ?? validationError ?? error;
  return (
    <section data-draft-inspector>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-balance text-sm font-medium text-zinc-100">Draft program</h2>
          <p className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={record.program.transactionId}>
            {record.program.transactionId}
          </p>
        </div>
        <span className="shrink-0 border border-sky-900 px-1.5 py-0.5 text-[10px] text-sky-300">
          {record.program.intentCount} intents
        </span>
      </div>

      {operation?.kind === "edit-program" ? (
        <label className="mt-3 block text-[10px] text-zinc-500">
          Execution
          <select
            className={inputClass}
            onChange={(event) => onOperationChange(changeSuggestionExecution(
              operation,
              event.currentTarget.value as "parallel" | "sequence",
            ))}
            value={operation.execution}
          >
            <option value="sequence">Sequence</option>
            <option value="parallel">Parallel</option>
          </select>
        </label>
      ) : null}

      {steps.length > 0 ? (
        <div className="mt-3 space-y-2">
          {steps.map((step, index) => (
            <StepEditor
              index={index}
              key={`${step.kind}-${index}`}
              onChange={(nextStep) => {
                if (operation) onOperationChange(replaceSuggestionStep(operation, index, nextStep));
              }}
              step={step}
            />
          ))}
        </div>
      ) : (
        <p className="mt-3 border border-dashed border-zinc-700 p-3 text-pretty text-xs leading-5 text-zinc-500">
          This direct manipulation is already represented by its Canonical operations.
        </p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
        <div><dt className="text-zinc-600">Preview</dt><dd className="mt-0.5 text-zinc-300">{execution.preview}</dd></div>
        <div><dt className="text-zinc-600">Apply</dt><dd className={cn("mt-0.5", applyStatus === "supported" ? "text-zinc-300" : "text-red-300")}>{applyStatus}</dd></div>
        <div><dt className="text-zinc-600">Lowering</dt><dd className="mt-0.5 text-zinc-300">{execution.lowering}</dd></div>
        <div><dt className="text-zinc-600">Schedule</dt><dd className="mt-0.5 text-zinc-300">{record.program.schedule.mode}</dd></div>
        <div><dt className="text-zinc-600">Operations</dt><dd className="mt-0.5 tabular-nums text-zinc-300">{record.program.operations.length}</dd></div>
        <div><dt className="text-zinc-600">Anchor</dt><dd className="mt-0.5 tabular-nums text-zinc-300">{record.program.anchor.resolvedSeconds.toFixed(2)}s</dd></div>
      </dl>

      {displayedError ? (
        <p className="mt-3 border border-red-950 bg-red-950/30 p-2 text-pretty text-xs leading-5 text-red-300" id="draft-apply-error" role="alert">
          {displayedError}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2 border-t border-zinc-800 pt-3">
        <button className="border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" onClick={onDiscard} type="button">
          Discard
        </button>
        <button
          aria-describedby={displayedError ? "draft-apply-error" : undefined}
          className="bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          disabled={applyStatus !== "supported"}
          onClick={onApply}
          title={execution.applyBlocker ?? undefined}
          type="button"
        >
          Apply program
        </button>
      </div>
    </section>
  );
}
