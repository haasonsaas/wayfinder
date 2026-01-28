import { integrationRegistry } from './registry.js';
import { SalesforceIntegration } from './salesforce.js';
import { GitHubIntegration } from './github.js';
import { GoogleDriveIntegration } from './google-drive.js';

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
      console.error(`[Integrations] Failed to register integration:`, error);
    }
  }

  const enabled = integrationRegistry.getEnabled();
  console.log(`[Integrations] ${enabled.length} integrations enabled: ${enabled.map((i) => i.name).join(', ')}`);
}

export { integrationRegistry } from './registry.js';
