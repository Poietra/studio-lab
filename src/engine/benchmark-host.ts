/**
 * Benchmark host page entry.
 *
 * The benchmark lane serves the production build from a dedicated static
 * server, so specs cannot dynamically import TypeScript sources the way the
 * dev-server smoke lane does. This entry exposes one deliberately small
 * handle: a loader that dynamically imports the built canvas worker client
 * chunk on demand, keeping the module fetch inside any cold-start span a
 * benchmark chooses to measure.
 */
export type PoietraCanvasBenchmarkHostV1 = Readonly<{
  loadCanvasWorkerClient: () => Promise<typeof import("./canvas-worker-client")>;
}>;

const host: PoietraCanvasBenchmarkHostV1 = {
  loadCanvasWorkerClient: () => import("./canvas-worker-client"),
};

(globalThis as { __poietraCanvasBenchmarkHostV1?: PoietraCanvasBenchmarkHostV1 }).__poietraCanvasBenchmarkHostV1 = host;
