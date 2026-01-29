import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';

export interface OutcomeMetrics {
  tool: string;
  integrationId: string;
  period: 'hour' | 'day' | 'week';
  periodStart: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  errorTypes: Record<string, number>;
  lastFailure?: string;
  lastSuccess?: string;
}

interface OutcomeRecord {
  tool: string;
  integrationId: string;
  timestamp: string;
  success: boolean;
  duration: number;
  errorType?: string;
  errorMessage?: string;
}

export interface Anomaly {
  tool: string;
  integrationId: string;
  type: 'error_spike' | 'latency_spike' | 'volume_drop' | 'new_error_type';
  severity: 'low' | 'medium' | 'high';
  description: string;
  detectedAt: string;
  baseline: number;
  current: number;
}

export interface DriftReport {
  tool: string;
  integrationId: string;
  period: string;
  successRateChange: number;
  avgDurationChange: number;
  volumeChange: number;
  newErrorTypes: string[];
  isSignificant: boolean;
}

const METRICS_RETENTION_HOURS = 168;
const ANOMALY_THRESHOLD_ERROR_RATE = 0.2;
const ANOMALY_THRESHOLD_LATENCY = 2.0;
const ANOMALY_THRESHOLD_VOLUME = 0.5;

export class OutcomeMonitor {
  private recordsStore = new RedisJsonStore<OutcomeRecord[]>('adept:outcome_records');
  private metricsCache = new RedisJsonStore<OutcomeMetrics>('adept:outcome_metrics');
  private anomaliesStore = new RedisJsonStore<Anomaly[]>('adept:anomalies');

  async recordOutcome(
    tool: string,
    integrationId: string,
    success: boolean,
    duration: number,
    error?: { type?: string; message?: string },
  ): Promise<void> {
    const record: OutcomeRecord = {
      tool,
      integrationId,
      timestamp: new Date().toISOString(),
      success,
      duration,
      errorType: error?.type,
      errorMessage: error?.message,
    };

    const key = `${tool}:${integrationId}`;
    const records = (await this.recordsStore.get(key)) || [];
    records.push(record);

    const cutoff = new Date(Date.now() - METRICS_RETENTION_HOURS * 60 * 60 * 1000);
    const filtered = records.filter((r) => new Date(r.timestamp) >= cutoff);

    await this.recordsStore.set(key, filtered);
    await this.updateMetrics(tool, integrationId);
  }

  private async updateMetrics(tool: string, integrationId: string): Promise<void> {
    const key = `${tool}:${integrationId}`;
    const records = (await this.recordsStore.get(key)) || [];

    for (const period of ['hour', 'day', 'week'] as const) {
      const periodMs = period === 'hour' ? 60 * 60 * 1000 : period === 'day' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      const cutoff = new Date(Date.now() - periodMs);
      const periodRecords = records.filter((r) => new Date(r.timestamp) >= cutoff);

      if (periodRecords.length === 0) continue;

      const metrics = this.calculateMetrics(tool, integrationId, period, periodRecords);
      await this.metricsCache.set(`${key}:${period}`, metrics);
    }
  }

  private calculateMetrics(
    tool: string,
    integrationId: string,
    period: 'hour' | 'day' | 'week',
    records: OutcomeRecord[],
  ): OutcomeMetrics {
    const durations = records.map((r) => r.duration).sort((a, b) => a - b);
    const successRecords = records.filter((r) => r.success);
    const failureRecords = records.filter((r) => !r.success);

    const errorTypes: Record<string, number> = {};
    for (const record of failureRecords) {
      const type = record.errorType || 'unknown';
      errorTypes[type] = (errorTypes[type] || 0) + 1;
    }

    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    return {
      tool,
      integrationId,
      period,
      periodStart: new Date(
        Date.now() - (period === 'hour' ? 60 * 60 * 1000 : period === 'day' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000),
      ).toISOString(),
      totalCalls: records.length,
      successCount: successRecords.length,
      failureCount: failureRecords.length,
      avgDuration,
      minDuration: durations[0] || 0,
      maxDuration: durations[durations.length - 1] || 0,
      p50Duration: this.percentile(durations, 50),
      p95Duration: this.percentile(durations, 95),
      p99Duration: this.percentile(durations, 99),
      errorTypes,
      lastFailure: failureRecords.length > 0 ? failureRecords[failureRecords.length - 1].timestamp : undefined,
      lastSuccess: successRecords.length > 0 ? successRecords[successRecords.length - 1].timestamp : undefined,
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  async getMetrics(tool: string, integrationId: string, period: 'hour' | 'day' | 'week'): Promise<OutcomeMetrics | null> {
    const key = `${tool}:${integrationId}:${period}`;
    return await this.metricsCache.get(key);
  }

  async getAllMetrics(period: 'hour' | 'day' | 'week' = 'day'): Promise<OutcomeMetrics[]> {
    const allMetrics = await this.metricsCache.list();
    return allMetrics.filter((m) => m.period === period);
  }

  async detectAnomalies(): Promise<Anomaly[]> {
    const anomalies: Anomaly[] = [];
    const hourMetrics = await this.getAllMetrics('hour');
    const dayMetrics = await this.getAllMetrics('day');

    const dayByTool = new Map<string, OutcomeMetrics>();
    for (const m of dayMetrics) {
      dayByTool.set(`${m.tool}:${m.integrationId}`, m);
    }

    for (const hourly of hourMetrics) {
      const key = `${hourly.tool}:${hourly.integrationId}`;
      const daily = dayByTool.get(key);
      if (!daily || daily.totalCalls < 10) continue;

      const hourlyErrorRate = hourly.totalCalls > 0 ? hourly.failureCount / hourly.totalCalls : 0;
      const dailyErrorRate = daily.totalCalls > 0 ? daily.failureCount / daily.totalCalls : 0;

      if (hourlyErrorRate > dailyErrorRate + ANOMALY_THRESHOLD_ERROR_RATE && hourly.failureCount >= 3) {
        anomalies.push({
          tool: hourly.tool,
          integrationId: hourly.integrationId,
          type: 'error_spike',
          severity: hourlyErrorRate > 0.5 ? 'high' : hourlyErrorRate > 0.3 ? 'medium' : 'low',
          description: `Error rate spiked from ${(dailyErrorRate * 100).toFixed(1)}% to ${(hourlyErrorRate * 100).toFixed(1)}%`,
          detectedAt: new Date().toISOString(),
          baseline: dailyErrorRate,
          current: hourlyErrorRate,
        });
      }

      if (daily.avgDuration > 0 && hourly.avgDuration > daily.avgDuration * ANOMALY_THRESHOLD_LATENCY) {
        anomalies.push({
          tool: hourly.tool,
          integrationId: hourly.integrationId,
          type: 'latency_spike',
          severity: hourly.avgDuration > daily.avgDuration * 3 ? 'high' : 'medium',
          description: `Latency increased from ${daily.avgDuration.toFixed(0)}ms to ${hourly.avgDuration.toFixed(0)}ms`,
          detectedAt: new Date().toISOString(),
          baseline: daily.avgDuration,
          current: hourly.avgDuration,
        });
      }

      const expectedHourlyVolume = daily.totalCalls / 24;
      if (expectedHourlyVolume > 5 && hourly.totalCalls < expectedHourlyVolume * ANOMALY_THRESHOLD_VOLUME) {
        anomalies.push({
          tool: hourly.tool,
          integrationId: hourly.integrationId,
          type: 'volume_drop',
          severity: 'low',
          description: `Call volume dropped from expected ${expectedHourlyVolume.toFixed(0)}/hr to ${hourly.totalCalls}/hr`,
          detectedAt: new Date().toISOString(),
          baseline: expectedHourlyVolume,
          current: hourly.totalCalls,
        });
      }

      const dailyErrorTypes = new Set(Object.keys(daily.errorTypes));
      for (const errorType of Object.keys(hourly.errorTypes)) {
        if (!dailyErrorTypes.has(errorType) && hourly.errorTypes[errorType] >= 2) {
          anomalies.push({
            tool: hourly.tool,
            integrationId: hourly.integrationId,
            type: 'new_error_type',
            severity: 'medium',
            description: `New error type detected: ${errorType}`,
            detectedAt: new Date().toISOString(),
            baseline: 0,
            current: hourly.errorTypes[errorType],
          });
        }
      }
    }

    if (anomalies.length > 0) {
      await this.anomaliesStore.set('latest', anomalies);
      logger.warn({ count: anomalies.length }, '[OutcomeMonitor] Anomalies detected');
    }

    return anomalies;
  }

  async getDriftReport(tool: string, integrationId: string): Promise<DriftReport | null> {
    const dayMetrics = await this.getMetrics(tool, integrationId, 'day');
    const weekMetrics = await this.getMetrics(tool, integrationId, 'week');

    if (!dayMetrics || !weekMetrics || weekMetrics.totalCalls < 10) {
      return null;
    }

    const daySuccessRate = dayMetrics.totalCalls > 0 ? dayMetrics.successCount / dayMetrics.totalCalls : 0;
    const weekSuccessRate = weekMetrics.totalCalls > 0 ? weekMetrics.successCount / weekMetrics.totalCalls : 0;
    const successRateChange = daySuccessRate - weekSuccessRate;

    const avgDurationChange = weekMetrics.avgDuration > 0
      ? (dayMetrics.avgDuration - weekMetrics.avgDuration) / weekMetrics.avgDuration
      : 0;

    const expectedDayVolume = weekMetrics.totalCalls / 7;
    const volumeChange = expectedDayVolume > 0
      ? (dayMetrics.totalCalls - expectedDayVolume) / expectedDayVolume
      : 0;

    const weekErrorTypes = new Set(Object.keys(weekMetrics.errorTypes));
    const newErrorTypes = Object.keys(dayMetrics.errorTypes).filter((t) => !weekErrorTypes.has(t));

    const isSignificant =
      Math.abs(successRateChange) > 0.1 ||
      Math.abs(avgDurationChange) > 0.5 ||
      Math.abs(volumeChange) > 0.5 ||
      newErrorTypes.length > 0;

    return {
      tool,
      integrationId,
      period: 'day vs week',
      successRateChange,
      avgDurationChange,
      volumeChange,
      newErrorTypes,
      isSignificant,
    };
  }

  async getTopFailingTools(limit = 10): Promise<Array<{ tool: string; integrationId: string; failureRate: number; failures: number }>> {
    const metrics = await this.getAllMetrics('day');
    
    return metrics
      .filter((m) => m.totalCalls >= 5)
      .map((m) => ({
        tool: m.tool,
        integrationId: m.integrationId,
        failureRate: m.totalCalls > 0 ? m.failureCount / m.totalCalls : 0,
        failures: m.failureCount,
      }))
      .sort((a, b) => b.failureRate - a.failureRate)
      .slice(0, limit);
  }

  async getSlowestTools(limit = 10): Promise<Array<{ tool: string; integrationId: string; avgDuration: number; p95Duration: number }>> {
    const metrics = await this.getAllMetrics('day');
    
    return metrics
      .filter((m) => m.totalCalls >= 5)
      .map((m) => ({
        tool: m.tool,
        integrationId: m.integrationId,
        avgDuration: m.avgDuration,
        p95Duration: m.p95Duration,
      }))
      .sort((a, b) => b.p95Duration - a.p95Duration)
      .slice(0, limit);
  }
}

export const outcomeMonitor = new OutcomeMonitor();
