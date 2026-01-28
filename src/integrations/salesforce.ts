import { tool } from 'ai';
import jsforce from 'jsforce';
import type { Connection, QueryResult } from 'jsforce';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { tokenStore } from '../lib/token-store.js';
import { IntegrationAuthError, IntegrationError, createToolError, toToolError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import type { SearchResult } from '../types/index.js';

import { loadConfig } from '../lib/config.js';

const DEFAULT_LOGIN_URL = 'https://login.salesforce.com';
const TOKEN_TTL_MS = 45 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;
const AUTH_HINT = 'Run "oauth status" in Slack to review Salesforce connection links.';

interface SalesforceAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginUrl: string;
  accessToken?: string;
  instanceUrl?: string;
  expiresAt?: number;
}

interface SalesforceTokenResponse {
  access_token: string;
  instance_url: string;
  issued_at?: string;
  refresh_token?: string;
}

interface SalesforceStoredTokens extends Record<string, unknown> {
  accessToken?: string;
  refreshToken?: string;
  instanceUrl?: string;
  issuedAt?: string;
  expiresAt?: number;
  updatedAt?: string;
}

interface SalesforceContactRecord extends Record<string, unknown> {
  Id: string;
  Name?: string;
  Email?: string;
  Title?: string;
  Phone?: string;
  LastActivityDate?: string;
  Account?: {
    Name?: string;
  };
}

interface SalesforceOpportunityRecord extends Record<string, unknown> {
  Id: string;
  Name?: string;
  Amount?: number;
  StageName?: string;
  Probability?: number;
  CloseDate?: string;
  Account?: {
    Name?: string;
  };
  Owner?: {
    Name?: string;
  };
}

interface SalesforceAccountRecord extends Record<string, unknown> {
  Id: string;
  Name?: string;
  Industry?: string;
  Website?: string;
  Type?: string;
  AnnualRevenue?: number;
  Owner?: {
    Name?: string;
  };
}

interface SalesforceStageSummaryRecord extends Record<string, unknown> {
  StageName?: string;
  totalAmount?: number;
  dealCount?: number;
}

interface ContactSummary {
  id: string;
  name?: string;
  email?: string;
  title?: string;
  phone?: string;
  accountName?: string;
  lastActivityDate?: string;
}

interface OpportunitySummary {
  id: string;
  name?: string;
  amount?: number;
  stage?: string;
  probability?: number;
  closeDate?: string;
  accountName?: string;
  owner?: string;
}

interface AccountSummary {
  id: string;
  name?: string;
  industry?: string;
  website?: string;
  type?: string;
  annualRevenue?: number;
  owner?: string;
}

interface PipelineStageSummary {
  stage?: string;
  count: number;
  totalAmount: number;
}

const sanitizeSoql = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const buildLike = (value: string) => `%${sanitizeSoql(value)}%`;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));


class SalesforceClient {
  private accessToken?: string;
  private instanceUrl?: string;
  private expiresAt?: number;
  private refreshPromise?: Promise<void>;
  private refreshToken: string;
  private clientId: string;
  private clientSecret: string;
  private loginUrl: string;
  private onTokenUpdate?: (tokens: SalesforceStoredTokens) => Promise<void>;

  constructor(config: SalesforceAuthConfig, onTokenUpdate?: (tokens: SalesforceStoredTokens) => Promise<void>) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.loginUrl = config.loginUrl.replace(/\/$/, '');
    this.accessToken = config.accessToken;
    this.instanceUrl = config.instanceUrl;
    this.expiresAt = config.expiresAt;
    this.onTokenUpdate = onTokenUpdate;
  }

  async getConnection(): Promise<Connection> {
    await this.ensureAccessToken();

    if (!this.accessToken || !this.instanceUrl) {
      throw new Error('Salesforce access token is unavailable.');
    }

    return new jsforce.Connection({
      accessToken: this.accessToken,
      instanceUrl: this.instanceUrl,
    });
  }

  private isTokenValid(): boolean {
    if (!this.accessToken || !this.instanceUrl || !this.expiresAt) {
      return false;
    }

    return Date.now() < this.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  }

  private async ensureAccessToken(): Promise<void> {
    if (this.isTokenValid()) {
      return;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken();
    }

    await this.refreshPromise;
    this.refreshPromise = undefined;
  }

  private async refreshAccessToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    const response = await withRetry(
      async () => {
        const res = await fetch(`${this.loginUrl}/services/oauth2/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });

        if (!res.ok) {
          const errorBody = await res.text();
          const error = new Error(`Salesforce token refresh failed (${res.status}): ${errorBody}`) as Error & {
            status?: number;
            headers?: Headers;
          };
          error.status = res.status;
          error.headers = res.headers;
          throw error;
        }

        return res;
      },
      { integrationId: 'salesforce', operation: 'refresh token' },
    );

    const data = (await response.json()) as SalesforceTokenResponse;

    if (!data.access_token || !data.instance_url) {
      throw new Error('Salesforce token refresh response missing access_token or instance_url');
    }

    this.accessToken = data.access_token;
    this.instanceUrl = data.instance_url;
    this.expiresAt = Date.now() + TOKEN_TTL_MS;

    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }

    await this.onTokenUpdate?.({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      instanceUrl: this.instanceUrl,
      issuedAt: data.issued_at,
      expiresAt: this.expiresAt,
      updatedAt: new Date().toISOString(),
    });
  }
}

export class SalesforceIntegration extends BaseIntegration {
  id = 'salesforce';
  name = 'Salesforce';
  description = 'Access Salesforce contacts, accounts, and opportunities';
  icon = '☁️';

  private client?: SalesforceClient;
  private clientKey?: string;

  getAuthConfig() {
    return {
      getAuthUrl: (baseUrl: string, state: string) => {
        const config = loadConfig();
        const loginUrl = (config.salesforce?.loginUrl || DEFAULT_LOGIN_URL).replace(/\/$/, '');
        const clientId = config.salesforce?.clientId;
        if (!clientId) {
          throw new Error('Missing SALESFORCE_CLIENT_ID');
        }

        const redirectUri = config.salesforce?.redirectUri || `${baseUrl}/oauth/salesforce/callback`;

        const url = new URL(`${loginUrl}/services/oauth2/authorize`);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', 'refresh_token api');
        url.searchParams.set('state', state);
        return url.toString();
      },
      handleCallback: async (params: URLSearchParams, baseUrl: string) => {
        const code = params.get('code');
        if (!code) {
          throw new Error('Missing authorization code');
        }

        const config = loadConfig();
        const redirectUri = config.salesforce?.redirectUri || `${baseUrl}/oauth/salesforce/callback`;
        const loginUrl = (config.salesforce?.loginUrl || DEFAULT_LOGIN_URL).replace(/\/$/, '');
        const clientId = config.salesforce?.clientId;
        const clientSecret = config.salesforce?.clientSecret;

        if (!clientId || !clientSecret) {
          throw new Error('Missing SALESFORCE_CLIENT_ID or SALESFORCE_CLIENT_SECRET');
        }

        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        });

        const response = await fetch(`${loginUrl}/services/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Salesforce token exchange failed (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as SalesforceTokenResponse;

        if (!data.refresh_token) {
          throw new Error('Salesforce did not return a refresh token. Ensure refresh_token scope is enabled.');
        }

        await tokenStore.setTokens(this.id, {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          instanceUrl: data.instance_url,
          issuedAt: data.issued_at,
          expiresAt: Date.now() + TOKEN_TTL_MS,
          updatedAt: new Date().toISOString(),
        });
      },
    };
  }

  getTools() {
    return {
      search_contacts: tool({
        description: 'Search Salesforce contacts by name, email, or account',
        inputSchema: z.object({
          query: z.string().describe('Contact name, email, or account to search for'),
          limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 10)'),
        }),
        execute: async ({ query, limit }: { query: string; limit?: number }) => {
          try {
            const results = await this.queryContacts(query, limit ?? 10);
            return { contacts: results, total: results.length };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_contact_details: tool({
        description: 'Get Salesforce contact details by id, name, or email',
        inputSchema: z.object({
          contactId: z.string().optional().describe('Salesforce Contact ID'),
          name: z.string().optional().describe('Full name of the contact'),
          email: z.string().optional().describe('Email of the contact'),
        }),
        execute: async ({ contactId, name, email }: { contactId?: string; name?: string; email?: string }) => {
          try {
            const contact = await this.getContactDetails({ contactId, name, email });
            if (!contact) {
              return createToolError(this.id, 'No matching Salesforce contact found.', { kind: 'not_found' });
            }
            return { contact };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      search_opportunities: tool({
        description: 'Search Salesforce opportunities with optional filters',
        inputSchema: z.object({
          query: z.string().optional().describe('Opportunity name or account to search for'),
          stage: z.string().optional().describe('Filter by stage name'),
          owner: z.string().optional().describe('Filter by opportunity owner'),
          includeClosed: z.boolean().optional().describe('Include closed opportunities'),
          limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 10)'),
        }),
        execute: async ({ query, stage, owner, includeClosed, limit }: {
          query?: string;
          stage?: string;
          owner?: string;
          includeClosed?: boolean;
          limit?: number;
        }) => {
          try {
            const results = await this.queryOpportunities({
              query,
              stage,
              owner,
              includeClosed: includeClosed ?? false,
              limit: limit ?? 10,
            });

            const totalValue = results.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);

            return {
              opportunities: results,
              summary: {
                count: results.length,
                totalValue,
              },
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_pipeline_summary: tool({
        description: 'Get Salesforce open pipeline totals by stage',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            return await this.getPipelineSummary();
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_account_summary: tool({
        description: 'Get Salesforce account details by id or name',
        inputSchema: z.object({
          accountId: z.string().optional().describe('Salesforce Account ID'),
          name: z.string().optional().describe('Account name'),
        }),
        execute: async ({ accountId, name }: { accountId?: string; name?: string }) => {
          try {
            const account = await this.getAccountSummary({ accountId, name });
            if (!account) {
              return createToolError(this.id, 'No matching Salesforce account found.', { kind: 'not_found' });
            }
            return { account };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),
    };
  }

  async search(query: string): Promise<SearchResult[]> {
    try {
      const [contacts, opportunities] = await Promise.all([
        this.queryContacts(query, 5),
        this.queryOpportunities({ query, includeClosed: true, limit: 5 }),
      ]);

      const contactResults: SearchResult[] = contacts.map((contact) => ({
        integrationId: this.id,
        title: `${contact.name ?? 'Unknown'}${contact.accountName ? ` (${contact.accountName})` : ''}`,
        snippet: contact.title ?? 'Contact',
        metadata: { type: 'contact', ...contact },
      }));

      const opportunityResults: SearchResult[] = opportunities.map((opp) => ({
        integrationId: this.id,
        title: opp.name ?? 'Opportunity',
        snippet: `${opp.stage ?? 'Stage unknown'} • ${(opp.amount ?? 0).toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 0,
        })}`,
        metadata: { type: 'opportunity', ...opp },
      }));

      return [...contactResults, ...opportunityResults];
    } catch (error) {
      console.error('[Salesforce] Search error:', error);
      return [];
    }
  }

  private async getClient(): Promise<SalesforceClient> {
    const config = loadConfig();
    const clientId = config.salesforce?.clientId;
    const clientSecret = config.salesforce?.clientSecret;
    const storedTokens = await tokenStore.getTokens<SalesforceStoredTokens>(this.id);
    const refreshToken = storedTokens?.refreshToken || process.env.SALESFORCE_REFRESH_TOKEN;
    const loginUrl = config.salesforce?.loginUrl || DEFAULT_LOGIN_URL;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new IntegrationAuthError('Salesforce credentials are missing.', {
        integrationId: this.id,
        hint: AUTH_HINT,
      });
    }

    const key = `${clientId}:${loginUrl}:${refreshToken}`;
    if (!this.client || this.clientKey !== key) {
      this.client = new SalesforceClient({
        clientId,
        clientSecret,
        refreshToken,
        loginUrl,
        accessToken: storedTokens?.accessToken,
        instanceUrl: storedTokens?.instanceUrl,
        expiresAt: storedTokens?.expiresAt,
      }, async (tokens) => {
        await tokenStore.setTokens(this.id, tokens);
      });
      this.clientKey = key;
    }

    return this.client;
  }

  private async queryContacts(query: string, limit: number): Promise<ContactSummary[]> {
    const conn = await (await this.getClient()).getConnection();
    const like = buildLike(query);
    const safeLimit = clamp(limit, 1, 50);
    const soql =
      'SELECT Id, Name, Email, Title, Phone, Account.Name, LastActivityDate ' +
      `FROM Contact WHERE Name LIKE '${like}' OR Email LIKE '${like}' OR Account.Name LIKE '${like}' ` +
      `ORDER BY LastActivityDate DESC NULLS LAST LIMIT ${safeLimit}`;

    const result = await this.runQuery<SalesforceContactRecord>(conn, soql, 'query contacts');
    const records = result.records as SalesforceContactRecord[];

    return records.map((record) => ({
      id: record.Id,
      name: record.Name,
      email: record.Email,
      title: record.Title,
      phone: record.Phone,
      accountName: record.Account?.Name,
      lastActivityDate: record.LastActivityDate,
    }));
  }

  private async getContactDetails({
    contactId,
    name,
    email,
  }: {
    contactId?: string;
    name?: string;
    email?: string;
  }): Promise<ContactSummary | null> {
    if (!contactId && !name && !email) {
      throw new IntegrationError('invalid_request', 'Provide a contactId, name, or email to look up a contact.', {
        integrationId: this.id,
      });
    }

    const conn = await (await this.getClient()).getConnection();
    const conditions: string[] = [];

    if (contactId) {
      conditions.push(`Id = '${sanitizeSoql(contactId)}'`);
    }

    if (email) {
      conditions.push(`Email = '${sanitizeSoql(email)}'`);
    }

    if (name) {
      const like = buildLike(name);
      conditions.push(`Name LIKE '${like}'`);
    }

    const soql =
      'SELECT Id, Name, Email, Title, Phone, Account.Name, LastActivityDate ' +
      `FROM Contact WHERE ${conditions.join(' OR ')} ORDER BY LastActivityDate DESC LIMIT 1`;

    const result = await this.runQuery<SalesforceContactRecord>(conn, soql, 'get contact details');
    const record = (result.records as SalesforceContactRecord[])[0];

    if (!record) {
      return null;
    }

    return {
      id: record.Id,
      name: record.Name,
      email: record.Email,
      title: record.Title,
      phone: record.Phone,
      accountName: record.Account?.Name,
      lastActivityDate: record.LastActivityDate,
    };
  }

  private async queryOpportunities({
    query,
    stage,
    owner,
    includeClosed,
    limit,
  }: {
    query?: string;
    stage?: string;
    owner?: string;
    includeClosed: boolean;
    limit: number;
  }): Promise<OpportunitySummary[]> {
    const conn = await (await this.getClient()).getConnection();
    const conditions: string[] = [];

    if (query) {
      const like = buildLike(query);
      conditions.push(`(Name LIKE '${like}' OR Account.Name LIKE '${like}')`);
    }

    if (stage) {
      conditions.push(`StageName = '${sanitizeSoql(stage)}'`);
    }

    if (owner) {
      const like = buildLike(owner);
      conditions.push(`Owner.Name LIKE '${like}'`);
    }

    if (!includeClosed) {
      conditions.push('IsClosed = false');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const safeLimit = clamp(limit, 1, 50);
    const soql =
      'SELECT Id, Name, Amount, StageName, Probability, CloseDate, Account.Name, Owner.Name ' +
      `FROM Opportunity ${whereClause} ORDER BY CloseDate ASC NULLS LAST LIMIT ${safeLimit}`;

    const result = await this.runQuery<SalesforceOpportunityRecord>(conn, soql, 'query opportunities');
    const records = result.records as SalesforceOpportunityRecord[];

    return records.map((record) => ({
      id: record.Id,
      name: record.Name,
      amount: record.Amount ?? 0,
      stage: record.StageName,
      probability: record.Probability,
      closeDate: record.CloseDate,
      accountName: record.Account?.Name,
      owner: record.Owner?.Name,
    }));
  }

  private async getAccountSummary({
    accountId,
    name,
  }: {
    accountId?: string;
    name?: string;
  }): Promise<AccountSummary | null> {
    if (!accountId && !name) {
      throw new IntegrationError('invalid_request', 'Provide an accountId or name to look up an account.', {
        integrationId: this.id,
      });
    }

    const conn = await (await this.getClient()).getConnection();
    const conditions: string[] = [];

    if (accountId) {
      conditions.push(`Id = '${sanitizeSoql(accountId)}'`);
    }

    if (name) {
      const like = buildLike(name);
      conditions.push(`Name LIKE '${like}'`);
    }

    const soql =
      'SELECT Id, Name, Industry, Website, Type, AnnualRevenue, Owner.Name ' +
      `FROM Account WHERE ${conditions.join(' OR ')} ORDER BY LastModifiedDate DESC LIMIT 1`;

    const result = await this.runQuery<SalesforceAccountRecord>(conn, soql, 'get account summary');
    const record = (result.records as SalesforceAccountRecord[])[0];

    if (!record) {
      return null;
    }

    return {
      id: record.Id,
      name: record.Name,
      industry: record.Industry,
      website: record.Website,
      type: record.Type,
      annualRevenue: record.AnnualRevenue,
      owner: record.Owner?.Name,
    };
  }

  private async getPipelineSummary(): Promise<{ byStage: PipelineStageSummary[]; totals: { count: number; totalAmount: number } }> {
    const conn = await (await this.getClient()).getConnection();
    const soql =
      'SELECT StageName, SUM(Amount) totalAmount, COUNT(Id) dealCount ' +
      'FROM Opportunity WHERE IsClosed = false GROUP BY StageName';

    const result = await this.runQuery<SalesforceStageSummaryRecord>(conn, soql, 'get pipeline summary');
    const records = result.records as SalesforceStageSummaryRecord[];

    const byStage = records.map((record) => ({
      stage: record.StageName,
      count: Number(record.dealCount ?? 0),
      totalAmount: Number(record.totalAmount ?? 0),
    }));

    const totals = byStage.reduce(
      (acc, stage) => {
        acc.count += stage.count;
        acc.totalAmount += stage.totalAmount;
        return acc;
      },
      { count: 0, totalAmount: 0 },
    );

    return {
      byStage,
      totals,
    };
  }

  private async runQuery<T extends Record<string, unknown>>(
    conn: Connection,
    soql: string,
    operation: string,
  ): Promise<QueryResult<T>> {
    return withRetry(
      () => conn.query<T>(soql).then((result) => result as QueryResult<T>),
      { integrationId: this.id, operation },
    );
  }
}
