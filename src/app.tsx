import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "./lib/cn";

type Shell = "Browser" | "Electron" | "Tauri";
type PlanId = "whole-followers" | "play-followers" | "play-target";
type Point = { x: number; y: number };
type PatchStatus = "draft" | "staged";

type EditPlan = {
  id: PlanId;
  rank: string;
  title: string;
  description: string;
  temporalScope: "whole" | "play";
  followers: boolean;
  affected: readonly string[];
  sourceLabel: string;
};

const FRAME = { width: 640, height: 360 } as const;
const EQUATION = { x: 320, y: 146 } as const;
const LABEL = { x: 320, y: 236 } as const;
const PLAY_SEGMENTS = [
  { name: "Introduce", start: 0, end: 2 },
  { name: "Explain", start: 2, end: 4 },
  { name: "Move equation", start: 4, end: 7 },
  { name: "Outro", start: 7, end: 12 },
] as const;

const plans: readonly EditPlan[] = [
  {
    id: "whole-followers",
    rank: "Likely",
    title: "Move from scene start",
    description: "Recompute the label and arrow from the new initial position.",
    temporalScope: "whole",
    followers: true,
    affected: ["equation_1", "label_1", "arrow_1"],
    sourceLabel: "Patch the allocation expression",
  },
  {
    id: "play-followers",
    rank: "Alternative",
    title: "Move from current play",
    description: "Keep earlier plays unchanged and move the connected group before this play.",
    temporalScope: "play",
    followers: true,
    affected: ["equation_1", "label_1", "arrow_1"],
    sourceLabel: "Insert a grouped shift before play",
  },
  {
    id: "play-target",
    rank: "Narrow",
    title: "Move only the equation",
    description: "Keep the earlier frames, label, and arrow exactly where they are.",
    temporalScope: "play",
    followers: false,
    affected: ["equation_1"],
    sourceLabel: "Insert a local shift before play",
  },
] as const;

function detectShell(): Shell {
  if ("__TAURI_INTERNALS__" in window) return "Tauri";
  if (navigator.userAgent.includes("Electron")) return "Electron";
  return "Browser";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatTime(seconds: number) {
  return `00:${seconds.toFixed(2).padStart(5, "0")}`;
}

function playAt(time: number) {
  return PLAY_SEGMENTS.find((segment) => time >= segment.start && time < segment.end) ?? PLAY_SEGMENTS.at(-1)!;
}

function worldUnits(renderPixels: number) {
  return (renderPixels * (128 / 9)) / FRAME.width;
}

function positionStyle(point: Point): CSSProperties {
  return {
    left: `${(point.x / FRAME.width) * 100}%`,
    top: `${(point.y / FRAME.height) * 100}%`,
  };
}

function patchFor(plan: EditPlan, delta: Point) {
  const horizontal = worldUnits(delta.x);
  const vertical = worldUnits(-delta.y);
  const terms = [
    Math.abs(horizontal) > 0.005 ? `${horizontal.toFixed(2)} * RIGHT` : null,
    Math.abs(vertical) > 0.005 ? `${vertical.toFixed(2)} * UP` : null,
  ].filter(Boolean);
  const vector = terms.length > 0 ? terms.join(" + ") : "ORIGIN";

  if (plan.id === "whole-followers") {
    return {
      before: 'equation = MathTex("E = mc^2")',
      after: `equation = MathTex("E = mc^2").shift(${vector})`,
      context: "The later next_to and Arrow construction run from the new position.",
    };
  }
  if (plan.id === "play-followers") {
    return {
      before: "self.play(equation.animate.shift(RIGHT * 0.5))",
      after: `VGroup(equation, label, arrow).shift(${vector})\nself.play(equation.animate.shift(RIGHT * 0.5))`,
      context: "The shift is inserted at the beginning of the selected play boundary.",
    };
  }
  return {
    before: "self.play(equation.animate.shift(RIGHT * 0.5))",
    after: `equation.shift(${vector})\nself.play(equation.animate.shift(RIGHT * 0.5))`,
    context: "The connection geometry is intentionally left unchanged.",
  };
}

function SceneObject({
  name,
  type,
  selected = false,
  affected = false,
}: {
  name: string;
  type: string;
  selected?: boolean;
  affected?: boolean;
}) {
  return (
    <li
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs",
        selected ? "bg-sky-950 text-sky-200" : "text-zinc-400",
      )}
    >
      <span className="truncate">{name}</span>
      <span
        className={cn(
          "shrink-0 text-[11px]",
          affected ? "text-sky-400" : "text-zinc-600",
        )}
      >
        {type}
      </span>
    </li>
  );
}

export function App() {
  const shell = detectShell();
  const [delta, setDelta] = useState<Point>({ x: 100, y: 0 });
  const [selectedPlanId, setSelectedPlanId] = useState<PlanId>("whole-followers");
  const [currentTime, setCurrentTime] = useState(5);
  const [patchStatus, setPatchStatus] = useState<PatchStatus>("draft");
  const dragState = useRef<{
    pointerId: number;
    clientStart: Point;
    deltaStart: Point;
    bounds: DOMRect;
  } | null>(null);

  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId)!;
  const selectedPlay = playAt(currentTime);
  const patch = useMemo(() => patchFor(selectedPlan, delta), [delta, selectedPlan]);
  const movedEquation = { x: EQUATION.x + delta.x, y: EQUATION.y + delta.y };
  const movedLabel = { x: LABEL.x + delta.x, y: LABEL.y + delta.y };
  const hasDelta = Math.abs(delta.x) > 0.5 || Math.abs(delta.y) > 0.5;
  const affected = new Set(selectedPlan.affected);
  const impactStart = selectedPlan.temporalScope === "whole" ? 0 : selectedPlay.start;

  function updateDelta(next: Point) {
    setDelta({
      x: Math.round(clamp(next.x, -220, 220)),
      y: Math.round(clamp(next.y, -100, 100)),
    });
    setPatchStatus("draft");
  }

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.closest("[data-scene-viewport]")?.getBoundingClientRect();
    if (!bounds) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      clientStart: { x: event.clientX, y: event.clientY },
      deltaStart: delta,
      bounds,
    };
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateDelta({
      x: drag.deltaStart.x + ((event.clientX - drag.clientStart.x) * FRAME.width) / drag.bounds.width,
      y: drag.deltaStart.y + ((event.clientY - drag.clientStart.y) * FRAME.height) / drag.bounds.height,
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (dragState.current?.pointerId === event.pointerId) dragState.current = null;
  }

  return (
    <main className="flex h-dvh min-h-[640px] flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-balance text-sm font-semibold">Poietra Studio Lab</h1>
          <span className="text-zinc-700">/</span>
          <p className="truncate text-pretty text-xs text-zinc-400">examples/relativity.py · GroupedEquation</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="hidden text-zinc-500 xl:inline">Experiment: drag interpretation</span>
          <span
            className={cn(
              "rounded-md border px-2 py-1 font-medium",
              shell === "Browser"
                ? "border-zinc-700 text-zinc-400"
                : "border-sky-800 bg-sky-950 text-sky-300",
            )}
          >
            {shell}
          </span>
        </div>
      </header>

      <section className="grid min-h-0 flex-1 grid-cols-12">
        <aside className="col-span-2 min-h-0 min-w-0 overflow-y-auto border-r border-zinc-800 bg-zinc-900/70 p-3">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-balance text-xs font-medium text-zinc-300">Scene objects</h2>
            <span className="text-xs tabular-nums text-zinc-600">4</span>
          </div>
          <ol className="space-y-0.5">
            <SceneObject affected name="equation_1" selected type="MathTex" />
            <SceneObject affected={affected.has("label_1")} name="label_1" type="Text" />
            <SceneObject affected={affected.has("arrow_1")} name="arrow_1" type="Arrow" />
            <SceneObject name="proof_box" type="Rectangle" />
          </ol>

          <div className="mt-6 border-t border-zinc-800 pt-4">
            <h2 className="text-balance text-xs font-medium text-zinc-300">Observed relation</h2>
            <dl className="mt-3 space-y-2 text-xs">
              <div>
                <dt className="text-zinc-600">label → equation</dt>
                <dd className="mt-0.5 text-zinc-400">snapshot · next_to</dd>
              </div>
              <div>
                <dt className="text-zinc-600">arrow → both</dt>
                <dd className="mt-0.5 text-zinc-400">snapshot · endpoints</dd>
              </div>
            </dl>
          </div>
        </aside>

        <div className="col-span-7 flex min-w-0 flex-col bg-zinc-950">
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-balance text-sm font-medium">Rendered frame</h2>
                <p className="mt-0.5 text-pretty text-xs text-zinc-500">
                  Drag the selected equation. Use arrow keys for 10 px adjustments.
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs tabular-nums">
                <span className="text-zinc-500">Δx {delta.x > 0 ? "+" : ""}{delta.x} px</span>
                <span className="text-zinc-500">Δy {delta.y > 0 ? "+" : ""}{delta.y} px</span>
                <button
                  className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600"
                  disabled={!hasDelta}
                  onClick={() => updateDelta({ x: 0, y: 0 })}
                  type="button"
                >
                  Reset
                </button>
              </div>
            </div>

            <div
              className="relative mx-auto aspect-video max-h-full w-full max-w-5xl overflow-hidden rounded-lg border border-zinc-800 bg-black shadow-lg"
              data-scene-viewport
            >
              <svg aria-hidden="true" className="absolute inset-0 size-full" viewBox="0 0 640 360">
                <g stroke="#27272a" strokeWidth="1">
                  <line x1="0" x2="640" y1="180" y2="180" />
                  <line x1="320" x2="320" y1="0" y2="360" />
                  <line x1="80" x2="80" y1="0" y2="360" />
                  <line x1="160" x2="160" y1="0" y2="360" />
                  <line x1="240" x2="240" y1="0" y2="360" />
                  <line x1="400" x2="400" y1="0" y2="360" />
                  <line x1="480" x2="480" y1="0" y2="360" />
                  <line x1="560" x2="560" y1="0" y2="360" />
                  <line x1="0" x2="640" y1="90" y2="90" />
                  <line x1="0" x2="640" y1="270" y2="270" />
                </g>

                <rect fill="none" height="62" rx="4" stroke="#3f3f46" width="230" x="205" y="116" />
                <g opacity="0.75" stroke="#a1a1aa" strokeWidth="1.5">
                  <line x1="320" x2="320" y1="211" y2="178" />
                  <path d="M 315 184 L 320 177 L 325 184" fill="none" />
                </g>

                {selectedPlan.followers && hasDelta ? (
                  <g
                    fill="none"
                    opacity="0.8"
                    stroke="#38bdf8"
                    strokeDasharray="5 4"
                    strokeWidth="1.5"
                    transform={`translate(${delta.x} ${delta.y})`}
                  >
                    <line x1="320" x2="320" y1="211" y2="178" />
                    <path d="M 315 184 L 320 177 L 325 184" />
                  </g>
                ) : null}

                {hasDelta ? (
                  <path
                    d={`M ${EQUATION.x} ${EQUATION.y} L ${movedEquation.x} ${movedEquation.y}`}
                    fill="none"
                    markerEnd="url(#trajectory-arrow)"
                    stroke="#38bdf8"
                    strokeDasharray="4 4"
                    strokeWidth="1.5"
                  />
                ) : null}
                <defs>
                  <marker id="trajectory-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
                    <path d="M0,0 L6,3 L0,6 Z" fill="#38bdf8" />
                  </marker>
                </defs>
              </svg>

              <div
                className={cn(
                  "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 font-serif text-3xl text-zinc-100",
                  hasDelta && "opacity-30",
                )}
                style={positionStyle(EQUATION)}
              >
                E = mc²
              </div>
              <div
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-xs text-zinc-400"
                style={positionStyle(LABEL)}
              >
                energy
              </div>

              {selectedPlan.followers && hasDelta ? (
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 text-xs text-sky-300"
                  style={positionStyle(movedLabel)}
                >
                  energy
                </div>
              ) : null}

              <button
                aria-label="Move equation_1"
                className={cn(
                  "absolute -translate-x-1/2 -translate-y-1/2 cursor-grab select-none border px-3 py-2 font-serif text-3xl outline-none active:cursor-grabbing",
                  "border-sky-400 bg-sky-950/50 text-sky-100 focus-visible:ring-2 focus-visible:ring-sky-400",
                )}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 1 : 10;
                  if (event.key === "ArrowLeft") updateDelta({ x: delta.x - step, y: delta.y });
                  else if (event.key === "ArrowRight") updateDelta({ x: delta.x + step, y: delta.y });
                  else if (event.key === "ArrowUp") updateDelta({ x: delta.x, y: delta.y - step });
                  else if (event.key === "ArrowDown") updateDelta({ x: delta.x, y: delta.y + step });
                  else return;
                  event.preventDefault();
                }}
                onPointerCancel={endDrag}
                onPointerDown={beginDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                style={{ ...positionStyle(movedEquation), touchAction: "none" }}
                type="button"
              >
                E = mc²
                <span className="absolute -top-6 left-0 bg-sky-400 px-1.5 py-0.5 font-sans text-[11px] font-medium text-sky-950">
                  equation_1
                </span>
              </button>

              <div className="absolute bottom-2 left-2 flex gap-2 text-[11px] tabular-nums text-zinc-500">
                <span>640 × 360</span>
                <span>frame 300</span>
                <span>{formatTime(currentTime)}</span>
              </div>
            </div>
          </div>

          <section className="shrink-0 border-t border-zinc-800 bg-zinc-900/70 px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-balance text-xs font-medium text-zinc-300">Timeline</h2>
                <span className="text-xs text-zinc-500">{selectedPlay.name}</span>
              </div>
              <span className="text-xs tabular-nums text-zinc-400">{formatTime(currentTime)} / 00:12.00</span>
            </div>

            <div className="relative h-14 border border-zinc-700 bg-zinc-950">
              <div
                className="absolute bottom-0 top-0 border-x border-sky-700 bg-sky-950/70"
                style={{ left: `${(impactStart / 12) * 100}%`, right: 0 }}
              />
              <div className="absolute inset-0 flex">
                {PLAY_SEGMENTS.map((segment) => (
                  <div
                    className={cn(
                      "flex items-end border-r border-zinc-800 px-2 pb-1 text-[11px]",
                      segment.name === selectedPlay.name ? "text-zinc-200" : "text-zinc-600",
                    )}
                    key={segment.name}
                    style={{ width: `${((segment.end - segment.start) / 12) * 100}%` }}
                  >
                    <span className="truncate">{segment.name}</span>
                  </div>
                ))}
              </div>
              <div
                aria-hidden="true"
                className="absolute bottom-0 top-0 w-px bg-sky-400"
                style={{ left: `${(currentTime / 12) * 100}%` }}
              />
            </div>
            <label className="sr-only" htmlFor="timeline-position">Timeline position</label>
            <input
              className="mt-2 w-full accent-sky-400"
              id="timeline-position"
              max="11.99"
              min="0"
              onChange={(event) => {
                setCurrentTime(Number(event.currentTarget.value));
                setPatchStatus("draft");
              }}
              step="0.01"
              type="range"
              value={currentTime}
            />
          </section>
        </div>

        <aside className="col-span-3 flex min-h-0 min-w-0 flex-col border-l border-zinc-800 bg-zinc-900">
          <div className="border-b border-zinc-800 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-balance text-sm font-medium">Interpret this drag</h2>
                <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
                  Each suggestion interprets the same gesture with a different temporal or dependency scope.
                </p>
              </div>
              <span className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400">
                3 plans
              </span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-2" role="list" aria-label="Edit plan suggestions">
              {plans.map((plan) => {
                const selected = plan.id === selectedPlanId;
                return (
                  <div key={plan.id} role="listitem">
                    <button
                      aria-pressed={selected}
                      className={cn(
                        "w-full rounded-md border p-3 text-left",
                        selected
                          ? "border-sky-700 bg-sky-950/60"
                          : "border-zinc-700 bg-zinc-950/40 hover:border-zinc-600 hover:bg-zinc-800/70",
                      )}
                      onClick={() => {
                        setSelectedPlanId(plan.id);
                        setPatchStatus("draft");
                      }}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className={cn("text-xs font-medium", selected ? "text-sky-200" : "text-zinc-200")}>
                          {plan.title}
                        </span>
                        <span className={cn("text-[11px]", selected ? "text-sky-400" : "text-zinc-600")}>
                          {plan.rank}
                        </span>
                      </div>
                      <p className="mt-1.5 text-pretty text-xs leading-5 text-zinc-500">{plan.description}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400">
                          {plan.temporalScope === "whole" ? "0.00s → end" : `${selectedPlay.start.toFixed(2)}s → end`}
                        </span>
                        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400">
                          {plan.followers ? "3 objects" : "1 object"}
                        </span>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>

            <section className="mt-4 border-t border-zinc-800 pt-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-balance text-xs font-medium text-zinc-300">Source patch</h3>
                <span className="truncate text-[11px] text-zinc-600">{selectedPlan.sourceLabel}</span>
              </div>
              <div className="mt-2 overflow-x-auto border border-zinc-700 bg-zinc-950 p-2 font-mono text-[11px] leading-5">
                <div className="whitespace-pre text-red-300/70">- {patch.before}</div>
                {patch.after.split("\n").map((line) => (
                  <div className="whitespace-pre text-emerald-300/80" key={line}>+ {line}</div>
                ))}
              </div>
              <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">{patch.context}</p>
            </section>

            <section className="mt-4 border-t border-zinc-800 pt-4">
              <h3 className="text-balance text-xs font-medium text-zinc-300">Expected impact</h3>
              <ul className="mt-2 space-y-1.5 text-xs">
                {selectedPlan.affected.map((name) => (
                  <li className="flex items-center justify-between gap-2" key={name}>
                    <span className="truncate text-zinc-400">{name}</span>
                    <span className="text-sky-400">allowed</span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-2">
                  <span className="truncate text-zinc-400">proof_box</span>
                  <span className="text-zinc-600">must not change</span>
                </li>
              </ul>
            </section>
          </div>

          <div className="border-t border-zinc-800 p-3">
            {patchStatus === "staged" ? (
              <div className="mb-3 border border-sky-800 bg-sky-950/50 p-2 text-xs">
                <p className="font-medium text-sky-200">Patch staged</p>
                <p className="mt-1 text-pretty leading-5 text-sky-400/80">Full render validation is still required before commit.</p>
              </div>
            ) : null}
            <button
              className="w-full rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-sky-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
              disabled={!hasDelta}
              onClick={() => setPatchStatus("staged")}
              type="button"
            >
              Apply selected patch
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}
