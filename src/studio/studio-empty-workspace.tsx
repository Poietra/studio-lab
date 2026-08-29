import { cn } from "../lib/cn";
import type { InsertEntityType } from "./authoring-commands";

export type StudioEmptyWorkspaceEntityType = Extract<InsertEntityType, "Circle" | "Rectangle" | "Text">;

const EMPTY_WORKSPACE_ACTIONS = [
  { label: "Add Text", primary: true, type: "Text" },
  { label: "Add Circle", primary: false, type: "Circle" },
  { label: "Add Rectangle", primary: false, type: "Rectangle" },
] as const satisfies readonly Readonly<{
  label: string;
  primary: boolean;
  type: StudioEmptyWorkspaceEntityType;
}>[];

export function studioNativeWorkspaceOnboardingAvailable(
  input: Readonly<{
    authoredObjectCount: number;
    draftActive: boolean;
    nativeSceneActive: boolean;
    scenePostEffectCount: number;
  }>,
) {
  return (
    input.nativeSceneActive && input.authoredObjectCount === 0 && input.scenePostEffectCount === 0 && !input.draftActive
  );
}

export function StudioEmptyWorkspace({
  onCreateEntity,
  onCreateStarterComposition,
}: Readonly<{
  onCreateEntity: (type: StudioEmptyWorkspaceEntityType) => void;
  onCreateStarterComposition?: () => void;
}>) {
  return (
    <section
      aria-label="Empty canvas"
      className="absolute left-1/2 top-1/2 z-30 w-80 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 border border-zinc-700 bg-zinc-950/95 p-4 text-center shadow-lg"
      data-studio-empty-workspace=""
    >
      <h2 className="text-balance text-sm font-medium text-zinc-100">Create your first object</h2>
      <p className="mt-1 text-pretty text-xs leading-5 text-zinc-400">
        Add an editable object at the center of the canvas.
      </p>
      <div aria-label="Quick create" className="mt-3 flex flex-wrap justify-center gap-2" role="group">
        {EMPTY_WORKSPACE_ACTIONS.map((action) => (
          <button
            className={cn(
              "h-9 border px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950",
              action.primary
                ? "border-sky-500 bg-sky-500 text-sky-950 hover:border-sky-400 hover:bg-sky-400"
                : "border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
            )}
            data-studio-empty-workspace-action={action.type}
            key={action.type}
            onClick={() => onCreateEntity(action.type)}
            type="button"
          >
            {action.label}
          </button>
        ))}
      </div>
      {onCreateStarterComposition ? (
        <button
          className="mt-3 text-xs text-zinc-400 underline decoration-zinc-600 underline-offset-4 outline-none hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          onClick={onCreateStarterComposition}
          type="button"
        >
          Add starter composition
        </button>
      ) : null}
    </section>
  );
}
