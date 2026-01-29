import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAllIntegrations } from '../src/integrations/index.js';
import { integrationRegistry } from '../src/integrations/registry.js';

vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('registerAllIntegrations', () => {
  beforeEach(() => {
    integrationRegistry.clear();
  });

  it('registers built-in integrations via dynamic import', async () => {
    await registerAllIntegrations();

    const ids = integrationRegistry.getAll().map((integration) => integration.id);
    expect(ids).toEqual(expect.arrayContaining(['github', 'salesforce', 'google_drive']));
  });
});
