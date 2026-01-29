import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';

export interface RateLimitConfig {
  tool: string;
  maxPerMinute: number;
  maxPerHour: number;
  maxPerDay: number;
  cooldownSeconds: number;
}

interface RateLimitRecord {
  tool: string;
  userId: string;
  minuteCount: number;
  minuteWindow: number;
  hourCount: number;
  hourWindow: number;
  dayCount: number;
  dayWindow: number;
  cooldownUntil?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  reason?: string;
  remaining: {
    minute: number;
    hour: number;
    day: number;
  };
}

const DEFAULT_LIMITS: RateLimitConfig = {
  tool: '*',
  maxPerMinute: 30,
  maxPerHour: 300,
  maxPerDay: 1000,
  cooldownSeconds: 60,
};

const TOOL_SPECIFIC_LIMITS: Record<string, Partial<RateLimitConfig>> = {
  'meta_tool_builder_create_tool': { maxPerHour: 10, maxPerDay: 50 },
  'computer_use_take_screenshot': { maxPerMinute: 10, maxPerHour: 100 },
  'computer_use_click': { maxPerMinute: 60, maxPerHour: 500 },
};

export class RateLimiter {
  private store = new RedisJsonStore<RateLimitRecord>('adept:rate_limits');
  private customLimits: Map<string, RateLimitConfig> = new Map();

  constructor() {
    for (const [tool, limits] of Object.entries(TOOL_SPECIFIC_LIMITS)) {
      this.customLimits.set(tool, { ...DEFAULT_LIMITS, ...limits, tool });
    }
  }

  setLimit(config: RateLimitConfig): void {
    this.customLimits.set(config.tool, config);
  }

  private getLimit(tool: string): RateLimitConfig {
    return this.customLimits.get(tool) || DEFAULT_LIMITS;
  }

  async check(tool: string, userId: string): Promise<RateLimitResult> {
    const key = `${tool}:${userId}`;
    const now = Date.now();
    const limit = this.getLimit(tool);

    let record = await this.store.get(key);

    if (!record) {
      record = {
        tool,
        userId,
        minuteCount: 0,
        minuteWindow: now,
        hourCount: 0,
        hourWindow: now,
        dayCount: 0,
        dayWindow: now,
      };
    }

    if (record.cooldownUntil && record.cooldownUntil > now) {
      const retryAfter = Math.ceil((record.cooldownUntil - now) / 1000);
      return {
        allowed: false,
        retryAfter,
        reason: `Rate limited. Retry after ${retryAfter} seconds.`,
        remaining: { minute: 0, hour: 0, day: 0 },
      };
    }

    const minuteAgo = now - 60 * 1000;
    const hourAgo = now - 60 * 60 * 1000;
    const dayAgo = now - 24 * 60 * 60 * 1000;

    if (record.minuteWindow < minuteAgo) {
      record.minuteCount = 0;
      record.minuteWindow = now;
    }
    if (record.hourWindow < hourAgo) {
      record.hourCount = 0;
      record.hourWindow = now;
    }
    if (record.dayWindow < dayAgo) {
      record.dayCount = 0;
      record.dayWindow = now;
    }

    const remaining = {
      minute: Math.max(0, limit.maxPerMinute - record.minuteCount),
      hour: Math.max(0, limit.maxPerHour - record.hourCount),
      day: Math.max(0, limit.maxPerDay - record.dayCount),
    };

    if (record.minuteCount >= limit.maxPerMinute) {
      const retryAfter = Math.ceil((record.minuteWindow + 60 * 1000 - now) / 1000);
      return {
        allowed: false,
        retryAfter,
        reason: `Minute limit exceeded (${limit.maxPerMinute}/min)`,
        remaining,
      };
    }

    if (record.hourCount >= limit.maxPerHour) {
      const retryAfter = Math.ceil((record.hourWindow + 60 * 60 * 1000 - now) / 1000);
      return {
        allowed: false,
        retryAfter,
        reason: `Hour limit exceeded (${limit.maxPerHour}/hr)`,
        remaining,
      };
    }

    if (record.dayCount >= limit.maxPerDay) {
      const retryAfter = Math.ceil((record.dayWindow + 24 * 60 * 60 * 1000 - now) / 1000);
      return {
        allowed: false,
        retryAfter,
        reason: `Day limit exceeded (${limit.maxPerDay}/day)`,
        remaining,
      };
    }

    return { allowed: true, remaining };
  }

  async record(tool: string, userId: string): Promise<void> {
    const key = `${tool}:${userId}`;
    const now = Date.now();

    let record = await this.store.get(key);

    if (!record) {
      record = {
        tool,
        userId,
        minuteCount: 0,
        minuteWindow: now,
        hourCount: 0,
        hourWindow: now,
        dayCount: 0,
        dayWindow: now,
      };
    }

    const minuteAgo = now - 60 * 1000;
    const hourAgo = now - 60 * 60 * 1000;
    const dayAgo = now - 24 * 60 * 60 * 1000;

    if (record.minuteWindow < minuteAgo) {
      record.minuteCount = 0;
      record.minuteWindow = now;
    }
    if (record.hourWindow < hourAgo) {
      record.hourCount = 0;
      record.hourWindow = now;
    }
    if (record.dayWindow < dayAgo) {
      record.dayCount = 0;
      record.dayWindow = now;
    }

    record.minuteCount++;
    record.hourCount++;
    record.dayCount++;

    await this.store.set(key, record);
  }

  async setCooldown(tool: string, userId: string, seconds?: number): Promise<void> {
    const key = `${tool}:${userId}`;
    const limit = this.getLimit(tool);
    const cooldownMs = (seconds ?? limit.cooldownSeconds) * 1000;

    let record = await this.store.get(key);
    if (!record) {
      record = {
        tool,
        userId,
        minuteCount: 0,
        minuteWindow: Date.now(),
        hourCount: 0,
        hourWindow: Date.now(),
        dayCount: 0,
        dayWindow: Date.now(),
      };
    }

    record.cooldownUntil = Date.now() + cooldownMs;
    await this.store.set(key, record);

    logger.info({ tool, userId, cooldownSeconds: seconds ?? limit.cooldownSeconds }, '[RateLimiter] Cooldown set');
  }

  async getStatus(userId: string): Promise<Array<{ tool: string; remaining: RateLimitResult['remaining']; cooldownUntil?: number }>> {
    const allRecords = await this.store.list();
    const userRecords = allRecords.filter((r) => r.userId === userId);

    return userRecords.map((record) => {
      const limit = this.getLimit(record.tool);
      const now = Date.now();

      const minuteAgo = now - 60 * 1000;
      const hourAgo = now - 60 * 60 * 1000;
      const dayAgo = now - 24 * 60 * 60 * 1000;

      const minuteCount = record.minuteWindow >= minuteAgo ? record.minuteCount : 0;
      const hourCount = record.hourWindow >= hourAgo ? record.hourCount : 0;
      const dayCount = record.dayWindow >= dayAgo ? record.dayCount : 0;

      return {
        tool: record.tool,
        remaining: {
          minute: Math.max(0, limit.maxPerMinute - minuteCount),
          hour: Math.max(0, limit.maxPerHour - hourCount),
          day: Math.max(0, limit.maxPerDay - dayCount),
        },
        cooldownUntil: record.cooldownUntil && record.cooldownUntil > now ? record.cooldownUntil : undefined,
      };
    });
  }

  async reset(tool: string, userId: string): Promise<void> {
    const key = `${tool}:${userId}`;
    await this.store.delete(key);
    logger.info({ tool, userId }, '[RateLimiter] Reset');
  }

  async resetUser(userId: string): Promise<number> {
    const allRecords = await this.store.list();
    let count = 0;

    for (const record of allRecords) {
      if (record.userId === userId) {
        const key = `${record.tool}:${userId}`;
        await this.store.delete(key);
        count++;
      }
    }

    logger.info({ userId, count }, '[RateLimiter] User reset');
    return count;
  }
}

export const rateLimiter = new RateLimiter();
