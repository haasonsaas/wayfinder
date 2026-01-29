import { z } from 'zod';
import { tool } from 'ai';
import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';
import { toolRegistry } from './tool-registry.js';

export interface UserToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpoint?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  authType?: 'none' | 'api_key' | 'bearer' | 'basic';
  authConfig?: {
    headerName?: string;
    envVar?: string;
  };
  createdBy: string;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  isPublic: boolean;
}

const UserToolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1).max(500),
  inputSchema: z.record(z.unknown()),
  endpoint: z.string().url().optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
  headers: z.record(z.string()).optional(),
  authType: z.enum(['none', 'api_key', 'bearer', 'basic']).optional(),
  authConfig: z.object({
    headerName: z.string().optional(),
    envVar: z.string().optional(),
  }).optional(),
  createdBy: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().positive(),
  isPublic: z.boolean(),
});

const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '10.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
  '169.254.',
];

export class UserToolsManager {
  private store = new RedisJsonStore<UserToolDefinition>('adept:user_tools');
  private versionStore = new RedisJsonStore<UserToolDefinition[]>('adept:user_tools_versions');

  async createTool(definition: Omit<UserToolDefinition, 'id' | 'createdAt' | 'updatedAt' | 'version'>): Promise<UserToolDefinition> {
    const id = `user_${definition.name}`;
    
    const existing = await this.store.get(id);
    if (existing) {
      throw new Error(`Tool "${definition.name}" already exists`);
    }

    if (definition.endpoint) {
      this.validateEndpoint(definition.endpoint);
    }

    const now = new Date().toISOString();
    const tool: UserToolDefinition = {
      ...definition,
      id,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };

    const parsed = UserToolSchema.safeParse(tool);
    if (!parsed.success) {
      throw new Error(`Invalid tool definition: ${parsed.error.message}`);
    }

    await this.store.set(id, tool);
    await this.registerWithToolRegistry(tool);

    logger.info({ id, name: definition.name }, '[UserTools] Tool created');
    return tool;
  }

  async updateTool(id: string, updates: Partial<UserToolDefinition>): Promise<UserToolDefinition> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new Error(`Tool "${id}" not found`);
    }

    if (updates.endpoint) {
      this.validateEndpoint(updates.endpoint);
    }

    const versions = (await this.versionStore.get(id)) || [];
    versions.push(existing);
    if (versions.length > 5) {
      versions.shift();
    }
    await this.versionStore.set(id, versions);

    const updated: UserToolDefinition = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      createdBy: existing.createdBy,
      updatedAt: new Date().toISOString(),
      version: existing.version + 1,
    };

    const parsed = UserToolSchema.safeParse(updated);
    if (!parsed.success) {
      throw new Error(`Invalid tool definition: ${parsed.error.message}`);
    }

    await this.store.set(id, updated);
    await this.registerWithToolRegistry(updated);

    logger.info({ id, version: updated.version }, '[UserTools] Tool updated');
    return updated;
  }

  async deleteTool(id: string): Promise<boolean> {
    const existing = await this.store.get(id);
    if (!existing) {
      return false;
    }

    await this.store.delete(id);
    await this.versionStore.delete(id);

    logger.info({ id }, '[UserTools] Tool deleted');
    return true;
  }

  async getTool(id: string): Promise<UserToolDefinition | null> {
    return await this.store.get(id);
  }

  async listTools(options: { userId?: string; workspaceId?: string } = {}): Promise<UserToolDefinition[]> {
    const all = await this.store.list();
    
    return all.filter((tool) => {
      if (tool.isPublic) return true;
      if (options.userId && tool.createdBy === options.userId) return true;
      if (options.workspaceId && tool.workspaceId === options.workspaceId) return true;
      return false;
    });
  }

  async getToolVersions(id: string): Promise<UserToolDefinition[]> {
    return (await this.versionStore.get(id)) || [];
  }

  async exportTools(userId: string): Promise<string> {
    const tools = await this.listTools({ userId });
    return JSON.stringify(tools, null, 2);
  }

  async importTools(json: string, userId: string): Promise<{ imported: number; errors: string[] }> {
    const errors: string[] = [];
    let imported = 0;

    try {
      const tools = JSON.parse(json) as UserToolDefinition[];
      
      for (const tool of tools) {
        try {
          await this.createTool({
            ...tool,
            createdBy: userId,
          });
          imported++;
        } catch (error) {
          errors.push(`${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch {
      errors.push('Invalid JSON format');
    }

    return { imported, errors };
  }

  private validateEndpoint(endpoint: string): void {
    try {
      const url = new URL(endpoint);
      const host = url.hostname.toLowerCase();

      for (const blocked of BLOCKED_HOSTS) {
        if (host === blocked || host.startsWith(blocked)) {
          throw new Error(`Endpoint host "${host}" is not allowed`);
        }
      }

      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`Protocol "${url.protocol}" is not allowed`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not allowed')) {
        throw error;
      }
      throw new Error(`Invalid endpoint URL: ${endpoint}`);
    }
  }

  private async registerWithToolRegistry(definition: UserToolDefinition): Promise<void> {
    const inputSchema = this.buildZodSchema(definition.inputSchema);
    
    const toolDef = tool({
      description: definition.description,
      inputSchema,
      execute: async (input: Record<string, unknown>) => {
        return await this.executeUserTool(definition, input);
      },
    });

    await toolRegistry.registerTool(
      definition.id,
      'user_tools',
      toolDef,
      { isUserDefined: true, version: definition.version },
    );
  }

  private buildZodSchema(schema: Record<string, unknown>): z.ZodSchema {
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, value] of Object.entries(schema)) {
      if (typeof value === 'object' && value !== null) {
        const fieldDef = value as { type?: string; description?: string; required?: boolean };
        let zodType: z.ZodTypeAny;

        switch (fieldDef.type) {
          case 'string':
            zodType = z.string();
            break;
          case 'number':
            zodType = z.number();
            break;
          case 'boolean':
            zodType = z.boolean();
            break;
          case 'array':
            zodType = z.array(z.unknown());
            break;
          case 'object':
            zodType = z.record(z.unknown());
            break;
          default:
            zodType = z.unknown();
        }

        if (fieldDef.description) {
          zodType = zodType.describe(fieldDef.description);
        }

        if (!fieldDef.required) {
          zodType = zodType.optional();
        }

        shape[key] = zodType;
      }
    }

    return z.object(shape);
  }

  private async executeUserTool(definition: UserToolDefinition, input: unknown): Promise<unknown> {
    if (!definition.endpoint) {
      return { error: 'Tool has no endpoint configured' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...definition.headers,
    };

    if (definition.authType && definition.authType !== 'none' && definition.authConfig?.envVar) {
      const authValue = process.env[definition.authConfig.envVar];
      if (authValue) {
        const headerName = definition.authConfig.headerName || 'Authorization';
        switch (definition.authType) {
          case 'api_key':
            headers[headerName] = authValue;
            break;
          case 'bearer':
            headers[headerName] = `Bearer ${authValue}`;
            break;
          case 'basic':
            headers[headerName] = `Basic ${Buffer.from(authValue).toString('base64')}`;
            break;
        }
      }
    }

    const method = definition.method || 'GET';
    const url = this.buildUrl(definition.endpoint, method, input);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? JSON.stringify(input) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          error: `HTTP ${response.status}: ${response.statusText}`,
          status: response.status,
        };
      }

      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        return await response.json();
      }
      return { text: await response.text() };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { error: 'Request timed out after 30 seconds' };
      }
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(endpoint: string, method: string, input: unknown): string {
    if (method !== 'GET' || !input || typeof input !== 'object') {
      return endpoint;
    }

    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async loadAllTools(): Promise<void> {
    const tools = await this.store.list();
    for (const tool of tools) {
      await this.registerWithToolRegistry(tool);
    }
    logger.info({ count: tools.length }, '[UserTools] Loaded user-defined tools');
  }
}

export const userToolsManager = new UserToolsManager();
