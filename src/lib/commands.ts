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
import { rateLimiter } from './rate-limiter.js';
import { toolRecorder } from './tool-recorder.js';
import { monitoringStore } from './monitoring-store.js';
import { identityStore } from './identity-store.js';

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

commandRegistry.register({
  name: 'record',
  description: 'Record tool calls into workflows',
  execute: async (args, context) => {
    const trimmed = args.trim();
    const parts = trimmed ? trimmed.split(/\s+/) : [];
    const action = parts[0] ?? 'status';
    const userId = context.userId;
    const channelId = context.channelId;

    if (!userId || !channelId) {
      return { text: 'Recording requires a Slack user and channel context.' };
    }

    if (action === 'start') {
      const session = toolRecorder.startRecording({ userId, channelId, threadTs: context.threadTs });
      if (!session) {
        return { text: 'Unable to start recording.' };
      }
      return { text: `Recording started. Session ${session.id.slice(0, 8)}...` };
    }

    if (action === 'stop') {
      const session = toolRecorder.stopRecording({ userId, channelId, threadTs: context.threadTs });
      if (!session) {
        return { text: 'No active recording to stop.' };
      }
      const lines = session.toolCalls.map(
        (call, index) => `${index + 1}. ${call.toolName} (${call.integrationId})`,
      );
      return {
        text: lines.length > 0
          ? `Recording stopped. ${session.toolCalls.length} tool calls captured:\n${lines.join('\n')}`
          : 'Recording stopped. No tool calls captured.',
      };
    }

    if (action === 'status') {
      const session = toolRecorder.getRecording({ userId, channelId, threadTs: context.threadTs });
      if (!session) {
        return { text: 'No active recording. Use "record start" to begin.' };
      }
      return { text: `Recording active. ${session.toolCalls.length} tool calls captured so far.` };
    }

    if (action === 'save') {
      const trigger = parts[1];
      const remainder = parts.slice(2).join(' ').trim();
      const session = toolRecorder.getLastRecording({ userId, channelId, threadTs: context.threadTs });

      if (!session) {
        return { text: 'No stopped recording found. Use "record stop" first.' };
      }

      if (!trigger) {
        return { text: 'Usage: record save [schedule|webhook] <name> | <cron> | <timezone?>' };
      }

      const actions = session.toolCalls.map((call) => {
        const prefix = `${call.integrationId}_`;
        const toolName = call.toolName.startsWith(prefix) ? call.toolName.slice(prefix.length) : call.toolName;
        return {
          type: 'integration_tool' as const,
          integrationId: call.integrationId,
          toolName,
          input: call.input,
        };
      });

      if (actions.length === 0) {
        return { text: 'Recording had no tool calls. Cannot save workflow.' };
      }

      if (trigger === 'webhook') {
        const name = remainder || `Recorded workflow ${session.id.slice(0, 6)}`;
        const workflow = await workflowService.createWorkflow({
          name,
          enabled: true,
          trigger: { type: 'webhook' },
          actions,
        });
        return { text: `Saved webhook workflow "${workflow.name}" (${workflow.id}).` };
      }

      if (trigger === 'schedule') {
        const [namePart, cronPart, timezonePart] = remainder.split('|').map((part) => part.trim());
        if (!namePart || !cronPart) {
          return { text: 'Usage: record save schedule <name> | <cron> | <timezone?>' };
        }
        const workflow = await workflowService.createWorkflow({
          name: namePart,
          enabled: true,
          trigger: {
            type: 'schedule',
            schedule: {
              cron: cronPart,
              timezone: timezonePart || undefined,
            },
          },
          actions,
        });
        return { text: `Saved schedule workflow "${workflow.name}" (${workflow.id}).` };
      }

      return { text: 'Usage: record save [schedule|webhook] <name> | <cron> | <timezone?>' };
    }

    return { text: 'Usage: record [start|stop|status|save]' };
  },
});

commandRegistry.register({
  name: 'catalog',
  description: 'Browse integrations and tools',
  execute: async (args) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = parts[0] ?? 'integrations';

    if (subcommand === 'integrations') {
      const integrations = integrationRegistry.getAll();
      const lines = integrations.map((integration) =>
        `• ${integration.name} (${integration.id}) — ${integration.description}`,
      );
      return {
        text: lines.length > 0
          ? `Integration catalog (${integrations.length}):\n${lines.join('\n')}`
          : 'No integrations available.',
      };
    }

    if (subcommand === 'search') {
      const query = parts.slice(1).join(' ').trim().toLowerCase();
      if (!query) {
        return { text: 'Usage: catalog search <query>' };
      }
      const results = integrationRegistry
        .getAll()
        .filter((integration) =>
          integration.name.toLowerCase().includes(query) ||
          integration.description.toLowerCase().includes(query),
        );
      if (results.length === 0) {
        return { text: `No integrations found for "${query}".` };
      }
      const lines = results.map((integration) =>
        `• ${integration.name} (${integration.id}) — ${integration.description}`,
      );
      return { text: `Search results (${results.length}):\n${lines.join('\n')}` };
    }

    if (subcommand === 'tools') {
      const integrationId = parts[1];
      const tools = toolRegistry.listTools(integrationId).slice(0, 20);
      if (tools.length === 0) {
        return { text: integrationId ? `No tools found for ${integrationId}.` : 'No tools registered.' };
      }
      const lines = tools.map((tool) => `• ${tool.name} (${tool.integrationId})`);
      return { text: `Tools${integrationId ? ` for ${integrationId}` : ''}:\n${lines.join('\n')}` };
    }

    return { text: 'Usage: catalog [integrations|search|tools] [args]' };
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

commandRegistry.register({
  name: 'monitoring',
  description: 'Configure monitoring alerts',
  execute: async (args, context) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = parts[0] ?? 'status';
    const config = await monitoringStore.getConfig();

    if (subcommand === 'status') {
      return {
        text: [
          '*Monitoring Status*',
          `Enabled: ${config.enabled}`,
          `Alert channel: ${config.alertChannelId ?? 'not set'}`,
          `Min severity: ${config.minSeverity}`,
          `Alert interval: ${config.minIntervalMinutes} min`,
          `Drift alerts: ${config.driftAlertsEnabled}`,
        ].join('\n'),
      };
    }

    if (subcommand === 'enable') {
      const channelId = parts[1] ?? context.channelId;
      if (!channelId) {
        return { text: 'Provide a Slack channel ID to enable monitoring.' };
      }
      const next = { ...config, enabled: true, alertChannelId: channelId };
      await monitoringStore.setConfig(next);
      return { text: `Monitoring enabled. Alerts will post to ${channelId}.` };
    }

    if (subcommand === 'disable') {
      const next = { ...config, enabled: false };
      await monitoringStore.setConfig(next);
      return { text: 'Monitoring disabled.' };
    }

    if (subcommand === 'channel') {
      const channelId = parts[1] ?? context.channelId;
      if (!channelId) {
        return { text: 'Provide a Slack channel ID to set the alert channel.' };
      }
      const next = { ...config, alertChannelId: channelId };
      await monitoringStore.setConfig(next);
      return { text: `Alert channel set to ${channelId}.` };
    }

    if (subcommand === 'severity') {
      const level = parts[1] as 'low' | 'medium' | 'high' | undefined;
      if (!level || !['low', 'medium', 'high'].includes(level)) {
        return { text: 'Usage: monitoring severity [low|medium|high]' };
      }
      const next = { ...config, minSeverity: level };
      await monitoringStore.setConfig(next);
      return { text: `Minimum severity set to ${level}.` };
    }

    if (subcommand === 'interval') {
      const minutes = Number(parts[1]);
      if (!minutes || minutes < 5) {
        return { text: 'Usage: monitoring interval <minutes> (>= 5)' };
      }
      const next = { ...config, minIntervalMinutes: minutes };
      await monitoringStore.setConfig(next);
      return { text: `Alert interval set to ${minutes} minutes.` };
    }

    if (subcommand === 'drift') {
      const mode = parts[1];
      if (!mode || !['on', 'off'].includes(mode)) {
        return { text: 'Usage: monitoring drift [on|off]' };
      }
      const next = { ...config, driftAlertsEnabled: mode === 'on' };
      await monitoringStore.setConfig(next);
      return { text: `Drift alerts ${mode === 'on' ? 'enabled' : 'disabled'}.` };
    }

    return { text: 'Usage: monitoring [status|enable|disable|channel|severity|interval|drift]' };
  },
});

commandRegistry.register({
  name: 'policy',
  description: 'Configure approvals and rate limits',
  execute: async (args) => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const section = parts[0] ?? 'status';

    if (section === 'status') {
      const approvalConfig = approvalGates.getConfig();
      const limitCount = rateLimiter.listLimits().length;
      return {
        text: [
          '*Policy Status*',
          `Approval tools: ${(approvalConfig.requireApprovalFor.tools ?? []).join(', ') || 'none'}`,
          `Approval integrations: ${(approvalConfig.requireApprovalFor.integrations ?? []).join(', ') || 'none'}`,
          `Approval methods: ${(approvalConfig.requireApprovalFor.methods ?? []).join(', ') || 'none'}`,
          `Approval expiry: ${approvalConfig.expirationMinutes} minutes`,
          `Custom rate limits: ${limitCount}`,
        ].join('\n'),
      };
    }

    if (section === 'approvals') {
      const action = parts[1] ?? 'list';
      const approvalConfig = approvalGates.getConfig();
      const requireApprovalFor = { ...approvalConfig.requireApprovalFor };

      if (action === 'list') {
        return {
          text: [
            '*Approval Policy*',
            `Tools: ${(requireApprovalFor.tools ?? []).join(', ') || 'none'}`,
            `Integrations: ${(requireApprovalFor.integrations ?? []).join(', ') || 'none'}`,
            `Methods: ${(requireApprovalFor.methods ?? []).join(', ') || 'none'}`,
            `Expiry: ${approvalConfig.expirationMinutes} minutes`,
          ].join('\n'),
        };
      }

      if (action === 'expire') {
        const minutes = Number(parts[2]);
        if (!minutes || minutes < 5) {
          return { text: 'Usage: policy approvals expire <minutes> (>= 5)' };
        }
        approvalGates.configure({ expirationMinutes: minutes });
        return { text: `Approval expiration set to ${minutes} minutes.` };
      }

      if (action === 'add' || action === 'remove') {
        const target = parts[2];
        const rawValue = parts.slice(3).join(' ').trim();
        if (!target || !rawValue) {
          return { text: 'Usage: policy approvals add|remove [tool|integration|method] <value>' };
        }

        const listKey = target === 'tool' ? 'tools' : target === 'integration' ? 'integrations' : 'methods';
        if (!['tools', 'integrations', 'methods'].includes(listKey)) {
          return { text: 'Usage: policy approvals add|remove [tool|integration|method] <value>' };
        }

        let value = rawValue;
        if (listKey === 'methods') {
          const method = rawValue.toUpperCase();
          if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
            return { text: 'Approval methods must be one of: POST, PUT, DELETE, PATCH.' };
          }
          value = method;
        }

        const existing = new Set((requireApprovalFor[listKey as keyof typeof requireApprovalFor] ?? []) as string[]);
        if (action === 'add') {
          existing.add(value);
        } else {
          existing.delete(value);
        }

        approvalGates.configure({
          requireApprovalFor: {
            ...requireApprovalFor,
            [listKey]: Array.from(existing),
          },
        });

        return { text: `Approval policy updated for ${listKey}: ${Array.from(existing).join(', ') || 'none'}` };
      }

      return { text: 'Usage: policy approvals [list|add|remove|expire]' };
    }

    if (section === 'limits') {
      const action = parts[1] ?? 'list';

      if (action === 'list') {
        const limits = rateLimiter.listLimits();
        if (limits.length === 0) {
          return { text: 'No custom rate limits configured.' };
        }
        const lines = limits.map((limit) =>
          `• ${limit.tool}: ${limit.maxPerMinute}/min, ${limit.maxPerHour}/hr, ${limit.maxPerDay}/day (cooldown ${limit.cooldownSeconds}s)`,
        );
        return { text: `Custom rate limits:\n${lines.join('\n')}` };
      }

      if (action === 'set') {
        const tool = parts[2];
        const minute = Number(parts[3]);
        const hour = Number(parts[4]);
        const day = Number(parts[5]);
        const cooldown = Number(parts[6] ?? '60');

        if (!tool || !minute || !hour || !day) {
          return { text: 'Usage: policy limits set <tool> <perMinute> <perHour> <perDay> [cooldownSeconds]' };
        }

        rateLimiter.setLimit({
          tool,
          maxPerMinute: minute,
          maxPerHour: hour,
          maxPerDay: day,
          cooldownSeconds: cooldown,
        });

        return { text: `Rate limit set for ${tool}.` };
      }

      return { text: 'Usage: policy limits [list|set]' };
    }

    return { text: 'Usage: policy [status|approvals|limits]' };
  },
});

commandRegistry.register({
  name: 'sso',
  description: 'View SSO status',
  execute: async () => {
    const config = loadConfig();
    const google = config.sso?.google;
    const baseUrl = getOAuthBaseUrl();

    return {
      text: [
        '*SSO Status*',
        `Google client configured: ${Boolean(google?.clientId && google?.clientSecret)}`,
        `Redirect URI: ${google?.redirectUri ?? `${baseUrl}/sso/google/callback`}`,
        `Allowed domains: ${google?.allowedDomains?.join(', ') ?? 'not set'}`,
        `Login URL: ${baseUrl}/sso/google/login`,
      ].join('\n'),
    };
  },
});

commandRegistry.register({
  name: 'scim',
  description: 'View SCIM status and directory',
  execute: async (args) => {
    const subcommand = args.trim().split(/\s+/)[0] ?? 'status';
    const config = loadConfig();
    const baseUrl = getOAuthBaseUrl();

    if (subcommand === 'status') {
      return {
        text: [
          '*SCIM Status*',
          `Endpoint: ${baseUrl}/scim/v2`,
          `Token configured: ${Boolean(config.scim?.token)}`,
        ].join('\n'),
      };
    }

    if (subcommand === 'users') {
      const users = await identityStore.listUsers();
      if (users.length === 0) {
        return { text: 'No SCIM users found.' };
      }
      const lines = users.slice(0, 20).map((user) => `• ${user.userName} (${user.active ? 'active' : 'inactive'})`);
      return { text: `SCIM users (${users.length}):\n${lines.join('\n')}` };
    }

    if (subcommand === 'groups') {
      const groups = await identityStore.listGroups();
      if (groups.length === 0) {
        return { text: 'No SCIM groups found.' };
      }
      const lines = groups.slice(0, 20).map((group) => `• ${group.displayName} (${group.members?.length ?? 0} members)`);
      return { text: `SCIM groups (${groups.length}):\n${lines.join('\n')}` };
    }

    return { text: 'Usage: scim [status|users|groups]' };
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
