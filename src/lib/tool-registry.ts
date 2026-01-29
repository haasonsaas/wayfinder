import { z } from 'zod';
import type { ToolSet } from 'ai';
import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';

export interface ToolMetadata {
  name: string;
  qualifiedName: string;
  integrationId: string;
  description: string;
  inputSchema: z.ZodSchema;
  usageCount: number;
  lastUsed: Date | null;
  isDeferred: boolean;
  isUserDefined: boolean;
  createdAt: Date;
  version: number;
}

export interface ToolSummary {
  name: string;
  qualifiedName: string;
  integrationId: string;
  description: string;
  usageCount: number;
  isHot: boolean;
}

interface ToolUsageRecord {
  qualifiedName: string;
  usageCount: number;
  lastUsed: string;
}

const HOT_TOOL_THRESHOLD = 10;
const MAX_HOT_TOOLS = 10;
const MIN_HOT_TOOLS = 5;

export class ToolRegistry {
  private tools: Map<string, ToolMetadata> = new Map();
  private toolImplementations: Map<string, ToolSet[string]> = new Map();
  private usageStore = new RedisJsonStore<ToolUsageRecord>('adept:tool_usage');
  private hotTools: Set<string> = new Set();

  private resolveInputSchema(toolDef: ToolSet[string]): z.ZodSchema {
    const typed = toolDef as { inputSchema?: z.ZodSchema; parameters?: z.ZodSchema };
    const candidate = typed.inputSchema ?? typed.parameters;

    if (candidate && typeof (candidate as z.ZodSchema).safeParse === 'function') {
      return candidate as z.ZodSchema;
    }

    return z.object({});
  }

  async registerTool(
    qualifiedName: string,
    integrationId: string,
    toolDef: ToolSet[string],
    options: { isUserDefined?: boolean; version?: number } = {},
  ): Promise<void> {
    const description = typeof toolDef.description === 'string' ? toolDef.description : '';
    const prefix = `${integrationId}_`;
    const name = qualifiedName.startsWith(prefix)
      ? qualifiedName.slice(prefix.length)
      : qualifiedName;

    const existingUsage = await this.usageStore.get(qualifiedName);
    const usageCount = existingUsage?.usageCount ?? 0;
    const lastUsed = existingUsage?.lastUsed ? new Date(existingUsage.lastUsed) : null;

    const metadata: ToolMetadata = {
      name,
      qualifiedName,
      integrationId,
      description,
      inputSchema: this.resolveInputSchema(toolDef),
      usageCount,
      lastUsed,
      isDeferred: usageCount < HOT_TOOL_THRESHOLD,
      isUserDefined: options.isUserDefined ?? false,
      createdAt: new Date(),
      version: options.version ?? 1,
    };

    this.tools.set(qualifiedName, metadata);
    this.toolImplementations.set(qualifiedName, toolDef);

    if (!metadata.isDeferred) {
      this.hotTools.add(qualifiedName);
    }

    logger.debug({ qualifiedName, integrationId, isDeferred: metadata.isDeferred }, '[ToolRegistry] Tool registered');
  }

  async recordUsage(qualifiedName: string): Promise<void> {
    const metadata = this.tools.get(qualifiedName);
    if (!metadata) return;

    metadata.usageCount++;
    metadata.lastUsed = new Date();

    await this.usageStore.set(qualifiedName, {
      qualifiedName,
      usageCount: metadata.usageCount,
      lastUsed: metadata.lastUsed.toISOString(),
    });

    if (metadata.usageCount >= HOT_TOOL_THRESHOLD && metadata.isDeferred) {
      await this.promoteToHot(qualifiedName);
    }
  }

  private async promoteToHot(qualifiedName: string): Promise<void> {
    const metadata = this.tools.get(qualifiedName);
    if (!metadata) return;

    if (this.hotTools.size >= MAX_HOT_TOOLS) {
      const coldestHot = this.findColdestHotTool();
      if (coldestHot && metadata.usageCount > (this.tools.get(coldestHot)?.usageCount ?? 0)) {
        this.demoteFromHot(coldestHot);
      } else {
        return;
      }
    }

    metadata.isDeferred = false;
    this.hotTools.add(qualifiedName);
    logger.info({ qualifiedName }, '[ToolRegistry] Tool promoted to hot');
  }

  private demoteFromHot(qualifiedName: string): void {
    if (this.hotTools.size <= MIN_HOT_TOOLS) return;

    const metadata = this.tools.get(qualifiedName);
    if (metadata) {
      metadata.isDeferred = true;
      this.hotTools.delete(qualifiedName);
      logger.info({ qualifiedName }, '[ToolRegistry] Tool demoted from hot');
    }
  }

  private findColdestHotTool(): string | null {
    let coldest: string | null = null;
    let lowestUsage = Infinity;

    for (const name of this.hotTools) {
      const metadata = this.tools.get(name);
      if (metadata && metadata.usageCount < lowestUsage) {
        lowestUsage = metadata.usageCount;
        coldest = name;
      }
    }

    return coldest;
  }

  searchTools(query: string, limit = 20): ToolSummary[] {
    const results: Array<{ summary: ToolSummary; score: number }> = [];
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    for (const metadata of this.tools.values()) {
      const score = this.calculateSearchScore(metadata, queryLower, queryTerms);
      if (score > 0) {
        results.push({
          summary: {
            name: metadata.name,
            qualifiedName: metadata.qualifiedName,
            integrationId: metadata.integrationId,
            description: metadata.description,
            usageCount: metadata.usageCount,
            isHot: this.hotTools.has(metadata.qualifiedName),
          },
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map((r) => r.summary);
  }

  private calculateSearchScore(metadata: ToolMetadata, queryLower: string, queryTerms: string[]): number {
    let score = 0;
    const nameLower = metadata.name.toLowerCase();
    const qualifiedLower = metadata.qualifiedName.toLowerCase();
    const descLower = metadata.description.toLowerCase();
    const integrationLower = metadata.integrationId.toLowerCase();

    if (nameLower === queryLower || qualifiedLower === queryLower) {
      score += 100;
    }

    if (nameLower.includes(queryLower) || qualifiedLower.includes(queryLower)) {
      score += 50;
    }

    if (integrationLower.includes(queryLower)) {
      score += 30;
    }

    for (const term of queryTerms) {
      if (nameLower.includes(term)) score += 20;
      if (descLower.includes(term)) score += 10;
      if (integrationLower.includes(term)) score += 15;
    }

    const termFrequency = this.calculateBM25Score(descLower, queryTerms);
    score += termFrequency * 5;

    score += Math.log(metadata.usageCount + 1) * 2;

    return score;
  }

  private calculateBM25Score(text: string, terms: string[]): number {
    const k1 = 1.2;
    const b = 0.75;
    const avgDocLength = 50;
    const docLength = text.split(/\s+/).length;

    let score = 0;
    for (const term of terms) {
      const termCount = (text.match(new RegExp(term, 'gi')) || []).length;
      if (termCount > 0) {
        const tf = (termCount * (k1 + 1)) / (termCount + k1 * (1 - b + b * (docLength / avgDocLength)));
        score += tf;
      }
    }

    return score;
  }

  searchByRegex(pattern: string, limit = 20): ToolSummary[] {
    const results: ToolSummary[] = [];

    try {
      const regex = new RegExp(pattern, 'i');

      for (const metadata of this.tools.values()) {
        if (
          regex.test(metadata.name) ||
          regex.test(metadata.qualifiedName) ||
          regex.test(metadata.description)
        ) {
          results.push({
            name: metadata.name,
            qualifiedName: metadata.qualifiedName,
            integrationId: metadata.integrationId,
            description: metadata.description,
            usageCount: metadata.usageCount,
            isHot: this.hotTools.has(metadata.qualifiedName),
          });

          if (results.length >= limit) break;
        }
      }
    } catch {
      logger.warn({ pattern }, '[ToolRegistry] Invalid regex pattern');
    }

    return results;
  }

  getHotTools(): ToolSet {
    const tools: ToolSet = {};

    for (const qualifiedName of this.hotTools) {
      const impl = this.toolImplementations.get(qualifiedName);
      if (impl) {
        tools[qualifiedName] = impl;
      }
    }

    return tools;
  }

  getDeferredTools(): ToolSummary[] {
    const deferred: ToolSummary[] = [];

    for (const metadata of this.tools.values()) {
      if (metadata.isDeferred) {
        deferred.push({
          name: metadata.name,
          qualifiedName: metadata.qualifiedName,
          integrationId: metadata.integrationId,
          description: metadata.description,
          usageCount: metadata.usageCount,
          isHot: false,
        });
      }
    }

    return deferred;
  }

  getTool(qualifiedName: string): ToolSet[string] | undefined {
    return this.toolImplementations.get(qualifiedName);
  }

  getToolMetadata(qualifiedName: string): ToolMetadata | undefined {
    return this.tools.get(qualifiedName);
  }

  getAllTools(): ToolSet {
    const tools: ToolSet = {};

    for (const [name, impl] of this.toolImplementations) {
      tools[name] = impl;
    }

    return tools;
  }

  listTools(integrationId?: string): ToolSummary[] {
    const summaries: ToolSummary[] = [];

    for (const metadata of this.tools.values()) {
      if (integrationId && metadata.integrationId !== integrationId) continue;

      summaries.push({
        name: metadata.name,
        qualifiedName: metadata.qualifiedName,
        integrationId: metadata.integrationId,
        description: metadata.description,
        usageCount: metadata.usageCount,
        isHot: this.hotTools.has(metadata.qualifiedName),
      });
    }

    return summaries.sort((a, b) => b.usageCount - a.usageCount);
  }

  getStats(): {
    totalTools: number;
    hotTools: number;
    deferredTools: number;
    userDefinedTools: number;
    byIntegration: Record<string, number>;
  } {
    const byIntegration: Record<string, number> = {};
    let userDefinedCount = 0;

    for (const metadata of this.tools.values()) {
      byIntegration[metadata.integrationId] = (byIntegration[metadata.integrationId] ?? 0) + 1;
      if (metadata.isUserDefined) userDefinedCount++;
    }

    return {
      totalTools: this.tools.size,
      hotTools: this.hotTools.size,
      deferredTools: this.tools.size - this.hotTools.size,
      userDefinedTools: userDefinedCount,
      byIntegration,
    };
  }

  clear(): void {
    this.tools.clear();
    this.toolImplementations.clear();
    this.hotTools.clear();
  }
}

export const toolRegistry = new ToolRegistry();
