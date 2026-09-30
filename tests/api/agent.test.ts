import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashPassword, hashToken, isoNow } from '../../src/server/security.js';
import { resetBasicFailureStateForTests } from '../../src/server/agentAuth.js';

const origin = 'http://127.0.0.1:5173';
const password = 'test-account-password-234';
let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;
let ids: { owner: string; editor: string; viewer: string; team: string; otherTeam: string; space: string; document: string };
let users: Record<string, { id: string; email: string }>;

beforeEach(async () => {
  resetBasicFailureStateForTests();
  dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-account-agent-'));
  db = openDatabase(dir);
  const now = isoNow();
  const owner = randomUUID(); const editor = randomUUID(); const viewer = randomUUID();
  const team = randomUUID(); const otherTeam = randomUUID(); const space = randomUUID(); const document = randomUUID();
  const hash = await hashPassword(password);
  users = { owner: { id: owner, email: 'owner@example.test' }, editor: { id: editor, email: 'editor@example.test' }, viewer: { id: viewer, email: 'viewer@example.test' } };
  const insertUser = db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)');
  for (const [key, user] of Object.entries(users)) insertUser.run(user.id, user.email, user.email, key, hash, now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(team, 'Team A', now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(otherTeam, 'Team B', now);
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(team, owner, 'owner', now);
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(team, editor, 'editor', now);
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(team, viewer, 'viewer', now);
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(otherTeam, owner, 'owner', now);
  db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(space, team, 'Knowledge', owner, now);
  db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'Private body','inherit',1,?,?,?,?)").run(document, space, 'Private', owner, now, owner, now);
  ids = { owner, editor, viewer, team, otherTeam, space, document };
  const config: AppConfig = { port: 0, dataDir: dir, appOrigin: origin, setupToken: '', cookieSecure: false, isProduction: false };
  app = createApp({ db, config, logger: false, serveClient: false });
  await app.ready();
});

afterEach(async () => { await app.close(); db.close(); await rm(dir, { recursive: true, force: true }); });

function basic(user: keyof typeof users, passwordValue = password) {
  return `Basic ${Buffer.from(`${users[user].email}:${passwordValue}`, 'utf8').toString('base64')}`;
}
function request(user: keyof typeof users, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, extraHeaders: Record<string, string> = {}, remoteAddress?: string) {
  return app.inject({ method, url, headers: { authorization: basic(user), origin, ...extraHeaders, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }), ...(remoteAddress ? { remoteAddress } : {}) });
}

describe('account authentication for Agent REST routes', () => {
  it('accepts only Basic credentials on the allowlist and keeps PAT issuance disabled', async () => {
    const read = await request('viewer', 'GET', `/api/teams/${ids.team}/spaces`);
    expect(read.statusCode).toBe(200);
    expect((await request('viewer', 'GET', '/api/auth/me')).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/teams/${ids.team}/spaces`, headers: { authorization: 'Bearer ts_agent_legacy', origin } })).statusCode).toBe(401);
    expect((await request('viewer', 'GET', `/api/teams/${ids.team}/spaces`, undefined, { cookie: 'teamshelf_session=browser-session' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/teams/${ids.team}/spaces`, headers: { authorization: 'Basic !!!', origin } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/teams/${ids.team}/spaces`, headers: { authorization: basic('viewer'), origin: 'https://attacker.example' } })).statusCode).toBe(403);

    expect((await app.inject({ method: 'GET', url: '/api/agent-tokens', headers: { cookie: 'teamshelf_session=browser-session' } })).statusCode).toBe(410);
    expect((await app.inject({ method: 'POST', url: '/api/agent-tokens', headers: { cookie: 'teamshelf_session=browser-session', 'x-requested-with': 'TeamShelf' }, payload: { name: 'old', teamId: ids.team } })).statusCode).toBe(410);
    const legacy = `ts_agent_${'x'.repeat(40)}`;
    db.prepare('INSERT INTO agent_tokens(id,user_id,team_id,name,scope,token_hash,token_hint,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), ids.viewer, ids.team, 'historical token', 'read', hashToken(legacy), 'legacy', isoNow(), new Date(Date.now() + 86_400_000).toISOString());
    expect((await app.inject({ method: 'GET', url: `/api/teams/${ids.team}/spaces`, headers: { authorization: `Bearer ${legacy}`, origin } })).statusCode).toBe(401);
    expect((db.prepare("SELECT COUNT(*) AS count FROM agent_tokens WHERE token_hint='legacy'").get() as { count: number }).count).toBe(1);
  });

  it('re-reads the current team role, applies document ACLs, and records account auth without a credential id', async () => {
    const first = await request('editor', 'PATCH', `/api/documents/${ids.document}`, { title: 'Updated', body: 'safe', version: 1 });
    expect(first.statusCode).toBe(200);
    const adminCookie = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'TeamShelf' }, payload: { email: users.owner.email, password } });
    const cookie = String(adminCookie.headers['set-cookie']).split(';')[0];
    const demote = await app.inject({ method: 'PATCH', url: `/api/teams/${ids.team}/members/${ids.editor}`, headers: { cookie, origin, 'x-requested-with': 'TeamShelf', 'content-type': 'application/json' }, payload: { role: 'viewer' } });
    expect(demote.statusCode).toBe(200);
    expect((await request('editor', 'PATCH', `/api/documents/${ids.document}`, { title: 'Denied', body: 'unsafe', version: 2 })).statusCode).toBe(403);

    const audit = db.prepare("SELECT details_json FROM audit_events WHERE actor_id=? AND action='agent.document.write' ORDER BY rowid DESC LIMIT 1").get(ids.editor) as { details_json: string };
    const details = JSON.parse(audit.details_json) as Record<string, unknown>;
    expect(details).toHaveProperty('authType', 'account_basic');
    expect(details).not.toHaveProperty('credentialId');
  });

  it('allows successful calls beyond ten per minute and rate-limits repeated failures by IP', async () => {
    for (let i = 0; i < 12; i++) expect((await request('viewer', 'GET', `/api/teams/${ids.team}/spaces`, undefined, {}, '198.51.100.10')).statusCode).toBe(200);
    for (let i = 0; i < 20; i++) {
      const response = await app.inject({ method: 'GET', url: `/api/teams/${ids.team}/spaces`, headers: { authorization: 'Basic !!!', origin }, remoteAddress: '198.51.100.20' });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('!!!');
    }
    const limited = await app.inject({ method: 'GET', url: `/api/teams/${ids.team}/spaces`, headers: { authorization: basic('viewer'), origin }, remoteAddress: '198.51.100.20' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.body).not.toContain(users.viewer.email);
    expect(limited.body).not.toContain(password);
  });
});
