import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateResponse } from '../src/lib/agent.js';
import * as ai from 'ai';

vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => ({
    defaultProvider: 'openai',
    enabledIntegrations: [],
    maxToolSteps: 5,
    slack: {},
    openaiApiKey: 'test-key',
  }),
}));

vi.mock('../src/integrations/registry.js', () => ({
  integrationRegistry: {
    getEnabled: () => [],
  },
}));

vi.mock('ai', async () => {
  const actual = await vi.importActual('ai');
  return {
    ...actual,
    generateText: vi.fn(),
    openai: vi.fn(),
  };
});

describe('generateResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls generateText with correct parameters', async () => {
    const mockGenerateText = vi.mocked(ai.generateText);
    mockGenerateText.mockResolvedValue({
      text: 'Hello world',
      toolCalls: [],
      toolResults: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      logprobs: [],
    } as any);

    const response = await generateResponse('Hi');

    expect(mockGenerateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Hi',
      system: expect.stringContaining('You are Adept'),
    }));
    expect(response).toBe('Hello world');
  });

  it('converts markdown links to Slack format', async () => {
    const mockGenerateText = vi.mocked(ai.generateText);
    mockGenerateText.mockResolvedValue({
      text: 'Check [this link](https://example.com)',
      toolCalls: [],
      toolResults: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      logprobs: [],
    } as any);

    const response = await generateResponse('Link please');
    expect(response).toBe('Check <https://example.com|this link>');
  });

  it('handles tool status updates', async () => {
    const mockGenerateText = vi.mocked(ai.generateText);
    mockGenerateText.mockImplementation(async ({ onStepFinish }) => {
      // Simulate a tool call
      if (onStepFinish) {
        await onStepFinish({
          toolCalls: [{ toolName: 'test_tool', args: {} }] as any,
          toolResults: [{ toolName: 'test_tool', result: 'ok' }] as any,
          text: '',
          finishReason: 'tool-calls',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
      }
      return {
        text: 'Done',
        toolCalls: [],
        toolResults: [],
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        logprobs: [],
      } as any;
    });

    const onStatusUpdate = vi.fn();
    await generateResponse('Do something', onStatusUpdate);

    expect(onStatusUpdate).toHaveBeenCalledWith('is thinking...');
    expect(onStatusUpdate).toHaveBeenCalledWith('Using test tool...');
  });
});
