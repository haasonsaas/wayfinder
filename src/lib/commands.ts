import { commandRegistry, type CommandResponse } from './command-registry.js';
import { integrationRegistry } from '../integrations/registry.js';
import { loadConfig } from './config.js';
import { tokenStore } from './token-store.js';
import type { KnownBlock } from '@slack/web-api';

const DEFAULT_OAUTH_PORT = 3999;

const getOAuthBaseUrl = () => {
  if (process.env.OAUTH_BASE_URL) {
    return process.env.OAUTH_BASE_URL.replace(/\/$/, '');
  }
  const port = process.env.OAUTH_PORT || DEFAULT_OAUTH_PORT;
  return `http://localhost:${port}`;
};

const getSharedSecretParam = () => {
  if (!process.env.OAUTH_SHARED_SECRET) {
    return '';
  }
  return `?secret=${encodeURIComponent(process.env.OAUTH_SHARED_SECRET)}`;
};

const getOAuthStartUrl = async (integrationId: string): Promise<string | null> => {
  const integration = integrationRegistry.get(integrationId);
  const baseUrl = getOAuthBaseUrl();
  const secret = getSharedSecretParam();

  if (integration?.getAuthConfig) {
    const authConfig = integration.getAuthConfig();
    const state = 'manual_connect'; 
    return await authConfig.getAuthUrl(baseUrl, state);
  }

  // Fallback for legacy
  return `${baseUrl}/oauth/${integrationId}/start${secret}`;
};

const resolveIntegrationId = (input: string): string | null => {
  const value = input.replace(/[^a-z0-9]/gi, '').toLowerCase();
  
  const allIntegrations = integrationRegistry.getAll();
  const match = allIntegrations.find(i => 
    i.id.toLowerCase() === value || 
    i.name.toLowerCase().replace(/[^a-z0-9]/g, '') === value
  );

  if (match) {
    return match.id;
  }

  // Legacy fallback aliases
  if (value.includes('salesforce') || value.includes('sf')) return 'salesforce';
  if (value.includes('github') || value.includes('gh')) return 'github';
  if (value.includes('drive') || value.includes('google')) return 'google_drive';
  
  return null;
};

const buildOnboardingResponse = async (): Promise<CommandResponse> => {
  const baseUrl = getOAuthBaseUrl();
  const oauthEnabled = process.env.OAUTH_SERVER_ENABLED !== 'false';
  
  const integrations = integrationRegistry.getAll();
  const connectLinks = await Promise.all(integrations.map(async (i) => {
      const url = await getOAuthStartUrl(i.id);
      return url ? `• ${i.name}: <${url}|Authorize>` : null;
  }));

  const text =
    "Welcome to Adept. I'm here to help with your connected business tools. " +
    'Ask questions in DMs or mention @Adept in a channel. ' +
    'Use "oauth status" to view connections or "connect <integration>" to authorize.';

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: 'Welcome to Adept',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'I can help answer questions and coordinate work across your connected tools.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Connect integrations*\n${connectLinks.filter(Boolean).join('\n')}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `OAuth server: ${baseUrl} (${oauthEnabled ? 'enabled' : 'disabled'})`,
        },
      ],
    },
  ];

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
      
      const statuses = await Promise.all(integrations.map(async (integration) => {
        const connectUrl = (await getOAuthStartUrl(integration.id)) || undefined;
        const hasTokens = tokenStore.hasTokens(integration.id);
        const enabled = integration.isEnabled();
        
        let connection = hasTokens ? 'connected' : 'not connected';
        let detail: string | undefined;

        if (!hasTokens && enabled) {
            connection = 'enabled (env)';
        } else if (!hasTokens && !enabled) {
            connection = 'not connected';
        } else if (hasTokens) {
            connection = 'connected';
            detail = 'token store';
        }

        return {
          name: integration.name,
          connection,
          detail,
          connectUrl: !hasTokens ? connectUrl : undefined,
          id: integration.id,
          enabled
        };
      }));

      const config = loadConfig();
      const allowlist = new Set(config.enabledIntegrations.map((id) => id.trim()).filter(Boolean));
      const oauthEnabled = process.env.OAUTH_SERVER_ENABLED !== 'false';
      const baseUrl = getOAuthBaseUrl();

      const blocks: KnownBlock[] = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'Integration status',
          },
        },
      ];

      for (const status of statuses) {
        const allowed = allowlist.size === 0 || allowlist.has(status.id);
        const enabledLabel = status.enabled && allowed ? 'enabled' : 'disabled';
        const details = [status.connection, enabledLabel];
        if (status.detail) {
          details.push(status.detail);
        }

        const linkLine = status.connectUrl ? `\nConnect: <${status.connectUrl}|Authorize>` : '';

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${status.name}*\n${details.join(' • ')}${linkLine}`,
          },
        });
      }

      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `OAuth server: ${baseUrl} (${oauthEnabled ? 'enabled' : 'disabled'})`,
          },
        ],
      });

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
    const integrationId = resolveIntegrationId(args);
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

export const handleCommand = async (text: string): Promise<CommandResponse | null> => {
  return await commandRegistry.execute(text);
};

// Kept for backward compatibility if needed, but updated signature
export const getOnboardingResponse = buildOnboardingResponse;
