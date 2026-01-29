import { loadConfig } from '../config.js';
import { RedisJsonStore } from '../redis.js';
import { logger } from '../logger.js';
import type { Workflow } from './types.js';

export interface WorkflowStore {
  get(id: string): Promise<Workflow | null>;
  set(workflow: Workflow): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<Workflow[]>;
}

class MemoryWorkflowStore implements WorkflowStore {
  private workflows = new Map<string, Workflow>();

  async get(id: string): Promise<Workflow | null> {
    return this.workflows.get(id) ?? null;
  }

  async set(workflow: Workflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
  }

  async delete(id: string): Promise<void> {
    this.workflows.delete(id);
  }

  async list(): Promise<Workflow[]> {
    return Array.from(this.workflows.values());
  }
}

class RedisWorkflowStore implements WorkflowStore {
  private store = new RedisJsonStore<Workflow>('adept:workflows');

  async get(id: string): Promise<Workflow | null> {
    return await this.store.get(id);
  }

  async set(workflow: Workflow): Promise<void> {
    await this.store.set(workflow.id, workflow);
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  async list(): Promise<Workflow[]> {
    return await this.store.list();
  }
}

export const createWorkflowStore = (): WorkflowStore => {
  const config = loadConfig();
  if (config.redisUrl) {
    logger.info('[Workflows] Using Redis store');
    return new RedisWorkflowStore();
  }
  logger.warn('[Workflows] Redis not configured, using in-memory store');
  return new MemoryWorkflowStore();
};
