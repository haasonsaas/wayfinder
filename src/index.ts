import 'dotenv/config';
import { validateEnv, loadConfig } from './lib/config.js';
import { tokenStore } from './lib/token-store.js';
import { startOAuthServer } from './lib/oauth-server.js';
import { registerAllIntegrations } from './integrations/index.js';
import { handleAppMention } from './handlers/app-mention.js';
import { handleDirectMessage, handleAssistantThreadStarted } from './handlers/direct-message.js';
import {
  isAppMentionEvent,
  isAssistantThreadStartedEvent,
  isDirectMessageEvent,
} from './types/slack.js';
import { slackService } from './lib/slack.js';
import { logger } from './lib/logger.js';

const bootstrap = async () => {
  // Validate environment before starting
  validateEnv();

  await tokenStore.load();

  // Register all integrations
  registerAllIntegrations();

  const config = loadConfig();
  logger.info(`[Adept] Starting with provider: ${config.defaultProvider}`);

  const shouldStartOAuth = config.oauthServerEnabled;
  if (shouldStartOAuth) {
    startOAuthServer();
  }

  // Initialize Slack app with Socket Mode
  const app = slackService.init();

  // Handle @mentions in channels
  app.event('app_mention', async ({ event }) => {
    try {
      if (!isAppMentionEvent(event)) {
        return;
      }
      await handleAppMention(event);
    } catch (error) {
      logger.error({ error }, '[Adept] Error handling app_mention');
    }
  });

  // Handle direct messages
  app.event('message', async ({ event }) => {
    if (!isDirectMessageEvent(event)) {
      return;
    }
    const msg = event;

    // Only handle DMs (im) without subtypes and not from bots
    if (msg.channel_type === 'im' && !msg.subtype && !msg.bot_id) {
      try {
        await handleDirectMessage(msg);
      } catch (error) {
        logger.error({ error }, '[Adept] Error handling DM');
      }
    }
  });

  // Handle assistant thread started (for Slack's native assistant feature)
  app.event('assistant_thread_started', async ({ event }) => {
    try {
      if (!isAssistantThreadStartedEvent(event)) {
        return;
      }
      await handleAssistantThreadStarted(event);
    } catch (error) {
      logger.error({ error }, '[Adept] Error handling assistant_thread_started');
    }
  });

  await app.start();
  logger.info('[Adept] Bot is running!');
  logger.info('[Adept] Mention @Adept in any channel or send a DM to get started.');
};

bootstrap().catch((error) => {
  logger.fatal({ error }, '[Adept] Failed to start');
  process.exit(1);
});
