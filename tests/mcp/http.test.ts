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

const password = 'mcp-account-test-password-42';
const origin = 'http://127.0.0.1';
let dir: string; let db: Db; let app: ReturnType<typeof createApp>; let endpoint: URL;
let ids: { owner: string; editor: string; viewer: string; teamA: string; teamB: string; spaceA: string; spaceB: string; docA: string; docB: string };
const users = { owner: { id: '', email: 'owner@mcp.test' }, editor: { id: '', email: 'editor@mcp.test' }, viewer: { id: '', email: 'viewer@mcp.test' } };
const clients: Client[] = [];

async function connect(user: keyof typeof users, passwordValue = password) {
  const authorization = `Basic ${Buffer.from(`${users[user].email}:${passwordValue}`).toString('base64')}`;
  const fetchWithBasic: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers); headers.set('authorization', authorization);
    return fetch(input, { ...init, headers });
  };
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: fetchWithBasic });
  const client = new Client({ name: `teamshelf-${user}-mcp-test`, version: '1.0.0' });
  await client.connect(transport); clients.push(client); return client;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-mcp-http-')); db = openDatabase(dir); const now = isoNow();
  users.owner.id = randomUUID(); users.editor.id = randomUUID(); users.viewer.id = randomUUID();
  const teamA = randomUUID(); const teamB = randomUUID(); const spaceA = randomUUID(); const spaceB = randomUUID(); const docA = randomUUID(); const docB = randomUUID();
  const hash = await hashPassword(password);
  const addUser = db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)');
  for (const [key, user] of Object.entries(users)) addUser.run(user.id, user.email, user.email, key, hash, now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamA, 'Team A', now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamB, 'Team B', now);
  const member = db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)');
  member.run(teamA, users.owner.id, 'owner', now); member.run(teamB, users.owner.id, 'owner', now);
  member.run(teamA, users.editor.id, 'editor', now); member.run(teamA, users.viewer.id, 'viewer', now);
  db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(spaceA, teamA, 'Knowledge A', users.owner.id, now);
  db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(spaceB, teamB, 'Knowledge B', users.owner.id, now);
  db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'Team A body','inherit',1,?,?,?,?)").run(docA, spaceA, 'Document A', users.owner.id, now, users.owner.id, now);
  db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'Team B private body','inherit',1,?,?,?,?)").run(docB, spaceB, 'Document B', users.owner.id, now, users.owner.id, now);
  ids = { owner: users.owner.id, editor: users.editor.id, viewer: users.viewer.id, teamA, teamB, spaceA, spaceB, docA, docB };
  const config: AppConfig = { port: 0, dataDir: dir, appOrigin: origin, setupToken: '', cookieSecure: false, isProduction: false };
  app = createApp({ db, config, logger: false, serveClient: false }); const address = await app.listen({ port: 0, host: '127.0.0.1' }); endpoint = new URL('/mcp', address);
});

afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined))); await app?.close(); db?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });

describe('TeamShelf HTTP MCP account authentication', () => {
  it('discovers teams, requires an explicit choice for multiple teams, and confines search to the selected team', async () => {
    const owner = await connect('owner');
    expect((await owner.listTools()).tools.map(tool => tool.name)).toContain('list_teams');
    const teams = await owner.callTool({ name: 'list_teams', arguments: {} });
    expect(JSON.stringify(teams)).toContain(ids.teamA); expect(JSON.stringify(teams)).toContain(ids.teamB);
    const missing = await owner.callTool({ name: 'list_spaces', arguments: {} });
    expect(missing.isError).toBe(true); expect(JSON.stringify(missing)).toContain('teamId');
    const spaces = await owner.callTool({ name: 'list_spaces', arguments: { teamId: ids.teamA } });
    expect(JSON.stringify(spaces)).toContain('Knowledge A'); expect(JSON.stringify(spaces)).not.toContain('Knowledge B');
    const search = await owner.callTool({ name: 'search_documents', arguments: { teamId: ids.teamA, query: 'body', spaceId: ids.spaceB } });
    expect(search.isError).toBe(true); expect(JSON.stringify(search)).not.toContain('Team B private body');
    const mismatchedResource = await owner.callTool({ name: 'get_document', arguments: { teamId: ids.teamA, documentId: ids.docB } });
    expect(mismatchedResource.isError).toBe(true); expect(JSON.stringify(mismatchedResource)).not.toContain('Team B private body');
  });

  it('exposes tools according to current role and applies ACL on every MCP call', async () => {
    const viewer = await connect('viewer');
    const viewerTools = (await viewer.listTools()).tools.map(tool => tool.name);
    expect(viewerTools).toContain('get_document'); expect(viewerTools).not.toContain('create_document'); expect(viewerTools).not.toContain('list_audit');
    const read = await viewer.callTool({ name: 'get_document', arguments: { documentId: ids.docA } });
    expect(JSON.stringify(read)).toContain('Team A body');
    const editor = await connect('editor');
    const created = await editor.callTool({ name: 'create_document', arguments: { spaceId: ids.spaceA, title: 'MCP-created', markdown: 'inherited ACL' } });
    expect(created.isError).not.toBe(true);
    const row = db.prepare('SELECT visibility,body FROM documents WHERE title=?').get('MCP-created');
    expect(row).toEqual({ visibility: 'inherit', body: 'inherited ACL' });
  });

  it('rejects bad Basic, old bearer, mixed cookie, and wrong Origin before tools execute', async () => {
    const bad = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Basic !!!', 'content-type': 'application/json' }, body: '{}' });
    expect(bad.status).toBe(401);
    const bearer = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer ts_agent_legacy', 'content-type': 'application/json' }, body: '{}' });
    expect(bearer.status).toBe(401);
    const mixed = await fetch(endpoint, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${users.owner.email}:${password}`).toString('base64')}`, cookie: 'teamshelf_session=browser', 'content-type': 'application/json' }, body: '{}' });
    expect(mixed.status).toBe(401);
    const wrongOrigin = await fetch(endpoint, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${users.owner.email}:${password}`).toString('base64')}`, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
    expect(wrongOrigin.status).toBe(403);
  });

  it('preserves a Unicode password with a colon and surrounding spaces through Basic decoding', async () => {
    const specialPassword = '  päss:wort λ\n\0  ';
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(specialPassword), ids.owner);
    const client = await connect('owner', specialPassword);
    const identity = await client.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.stringify(identity)).toContain('owner@mcp.test');
  });

  it('measures one real account-authenticated MCP tool round trip', async () => {
    const client = await connect('viewer');
    const started = performance.now();
    const teams = await client.callTool({ name: 'list_teams', arguments: {} });
    const elapsedMs = performance.now() - started;
    expect(teams.isError).not.toBe(true);
    expect(elapsedMs).toBeGreaterThan(0);
    if (process.env.MCP_PERF_EVIDENCE === '1') console.info(`Basic MCP list_teams round trip: ${elapsedMs.toFixed(1)} ms`);
  });
});
