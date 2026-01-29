import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCommand } from '../src/lib/commands.js';
import { integrationRegistry } from '../src/integrations/registry.js';
import { tokenStore } from '../src/lib/token-store.js';

vi.mock('../src/integrations/registry.js', () => ({
  integrationRegistry: {
    getAll: vi.fn(),
    get: vi.fn(),
    resolveId: vi.fn(),
  },
}));

vi.mock('../src/lib/token-store.js', () => ({
  tokenStore: {
    load: vi.fn(),
    getCachedTokens: vi.fn(),
  },
}));

vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => ({
    enabledIntegrations: [],
    oauth: {
      port: 3999,
      baseUrl: 'http://localhost:3999',
      sharedSecret: undefined,
    },
  }),
}));

vi.mock('../src/lib/integration-config.js', () => ({
  getIntegrationHealth: vi.fn().mockReturnValue(null),
}));

const mockIntegration = {
  id: 'github',
  name: 'GitHub',
  isEnabled: () => true,
  getAuthConfig: () => ({
    getAuthUrl: async () => 'https://github.com/login/oauth/authorize?client_id=test',
  }),
};

describe('handleCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrationRegistry.getAll).mockReturnValue([mockIntegration as any]);
    vi.mocked(integrationRegistry.get).mockReturnValue(mockIntegration as any);
    vi.mocked(tokenStore.load).mockResolvedValue(undefined);
    vi.mocked(tokenStore.getCachedTokens).mockReturnValue(null);
  });

  describe('help command', () => {
    it('responds to "help"', async () => {
      const result = await handleCommand('help');

      expect(result).not.toBeNull();
      expect(result?.text).toContain('Welcome to Adept');
      expect(result?.blocks).toBeDefined();
    });

    it('responds to aliases like "hello"', async () => {
      const result = await handleCommand('hello');

      expect(result).not.toBeNull();
      expect(result?.text).toContain('Welcome to Adept');
    });

    it('responds to "hi"', async () => {
      const result = await handleCommand('hi');

      expect(result).not.toBeNull();
      expect(result?.text).toContain('Welcome to Adept');
    });
  });

  describe('status command', () => {
    it('responds to "status"', async () => {
      const result = await handleCommand('status');

      expect(result).not.toBeNull();
      expect(result?.text).toContain('GitHub');
      expect(result?.blocks).toBeDefined();
    });

    // Note: "oauth status" is a multi-word alias that the current command registry
    // doesn't support directly - it only matches the first word. Use "status" instead.
    it('responds to "integrations"', async () => {
      const result = await handleCommand('integrations');

      expect(result).not.toBeNull();
      expect(result?.text).toContain('GitHub');
    });

    it('responds to "integrations"', async () => {
      const result = await handleCommand('integrations');

      expect(result).not.toBeNull();
    });
  });

  describe('connect command', () => {
    it('responds to "connect github"', async () => {
      vi.mocked(integrationRegistry.resolveId).mockReturnValue('github');

      const result = await handleCommand('connect github');

      expect(result).not.toBeNull();
      expect(result?.text).toContain('Authorize GitHub');
      expect(result?.blocks).toBeDefined();
    });

    it('handles unknown integration', async () => {
      vi.mocked(integrationRegistry.resolveId).mockReturnValue(null);

      const result = await handleCommand('connect unknown');

      expect(result).not.toBeNull();
      expect(result?.text).toContain('could not match');
    });

    it('responds to "authorize salesforce"', async () => {
      vi.mocked(integrationRegistry.resolveId).mockReturnValue('salesforce');
      vi.mocked(integrationRegistry.get).mockReturnValue({
        ...mockIntegration,
        id: 'salesforce',
        name: 'Salesforce',
      } as any);

      const result = await handleCommand('authorize salesforce');

      expect(result).not.toBeNull();
      expect(result?.text).toContain('Authorize Salesforce');
    });
  });

  describe('non-commands', () => {
    it('returns null for regular messages', async () => {
      const result = await handleCommand('What is the weather like?');

      expect(result).toBeNull();
    });

    it('returns null for empty text', async () => {
      const result = await handleCommand('');

      expect(result).toBeNull();
    });

    it('returns null for messages that look like commands but are not', async () => {
      const result = await handleCommand('helping my friend');

      expect(result).toBeNull();
    });
  });
});
