import { randomUUID } from 'node:crypto';
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';

export interface AuditEntry {
  id: string;
  timestamp: string;
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  action: 'tool_call' | 'tool_result' | 'approval_requested' | 'approval_granted' | 'approval_denied' | 'error';
  tool?: string;
  integrationId?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  duration?: number;
  success: boolean;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditFilters {
  userId?: string;
  workspaceId?: string;
  tool?: string;
  integrationId?: string;
  action?: AuditEntry['action'];
  startDate?: Date;
  endDate?: Date;
  success?: boolean;
  limit?: number;
  offset?: number;
}

const SENSITIVE_KEYS = [
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'private_key',
  'privatekey',
  'access_token',
  'refresh_token',
];

const REDIS_RETENTION_DAYS = 7;
const ARCHIVE_DIR = join(homedir(), '.adept', 'audit_logs');

export class AuditLogger {
  private store = new RedisJsonStore<AuditEntry>('adept:audit_log');
  private indexStore = new RedisJsonStore<string[]>('adept:audit_index');

  async log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<string> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    const sanitizedEntry: AuditEntry = {
      ...entry,
      id,
      timestamp,
      inputs: entry.inputs ? this.redactSensitive(entry.inputs) : undefined,
      outputs: entry.outputs ? this.redactSensitive(entry.outputs) : undefined,
    };

    await this.store.set(id, sanitizedEntry);

    const dateKey = timestamp.split('T')[0];
    const existingIndex = (await this.indexStore.get(dateKey)) || [];
    existingIndex.push(id);
    await this.indexStore.set(dateKey, existingIndex);

    logger.debug({ auditId: id, action: entry.action, tool: entry.tool }, '[Audit] Entry logged');

    return id;
  }

  async logToolCall(
    userId: string,
    tool: string,
    integrationId: string,
    inputs: Record<string, unknown>,
    sessionId?: string,
    workspaceId?: string,
  ): Promise<string> {
    return await this.log({
      userId,
      workspaceId,
      sessionId,
      action: 'tool_call',
      tool,
      integrationId,
      inputs,
      success: true,
    });
  }

  async logToolResult(
    userId: string,
    tool: string,
    integrationId: string,
    outputs: Record<string, unknown>,
    duration: number,
    success: boolean,
    errorMessage?: string,
    sessionId?: string,
    workspaceId?: string,
  ): Promise<string> {
    return await this.log({
      userId,
      workspaceId,
      sessionId,
      action: 'tool_result',
      tool,
      integrationId,
      outputs,
      duration,
      success,
      errorMessage,
    });
  }

  async query(filters: AuditFilters): Promise<AuditEntry[]> {
    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const startDate = filters.startDate || new Date(Date.now() - REDIS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const endDate = filters.endDate || new Date();

    const allIds: string[] = [];
    const current = new Date(startDate);
    
    while (current <= endDate) {
      const dateKey = current.toISOString().split('T')[0];
      const dayIds = (await this.indexStore.get(dateKey)) || [];
      allIds.push(...dayIds);
      current.setDate(current.getDate() + 1);
    }

    const entries: AuditEntry[] = [];
    
    for (const id of allIds.slice(offset, offset + limit * 2)) {
      const entry = await this.store.get(id);
      if (!entry) continue;

      if (this.matchesFilters(entry, filters)) {
        entries.push(entry);
        if (entries.length >= limit) break;
      }
    }

    return entries;
  }

  private matchesFilters(entry: AuditEntry, filters: AuditFilters): boolean {
    if (filters.userId && entry.userId !== filters.userId) return false;
    if (filters.workspaceId && entry.workspaceId !== filters.workspaceId) return false;
    if (filters.tool && entry.tool !== filters.tool) return false;
    if (filters.integrationId && entry.integrationId !== filters.integrationId) return false;
    if (filters.action && entry.action !== filters.action) return false;
    if (filters.success !== undefined && entry.success !== filters.success) return false;

    const entryDate = new Date(entry.timestamp);
    if (filters.startDate && entryDate < filters.startDate) return false;
    if (filters.endDate && entryDate > filters.endDate) return false;

    return true;
  }

  async export(format: 'json' | 'csv', filters: AuditFilters): Promise<string> {
    const entries = await this.query({ ...filters, limit: 10000 });

    if (format === 'json') {
      return JSON.stringify(entries, null, 2);
    }

    const headers = ['id', 'timestamp', 'userId', 'action', 'tool', 'integrationId', 'success', 'duration', 'errorMessage'];
    const rows = entries.map((e) => [
      e.id,
      e.timestamp,
      e.userId,
      e.action,
      e.tool || '',
      e.integrationId || '',
      String(e.success),
      e.duration?.toString() || '',
      e.errorMessage || '',
    ]);

    return [headers.join(','), ...rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))].join('\n');
  }

  async archive(date: Date): Promise<void> {
    const dateKey = date.toISOString().split('T')[0];
    const ids = (await this.indexStore.get(dateKey)) || [];

    if (ids.length === 0) return;

    await mkdir(ARCHIVE_DIR, { recursive: true });
    const archivePath = join(ARCHIVE_DIR, `${dateKey}.jsonl`);

    for (const id of ids) {
      const entry = await this.store.get(id);
      if (entry) {
        await appendFile(archivePath, JSON.stringify(entry) + '\n');
        await this.store.delete(id);
      }
    }

    await this.indexStore.delete(dateKey);
    logger.info({ date: dateKey, count: ids.length }, '[Audit] Archived entries');
  }

  async cleanupOldEntries(): Promise<void> {
    const cutoff = new Date(Date.now() - REDIS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const current = new Date(cutoff);
    current.setDate(current.getDate() - 30);

    while (current < cutoff) {
      await this.archive(current);
      current.setDate(current.getDate() + 1);
    }
  }

  private redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      const isSensitive = SENSITIVE_KEYS.some((s) => keyLower.includes(s));

      if (isSensitive) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactSensitive(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }

  async getStats(filters: { userId?: string; workspaceId?: string; days?: number } = {}): Promise<{
    totalActions: number;
    byAction: Record<string, number>;
    byTool: Record<string, number>;
    byIntegration: Record<string, number>;
    successRate: number;
    avgDuration: number;
  }> {
    const days = filters.days || 7;
    const entries = await this.query({
      userId: filters.userId,
      workspaceId: filters.workspaceId,
      startDate: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
      limit: 10000,
    });

    const byAction: Record<string, number> = {};
    const byTool: Record<string, number> = {};
    const byIntegration: Record<string, number> = {};
    let successCount = 0;
    let totalDuration = 0;
    let durationCount = 0;

    for (const entry of entries) {
      byAction[entry.action] = (byAction[entry.action] || 0) + 1;
      if (entry.tool) byTool[entry.tool] = (byTool[entry.tool] || 0) + 1;
      if (entry.integrationId) byIntegration[entry.integrationId] = (byIntegration[entry.integrationId] || 0) + 1;
      if (entry.success) successCount++;
      if (entry.duration) {
        totalDuration += entry.duration;
        durationCount++;
      }
    }

    return {
      totalActions: entries.length,
      byAction,
      byTool,
      byIntegration,
      successRate: entries.length > 0 ? successCount / entries.length : 0,
      avgDuration: durationCount > 0 ? totalDuration / durationCount : 0,
    };
  }
}

export const auditLogger = new AuditLogger();
