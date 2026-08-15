import { readFile } from "node:fs/promises";

import { expect, type Page, test } from "@playwright/test";

import type { EditSuggestionRequest, EditSuggestionResult } from "../src/ai/edit-suggestions";
import { openWorkspace } from "./workspace";

const prompt = "Transform this equation to Maxwell's equations, then return to E = mc^2.";

function sequentialTransformResult(request: EditSuggestionRequest): EditSuggestionResult {
  const sourceObjectId = request.selectedObjectIds[0];
  if (!sourceObjectId) throw new Error("The Magic Edit fixture requires one selected MathTex object.");
  const start = request.playhead;
  return {
    kind: "suggestion",
    suggestion: {
      assumptions: ["Keep one continuous MathTex identity."],
      confidence: "medium",
      operation: {
        anchor: { kind: "playhead", referenceSeconds: start },
        execution: "sequence",
        kind: "edit-program",
        operations: [
          {
            easing: "smooth",
            end: start + 1,
            identityAfter: "target-replaces-source",
            kind: "create-transform",
            mismatchMode: "transform",
            sourceObjectId,
            start,
            strategy: "transform-matching-tex",
            target: {
              displayLines: ["Maxwell's equations"],
              kind: "mathtex",
              label: "Maxwell equations",
              texParts: [
                String.raw`\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0}`,
                String.raw`\nabla \cdot \mathbf{B} = 0`,
                String.raw`\nabla \times \mathbf{E} = -\frac{\partial \mathbf{B}}{\partial t}`,
                String.raw`\nabla \times \mathbf{B} = \mu_0\mathbf{J} + \mu_0\varepsilon_0\frac{\partial \mathbf{E}}{\partial t}`,
              ],
            },
          },
          {
            easing: "smooth",
            end: start + 2,
            identityAfter: "target-replaces-source",
            kind: "create-transform",
            mismatchMode: "transform",
            sourceObjectId,
            start: start + 1,
            strategy: "transform-matching-tex",
            target: {
              displayLines: ["E = mc^2"],
              kind: "mathtex",
              label: "Mass-energy equivalence",
              texParts: ["E", "=", "m", "c^2"],
            },
          },
        ],
      },
      provider: "remote",
      summary: "Transform the selected equation twice in sequence.",
    },
  };
}

async function exportedSource(page: Page) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .py" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("The exported source was not persisted by Playwright.");
  return readFile(path, "utf8");
}

async function startCanonicalPreview(page: Page) {
  await page.getByRole("button", { name: "Start preview…" }).click();
  await expect(page.getByRole("alertdialog", { name: "Run workspace Scenes for WebGPU preview?" })).toBeVisible();
  await page.getByRole("button", { name: "Run Scene preview" }).click();
  await expect(page.getByRole("status").filter({ hasText: "WebGPU Preview · Verified" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("textbox", { name: "Describe an edit" })).toBeEnabled();
}

test("previews, applies, and exports two sequential transforms of the same MathTex", async ({ page }) => {
  const requests: EditSuggestionRequest[] = [];
  await page.route("**/api/ai/edit-suggestions", async (route) => {
    const request = route.request().postDataJSON() as EditSuggestionRequest;
    requests.push(request);
    await route.fulfill({ json: sequentialTransformResult(request) });
  });
  await openWorkspace(page);
  await startCanonicalPreview(page);
  const canvas = page.locator("[data-studio-canvas]");
  const basePreviewRevision = await canvas.getAttribute("data-preview-revision");
  expect(basePreviewRevision).toBeTruthy();

  await page.getByRole("textbox", { name: "Describe an edit" }).fill(prompt);
  await page.getByRole("button", { name: "Preview" }).click();

  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Execution" })).toHaveValue("sequence");
  const equationLabels = page.getByRole("textbox", { name: "Equation label" });
  await expect(equationLabels).toHaveCount(2);
  await expect(equationLabels.nth(0)).toHaveValue("Maxwell equations");
  await expect(equationLabels.nth(1)).toHaveValue("Mass-energy equivalence");
  await expect
    .poll(
      async () => {
        const revision = await canvas.getAttribute("data-preview-revision");
        return (await canvas.getAttribute("data-preview-renderer")) === "presented" && revision !== basePreviewRevision
          ? revision
          : null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    clarification: null,
    playhead: 5,
    prompt,
    selectedObjectIds: [expect.any(String)],
  });
  expect(requests[0]?.objects.find((object) => object.id === requests[0]?.selectedObjectIds[0])).toMatchObject({
    type: "MathTex",
  });

  await page.getByRole("button", { name: "Apply program" }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toHaveCount(0);

  const source = await exportedSource(page);
  expect(source.match(/TransformMatchingTex\(/g)).toHaveLength(2);
  const maxwellIndex = source.indexOf(String.raw`MathTex("\\nabla \\cdot \\mathbf{E}`);
  const relativityIndex = source.lastIndexOf('MathTex("E", "=", "m", "c^2")');
  expect(maxwellIndex).toBeGreaterThan(-1);
  expect(relativityIndex).toBeGreaterThan(maxwellIndex);
});

test("continues a clarification choice into a fresh sequential-transform preview", async ({ page }) => {
  const requests: EditSuggestionRequest[] = [];
  await page.route("**/api/ai/edit-suggestions", async (route) => {
    const request = route.request().postDataJSON() as EditSuggestionRequest;
    requests.push(request);
    const result: EditSuggestionResult =
      requests.length === 1
        ? {
            kind: "clarification",
            message: "Should both transformations run as one continuous preview?",
            options: [
              {
                description: "Keep both transformations in one sequential Edit Program.",
                id: "continuous",
                label: "Continuous preview",
              },
              {
                description: "Preview only the first transformation.",
                id: "first-only",
                label: "First transform only",
              },
            ],
          }
        : sequentialTransformResult(request);
    await route.fulfill({ json: result });
  });
  await openWorkspace(page);
  await startCanonicalPreview(page);

  await page.getByRole("textbox", { name: "Describe an edit" }).fill(prompt);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("More detail needed", { exact: true })).toBeVisible();
  await expect(page.locator("#magic-edit-clarification-question")).toHaveText(
    "Should both transformations run as one continuous preview?",
  );

  await page.getByRole("button", { name: /Continuous preview/ }).click();
  await expect(page.getByRole("heading", { name: "Draft program" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Equation label" })).toHaveCount(2);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    clarification: {
      answer: { kind: "option", optionId: "continuous" },
      history: [],
      question: "Should both transformations run as one continuous preview?",
    },
    prompt,
  });
});
