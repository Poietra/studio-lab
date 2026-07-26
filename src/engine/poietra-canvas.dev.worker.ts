// Dev/test-only canvas worker entry: re-registers the runtime with the
// frame-proof extension injected, taking over from the base registration.
// Only the dev evidence client adapter references this entry, so production
// builds never emit it.
import { createCanvasWorkerEvidenceSupportV1 } from "./canvas-worker-evidence";
import { registerPoietraCanvasWorkerScopeV1 } from "./poietra-canvas.worker";

registerPoietraCanvasWorkerScopeV1({ evidence: createCanvasWorkerEvidenceSupportV1() });
