import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { Store } from '@toeverything/infra';
import type { AgentJob } from '../domain/agent-job';

export interface AgentJobDBSchema extends DBSchema {
  jobs: {
    key: string;
    value: AgentJob;
    indexes: {
      workspaceId: string;
    };
  };
}

export class AgentJobStore extends Store {
  private dbPromise: Promise<IDBPDatabase<AgentJobDBSchema>> | null = null;

  private getDB(): Promise<IDBPDatabase<AgentJobDBSchema>> {
    if (!this.dbPromise) {
      this.dbPromise = openDB<AgentJobDBSchema>('affine-agent-jobs', 1, {
        upgrade(db) {
          const store = db.createObjectStore('jobs', { keyPath: 'id' });
          store.createIndex('workspaceId', 'workspaceId');
        },
      });
    }
    return this.dbPromise;
  }

  async saveJob(job: AgentJob): Promise<void> {
    try {
      const db = await this.getDB();
      await db.put('jobs', job);
    } catch (error) {
      console.error('[AgentJobStore] Failed to save job:', error);
    }
  }

  async deleteJob(jobId: string): Promise<void> {
    try {
      const db = await this.getDB();
      await db.delete('jobs', jobId);
    } catch (error) {
      console.error('[AgentJobStore] Failed to delete job:', error);
    }
  }

  async listJobs(workspaceId: string): Promise<AgentJob[]> {
    try {
      const db = await this.getDB();
      const tx = db.transaction('jobs', 'readonly');
      const index = tx.store.index('workspaceId');
      const jobs = await index.getAll(workspaceId);
      // Sort newest first
      return jobs.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    } catch (error) {
      console.error('[AgentJobStore] Failed to list jobs:', error);
      return [];
    }
  }

  async clearJobs(workspaceId: string): Promise<void> {
    try {
      const db = await this.getDB();
      const tx = db.transaction('jobs', 'readwrite');
      const index = tx.store.index('workspaceId');
      const keys = await index.getAllKeys(workspaceId);
      for (const key of keys) {
        await tx.store.delete(key);
      }
      await tx.done;
    } catch (error) {
      console.error('[AgentJobStore] Failed to clear jobs:', error);
    }
  }
}
