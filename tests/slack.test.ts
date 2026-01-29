import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackService } from '../src/lib/slack.js';

const mockWebClient = {
  auth: { test: vi.fn() },
  chat: { postMessage: vi.fn(), update: vi.fn() },
  conversations: { replies: vi.fn() },
  assistant: {
    threads: {
      setStatus: vi.fn(),
      setSuggestedPrompts: vi.fn(),
    },
  },
};

vi.mock('@slack/bolt', () => ({
  App: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
  })),
  LogLevel: { INFO: 'info' },
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => mockWebClient),
}));

vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => ({
    slack: {
      botToken: 'xoxb-test',
      signingSecret: 'test-secret',
      appToken: 'xapp-test',
    },
  }),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('SlackService', () => {
  let service: SlackService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SlackService();
    service.init();
  });

  describe('getBotUserId', () => {
    it('returns bot user ID from auth.test', async () => {
      mockWebClient.auth.test.mockResolvedValue({ user_id: 'U123BOT' });

      const userId = await service.getBotUserId();

      expect(userId).toBe('U123BOT');
      expect(mockWebClient.auth.test).toHaveBeenCalled();
    });

    it('throws when user_id is missing', async () => {
      mockWebClient.auth.test.mockResolvedValue({});

      await expect(service.getBotUserId()).rejects.toThrow('Could not get bot user ID');
    });
  });

  describe('getThreadMessages', () => {
    it('returns formatted messages from thread', async () => {
      mockWebClient.conversations.replies.mockResolvedValue({
        messages: [
          { text: '<@U123BOT> hello', bot_id: undefined },
          { text: 'Hi there!', bot_id: 'B123' },
          { text: '<@U123BOT> follow up', bot_id: undefined },
        ],
      });

      const messages = await service.getThreadMessages('C123', '123.456', 'U123BOT');

      expect(messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'follow up' },
      ]);
    });

    it('returns empty array when no messages', async () => {
      mockWebClient.conversations.replies.mockResolvedValue({ messages: undefined });

      const messages = await service.getThreadMessages('C123', '123.456', 'U123BOT');

      expect(messages).toEqual([]);
    });

    it('filters out messages without text', async () => {
      mockWebClient.conversations.replies.mockResolvedValue({
        messages: [
          { text: 'valid' },
          { text: '' },
          { text: undefined },
        ],
      });

      const messages = await service.getThreadMessages('C123', '123.456', 'U123BOT');

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('valid');
    });
  });

  describe('postMessage', () => {
    it('posts message and returns timestamp', async () => {
      mockWebClient.chat.postMessage.mockResolvedValue({ ts: '123.789' });

      const ts = await service.postMessage('C123', 'Hello', '123.456');

      expect(ts).toBe('123.789');
      expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: 'Hello',
        thread_ts: '123.456',
        unfurl_links: false,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello' } }],
      });
    });

    it('uses custom blocks when provided', async () => {
      mockWebClient.chat.postMessage.mockResolvedValue({ ts: '123.789' });
      const customBlocks = [{ type: 'header', text: { type: 'plain_text', text: 'Title' } }];

      await service.postMessage('C123', 'Hello', undefined, customBlocks as any);

      expect(mockWebClient.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ blocks: customBlocks }),
      );
    });

    it('throws and logs on error', async () => {
      const error = new Error('Slack API error');
      mockWebClient.chat.postMessage.mockRejectedValue(error);

      await expect(service.postMessage('C123', 'Hello')).rejects.toThrow('Slack API error');
    });
  });

  describe('updateMessage', () => {
    it('updates message with text and blocks', async () => {
      mockWebClient.chat.update.mockResolvedValue({ ok: true });

      await service.updateMessage('C123', '123.456', 'Updated text');

      expect(mockWebClient.chat.update).toHaveBeenCalledWith({
        channel: 'C123',
        ts: '123.456',
        text: 'Updated text',
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Updated text' } }],
      });
    });

    it('uses custom blocks when provided', async () => {
      mockWebClient.chat.update.mockResolvedValue({ ok: true });
      const customBlocks = [{ type: 'divider' }];

      await service.updateMessage('C123', '123.456', 'text', customBlocks as any);

      expect(mockWebClient.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ blocks: customBlocks }),
      );
    });
  });

  describe('setAssistantStatus', () => {
    it('sets assistant thread status', async () => {
      mockWebClient.assistant.threads.setStatus.mockResolvedValue({ ok: true });

      await service.setAssistantStatus('C123', '123.456', 'thinking...');

      expect(mockWebClient.assistant.threads.setStatus).toHaveBeenCalledWith({
        channel_id: 'C123',
        thread_ts: '123.456',
        status: 'thinking...',
      });
    });

    it('silently handles errors (optional API)', async () => {
      mockWebClient.assistant.threads.setStatus.mockRejectedValue(new Error('Not available'));

      await expect(service.setAssistantStatus('C123', '123.456', 'status')).resolves.toBeUndefined();
    });
  });

  describe('setSuggestedPrompts', () => {
    it('sets suggested prompts', async () => {
      mockWebClient.assistant.threads.setSuggestedPrompts.mockResolvedValue({ ok: true });
      const prompts = [{ title: 'Help', message: 'How can I help?' }];

      await service.setSuggestedPrompts('C123', '123.456', prompts);

      expect(mockWebClient.assistant.threads.setSuggestedPrompts).toHaveBeenCalledWith({
        channel_id: 'C123',
        thread_ts: '123.456',
        prompts,
      });
    });

    it('silently handles errors (optional API)', async () => {
      mockWebClient.assistant.threads.setSuggestedPrompts.mockRejectedValue(new Error('Not available'));

      await expect(service.setSuggestedPrompts('C123', '123.456', [])).resolves.toBeUndefined();
    });
  });
});
