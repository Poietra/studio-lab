import { useState } from "react";

import { dataSeriesUnavailableReason, formatDataPlotCsv, parseDataPlotCsv } from "./data-plot";
import type { DataSeries, EntityDimensions } from "./model";

export type DataPlotInspectorAuthoring = Readonly<{
  dimensions: EntityDimensions;
  entityId: string;
  initialDataSeries: DataSeries | null;
  mode: "add" | "update";
  onSubmit: (dataSeries: DataSeries) => boolean;
  unavailableReason: string | null;
}>;

export function DataPlotEditor({ authoring }: Readonly<{ authoring: DataPlotInspectorAuthoring }>) {
  const [csv, setCsv] = useState(
    authoring.initialDataSeries ? formatDataPlotCsv(authoring.initialDataSeries.points) : "",
  );
  const [interpolation, setInterpolation] = useState<DataSeries["interpolation"]>(
    authoring.initialDataSeries?.interpolation ?? "linear",
  );
  const [message, setMessage] = useState<string | null>(null);
  const submitLabel = authoring.mode === "add" ? "Add data plot" : "Update data plot";

  return (
    <section className="mt-4 border-t border-zinc-800 pt-3">
      <h3 className="text-xs font-medium text-zinc-300">Data plot</h3>
      <p className="mt-1 text-pretty text-[10px] leading-4 text-zinc-600">
        Enter one x,y pair per line. Values must stay inside the Axes range.
      </p>
      <form
        className="mt-2 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = parseDataPlotCsv(csv);
          if (parsed.kind === "invalid") {
            setMessage(parsed.message);
            return;
          }
          const dataSeries = { interpolation, points: parsed.points } as const;
          const unavailable = dataSeriesUnavailableReason(dataSeries, authoring.dimensions);
          if (unavailable) {
            setMessage(unavailable);
            return;
          }
          setMessage(authoring.onSubmit(dataSeries) ? null : "The data plot draft could not be created.");
        }}
      >
        <textarea
          aria-label="Data plot sample points"
          className="min-h-20 resize-y border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] leading-4 text-zinc-300 outline-none focus:border-sky-500"
          disabled={authoring.unavailableReason !== null}
          onChange={(event) => setCsv(event.currentTarget.value)}
          placeholder={"-1,0\n0,1\n1,0"}
          spellCheck={false}
          value={csv}
        />
        <div className="flex items-center gap-2">
          <label className="text-[10px] text-zinc-500" htmlFor={`data-plot-interpolation-${authoring.entityId}`}>
            Curve
          </label>
          <select
            aria-label="Data plot interpolation"
            className="h-7 border border-zinc-700 bg-zinc-950 px-1.5 text-[10px] text-zinc-300 outline-none focus:border-sky-500"
            disabled={authoring.unavailableReason !== null}
            id={`data-plot-interpolation-${authoring.entityId}`}
            onChange={(event) => setInterpolation(event.currentTarget.value as DataSeries["interpolation"])}
            value={interpolation}
          >
            <option value="linear">Linear</option>
            <option value="smooth">Smooth</option>
          </select>
          <button
            className="ml-auto h-7 border border-sky-700 px-2 text-[10px] text-sky-300 hover:bg-sky-950 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-700 disabled:hover:bg-transparent"
            disabled={authoring.unavailableReason !== null}
            type="submit"
          >
            {submitLabel}
          </button>
        </div>
      </form>
      {(authoring.unavailableReason ?? message) ? (
        <p className="mt-2 text-pretty text-[10px] leading-4 text-amber-500" role="status">
          {authoring.unavailableReason ?? message}
        </p>
      ) : null}
    </section>
  );
}
