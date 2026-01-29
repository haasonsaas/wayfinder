import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseIntegration } from './base.js';
import { integrationRegistry } from './registry.js';
import { logger } from '../lib/logger.js';
import { toolRegistry } from '../lib/tool-registry.js';
import { userToolsManager } from '../lib/user-tools.js';

const EXCLUDED_MODULES = new Set(['index', 'base', 'registry']);
const VALID_EXTENSIONS = new Set(['.ts', '.js']);

const isIntegrationFile = (file: string) => {
  if (file.endsWith('.d.ts') || file.endsWith('.map')) {
    return false;
  }

  const ext = path.extname(file);
  if (!VALID_EXTENSIONS.has(ext)) {
    return false;
  }

  const base = path.basename(file, ext);
  if (EXCLUDED_MODULES.has(base)) {
    return false;
  }

  return true;
};

const resolveIntegrationClasses = (module: Record<string, unknown>) =>
  Object.values(module).filter((candidate): candidate is new () => BaseIntegration => {
    if (typeof candidate !== 'function') {
      return false;
    }

    const prototype = candidate.prototype;
    if (!prototype || typeof prototype !== 'object') {
      return false;
    }

    return prototype instanceof BaseIntegration;
  });

export async function registerAllIntegrations(): Promise<void> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const entries = await readdir(dir);
  const files = entries.filter(isIntegrationFile).sort();

  for (const file of files) {
    try {
      const base = path.basename(file, path.extname(file));
      const module = (await import(/* @vite-ignore */ `./${base}.js`)) as Record<string, unknown>;
      const classes = resolveIntegrationClasses(module);

      for (const IntegrationClass of classes) {
        try {
          integrationRegistry.register(new IntegrationClass());
        } catch (error) {
          logger.error({ error }, '[Integrations] Failed to register integration');
        }
      }
    } catch (error) {
      logger.error({ error, file }, '[Integrations] Failed to load integration module');
    }
  }

  const enabled = integrationRegistry.getEnabled();

  for (const integration of enabled) {
    const tools = integration.getTools();
    for (const [toolName, toolDef] of Object.entries(tools)) {
      const qualifiedName = `${integration.id}_${toolName}`;
      await toolRegistry.registerTool(qualifiedName, integration.id, toolDef);
    }
  }

  await userToolsManager.loadAllTools();

  for (const integration of enabled) {
    const candidate = integration as { loadStoredTools?: () => Promise<void> };
    if (typeof candidate.loadStoredTools === 'function') {
      await candidate.loadStoredTools();
    }
  }

  logger.info(
    { count: enabled.length, enabled: enabled.map((i) => i.name) },
    '[Integrations] Enabled integrations',
  );
}

export { integrationRegistry } from './registry.js';
