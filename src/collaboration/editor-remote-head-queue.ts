/** Coalesces lossy WebSocket hints around the authority's single-flight HTTP boundary. */
export class EditorRemoteHeadQueueV1 {
  #pending = false;
  #running = false;
  #generation = 0;

  constructor(
    private readonly canRun: () => boolean,
    private readonly reconcile: () => Promise<boolean>,
  ) {}

  clear() {
    this.#generation += 1;
    this.#pending = false;
  }

  kick() {
    void this.#flush();
  }

  notify() {
    this.#pending = true;
    void this.#flush();
  }

  async #flush() {
    if (this.#running || !this.#pending || !this.canRun()) return;
    const generation = this.#generation;
    this.#running = true;
    try {
      while (this.#pending && this.canRun() && generation === this.#generation) {
        this.#pending = false;
        if (!(await this.reconcile())) break;
      }
    } finally {
      this.#running = false;
      // A new Scene may become ready while the previous Scene's reconcile is
      // still unwinding. Do not strand that new generation's notification.
      if (this.#pending && this.canRun()) void this.#flush();
    }
  }
}
