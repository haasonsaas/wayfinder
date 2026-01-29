import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { RedisJsonStore } from './redis.js';

interface GoogleTokenInfo {
  aud?: string;
  email?: string;
  email_verified?: string;
  hd?: string;
  sub?: string;
  name?: string;
  exp?: string;
  error_description?: string;
}

interface SsoSession {
  token: string;
  subject: string;
  email: string;
  name?: string;
  domain?: string;
  createdAt: string;
  expiresAt: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_HOURS = 8;

const stateStore = new Map<string, { createdAt: number }>();
const sessionStore = new RedisJsonStore<SsoSession>('adept:sso_sessions');
const sessionCache = new Map<string, SsoSession>();

const clearExpiredStates = () => {
  const now = Date.now();
  for (const [key, value] of stateStore.entries()) {
    if (now - value.createdAt > STATE_TTL_MS) {
      stateStore.delete(key);
    }
  }
};

const createState = (): string => {
  clearExpiredStates();
  const state = randomBytes(16).toString('hex');
  stateStore.set(state, { createdAt: Date.now() });
  return state;
};

const validateState = (state: string | null): boolean => {
  if (!state) return false;
  const stored = stateStore.get(state);
  stateStore.delete(state);
  if (!stored) return false;
  return Date.now() - stored.createdAt <= STATE_TTL_MS;
};

const getConfig = () => {
  const config = loadConfig();
  const google = config.sso?.google;
  return {
    clientId: google?.clientId,
    clientSecret: google?.clientSecret,
    redirectUri: google?.redirectUri || `${config.oauth.baseUrl}/sso/google/callback`,
    allowedDomains: google?.allowedDomains ?? [],
  };
};

const sendJson = (res: http.ServerResponse, status: number, payload: Record<string, unknown>) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const sendHtml = (res: http.ServerResponse, status: number, title: string, body: string) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>${title}</title></head><body><h2>${title}</h2><p>${body}</p></body></html>`);
};

const readJsonBody = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          resolve(parsed as Record<string, unknown>);
          return;
        }
        reject(new Error('Invalid JSON'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', (error) => reject(error));
  });
};

const buildLoginUrl = (baseUrl: string, state: string): string => {
  const { clientId, redirectUri } = getConfig();
  if (!clientId) {
    throw new Error('Google SSO clientId is not configured');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri || `${baseUrl}/sso/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

const exchangeCodeForToken = async (code: string): Promise<{ id_token?: string; error?: string }> => {
  const { clientId, clientSecret, redirectUri } = getConfig();
  if (!clientId || !clientSecret) {
    throw new Error('Google SSO client credentials are not configured');
  }

  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    return { error: String(data.error ?? 'Token exchange failed') };
  }

  return { id_token: data.id_token ? String(data.id_token) : undefined };
};

const fetchTokenInfo = async (idToken: string): Promise<GoogleTokenInfo> => {
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
  );
  return (await response.json()) as GoogleTokenInfo;
};

const validateTokenInfo = (info: GoogleTokenInfo): { valid: boolean; reason?: string } => {
  const { clientId, allowedDomains } = getConfig();
  if (!info.aud || info.aud !== clientId) {
    return { valid: false, reason: 'Invalid audience' };
  }
  if (!info.email || info.email_verified !== 'true') {
    return { valid: false, reason: 'Email not verified' };
  }
  if (allowedDomains.length > 0 && (!info.hd || !allowedDomains.includes(info.hd))) {
    return { valid: false, reason: 'Domain not allowed' };
  }
  return { valid: true };
};

const createSession = async (info: GoogleTokenInfo): Promise<SsoSession> => {
  const token = randomBytes(24).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_HOURS * 60 * 60 * 1000);
  const session: SsoSession = {
    token,
    subject: info.sub ?? '',
    email: info.email ?? '',
    name: info.name,
    domain: info.hd,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  sessionCache.set(token, session);
  await sessionStore.set(token, session);
  return session;
};

const getSession = async (token: string): Promise<SsoSession | null> => {
  const cached = sessionCache.get(token);
  if (cached && new Date(cached.expiresAt) > new Date()) {
    return cached;
  }
  const stored = await sessionStore.get(token);
  if (stored && new Date(stored.expiresAt) > new Date()) {
    sessionCache.set(token, stored);
    return stored;
  }
  return null;
};

const extractBearerToken = (req: http.IncomingMessage): string | null => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length);
  }
  return null;
};

export const handleGoogleSsoRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  baseUrl: string,
  url: URL,
): Promise<void> => {
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/sso/google/login') {
      const state = createState();
      const loginUrl = buildLoginUrl(baseUrl, state);
      res.writeHead(302, { Location: loginUrl });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/sso/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const format = url.searchParams.get('format');

      if (!validateState(state)) {
        sendHtml(res, 400, 'SSO error', 'Invalid or expired state.');
        return;
      }
      if (!code) {
        sendHtml(res, 400, 'SSO error', 'Missing authorization code.');
        return;
      }

      const tokenResponse = await exchangeCodeForToken(code);
      if (!tokenResponse.id_token) {
        sendHtml(res, 400, 'SSO error', tokenResponse.error ?? 'Failed to exchange code.');
        return;
      }

      const info = await fetchTokenInfo(tokenResponse.id_token);
      const validation = validateTokenInfo(info);
      if (!validation.valid) {
        sendHtml(res, 403, 'SSO error', validation.reason ?? 'Invalid token.');
        return;
      }

      const session = await createSession(info);
      if (format === 'json') {
        sendJson(res, 200, {
          accessToken: session.token,
          expiresAt: session.expiresAt,
          email: session.email,
          domain: session.domain,
        });
        return;
      }

      sendHtml(
        res,
        200,
        'SSO complete',
        `Login succeeded for ${session.email}. Your access token is ${session.token}.`,
      );
      return;
    }

    if (req.method === 'POST' && path === '/sso/google/token') {
      const body = await readJsonBody(req);
      const idToken = body.idToken ? String(body.idToken) : null;
      if (!idToken) {
        sendJson(res, 400, { error: 'idToken is required' });
        return;
      }
      const info = await fetchTokenInfo(idToken);
      const validation = validateTokenInfo(info);
      if (!validation.valid) {
        sendJson(res, 403, { error: validation.reason ?? 'Invalid token' });
        return;
      }
      const session = await createSession(info);
      sendJson(res, 200, {
        accessToken: session.token,
        expiresAt: session.expiresAt,
        email: session.email,
        domain: session.domain,
      });
      return;
    }

    if (req.method === 'GET' && path === '/sso/google/session') {
      const token = extractBearerToken(req) ?? url.searchParams.get('token');
      if (!token) {
        sendJson(res, 401, { error: 'Missing token' });
        return;
      }
      const session = await getSession(token);
      if (!session) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }
      sendJson(res, 200, {
        email: session.email,
        name: session.name,
        domain: session.domain,
        expiresAt: session.expiresAt,
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    logger.error({ error }, '[SSO] Google SSO failed');
    sendJson(res, 500, { error: 'SSO error' });
  }
};
