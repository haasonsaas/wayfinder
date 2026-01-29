import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAppMention } from '../src/handlers/app-mention.js';
import { slackService } from '../src/lib/slack.js';
import * as agent from '../src/lib/agent.js';
import * as commands from '../src/lib/commands.js';

// Mock the dependencies
vi.mock('../src/lib/slack.js', () => ({
  slackService: {
    getBotUserId: vi.fn(),
    postMessage: vi.fn(),
    updateMessage: vi.fn(),
    getThreadMessages: vi.fn(),
  },
}));
vi.mock('../src/lib/agent.js');
vi.mock('../src/lib/commands.js');
vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('handleAppMention', () => {
  const mockEvent = {
    channel: 'C123',
    ts: '123.456',
    text: '<@U123> hello',
    user: 'U456',
    type: 'app_mention',
    client_msg_id: 'abc',
    event_ts: '123.456',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(slackService.getBotUserId).mockResolvedValue('U123');
    vi.mocked(slackService.postMessage).mockResolvedValue('ts-thinking');
    vi.mocked(commands.handleCommand).mockResolvedValue(null);
  });

  it('ignores messages from bots', async () => {
    await handleAppMention({ ...mockEvent, bot_id: 'B123' } as any);
    expect(slackService.postMessage).not.toHaveBeenCalled();
  });

  it('posts thinking message and generates response', async () => {
    vi.mocked(agent.generateResponse).mockResolvedValue('Hello there');
    
    await handleAppMention(mockEvent as any);

    expect(slackService.postMessage).toHaveBeenCalledWith('C123', '_is thinking..._', '123.456');
    expect(agent.generateResponse).toHaveBeenCalledWith('hello', expect.any(Function));
    expect(slackService.updateMessage).toHaveBeenCalledWith('C123', 'ts-thinking', 'Hello there');
  });

  it('handles commands', async () => {
    vi.mocked(commands.handleCommand).mockResolvedValue({
      text: 'Command result',
      blocks: [],
    });

    await handleAppMention(mockEvent as any);

    expect(slackService.updateMessage).toHaveBeenCalledWith('C123', 'ts-thinking', 'Command result', []);
    expect(agent.generateResponse).not.toHaveBeenCalled();
  });

  it('handles errors gracefully', async () => {
    vi.mocked(agent.generateResponse).mockRejectedValue(new Error('Boom'));

    await handleAppMention(mockEvent as any);

    expect(slackService.updateMessage).toHaveBeenCalledWith(
      'C123',
      'ts-thinking',
      '_Sorry, I encountered an error processing your request._'
    );
  });
});
