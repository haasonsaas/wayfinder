import type { ToolExecutionOptions } from 'ai';
import { integrationRegistry } from '../../integrations/registry.js';
import { slackService } from '../slack.js';
import { logger } from '../logger.js';
import type {
  Attachment,
  Condition,
  ConditionGroup,
  ToolRef,
  Workflow,
  WorkflowAction,
  WorkflowEvent,
} from './types.js';

interface WorkflowContext {
  [key: string]: unknown;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
  extracted?: Record<string, unknown>;
  event: WorkflowEvent;
  source?: unknown;
  attachment?: Attachment;
  file?: { content?: unknown; name?: string; contentType?: string };
}

export interface WorkflowRunResult {
  workflowId: string;
  matched: boolean;
  actionsRun: number;
  error?: string;
}

const normalizeValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).toLowerCase();
  }
  return JSON.stringify(value).toLowerCase();
};

const resolvePath = (context: Record<string, unknown>, path: string): unknown => {
  const cleaned = path.replace(/^\$\./, '').replace(/^\./, '');
  if (!cleaned) {
    return undefined;
  }
  const parts = cleaned.split('.').filter(Boolean);
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    const key = /^\d+$/.test(part) ? Number(part) : part;
    current = (current as Record<string, unknown>)[key as keyof Record<string, unknown>];
  }
  return current;
};

const renderTemplateString = (template: string, context: Record<string, unknown>): string => {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_match, path) => {
    const value = resolvePath(context, String(path).trim());
    if (value === null || value === undefined) {
      return '';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
};

const renderTemplate = (value: unknown, context: Record<string, unknown>): unknown => {
  if (typeof value === 'string') {
    return renderTemplateString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderTemplate(item, context));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = renderTemplate(val, context);
    }
    return result;
  }
  return value;
};

const extractText = (payload: Record<string, unknown>): string => {
  const candidates = [payload.subject, payload.body, payload.text, payload.message];
  const parts = candidates.filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (parts.length > 0) {
    return parts.join('\n');
  }
  return JSON.stringify(payload);
};

const extractSender = (payload: Record<string, unknown>): string => {
  const from = payload.from ?? payload.sender;
  if (typeof from === 'string') {
    return from;
  }
  if (from && typeof from === 'object') {
    const fromObj = from as Record<string, unknown>;
    const email = fromObj.email ?? fromObj.address;
    if (typeof email === 'string') {
      return email;
    }
  }
  return '';
};

const evaluateCondition = (condition: Condition, context: Record<string, unknown>): boolean => {
  const value = resolvePath(context, condition.path);
  const normalized = normalizeValue(value);
  const expected = condition.value;

  switch (condition.operator) {
    case 'exists':
      return value !== undefined && value !== null;
    case 'not_exists':
      return value === undefined || value === null;
    case 'contains':
      return normalized.includes(normalizeValue(expected));
    case 'starts_with':
      return normalized.startsWith(normalizeValue(expected));
    case 'ends_with':
      return normalized.endsWith(normalizeValue(expected));
    case 'equals':
      return normalizeValue(expected) === normalized;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const numericValue = Number(value);
      const numericExpected = Number(expected);
      if (Number.isNaN(numericValue) || Number.isNaN(numericExpected)) {
        return false;
      }
      if (condition.operator === 'gt') {
        return numericValue > numericExpected;
      }
      if (condition.operator === 'gte') {
        return numericValue >= numericExpected;
      }
      if (condition.operator === 'lt') {
        return numericValue < numericExpected;
      }
      return numericValue <= numericExpected;
    }
    default:
      return false;
  }
};

const evaluateConditions = (group: ConditionGroup | undefined, context: Record<string, unknown>): boolean => {
  if (!group || group.conditions.length === 0) {
    return true;
  }

  if (group.op === 'all') {
    return group.conditions.every((condition) => evaluateCondition(condition, context));
  }
  return group.conditions.some((condition) => evaluateCondition(condition, context));
};

const evaluateKeywords = (keywords: string[] | undefined, payload: Record<string, unknown>): boolean => {
  if (!keywords || keywords.length === 0) {
    return true;
  }

  const text = normalizeValue(extractText(payload));
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
};

const evaluateSenders = (senders: string[] | undefined, payload: Record<string, unknown>): boolean => {
  if (!senders || senders.length === 0) {
    return true;
  }

  const sender = normalizeValue(extractSender(payload));
  return senders.some((candidate) => sender.includes(candidate.toLowerCase()));
};

const applyExtractors = (
  workflow: Workflow,
  payload: Record<string, unknown>,
  context: WorkflowContext,
): void => {
  const extractors = workflow.trigger.extractors ?? [];
  if (extractors.length === 0) {
    return;
  }

  const extracted: Record<string, unknown> = {};

  for (const extractor of extractors) {
    const sourceText =
      extractor.source === 'subject'
        ? String(payload.subject ?? '')
        : extractor.source === 'body'
          ? String(payload.body ?? '')
          : String(payload.text ?? payload.body ?? '');

    try {
      const regex = new RegExp(extractor.pattern, 'i');
      const match = sourceText.match(regex);
      if (match) {
        extracted[extractor.field] = match[1] ?? match[0];
      }
    } catch (error) {
      logger.warn({ error, field: extractor.field }, '[Workflow] Invalid extractor pattern');
    }
  }

  context.extracted = extracted;
};

const buildContext = (workflow: Workflow, event: WorkflowEvent): WorkflowContext => {
  const context: WorkflowContext = {
    payload: event.payload,
    metadata: event.metadata,
    attachments: event.attachments,
    event,
  };

  if (workflow.trigger.type === 'email') {
    applyExtractors(workflow, event.payload, context);
  }

  return context;
};

const runTool = async (tool: ToolRef, context: WorkflowContext): Promise<unknown> => {
  const integration = integrationRegistry.get(tool.integrationId);
  if (!integration) {
    throw new Error(`Integration not found: ${tool.integrationId}`);
  }

  const tools = integration.getTools();
  const toolDef = tools[tool.toolName];
  if (!toolDef || typeof toolDef.execute !== 'function') {
    throw new Error(`Tool not found: ${tool.integrationId}.${tool.toolName}`);
  }

  const input = tool.input ? (renderTemplate(tool.input, context) as Record<string, unknown>) : {};
  const execute = toolDef.execute as (input: unknown, options?: ToolExecutionOptions) => Promise<unknown>;
  return await execute(input, {} as ToolExecutionOptions);
};

const extractFileContent = (result: unknown, field?: string): unknown => {
  if (field && result && typeof result === 'object') {
    return resolvePath(result as Record<string, unknown>, field);
  }

  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    return (
      record.content ??
      record.data ??
      record.file ??
      record.body ??
      record.buffer ??
      record.bytes
    );
  }
  return undefined;
};

const extractFileName = (result: unknown, field?: string): string | undefined => {
  if (field && result && typeof result === 'object') {
    const value = resolvePath(result as Record<string, unknown>, field);
    return typeof value === 'string' ? value : undefined;
  }

  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    const name = record.name ?? record.filename ?? record.fileName;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
};

const executeAction = async (action: WorkflowAction, context: WorkflowContext): Promise<void> => {
  switch (action.type) {
    case 'slack_message': {
      const channelId = renderTemplateString(action.channelId, context);
      const text = renderTemplateString(action.text, context);
      await slackService.postMessage(channelId, text);
      return;
    }
    case 'integration_tool': {
      await runTool(
        {
          integrationId: action.integrationId,
          toolName: action.toolName,
          input: action.input,
        },
        context,
      );
      return;
    }
    case 'stripe_update': {
      await runTool(
        {
          integrationId: 'stripe',
          toolName: action.toolName,
          input: action.input,
        },
        context,
      );
      return;
    }
    case 'data_sync': {
      const sourceResult = await runTool(action.source, context);
      const nextContext: WorkflowContext = { ...context, source: sourceResult };
      const baseInput = action.target.input
        ? (renderTemplate(action.target.input, nextContext) as Record<string, unknown>)
        : {};
      const mapped: Record<string, unknown> = {};
      if (action.mapping) {
        for (const [key, template] of Object.entries(action.mapping)) {
          mapped[key] = renderTemplateString(template, nextContext);
        }
      }
      await runTool(
        {
          integrationId: action.target.integrationId,
          toolName: action.target.toolName,
          input: { ...baseInput, ...mapped },
        },
        nextContext,
      );
      return;
    }
    case 'file_transfer': {
      const downloadResult = await runTool(action.download, context);
      const fileContent = extractFileContent(downloadResult, action.contentField);
      const fileName = extractFileName(downloadResult, action.nameField);
      const fileContext: WorkflowContext = {
        ...context,
        file: {
          content: fileContent,
          name: fileName,
        },
      };
      const baseInput = action.upload.input
        ? (renderTemplate(action.upload.input, fileContext) as Record<string, unknown>)
        : {};
      if (fileContent !== undefined && baseInput.content === undefined) {
        baseInput.content = fileContent;
      }
      if (fileName && baseInput.filename === undefined && baseInput.name === undefined) {
        baseInput.filename = fileName;
      }
      await runTool(
        {
          integrationId: action.upload.integrationId,
          toolName: action.upload.toolName,
          input: baseInput,
        },
        fileContext,
      );
      return;
    }
    case 'route_attachments': {
      const attachments = context.attachments ?? [];
      for (const attachment of attachments) {
        const attachmentContext: WorkflowContext = { ...context, attachment };
        const input = action.target.input
          ? (renderTemplate(action.target.input, attachmentContext) as Record<string, unknown>)
          : {};
        await runTool(
          {
            integrationId: action.target.integrationId,
            toolName: action.target.toolName,
            input,
          },
          attachmentContext,
        );
      }
      return;
    }
    default:
      return;
  }
};

const shouldRunWorkflow = (workflow: Workflow, event: WorkflowEvent, context: WorkflowContext): boolean => {
  if (!workflow.enabled) {
    return false;
  }

  if (workflow.trigger.type !== event.type) {
    return false;
  }

  if (!evaluateKeywords(workflow.trigger.keywords, event.payload)) {
    return false;
  }

  if (!evaluateSenders(workflow.trigger.senders, event.payload)) {
    return false;
  }

  return evaluateConditions(workflow.trigger.conditions, context);
};

export class WorkflowEngine {
  async run(workflows: Workflow[], event: WorkflowEvent): Promise<WorkflowRunResult[]> {
    const results: WorkflowRunResult[] = [];

    for (const workflow of workflows) {
      const context = buildContext(workflow, event);
      const matched = shouldRunWorkflow(workflow, event, context);

      if (!matched) {
        results.push({ workflowId: workflow.id, matched: false, actionsRun: 0 });
        continue;
      }

      let actionsRun = 0;
      try {
        for (const action of workflow.actions) {
          await executeAction(action, context);
          actionsRun += 1;
        }
        results.push({ workflowId: workflow.id, matched: true, actionsRun });
      } catch (error) {
        logger.error({ error, workflowId: workflow.id }, '[Workflow] Action execution failed');
        results.push({
          workflowId: workflow.id,
          matched: true,
          actionsRun,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }
}
