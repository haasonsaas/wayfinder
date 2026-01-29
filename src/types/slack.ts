export interface AppMentionEvent {
  channel: string;
  thread_ts?: string;
  ts: string;
  text: string;
  bot_id?: string;
  user?: string;
}

export interface DirectMessageEvent {
  channel: string;
  channel_type?: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  user?: string;
}

export interface AssistantThreadStartedEvent {
  assistant_thread: {
    channel_id: string;
    thread_ts: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasString = (value: unknown): value is string => typeof value === 'string';

export const isAppMentionEvent = (event: unknown): event is AppMentionEvent => {
  if (!isRecord(event)) {
    return false;
  }

  return hasString(event.channel) && hasString(event.ts) && hasString(event.text);
};

export const isDirectMessageEvent = (event: unknown): event is DirectMessageEvent => {
  if (!isRecord(event)) {
    return false;
  }

  return hasString(event.channel) && hasString(event.ts);
};

export const isAssistantThreadStartedEvent = (
  event: unknown,
): event is AssistantThreadStartedEvent => {
  if (!isRecord(event)) {
    return false;
  }

  const assistantThread = event.assistant_thread;

  if (!isRecord(assistantThread)) {
    return false;
  }

  return hasString(assistantThread.channel_id) && hasString(assistantThread.thread_ts);
};
