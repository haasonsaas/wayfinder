import { commandRegistry, type CommandContext, type CommandResponse } from './command-registry.js';
import { integrationRegistry } from '../integrations/registry.js';
import { loadConfig } from './config.js';
import { tokenStore } from './token-store.js';
import type { IntegrationStatus } from './command-builders.js';
import { buildIntegrationStatusBlocks, buildOnboardingBlocks } from './command-builders.js';
import { buildOAuthStartUrl, buildSharedSecretParam, getOAuthBaseUrl } from './oauth.js';
import { getIntegrationHealth } from './integration-config.js';
import { workflowWizard } from './workflows/wizard.js';
import { workflowService } from './workflows/service.js';
import { toolRegistry } from './tool-registry.js';
import { toolStorage } from './tool-storage.js';
import { auditLogger } from './audit-log.js';
import { outcomeMonitor } from './outcome-monitor.js';
import { approvalGates } from './approval-gates.js';

const getOAuthStartUrl = async (integrationId: string): Promise<string | null> => {
  const integration = integrationRegistry.get(integrationId);
  const baseUrl = getOAuthBaseUrl();

  if (integration?.getAuthConfig) {
    const authConfig = integration.getAuthConfig();
    const state = 'manual_connect';
    return await authConfig.getAuthUrl(baseUrl, state);
  }

  // Fallback for legacy
  const secret = buildSharedSecretParam(loadConfig().oauth.sharedSecret);
  return `${buildOAuthStartUrl(baseUrl, integrationId)}${secret}`;
};

const buildOnboardingResponse = async (): Promise<CommandResponse> => {
  const baseUrl = getOAuthBaseUrl();
  const oauthEnabled = process.env.OAUTH_SERVER_ENABLED !== 'false';
  
  const integrations = integrationRegistry.getAll();
  const connectLinks = await Promise.all(
    integrations.map(async (i) => {
      const url = await getOAuthStartUrl(i.id);
      return url ? `• ${i.name}: <${url}|Authorize>` : null;
    }),
  );

  const text =
    "Welcome to Adept. I'm here to help with your connected business tools. " +
    'Ask questions in DMs or mention @Adept in a channel. ' +
    'Use "oauth status" to view connections or "connect <integration>" to authorize.';
  const blocks = buildOnboardingBlocks(connectLinks, baseUrl, oauthEnabled);

  return { text, blocks };
};

// Register core commands
commandRegistry.register({
  name: 'help',
  description: 'Show onboarding help',
  aliases: ['start', 'onboard', 'onboarding', 'hello', 'hi'],
  execute: async () => await buildOnboardingResponse(),
});

commandRegistry.register({
  name: 'status',
  description: 'Show integration status',
  aliases: ['oauth status', 'integration status', 'integrations'],
  execute: async () => {
    try {
      await tokenStore.load();
      const integrations = integrationRegistry.getAll();
      const config = loadConfig();
      
      const statuses: IntegrationStatus[] = await Promise.all(
        integrations.map(async (integration) => {
          const tokens = tokenStore.getCachedTokens<Record<string, unknown>>(integration.id);
          const health = getIntegrationHealth(integration.id, {
            config,
            env: process.env,
            tokens,
          });
          const enabled = health?.enabled ?? integration.isEnabled();
          const tokenSource = health?.token.source ?? 'none';

          let connection = 'not connected';
          let detail: string | undefined;

          if (tokenSource === 'env') {
            connection = 'enabled (env)';
          } else if (tokenSource === 'store') {
            connection = 'connected';
            detail = 'token store';
          }

          const connectUrl = tokenSource === 'none'
            ? (await getOAuthStartUrl(integration.id)) || undefined
            : undefined;

          return {
            name: integration.name,
            connection,
            detail,
            connectUrl,
            id: integration.id,
            enabled,
            health,
          };
        }),
      );

      const allowlist = new Set(config.enabledIntegrations.map((id) => id.trim()).filter(Boolean));
      const oauthEnabled = process.env.OAUTH_SERVER_ENABLED !== 'false';
      const baseUrl = getOAuthBaseUrl();

      const blocks = buildIntegrationStatusBlocks(statuses, allowlist, baseUrl, oauthEnabled);

      const text = statuses
        .map((status) => `${status.name}: ${status.connection}${status.detail ? ` (${status.detail})` : ''}`)
        .join('\n');

      return { text, blocks };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: `Unable to load integration status: ${message}` };
    }
  },
});

commandRegistry.register({
  name: 'connect',
  description: 'Connect an integration',
  aliases: ['oauth connect', 'oauth start', 'authorize'],
  execute: async (args) => {
    const integrationId = integrationRegistry.resolveId(args);
    if (!integrationId) {
      return { text: 'I could not match that integration. Try: connect salesforce, github, or drive.' };
    }
    
    const connectUrl = await getOAuthStartUrl(integrationId);
    if (!connectUrl) {
      return { text: 'I could not determine an OAuth link for that integration.' };
    }

    const integrationName = integrationRegistry.get(integrationId)?.name ?? integrationId;

    return {
      text: `Authorize ${integrationName} by visiting ${connectUrl}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Authorize *${integrationName}* here: <${connectUrl}|${connectUrl}>`,
          },
        },
      ],
    };
  },
});

commandRegistry.register({
  name: 'workflow',
  description: 'Create and manage workflows',
  aliases: ['workflows'],
  execute: async (args, context) => {
    const trimmed = args.trim();
    if (!trimmed) {
      return (await workflowWizard.handleMessage('workflow', context)) ?? {
        text: 'Type "workflow" to start a new workflow wizard.',
      };
    }

    if (trimmed === 'list') {
      const workflows = await workflowService.listWorkflows();
      if (workflows.length === 0) {
        return { text: 'No workflows found.' };
      }
      const lines = workflows.map((workflow) =>
        `• ${workflow.name} (${workflow.id}) — ${workflow.trigger.type}`,
      );
      return { text: lines.join('\n') };
    }

    if (trimmed.startsWith('delete ')) {
      const id = trimmed.replace('delete', '').trim();
      if (!id) {
        return { text: 'Provide a workflow ID to delete.' };
      }
      const deleted = await workflowService.deleteWorkflow(id);
      return { text: deleted ? `Deleted workflow ${id}.` : `Workflow ${id} not found.` };
    }

    return { text: 'Unknown workflow command. Use "workflow", "workflow list", or "workflow delete <id>".' };
  },
});

commandRegistry.register({
  name: 'schedule',
  description: 'Create and manage schedules',
  aliases: ['schedules'],
  execute: async (args, context) => {
    const trimmed = args.trim();
    if (!trimmed) {
      return (await workflowWizard.handleMessage('schedule', context)) ?? {
        text: 'Type "schedule" to start a new schedule wizard.',
      };
    }

    if (trimmed === 'list') {
      const workflows = await workflowService.listWorkflows();
      const schedules = workflows.filter((workflow) => workflow.trigger.type === 'schedule');
      if (schedules.length === 0) {
        return { text: 'No schedules found.' };
      }
      const lines = schedules.map((workflow) =>
        `• ${workflow.name} (${workflow.id}) — ${workflow.trigger.schedule?.cron ?? 'cron missing'}`,
      );
      return { text: lines.join('\n') };
    }

    if (trimmed.startsWith('delete ')) {
      const id = trimmed.replace('delete', '').trim();
      if (!id) {
        return { text: 'Provide a schedule ID to delete.' };
      }
      const deleted = await workflowService.deleteWorkflow(id);
      return { text: deleted ? `Deleted schedule ${id}.` : `Schedule ${id} not found.` };
    }

    return { text: 'Unknown schedule command. Use "schedule", "schedule list", or "schedule delete <id>".' };
  },
});

// Tool management commands
commandRegistry.register({
  name: 'tools',
  description: 'Manage tools',
  execute: async (args) => {
    const parts = args.trim().split(/\s+/);
    const subcommand = parts[0] || 'list';

    if (subcommand === 'list') {
      const integrationId = parts[1];
      const tools = toolRegistry.listTools(integrationId);
      
      if (tools.length === 0) {
        return { text: integrationId ? `No tools found for ${integrationId}.` : 'No tools registered.' };
      }

      const lines = tools.slice(0, 20).map((t) => 
        `• *${t.name}* (${t.integrationId}) - ${t.description.slice(0, 60)}${t.isHot ? ' [HOT]' : ''}`,
      );
      
      return {
        text: `*Registered Tools* (${tools.length} total)\n${lines.join('\n')}`,
      };
    }

    if (subcommand === 'search') {
      const query = parts.slice(1).join(' ');
      if (!query) {
        return { text: 'Usage: tools search <query>' };
      }

      const results = toolRegistry.searchTools(query, 10);
      if (results.length === 0) {
        return { text: `No tools found matching "${query}".` };
      }

      const lines = results.map((t) =>
        `• *${t.qualifiedName}* - ${t.description.slice(0, 60)}`,
      );

      return { text: `*Search Results for "${query}"*\n${lines.join('\n')}` };
    }

    if (subcommand === 'stats') {
      const stats = toolRegistry.getStats();
      const storageStats = await toolStorage.getStats();

      return {
        text: [
          '*Tool Statistics*',
          `Total tools: ${stats.totalTools}`,
          `Hot tools: ${stats.hotTools}`,
          `Deferred tools: ${stats.deferredTools}`,
          `User-defined tools: ${storageStats.totalTools}`,
          '',
          '*By Integration:*',
          ...Object.entries(stats.byIntegration).map(([id, count]) => `• ${id}: ${count}`),
        ].join('\n'),
      };
    }

    if (subcommand === 'hot') {
      const hotTools = toolRegistry.listTools().filter((t) => t.isHot);
      
      if (hotTools.length === 0) {
        return { text: 'No hot tools currently.' };
      }

      const lines = hotTools.map((t) =>
        `• *${t.name}* (${t.integrationId}) - ${t.usageCount} uses`,
      );

      return { text: `*Hot Tools* (always loaded)\n${lines.join('\n')}` };
    }

    return { text: 'Usage: tools [list|search|stats|hot] [args]' };
  },
});

// Audit and monitoring commands
commandRegistry.register({
  name: 'audit',
  description: 'View audit logs',
  execute: async (args, context) => {
    const parts = args.trim().split(/\s+/);
    const tool = parts[0];
    const days = parseInt(parts[1] || '7', 10);

    const stats = await auditLogger.getStats({
      userId: context.userId,
      days: Math.min(days, 30),
    });

    const lines = [
      `*Audit Summary* (last ${days} days)`,
      `Total actions: ${stats.totalActions}`,
      `Success rate: ${(stats.successRate * 100).toFixed(1)}%`,
      `Avg duration: ${stats.avgDuration.toFixed(0)}ms`,
      '',
      '*By Action:*',
      ...Object.entries(stats.byAction).map(([action, count]) => `• ${action}: ${count}`),
    ];

    if (tool) {
      lines.push('', `*Tool filter: ${tool}*`);
    }

    return { text: lines.join('\n') };
  },
});

commandRegistry.register({
  name: 'metrics',
  description: 'View tool metrics',
  execute: async (args) => {
    const tool = args.trim();

    if (tool) {
      const parts = tool.split('_');
      const integrationId = parts[0];
      const metrics = await outcomeMonitor.getMetrics(tool, integrationId, 'day');
      
      if (!metrics) {
        return { text: `No metrics found for ${tool}.` };
      }

      return {
        text: [
          `*Metrics for ${tool}*`,
          `Total calls: ${metrics.totalCalls}`,
          `Success: ${metrics.successCount} | Failures: ${metrics.failureCount}`,
          `Avg duration: ${metrics.avgDuration.toFixed(0)}ms`,
          `P95 duration: ${metrics.p95Duration.toFixed(0)}ms`,
        ].join('\n'),
      };
    }

    const failing = await outcomeMonitor.getTopFailingTools(5);
    const slow = await outcomeMonitor.getSlowestTools(5);

    const lines = ['*Tool Metrics Overview*', '', '*Top Failing:*'];
    for (const t of failing) {
      lines.push(`• ${t.tool}: ${(t.failureRate * 100).toFixed(1)}% failure rate`);
    }

    lines.push('', '*Slowest:*');
    for (const t of slow) {
      lines.push(`• ${t.tool}: p95 ${t.p95Duration.toFixed(0)}ms`);
    }

    return { text: lines.join('\n') };
  },
});

commandRegistry.register({
  name: 'approvals',
  description: 'View pending approvals',
  execute: async (_, context) => {
    const pending = await approvalGates.listPending(context.teamId);

    if (pending.length === 0) {
      return { text: 'No pending approvals.' };
    }

    const lines = ['*Pending Approvals*', ''];
    for (const gate of pending) {
      lines.push(
        `• *${gate.tool}* requested by <@${gate.requestedBy}>`,
        `  ID: ${gate.id.slice(0, 8)}... | Expires: ${new Date(gate.expiresAt).toLocaleString()}`,
      );
    }

    return { text: lines.join('\n') };
  },
});

export const handleCommand = async (
  text: string,
  context: CommandContext = {},
): Promise<CommandResponse | null> => {
  const wizardResponse = await workflowWizard.handleMessage(text, context);
  if (wizardResponse) {
    return wizardResponse;
  }
  return await commandRegistry.execute(text, context);
};

// Kept for backward compatibility if needed, but updated signature
export const getOnboardingResponse = buildOnboardingResponse;
