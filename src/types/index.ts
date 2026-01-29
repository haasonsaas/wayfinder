import { z } from 'zod';
import type { ToolSet } from 'ai';

export interface Integration {
  id: string;
  name: string;
  description: string;
  icon?: string;
  isEnabled: () => boolean;
  getTools: () => ToolSet;
  search?: (query: string) => Promise<SearchResult[]>;
  getAuthConfig?: () => IntegrationAuthConfig;
}

export interface IntegrationAuthConfig {
  getAuthUrl: (baseUrl: string, state: string) => Promise<string> | string;
  handleCallback: (params: URLSearchParams, baseUrl: string) => Promise<void>;
}

export interface SearchResult {
  integrationId: string;
  title: string;
  snippet: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationContext {
  channelId: string;
  threadTs: string;
  userId: string;
  teamId?: string;
}

export interface AdeptConfig {
  defaultProvider: 'openai' | 'anthropic';
  enabledIntegrations: string[];
  maxToolSteps: number;
  redisUrl?: string;
  slack: {
    botToken: string;
    signingSecret: string;
    appToken: string;
  };
  openaiApiKey?: string;
  anthropicApiKey?: string;
  oauthServerEnabled: boolean;
  oauth: {
    port: number;
    baseUrl: string;
    bindHost: string;
    allowRemote: boolean;
    sharedSecret?: string;
  };
  github?: {
    oauthClientId?: string;
    oauthClientSecret?: string;
    oauthRedirectUri?: string;
    defaultOwner?: string;
    defaultRepo?: string;
    baseUrl?: string;
  };
  salesforce?: {
    clientId?: string;
    clientSecret?: string;
    loginUrl?: string;
    redirectUri?: string;
  };
  googleDrive?: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  daytona?: {
    apiKey?: string;
    apiUrl?: string;
    target?: string;
  };
}

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export type Message = z.infer<typeof MessageSchema>;

export interface ToolExecutionUpdate {
  toolName: string;
  status: 'started' | 'completed' | 'error';
  integrationId?: string;
  message?: string;
}
