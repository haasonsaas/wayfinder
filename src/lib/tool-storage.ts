import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';
import type { GeneratedToolSchema } from './api-doc-parser.js';

export interface StoredTool extends GeneratedToolSchema {
  id: string;
  createdBy: string;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  isPublic: boolean;
  source: 'manual' | 'api_doc' | 'generated';
  sourceUrl?: string;
  tags?: string[];
}

interface ToolVersion {
  version: number;
  tool: StoredTool;
  savedAt: string;
}

const TOOLS_DIR = join(homedir(), '.adept', 'tools');
const MAX_VERSIONS = 5;

export class ToolStorage {
  private store = new RedisJsonStore<StoredTool>('adept:stored_tools');
  private versionStore = new RedisJsonStore<ToolVersion[]>('adept:tool_versions');
  private initialized = false;

  private async ensureDir(): Promise<void> {
    if (!this.initialized) {
      await mkdir(TOOLS_DIR, { recursive: true });
      this.initialized = true;
    }
  }

  async save(tool: Omit<StoredTool, 'id' | 'createdAt' | 'updatedAt' | 'version'>): Promise<StoredTool> {
    const id = `tool_${tool.name}`;
    const existing = await this.get(id);

    const now = new Date().toISOString();
    const savedTool: StoredTool = {
      ...tool,
      id,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      version: (existing?.version || 0) + 1,
    };

    if (existing) {
      await this.saveVersion(id, existing);
    }

    await this.store.set(id, savedTool);

    await this.ensureDir();
    const filePath = join(TOOLS_DIR, `${id}.json`);
    await writeFile(filePath, JSON.stringify(savedTool, null, 2));

    logger.info({ id, version: savedTool.version }, '[ToolStorage] Tool saved');

    return savedTool;
  }

  async get(id: string): Promise<StoredTool | null> {
    const tool = await this.store.get(id);
    if (tool) return tool;

    try {
      await this.ensureDir();
      const filePath = join(TOOLS_DIR, `${id}.json`);
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as StoredTool;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    await this.store.delete(id);
    await this.versionStore.delete(id);

    try {
      await this.ensureDir();
      const filePath = join(TOOLS_DIR, `${id}.json`);
      await unlink(filePath);
    } catch {
      // File might not exist
    }

    logger.info({ id }, '[ToolStorage] Tool deleted');
    return true;
  }

  async list(options: {
    userId?: string;
    workspaceId?: string;
    tags?: string[];
    source?: StoredTool['source'];
  } = {}): Promise<StoredTool[]> {
    const allTools = await this.loadAllTools();

    return allTools.filter((tool) => {
      if (tool.isPublic) return true;
      if (options.userId && tool.createdBy === options.userId) return true;
      if (options.workspaceId && tool.workspaceId === options.workspaceId) return true;

      if (options.tags && options.tags.length > 0) {
        if (!tool.tags?.some((t) => options.tags!.includes(t))) return false;
      }

      if (options.source && tool.source !== options.source) return false;

      return false;
    });
  }

  async listAll(): Promise<StoredTool[]> {
    return await this.loadAllTools();
  }

  async search(query: string, options: { userId?: string; workspaceId?: string } = {}): Promise<StoredTool[]> {
    const tools = await this.list(options);
    const queryLower = query.toLowerCase();

    return tools.filter((tool) => {
      return (
        tool.name.toLowerCase().includes(queryLower) ||
        tool.description.toLowerCase().includes(queryLower) ||
        tool.tags?.some((t) => t.toLowerCase().includes(queryLower))
      );
    });
  }

  private async loadAllTools(): Promise<StoredTool[]> {
    const redisTools = await this.store.list();

    await this.ensureDir();
    const files = await readdir(TOOLS_DIR).catch(() => []);
    const fileTools: StoredTool[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const id = file.replace('.json', '');
      if (redisTools.some((t) => t.id === id)) continue;

      try {
        const content = await readFile(join(TOOLS_DIR, file), 'utf-8');
        fileTools.push(JSON.parse(content) as StoredTool);
      } catch {
        // Skip invalid files
      }
    }

    return [...redisTools, ...fileTools];
  }

  private async saveVersion(id: string, tool: StoredTool): Promise<void> {
    const versions = (await this.versionStore.get(id)) || [];
    
    versions.push({
      version: tool.version,
      tool,
      savedAt: new Date().toISOString(),
    });

    while (versions.length > MAX_VERSIONS) {
      versions.shift();
    }

    await this.versionStore.set(id, versions);
  }

  async getVersions(id: string): Promise<ToolVersion[]> {
    return (await this.versionStore.get(id)) || [];
  }

  async restoreVersion(id: string, version: number): Promise<StoredTool | null> {
    const versions = await this.getVersions(id);
    const targetVersion = versions.find((v) => v.version === version);

    if (!targetVersion) {
      return null;
    }

    const {
      id: storedId,
      createdAt: storedCreatedAt,
      updatedAt: storedUpdatedAt,
      version: storedVersion,
      ...rest
    } = targetVersion.tool;
    void storedId;
    void storedCreatedAt;
    void storedUpdatedAt;
    void storedVersion;
    return await this.save(rest);
  }

  async export(options: { userId?: string; workspaceId?: string } = {}): Promise<string> {
    const tools = await this.list(options);
    return JSON.stringify(tools, null, 2);
  }

  async import(json: string, userId: string, workspaceId?: string): Promise<{ imported: number; errors: string[] }> {
    const errors: string[] = [];
    let imported = 0;

    try {
      const tools = JSON.parse(json) as StoredTool[];

      for (const tool of tools) {
        try {
          await this.save({
            ...tool,
            createdBy: userId,
            workspaceId,
            isPublic: false,
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

  async getStats(): Promise<{
    totalTools: number;
    bySource: Record<string, number>;
    byWorkspace: Record<string, number>;
    publicTools: number;
  }> {
    const tools = await this.store.list();

    const bySource: Record<string, number> = {};
    const byWorkspace: Record<string, number> = {};
    let publicTools = 0;

    for (const tool of tools) {
      bySource[tool.source] = (bySource[tool.source] || 0) + 1;
      if (tool.workspaceId) {
        byWorkspace[tool.workspaceId] = (byWorkspace[tool.workspaceId] || 0) + 1;
      }
      if (tool.isPublic) publicTools++;
    }

    return {
      totalTools: tools.length,
      bySource,
      byWorkspace,
      publicTools,
    };
  }
}

export const toolStorage = new ToolStorage();
