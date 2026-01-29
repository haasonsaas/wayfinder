import { createClient, type RedisClientType } from 'redis';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

let client: RedisClientType | null = null;
let connectPromise: Promise<RedisClientType | null> | null = null;
let disabled = false;

export const getRedisClient = async (): Promise<RedisClientType | null> => {
  if (disabled) {
    return null;
  }

  if (client) {
    return client;
  }

  const { redisUrl } = loadConfig();
  if (!redisUrl) {
    return null;
  }

  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        const nextClient: RedisClientType = createClient({ url: redisUrl });
        nextClient.on('error', (error) => {
          logger.warn({ error }, '[Redis] Client error');
        });
        await nextClient.connect();
        client = nextClient;
        logger.info('[Redis] Connected');
        return client;
      } catch (error) {
        disabled = true;
        logger.warn({ error }, '[Redis] Failed to connect, disabling Redis');
        return null;
      }
    })();
  }

  return connectPromise;
};

export const closeRedisClient = async (): Promise<void> => {
  if (!client) {
    return;
  }
  try {
    await client.quit();
  } catch (error) {
    logger.warn({ error }, '[Redis] Failed to close client');
  } finally {
    client = null;
    connectPromise = null;
  }
};

export class RedisJsonStore<T> {
  constructor(private namespace: string) {}

  private async getClient(): Promise<RedisClientType | null> {
    return await getRedisClient();
  }

  async get(id: string): Promise<T | null> {
    const redis = await this.getClient();
    if (!redis) {
      return null;
    }
    const value = await redis.hGet(this.namespace, id);
    if (!value) {
      return null;
    }
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      logger.warn({ error, id }, '[Redis] Failed to parse JSON');
      return null;
    }
  }

  async set(id: string, value: T): Promise<void> {
    const redis = await this.getClient();
    if (!redis) {
      return;
    }
    await redis.hSet(this.namespace, id, JSON.stringify(value));
  }

  async delete(id: string): Promise<void> {
    const redis = await this.getClient();
    if (!redis) {
      return;
    }
    await redis.hDel(this.namespace, id);
  }

  async list(): Promise<T[]> {
    const redis = await this.getClient();
    if (!redis) {
      return [];
    }
    const entries = await redis.hGetAll(this.namespace);
    return Object.values(entries)
      .map((value) => {
        try {
          return JSON.parse(value) as T;
        } catch (error) {
          logger.warn({ error }, '[Redis] Failed to parse JSON');
          return null;
        }
      })
      .filter((value): value is T => value !== null);
  }
}
