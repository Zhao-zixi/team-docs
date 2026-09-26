import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { openDatabase } from '../../src/server/db.js';
import type { Db } from '../../src/server/db.js';
import { hashPassword, hashToken, newToken, isoNow, expiresInDays } from '../../src/server/security.js';

const appOrigin = 'http://localhost:5173';
const headers = { 'x-requested-with': 'TeamShelf', origin: appOrigin };
const setupToken = 'team-api-setup-token-longer-than-32-characters';

describe('teams, membership, and invitations', () => {
  let dataDir: string;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let teamId: string;
  let ownerId: string;
  let adminId: string;
  let editorId: string;
  let viewerId: string;
  let cookies: Record<string, string>;
  const config: AppConfig = {
    port: 3000,
    dataDir: '',
    appOrigin,
    setupToken,
    cookieSecure: false,
    isProduction: false,
  };

  async function addUser(email: string, name: string, role?: string, forTeam = teamId, passwordHash = 'unused-password-hash') {
    const id = randomUUID();
    const now = isoNow();
    db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, email, email.toLowerCase(), name, passwordHash, now);
    if (role) db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(forTeam, id, role, now);
    const token = newToken();
    db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), hashToken(token), id, now, expiresInDays(7));
    return { id, cookie: `teamshelf_session=${token}` };
  }

  async function createInvite(email: string, role: string, cookie = cookies.owner, targetTeamId = teamId) {
    return app.inject({
      method: 'POST', url: `/api/teams/${targetTeamId}/invitations`, headers: { ...headers, cookie },
      payload: { email, role },
    });
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-team-api-'));
    db = openDatabase(dataDir);
    app = createApp({ db, config: { ...config, dataDir } });
    await app.ready();
    teamId = randomUUID();
    db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamId, 'Research', isoNow());
    const owner = await addUser('owner@example.com', 'Owner', 'owner');
    const admin = await addUser('admin@example.com', 'Admin', 'admin');
    const editor = await addUser('editor@example.com', 'Editor', 'editor');
    const viewer = await addUser('viewer@example.com', 'Viewer', 'viewer');
    ownerId = owner.id;
    adminId = admin.id;
    editorId = editor.id;
    viewerId = viewer.id;
    cookies = { owner: owner.cookie, admin: admin.cookie, editor: editor.cookie, viewer: viewer.cookie };
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('limits administrator powers and prevents owner self-demotion', async () => {
    const adminPromote = await app.inject({
      method: 'PATCH', url: `/api/teams/${teamId}/members/${viewerId}`,
      headers: { ...headers, cookie: cookies.admin }, payload: { role: 'admin' },
    });
    const selfChange = await app.inject({
      method: 'PATCH', url: `/api/teams/${teamId}/members/${adminId}`,
      headers: { ...headers, cookie: cookies.admin }, payload: { role: 'viewer' },
    });
    const ownerDemote = await app.inject({
      method: 'PATCH', url: `/api/teams/${teamId}/members/${ownerId}`,
      headers: { ...headers, cookie: cookies.owner }, payload: { role: 'viewer' },
    });
    expect([adminPromote.statusCode, selfChange.statusCode, ownerDemote.statusCode]).toEqual([403, 403, 403]);

    const ownerPromote = await app.inject({
      method: 'PATCH', url: `/api/teams/${teamId}/members/${viewerId}`,
      headers: { ...headers, cookie: cookies.owner }, payload: { role: 'admin' },
    });
    expect(ownerPromote.statusCode).toBe(200);
    expect(ownerPromote.json().member.role).toBe('admin');
  });

  it('removes grants, sessions, and pending invitations with team membership', async () => {
    const spaceId = randomUUID();
    const docId = randomUUID();
    const now = isoNow();
    db.prepare(`INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(spaceId, teamId, 'Secret', '', 'restricted', ownerId, now);
    db.prepare(`INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(docId, spaceId, 'Memo', '', 'restricted', 1, ownerId, now, ownerId, now);
    db.prepare('INSERT INTO space_grants(space_id,user_id,role) VALUES(?,?,?)').run(spaceId, editorId, 'editor');
    db.prepare('INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,?)').run(docId, editorId, 'editor');
    db.prepare(`INSERT INTO invitations(id,team_id,email,normalized_email,role,token_hash,created_by,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), teamId, 'editor@example.com', 'editor@example.com', 'viewer', hashToken(newToken()), ownerId, now, expiresInDays(7));

    const denied = await app.inject({
      method: 'DELETE', url: `/api/teams/${teamId}/members/${ownerId}`,
      headers: { ...headers, cookie: cookies.admin },
    });
    expect(denied.statusCode).toBe(403);
    const removed = await app.inject({
      method: 'DELETE', url: `/api/teams/${teamId}/members/${editorId}`,
      headers: { ...headers, cookie: cookies.owner },
    });
    expect(removed.statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS count FROM members WHERE team_id=? AND user_id=?').get(teamId, editorId) as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM space_grants WHERE user_id=?').get(editorId) as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM document_grants WHERE user_id=?').get(editorId) as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(editorId) as { count: number }).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM invitations WHERE normalized_email=? AND used_at IS NULL').get('editor@example.com') as { count: number }).count).toBe(0);
  });

  it('keeps invitation tokens one-time and accepts a new account only once', async () => {
    const created = await createInvite('new@example.com', 'editor');
    expect(created.statusCode).toBe(201);
    const { token } = created.json();
    expect(token).toBeTruthy();
    const info = await app.inject({ method: 'GET', url: `/api/invitations/${token}` });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ teamName: 'Research', email: 'new@example.com', role: 'editor' });
    expect(info.body).not.toContain(token);
    const row = db.prepare('SELECT token_hash FROM invitations WHERE email=?').get('new@example.com') as { token_hash: string };
    expect(row.token_hash).not.toBe(token);

    const accepted = await app.inject({
      method: 'POST', url: `/api/invitations/${token}/accept`, headers,
      payload: { name: 'New teammate', password: 'a newly created strong password 1' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().teams.find((team: { id: string }) => team.id === teamId).role).toBe('editor');
    expect(accepted.headers['set-cookie']).toContain('HttpOnly');
    const replay = await app.inject({
      method: 'POST', url: `/api/invitations/${token}/accept`, headers,
      payload: { name: 'New teammate', password: 'a newly created strong password 1' },
    });
    expect(replay.statusCode).toBe(404);
    expect((db.prepare('SELECT COUNT(*) AS count FROM users WHERE normalized_email=?').get('new@example.com') as { count: number }).count).toBe(1);
  });

  it('requires the existing account password and detects account creation races across teams', async () => {
    const currentHash = await hashPassword('existing account password 2');
    const existing = await addUser('existing@example.com', 'Existing', undefined, teamId, currentHash);
    const existingInvite = await createInvite('existing@example.com', 'viewer');
    const existingToken = existingInvite.json().token as string;
    const wrongPassword = await app.inject({
      method: 'POST', url: `/api/invitations/${existingToken}/accept`, headers,
      payload: { password: 'wrong password that is long enough 1' },
    });
    expect(wrongPassword.statusCode).toBe(403);
    expect((db.prepare('SELECT password_hash FROM users WHERE id=?').get(existing.id) as { password_hash: string }).password_hash).toBe(currentHash);
    expect((db.prepare('SELECT used_at FROM invitations WHERE token_hash=?').get(hashToken(existingToken)) as { used_at: string | null }).used_at).toBeNull();

    const otherTeamId = randomUUID();
    db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(otherTeamId, 'Design', isoNow());
    const otherOwner = await addUser('other-owner@example.com', 'Other owner', 'owner', otherTeamId);
    const firstInvite = await createInvite('racing@example.com', 'viewer');
    const secondInvite = await createInvite('racing@example.com', 'viewer', otherOwner.cookie, otherTeamId);
    const firstToken = firstInvite.json().token as string;
    const secondToken = secondInvite.json().token as string;
    const payload = { name: 'Racer', password: 'racing strong password 3' };
    const firstTry = await Promise.all([
      app.inject({ method: 'POST', url: `/api/invitations/${firstToken}/accept`, headers, payload }),
      app.inject({ method: 'POST', url: `/api/invitations/${secondToken}/accept`, headers, payload }),
    ]);
    expect(firstTry.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    const retryToken = firstTry[0].statusCode === 200 ? secondToken : firstToken;
    const retry = await app.inject({
      method: 'POST', url: `/api/invitations/${retryToken}/accept`, headers,
      payload: { password: payload.password },
    });
    expect(retry.statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS count FROM users WHERE normalized_email=?').get('racing@example.com') as { count: number }).count).toBe(1);
  });

  it('preserves legacy existing-account passwords while requiring a strong password for new invited accounts', async () => {
    const legacyPassword = '😀'.repeat(6);
    const legacyHash = await hashPassword(legacyPassword);
    const existing = await addUser('legacy@example.com', 'Legacy', undefined, teamId, legacyHash);
    const invite = await createInvite('legacy@example.com', 'viewer');
    const accepted = await app.inject({ method: 'POST', url: '/api/invitations/' + invite.json().token + '/accept', headers, payload: { password: legacyPassword } });
    expect(accepted.statusCode).toBe(200);
    expect((db.prepare('SELECT password_hash FROM users WHERE id=?').get(existing.id) as { password_hash: string }).password_hash).toBe(legacyHash);

    const weakInvite = await createInvite('weak-new@example.com', 'viewer');
    const weak = await app.inject({ method: 'POST', url: '/api/invitations/' + weakInvite.json().token + '/accept', headers, payload: { name: 'Weak New User', password: 'password123456789' } });
    expect(weak.statusCode).toBe(403);
    expect(db.prepare('SELECT 1 FROM users WHERE normalized_email=?').get('weak-new@example.com')).toBeUndefined();
  });
});
