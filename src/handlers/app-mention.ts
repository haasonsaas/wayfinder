import { generateResponse, generateResponseWithHistory } from '../lib/agent.js';
import { slackService } from '../lib/slack.js';
import { handleCommand } from '../lib/commands.js';
import type { AppMentionEvent } from '../types/slack.js';
import { logger } from '../lib/logger.js';

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
  const thinkingTs = await slackService.postMessage(channel, '_is thinking..._', threadTs);

  if (!thinkingTs) {
    logger.error({ channel, threadTs }, '[AppMention] Failed to post thinking message');
    return;
  }

  const updateStatus = async (status: string) => {
    await slackService.updateMessage(channel, thinkingTs, `_${status}_`);
  };

  try {
    let response: string;

    const cleanedText = text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
    const commandResponse = await handleCommand(cleanedText);
    if (commandResponse) {
      await slackService.updateMessage(
        channel,
        thinkingTs,
        commandResponse.text,
        commandResponse.blocks,
      );
      return;
    }

    if (thread_ts) {
      // Get full thread context
      const messages = await slackService.getThreadMessages(channel, thread_ts, botUserId);
      response = await generateResponseWithHistory(messages, updateStatus);
    } else {
      // Single message - remove the mention
      response = await generateResponse(cleanedText, updateStatus);
    }

    await slackService.updateMessage(channel, thinkingTs, response);
  } catch (error) {
    logger.error({ error, channel, threadTs }, '[AppMention] Error generating response');
    await slackService.updateMessage(
      channel,
      thinkingTs,
      '_Sorry, I encountered an error processing your request._',
    );
  }
}
