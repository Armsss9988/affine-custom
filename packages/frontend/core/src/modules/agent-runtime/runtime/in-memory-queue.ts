/**
 * In-memory job queue with configurable concurrency.
 * Processes jobs sequentially (concurrency = 1 by default) to avoid
 * CRDT write conflicts when multiple jobs modify the same workspace.
 */
export class InMemoryJobQueue {
  private readonly concurrency: number;
  private readonly pending: string[] = [];
  private readonly running = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private executor:
    | ((jobId: string, signal: AbortSignal) => Promise<void>)
    | null = null;

  constructor(concurrency = 1) {
    this.concurrency = concurrency;
  }

  /**
   * Sets the function that will be called to execute each job.
   */
  setExecutor(fn: (jobId: string, signal: AbortSignal) => Promise<void>): void {
    this.executor = fn;
  }

  /**
   * Adds a job to the queue. Starts processing immediately if capacity allows.
   */
  enqueue(jobId: string): void {
    if (this.pending.includes(jobId) || this.running.has(jobId)) {
      return; // already queued or running
    }
    this.pending.push(jobId);
    this.processNext();
  }

  /**
   * Cancels a job. If queued, removes it. If running, aborts it.
   */
  cancel(jobId: string): void {
    // Remove from pending
    const idx = this.pending.indexOf(jobId);
    if (idx !== -1) {
      this.pending.splice(idx, 1);
    }

    // Abort if running
    const controller = this.abortControllers.get(jobId);
    if (controller) {
      controller.abort();
    }
  }

  /**
   * Returns true if the job is currently running or queued.
   */
  isActive(jobId: string): boolean {
    return this.running.has(jobId) || this.pending.includes(jobId);
  }

  /**
   * Returns all queued job IDs (not yet started).
   */
  getPendingIds(): string[] {
    return [...this.pending];
  }

  /**
   * Returns all currently running job IDs.
   */
  getRunningIds(): string[] {
    return Array.from(this.running);
  }

  private processNext(): void {
    if (this.running.size >= this.concurrency || this.pending.length === 0) {
      return;
    }

    const jobId = this.pending.shift();
    if (!jobId) return;

    const controller = new AbortController();
    this.abortControllers.set(jobId, controller);
    this.running.add(jobId);

    const execute = this.executor;
    if (!execute) {
      console.error('[InMemoryJobQueue] No executor set');
      this.running.delete(jobId);
      this.abortControllers.delete(jobId);
      return;
    }

    execute(jobId, controller.signal)
      .catch(error => {
        console.error(`[InMemoryJobQueue] Job ${jobId} failed:`, error);
      })
      .finally(() => {
        this.running.delete(jobId);
        this.abortControllers.delete(jobId);
        this.processNext();
      });
  }

  /**
   * Cancels all jobs and clears the queue.
   */
  dispose(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.pending.length = 0;
    this.running.clear();
    this.abortControllers.clear();
  }
}
