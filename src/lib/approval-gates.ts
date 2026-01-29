import { randomUUID } from 'node:crypto';
import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';
import { auditLogger } from './audit-log.js';

export interface ApprovalGate {
  id: string;
  action: string;
  tool: string;
  integrationId: string;
  inputs: Record<string, unknown>;
  requestedBy: string;
  workspaceId?: string;
  sessionId?: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  approvedBy?: string;
  rejectedBy?: string;
  decidedAt?: string;
  expiresAt: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalConfig {
  requireApprovalFor: {
    tools?: string[];
    integrations?: string[];
    methods?: ('POST' | 'PUT' | 'DELETE' | 'PATCH')[];
    patterns?: RegExp[];
  };
  expirationMinutes: number;
  autoApproveFor?: string[];
}

const DEFAULT_EXPIRATION_MINUTES = 30;
const SENSITIVE_TOOLS = [
  'delete',
  'remove',
  'update',
  'create',
  'modify',
  'execute',
  'run',
  'send',
  'transfer',
  'pay',
];

export class ApprovalGateManager {
  private store = new RedisJsonStore<ApprovalGate>('adept:approval_gates');
  private pendingStore = new RedisJsonStore<string[]>('adept:pending_approvals');
  private configStore = new RedisJsonStore<ApprovalConfig>('adept:approval_config');
  private config: ApprovalConfig = {
    requireApprovalFor: {
      methods: ['DELETE'],
    },
    expirationMinutes: DEFAULT_EXPIRATION_MINUTES,
  };

  configure(config: Partial<ApprovalConfig>): void {
    this.config = { ...this.config, ...config };
    void this.configStore.set('config', this.config);
  }

  async loadConfig(): Promise<void> {
    const stored = await this.configStore.get('config');
    if (stored) {
      this.config = stored;
    }
  }

  getConfig(): ApprovalConfig {
    return this.config;
  }

  requiresApproval(tool: string, integrationId: string, inputs: Record<string, unknown>): boolean {
    const { requireApprovalFor } = this.config;

    if (requireApprovalFor.tools?.some((t) => tool.toLowerCase().includes(t.toLowerCase()))) {
      return true;
    }

    if (requireApprovalFor.integrations?.includes(integrationId)) {
      return true;
    }

    if (requireApprovalFor.patterns?.some((p) => p.test(tool))) {
      return true;
    }

    const toolLower = tool.toLowerCase();
    if (SENSITIVE_TOOLS.some((s) => toolLower.includes(s))) {
      const inputStr = JSON.stringify(inputs).toLowerCase();
      if (inputStr.includes('production') || inputStr.includes('prod')) {
        return true;
      }
    }

    return false;
  }

  async requestApproval(
    action: string,
    tool: string,
    integrationId: string,
    inputs: Record<string, unknown>,
    userId: string,
    options: { workspaceId?: string; sessionId?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<ApprovalGate> {
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.expirationMinutes * 60 * 1000);

    const gate: ApprovalGate = {
      id,
      action,
      tool,
      integrationId,
      inputs,
      requestedBy: userId,
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
      requestedAt: now.toISOString(),
      status: 'pending',
      expiresAt: expiresAt.toISOString(),
      metadata: options.metadata,
    };

    await this.store.set(id, gate);

    const pendingKey = options.workspaceId || 'global';
    const pending = (await this.pendingStore.get(pendingKey)) || [];
    pending.push(id);
    await this.pendingStore.set(pendingKey, pending);

    await auditLogger.log({
      userId,
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
      action: 'approval_requested',
      tool,
      integrationId,
      inputs,
      success: true,
      metadata: { gateId: id },
    });

    logger.info({ gateId: id, tool, userId }, '[ApprovalGates] Approval requested');

    return gate;
  }

  async checkApproval(gateId: string): Promise<ApprovalGate | null> {
    const gate = await this.store.get(gateId);
    if (!gate) return null;

    if (gate.status === 'pending' && new Date(gate.expiresAt) < new Date()) {
      gate.status = 'expired';
      await this.store.set(gateId, gate);
      await this.removePending(gateId, gate.workspaceId);
    }

    return gate;
  }

  async approve(gateId: string, approverId: string): Promise<ApprovalGate> {
    const gate = await this.store.get(gateId);
    if (!gate) {
      throw new Error(`Approval gate ${gateId} not found`);
    }

    if (gate.status !== 'pending') {
      throw new Error(`Approval gate ${gateId} is already ${gate.status}`);
    }

    if (new Date(gate.expiresAt) < new Date()) {
      gate.status = 'expired';
      await this.store.set(gateId, gate);
      throw new Error(`Approval gate ${gateId} has expired`);
    }

    gate.status = 'approved';
    gate.approvedBy = approverId;
    gate.decidedAt = new Date().toISOString();

    await this.store.set(gateId, gate);
    await this.removePending(gateId, gate.workspaceId);

    await auditLogger.log({
      userId: approverId,
      workspaceId: gate.workspaceId,
      sessionId: gate.sessionId,
      action: 'approval_granted',
      tool: gate.tool,
      integrationId: gate.integrationId,
      inputs: gate.inputs,
      success: true,
      metadata: { gateId, requestedBy: gate.requestedBy },
    });

    logger.info({ gateId, approverId }, '[ApprovalGates] Approval granted');

    return gate;
  }

  async reject(gateId: string, rejecterId: string, reason?: string): Promise<ApprovalGate> {
    const gate = await this.store.get(gateId);
    if (!gate) {
      throw new Error(`Approval gate ${gateId} not found`);
    }

    if (gate.status !== 'pending') {
      throw new Error(`Approval gate ${gateId} is already ${gate.status}`);
    }

    gate.status = 'rejected';
    gate.rejectedBy = rejecterId;
    gate.decidedAt = new Date().toISOString();
    gate.reason = reason;

    await this.store.set(gateId, gate);
    await this.removePending(gateId, gate.workspaceId);

    await auditLogger.log({
      userId: rejecterId,
      workspaceId: gate.workspaceId,
      sessionId: gate.sessionId,
      action: 'approval_denied',
      tool: gate.tool,
      integrationId: gate.integrationId,
      inputs: gate.inputs,
      success: true,
      metadata: { gateId, requestedBy: gate.requestedBy, reason },
    });

    logger.info({ gateId, rejecterId, reason }, '[ApprovalGates] Approval rejected');

    return gate;
  }

  async listPending(workspaceId?: string): Promise<ApprovalGate[]> {
    const key = workspaceId || 'global';
    const ids = (await this.pendingStore.get(key)) || [];
    const gates: ApprovalGate[] = [];

    for (const id of ids) {
      const gate = await this.checkApproval(id);
      if (gate && gate.status === 'pending') {
        gates.push(gate);
      }
    }

    return gates;
  }

  private async removePending(gateId: string, workspaceId?: string): Promise<void> {
    const key = workspaceId || 'global';
    const pending = (await this.pendingStore.get(key)) || [];
    const updated = pending.filter((id) => id !== gateId);
    await this.pendingStore.set(key, updated);
  }

  async cleanupExpired(): Promise<number> {
    const keys = ['global'];
    let cleaned = 0;

    for (const key of keys) {
      const ids = (await this.pendingStore.get(key)) || [];
      const validIds: string[] = [];

      for (const id of ids) {
        const gate = await this.store.get(id);
        if (gate && gate.status === 'pending' && new Date(gate.expiresAt) >= new Date()) {
          validIds.push(id);
        } else {
          cleaned++;
        }
      }

      await this.pendingStore.set(key, validIds);
    }

    if (cleaned > 0) {
      logger.info({ count: cleaned }, '[ApprovalGates] Cleaned up expired gates');
    }

    return cleaned;
  }

  formatForSlack(gate: ApprovalGate): {
    text: string;
    blocks: Array<Record<string, unknown>>;
  } {
    const inputSummary = Object.entries(gate.inputs)
      .slice(0, 5)
      .map(([k, v]) => `• ${k}: ${JSON.stringify(v).slice(0, 50)}`)
      .join('\n');

    return {
      text: `Approval requested for ${gate.tool}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: 'Approval Required' },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Tool:*\n${gate.tool}` },
            { type: 'mrkdwn', text: `*Integration:*\n${gate.integrationId}` },
            { type: 'mrkdwn', text: `*Requested by:*\n<@${gate.requestedBy}>` },
            { type: 'mrkdwn', text: `*Expires:*\n${new Date(gate.expiresAt).toLocaleString()}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Inputs:*\n${inputSummary}` },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              action_id: `approve_${gate.id}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              action_id: `reject_${gate.id}`,
            },
          ],
        },
      ],
    };
  }
}

export const approvalGates = new ApprovalGateManager();
