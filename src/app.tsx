import { cn } from "./lib/cn";

type Shell = "Browser" | "Electron" | "Tauri";

function detectShell(): Shell {
  if ("__TAURI_INTERNALS__" in window) return "Tauri";
  if (navigator.userAgent.includes("Electron")) return "Electron";
  return "Browser";
}

const metrics = [
  ["Frame", "300"],
  ["Time", "05.00 s"],
  ["Objects", "128"],
  ["Trace", "1.8 MB"],
] as const;

const ticks = Array.from({ length: 24 }, (_, index) => index);

export function App() {
  const shell = detectShell();

  return (
    <main className="min-h-dvh bg-zinc-950 text-zinc-100">
      <header className="flex h-12 items-center justify-between border-b border-zinc-800 px-4">
        <div className="flex items-baseline gap-3">
          <h1 className="text-balance text-sm font-semibold">Poietra Studio Lab</h1>
          <p className="text-pretty text-xs text-zinc-500">Shell comparison fixture</p>
        </div>
        <span
          className={cn(
            "rounded-md border px-2 py-1 text-xs font-medium",
            shell === "Browser"
              ? "border-zinc-700 text-zinc-400"
              : "border-sky-700 bg-sky-950 text-sky-300",
          )}
        >
          {shell}
        </span>
      </header>

      <section className="grid min-h-[calc(100dvh-3rem)] grid-cols-[15rem_minmax(0,1fr)_15rem]">
        <aside className="border-r border-zinc-800 bg-zinc-900 p-3">
          <p className="mb-3 text-pretty text-xs font-medium text-zinc-400">Scene objects</p>
          <ol className="space-y-1 text-sm">
            <li className="rounded-md bg-zinc-800 px-3 py-2 text-zinc-100">equation_1</li>
            <li className="rounded-md px-3 py-2 text-zinc-400">arrow_1</li>
            <li className="rounded-md px-3 py-2 text-zinc-400">label_1</li>
          </ol>
        </aside>

        <div className="flex min-w-0 flex-col">
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="relative aspect-video w-full max-w-4xl overflow-hidden rounded-lg border border-zinc-800 bg-black shadow-lg">
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="font-serif text-4xl text-zinc-100">E = mc²</span>
              </div>
              <div className="absolute left-[39%] top-[39%] h-[22%] w-[22%] border border-sky-400">
                <span className="absolute -top-6 left-0 bg-sky-500 px-1.5 py-0.5 text-xs font-medium text-sky-950">
                  equation_1
                </span>
              </div>
            </div>
          </div>

          <div className="border-t border-zinc-800 bg-zinc-900 p-4">
            <div className="mb-3 flex items-center justify-between text-xs text-zinc-400">
              <span>Timeline fixture</span>
              <span className="tabular-nums">00:05.00 / 00:12.00</span>
            </div>
            <div className="relative h-16 overflow-hidden rounded-md border border-zinc-700 bg-zinc-950 px-2 pt-3">
              <div className="flex h-8 items-end gap-1">
                {ticks.map((tick) => (
                  <span
                    className={cn(
                      "block flex-1 bg-zinc-700",
                      tick % 6 === 0 ? "h-6" : tick % 3 === 0 ? "h-4" : "h-2",
                    )}
                    key={tick}
                  />
                ))}
              </div>
              <div className="absolute bottom-0 left-[42%] top-0 w-px bg-sky-400" />
            </div>
          </div>
        </div>

        <aside className="border-l border-zinc-800 bg-zinc-900 p-3">
          <p className="mb-3 text-pretty text-xs font-medium text-zinc-400">Representative load</p>
          <dl className="space-y-3">
            {metrics.map(([label, value]) => (
              <div className="flex items-center justify-between gap-3" key={label}>
                <dt className="text-xs text-zinc-500">{label}</dt>
                <dd className="truncate text-sm tabular-nums text-zinc-200">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 text-pretty text-xs leading-5 text-zinc-500">
            Values are placeholders until the media, overlay, subprocess, and Runtime IR fixtures are wired.
          </p>
        </aside>
      </section>
    </main>
  );
}
