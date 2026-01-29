import { randomUUID } from 'node:crypto';
import { generateText, stepCountIs, tool } from 'ai';
import type { ToolExecuteFunction, ToolExecutionOptions, ToolSet } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createToolError, isToolErrorResponse } from './errors.js';
import { toolRegistry } from './tool-registry.js';
import { auditLogger } from './audit-log.js';
import { approvalGates } from './approval-gates.js';
import { outcomeMonitor } from './outcome-monitor.js';
import { rateLimiter } from './rate-limiter.js';
import { logger } from './logger.js';

const buildSystemInstructions = () => `You are Adept, an AI assistant for business operations. You help teams work faster by:
- Answering questions using data from connected business systems
- Executing workflows across multiple tools  
- Providing insights without users needing to open separate apps

Guidelines:
- Be concise and direct in your responses
- Always cite your sources when using data from integrations
- If you need to search multiple systems, do so efficiently
- Format responses for Slack (use *bold*, _italic_, bullet points)
- If a tool response includes an "error" field, explain the issue and include any provided "hint" to help the user resolve it
- Current date: ${new Date().toISOString().split('T')[0]}

When asked about a person, company, or deal:
1. Search across all relevant connected systems
2. Synthesize information into a comprehensive briefing
3. Highlight the most relevant details for the user's context

You have access to tools from connected integrations. Use them proactively to gather context.`;

const formatToolNames = (toolNames: string[]): string | null => {
  const unique = Array.from(
    new Set(toolNames.map((toolName) => toolName.replace(/_/g, ' ')).filter(Boolean)),
  );
  if (unique.length === 0) {
    return null;
  }
  return unique.length === 1 ? unique[0] : unique.join(', ');
};

const updateToolStatus = async (
  toolCalls: Array<{ toolName: string }> | undefined,
  toolResults: Array<{ toolName: string; result?: unknown }> | undefined,
  onStatusUpdate?: (status: string) => Promise<void>,
): Promise<void> => {
  if (!onStatusUpdate) {
    return;
  }

  if (toolCalls && toolCalls.length > 0) {
    const toolLabel = formatToolNames(toolCalls.map((toolCall) => toolCall.toolName));
    if (toolLabel) {
      await onStatusUpdate(`Using ${toolLabel}...`);
    }
  }

  if (toolResults && toolResults.length > 0) {
    const errorTools = toolResults
      .filter((toolResult) => {
        const candidate = toolResult as { result?: unknown };
        return isToolErrorResponse(candidate.result);
      })
      .map((toolResult) => toolResult.toolName);

    const errorLabel = formatToolNames(errorTools);
    if (errorLabel) {
      await onStatusUpdate(`Tool error in ${errorLabel}.`);
    }
  }
};

const formatSlackText = (text: string) =>
  text.replace(/\[(.*?)\]\((.*?)\)/g, '<$2|$1>').replace(/\*\*/g, '*');

type GenerationInput =
  | { prompt: string }
  | { messages: Array<{ role: 'user' | 'assistant'; content: string }> };

export interface AgentContext {
  userId?: string;
  teamId?: string;
  workspaceId?: string;
  channelId?: string;
  threadTs?: string;
}

const generateTextResponse = async (
  input: GenerationInput,
  onStatusUpdate?: (status: string) => Promise<void>,
  context?: AgentContext,
): Promise<string> => {
  const config = loadConfig();
  const model = getModel();
  const requestId = randomUUID();
  const tools = getAllTools(requestId);

  await onStatusUpdate?.('is thinking...');

  const request =
    'prompt' in input
      ? { prompt: input.prompt }
      : { messages: input.messages };

  logger.info({ requestId }, '[Agent] Request started');

  const { text } = await generateText({
    model,
    system: buildSystemInstructions(),
    ...request,
    tools,
    stopWhen: stepCountIs(config.maxToolSteps),
    experimental_context: context,
    onStepFinish: async ({ toolCalls, toolResults }) => {
      await updateToolStatus(toolCalls, toolResults, onStatusUpdate);
    },
  });

  logger.info({ requestId }, '[Agent] Request completed');

  return formatSlackText(text);
};

function getModel() {
  const config = loadConfig();
  const hasAnthropic = !!config.anthropicApiKey;
  const hasOpenAI = !!config.openaiApiKey;

  if (config.defaultProvider === 'anthropic') {
    if (hasAnthropic) {
      return anthropic('claude-opus-4-5');
    }
    if (hasOpenAI) {
      logger.warn(
        '[Adept] DEFAULT_AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing. Falling back to OpenAI.',
      );
      return openai('gpt-4.1');
    }
  }

  if (config.defaultProvider === 'openai') {
    if (hasOpenAI) {
      return openai('gpt-4.1');
    }
    if (hasAnthropic) {
      logger.warn(
        '[Adept] DEFAULT_AI_PROVIDER=openai but OPENAI_API_KEY is missing. Falling back to Anthropic.',
      );
      return anthropic('claude-opus-4-5');
    }
  }

  throw new Error('No AI provider configured');
}

const toRecord = (value: unknown): Record<string, unknown> => {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return { value };
};

const extractInputFields = (schema?: z.ZodSchema): string[] => {
  if (!schema) return [];
  if (schema instanceof z.ZodObject) {
    return Object.keys(schema.shape);
  }
  return [];
};

const resolveContext = (options: ToolExecutionOptions): AgentContext => {
  const ctx = options.experimental_context as AgentContext | undefined;
  return ctx ?? {};
};

const wrapToolExecution = (
  toolName: string,
  toolDef: ToolSet[string],
  requestId: string,
  integrationId: string,
): ToolSet[string] => {
  const execute = toolDef.execute as ToolExecuteFunction<unknown, unknown> | undefined;
  if (typeof execute !== 'function') {
    return toolDef;
  }

  return {
    ...toolDef,
    execute: async (input: unknown, context: ToolExecutionOptions) => {
      const start = Date.now();
      const execContext = resolveContext(context);
      const userId = execContext.userId ?? 'system';
      const workspaceId = execContext.workspaceId ?? execContext.teamId;
      const sessionId = execContext.threadTs;
      const inputs = toRecord(input);

      const rateCheck = await rateLimiter.check(toolName, userId);
      if (!rateCheck.allowed) {
        await auditLogger.logToolResult(
          userId,
          toolName,
          integrationId,
          { error: rateCheck.reason || 'Rate limit exceeded' },
          Date.now() - start,
          false,
          rateCheck.reason,
          sessionId,
          workspaceId,
        );

        return createToolError(integrationId, rateCheck.reason || 'Rate limit exceeded', {
          retryAfterSeconds: rateCheck.retryAfter,
          hint: 'Slow down and try again after the cooldown window.',
        });
      }

      if (approvalGates.requiresApproval(toolName, integrationId, inputs)) {
        const gate = await approvalGates.requestApproval(
          'tool_call',
          toolName,
          integrationId,
          inputs,
          userId,
          { workspaceId, sessionId },
        );

        return createToolError(integrationId, 'Approval required for this action.', {
          hint: `Approval gate ${gate.id.slice(0, 8)} pending. Use "approvals" to review.`,
        });
      }

      await auditLogger.logToolCall(
        userId,
        toolName,
        integrationId,
        inputs,
        sessionId,
        workspaceId,
      );

      try {
        const result = await execute(input, context);
        const duration = Date.now() - start;
        const isError = isToolErrorResponse(result);
        const errorPayload = isError
          ? {
              type: (result as { errorType?: string }).errorType,
              message: (result as { error?: string }).error,
            }
          : undefined;

        await Promise.all([
          toolRegistry.recordUsage(toolName),
          rateLimiter.record(toolName, userId),
          outcomeMonitor.recordOutcome(toolName, integrationId, !isError, duration, errorPayload),
          auditLogger.logToolResult(
            userId,
            toolName,
            integrationId,
            toRecord(result),
            duration,
            !isError,
            isError ? (result as { error?: string }).error : undefined,
            sessionId,
            workspaceId,
          ),
        ]);

        logger.info(
          { requestId, toolName, integrationId, durationMs: duration },
          '[Agent] Tool execution',
        );
        return result;
      } catch (error) {
        const duration = Date.now() - start;
        const message = error instanceof Error ? error.message : String(error);

        await Promise.all([
          toolRegistry.recordUsage(toolName),
          rateLimiter.record(toolName, userId),
          outcomeMonitor.recordOutcome(toolName, integrationId, false, duration, {
            type: error instanceof Error ? error.name : 'error',
            message,
          }),
          auditLogger.logToolResult(
            userId,
            toolName,
            integrationId,
            { error: message },
            duration,
            false,
            message,
            sessionId,
            workspaceId,
          ),
        ]);

        logger.error(
          { requestId, toolName, integrationId, durationMs: duration, error },
          '[Agent] Tool execution failed',
        );
        throw error;
      }
    },
  };
};

function getAllTools(requestId: string): ToolSet {
  const allTools: ToolSet = {};

  const hotTools = toolRegistry.getHotTools();
  for (const [qualifiedName, toolDef] of Object.entries(hotTools)) {
    const metadata = toolRegistry.getToolMetadata(qualifiedName);
    const integrationId = metadata?.integrationId || qualifiedName.split('_')[0];
    allTools[qualifiedName] = wrapToolExecution(
      qualifiedName,
      toolDef,
      requestId,
      integrationId,
    );
  }

  allTools['tool_registry_search'] = wrapToolExecution(
    'tool_registry_search',
    tool({
      description: 'Search available tools in the registry by name or description',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum results'),
      }),
      execute: async ({ query, limit }: { query: string; limit?: number }) => {
        const results = toolRegistry.searchTools(query, limit || 10);
        return results.map((result) => {
          const metadata = toolRegistry.getToolMetadata(result.qualifiedName);
          return {
            ...result,
            inputFields: extractInputFields(metadata?.inputSchema),
          };
        });
      },
    }),
    requestId,
    'tool_registry',
  );

  allTools['tool_registry_execute'] = wrapToolExecution(
    'tool_registry_execute',
    tool({
      description: 'Execute a registered tool by name using deferred loading',
      inputSchema: z.object({
        toolName: z.string().min(1).describe('Qualified tool name to execute'),
        input: z.record(z.unknown()).optional().describe('Tool input payload'),
      }),
      execute: async (
        { toolName, input }: { toolName: string; input?: Record<string, unknown> },
        context: ToolExecutionOptions,
      ) => {
        if (toolName === 'tool_registry_execute' || toolName === 'tool_registry_search') {
          return createToolError('tool_registry', 'Cannot execute registry tools via registry execution.');
        }

        const toolDef = toolRegistry.getTool(toolName);
        if (!toolDef) {
          return createToolError('tool_registry', `Tool "${toolName}" not found`, {
            hint: 'Use tool_registry_search to discover available tools.',
          });
        }

        const metadata = toolRegistry.getToolMetadata(toolName);
        const integrationId = metadata?.integrationId || toolName.split('_')[0];
        const wrappedTool = wrapToolExecution(toolName, toolDef, requestId, integrationId);
        const execute = wrappedTool.execute as ToolExecuteFunction<unknown, unknown> | undefined;

        if (!execute) {
          return createToolError('tool_registry', `Tool "${toolName}" is not executable.`);
        }

        return await execute(input ?? {}, context);
      },
    }),
    requestId,
    'tool_registry',
  );

  // Built-in utility tools
  allTools['get_current_time'] = wrapToolExecution(
    'get_current_time',
    tool({
      description: 'Get the current date and time',
      inputSchema: z.object({
        timezone: z.string().optional().describe('Timezone like "America/New_York"'),
      }),
      execute: async ({ timezone }: { timezone?: string }) => {
        const now = new Date();
        const options: Intl.DateTimeFormatOptions = {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: timezone || 'UTC',
        };
        return { datetime: now.toLocaleString('en-US', options) };
      },
    }),
    requestId,
    'core',
  );

  return allTools;
}

export async function generateResponse(
  prompt: string,
  onStatusUpdate?: (status: string) => Promise<void>,
  context?: AgentContext,
): Promise<string> {
  return await generateTextResponse({ prompt }, onStatusUpdate, context);
}

export async function generateResponseWithHistory(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  onStatusUpdate?: (status: string) => Promise<void>,
  context?: AgentContext,
): Promise<string> {
  return await generateTextResponse(
    {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    },
    onStatusUpdate,
    context,
  );
}
