import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { WorkflowEngine } from './engine.js';
import type { Workflow, WorkflowEvent } from './types.js';
import { createWorkflowStore, type WorkflowStore } from './store.js';
import { WorkflowScheduler } from './scheduler.js';

class WorkflowService {
  private store: WorkflowStore;
  private engine: WorkflowEngine;
  private scheduler: WorkflowScheduler;

  constructor() {
    this.store = createWorkflowStore();
    this.engine = new WorkflowEngine();
    this.scheduler = new WorkflowScheduler(this.store, this.engine);
  }

  async startScheduler(): Promise<void> {
    await this.scheduler.start();
  }

  async listWorkflows(): Promise<Workflow[]> {
    return await this.store.list();
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    return await this.store.get(id);
  }

  async createWorkflow(input: Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<Workflow> {
    const now = new Date().toISOString();
    const workflow: Workflow = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.set(workflow);
    await this.scheduler.refreshWorkflow(workflow);
    logger.info({ workflowId: workflow.id }, '[Workflow] Created');
    return workflow;
  }

  async updateWorkflow(id: string, update: Partial<Omit<Workflow, 'id' | 'createdAt'>>): Promise<Workflow | null> {
    const existing = await this.store.get(id);
    if (!existing) {
      return null;
    }

    const workflow: Workflow = {
      ...existing,
      ...update,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await this.store.set(workflow);
    await this.scheduler.refreshWorkflow(workflow);
    logger.info({ workflowId: workflow.id }, '[Workflow] Updated');
    return workflow;
  }

  async deleteWorkflow(id: string): Promise<boolean> {
    const existing = await this.store.get(id);
    if (!existing) {
      return false;
    }
    await this.store.delete(id);
    this.scheduler.stopWorkflow(id);
    logger.info({ workflowId: id }, '[Workflow] Deleted');
    return true;
  }

  async handleEvent(event: WorkflowEvent): Promise<Workflow[]> {
    const workflows = await this.store.list();
    const results = await this.engine.run(workflows, event);
    const matched = results.filter((result) => result.matched);
    logger.info({ matched: matched.length, total: workflows.length }, '[Workflow] Event processed');
    return workflows.filter((workflow) => matched.some((result) => result.workflowId === workflow.id));
  }
}

export const workflowService = new WorkflowService();
