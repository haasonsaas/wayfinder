import { logger } from './logger.js';
import { rateLimiter } from './rate-limiter.js';
import type { GeneratedToolSchema } from './api-doc-parser.js';

export interface ExecutionContext {
  userId: string;
  workspaceId?: string;
  authCredentials?: Record<string, string>;
}

export interface ExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  statusCode?: number;
  duration: number;
  headers?: Record<string, string>;
}

const REQUEST_TIMEOUT_MS = 30000;

const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '10.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.',
  '169.254.',
  'metadata.google',
  '169.254.169.254',
];

export class DynamicToolExecutor {
  async execute(
    toolSchema: GeneratedToolSchema,
    inputs: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const start = Date.now();

    try {
      const rateCheck = await rateLimiter.check(`dynamic:${toolSchema.name}`, context.userId);
      if (!rateCheck.allowed) {
        return {
          success: false,
          error: rateCheck.reason || 'Rate limit exceeded',
          duration: Date.now() - start,
        };
      }

      this.validateEndpoint(toolSchema.endpoint);

      const url = this.buildUrl(toolSchema, inputs);
      const headers = this.buildHeaders(context);
      const body = this.buildBody(toolSchema, inputs);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: toolSchema.method,
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        await rateLimiter.record(`dynamic:${toolSchema.name}`, context.userId);

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const contentType = response.headers.get('content-type') || '';
        let data: unknown;

        if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          data = await response.text();
        }

        if (!response.ok) {
          return {
            success: false,
            error: `HTTP ${response.status}: ${response.statusText}`,
            data,
            statusCode: response.status,
            duration: Date.now() - start,
            headers: responseHeaders,
          };
        }

        logger.debug(
          { tool: toolSchema.name, statusCode: response.status, duration: Date.now() - start },
          '[DynamicExecutor] Request completed',
        );

        return {
          success: true,
          data,
          statusCode: response.status,
          duration: Date.now() - start,
          headers: responseHeaders,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const duration = Date.now() - start;

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`,
          duration,
        };
      }

      logger.error({ error, tool: toolSchema.name }, '[DynamicExecutor] Execution failed');

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration,
      };
    }
  }

  private validateEndpoint(endpoint: string): void {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error(`Invalid endpoint URL: ${endpoint}`);
    }

    const host = url.hostname.toLowerCase();

    for (const blocked of BLOCKED_HOSTS) {
      if (host === blocked || host.startsWith(blocked)) {
        throw new Error(`Endpoint host "${host}" is not allowed for security reasons`);
      }
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`Protocol "${url.protocol}" is not allowed`);
    }
  }

  private buildUrl(toolSchema: GeneratedToolSchema, inputs: Record<string, unknown>): string {
    let url = toolSchema.endpoint;

    for (const param of toolSchema.pathParams) {
      const value = inputs[param];
      if (value !== undefined) {
        url = url.replace(`{${param}}`, encodeURIComponent(String(value)));
      }
    }

    if (toolSchema.method === 'GET' && toolSchema.queryParams.length > 0) {
      const urlObj = new URL(url);
      for (const param of toolSchema.queryParams) {
        const value = inputs[param];
        if (value !== undefined && value !== null) {
          urlObj.searchParams.set(param, String(value));
        }
      }
      url = urlObj.toString();
    }

    return url;
  }

  private buildHeaders(context: ExecutionContext): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Adept/1.0',
    };

    if (context.authCredentials) {
      const { apiKey, bearerToken, basicAuth } = context.authCredentials;

      if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
      } else if (apiKey) {
        headers['X-API-Key'] = apiKey;
        headers['Authorization'] = `ApiKey ${apiKey}`;
      } else if (basicAuth) {
        headers['Authorization'] = `Basic ${Buffer.from(basicAuth).toString('base64')}`;
      }
    }

    return headers;
  }

  private buildBody(toolSchema: GeneratedToolSchema, inputs: Record<string, unknown>): string | undefined {
    if (toolSchema.method === 'GET') {
      return undefined;
    }

    const bodyParams = { ...inputs };
    
    for (const param of [...toolSchema.pathParams, ...toolSchema.queryParams]) {
      delete bodyParams[param];
    }

    if (Object.keys(bodyParams).length === 0) {
      return undefined;
    }

    return JSON.stringify(bodyParams);
  }

  async testTool(
    schema: GeneratedToolSchema,
    testInputs: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<{
    success: boolean;
    response?: ExecutionResult;
    validationErrors?: string[];
  }> {
    const validationErrors: string[] = [];

    for (const param of schema.pathParams) {
      if (testInputs[param] === undefined) {
        validationErrors.push(`Missing required path parameter: ${param}`);
      }
    }

    for (const [key, fieldSchema] of Object.entries(schema.inputSchema)) {
      const s = fieldSchema as { required?: boolean; type?: string };
      if (s.required && testInputs[key] === undefined) {
        validationErrors.push(`Missing required input: ${key}`);
      }
    }

    if (validationErrors.length > 0) {
      return { success: false, validationErrors };
    }

    const response = await this.execute(schema, testInputs, context);

    return {
      success: response.success,
      response,
      validationErrors: response.success ? undefined : [`Request failed: ${response.error}`],
    };
  }
}

export const dynamicToolExecutor = new DynamicToolExecutor();
