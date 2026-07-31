import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceLauncher } from "./workspace-launcher";

describe("workspace launcher shell modes", () => {
  it("uses the native folder picker without rendering a raw path field", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceLauncher
        creationMode="native-existing"
        error={null}
        isLoading={false}
        mutation={null}
        mutationError={null}
        onCancelMutation={vi.fn()}
        onClearMutationError={vi.fn()}
        onCreate={vi.fn(async () => false)}
        onOpen={vi.fn()}
        onRename={vi.fn(async () => false)}
        onRetry={vi.fn()}
        onUnregister={vi.fn(async () => false)}
        projects={[]}
      />,
    );

    expect(markup).toContain('<h1 aria-label="Poietra Studio Lab"');
    expect(markup).toContain('alt="" aria-hidden="true"');
    expect(markup).toContain("data-poietra-symbol");
    expect(markup).toContain("Choose folder…");
    expect(markup).not.toContain("Existing folder path");
    expect(markup).not.toContain("/path/to/manim-project");
  });
});
