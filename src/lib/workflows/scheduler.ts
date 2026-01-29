import { CronJob } from 'cron';
import { logger } from '../logger.js';
import type { Workflow, WorkflowEvent } from './types.js';
import type { WorkflowStore } from './store.js';
import { WorkflowEngine } from './engine.js';

export class WorkflowScheduler {
  private jobs = new Map<string, CronJob>();

  constructor(private store: WorkflowStore, private engine: WorkflowEngine) {}

  async start(): Promise<void> {
    const workflows = await this.store.list();
    for (const workflow of workflows) {
      this.scheduleWorkflow(workflow);
    }
  }

  async refreshWorkflow(workflow: Workflow): Promise<void> {
    this.stopWorkflow(workflow.id);
    this.scheduleWorkflow(workflow);
  }

  stopWorkflow(id: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }
    job.stop();
    this.jobs.delete(id);
  }

  private scheduleWorkflow(workflow: Workflow): void {
    if (workflow.trigger.type !== 'schedule' || !workflow.trigger.schedule) {
      return;
    }

    const { cron, timezone } = workflow.trigger.schedule;

    try {
      const job = new CronJob(
        cron,
        async () => {
          const event: WorkflowEvent = {
            id: `schedule-${workflow.id}-${Date.now()}`,
            type: 'schedule',
            payload: { workflowId: workflow.id, workflowName: workflow.name },
            metadata: { scheduledAt: new Date().toISOString() },
            receivedAt: new Date().toISOString(),
          };
          await this.engine.run([workflow], event);
        },
        null,
        false,
        timezone || 'UTC',
      );

      job.start();
      this.jobs.set(workflow.id, job);
      logger.info({ workflowId: workflow.id, cron, timezone }, '[Workflow] Scheduled');
    } catch (error) {
      logger.error({ error, workflowId: workflow.id }, '[Workflow] Failed to schedule');
    }
  }
}
