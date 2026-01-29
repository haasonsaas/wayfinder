import { loadConfig } from './config.js';
import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';

export type Severity = 'low' | 'medium' | 'high';

export interface MonitoringConfig {
  enabled: boolean;
  alertChannelId?: string;
  minSeverity: Severity;
  minIntervalMinutes: number;
  driftAlertsEnabled: boolean;
}

const resolveDefaultConfig = (): MonitoringConfig => {
  const config = loadConfig();
  const env = config.monitoring;
  return {
    enabled: false,
    alertChannelId: env?.alertChannelId,
    minSeverity: env?.minSeverity ?? 'medium',
    minIntervalMinutes: env?.minIntervalMinutes ?? 60,
    driftAlertsEnabled: env?.driftAlertsEnabled ?? true,
  };
};

interface MonitoringStore {
  getConfig(): Promise<MonitoringConfig>;
  setConfig(config: MonitoringConfig): Promise<void>;
}

class MemoryMonitoringStore implements MonitoringStore {
  private config: MonitoringConfig = resolveDefaultConfig();

  async getConfig(): Promise<MonitoringConfig> {
    return { ...this.config };
  }

  async setConfig(config: MonitoringConfig): Promise<void> {
    this.config = { ...config };
  }
}

class RedisMonitoringStore implements MonitoringStore {
  private store = new RedisJsonStore<MonitoringConfig>('adept:monitoring_config');
  private cache: MonitoringConfig | null = null;

  async getConfig(): Promise<MonitoringConfig> {
    if (this.cache) {
      return { ...this.cache };
    }

    const stored = await this.store.get('config');
    if (stored) {
      this.cache = { ...resolveDefaultConfig(), ...stored };
    } else {
      this.cache = resolveDefaultConfig();
      await this.store.set('config', this.cache);
    }

    return { ...this.cache };
  }

  async setConfig(config: MonitoringConfig): Promise<void> {
    this.cache = { ...config };
    await this.store.set('config', this.cache);
  }
}

const createMonitoringStore = (): MonitoringStore => {
  const config = loadConfig();
  if (config.redisUrl) {
    logger.info('[Monitoring] Using Redis store');
    return new RedisMonitoringStore();
  }
  logger.warn('[Monitoring] Redis not configured, using in-memory store');
  return new MemoryMonitoringStore();
};

export const monitoringStore = createMonitoringStore();
export { resolveDefaultConfig };
