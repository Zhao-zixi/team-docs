import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { openDatabase } from '../../src/server/db.js';
import type { Db } from '../../src/server/db.js';
import { sendConfiguredMail, type OutgoingMail } from '../../src/server/mailer.js';
import { hashToken, isoNow, newToken, expiresInDays } from '../../src/server/security.js';

const origin = 'http://localhost:5173';
const baseHeaders = { origin, 'x-requested-with': 'TeamShelf' };

describe('personal SMTP settings and email invitations', () => {
  let dataDir: string;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let ownerId: string;
  let adminId: string;
  let ownerCookie: string;
  let adminCookie: string;
  let teamId: string;
  let sent: OutgoingMail[];
  let shouldFail: boolean;

  function addUser(email: string, role: string): { id: string; cookie: string } {
    const id = randomUUID();
    const now = isoNow();
    db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, email, email.toLowerCase(), email.split('@')[0], 'fixture-hash', now);
    db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(teamId, id, role, now);
    const token = newToken();
    db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), hashToken(token), id, now, expiresInDays(7));
    return { id, cookie: `teamshelf_session=${token}` };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-mail-api-'));
    db = openDatabase(dataDir);
    teamId = randomUUID();
    db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamId, 'Mail Team', isoNow());
    const owner = addUser('owner@example.test', 'owner');
    const admin = addUser('admin@example.test', 'admin');
    ownerId = owner.id; adminId = admin.id; ownerCookie = owner.cookie; adminCookie = admin.cookie;
    sent = [];
    shouldFail = false;
    app = createApp({
      db,
      config: { port: 3000, dataDir, appOrigin: origin, setupToken: 'test-only-token', cookieSecure: false, isProduction: false } satisfies AppConfig,
      mailSender: async (_db, _dir, _userId, message) => { sent.push(message); if (shouldFail) throw new Error('secret provider diagnostic'); },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stores an encrypted credential, limits password reuse to the same auth target, and sends tests only to the logged-in user', async () => {
    const settings = { host: 'smtp.example.test', port: 465, security: 'tls', username: 'owner-mail', fromEmail: 'noreply@example.test', fromName: 'TeamShelf' };
    const put = await app.inject({ method: 'PUT', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: ownerCookie }, payload: { ...settings, password: 'smtp-secret-should-not-return' } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('smtp-secret-should-not-return');
    expect(JSON.parse(put.body).settings).toEqual({ ...settings, hasPassword: true });
    const stored = db.prepare('SELECT password_ciphertext,password_iv,password_tag FROM mail_settings WHERE user_id=?').get(ownerId) as Record<string, string>;
    expect(Object.values(stored)).not.toContain('smtp-secret-should-not-return');
    const keyStat = await stat(path.join(dataDir, 'mail-encryption.key'));
    if (process.platform !== 'win32') expect(keyStat.mode & 0o777).toBe(0o600);

    const fromOnly = await app.inject({ method: 'PUT', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: ownerCookie }, payload: { ...settings, fromEmail: 'new-from@example.test' } });
    expect(fromOnly.statusCode).toBe(200);
    const changedHost = await app.inject({ method: 'PUT', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: ownerCookie }, payload: { ...settings, host: 'other.example.test' } });
    expect(changedHost.statusCode).toBe(403);
    expect((db.prepare('SELECT host FROM mail_settings WHERE user_id=?').get(ownerId) as { host: string }).host).toBe(settings.host);
    const replacePassword = await app.inject({ method: 'PUT', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: ownerCookie }, payload: { ...settings, host: 'other.example.test', password: 'new-smtp-secret' } });
    expect(replacePassword.statusCode).toBe(200);

    const testMail = await app.inject({ method: 'POST', url: '/api/mail/settings/test', headers: { ...baseHeaders, cookie: ownerCookie }, payload: {} });
    expect(testMail.statusCode).toBe(200);
    expect(JSON.parse(testMail.body)).toEqual({ sent: true, to: 'owner@example.test' });
    expect(sent.at(-1)?.to).toBe('owner@example.test');
    expect(sent.at(-1)?.text).not.toContain('smtp-secret-should-not-return');
    shouldFail = true;
    const sendFailure = await app.inject({ method: 'POST', url: '/api/mail/settings/test', headers: { ...baseHeaders, cookie: ownerCookie }, payload: {} });
    expect(sendFailure.json()).toEqual({ sent: false, to: 'owner@example.test', error: '邮件发送失败，请检查配置和服务商状态。' });
    expect(sendFailure.body).not.toContain('secret provider diagnostic');
    shouldFail = false;

    const withCustomRecipient = await app.inject({ method: 'POST', url: '/api/mail/settings/test', headers: { ...baseHeaders, cookie: ownerCookie }, payload: { to: 'attacker@example.test' } });
    expect(withCustomRecipient.statusCode).toBe(400);
    const bearer = await app.inject({ method: 'GET', url: '/api/mail/settings', headers: { authorization: `Bearer ts_agent_${'a'.repeat(43)}` } });
    expect([401, 403]).toContain(bearer.statusCode);
  });

  it('fails closed when an existing SMTP secret loses its key while document service stays available', async () => {
    const settings = { host: 'smtp.example.test', port: 465, security: 'tls', username: 'owner-mail', fromEmail: 'owner@example.test', fromName: 'TeamShelf', password: 'smtp-secret' };
    expect((await app.inject({ method: 'PUT', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: ownerCookie }, payload: settings })).statusCode).toBe(200);
    await rm(path.join(dataDir, 'mail-encryption.key'));
    await app.close();
    app = createApp({ db, config: { port: 3000, dataDir, appOrigin: origin, setupToken: 'test-only-token', cookieSecure: false, isProduction: false } satisfies AppConfig });
    await app.ready();
    const test = await app.inject({ method: 'POST', url: '/api/mail/settings/test', headers: { ...baseHeaders, cookie: ownerCookie }, payload: {} });
    expect(test.statusCode).toBe(200);
    expect(JSON.parse(test.body)).toEqual({ sent: false, to: 'owner@example.test', error: '邮件发送失败，请检查配置和服务商状态。' });
    const preserve = await app.inject({ method: 'PUT', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: ownerCookie }, payload: { ...settings, password: '' } });
    expect(preserve.statusCode).toBe(500);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const deleteOwn = await app.inject({ method: 'DELETE', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: ownerCookie } });
    expect(deleteOwn.statusCode).toBe(200);
    const reconfigure = await app.inject({ method: 'PUT', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: ownerCookie }, payload: settings });
    expect(reconfigure.statusCode).toBe(200);
  });

  it('sends and resends one-time invitations with token rotation and creator role checks', async () => {
    const invite = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/invitations/email`, headers: { ...baseHeaders, cookie: adminCookie }, payload: { email: 'new-person@example.test', role: 'viewer' } });
    expect(invite.statusCode).toBe(201);
    const first = JSON.parse(invite.body) as { invitation: { id: string; deliveryStatus: string }; delivery: string };
    expect(first.delivery).toBe('sent');
    expect(first.invitation.deliveryStatus).toBe('sent');
    expect(invite.body).not.toContain('token');
    const tokenFrom = (message: OutgoingMail) => new URL(message.text.match(/https?:\/\/\S+/)![0]).searchParams.get('invite')!;
    const firstToken = tokenFrom(sent.at(-1)!);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${firstToken}` })).statusCode).toBe(200);

    shouldFail = true;
    const failed = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/invitations/${first.invitation.id}/send`, headers: { ...baseHeaders, cookie: adminCookie } });
    expect(failed.statusCode).toBe(200);
    expect(JSON.parse(failed.body).delivery).toBe('failed');
    const secondToken = tokenFrom(sent.at(-1)!);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${firstToken}` })).statusCode).toBe(404);

    shouldFail = false;
    const resent = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/invitations/${first.invitation.id}/send`, headers: { ...baseHeaders, cookie: ownerCookie } });
    expect(JSON.parse(resent.body).delivery).toBe('sent');
    const thirdToken = tokenFrom(sent.at(-1)!);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${secondToken}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${thirdToken}` })).statusCode).toBe(200);
    const inviteRow = db.prepare('SELECT created_by,delivery_status,last_sent_at FROM invitations WHERE id=?').get(first.invitation.id) as { created_by: string; delivery_status: string; last_sent_at: string };
    expect(inviteRow.created_by).toBe(ownerId);
    expect(inviteRow.delivery_status).toBe('sent');
    expect(inviteRow.last_sent_at).toBeTruthy();

    const adminCannotInviteAdmin = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/invitations/email`, headers: { ...baseHeaders, cookie: adminCookie }, payload: { email: 'another@example.test', role: 'admin' } });
    expect(adminCannotInviteAdmin.statusCode).toBe(403);
  });

  it('revokes a manager’s pending invitations immediately on demotion', async () => {
    const token = newToken();
    const invitationId = randomUUID();
    const now = isoNow();
    db.prepare(`INSERT INTO invitations(id,team_id,email,normalized_email,role,token_hash,created_by,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(invitationId, teamId, 'pending@example.test', 'pending@example.test', 'viewer', hashToken(token), adminId, now, expiresInDays(7));
    const demote = await app.inject({ method: 'PATCH', url: `/api/teams/${teamId}/members/${adminId}`, headers: { ...baseHeaders, cookie: ownerCookie }, payload: { role: 'editor' } });
    expect(demote.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${token}` })).statusCode).toBe(404);
    expect(db.prepare('SELECT 1 FROM invitations WHERE id=?').get(invitationId)).toBeUndefined();
  });

  it('rejects Bearer mail mutations, admin-role resends by admins, and expired or consumed invitation resends', async () => {
    const agentToken = 'ts_agent_' + newToken();
    const now = isoNow();
    db.prepare('INSERT INTO agent_tokens(id,user_id,team_id,space_id,name,scope,token_hash,token_hint,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), adminId, teamId, null, 'test agent', 'manage', hashToken(agentToken), agentToken.slice(-6), now, expiresInDays(2));
    const bearer = await app.inject({ method: 'POST', url: '/api/teams/' + teamId + '/invitations/email', headers: { ...baseHeaders, authorization: 'Bearer ' + agentToken }, payload: { email: 'bearer@example.test', role: 'viewer' } });
    expect(bearer.statusCode).toBe(401);

    const adminInvite = await app.inject({ method: 'POST', url: '/api/teams/' + teamId + '/invitations', headers: { ...baseHeaders, cookie: ownerCookie }, payload: { email: 'new-admin@example.test', role: 'admin' } });
    expect(adminInvite.statusCode).toBe(201);
    const adminInvitationId = adminInvite.json().invitation.id as string;
    const adminResend = await app.inject({ method: 'POST', url: '/api/teams/' + teamId + '/invitations/' + adminInvitationId + '/send', headers: { ...baseHeaders, cookie: adminCookie } });
    expect(adminResend.statusCode).toBe(403);
    db.prepare('UPDATE invitations SET used_at=? WHERE id=?').run(isoNow(), adminInvitationId);
    const usedResend = await app.inject({ method: 'POST', url: '/api/teams/' + teamId + '/invitations/' + adminInvitationId + '/send', headers: { ...baseHeaders, cookie: ownerCookie } });
    expect(usedResend.statusCode).toBe(404);

    const expiredId = randomUUID();
    db.prepare('INSERT INTO invitations(id,team_id,email,normalized_email,role,token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(expiredId, teamId, 'expired@example.test', 'expired@example.test', 'viewer', hashToken(newToken()), ownerId, now, new Date(Date.now() - 1000).toISOString());
    const expiredResend = await app.inject({ method: 'POST', url: '/api/teams/' + teamId + '/invitations/' + expiredId + '/send', headers: { ...baseHeaders, cookie: ownerCookie } });
    expect(expiredResend.statusCode).toBe(404);
    const wrongTeam = await app.inject({ method: 'POST', url: '/api/teams/' + randomUUID() + '/invitations/email', headers: { ...baseHeaders, cookie: ownerCookie }, payload: { email: 'cross@example.test', role: 'viewer' } });
    expect(wrongTeam.statusCode).toBe(403);
  });

  it('lets a demoted user delete their own mail settings but denies read and send', async () => {
    const settings = { host: 'smtp.example.test', port: 465, security: 'tls', username: 'admin-mail', fromEmail: 'admin@example.test', fromName: 'TeamShelf', password: 'private-mail-secret' };
    const put = await app.inject({ method: 'PUT', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: adminCookie }, payload: settings });
    expect(put.statusCode).toBe(200);
    const demote = await app.inject({ method: 'PATCH', url: '/api/teams/' + teamId + '/members/' + adminId, headers: { ...baseHeaders, cookie: ownerCookie }, payload: { role: 'editor' } });
    expect(demote.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: adminCookie } })).statusCode).toBe(403);
    const removed = await app.inject({ method: 'DELETE', url: '/api/mail/settings', headers: { ...baseHeaders, cookie: adminCookie } });
    expect(removed.statusCode).toBe(200);
    expect(db.prepare('SELECT 1 FROM mail_settings WHERE user_id=?').get(adminId)).toBeUndefined();
  });
});

