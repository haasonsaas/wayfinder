import { generateResponse, generateResponseWithHistory } from '../lib/agent.js';
import { slackService } from '../lib/slack.js';
import { handleCommand, getOnboardingResponse } from '../lib/commands.js';
import type { AssistantThreadStartedEvent, DirectMessageEvent } from '../types/slack.js';
import { logger } from '../lib/logger.js';

export async function handleDirectMessage(event: DirectMessageEvent): Promise<void> {
  const { channel, thread_ts, ts, text, bot_id, subtype } = event;

  // Ignore bot messages and subtypes (like message_changed)
  if (bot_id || subtype) {
    return;
  }

  const botUserId = await slackService.getBotUserId();
  const threadTs = thread_ts || ts;

  logger.info({ channel, threadTs }, '[DM] Received message');

  const updateStatus = async (status: string) => {
    await slackService.setAssistantStatus(channel, threadTs, status);
  };

  try {
    await updateStatus('is thinking...');

    let response: string;

    const commandResponse = text ? await handleCommand(text) : null;
    if (commandResponse) {
      await slackService.postMessage(
        channel,
        commandResponse.text,
        threadTs,
        commandResponse.blocks,
      );
      await updateStatus('');
      return;
    }

    if (thread_ts) {
      // Get thread context
      const messages = await slackService.getThreadMessages(channel, thread_ts, botUserId);
      response = await generateResponseWithHistory(messages, updateStatus);
    } else {
      // New conversation
      response = await generateResponse(text || '', updateStatus);
    }

    await slackService.postMessage(channel, response, threadTs);
    await updateStatus('');
  } catch (error) {
    logger.error({ error, channel, threadTs }, '[DM] Error generating response');
    await slackService.postMessage(
      channel,
      '_Sorry, I encountered an error processing your request._',
      threadTs,
    );
    await updateStatus('');
  }
}

export async function handleAssistantThreadStarted(
  event: AssistantThreadStartedEvent,
): Promise<void> {
  const { channel_id, thread_ts } = event.assistant_thread;

  logger.info({ channelId: channel_id, threadTs: thread_ts }, '[Assistant] Thread started');

  const onboarding = await getOnboardingResponse();

  await slackService.postMessage(channel_id, onboarding.text, thread_ts, onboarding.blocks);

  await slackService.setSuggestedPrompts(channel_id, thread_ts, [
    {
      title: 'Prep for a call',
      message: 'Pull a Salesforce briefing on Acme Corp and summarize open opportunities.',
    },
    {
      title: 'Pipeline overview',
      message: "What's the current Salesforce pipeline by stage?",
    },
    {
      title: 'Drive search',
      message: 'Find the latest QBR deck in Google Drive and summarize it.',
    },
    {
      title: 'GitHub issues',
      message: 'Search GitHub for any open P1 issues in the frontend repo.',
    },
  ]);
}
