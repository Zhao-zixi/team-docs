import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';

const origin = 'http://localhost:5173';
const csrf = { 'x-requested-with': 'TeamShelf', origin };
const password = 'correct horse battery staple 7';
const memberPassword = 'another correct horse battery staple 8';
const setupToken = 'persistence-test-only-secret-token-long-enough';
const directories: string[] = [];
const openApps: Array<ReturnType<typeof createApp>> = [];

function runScript(script: string, args: string[], dataDir: string) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function createAppAt(dataDir: string) {
  const config: AppConfig = { port: 3000, dataDir, appOrigin: origin, setupToken, cookieSecure: false, isProduction: false };
  const app = createApp({ config, serveClient: false });
  await app.ready();
  return app;
}

describe('file-backed persistence and offline backup restore', () => {
  afterEach(async () => {
    await Promise.all(openApps.splice(0).map((app) => app.close().catch(() => {})));
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('persists ordinary-user grants and restores a WAL snapshot while revoking sessions and pending invitations', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-persistence-'));
    directories.push(dataDir);
    let app = await createAppAt(dataDir);
    const initialized = await app.inject({ method: 'POST', url: '/api/setup', headers: csrf, payload: {
      token: setupToken, name: 'Owner', email: 'owner@example.com', password, teamName: 'Research',
    } });
    expect(initialized.statusCode).toBe(201);
    const ownerCookie = (initialized.headers['set-cookie'] as string).split(';')[0]!;
    const { id: teamId } = initialized.json().teams[0];

    const acceptedInvitation = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/invitations`, headers: { ...csrf, cookie: ownerCookie }, payload: { email: 'member@example.com', role: 'viewer' } });
    expect(acceptedInvitation.statusCode).toBe(201);
    const acceptedToken = acceptedInvitation.json().token as string;
    const accepted = await app.inject({ method: 'POST', url: `/api/invitations/${encodeURIComponent(acceptedToken)}/accept`, headers: csrf, payload: { name: 'Member', password: memberPassword } });
    expect(accepted.statusCode).toBe(200);
    const memberId = accepted.json().user.id as string;

    const pendingInvitation = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/invitations`, headers: { ...csrf, cookie: ownerCookie }, payload: { email: 'pending@example.com', role: 'viewer' } });
    expect(pendingInvitation.statusCode).toBe(201);
    const pendingToken = pendingInvitation.json().token as string;

    const restrictedSpaceResponse = await app.inject({ method: 'POST', url: `/api/teams/${teamId}/spaces`, headers: { ...csrf, cookie: ownerCookie }, payload: {
      name: 'Restricted research', description: 'Persisted ACL', visibility: 'restricted', grants: [{ userId: memberId, role: 'viewer' }],
    } });
    expect(restrictedSpaceResponse.statusCode).toBe(201);
    const spaceId = restrictedSpaceResponse.json().space.id as string;
    const created = await app.inject({ method: 'POST', url: `/api/spaces/${spaceId}/documents`, headers: { ...csrf, cookie: ownerCookie }, payload: {
      title: 'Backup snapshot', body: '# Before backup\n\nSnapshot text.', visibility: 'restricted', grants: [{ userId: memberId, role: 'viewer' }],
    } });
    expect(created.statusCode).toBe(201);
    const documentId = created.json().document.id as string;
    const memberLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload: { email: 'member@example.com', password: memberPassword } });
    expect(memberLogin.statusCode).toBe(200);
    const memberCookie = (memberLogin.headers['set-cookie'] as string).split(';')[0]!;
    const memberRead = await app.inject({ method: 'GET', url: `/api/documents/${documentId}`, headers: { cookie: memberCookie } });
    expect(memberRead.statusCode).toBe(200);

    await app.close();
    app = await createAppAt(dataDir);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${documentId}`, headers: { cookie: memberCookie } })).statusCode).toBe(200);
    const backupPath = path.join(dataDir, 'snapshot.sqlite');
    runScript('scripts/backup.mjs', [backupPath], dataDir);
    const changed = await app.inject({ method: 'PATCH', url: `/api/documents/${documentId}`, headers: { ...csrf, cookie: ownerCookie }, payload: {
      title: 'After backup', body: 'Changed after snapshot.', version: 1,
    } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().document.version).toBe(2);
    const revoked = await app.inject({ method: 'PUT', url: `/api/documents/${documentId}/access`, headers: { ...csrf, cookie: ownerCookie }, payload: { visibility: 'restricted', grants: [] } });
    expect(revoked.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/documents/${documentId}`, headers: { cookie: memberCookie } })).statusCode).toBe(404);
    await app.close();

    runScript('scripts/restore.mjs', [backupPath, '--confirm'], dataDir);
    app = await createAppAt(dataDir);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: ownerCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/invitations/${encodeURIComponent(pendingToken)}` })).statusCode).toBe(404);
    const ownerLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload: { email: 'owner@example.com', password } });
    expect(ownerLogin.statusCode).toBe(200);
    const freshOwnerCookie = (ownerLogin.headers['set-cookie'] as string).split(';')[0]!;
    const restored = await app.inject({ method: 'GET', url: `/api/documents/${documentId}`, headers: { cookie: freshOwnerCookie } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().document).toMatchObject({ body: '# Before backup\n\nSnapshot text.', title: 'Backup snapshot', version: 1, visibility: 'restricted', canManage: true });
    const memberLoginAfterRestore = await app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload: { email: 'member@example.com', password: memberPassword } });
    expect(memberLoginAfterRestore.statusCode).toBe(200);
    const freshMemberCookie = (memberLoginAfterRestore.headers['set-cookie'] as string).split(';')[0]!;
    expect((await app.inject({ method: 'GET', url: `/api/teams/${teamId}/spaces`, headers: { cookie: freshMemberCookie } })).json().spaces.map((space: { id: string }) => space.id)).toContain(spaceId);
    const memberRestored = await app.inject({ method: 'GET', url: `/api/documents/${documentId}`, headers: { cookie: freshMemberCookie } });
    expect(memberRestored.statusCode).toBe(200);
    expect(memberRestored.json().document).toMatchObject({ body: '# Before backup\n\nSnapshot text.', version: 1, canEdit: false });
    const history = await app.inject({ method: 'GET', url: `/api/documents/${documentId}/revisions`, headers: { cookie: freshOwnerCookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json().revisions).toHaveLength(1);
    await app.close();
  });
});



