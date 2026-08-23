import { useRef } from "react";

import { StudioExportControl, type StudioMp4ExportSourceV1 } from "./studio-export-control";
import type { StudioExportPublicationAvailabilityV1 } from "./studio-export-publication";
import { StudioThumbnailControl } from "./studio-thumbnail-control";

const DIALOG_ID = "studio-export-settings-dialog";
const DIALOG_TITLE_ID = "studio-export-settings-title";
const DIALOG_DESCRIPTION_ID = "studio-export-settings-description";

export function StudioExportSettingsControl({
  disabled = false,
  exportSource,
  generateThumbnail,
  publication,
}: Readonly<{
  disabled?: boolean;
  exportSource: StudioMp4ExportSourceV1 | null;
  generateThumbnail: ((signal?: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>) | null;
  publication: StudioExportPublicationAvailabilityV1;
}>) {
  const dialog = useRef<HTMLDialogElement | null>(null);

  return (
    <>
      <button
        aria-controls={DIALOG_ID}
        aria-haspopup="dialog"
        className="min-h-8 shrink-0 border border-zinc-700 px-2 text-xs font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-wait disabled:text-zinc-600"
        disabled={disabled}
        onClick={() => {
          if (!dialog.current?.open) dialog.current?.showModal();
        }}
        type="button"
      >
        Export settings
      </button>
      <dialog
        aria-describedby={DIALOG_DESCRIPTION_ID}
        aria-labelledby={DIALOG_TITLE_ID}
        className="m-auto max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-xl backdrop:bg-black/70"
        id={DIALOG_ID}
        ref={dialog}
      >
        <section className="p-5">
          <h2 className="text-balance text-base font-semibold" id={DIALOG_TITLE_ID}>
            Export settings
          </h2>
          <p className="mt-2 text-pretty text-xs leading-5 text-zinc-400" id={DIALOG_DESCRIPTION_ID}>
            Configure a local MP4 from the canonical WebGPU preview and manage its published output.
          </p>

          <div className="mt-5">
            <StudioExportControl disabled={disabled} exportSource={exportSource} publication={publication} />
          </div>

          <section aria-labelledby="studio-thumbnail-settings-title" className="mt-5 border-t border-zinc-800 pt-4">
            <h3 className="text-balance text-sm font-medium text-zinc-200" id="studio-thumbnail-settings-title">
              Project thumbnail
            </h3>
            <p className="mt-1 text-pretty text-xs leading-5 text-zinc-500">
              Publish the representative frame from the current canonical preview.
            </p>
            <div className="mt-3">
              <StudioThumbnailControl disabled={disabled} generate={generateThumbnail} publication={publication} />
            </div>
          </section>

          <div className="mt-5 flex justify-end">
            <button
              className="min-h-9 border border-zinc-700 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
              onClick={() => dialog.current?.close()}
              type="button"
            >
              Close
            </button>
          </div>
        </section>
      </dialog>
    </>
  );
}
