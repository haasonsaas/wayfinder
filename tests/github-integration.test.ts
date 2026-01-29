import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubIntegration } from '../src/integrations/github.js';

vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => ({
    github: {
      oauthClientId: 'test-client-id',
      oauthClientSecret: 'test-client-secret',
      defaultOwner: 'test-owner',
      defaultRepo: 'test-repo',
    },
  }),
}));

vi.mock('../src/lib/token-store.js', () => ({
  tokenStore: {
    getTokens: vi.fn(),
    setTokens: vi.fn(),
    getCachedTokens: vi.fn(),
  },
}));

vi.mock('../src/lib/integration-config.js', () => ({
  getGitHubEnablement: () => ({ enabled: true, missing: [] }),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../src/lib/retry.js', () => ({
  withRetry: vi.fn((fn) => fn()),
}));

describe('GitHubIntegration', () => {
  let integration: GitHubIntegration;

  beforeEach(() => {
    vi.clearAllMocks();
    integration = new GitHubIntegration();
  });

  describe('metadata', () => {
    it('has correct id and name', () => {
      expect(integration.id).toBe('github');
      expect(integration.name).toBe('GitHub');
      expect(integration.description).toContain('GitHub');
    });
  });

  describe('isEnabled', () => {
    it('returns true when enabled', () => {
      expect(integration.isEnabled()).toBe(true);
    });
  });

  describe('getTools', () => {
    it('returns expected tools', () => {
      const tools = integration.getTools();

      expect(tools).toHaveProperty('search_issues');
      expect(tools).toHaveProperty('list_pull_requests');
      expect(tools).toHaveProperty('get_repo_summary');
    });

    it('search_issues has correct schema', () => {
      const tools = integration.getTools();
      const searchTool = tools.search_issues;

      expect(searchTool.description).toContain('Search');
    });

    it('list_pull_requests has correct schema', () => {
      const tools = integration.getTools();
      const prTool = tools.list_pull_requests;

      expect(prTool.description).toContain('pull requests');
    });
  });

  describe('getAuthConfig', () => {
    it('returns auth config with getAuthUrl and handleCallback', () => {
      const authConfig = integration.getAuthConfig();

      expect(authConfig).toHaveProperty('getAuthUrl');
      expect(authConfig).toHaveProperty('handleCallback');
      expect(typeof authConfig.getAuthUrl).toBe('function');
      expect(typeof authConfig.handleCallback).toBe('function');
    });

    it('getAuthUrl generates correct URL', () => {
      const authConfig = integration.getAuthConfig();
      const url = authConfig.getAuthUrl('http://localhost:3999', 'test-state');

      expect(url).toContain('github.com/login/oauth/authorize');
      expect(url).toContain('client_id=test-client-id');
      expect(url).toContain('state=test-state');
      expect(url).toContain('redirect_uri=');
    });
  });
});

describe('GitHubIntegration tool execution', () => {
  let integration: GitHubIntegration;

  beforeEach(() => {
    vi.clearAllMocks();
    integration = new GitHubIntegration();
  });

  it('search_issues returns error when no token', async () => {
    const { tokenStore } = await import('../src/lib/token-store.js');
    vi.mocked(tokenStore.getTokens).mockResolvedValue(null);

    const tools = integration.getTools();
    const result = await tools.search_issues.execute(
      { query: 'bug' },
      { toolCallId: 'test', messages: [], abortSignal: new AbortController().signal },
    );

    expect(result).toHaveProperty('error');
  });
});
