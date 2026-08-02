import { fastManimSnapshotSceneIdV1 } from "../server/fast-manim-snapshot-contract";
import { importManimScene } from "../src/render-pipeline/source-import";
import type { AccountEditorDocumentFixtureV1 } from "./editor-document-postgres-fixture";

export const ACCOUNT_E2E_BILLING_ORGANIZATION_ID = "billing-team";
export const ACCOUNT_E2E_STUDIO_ORGANIZATION_ID = "editor-team";
export const ACCOUNT_E2E_USER_ID = "2f2e3ea4-88de-4f37-81f7-1860d8f942f8";
export const ACCOUNT_E2E_IDENTITY = Object.freeze({
  issuer: "https://identity.e2e.invalid",
  subject: "account-e2e-user",
});
export const ACCOUNT_E2E_PROJECT_ID = "production-demo";
export const ACCOUNT_E2E_SOURCE_PATH = "scene.py";
export const ACCOUNT_E2E_SCENE_NAME = "ProductionScene";
export const ACCOUNT_E2E_SOURCE = `from manim import *

class ProductionScene(Scene):
    def construct(self):
        equation = MathTex("E", "=", "m", "c^2")
        self.play(Write(equation), run_time=1)
        # poietra:anchor 1.000
        self.wait(7)
`;

export const ACCOUNT_E2E_IMPORTED_SCENE = importManimScene(
  ACCOUNT_E2E_SOURCE,
  ACCOUNT_E2E_SOURCE_PATH,
  ACCOUNT_E2E_SCENE_NAME,
);
if (!ACCOUNT_E2E_IMPORTED_SCENE) throw new TypeError("The account E2E Scene fixture could not be imported.");
if (!ACCOUNT_E2E_IMPORTED_SCENE.anchors.some((anchor) => Math.abs(anchor - 1) < 0.0005)) {
  throw new TypeError("The account E2E Scene fixture must expose its one-second authoring anchor.");
}

export const ACCOUNT_EDITOR_DOCUMENT_FIXTURE_V1 = Object.freeze({
  documentSceneId: fastManimSnapshotSceneIdV1(ACCOUNT_E2E_SOURCE_PATH, ACCOUNT_E2E_SCENE_NAME),
  organizationId: ACCOUNT_E2E_STUDIO_ORGANIZATION_ID,
  projectId: ACCOUNT_E2E_PROJECT_ID,
  sceneId: ACCOUNT_E2E_IMPORTED_SCENE.sceneId,
  sourceHash: ACCOUNT_E2E_IMPORTED_SCENE.sourceHash,
  sourcePath: ACCOUNT_E2E_SOURCE_PATH,
  userId: ACCOUNT_E2E_USER_ID,
}) satisfies AccountEditorDocumentFixtureV1;
