import { loadConfig } from './config.js';
import { RedisJsonStore } from './redis.js';
import { logger } from './logger.js';

export interface ScimUserName {
  givenName?: string;
  familyName?: string;
  formatted?: string;
}

export interface ScimEmail {
  value: string;
  primary?: boolean;
  type?: string;
}

export interface ScimGroupMember {
  value: string;
  display?: string;
}

export interface ScimUser {
  id: string;
  userName: string;
  displayName?: string;
  name?: ScimUserName;
  emails?: ScimEmail[];
  active: boolean;
  groups?: ScimGroupMember[];
  externalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScimGroup {
  id: string;
  displayName: string;
  members?: ScimGroupMember[];
  createdAt: string;
  updatedAt: string;
}

export interface IdentityStore {
  listUsers(): Promise<ScimUser[]>;
  getUser(id: string): Promise<ScimUser | null>;
  getUserByUserName(userName: string): Promise<ScimUser | null>;
  setUser(user: ScimUser): Promise<void>;
  deleteUser(id: string): Promise<void>;
  listGroups(): Promise<ScimGroup[]>;
  getGroup(id: string): Promise<ScimGroup | null>;
  setGroup(group: ScimGroup): Promise<void>;
  deleteGroup(id: string): Promise<void>;
}

class MemoryIdentityStore implements IdentityStore {
  private users = new Map<string, ScimUser>();
  private groups = new Map<string, ScimGroup>();

  async listUsers(): Promise<ScimUser[]> {
    return Array.from(this.users.values());
  }

  async getUser(id: string): Promise<ScimUser | null> {
    return this.users.get(id) ?? null;
  }

  async getUserByUserName(userName: string): Promise<ScimUser | null> {
    const normalized = userName.toLowerCase();
    for (const user of this.users.values()) {
      if (user.userName.toLowerCase() === normalized) {
        return user;
      }
    }
    return null;
  }

  async setUser(user: ScimUser): Promise<void> {
    this.users.set(user.id, user);
  }

  async deleteUser(id: string): Promise<void> {
    this.users.delete(id);
  }

  async listGroups(): Promise<ScimGroup[]> {
    return Array.from(this.groups.values());
  }

  async getGroup(id: string): Promise<ScimGroup | null> {
    return this.groups.get(id) ?? null;
  }

  async setGroup(group: ScimGroup): Promise<void> {
    this.groups.set(group.id, group);
  }

  async deleteGroup(id: string): Promise<void> {
    this.groups.delete(id);
  }
}

class RedisIdentityStore implements IdentityStore {
  private userStore = new RedisJsonStore<ScimUser>('adept:scim_users');
  private groupStore = new RedisJsonStore<ScimGroup>('adept:scim_groups');

  async listUsers(): Promise<ScimUser[]> {
    return await this.userStore.list();
  }

  async getUser(id: string): Promise<ScimUser | null> {
    return await this.userStore.get(id);
  }

  async getUserByUserName(userName: string): Promise<ScimUser | null> {
    const users = await this.userStore.list();
    const normalized = userName.toLowerCase();
    return users.find((user) => user.userName.toLowerCase() === normalized) ?? null;
  }

  async setUser(user: ScimUser): Promise<void> {
    await this.userStore.set(user.id, user);
  }

  async deleteUser(id: string): Promise<void> {
    await this.userStore.delete(id);
  }

  async listGroups(): Promise<ScimGroup[]> {
    return await this.groupStore.list();
  }

  async getGroup(id: string): Promise<ScimGroup | null> {
    return await this.groupStore.get(id);
  }

  async setGroup(group: ScimGroup): Promise<void> {
    await this.groupStore.set(group.id, group);
  }

  async deleteGroup(id: string): Promise<void> {
    await this.groupStore.delete(id);
  }
}

export const createIdentityStore = (): IdentityStore => {
  const config = loadConfig();
  if (config.redisUrl) {
    logger.info('[SCIM] Using Redis store');
    return new RedisIdentityStore();
  }
  logger.warn('[SCIM] Redis not configured, using in-memory store');
  return new MemoryIdentityStore();
};

export const identityStore = createIdentityStore();
