import type { AdeptConfig } from '../types/index.js';
import { logger } from './logger.js';

let cachedConfig: AdeptConfig | null = null;

const resolveDefaultProvider = (): AdeptConfig['defaultProvider'] => {
  const raw = process.env.DEFAULT_AI_PROVIDER?.toLowerCase();
  if (raw === 'openai' || raw === 'anthropic') {
    return raw;
  }

  if (raw) {
    logger.warn(
      { provider: process.env.DEFAULT_AI_PROVIDER },
      '[Config] Unknown DEFAULT_AI_PROVIDER, defaulting to anthropic',
    );
  }

  return 'anthropic';
};

const buildConfig = (): AdeptConfig => {
  const oauthPort = Number(process.env.OAUTH_PORT || 3999);
  const oauthBaseUrl = process.env.OAUTH_BASE_URL || `http://localhost:${oauthPort}`;
  const monitoringSeverity = process.env.MONITORING_MIN_SEVERITY?.toLowerCase();
  const ssoDomains = (process.env.SSO_GOOGLE_ALLOWED_DOMAINS || '')
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean);

  return {
    defaultProvider: resolveDefaultProvider(),
    enabledIntegrations: (process.env.ENABLED_INTEGRATIONS || '').split(',').filter(Boolean),
    maxToolSteps: parseInt(process.env.MAX_TOOL_STEPS || '15', 10),
    redisUrl: process.env.REDIS_URL,
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN || '',
      signingSecret: process.env.SLACK_SIGNING_SECRET || '',
      appToken: process.env.SLACK_APP_TOKEN || '',
    },
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    oauthServerEnabled: process.env.OAUTH_SERVER_ENABLED !== 'false',
    oauth: {
      port: oauthPort,
      baseUrl: oauthBaseUrl,
      bindHost: process.env.OAUTH_BIND_HOST || '127.0.0.1',
      allowRemote: process.env.OAUTH_ALLOW_REMOTE === 'true',
      sharedSecret: process.env.OAUTH_SHARED_SECRET,
    },
    github: {
      oauthClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      oauthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      oauthRedirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI,
      defaultOwner: process.env.GITHUB_DEFAULT_OWNER,
      defaultRepo: process.env.GITHUB_DEFAULT_REPO,
      baseUrl: process.env.GITHUB_BASE_URL,
    },
    salesforce: {
      clientId: process.env.SALESFORCE_CLIENT_ID,
      clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
      loginUrl: process.env.SALESFORCE_LOGIN_URL,
      redirectUri: process.env.SALESFORCE_REDIRECT_URI,
    },
    googleDrive: {
      clientId: process.env.GOOGLE_DRIVE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI,
    },
    daytona: {
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET,
    },
    scim: {
      token: process.env.SCIM_TOKEN,
    },
    sso: {
      google: {
        clientId: process.env.SSO_GOOGLE_CLIENT_ID,
        clientSecret: process.env.SSO_GOOGLE_CLIENT_SECRET,
        redirectUri: process.env.SSO_GOOGLE_REDIRECT_URI,
        allowedDomains: ssoDomains.length > 0 ? ssoDomains : undefined,
      },
    },
    monitoring: {
      alertChannelId: process.env.MONITORING_ALERT_CHANNEL_ID,
      minSeverity:
        monitoringSeverity === 'low' || monitoringSeverity === 'medium' || monitoringSeverity === 'high'
          ? monitoringSeverity
          : undefined,
      minIntervalMinutes: process.env.MONITORING_MIN_INTERVAL_MINUTES
        ? Number(process.env.MONITORING_MIN_INTERVAL_MINUTES)
        : undefined,
      driftAlertsEnabled: process.env.MONITORING_DRIFT_ALERTS_ENABLED
        ? process.env.MONITORING_DRIFT_ALERTS_ENABLED === 'true'
        : undefined,
    },
  };
};

export function loadConfig(): AdeptConfig {
  if (!cachedConfig) {
    cachedConfig = buildConfig();
  }
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}

export function validateEnv(): void {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const config = loadConfig();

  if (!hasOpenAI && !hasAnthropic) {
    throw new Error('At least one AI provider API key is required (OPENAI_API_KEY or ANTHROPIC_API_KEY)');
  }

  if (config.defaultProvider === 'anthropic' && !hasAnthropic && hasOpenAI) {
    logger.warn(
      '[Config] DEFAULT_AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing. Falling back to OpenAI.',
    );
  }

  if (config.defaultProvider === 'openai' && !hasOpenAI && hasAnthropic) {
    logger.warn(
      '[Config] DEFAULT_AI_PROVIDER=openai but OPENAI_API_KEY is missing. Falling back to Anthropic.',
    );
  }
}
