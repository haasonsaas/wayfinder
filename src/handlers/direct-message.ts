import { generateResponse, generateResponseWithHistory } from '../lib/agent.js';
import {
  getThreadMessages,
  postMessage,
  setAssistantStatus,
  setSuggestedPrompts,
  getBotUserId,
} from '../lib/slack.js';
import { handleCommand, getOnboardingResponse } from '../lib/commands.js';
import type { AssistantThreadStartedEvent, DirectMessageEvent } from '../types/slack.js';

export async function handleDirectMessage(event: DirectMessageEvent): Promise<void> {
  const { channel, thread_ts, ts, text, bot_id, subtype } = event;

  // Ignore bot messages and subtypes (like message_changed)
  if (bot_id || subtype) {
    return;
  }

  const botUserId = await getBotUserId();
  const threadTs = thread_ts || ts;

  console.log(`[DM] Received message in ${channel}, thread: ${threadTs}`);

  const updateStatus = async (status: string) => {
    await setAssistantStatus(channel, threadTs, status);
  };

  try {
    await updateStatus('is thinking...');

    let response: string;

    const commandResponse = text ? await handleCommand(text) : null;
    if (commandResponse) {
      await postMessage(channel, commandResponse.text, threadTs, commandResponse.blocks);
      await updateStatus('');
      return;
    }

    if (thread_ts) {
      // Get thread context
      const messages = await getThreadMessages(channel, thread_ts, botUserId);
      response = await generateResponseWithHistory(messages, updateStatus);
    } else {
      // New conversation
      response = await generateResponse(text || '', updateStatus);
    }

    await postMessage(channel, response, threadTs);
    await updateStatus('');
  } catch (error) {
    console.error('[DM] Error generating response:', error);
    await postMessage(channel, '_Sorry, I encountered an error processing your request._', threadTs);
    await updateStatus('');
  }
}

export async function handleAssistantThreadStarted(event: AssistantThreadStartedEvent): Promise<void> {
  const { channel_id, thread_ts } = event.assistant_thread;

  console.log(`[Assistant] Thread started in ${channel_id}`);

  const onboarding = await getOnboardingResponse();

  await postMessage(channel_id, onboarding.text, thread_ts, onboarding.blocks);

  await setSuggestedPrompts(channel_id, thread_ts, [
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
