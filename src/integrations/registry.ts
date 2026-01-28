import type { Integration, SearchResult } from '../types/index.js';
import { loadConfig } from '../lib/config.js';
import { logger } from '../lib/logger.js';

class IntegrationRegistry {
  private integrations: Map<string, Integration> = new Map();

  register(integration: Integration): void {
    this.integrations.set(integration.id, integration);
    logger.info({ integration: integration.name }, '[Registry] Registered integration');
  }

  get(id: string): Integration | undefined {
    return this.integrations.get(id);
  }

  getAll(): Integration[] {
    return Array.from(this.integrations.values());
  }

  getEnabled(): Integration[] {
    const config = loadConfig();
    const allowlist = new Set(config.enabledIntegrations.map((id) => id.trim()).filter(Boolean));
    return this.getAll().filter((integration) => {
      if (!integration.isEnabled()) {
        return false;
      }
      if (allowlist.size === 0) {
        return true;
      }
      return allowlist.has(integration.id);
    });
  }

  async searchAll(query: string): Promise<SearchResult[]> {
    const enabled = this.getEnabled().filter((i) => i.search);
    const results = await Promise.all(
      enabled.map(async (integration) => {
        try {
          return (await integration.search?.(query)) || [];
        } catch (error) {
          logger.error({ error, integration: integration.id }, '[Registry] Search error');
          return [];
        }
      }),
    );
    return results.flat();
  }
}

export const integrationRegistry = new IntegrationRegistry();
