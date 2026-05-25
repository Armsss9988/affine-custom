import { describe, expect, test, vi } from 'vitest';

import { InMemoryJobQueue } from './in-memory-queue';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('InMemoryJobQueue', () => {
  test('runs queued jobs in order with concurrency 1', async () => {
    const queue = new InMemoryJobQueue(1);
    const first = deferred();
    const executionOrder: string[] = [];

    queue.setExecutor(async jobId => {
      executionOrder.push(`start:${jobId}`);
      if (jobId === 'job-1') {
        await first.promise;
      }
      executionOrder.push(`finish:${jobId}`);
    });

    queue.enqueue('job-1');
    queue.enqueue('job-2');

    await vi.waitFor(() => {
      expect(executionOrder).toEqual(['start:job-1']);
    });

    first.resolve();

    await vi.waitFor(() => {
      expect(executionOrder).toEqual([
        'start:job-1',
        'finish:job-1',
        'start:job-2',
        'finish:job-2',
      ]);
    });
  });

  test('aborts a running job when cancelled', async () => {
    const queue = new InMemoryJobQueue(1);
    const abortHandler = vi.fn();

    queue.setExecutor(
      (jobId, signal) =>
        new Promise<void>((_, reject) => {
          expect(jobId).toBe('job-1');
          signal.addEventListener(
            'abort',
            () => {
              abortHandler();
              reject(new Error('cancelled'));
            },
            { once: true }
          );
        })
    );

    queue.enqueue('job-1');

    await vi.waitFor(() => {
      expect(queue.getRunningIds()).toEqual(['job-1']);
    });

    queue.cancel('job-1');

    await vi.waitFor(() => {
      expect(abortHandler).toHaveBeenCalledTimes(1);
      expect(queue.getRunningIds()).toEqual([]);
    });
  });
});
