import { tool } from 'ai';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { tokenStore } from '../lib/token-store.js';
import { IntegrationAuthError, createToolError, toToolError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import type { SearchResult } from '../types/index.js';

import { loadConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;
const AUTH_HINT = 'Run "oauth status" in Slack to review GitHub connection links.';
const DEFAULT_OAUTH_BASE_URL = 'https://github.com';

interface GitHubStoredTokens extends Record<string, unknown> {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  tokenType?: string;
  scope?: string;
  updatedAt?: string;
}

interface GitHubRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

const resolveRepo = (repoInput?: string) => {
  if (repoInput) {
    const [owner, repo] = repoInput.split('/');
    if (owner && repo) {
      return { owner, repo };
    }
  }

  const config = loadConfig();
  const owner = config.github?.defaultOwner;
  const repo = config.github?.defaultRepo;
  if (owner && repo) {
    return { owner, repo };
  }

  return null;
};

const getOAuthBaseUrl = () => (process.env.GITHUB_OAUTH_BASE_URL || DEFAULT_OAUTH_BASE_URL).replace(/\/$/, '');

const refreshGitHubToken = async (
  refreshToken: string,
  existing?: GitHubStoredTokens,
): Promise<GitHubStoredTokens> => {
  const config = loadConfig();
  const clientId = config.github?.oauthClientId;
  const clientSecret = config.github?.oauthClientSecret;

  if (!clientId || !clientSecret) {
    throw new IntegrationAuthError('GitHub OAuth client credentials are missing.', {
      integrationId: 'github',
      hint: AUTH_HINT,
    });
  }

  const baseUrl = getOAuthBaseUrl();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await withRetry(
    async () => {
      const res = await fetch(`${baseUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        const error = new Error(`GitHub token refresh failed (${res.status}): ${errorBody}`) as Error & {
          status?: number;
          headers?: Headers;
        };
        error.status = res.status;
        error.headers = res.headers;
        throw error;
      }

      return res;
    },
    { integrationId: 'github', operation: 'refresh token' },
  );

  const data = (await response.json()) as GitHubRefreshResponse;

  if (data.error || !data.access_token) {
    throw new IntegrationAuthError(data.error_description || 'GitHub token refresh failed.', {
      integrationId: 'github',
      hint: AUTH_HINT,
    });
  }

  const now = Date.now();
  const expiresAt = data.expires_in ? now + data.expires_in * 1000 : existing?.expiresAt;
  const refreshTokenExpiresAt = data.refresh_token_expires_in
    ? now + data.refresh_token_expires_in * 1000
    : existing?.refreshTokenExpiresAt;

  const updated: GitHubStoredTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt,
    refreshTokenExpiresAt,
    tokenType: data.token_type ?? existing?.tokenType,
    scope: data.scope ?? existing?.scope,
    updatedAt: new Date().toISOString(),
  };

  await tokenStore.setTokens('github', updated);
  return updated;
};

const resolveAccessToken = async (): Promise<string> => {
  const envToken = process.env.GITHUB_OAUTH_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken) {
    return envToken;
  }

  const stored = await tokenStore.getTokens<GitHubStoredTokens>('github');
  if (!stored?.accessToken) {
    throw new IntegrationAuthError('GitHub OAuth token is missing.', {
      integrationId: 'github',
      hint: AUTH_HINT,
    });
  }

  if (stored.refreshTokenExpiresAt && Date.now() >= stored.refreshTokenExpiresAt) {
    throw new IntegrationAuthError('GitHub refresh token expired.', {
      integrationId: 'github',
      hint: AUTH_HINT,
    });
  }

  if (stored.expiresAt && Date.now() >= stored.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    if (!stored.refreshToken) {
      throw new IntegrationAuthError('GitHub OAuth token expired.', {
        integrationId: 'github',
        hint: AUTH_HINT,
      });
    }

    const refreshed = await refreshGitHubToken(stored.refreshToken, stored);
    if (refreshed.accessToken) {
      return refreshed.accessToken;
    }
  }

  return stored.accessToken;
};

const getOctokit = async () => {
  const token = await resolveAccessToken();
  const config = loadConfig();
  const baseUrl = config.github?.baseUrl;
  return new Octokit({ auth: token, baseUrl: baseUrl || undefined });
};

export class GitHubIntegration extends BaseIntegration {
  id = 'github';
  name = 'GitHub';
  description = 'Access GitHub repositories, issues, and pull requests';
  icon = '🐙';

  getAuthConfig() {
    return {
      getAuthUrl: (baseUrl: string, state: string) => {
        const config = loadConfig();
        const clientId = config.github?.oauthClientId;
        if (!clientId) {
          throw new Error('Missing GITHUB_OAUTH_CLIENT_ID');
        }

        const redirectUri = config.github?.oauthRedirectUri || `${baseUrl}/oauth/github/callback`;
        const authBaseUrl = (process.env.GITHUB_OAUTH_BASE_URL || DEFAULT_OAUTH_BASE_URL).replace(/\/$/, '');
        
        const url = new URL(`${authBaseUrl}/login/oauth/authorize`);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', process.env.GITHUB_OAUTH_SCOPES || 'repo read:org read:user');
        url.searchParams.set('state', state);
        return url.toString();
      },
      handleCallback: async (params: URLSearchParams, baseUrl: string) => {
        const code = params.get('code');
        const state = params.get('state');
        
        if (!code) {
          throw new Error('Missing authorization code');
        }

        const config = loadConfig();
        const clientId = config.github?.oauthClientId;
        const clientSecret = config.github?.oauthClientSecret;

        if (!clientId || !clientSecret) {
          throw new Error('Missing GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_SECRET');
        }

        const redirectUri = config.github?.oauthRedirectUri || `${baseUrl}/oauth/github/callback`;
        const authBaseUrl = (process.env.GITHUB_OAUTH_BASE_URL || DEFAULT_OAUTH_BASE_URL).replace(/\/$/, '');
        
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          state: state ?? '',
        });

        const response = await fetch(`${authBaseUrl}/login/oauth/access_token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
        });

        if (!response.ok) {
          throw new Error(`GitHub token exchange failed (${response.status})`);
        }

        const data = (await response.json()) as GitHubRefreshResponse;
        
        if (data.error || !data.access_token) {
           throw new Error(data.error_description || 'GitHub did not return an access token.');
        }

        const now = Date.now();
        const expiresAt = data.expires_in ? now + data.expires_in * 1000 : undefined;
        const refreshTokenExpiresAt = data.refresh_token_expires_in
          ? now + data.refresh_token_expires_in * 1000
          : undefined;

        await tokenStore.setTokens(this.id, {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt,
          refreshTokenExpiresAt,
          scope: data.scope,
          tokenType: data.token_type,
          updatedAt: new Date().toISOString(),
        });
      },
    };
  }

  getTools() {
    return {
      search_issues: tool({
        description: 'Search GitHub issues or pull requests with optional repo scoping',
        inputSchema: z.object({
          query: z.string().describe('Search query for issues or pull requests'),
          repo: z.string().optional().describe('Optional repo in owner/repo format'),
          state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state'),
          type: z.enum(['issue', 'pull_request', 'all']).optional().describe('Search issues, PRs, or both'),
          limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 10)'),
        }),
        execute: async ({ query, repo, state, type, limit }: {
          query: string;
          repo?: string;
          state?: 'open' | 'closed' | 'all';
          type?: 'issue' | 'pull_request' | 'all';
          limit?: number;
        }) => {
          try {
            const octokit = await getOctokit();
            const qualifiers: string[] = [];
            const resolved = resolveRepo(repo);

            if (resolved) {
              qualifiers.push(`repo:${resolved.owner}/${resolved.repo}`);
            }

            if (state && state !== 'all') {
              qualifiers.push(`state:${state}`);
            }

            if (type === 'issue') {
              qualifiers.push('is:issue');
            } else if (type === 'pull_request') {
              qualifiers.push('is:pr');
            }

            const q = [query, ...qualifiers].join(' ').trim();
            const perPage = clamp(limit ?? 10, 1, 50);
            const result = await withRetry(
              () => octokit.search.issuesAndPullRequests({ q, per_page: perPage }),
              { integrationId: this.id, operation: 'search issues' },
            );

            return {
              total: result.data.total_count,
              items: result.data.items.map((item) => ({
                id: item.id,
                number: item.number,
                title: item.title,
                url: item.html_url,
                state: item.state,
                author: item.user?.login,
                labels: item.labels
                  .map((label) => (typeof label === 'string' ? label : label.name ?? ''))
                  .filter((label) => label.length > 0),
                repo: item.repository_url?.split('repos/')[1],
                updatedAt: item.updated_at,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_pull_requests: tool({
        description: 'List pull requests for a repository',
        inputSchema: z.object({
          repo: z.string().optional().describe('Repo in owner/repo format (defaults to env config)'),
          state: z.enum(['open', 'closed', 'all']).optional().describe('PR state'),
          limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 10)'),
        }),
        execute: async ({ repo, state, limit }: {
          repo?: string;
          state?: 'open' | 'closed' | 'all';
          limit?: number;
        }) => {
          try {
            const octokit = await getOctokit();
            const resolved = resolveRepo(repo);

            if (!resolved) {
              return createToolError(this.id, 'Provide repo or set GITHUB_DEFAULT_OWNER/GITHUB_DEFAULT_REPO.', {
                kind: 'invalid_request',
              });
            }

            const perPage = clamp(limit ?? 10, 1, 50);
            const result = await withRetry(
              () =>
                octokit.pulls.list({
                  owner: resolved.owner,
                  repo: resolved.repo,
                  state: state ?? 'open',
                  per_page: perPage,
                }),
              { integrationId: this.id, operation: 'list pull requests' },
            );

            return {
              repo: `${resolved.owner}/${resolved.repo}`,
              pullRequests: result.data.map((pr) => ({
                id: pr.id,
                number: pr.number,
                title: pr.title,
                url: pr.html_url,
                state: pr.state,
                author: pr.user?.login,
                createdAt: pr.created_at,
                updatedAt: pr.updated_at,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_repo_summary: tool({
        description: 'Get summary information for a GitHub repository',
        inputSchema: z.object({
          repo: z.string().optional().describe('Repo in owner/repo format (defaults to env config)'),
        }),
        execute: async ({ repo }: { repo?: string }) => {
          try {
            const octokit = await getOctokit();
            const resolved = resolveRepo(repo);

            if (!resolved) {
              return createToolError(this.id, 'Provide repo or set GITHUB_DEFAULT_OWNER/GITHUB_DEFAULT_REPO.', {
                kind: 'invalid_request',
              });
            }

            const result = await withRetry(
              () =>
                octokit.repos.get({
                  owner: resolved.owner,
                  repo: resolved.repo,
                }),
              { integrationId: this.id, operation: 'get repo summary' },
            );

            return {
              repo: result.data.full_name,
              description: result.data.description,
              defaultBranch: result.data.default_branch,
              stars: result.data.stargazers_count,
              forks: result.data.forks_count,
              openIssues: result.data.open_issues_count,
              visibility: result.data.visibility,
              updatedAt: result.data.updated_at,
              url: result.data.html_url,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),
    };
  }

  async search(query: string): Promise<SearchResult[]> {
    try {
      const octokit = await getOctokit();
      const result = await withRetry(
        () =>
          octokit.search.issuesAndPullRequests({
            q: query,
            per_page: 5,
          }),
        { integrationId: this.id, operation: 'search issues' },
      );

      return result.data.items.map((item) => ({
        integrationId: this.id,
        title: item.title,
        snippet: `${item.state} • ${item.user?.login ?? 'unknown'}`,
        url: item.html_url,
        metadata: {
          id: item.id,
          number: item.number,
          repo: item.repository_url?.split('repos/')[1],
        },
      }));
    } catch (error) {
      logger.error({ error }, '[GitHub] Search error');
      return [];
    }
  }
}
