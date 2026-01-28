import { integrationRegistry } from './registry.js';
import { SalesforceIntegration } from './salesforce.js';
import { GitHubIntegration } from './github.js';
import { GoogleDriveIntegration } from './google-drive.js';
import { logger } from '../lib/logger.js';

// TODO: Implement dynamic loading if list grows
const AVAILABLE_INTEGRATIONS = [
  SalesforceIntegration,
  GitHubIntegration,
  GoogleDriveIntegration,
];

export function registerAllIntegrations(): void {
  for (const IntegrationClass of AVAILABLE_INTEGRATIONS) {
    try {
      integrationRegistry.register(new IntegrationClass());
    } catch (error) {
      logger.error({ error }, '[Integrations] Failed to register integration');
    }
  }

  const enabled = integrationRegistry.getEnabled();
  logger.info(
    { count: enabled.length, enabled: enabled.map((i) => i.name) },
    '[Integrations] Enabled integrations',
  );
}

export { integrationRegistry } from './registry.js';
