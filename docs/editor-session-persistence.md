# Editor session persistence

Studio keeps unfinished editor work across browser reloads and desktop-shell
restarts. Persistence is deliberately separate from the Manim source and render
session stores: restoring editor state never mutates a `.py` file or resumes a
render process.

## Identity and invalidation

A session is selected by the registered opaque project ID, Scene occurrence ID,
and the SHA-256 source hash returned by the workspace importer. The persisted
record contains the project ID, source hash, and an opaque deterministic digest
of the Scene ID. It does not contain `sourcePath`, the workspace root, or an
absolute filesystem path.

If the same project and Scene digest is opened with a different source hash,
Studio deletes the old entry, starts from the newly imported Scene, and explains
the invalidation in the Inspector. It never tries to replay programs against a
source snapshot that they were not created for.

## Stored and transient state

Version 1 stores applied programs and their Studio authoring metadata, the
current draft and any in-place Applied Program edit, append/replace undo and
redo history, playhead, selection, and these preferences: active insert tool,
position/animation mode, and default motion duration. This keeps replacement
edits reversible after a reload instead of flattening them into appended work.

Restored applied programs must still be valid and truthfully source-lowerable.
A preview-only program may be restored as a draft, but the normal capability
guard continues to block Apply; it cannot enter the persisted applied list.

The following stay in memory only:

- AI prompt text, response, clarification, request error, and loading state
- toolbar content input and transient draft error text
- playback, pointer gestures, clipboard contents, render sessions, and media
- workspace roots and source paths

Keeping those values in memory preserves switching behavior during one SPA
session without putting request or filesystem context into browser storage.

## Schema, migration, and quotas

The storage envelope and every restored editor field are validated with a
closed runtime schema. Malformed JSON, unknown fields, and unsupported older or
newer versions are removed and treated as an empty store. A future version must
add an explicit migration branch before incrementing the version constant;
payload shapes are never guessed.

The store retains at most 20 most-recent sessions, at most 384 KiB per session,
and at most 2 MiB in total. Oldest entries are pruned first. Workspace removal
deletes all of that project's entries, and catalog refresh prunes entries for
projects that are no longer registered. A storage exception or quota failure
falls back to the in-memory store without breaking editing.

`EditorSessionStorageAdapter` is the boundary used by the controller. The web
and current desktop webviews use the browser `localStorage` implementation. A
future native shell can replace the adapter without changing editor state or
schema code.

## Privacy limits

Browser storage is origin-scoped but not encrypted. Canonical programs may
contain authored Text or MathTex content, so a shared browser profile should be
treated as containing local project drafts. Sensitive content should not be
placed there until encrypted, OS-user-scoped storage is available in a selected
desktop shell.
