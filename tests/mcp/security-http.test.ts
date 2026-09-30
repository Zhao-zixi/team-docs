import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashPassword, isoNow } from '../../src/server/security.js';

const origin = 'http://127.0.0.1';
const password = 'mcp-live-password-456';
let dir: string; let db: Db; let app: ReturnType<typeof createApp>; let endpoint: URL;
let ids: { owner: string; admin: string; viewer: string; team: string; space: string; doc: string };
const users = { owner: { id: '', email: 'owner@security.test' }, admin: { id: '', email: 'admin@security.test' }, viewer: { id: '', email: 'viewer@security.test' } };
const clients: Client[] = [];

async function connect(user: keyof typeof users, passwordValue = password) {
  const authorization = `Basic ${Buffer.from(`${users[user].email}:${passwordValue}`).toString('base64')}`;
  const fetchWithBasic: typeof fetch = (input, init) => { const headers = new Headers(init?.headers); headers.set('authorization', authorization); return fetch(input, { ...init, headers }); };
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: fetchWithBasic });
  const client = new Client({ name: `mcp-security-${user}`, version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport); clients.push(client); return client;
}
async function ownerCookie() {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'TeamShelf' }, payload: { email: users.owner.email, password } });
  return String(response.headers['set-cookie']).split(';')[0];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-mcp-security-')); db = openDatabase(dir); const now = isoNow();
  users.owner.id = randomUUID(); users.admin.id = randomUUID(); users.viewer.id = randomUUID();
  const team = randomUUID(); const space = randomUUID(); const doc = randomUUID(); const hash = await hashPassword(password);
  const addUser = db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)');
  for (const [key, user] of Object.entries(users)) addUser.run(user.id, user.email, user.email, key, hash, now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(team, 'Security Team', now);
  const member = db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)');
  member.run(team, users.owner.id, 'owner', now); member.run(team, users.admin.id, 'admin', now); member.run(team, users.viewer.id, 'viewer', now);
  db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(space, team, 'Restricted Space', users.owner.id, now);
  db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'Sensitive body','restricted',1,?,?,?,?)").run(doc, space, 'Private document', users.owner.id, now, users.owner.id, now);
  db.prepare('INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,?)').run(doc, users.viewer.id, 'viewer');
  ids = { owner: users.owner.id, admin: users.admin.id, viewer: users.viewer.id, team, space, doc };
  const config: AppConfig = { port: 0, dataDir: dir, appOrigin: origin, setupToken: '', cookieSecure: false, isProduction: false };
  app = createApp({ db, config, logger: false, serveClient: false }); const address = await app.listen({ port: 0, host: '127.0.0.1' }); endpoint = new URL('/mcp', address);
});

afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined))); await app?.close(); db?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

describe('MCP authorization stays live for an established client', () => {
  it('rechecks current role and document ACL after changes', async () => {
    const admin = await connect('admin');
    expect((await admin.listTools()).tools.map(tool => tool.name)).toContain('list_audit');
    const cookie = await ownerCookie();
    const demoted = await app.inject({ method: 'PATCH', url: `/api/teams/${ids.team}/members/${ids.admin}`, headers: { cookie, origin, 'x-requested-with': 'TeamShelf', 'content-type': 'application/json' }, payload: { role: 'editor' } });
    expect(demoted.statusCode).toBe(200);
    const teams = await admin.callTool({ name: 'list_teams', arguments: {} });
    expect(JSON.stringify(teams)).toContain('editor');
    expect((await admin.listTools()).tools.map(tool => tool.name)).not.toContain('list_audit');
    const basic = `Basic ${Buffer.from(`${users.admin.email}:${password}`).toString('base64')}`;
    expect((await app.inject({ method: 'GET', url: `/api/teams/${ids.team}/audit`, headers: { authorization: basic, origin } })).statusCode).toBe(403);

    const viewer = await connect('viewer');
    expect(JSON.stringify(await viewer.callTool({ name: 'get_document', arguments: { documentId: ids.doc } }))).toContain('Sensitive body');
    const changedAcl = await app.inject({ method: 'PUT', url: `/api/documents/${ids.doc}/access`, headers: { cookie, origin, 'x-requested-with': 'TeamShelf', 'content-type': 'application/json' }, payload: { visibility: 'restricted', grants: [] } });
    expect(changedAcl.statusCode).toBe(200);
    const after = await viewer.callTool({ name: 'get_document', arguments: { documentId: ids.doc } });
    expect(after.isError).toBe(true); expect(JSON.stringify(after)).not.toContain('Sensitive body');
  });

  it('invalidates the established connection after password change and accepts the new password', async () => {
    const viewer = await connect('viewer');
    expect((await viewer.callTool({ name: 'list_teams', arguments: {} })).isError).not.toBe(true);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword('new-mcp-password-789'), ids.viewer);
    let error = '';
    try { await viewer.callTool({ name: 'list_teams', arguments: {} }); } catch (cause) { error = cause instanceof Error ? cause.name : 'error'; }
    expect(error).toBe('SdkHttpError');
    const newClient = await connect('viewer', 'new-mcp-password-789');
    expect((await newClient.callTool({ name: 'list_teams', arguments: {} })).isError).not.toBe(true);
  });
});
