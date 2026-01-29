import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

export type IntegrationTokens = Record<string, Record<string, unknown>>;

interface TokenStoreOptions {
  storePath?: string;
  secret?: string;
  autoEncrypt?: boolean;
}

interface EncryptedPayload {
  version: 1;
  encrypted: true;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const DEFAULT_STORE_PATH = path.join(process.cwd(), '.data', 'tokens.json');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

const scryptAsync = promisify(scrypt);

const isErrno = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isEncryptedPayload = (value: unknown): value is EncryptedPayload =>
  isRecord(value) &&
  value.encrypted === true &&
  value.version === 1 &&
  typeof value.salt === 'string' &&
  typeof value.iv === 'string' &&
  typeof value.tag === 'string' &&
  typeof value.ciphertext === 'string';

const deriveKey = async (secret: string, salt: Buffer): Promise<Buffer> => {
  const key = (await scryptAsync(secret, salt, KEY_BYTES)) as Buffer;
  return key;
};

const encryptPayload = async (payload: IntegrationTokens, secret: string): Promise<EncryptedPayload> => {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(secret, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    encrypted: true,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
};

const decryptPayload = async (payload: EncryptedPayload, secret: string): Promise<IntegrationTokens> => {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  const key = await deriveKey(secret, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as IntegrationTokens;
};

export class TokenStore {
  private cache: IntegrationTokens | null = null;
  private storePath: string;
  private secret?: string;
  private autoEncrypt: boolean;
  private warnedUnencrypted = false;

  constructor(options: TokenStoreOptions = {}) {
    this.storePath = options.storePath || process.env.TOKEN_STORE_PATH || DEFAULT_STORE_PATH;
    this.secret = options.secret || process.env.TOKEN_STORE_SECRET;
    this.autoEncrypt = options.autoEncrypt ?? true;
  }

  private warnIfUnencrypted(): void {
    if (!this.secret && !this.warnedUnencrypted) {
      this.warnedUnencrypted = true;
      console.warn(
        '[TokenStore] WARNING: TOKEN_STORE_SECRET is not set. Tokens will be stored in plaintext. ' +
        'Set TOKEN_STORE_SECRET environment variable to enable encryption.',
      );
    }
  }

  async load(): Promise<void> {
    if (this.cache) {
      return;
    }

    try {
      const data = await fs.readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(data) as IntegrationTokens | EncryptedPayload;

      if (isEncryptedPayload(parsed)) {
        if (!this.secret) {
          throw new Error('Token store is encrypted. Set TOKEN_STORE_SECRET to decrypt it.');
        }
        this.cache = await decryptPayload(parsed, this.secret);
        return;
      }

      if (!isRecord(parsed)) {
        throw new Error('Token store data is invalid.');
      }

      this.cache = parsed as IntegrationTokens;

      if (this.secret && this.autoEncrypt) {
        await this.persist();
      }
    } catch (error) {
      if (isErrno(error) && error.code === 'ENOENT') {
        this.cache = {};
        return;
      }
      throw error;
    }
  }

  hasTokens(integrationId: string): boolean {
    return Boolean(this.cache?.[integrationId]);
  }

  getCachedTokens<T extends Record<string, unknown>>(integrationId: string): T | null {
    return (this.cache?.[integrationId] as T | undefined) ?? null;
  }

  async getTokens<T extends Record<string, unknown>>(integrationId: string): Promise<T | null> {
    await this.load();
    return (this.cache?.[integrationId] as T | undefined) ?? null;
  }

  async setTokens<T extends Record<string, unknown>>(integrationId: string, tokens: T): Promise<void> {
    this.warnIfUnencrypted();
    await this.load();
    if (!this.cache) {
      this.cache = {};
    }
    this.cache[integrationId] = tokens;
    await this.persist();
  }

  async clearTokens(integrationId: string): Promise<void> {
    await this.load();
    if (!this.cache) {
      this.cache = {};
    }
    delete this.cache[integrationId];
    await this.persist();
  }

  getStorePath(): string {
    return this.storePath;
  }

  private async persist(): Promise<void> {
    if (!this.cache) {
      return;
    }
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const payload = this.secret ? await encryptPayload(this.cache, this.secret) : this.cache;
    await fs.writeFile(this.storePath, JSON.stringify(payload, null, 2));
  }
}

export const tokenStore = new TokenStore();
