import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/web-api';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export class SlackService {
  private app?: App;
  private webClient?: WebClient;

  constructor(private config = loadConfig()) {}

  init(): App {
    this.app = new App({
      token: this.config.slack.botToken,
      signingSecret: this.config.slack.signingSecret,
      appToken: this.config.slack.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.webClient = new WebClient(this.config.slack.botToken);

    return this.app;
  }

  getWebClient(): WebClient {
    if (!this.webClient) {
      this.webClient = new WebClient(this.config.slack.botToken);
    }
    return this.webClient;
  }

  async getBotUserId(): Promise<string> {
    const client = this.getWebClient();
    const { user_id } = await client.auth.test();
    if (!user_id) {
      throw new Error('Could not get bot user ID');
    }
    return user_id;
  }

  async getThreadMessages(
    channelId: string,
    threadTs: string,
    botUserId: string,
  ): Promise<Message[]> {
    const client = this.getWebClient();
    const { messages } = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 50,
    });

    if (!messages) {
      return [];
    }

    return messages
      .filter((msg) => msg.text)
      .map((msg) => {
        const isBot = !!msg.bot_id;
        let content = msg.text || '';

        // Remove bot mention from user messages
        if (!isBot && content.includes(`<@${botUserId}>`)) {
          content = content.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
        }

        return {
          role: isBot ? 'assistant' : 'user',
          content,
        } as Message;
      });
  }

  async postMessage(
    channelId: string,
    text: string,
    threadTs?: string,
    blocks?: KnownBlock[],
  ): Promise<string | undefined> {
    const client = this.getWebClient();
    const resolvedBlocks = blocks ?? [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text,
        },
      },
    ];
    try {
      const result = await client.chat.postMessage({
        channel: channelId,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
        blocks: resolvedBlocks,
      });
      return result.ts;
    } catch (error) {
      logger.error({ error, channelId, threadTs }, 'Failed to post Slack message');
      throw error;
    }
  }

  async updateMessage(
    channelId: string,
    ts: string,
    text: string,
    blocks?: KnownBlock[],
  ): Promise<void> {
    const client = this.getWebClient();
    const resolvedBlocks = blocks ?? [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text,
        },
      },
    ];
    try {
      await client.chat.update({
        channel: channelId,
        ts,
        text,
        blocks: resolvedBlocks,
      });
    } catch (error) {
      logger.error({ error, channelId, ts }, 'Failed to update Slack message');
      throw error;
    }
  }

  async setAssistantStatus(channelId: string, threadTs: string, status: string): Promise<void> {
    const client = this.getWebClient();
    try {
      await client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status,
      });
    } catch (error) {
      // Assistant API might not be available in all contexts
      logger.debug({ error, channelId, threadTs, status }, 'Failed to set assistant status (optional)');
    }
  }

  async setSuggestedPrompts(
    channelId: string,
    threadTs: string,
    prompts: Array<{ title: string; message: string }>,
  ): Promise<void> {
    const client = this.getWebClient();
    try {
      await client.assistant.threads.setSuggestedPrompts({
        channel_id: channelId,
        thread_ts: threadTs,
        prompts,
      });
    } catch (error) {
      // Assistant API might not be available
      logger.debug({ error, channelId, threadTs }, 'Failed to set suggested prompts (optional)');
    }
  }
}

export const slackService = new SlackService();

