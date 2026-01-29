import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import {
  identityStore,
  type ScimGroup,
  type ScimGroupMember,
  type ScimUser,
  type ScimUserName,
  type ScimEmail,
} from './identity-store.js';

const SCIM_CONTENT_TYPE = 'application/scim+json';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

const sendJson = (res: http.ServerResponse, status: number, payload: Record<string, unknown>) => {
  res.writeHead(status, { 'Content-Type': SCIM_CONTENT_TYPE });
  res.end(JSON.stringify(payload));
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

const isAuthorized = (req: http.IncomingMessage): boolean => {
  const config = loadConfig();
  const token = config.scim?.token;
  if (!token) {
    return true;
  }
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return false;
  }
  return auth.slice('Bearer '.length) === token;
};

const parseFilterValue = (filter: string | null, field: string): string | null => {
  if (!filter) {
    return null;
  }
  const regex = new RegExp(`${field}\\s+eq\\s+"?([^"]+)"?`, 'i');
  const match = filter.match(regex);
  return match?.[1] ?? null;
};

const paginate = <T>(items: T[], startIndex: number, count: number): T[] => {
  const start = Math.max(0, startIndex - 1);
  return items.slice(start, start + count);
};

const buildUserResource = (user: ScimUser) => ({
  schemas: [USER_SCHEMA],
  id: user.id,
  userName: user.userName,
  displayName: user.displayName,
  name: user.name,
  emails: user.emails,
  active: user.active,
  groups: user.groups,
  externalId: user.externalId,
  meta: {
    resourceType: 'User',
    created: user.createdAt,
    lastModified: user.updatedAt,
  },
});

const buildGroupResource = (group: ScimGroup) => ({
  schemas: [GROUP_SCHEMA],
  id: group.id,
  displayName: group.displayName,
  members: group.members,
  meta: {
    resourceType: 'Group',
    created: group.createdAt,
    lastModified: group.updatedAt,
  },
});

const parseUserBody = (body: Record<string, unknown>, existing?: ScimUser): ScimUser => {
  const now = new Date().toISOString();
  const userName = String(body.userName ?? existing?.userName ?? '').trim();
  const name = body.name && typeof body.name === 'object' ? (body.name as ScimUserName) : existing?.name;
  const emails = Array.isArray(body.emails) ? (body.emails as ScimEmail[]) : existing?.emails;
  const displayName = body.displayName ? String(body.displayName) : existing?.displayName;
  const active = typeof body.active === 'boolean' ? body.active : existing?.active ?? true;
  const groups = Array.isArray(body.groups) ? (body.groups as ScimGroupMember[]) : existing?.groups;
  const externalId = body.externalId ? String(body.externalId) : existing?.externalId;

  if (!userName) {
    throw new Error('userName is required');
  }

  return {
    id: existing?.id ?? randomUUID(),
    userName,
    displayName,
    name,
    emails,
    active,
    groups,
    externalId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
};

const parseGroupBody = (body: Record<string, unknown>, existing?: ScimGroup): ScimGroup => {
  const now = new Date().toISOString();
  const displayName = String(body.displayName ?? existing?.displayName ?? '').trim();
  const members = Array.isArray(body.members) ? (body.members as ScimGroupMember[]) : existing?.members;

  if (!displayName) {
    throw new Error('displayName is required');
  }

  return {
    id: existing?.id ?? randomUUID(),
    displayName,
    members,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
};

const applyUserPatch = (user: ScimUser, body: Record<string, unknown>): ScimUser => {
  const operations = Array.isArray(body.Operations) ? body.Operations : [];
  let updated = { ...user };

  for (const op of operations) {
    if (!op || typeof op !== 'object') continue;
    const operation = op as Record<string, unknown>;
    const path = String(operation.path ?? '').toLowerCase();
    const value = operation.value;

    if (path === 'active' && typeof value === 'boolean') {
      updated.active = value;
    } else if (path === 'username' && typeof value === 'string') {
      updated.userName = value;
    } else if (path.startsWith('name.') && value && typeof value === 'string') {
      const name = { ...(updated.name ?? {}) };
      if (path.endsWith('givenname')) {
        name.givenName = value;
      }
      if (path.endsWith('familyname')) {
        name.familyName = value;
      }
      updated.name = name;
    } else if (path === 'emails' && Array.isArray(value)) {
      updated.emails = value as ScimEmail[];
    } else if (!path && value && typeof value === 'object') {
      const patch = value as Record<string, unknown>;
      updated = parseUserBody(patch, updated);
    }
  }

  updated.updatedAt = new Date().toISOString();
  return updated;
};

const applyGroupPatch = (group: ScimGroup, body: Record<string, unknown>): ScimGroup => {
  const operations = Array.isArray(body.Operations) ? body.Operations : [];
  let updated = { ...group };

  for (const op of operations) {
    if (!op || typeof op !== 'object') continue;
    const operation = op as Record<string, unknown>;
    const path = String(operation.path ?? '').toLowerCase();
    const value = operation.value;

    if (path === 'displayname' && typeof value === 'string') {
      updated.displayName = value;
    } else if (path === 'members' && Array.isArray(value)) {
      updated.members = value as ScimGroupMember[];
    } else if (!path && value && typeof value === 'object') {
      const patch = value as Record<string, unknown>;
      updated = parseGroupBody(patch, updated);
    }
  }

  updated.updatedAt = new Date().toISOString();
  return updated;
};

const handleUsers = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  id?: string,
): Promise<void> => {
  if (req.method === 'GET' && !id) {
    const filterUserName = parseFilterValue(url.searchParams.get('filter'), 'userName');
    const startIndex = Number(url.searchParams.get('startIndex') ?? '1');
    const count = Number(url.searchParams.get('count') ?? '100');
    let users = await identityStore.listUsers();
    if (filterUserName) {
      users = users.filter((user) => user.userName.toLowerCase() === filterUserName.toLowerCase());
    }
    const resources = paginate(users, startIndex, count).map(buildUserResource);
    sendJson(res, 200, {
      schemas: [LIST_SCHEMA],
      totalResults: users.length,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    });
    return;
  }

  if (req.method === 'POST' && !id) {
    try {
      const body = await readJsonBody(req);
      const existing = await identityStore.getUserByUserName(String(body.userName ?? ''));
      if (existing) {
        sendJson(res, 409, { detail: 'User already exists', status: 409 });
        return;
      }
      const user = parseUserBody(body);
      await identityStore.setUser(user);
      sendJson(res, 201, buildUserResource(user));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : 'Invalid user', status: 400 });
    }
    return;
  }

  if (!id) {
    sendJson(res, 400, { detail: 'User ID required', status: 400 });
    return;
  }

  const existing = await identityStore.getUser(id);
  if (!existing) {
    sendJson(res, 404, { detail: 'User not found', status: 404 });
    return;
  }

  if (req.method === 'GET') {
    sendJson(res, 200, buildUserResource(existing));
    return;
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const updated = parseUserBody(body, existing);
      await identityStore.setUser(updated);
      sendJson(res, 200, buildUserResource(updated));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : 'Invalid user', status: 400 });
    }
    return;
  }

  if (req.method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      const updated = applyUserPatch(existing, body);
      await identityStore.setUser(updated);
      sendJson(res, 200, buildUserResource(updated));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : 'Invalid patch', status: 400 });
    }
    return;
  }

  if (req.method === 'DELETE') {
    await identityStore.deleteUser(id);
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 405, { detail: 'Method not allowed', status: 405 });
};

const handleGroups = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  id?: string,
): Promise<void> => {
  if (req.method === 'GET' && !id) {
    const filterDisplay = parseFilterValue(url.searchParams.get('filter'), 'displayName');
    const startIndex = Number(url.searchParams.get('startIndex') ?? '1');
    const count = Number(url.searchParams.get('count') ?? '100');
    let groups = await identityStore.listGroups();
    if (filterDisplay) {
      groups = groups.filter((group) => group.displayName.toLowerCase() === filterDisplay.toLowerCase());
    }
    const resources = paginate(groups, startIndex, count).map(buildGroupResource);
    sendJson(res, 200, {
      schemas: [LIST_SCHEMA],
      totalResults: groups.length,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    });
    return;
  }

  if (req.method === 'POST' && !id) {
    try {
      const body = await readJsonBody(req);
      const group = parseGroupBody(body);
      await identityStore.setGroup(group);
      sendJson(res, 201, buildGroupResource(group));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : 'Invalid group', status: 400 });
    }
    return;
  }

  if (!id) {
    sendJson(res, 400, { detail: 'Group ID required', status: 400 });
    return;
  }

  const existing = await identityStore.getGroup(id);
  if (!existing) {
    sendJson(res, 404, { detail: 'Group not found', status: 404 });
    return;
  }

  if (req.method === 'GET') {
    sendJson(res, 200, buildGroupResource(existing));
    return;
  }

  if (req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const updated = parseGroupBody(body, existing);
      await identityStore.setGroup(updated);
      sendJson(res, 200, buildGroupResource(updated));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : 'Invalid group', status: 400 });
    }
    return;
  }

  if (req.method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      const updated = applyGroupPatch(existing, body);
      await identityStore.setGroup(updated);
      sendJson(res, 200, buildGroupResource(updated));
    } catch (error) {
      sendJson(res, 400, { detail: error instanceof Error ? error.message : 'Invalid patch', status: 400 });
    }
    return;
  }

  if (req.method === 'DELETE') {
    await identityStore.deleteGroup(id);
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 405, { detail: 'Method not allowed', status: 405 });
};

const sendServiceProviderConfig = (res: http.ServerResponse) => {
  sendJson(res, 200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer Token',
        description: 'Bearer token authentication',
        specUri: 'https://www.rfc-editor.org/rfc/rfc6750',
        primary: true,
      },
    ],
  });
};

export const handleScimRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> => {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { detail: 'Unauthorized', status: 401 });
    return;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  const resource = parts[2];
  const id = parts[3];

  try {
    if (resource === 'ServiceProviderConfig') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { detail: 'Method not allowed', status: 405 });
        return;
      }
      sendServiceProviderConfig(res);
      return;
    }

    if (resource === 'Users') {
      await handleUsers(req, res, url, id);
      return;
    }

    if (resource === 'Groups') {
      await handleGroups(req, res, url, id);
      return;
    }

    sendJson(res, 404, { detail: 'Resource not found', status: 404 });
  } catch (error) {
    logger.error({ error }, '[SCIM] Request failed');
    sendJson(res, 500, { detail: 'SCIM error', status: 500 });
  }
};
