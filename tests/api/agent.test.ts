import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../src/server/config.js';
import { createApp } from '../../src/server/app.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashPassword, hashToken, isoNow } from '../../src/server/security.js';

const origin = 'http://localhost:5173';
const csrf = { 'x-requested-with': 'TeamShelf', origin };
let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;
let ids: { owner: string; admin: string; editor: string; viewer: string; team: string; otherTeam: string; space: string; otherSpace: string; remoteSpace: string; doc: string; otherDoc: string; remoteDoc: string };
let sessions: Record<string, string>;

function member(teamId: string, userId: string, role: string) {
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(teamId, userId, role, isoNow());
}

function seedSpace(teamId: string, creator: string, name: string) {
  const id = randomUUID();
  db.prepare(`INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)`)
    .run(id, teamId, name, creator, isoNow());
  return id;
}

function seedDocument(spaceId: string, userId: string, title: string, body: string) {
  const id = randomUUID();
  const now = isoNow();
  db.prepare(`INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at)
    VALUES(?,?,?,?,'inherit',1,?,?,?,?)`).run(id, spaceId, title, body, userId, now, userId, now);
  db.prepare(`INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,1,?,?,?,?,?)`)
    .run(randomUUID(), id, title, body, now, userId, 'seed');
  return id;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-agent-'));
  db = openDatabase(dir);
  const owner = randomUUID(); const admin = randomUUID(); const editor = randomUUID(); const viewer = randomUUID();
  const team = randomUUID(); const otherTeam = randomUUID();
  const now = isoNow();
  const insertUser = db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)');
  for (const [id, key] of [[owner, 'owner'], [admin, 'admin'], [editor, 'editor'], [viewer, 'viewer']] as const) {
    insertUser.run(id, `${key}@example.test`, `${key}@example.test`, key, 'unused', now);
  }
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(team, 'Team A', now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(otherTeam, 'Team B', now);
  member(team, owner, 'owner'); member(team, admin, 'admin'); member(team, editor, 'editor'); member(team, viewer, 'viewer');
  member(otherTeam, owner, 'owner');
  const space = seedSpace(team, owner, 'Alpha');
  const otherSpace = seedSpace(team, owner, 'Beta');
  const remoteSpace = seedSpace(otherTeam, owner, 'Remote');
  const doc = seedDocument(space, owner, 'Needle Alpha', 'shared needle in alpha');
  const otherDoc = seedDocument(otherSpace, owner, 'Needle Beta', 'shared needle in beta');
  const remoteDoc = seedDocument(remoteSpace, owner, 'Needle Remote', 'shared needle in remote');
  sessions = {};
  for (const [key, userId] of Object.entries({ owner, admin, editor, viewer })) {
    const token = `session-${key}-${randomUUID()}`;
    sessions[key] = token;
    db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), hashToken(token), userId, now, new Date(Date.now() + 86_400_000).toISOString());
  }
  ids = { owner, admin, editor, viewer, team, otherTeam, space, otherSpace, remoteSpace, doc, otherDoc, remoteDoc };
  const config: AppConfig = { port: 3000, dataDir: dir, appOrigin: origin, setupToken: 'unused', cookieSecure: false, isProduction: false };
  app = createApp({ db, config, logger: false, serveClient: false });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

function sessionRequest(user: keyof typeof sessions, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const headers: Record<string, string> = { cookie: `teamshelf_session=${sessions[user]}`, ...(method === 'GET' ? {} : csrf), ...(payload === undefined ? {} : { 'content-type': 'application/json' }) };
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

async function issue(user: keyof typeof sessions, data: Record<string, unknown>) {
  const response = await sessionRequest(user, 'POST', '/api/agent-tokens', { name: 'Test Agent', teamId: ids.team, ...data });
  expect(response.statusCode).toBe(201);
  return response.json() as { credential: { id: string; scope: string; spaceId: string | null; tokenHint: string }; token: string };
}

function bearer(token: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}`, origin, ...extraHeaders, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

describe('Agent credentials and REST bearer policy', () => {
  it('migrates a v1 database idempotently without changing existing data', async () => {
    const migrationDir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-v1-'));
    const first = openDatabase(migrationDir);
    first.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run('team-migration', 'Preserve', isoNow());
    first.exec('DROP TABLE agent_tokens; PRAGMA user_version=1;');
    first.close();
    const migrated = openDatabase(migrationDir);
    expect((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    expect(migrated.prepare("SELECT name FROM teams WHERE id='team-migration'").get()).toEqual({ name: 'Preserve' });
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tokens'").get()).toBeTruthy();
    migrated.close();
    const twice = openDatabase(migrationDir);
    expect((twice.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    twice.close();
    await rm(migrationDir, { recursive: true, force: true });
  });

  it('shows a PAT only once, stores only its hash, and restricts credential routes to browser sessions', async () => {
    const issued = await issue('owner', { scope: 'manage' });
    expect(issued.token).toMatch(/^ts_agent_[A-Za-z0-9_-]{32,}$/);
    expect(issued.credential.tokenHint).not.toBe(issued.token);
    const stored = db.prepare('SELECT token_hash,token_hint FROM agent_tokens WHERE id=?').get(issued.credential.id) as { token_hash: string; token_hint: string };
    expect(stored.token_hash).not.toBe(issued.token);
    expect(stored.token_hint).toBe(issued.credential.tokenHint);

    const list = await sessionRequest('owner', 'GET', '/api/agent-tokens');
    expect(list.statusCode).toBe(200);
    expect(list.json().credentials[0]).not.toHaveProperty('token');
    expect(list.json().credentials[0]).not.toHaveProperty('token_hash');
    expect(list.body).not.toContain(issued.token);

    expect((await bearer(issued.token, 'GET', '/api/agent-tokens')).statusCode).toBe(403);
    expect((await bearer(issued.token, 'POST', '/api/agent-tokens', { teamId: ids.team, name: 'bad' })).statusCode).toBe(403);
    expect((await bearer(issued.token, 'GET', '/api/auth/me')).statusCode).toBe(403);
    expect((await bearer(issued.token, 'GET', `/api/teams/${ids.team}/spaces`, undefined, { cookie: `teamshelf_session=${sessions.owner}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/teams/${ids.team}/spaces`, headers: { authorization: 'Bearer ' + issued.token + ' ' } })).statusCode).toBe(401);
  });

  it('binds credentials to one team and filters space-bound lists and searches before limiting', async () => {
    const teamToken = await issue('owner', { scope: 'read' });
    const otherTeam = await bearer(teamToken.token, 'GET', `/api/teams/${ids.otherTeam}/spaces`);
    expect(otherTeam.statusCode).toBe(404);
    expect(otherTeam.body).not.toContain('Remote');
    expect((await bearer(teamToken.token, 'GET', `/api/documents/${ids.remoteSpace}`)).statusCode).toBe(404);

    const scoped = await issue('owner', { scope: 'read', spaceId: ids.space });
    const spaces = await bearer(scoped.token, 'GET', `/api/teams/${ids.team}/spaces`);
    expect(spaces.statusCode).toBe(200);
    expect(spaces.json().spaces.map((entry: { id: string }) => entry.id)).toEqual([ids.space]);
    const search = await bearer(scoped.token, 'GET', `/api/teams/${ids.team}/search?q=needle`);
    expect((await bearer(scoped.token, 'GET', '/api/teams/' + ids.team + '/search?q=needle&spaceId=' + ids.otherSpace)).statusCode).toBe(404);
    expect(search.statusCode).toBe(200);
    expect(search.json().documents.map((entry: { id: string }) => entry.id)).toEqual([ids.doc]);
    expect((await bearer(scoped.token, 'GET', `/api/documents/${ids.otherDoc}`)).statusCode).toBe(404);
    expect((await bearer(scoped.token, 'GET', `/api/spaces/${ids.otherSpace}/documents`)).statusCode).toBe(404);
  });

  it('intersects token scope with the current role immediately after role downgrade', async () => {
    const issued = await issue('admin', { scope: 'manage' });
    expect((await bearer(issued.token, 'GET', `/api/teams/${ids.team}/members`)).statusCode).toBe(200);
    const downgrade = await sessionRequest('owner', 'PATCH', `/api/teams/${ids.team}/members/${ids.admin}`, { role: 'editor' });
    expect(downgrade.statusCode).toBe(200);
    expect((await bearer(issued.token, 'GET', `/api/teams/${ids.team}/members`)).statusCode).toBe(403);
    const identity = await bearer(issued.token, 'GET', '/api/agent/identity');
    expect(identity.statusCode).toBe(200);
    expect(identity.json().effectiveScope).toBe('write');
    expect((await bearer(issued.token, 'GET', `/api/teams/${ids.team}/spaces`)).statusCode).toBe(200);
  });

  it('revokes a member’s token when the member is removed', async () => {
    const issued = await issue('editor', { scope: 'write' });
    expect((await bearer(issued.token, 'GET', `/api/teams/${ids.team}/spaces`)).statusCode).toBe(200);
    const removed = await sessionRequest('owner', 'DELETE', `/api/teams/${ids.team}/members/${ids.editor}`);
    expect(removed.statusCode).toBe(200);
    const row = db.prepare('SELECT revoked_at FROM agent_tokens WHERE id=?').get(issued.credential.id) as { revoked_at: string | null };
    expect(row.revoked_at).toBeTruthy();
    expect((await bearer(issued.token, 'GET', `/api/teams/${ids.team}/spaces`)).statusCode).toBe(401);
  });

  it('enforces role ceilings on issue and manager revocation limits', async () => {
    const denied = await sessionRequest('viewer', 'POST', '/api/agent-tokens', { name: 'Too strong', teamId: ids.team, scope: 'write' });
    expect(denied.statusCode).toBe(403);
    const ownerToken = await issue('owner', { scope: 'manage' });
    const listed = await sessionRequest('admin', 'GET', `/api/teams/${ids.team}/agent-tokens`);
    expect(listed.statusCode).toBe(200);
    const revokeOwner = await sessionRequest('admin', 'DELETE', `/api/agent-tokens/${ownerToken.credential.id}`);
    expect(revokeOwner.statusCode).toBe(403);
    const selfToken = await issue('admin', { scope: 'manage' });
    const revokeSelf = await sessionRequest('admin', 'DELETE', `/api/agent-tokens/${selfToken.credential.id}`);
    expect(revokeSelf.statusCode).toBe(200);
    expect((await bearer(selfToken.token, 'GET', `/api/teams/${ids.team}/spaces`)).statusCode).toBe(401);
  });
  it('allows fixed REST document updates only with write scope and the expected version', async () => {
    const issued = await issue('editor', { scope: 'write' });
    const changed = await bearer(issued.token, 'PATCH', `/api/documents/${ids.doc}`, { title: 'Updated by PAT', body: 'written through the guarded REST route', version: 1 });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().document.version).toBe(2);
    const audit = db.prepare("SELECT actor_id,target_type,target_id,details_json FROM audit_events WHERE action='agent.document.write' ORDER BY created_at DESC LIMIT 1").get() as { actor_id: string; target_type: string; target_id: string; details_json: string };
    expect(audit.actor_id).toBe(ids.editor);
    expect(audit.target_type).toBe('document');
    expect(audit.target_id).toBe(ids.doc);
    expect(JSON.parse(audit.details_json)).toHaveProperty('credentialId', issued.credential.id);
    const stale = await bearer(issued.token, 'PATCH', `/api/documents/${ids.doc}`, { title: 'Stale', body: 'must not overwrite', version: 1 });
    expect(stale.statusCode).toBe(409);
    const row = db.prepare('SELECT title,version FROM documents WHERE id=?').get(ids.doc) as { title: string; version: number };
    expect(row).toEqual({ title: 'Updated by PAT', version: 2 });
    const extraFields = await bearer(issued.token, 'PATCH', `/api/documents/${ids.doc}`, { title: 'Invalid', body: '', version: 2, teamId: ids.otherTeam, spaceId: ids.otherSpace });
    expect(extraFields.statusCode).toBe(400);
  });

  it('paginates filtered spaces, documents, and search results beyond the first 100', async () => {
    for (let index = 0; index < 105; index++) seedSpace(ids.team, ids.owner, `Page space ${index.toString().padStart(3, '0')}`);
    for (let index = 0; index < 105; index++) seedDocument(ids.space, ids.owner, `Page doc ${index.toString().padStart(3, '0')}`, 'pagination needle');
    for (let index = 0; index < 105; index++) {
      const userId = randomUUID();
      db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(userId, `page-${index}@example.test`, `page-${index}@example.test`, `Page ${index}`, 'unused', isoNow());
      member(ids.team, userId, 'viewer');
    }
    for (let version = 2; version <= 106; version++) db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), ids.doc, version, `Revision ${version}`, 'body', isoNow(), ids.owner, 'Owner');
    const issued = await issue('owner', { scope: 'read' });
    const spaces = await bearer(issued.token, 'GET', `/api/teams/${ids.team}/spaces?offset=100&limit=100`);
    const cookieMembers = await sessionRequest('owner', 'GET', `/api/teams/${ids.team}/members`);
    expect(cookieMembers.statusCode).toBe(200);
    expect(cookieMembers.json().members).toHaveLength(109);
    const manageToken = await issue('owner', { scope: 'manage' });
    const pagedMembers = await bearer(manageToken.token, 'GET', '/api/teams/' + ids.team + '/members?offset=100&limit=100');
    expect(pagedMembers.json().members).toHaveLength(9);
    const cookieRevisions = await sessionRequest('owner', 'GET', `/api/documents/${ids.doc}/revisions`);
    expect(cookieRevisions.statusCode).toBe(200);
    expect(cookieRevisions.json().revisions).toHaveLength(106);
    const patRevisions = await bearer(issued.token, 'GET', `/api/documents/${ids.doc}/revisions?offset=100&limit=100`);
    expect(patRevisions.statusCode).toBe(200);
    expect(patRevisions.json().revisions).toHaveLength(6);
    expect(spaces.statusCode).toBe(200);
    expect(spaces.json().spaces).toHaveLength(7);
    expect(spaces.json().hasMore).toBe(false);
    expect(spaces.json().nextOffset).toBeNull();
    const documents = await bearer(issued.token, 'GET', `/api/spaces/${ids.space}/documents?offset=100&limit=100`);
    expect(documents.statusCode).toBe(200);
    expect(documents.json().documents).toHaveLength(6);
    const search = await bearer(issued.token, 'GET', `/api/teams/${ids.team}/search?q=needle&offset=100&limit=100`);
    expect(search.statusCode).toBe(200);
    expect(search.json().documents.length).toBeGreaterThan(0);
    const scopedSearch = await bearer(issued.token, 'GET', `/api/teams/${ids.team}/search?q=needle&spaceId=${ids.otherSpace}`);
    expect(scopedSearch.statusCode).toBe(200);
    expect(scopedSearch.json().documents.map((doc: { id: string }) => doc.id)).toContain(ids.otherDoc);
    expect((await bearer(issued.token, 'GET', `/api/teams/${ids.team}/search?q=needle&spaceId=${ids.remoteSpace}`)).statusCode).toBe(404);
    expect(search.json().documents).toHaveLength(7);
    expect(search.json().documents.every((doc: { spaceId: string }) => [ids.space, ids.otherSpace].includes(doc.spaceId))).toBe(true);
  });
  it('prevents write PATs from assigning document ACLs through REST', async () => {
    const writeToken = await issue('editor', { scope: 'write', spaceId: ids.space });
    const before = (db.prepare('SELECT COUNT(*) AS count FROM documents WHERE space_id=?').get(ids.space) as { count: number }).count;
    const denied = await bearer(writeToken.token, 'POST', `/api/spaces/${ids.space}/documents`, { title: 'Should not exist', body: 'secret', visibility: 'restricted', grants: [{ userId: ids.viewer, role: 'viewer' }] });
    expect(denied.statusCode).toBe(403);
    expect((db.prepare('SELECT COUNT(*) AS count FROM documents WHERE space_id=?').get(ids.space) as { count: number }).count).toBe(before);
    const ordinary = await bearer(writeToken.token, 'POST', `/api/spaces/${ids.space}/documents`, { title: 'Ordinary write', body: 'content' });
    expect(ordinary.statusCode).toBe(201);
    const manageToken = await issue('owner', { scope: 'manage', spaceId: ids.space });
    const managed = await bearer(manageToken.token, 'POST', `/api/spaces/${ids.space}/documents`, { title: 'Restricted with grant', visibility: 'restricted', grants: [{ userId: ids.viewer, role: 'viewer' }] });
    expect(managed.statusCode).toBe(201);
    expect(managed.json().document.visibility).toBe('restricted');
  });
  it('revokes PATs on password change while retaining metadata', async () => {
    const passToken = await issue('owner', { scope: 'read' });
    const hash = await hashPassword('old password that is valid 4');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, ids.owner);
    const changed = await sessionRequest('owner', 'POST', '/api/auth/password', { currentPassword: 'old password that is valid 4', newPassword: 'new password that is valid 5' });
    expect(changed.statusCode).toBe(200);
    expect((db.prepare('SELECT revoked_at FROM agent_tokens WHERE id=?').get(passToken.credential.id) as { revoked_at: string | null }).revoked_at).toBeTruthy();
    expect((await bearer(passToken.token, 'GET', `/api/teams/${ids.team}/spaces`)).statusCode).toBe(401);
  });

  it('revokes space-bound PATs on space deletion while retaining metadata', async () => {
    const spaceId = seedSpace(ids.team, ids.owner, 'Delete me');
    const spaceToken = await issue('owner', { scope: 'read', spaceId });
    const deleted = await sessionRequest('owner', 'DELETE', `/api/spaces/${spaceId}`);
    expect(deleted.statusCode).toBe(200);
    expect((db.prepare('SELECT revoked_at FROM agent_tokens WHERE id=?').get(spaceToken.credential.id) as { revoked_at: string | null }).revoked_at).toBeTruthy();
  });
});
