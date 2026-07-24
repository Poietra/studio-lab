import { type FormEvent, useEffect, useRef, useState } from "react";

import { cn } from "../lib/cn";
import { generateManimThumbnail, loadManimThumbnailStatus } from "../render-pipeline/client";
import type { ManimProjectCreationInput } from "../render-pipeline/client";
import type { ManimProjectSummary, ManimThumbnailStatus } from "../render-pipeline/contracts";
import type { WorkspaceMutation } from "./use-manim-workspace";

type WorkspaceLauncherProps = Readonly<{
  creationMode: "existing" | "managed" | "native-existing";
  error: string | null;
  isLoading: boolean;
  mutation: WorkspaceMutation;
  mutationError: string | null;
  onCancelMutation: () => void;
  onClearMutationError: () => void;
  onCreate: (input: ManimProjectCreationInput) => Promise<boolean>;
  onOpen: (workspaceId: string) => void;
  onRename: (workspaceId: string, name: string) => Promise<boolean>;
  onRetry: () => void;
  onUnregister: (workspaceId: string) => Promise<boolean>;
  projects: readonly ManimProjectSummary[];
}>;

const fieldClassName =
  "mt-1 h-9 w-full border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500 disabled:cursor-wait disabled:text-zinc-500";
const secondaryButtonClassName =
  "border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-600";
const primaryButtonClassName =
  "bg-sky-500 px-3 py-1.5 text-xs font-medium text-sky-950 hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-wait disabled:bg-zinc-700 disabled:text-zinc-500";
const addWorkspaceButtonClassName =
  "inline-flex min-h-11 min-w-40 shrink-0 items-center justify-center gap-2 px-5 py-2 text-sm";
const dialogClassName =
  "m-auto w-full max-w-md border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-xl backdrop:bg-black/70";
const cardActionButtonClassName =
  "cursor-pointer px-2 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-700";
const MAX_THUMBNAIL_STATUS_ATTEMPTS = 3;

function PlusIcon() {
  return (
    <svg aria-hidden="true" className="size-5 shrink-0" fill="none" focusable="false" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  );
}

function workspaceInitials(name: string) {
  const words = name.trim().split(/\s+/u);
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0] ?? "")
      .join("")
      .toUpperCase();
  }
  return Array.from(words[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function WorkspaceThumbnailImage({ assetVersion, projectId }: Readonly<{ assetVersion: string; projectId: string }>) {
  const [state, setState] = useState<"error" | "loaded" | "loading">("loading");
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 size-full bg-zinc-950 object-cover",
        state === "loaded" ? "opacity-100" : "opacity-0",
      )}
      data-state={state}
      data-workspace-actual-thumbnail={projectId}
      decoding="async"
      draggable={false}
      loading="lazy"
      onError={() => setState("error")}
      onLoad={() => setState("loaded")}
      src={`/api/manim/projects/${encodeURIComponent(projectId)}/thumbnail?v=${encodeURIComponent(assetVersion)}`}
    />
  );
}

function WorkspaceCover({
  interactive,
  project,
  status,
}: Readonly<{
  interactive: boolean;
  project: ManimProjectSummary;
  status: ManimThumbnailStatus | null;
}>) {
  const assetVersion = status?.generatedAt ?? status?.sourceHash ?? "unresolved";

  const statusLabel =
    status?.state === "current"
      ? "Rendered"
      : status?.state === "generating"
        ? "Generating…"
        : status?.state === "stale"
          ? "Preview out of date"
          : status?.state === "failed"
            ? "Render failed"
            : status?.state === "unavailable"
              ? "Workspace unavailable"
              : status?.imageKind === "empty"
                ? "No preview"
                : status
                  ? "Semantic preview"
                  : "Loading preview…";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative grid aspect-video w-full place-items-center overflow-hidden border-b border-zinc-800 bg-zinc-900",
        interactive && "group-hover:border-zinc-700 group-hover:bg-zinc-800",
      )}
      data-workspace-thumbnail
    >
      <span className="absolute inset-3 border border-zinc-800" />
      <span
        className={cn("text-3xl font-semibold text-zinc-600", interactive && "group-hover:text-sky-400")}
        data-workspace-thumbnail-fallback
      >
        {workspaceInitials(project.name)}
      </span>
      {status && status.imageKind !== "empty" ? (
        <WorkspaceThumbnailImage assetVersion={assetVersion} key={assetVersion} projectId={project.id} />
      ) : null}
      <span
        className={cn(
          "absolute left-3 top-3 border bg-zinc-950/90 px-2 py-1 text-xs font-medium",
          status?.state === "current"
            ? "border-sky-800 text-sky-300"
            : status?.state === "failed" || status?.state === "unavailable"
              ? "border-red-900 text-red-300"
              : "border-zinc-700 text-zinc-400",
        )}
        data-thumbnail-status={status?.state ?? "loading"}
      >
        {statusLabel}
      </span>
      <span className="absolute bottom-3 right-3 border border-zinc-700 bg-zinc-950/90 px-2 py-1 text-xs font-medium text-zinc-400">
        {project.kind === "managed" ? "Studio" : "Linked"}
      </span>
    </span>
  );
}

function WorkspaceCard({
  mutationPending,
  onOpen,
  onRemove,
  onRename,
  project,
}: Readonly<{
  mutationPending: boolean;
  onOpen: (workspaceId: string) => void;
  onRemove: (project: ManimProjectSummary) => void;
  onRename: (project: ManimProjectSummary) => void;
  project: ManimProjectSummary;
}>) {
  const [thumbnailStatus, setThumbnailStatus] = useState<ManimThumbnailStatus | null>(null);
  const [thumbnailActionError, setThumbnailActionError] = useState<string | null>(null);
  const [thumbnailStatusError, setThumbnailStatusError] = useState<string | null>(null);
  const [thumbnailStatusRetryAvailable, setThumbnailStatusRetryAvailable] = useState(false);
  const [generatingThumbnail, setGeneratingThumbnail] = useState(false);
  const [statusRevision, setStatusRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    let attempts = 0;
    const loadStatus = async () => {
      attempts += 1;
      try {
        const status = await loadManimThumbnailStatus(project.id, controller.signal);
        if (!active) return;
        attempts = 0;
        setThumbnailStatusError(null);
        setThumbnailStatusRetryAvailable(false);
        setThumbnailStatus(status);
        if (status.state === "generating") {
          pollTimer = setTimeout(() => void loadStatus(), 750);
        }
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        setThumbnailStatusError(error instanceof Error ? error.message : "Could not load the preview status.");
        if (attempts < MAX_THUMBNAIL_STATUS_ATTEMPTS) {
          pollTimer = setTimeout(() => void loadStatus(), attempts * 500);
        } else {
          setThumbnailStatusRetryAvailable(true);
        }
      }
    };
    // StrictMode reconnects effects once in development. Deferring avoids sending
    // a status request from the setup React immediately discards.
    queueMicrotask(() => {
      if (active) void loadStatus();
    });
    return () => {
      active = false;
      controller.abort();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [project.id, statusRevision]);

  async function generateThumbnail() {
    setGeneratingThumbnail(true);
    setThumbnailActionError(null);
    try {
      setThumbnailStatus(await generateManimThumbnail(project.id));
      setStatusRevision((current) => current + 1);
    } catch (error) {
      setThumbnailActionError(error instanceof Error ? error.message : "Could not generate the rendered preview.");
      setStatusRevision((current) => current + 1);
    } finally {
      setGeneratingThumbnail(false);
    }
  }

  function retryThumbnailStatus() {
    setThumbnailStatusError(null);
    setThumbnailStatusRetryAvailable(false);
    setStatusRevision((current) => current + 1);
  }

  const generateLabel = thumbnailStatus?.state === "current" ? "Refresh preview" : "Generate preview";
  const renderedFailure =
    thumbnailStatus?.state === "failed" || thumbnailStatus?.state === "unavailable"
      ? (thumbnailStatus.error ?? "The rendered preview is unavailable.")
      : null;
  return (
    <li
      className={cn(
        "group flex min-h-0 flex-col overflow-hidden border border-zinc-800 bg-zinc-950",
        !mutationPending && "hover:border-zinc-600 hover:bg-zinc-900 focus-within:border-sky-500",
      )}
      data-workspace-card={project.id}
    >
      <span aria-live="polite" className="sr-only">
        {thumbnailStatus
          ? `Preview status for ${project.name}: ${thumbnailStatus.state}.`
          : `Loading preview status for ${project.name}.`}
      </span>
      <button
        aria-label={`Open ${project.name} workspace`}
        className="flex min-h-0 flex-1 cursor-pointer flex-col text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-600"
        disabled={mutationPending}
        onClick={() => onOpen(project.id)}
        type="button"
      >
        <WorkspaceCover interactive={!mutationPending} project={project} status={thumbnailStatus} />
        <span className="flex w-full flex-1 flex-col p-4 pb-2">
          <span className="block truncate text-sm font-semibold text-zinc-100" title={project.name}>
            {project.name}
          </span>
          <span className="mt-1 block text-pretty text-xs text-zinc-500">
            {project.kind === "managed" ? "Studio workspace" : "Linked Manim folder"}
          </span>
          <span className="mt-3 block text-xs font-medium text-sky-400">Open workspace</span>
        </span>
      </button>
      <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
        <button
          aria-label={`${generateLabel} for ${project.name}`}
          className={cardActionButtonClassName}
          disabled={mutationPending || generatingThumbnail || thumbnailStatus?.state === "generating"}
          onClick={() => void generateThumbnail()}
          type="button"
        >
          {generatingThumbnail || thumbnailStatus?.state === "generating" ? "Generating…" : generateLabel}
        </button>
        {thumbnailStatusError && thumbnailStatusRetryAvailable ? (
          <button
            aria-label={`Retry preview status for ${project.name}`}
            className={cardActionButtonClassName}
            disabled={mutationPending}
            onClick={retryThumbnailStatus}
            type="button"
          >
            Retry status
          </button>
        ) : null}
        <button
          aria-label={`Rename ${project.name} workspace`}
          className={cardActionButtonClassName}
          disabled={mutationPending}
          onClick={() => onRename(project)}
          type="button"
        >
          Rename
        </button>
        <button
          aria-label={`${project.kind === "managed" ? "Delete" : "Remove"} ${project.name} workspace`}
          className="cursor-pointer px-2 py-1.5 text-xs font-medium text-zinc-500 hover:bg-red-950 hover:text-red-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:cursor-wait disabled:text-zinc-700"
          disabled={mutationPending}
          onClick={() => onRemove(project)}
          type="button"
        >
          {project.kind === "managed" ? "Delete" : "Remove"}
        </button>
      </div>
      {renderedFailure ? (
        <p className="border-t border-red-950 px-4 py-2 text-pretty text-xs leading-5 text-red-300" role="status">
          {renderedFailure}
        </p>
      ) : null}
      {thumbnailStatusError ? (
        <p className="border-t border-red-950 px-4 py-2 text-pretty text-xs leading-5 text-red-300" role="alert">
          Preview status could not be refreshed: {thumbnailStatusError}
        </p>
      ) : null}
      {thumbnailActionError ? (
        <p className="border-t border-red-950 px-4 py-2 text-pretty text-xs leading-5 text-red-300" role="alert">
          Preview action failed: {thumbnailActionError}
        </p>
      ) : null}
    </li>
  );
}

export function WorkspaceLauncher({
  creationMode,
  error,
  isLoading,
  mutation,
  mutationError,
  onCancelMutation,
  onClearMutationError,
  onCreate,
  onOpen,
  onRename,
  onRetry,
  onUnregister,
  projects,
}: WorkspaceLauncherProps) {
  const addDialog = useRef<HTMLDialogElement | null>(null);
  const renameDialog = useRef<HTMLDialogElement | null>(null);
  const removeDialog = useRef<HTMLDialogElement | null>(null);
  const [createName, setCreateName] = useState("");
  const [createRoot, setCreateRoot] = useState("");
  const [renameName, setRenameName] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState<ManimProjectSummary | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const creating = mutation?.kind === "create";
  const renaming = mutation?.kind === "rename" && mutation.workspaceId === selectedWorkspace?.id;
  const unregistering = mutation?.kind === "unregister" && mutation.workspaceId === selectedWorkspace?.id;
  const mutationPending = mutation !== null;
  const registeringExistingFolder = creationMode === "existing";
  const pickingExistingFolder = creationMode === "native-existing";
  const linkingExistingFolder = registeringExistingFolder || pickingExistingFolder;
  const deletingManagedWorkspace = selectedWorkspace?.kind === "managed";

  function clearDialogError() {
    setFormError(null);
    onClearMutationError();
  }

  function cancelPendingMutation(dialog: HTMLDialogElement | null) {
    onCancelMutation();
    dialog?.close();
  }

  function showAddDialog() {
    setCreateName("");
    setCreateRoot("");
    setSelectedWorkspace(null);
    clearDialogError();
    addDialog.current?.showModal();
  }

  function showRenameDialog(project: ManimProjectSummary) {
    setSelectedWorkspace(project);
    setRenameName(project.name);
    clearDialogError();
    renameDialog.current?.showModal();
  }

  function showRemoveDialog(project: ManimProjectSummary) {
    setSelectedWorkspace(project);
    clearDialogError();
    removeDialog.current?.showModal();
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = createName.trim();
    const root = createRoot.trim();
    if (!name || (registeringExistingFolder && !root)) {
      setFormError(
        registeringExistingFolder
          ? "Enter both a workspace name and an existing folder path."
          : "Enter a workspace name.",
      );
      return;
    }
    setFormError(null);
    const input: ManimProjectCreationInput = registeringExistingFolder
      ? { kind: "existing", name, root }
      : pickingExistingFolder
        ? { kind: "native-existing", name }
        : { kind: "managed", name };
    if (await onCreate(input)) addDialog.current?.close();
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = renameName.trim();
    if (!selectedWorkspace || !name) {
      setFormError("Enter a workspace name.");
      return;
    }
    setFormError(null);
    if (await onRename(selectedWorkspace.id, name)) renameDialog.current?.close();
  }

  async function submitRemove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedWorkspace) return;
    setFormError(null);
    if (await onUnregister(selectedWorkspace.id)) removeDialog.current?.close();
  }

  return (
    <main className="flex h-dvh min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <header className="flex min-h-12 shrink-0 items-center border-b border-zinc-800 px-4 py-2">
        <h1 className="text-balance text-sm font-semibold">Poietra Studio Lab</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="mx-auto w-full max-w-7xl px-6 py-12 sm:py-16">
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="text-xs font-medium text-sky-400">Workspaces</p>
              <h2 className="mt-2 text-balance text-2xl font-semibold text-zinc-100">Choose a workspace</h2>
              <p className="mt-3 max-w-xl text-pretty text-sm leading-6 text-zinc-400">
                {linkingExistingFolder
                  ? "Open a registered Manim folder, or add another workspace to Studio."
                  : "Open a workspace or create a new animation from a starter Scene."}
              </p>
            </div>
            {projects.length > 0 && !isLoading ? (
              <button
                className={cn(primaryButtonClassName, addWorkspaceButtonClassName)}
                disabled={mutationPending}
                onClick={showAddDialog}
                type="button"
              >
                <PlusIcon />
                Add workspace
              </button>
            ) : null}
          </div>

          {error ? (
            <div className="mt-8 border border-red-900 bg-red-950/40 p-4" role="alert">
              <p className="text-pretty text-sm text-red-200">{error}</p>
              <button
                className="mt-3 border border-red-800 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
                onClick={onRetry}
                type="button"
              >
                Retry
              </button>
            </div>
          ) : null}

          {isLoading ? (
            <div
              aria-busy="true"
              aria-label="Loading workspaces"
              className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              data-workspace-grid
              role="status"
            >
              {[0, 1, 2, 3].map((index) => (
                <div className="overflow-hidden border border-zinc-800 bg-zinc-950" key={index}>
                  <div className="aspect-video bg-zinc-900" />
                  <div className="p-4">
                    <div className="h-4 w-32 bg-zinc-800" />
                    <div className="mt-3 h-3 w-24 bg-zinc-900" />
                    <div className="mt-5 h-7 w-28 bg-zinc-900" />
                  </div>
                </div>
              ))}
            </div>
          ) : projects.length > 0 ? (
            <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-workspace-grid>
              {projects.map((project) => (
                <WorkspaceCard
                  key={project.id}
                  mutationPending={mutationPending}
                  onOpen={onOpen}
                  onRemove={showRemoveDialog}
                  onRename={showRenameDialog}
                  project={project}
                />
              ))}
            </ul>
          ) : error ? null : (
            <div className="mt-8 border border-zinc-800 p-5">
              <h3 className="text-balance text-sm font-medium">No workspaces are registered</h3>
              <p className="mt-2 text-pretty text-xs leading-5 text-zinc-500">
                {linkingExistingFolder
                  ? "Add an existing Manim project folder to start editing its Scenes."
                  : "Create a workspace to start with an editable Manim Scene."}
              </p>
              <button
                className={cn(primaryButtonClassName, addWorkspaceButtonClassName, "mt-4")}
                onClick={showAddDialog}
                type="button"
              >
                <PlusIcon />
                Add workspace
              </button>
            </div>
          )}
        </section>
      </div>

      <dialog
        aria-describedby="add-workspace-description"
        aria-labelledby="add-workspace-title"
        className={dialogClassName}
        onCancel={onCancelMutation}
        onClose={clearDialogError}
        ref={addDialog}
      >
        <form
          aria-busy={creating}
          className="p-4"
          method="dialog"
          noValidate
          onSubmit={(event) => void submitCreate(event)}
        >
          <h2 className="text-balance text-sm font-medium" id="add-workspace-title">
            Add workspace
          </h2>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400" id="add-workspace-description">
            {linkingExistingFolder
              ? pickingExistingFolder
                ? "Choose an existing Manim folder on this machine. Studio will not move or copy its files."
                : "Register an existing folder on this machine. Studio will not move or copy its files."
              : "Create a new workspace with a starter Manim Scene. No folder setup is required."}
          </p>
          <label className="mt-4 block text-xs font-medium text-zinc-300" htmlFor="workspace-name">
            Workspace name
          </label>
          <input
            aria-describedby={formError || mutationError ? "add-workspace-error" : undefined}
            aria-invalid={Boolean(formError || mutationError)}
            autoComplete="off"
            className={fieldClassName}
            disabled={creating}
            id="workspace-name"
            maxLength={120}
            onChange={(event) => setCreateName(event.currentTarget.value)}
            placeholder="My animation"
            required
            value={createName}
          />
          {registeringExistingFolder ? (
            <>
              <label className="mt-4 block text-xs font-medium text-zinc-300" htmlFor="workspace-root">
                Existing folder path
              </label>
              <input
                aria-describedby={formError || mutationError ? "add-workspace-error" : undefined}
                aria-invalid={Boolean(formError || mutationError)}
                autoComplete="off"
                className={fieldClassName}
                disabled={creating}
                id="workspace-root"
                maxLength={4096}
                onChange={(event) => setCreateRoot(event.currentTarget.value)}
                placeholder="/path/to/manim-project"
                required
                value={createRoot}
              />
            </>
          ) : null}
          {formError || mutationError ? (
            <p className="mt-3 text-pretty text-xs leading-5 text-red-300" id="add-workspace-error" role="alert">
              {formError ?? mutationError}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              className={secondaryButtonClassName}
              onClick={() => cancelPendingMutation(addDialog.current)}
              type="button"
            >
              Cancel
            </button>
            <button className={primaryButtonClassName} disabled={creating} type="submit">
              {creating
                ? linkingExistingFolder
                  ? "Adding…"
                  : "Creating…"
                : pickingExistingFolder
                  ? "Choose folder…"
                  : registeringExistingFolder
                    ? "Add workspace"
                    : "Create workspace"}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        aria-describedby="rename-workspace-description"
        aria-labelledby="rename-workspace-title"
        className={dialogClassName}
        onCancel={onCancelMutation}
        onClose={clearDialogError}
        ref={renameDialog}
      >
        <form
          aria-busy={renaming}
          className="p-4"
          method="dialog"
          noValidate
          onSubmit={(event) => void submitRename(event)}
        >
          <h2 className="text-balance text-sm font-medium" id="rename-workspace-title">
            Rename workspace
          </h2>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400" id="rename-workspace-description">
            Change the name shown in Studio. The workspace content stays the same.
          </p>
          <label className="mt-4 block text-xs font-medium text-zinc-300" htmlFor="renamed-workspace-name">
            Workspace name
          </label>
          <input
            aria-describedby={formError || mutationError ? "rename-workspace-error" : undefined}
            aria-invalid={Boolean(formError || mutationError)}
            autoComplete="off"
            className={fieldClassName}
            disabled={renaming}
            id="renamed-workspace-name"
            maxLength={120}
            onChange={(event) => setRenameName(event.currentTarget.value)}
            required
            value={renameName}
          />
          {formError || mutationError ? (
            <p className="mt-3 text-pretty text-xs leading-5 text-red-300" id="rename-workspace-error" role="alert">
              {formError ?? mutationError}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              className={secondaryButtonClassName}
              onClick={() => cancelPendingMutation(renameDialog.current)}
              type="button"
            >
              Cancel
            </button>
            <button className={primaryButtonClassName} disabled={renaming} type="submit">
              {renaming ? "Saving…" : "Save name"}
            </button>
          </div>
        </form>
      </dialog>

      <dialog
        aria-describedby="remove-workspace-description"
        aria-labelledby="remove-workspace-title"
        className={dialogClassName}
        onCancel={onCancelMutation}
        onClose={clearDialogError}
        ref={removeDialog}
        role="alertdialog"
      >
        <form aria-busy={unregistering} className="p-4" method="dialog" onSubmit={(event) => void submitRemove(event)}>
          <h2 className="text-balance text-sm font-medium" id="remove-workspace-title">
            {deletingManagedWorkspace ? "Delete" : "Remove"} {selectedWorkspace?.name ?? "workspace"}
            {deletingManagedWorkspace ? "?" : " from Studio?"}
          </h2>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400" id="remove-workspace-description">
            {deletingManagedWorkspace
              ? "This removes the workspace and moves its source files to Studio Trash instead of deleting them permanently."
              : "This only unregisters the workspace. Its source files and folder remain on disk."}
          </p>
          {mutationError ? (
            <p className="mt-3 text-pretty text-xs leading-5 text-red-300" role="alert">
              {mutationError}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              className={secondaryButtonClassName}
              onClick={() => cancelPendingMutation(removeDialog.current)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 disabled:cursor-wait disabled:bg-zinc-700 disabled:text-zinc-500"
              disabled={unregistering}
              type="submit"
            >
              {unregistering
                ? deletingManagedWorkspace
                  ? "Deleting…"
                  : "Removing…"
                : deletingManagedWorkspace
                  ? "Delete workspace"
                  : "Remove workspace"}
            </button>
          </div>
        </form>
      </dialog>
    </main>
  );
}
