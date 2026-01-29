import { slackService } from '../lib/slack.js';
import type { AppMentionEvent } from '../types/slack.js';
import { logger } from '../lib/logger.js';
import { DEFAULT_ERROR_MESSAGE, runAssistantFlow } from './assistant-flow.js';
import type { KnownBlock } from '@slack/web-api';

export async function handleAppMention(event: AppMentionEvent): Promise<void> {
  const { channel, thread_ts, ts, text, bot_id } = event;
  const botUserId = await slackService.getBotUserId();

  // Ignore messages from bots
  if (bot_id) {
    return;
  }

  logger.info({ channel }, '[AppMention] Received mention');

  // Post initial "thinking" message
  const threadTs = thread_ts || ts;
  let thinkingTs: string | undefined;

  try {
    thinkingTs = await slackService.postMessage(channel, '_is thinking..._', threadTs);
  } catch (error) {
    logger.error({ error, channel, threadTs }, '[AppMention] Failed to post thinking message');
  }

  if (!thinkingTs) {
    // Fallback: try to reply without the thinking message
    logger.warn({ channel, threadTs }, '[AppMention] Proceeding without thinking message');
    try {
      const response = await import('../lib/agent.js').then((m) =>
        m.generateResponse(text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim()),
      );
      await slackService.postMessage(channel, response, threadTs);
    } catch (fallbackError) {
      logger.error({ error: fallbackError, channel, threadTs }, '[AppMention] Fallback also failed');
    }
    return;
  }

  const updateStatus = async (status: string) => {
    await slackService.updateMessage(channel, thinkingTs, `_${status}_`);
  };

  const cleanedText = text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();

  const sendResponse = async (responseText: string, blocks?: KnownBlock[]) => {
    if (blocks) {
      await slackService.updateMessage(channel, thinkingTs, responseText, blocks);
      return;
    }
    await slackService.updateMessage(channel, thinkingTs, responseText);
  };

  await runAssistantFlow({
    text: cleanedText,
    threadTs: thread_ts,
    getThreadMessages: thread_ts
      ? () => slackService.getThreadMessages(channel, thread_ts, botUserId)
      : undefined,
    onStatusUpdate: updateStatus,
    sendResponse,
    errorMessage: DEFAULT_ERROR_MESSAGE,
    onError: (error) => logger.error({ error, channel, threadTs }, '[AppMention] Error generating response'),
  });
}
