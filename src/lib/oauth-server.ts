import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { integrationRegistry } from '../integrations/registry.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { handleWebhookRequest } from './webhooks.js';
import { handleScimRequest } from './scim.js';
import { handleGoogleSsoRequest } from './sso-google.js';

const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthState {
  integrationId: string;
  createdAt: number;
}

const stateStore = new Map<string, OAuthState>();

const getSharedSecret = (url: URL, req: http.IncomingMessage): string | null => {
  const querySecret = url.searchParams.get('secret');
  if (querySecret) {
    return querySecret;
  }

  const oauthHeader = req.headers['x-adept-oauth-secret'];
  const webhookHeader = req.headers['x-adept-webhook-secret'];
  const header = webhookHeader ?? oauthHeader;
  if (Array.isArray(header)) {
    return header[0] ?? null;
  }
  if (typeof header === 'string') {
    return header;
  }

  return null;
};

const isSharedSecretValid = (url: URL, req: http.IncomingMessage): boolean => {
  const config = loadConfig();
  const sharedSecret = config.oauth.sharedSecret;

  if (!sharedSecret) {
    return true;
  }

  const provided = getSharedSecret(url, req);
  return Boolean(provided && provided === sharedSecret);
};

const isLocalAddress = (address?: string | null) => {
  if (!address) {
    return false;
  }
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  );
};

const clearExpiredStates = () => {
  const now = Date.now();
  for (const [key, value] of stateStore.entries()) {
    if (now - value.createdAt > STATE_TTL_MS) {
      stateStore.delete(key);
    }
  }
};

const createState = (integrationId: string) => {
  clearExpiredStates();
  const state = randomBytes(16).toString('hex');
  stateStore.set(state, { integrationId, createdAt: Date.now() });
  return state;
};

const validateState = (state: string | null, integrationId: string): boolean => {
  if (!state) {
    return false;
  }

  const stored = stateStore.get(state);
  stateStore.delete(state);

  if (!stored) {
    return false;
  }

  return stored.integrationId === integrationId && Date.now() - stored.createdAt <= STATE_TTL_MS;
};

const renderHtml = (title: string, body: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 32px; color: #111; }
      code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h2>${title}</h2>
    <p>${body}</p>
  </body>
</html>`;

const sendResponse = (res: http.ServerResponse, status: number, html: string) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
};

const redirect = (res: http.ServerResponse, url: string) => {
  res.writeHead(302, { Location: url });
  res.end();
};

const handleHealth = (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
};

const handleStart = async (integrationId: string, baseUrl: string, res: http.ServerResponse) => {
  const integration = integrationRegistry.get(integrationId);
  const state = createState(integrationId);

  if (integration?.getAuthConfig) {
    const authConfig = integration.getAuthConfig();
    const url = await authConfig.getAuthUrl(baseUrl, state);
    redirect(res, url);
    return;
  }

  sendResponse(
    res,
    404,
    renderHtml('Integration not found', `Integration "${integrationId}" does not support OAuth.`),
  );
};

const handleCallback = async (
  integrationId: string,
  baseUrl: string,
  url: URL,
  res: http.ServerResponse,
) => {
  const integration = integrationRegistry.get(integrationId);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  if (error) {
    sendResponse(res, 400, renderHtml('OAuth error', `${error}: ${errorDescription ?? ''}`));
    return;
  }

  if (!code) {
    sendResponse(res, 400, renderHtml('OAuth error', 'Missing authorization code.'));
    return;
  }

  if (!validateState(state, integrationId)) {
    sendResponse(res, 400, renderHtml('OAuth error', 'Invalid or expired state.'));
    return;
  }

  try {
    if (integration?.getAuthConfig) {
      const authConfig = integration.getAuthConfig();
      await authConfig.handleCallback(url.searchParams, baseUrl);
      sendResponse(
        res,
        200,
        renderHtml(
          `${integration.name} connected`,
          `Successfully connected ${integration.name} to Adept.`,
        ),
      );
      return;
    }

    sendResponse(
      res,
      404,
      renderHtml('Integration not found', `Integration "${integrationId}" does not support OAuth.`),
    );
  } catch (err) {
    sendResponse(
      res,
      500,
      renderHtml('OAuth error', err instanceof Error ? err.message : String(err)),
    );
  }
};

export const startOAuthServer = () => {
  const config = loadConfig();
  const { port, baseUrl, bindHost, allowRemote } = config.oauth;

  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.method) {
      sendResponse(res, 404, renderHtml('Not found', 'Route not found.'));
      return;
    }

    if (!allowRemote && !isLocalAddress(req.socket.remoteAddress)) {
      sendResponse(
        res,
        403,
        renderHtml('Forbidden', 'Remote requests are disabled for this OAuth server.'),
      );
      return;
    }

    const url = new URL(req.url, baseUrl);
    const path = url.pathname;

    // Health check endpoint
    if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
      handleHealth(req, res);
      return;
    }

    if (path.startsWith('/scim/')) {
      await handleScimRequest(req, res, url);
      return;
    }

    if (path.startsWith('/sso/google')) {
      await handleGoogleSsoRequest(req, res, baseUrl, url);
      return;
    }

    if (path.startsWith('/webhooks')) {
      if (req.method !== 'POST') {
        sendResponse(res, 405, renderHtml('Method not allowed', 'Use POST for webhook events.'));
        return;
      }

      if (!isSharedSecretValid(url, req)) {
        sendResponse(res, 401, renderHtml('Unauthorized', 'Missing or invalid shared secret.'));
        return;
      }

      if (path === '/webhooks/email') {
        await handleWebhookRequest(req, res, 'email');
        return;
      }

      if (path === '/webhooks/form') {
        await handleWebhookRequest(req, res, 'form_submit');
        return;
      }

      if (path === '/webhooks/deal-close') {
        await handleWebhookRequest(req, res, 'deal_close');
        return;
      }

      if (path === '/webhooks/events' || path === '/webhooks/custom') {
        await handleWebhookRequest(req, res, 'webhook');
        return;
      }

      await handleWebhookRequest(req, res);
      return;
    }

    const parts = path.split('/').filter(Boolean); // ['oauth', 'integrationId', 'action']

    if (
      req.method === 'GET' &&
      parts.length === 3 &&
      parts[0] === 'oauth' &&
      (parts[2] === 'start' || parts[2] === 'callback')
    ) {
      const integrationId = parts[1];
      const action = parts[2];

      try {
        if (action === 'start') {
          if (!isSharedSecretValid(url, req)) {
            sendResponse(res, 401, renderHtml('Unauthorized', 'Missing or invalid shared secret.'));
            return;
          }
          await handleStart(integrationId, baseUrl, res);
          return;
        }

        if (action === 'callback') {
          await handleCallback(integrationId, baseUrl, url, res);
          return;
        }
      } catch (error) {
        sendResponse(
          res,
          500,
          renderHtml('OAuth error', error instanceof Error ? error.message : String(error)),
        );
        return;
      }
    }

    sendResponse(res, 404, renderHtml('Not found', 'Route not found.'));
  });

  server.listen(port, bindHost, () => {
    logger.info({ baseUrl }, '[Adept] OAuth server listening');
  });

  return server;
};
