import type { AdeptConfig } from '../types/index.js';

const resolveDefaultProvider = (): AdeptConfig['defaultProvider'] => {
  const raw = process.env.DEFAULT_AI_PROVIDER?.toLowerCase();
  if (raw === 'openai' || raw === 'anthropic') {
    return raw;
  }

  if (raw) {
    console.warn(`[Config] Unknown DEFAULT_AI_PROVIDER "${process.env.DEFAULT_AI_PROVIDER}", defaulting to anthropic.`);
  }

  return 'anthropic';
};

export function loadConfig(): AdeptConfig {
  return {
    defaultProvider: resolveDefaultProvider(),
    enabledIntegrations: (process.env.ENABLED_INTEGRATIONS || '').split(',').filter(Boolean),
    maxToolSteps: parseInt(process.env.MAX_TOOL_STEPS || '15', 10),
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN || '',
      signingSecret: process.env.SLACK_SIGNING_SECRET || '',
      appToken: process.env.SLACK_APP_TOKEN || '',
    },
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    oauthServerEnabled: process.env.OAUTH_SERVER_ENABLED !== 'false',
  };
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
    console.warn('[Config] DEFAULT_AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is missing. Falling back to OpenAI.');
  }

  if (config.defaultProvider === 'openai' && !hasOpenAI && hasAnthropic) {
    console.warn('[Config] DEFAULT_AI_PROVIDER=openai but OPENAI_API_KEY is missing. Falling back to Anthropic.');
  }
}
