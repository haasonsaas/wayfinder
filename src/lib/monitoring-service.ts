import { slackService } from './slack.js';
import { logger } from './logger.js';
import { monitoringStore, type MonitoringConfig, type Severity } from './monitoring-store.js';
import { outcomeMonitor, type Anomaly, type DriftReport } from './outcome-monitor.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const severityRank = (severity: Severity): number => {
  switch (severity) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    default:
      return 1;
  }
};

const shouldSendAlert = (config: MonitoringConfig, severity: Severity): boolean =>
  severityRank(severity) >= severityRank(config.minSeverity);

const formatAnomaly = (anomaly: Anomaly): string =>
  `• ${anomaly.tool} (${anomaly.integrationId}) — ${anomaly.description} [${anomaly.severity}]`;

const formatDrift = (report: DriftReport): string => {
  const changes = [
    `success ${Math.round(report.successRateChange * 100)}%`,
    `latency ${Math.round(report.avgDurationChange * 100)}%`,
    `volume ${Math.round(report.volumeChange * 100)}%`,
  ];
  const errors = report.newErrorTypes.length > 0 ? `new errors: ${report.newErrorTypes.join(', ')}` : 'no new errors';
  return `• ${report.tool} (${report.integrationId}) — ${changes.join(', ')}, ${errors}`;
};

export class MonitoringService {
  private interval?: NodeJS.Timeout;
  private lastAlerts = new Map<string, number>();

  start(): void {
    if (this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      this.runChecks().catch((error) => {
        logger.error({ error }, '[Monitoring] Failed to run checks');
      });
    }, CHECK_INTERVAL_MS);

    this.runChecks().catch((error) => {
      logger.error({ error }, '[Monitoring] Failed initial check');
    });
  }

  private shouldThrottle(key: string, minIntervalMinutes: number): boolean {
    const last = this.lastAlerts.get(key);
    if (!last) return false;
    return Date.now() - last < minIntervalMinutes * 60 * 1000;
  }

  private markAlerted(key: string): void {
    this.lastAlerts.set(key, Date.now());
  }

  private async runChecks(): Promise<void> {
    const config = await monitoringStore.getConfig();
    if (!config.enabled || !config.alertChannelId) {
      return;
    }

    const anomalies = await outcomeMonitor.detectAnomalies();
    const filtered = anomalies.filter((anomaly) => shouldSendAlert(config, anomaly.severity));

    if (filtered.length > 0) {
      const unique = filtered.filter((anomaly) => {
        const key = `anomaly:${anomaly.tool}:${anomaly.type}`;
        if (this.shouldThrottle(key, config.minIntervalMinutes)) {
          return false;
        }
        this.markAlerted(key);
        return true;
      });

      if (unique.length > 0) {
        const text = ['[Monitoring] Detected anomalies:', ...unique.map(formatAnomaly)].join('\n');
        await slackService.postMessage(config.alertChannelId, text);
      }
    }

    if (config.driftAlertsEnabled) {
      const metrics = await outcomeMonitor.getAllMetrics('day');
      const driftReports: DriftReport[] = [];

      for (const metric of metrics) {
        const report = await outcomeMonitor.getDriftReport(metric.tool, metric.integrationId);
        if (report?.isSignificant) {
          driftReports.push(report);
        }
      }

      const driftAlerts = driftReports.filter((report) => {
        const key = `drift:${report.tool}:${report.integrationId}`;
        if (this.shouldThrottle(key, config.minIntervalMinutes * 4)) {
          return false;
        }
        this.markAlerted(key);
        return true;
      });

      if (driftAlerts.length > 0) {
        const text = ['[Monitoring] Drift signals detected:', ...driftAlerts.map(formatDrift)].join('\n');
        await slackService.postMessage(config.alertChannelId, text);
      }
    }
  }
}

export const monitoringService = new MonitoringService();
