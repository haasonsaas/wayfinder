import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

export interface RecordingContext {
  userId?: string;
  channelId?: string;
  threadTs?: string;
}

export interface ToolCallRecord {
  toolName: string;
  integrationId: string;
  input: Record<string, unknown>;
  timestamp: string;
}

export interface RecordingSession {
  id: string;
  userId: string;
  channelId: string;
  threadTs?: string;
  startedAt: string;
  toolCalls: ToolCallRecord[];
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

const shouldSkipTool = (integrationId: string, toolName: string) => {
  if (integrationId === 'tool_registry' || integrationId === 'core') {
    return true;
  }
  return toolName.startsWith('tool_registry_');
};

const redactSensitive = (input: Record<string, unknown>): Record<string, unknown> => {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some((needle) => lower.includes(needle));

    if (isSensitive) {
      output[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      output[key] = value;
    }
  }

  return output;
};

const buildKey = (context: RecordingContext): string | null => {
  if (!context.userId || !context.channelId) {
    return null;
  }
  return [context.channelId, context.userId, context.threadTs].filter(Boolean).join(':');
};

export class ToolRecorder {
  private sessions = new Map<string, RecordingSession>();
  private lastSessions = new Map<string, RecordingSession>();

  startRecording(context: RecordingContext): RecordingSession | null {
    const key = buildKey(context);
    if (!key || !context.userId || !context.channelId) {
      return null;
    }

    if (this.sessions.has(key)) {
      return this.sessions.get(key) ?? null;
    }

    const session: RecordingSession = {
      id: randomUUID(),
      userId: context.userId,
      channelId: context.channelId,
      threadTs: context.threadTs,
      startedAt: new Date().toISOString(),
      toolCalls: [],
    };

    this.sessions.set(key, session);
    logger.info({ sessionId: session.id, userId: context.userId }, '[Recorder] Started');
    return session;
  }

  stopRecording(context: RecordingContext): RecordingSession | null {
    const key = buildKey(context);
    if (!key) {
      return null;
    }

    const session = this.sessions.get(key) ?? null;
    if (session) {
      this.sessions.delete(key);
      this.lastSessions.set(key, session);
      logger.info({ sessionId: session.id, userId: session.userId }, '[Recorder] Stopped');
    }

    return session;
  }

  getRecording(context: RecordingContext): RecordingSession | null {
    const key = buildKey(context);
    if (!key) {
      return null;
    }

    return this.sessions.get(key) ?? null;
  }

  getLastRecording(context: RecordingContext): RecordingSession | null {
    const key = buildKey(context);
    if (!key) {
      return null;
    }

    return this.lastSessions.get(key) ?? null;
  }

  recordToolCall(
    context: RecordingContext,
    toolName: string,
    integrationId: string,
    input: Record<string, unknown>,
  ): void {
    const key = buildKey(context);
    if (!key) {
      return;
    }

    const session = this.sessions.get(key);
    if (!session) {
      return;
    }

    if (shouldSkipTool(integrationId, toolName)) {
      return;
    }

    session.toolCalls.push({
      toolName,
      integrationId,
      input: redactSensitive(input),
      timestamp: new Date().toISOString(),
    });
  }
}

export const toolRecorder = new ToolRecorder();
