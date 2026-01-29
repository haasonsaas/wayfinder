import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import { workflowService } from './workflows/service.js';
import { logger } from './logger.js';
import type { Attachment, TriggerType, WorkflowEvent } from './workflows/types.js';

const MAX_BODY_BYTES = 1_000_000;

const sendJson = (res: http.ServerResponse, status: number, payload: Record<string, unknown>) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const readBody = async (req: http.IncomingMessage): Promise<unknown> => {
  return await new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
};

const normalizeAttachments = (value: unknown): Attachment[] | undefined => {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is Attachment => typeof item === 'object' && item !== null);
  }
  return undefined;
};

const resolveType = (override: TriggerType | undefined, body: Record<string, unknown>): TriggerType => {
  if (override) {
    return override;
  }
  const candidate = body.type;
  if (
    candidate === 'email' ||
    candidate === 'form_submit' ||
    candidate === 'deal_close' ||
    candidate === 'webhook' ||
    candidate === 'schedule'
  ) {
    return candidate;
  }
  return 'webhook';
};

export const handleWebhookRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  typeOverride?: TriggerType,
): Promise<void> => {
  try {
    const body = (await readBody(req)) as Record<string, unknown>;
    const payload = (body.payload as Record<string, unknown> | undefined) ?? body;
    const attachments = normalizeAttachments(body.attachments ?? payload?.attachments);
    const eventType = resolveType(typeOverride, body);

    const event: WorkflowEvent = {
      id: randomUUID(),
      type: eventType,
      payload: payload ?? {},
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
      attachments,
      receivedAt: new Date().toISOString(),
    };

    const matched = await workflowService.handleEvent(event);
    sendJson(res, 200, { status: 'ok', matched: matched.length, eventType });
  } catch (error) {
    logger.error({ error }, '[Webhook] Failed to process request');
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('Payload too large') ? 413 : 400;
    sendJson(res, status, { status: 'error', message });
  }
};
