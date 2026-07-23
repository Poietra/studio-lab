import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { openWorkspace } from "./workspace";

async function exportSource(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

test("Magic Edit previews, applies, exports, and undoes scale and delete", async ({ page }) => {
  await page.route("**/api/ai/edit-suggestions", async (route) => {
    const request = route.request().postDataJSON() as {
      objects: Array<{
        editCapabilities: {
          delete: { kind: string };
          scale: { current?: number; kind: string };
        };
        id: string;
      }>;
      playhead: number;
      prompt: string;
      selectedObjectIds: string[];
    };
    const targetObjectIds = request.selectedObjectIds;
    const target = request.objects.find((object) => object.id === targetObjectIds[0]);
    expect(targetObjectIds).toHaveLength(1);
    expect(target?.editCapabilities.delete.kind).toBe("supported");
    expect(target?.editCapabilities.scale).toMatchObject({ current: 1, kind: "supported" });
    const deleting = request.prompt.includes("delete");
    await route.fulfill({
      body: JSON.stringify({
        kind: "suggestion",
        suggestion: {
          assumptions: [],
          confidence: "medium",
          operation: deleting
            ? {
                anchor: { kind: "playhead", referenceSeconds: request.playhead },
                animation: "fade-out",
                end: request.playhead + 0.4,
                kind: "delete-objects",
                start: request.playhead,
                targetObjectIds,
              }
            : {
                anchor: { kind: "playhead", referenceSeconds: request.playhead },
                easing: "smooth",
                end: request.playhead + 1,
                factor: 1.5,
                kind: "scale-objects",
                start: request.playhead,
                targetObjectIds,
              },
          provider: "remote",
          summary: deleting ? "Delete the selected equation." : "Scale the selected equation.",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
  await openWorkspace(page);
  await page.getByRole("button", { name: "Move playhead to source anchor 5.000 seconds" }).click();
  await page.getByRole("checkbox", { name: "Select equation" }).check();
  const equation = page.getByRole("button", { name: "Move equation" });
  const wrapper = page.locator("[data-studio-entity-wrapper]").filter({ has: equation });
  const instruction = page.getByRole("textbox", { name: "Describe an edit" });

  await instruction.fill("Scale the selected equation to 1.5 times its size.");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Relative scale factor" })).toHaveValue("1.5");
  await page.getByRole("slider", { name: "Scene playhead" }).fill("6");
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.5000");
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(await exportSource(page)).toContain("equation.animate.scale(1.5)");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(wrapper).toHaveAttribute("data-studio-entity-scale", "1.0000");

  // Deletion must use the last safe source anchor; the 5s anchor is followed by
  // another equation animation and is intentionally rejected by source lowering.
  await page.getByRole("button", { name: "Move playhead to source anchor 7.000 seconds" }).click();
  await page.getByRole("checkbox", { name: "Select equation" }).check();
  await instruction.fill("delete the selected equation");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await page.getByRole("slider", { name: "Scene playhead" }).fill("7.4");
  await expect(equation).toHaveCount(0);
  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(await exportSource(page)).toContain("FadeOut(equation)");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(equation).toBeVisible();
});
