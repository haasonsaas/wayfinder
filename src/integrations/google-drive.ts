import { tool } from 'ai';
import { google, drive_v3 } from 'googleapis';
import type { Credentials, OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { tokenStore } from '../lib/token-store.js';
import { IntegrationAuthError, createToolError, toToolError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';
import type { SearchResult } from '../types/index.js';

import { loadConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const MAX_TEXT_CHARS = 20000;
const MAX_BINARY_BYTES = 1024 * 1024;
const AUTH_HINT = 'Run "oauth status" in Slack to review Google Drive connection links.';

interface DriveAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  tokenType?: string;
  scope?: string;
}

interface DriveStoredTokens extends Record<string, unknown> {
  refreshToken?: string;
  accessToken?: string;
  expiryDate?: number;
  tokenType?: string;
  scope?: string;
  updatedAt?: string;
}

const sanitizeQuery = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const toBuffer = (data: unknown): Buffer => {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data);
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }

  if (typeof data === 'string') {
    return Buffer.from(data);
  }

  return Buffer.from('');
};

class DriveClient {
  private drive?: drive_v3.Drive;
  private auth?: OAuth2Client;
  private onTokenUpdate?: (tokens: DriveStoredTokens) => Promise<void>;

  constructor(config: DriveAuthConfig, onTokenUpdate?: (tokens: DriveStoredTokens) => Promise<void>) {
    this.config = { ...config };
    this.onTokenUpdate = onTokenUpdate;
  }

  private config: DriveAuthConfig;

  private handleTokenUpdate(tokens: Credentials) {
    if (tokens.refresh_token) {
      this.config.refreshToken = tokens.refresh_token;
    }

    if (tokens.access_token) {
      this.config.accessToken = tokens.access_token;
    }

    if (tokens.expiry_date) {
      this.config.expiryDate = tokens.expiry_date;
    }

    if (tokens.token_type) {
      this.config.tokenType = tokens.token_type;
    }

    if (tokens.scope) {
      this.config.scope = tokens.scope;
    }

    if (!this.onTokenUpdate) {
      return;
    }

    void this.onTokenUpdate({
      refreshToken: this.config.refreshToken,
      accessToken: this.config.accessToken,
      expiryDate: this.config.expiryDate,
      tokenType: this.config.tokenType,
      scope: this.config.scope,
      updatedAt: new Date().toISOString(),
    });
  }

  getDrive(): drive_v3.Drive {
    if (!this.drive) {
      const auth = new google.auth.OAuth2(
        this.config.clientId,
        this.config.clientSecret,
        this.config.redirectUri,
      );

      auth.setCredentials({
        refresh_token: this.config.refreshToken,
        access_token: this.config.accessToken,
        expiry_date: this.config.expiryDate,
        token_type: this.config.tokenType,
      });

      auth.on('tokens', (tokens) => this.handleTokenUpdate(tokens));
      this.auth = auth;
      this.drive = google.drive({ version: 'v3', auth: this.auth });
    }

    return this.drive;
  }
}

export class GoogleDriveIntegration extends BaseIntegration {
  id = 'google_drive';
  name = 'Google Drive';
  description = 'Search and read Google Drive files and documents';
  icon = '📂';

  private client?: DriveClient;
  private clientKey?: string;

  getAuthConfig() {
    return {
      getAuthUrl: (baseUrl: string, state: string) => {
        const config = loadConfig();
        const clientId = config.googleDrive?.clientId;
        const clientSecret = config.googleDrive?.clientSecret;
        if (!clientId || !clientSecret) {
          throw new Error('Missing GOOGLE_DRIVE_CLIENT_ID or GOOGLE_DRIVE_CLIENT_SECRET');
        }

        const redirectUri = config.googleDrive?.redirectUri || `${baseUrl}/oauth/google-drive/callback`;

        const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        return oauth.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: [
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/drive.metadata.readonly',
          ],
          state,
        });
      },
      handleCallback: async (params: URLSearchParams, baseUrl: string) => {
        const code = params.get('code');
        if (!code) {
          throw new Error('Missing authorization code');
        }

        const config = loadConfig();
        const clientId = config.googleDrive?.clientId;
        const clientSecret = config.googleDrive?.clientSecret;
        if (!clientId || !clientSecret) {
          throw new Error('Missing GOOGLE_DRIVE_CLIENT_ID or GOOGLE_DRIVE_CLIENT_SECRET');
        }

        const redirectUri = config.googleDrive?.redirectUri || `${baseUrl}/oauth/google-drive/callback`;

        const oauth = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        const { tokens } = await oauth.getToken(code);

        if (!tokens.refresh_token) {
           throw new Error('Google did not return a refresh token. Revoke access and retry with prompt=consent.');
        }

        await tokenStore.setTokens(this.id, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          scope: tokens.scope,
          expiryDate: tokens.expiry_date,
          tokenType: tokens.token_type,
          updatedAt: new Date().toISOString(),
        });
      },
    };
  }

  getTools() {
    return {
      drive_search_files: tool({
        description: 'Search Google Drive files by name or MIME type',
        inputSchema: z.object({
          query: z.string().optional().describe('Search term applied to file names'),
          mimeType: z.string().optional().describe('Filter by MIME type (e.g. application/pdf)'),
          includeTrashed: z.boolean().optional().describe('Include trashed files'),
          limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 10)'),
        }),
        execute: async ({ query, mimeType, includeTrashed, limit }: {
          query?: string;
          mimeType?: string;
          includeTrashed?: boolean;
          limit?: number;
        }) => {
          try {
            return await this.searchFiles({ query, mimeType, includeTrashed, limit: limit ?? 10 });
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      drive_get_file_metadata: tool({
        description: 'Get metadata for a Google Drive file',
        inputSchema: z.object({
          fileId: z.string().describe('Google Drive file ID'),
        }),
        execute: async ({ fileId }: { fileId: string }) => {
          try {
            return await this.getFileMetadata(fileId);
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      drive_read_file_text: tool({
        description: 'Read textual content from a Google Drive file or Google Doc',
        inputSchema: z.object({
          fileId: z.string().describe('Google Drive file ID'),
          maxChars: z.number().int().min(500).max(50000).optional().describe('Maximum characters to return'),
        }),
        execute: async ({ fileId, maxChars }: { fileId: string; maxChars?: number }) => {
          try {
            return await this.readFileText(fileId, maxChars ?? MAX_TEXT_CHARS);
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),
    };
  }

  async search(query: string): Promise<SearchResult[]> {
    try {
      const results = await this.searchFiles({ query, limit: 5 });
      const files = results.files ?? [];

      return files.map((file) => ({
        integrationId: this.id,
        title: file.name || 'Untitled file',
        snippet: `${file.mimeType ?? 'unknown'} • ${file.modifiedTime ?? ''}`.trim(),
        url: file.webViewLink ?? undefined,
        metadata: {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime,
          webViewLink: file.webViewLink,
        },
      }));
    } catch (error) {
      logger.error({ error }, '[Google Drive] Search error');
      return [];
    }
  }

  private async getClient(): Promise<DriveClient> {
    const config = loadConfig();
    const clientId = config.googleDrive?.clientId;
    const clientSecret = config.googleDrive?.clientSecret;
    const redirectUri = config.googleDrive?.redirectUri;
    const stored = await tokenStore.getTokens<DriveStoredTokens>(this.id);
    const refreshToken = stored?.refreshToken || process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !redirectUri || !refreshToken) {
      throw new IntegrationAuthError('Google Drive OAuth configuration is missing.', {
        integrationId: this.id,
        hint: AUTH_HINT,
      });
    }

    const key = `${clientId}:${redirectUri}:${refreshToken}`;
    if (!this.client || this.clientKey !== key) {
      this.client = new DriveClient({
        clientId,
        clientSecret,
        redirectUri,
        refreshToken,
        accessToken: stored?.accessToken,
        expiryDate: stored?.expiryDate,
        tokenType: stored?.tokenType,
        scope: stored?.scope,
      }, async (tokens) => {
        await tokenStore.setTokens(this.id, tokens);
      });
      this.clientKey = key;
    }

    return this.client;
  }

  private async searchFiles({
    query,
    mimeType,
    includeTrashed,
    limit,
  }: {
    query?: string;
    mimeType?: string;
    includeTrashed?: boolean;
    limit: number;
  }) {
    const drive = (await this.getClient()).getDrive();
    const filters: string[] = [];

    if (query) {
      filters.push(`name contains '${sanitizeQuery(query)}'`);
    }

    if (mimeType) {
      filters.push(`mimeType = '${sanitizeQuery(mimeType)}'`);
    }

    if (!includeTrashed) {
      filters.push('trashed = false');
    }

    const q = filters.length > 0 ? filters.join(' and ') : undefined;
    const pageSize = clamp(limit, 1, 50);
    const response = await withRetry(
      () =>
        drive.files.list({
          q,
          pageSize,
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress),size)',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        }),
      { integrationId: this.id, operation: 'drive search' },
    );

    return { files: response.data.files ?? [] };
  }

  private async getFileMetadata(fileId: string) {
    const drive = (await this.getClient()).getDrive();
    const response = await withRetry(
      () =>
        drive.files.get({
          fileId,
          fields: 'id,name,mimeType,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress),size',
          supportsAllDrives: true,
        }),
      { integrationId: this.id, operation: 'drive metadata' },
    );

    return { file: response.data };
  }

  private async readFileText(fileId: string, maxChars: number) {
    const drive = (await this.getClient()).getDrive();
    const metadataResponse = await withRetry(
      () =>
        drive.files.get({
          fileId,
          fields: 'id,name,mimeType,webViewLink,size',
          supportsAllDrives: true,
        }),
      { integrationId: this.id, operation: 'drive file fetch' },
    );

    const file = metadataResponse.data;
    const mimeType = file.mimeType || '';
    const size = file.size ? Number(file.size) : undefined;

    if (size && size > MAX_BINARY_BYTES && !mimeType.startsWith('application/vnd.google-apps.')) {
      return createToolError(this.id, `File is too large to read (${size} bytes).`, {
        kind: 'invalid_request',
      });
    }

    let responseData: ArrayBuffer | Uint8Array | Buffer | string;

    if (mimeType.startsWith('application/vnd.google-apps.')) {
      const exportType = mimeType.includes('spreadsheet') ? 'text/csv' : 'text/plain';
      const exportResponse = await withRetry(
        () =>
          drive.files.export({ fileId, mimeType: exportType }, { responseType: 'arraybuffer' }),
        { integrationId: this.id, operation: 'drive export' },
      );
      responseData = exportResponse.data as ArrayBuffer;
    } else if (mimeType.startsWith('text/') || mimeType === 'application/json') {
      const mediaResponse = await withRetry(
        () => drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }),
        { integrationId: this.id, operation: 'drive file download' },
      );
      responseData = mediaResponse.data as ArrayBuffer;
    } else {
      return createToolError(
        this.id,
        `File type ${mimeType || 'unknown'} is not supported for text extraction.`,
        { kind: 'invalid_request' },
      );
    }

    const content = toBuffer(responseData).toString('utf-8');
    const truncated = content.length > maxChars;
    const text = truncated ? content.slice(0, maxChars) : content;

    return {
      file: {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        webViewLink: file.webViewLink,
      },
      content: text,
      truncated,
    };
  }
}
