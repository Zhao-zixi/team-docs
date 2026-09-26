import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { createSessionAfterPasswordCheck } from '../../src/server/auth.js';
import type { AppConfig } from '../../src/server/config.js';
import { openDatabase } from '../../src/server/db.js';
import { verifyPassword } from '../../src/server/security.js';
import type { Db } from '../../src/server/db.js';

const origin = 'http://localhost:5173';
const csrf = { 'x-requested-with': 'TeamShelf', origin };
const password = 'correct horse battery staple 7';

describe('setup and session authentication', () => {
  let dataDir: string;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  const config: AppConfig = {
    port: 3000,
    dataDir: '',
    appOrigin: origin,
    setupToken: 'test-only-setup-token-which-is-long-enough-32',
    cookieSecure: false,
    isProduction: false,
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-api-'));
    db = openDatabase(dataDir);
    app = createApp({ db, config: { ...config, dataDir } });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function setup(extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: csrf,
      payload: {
        token: config.setupToken,
        name: 'Owner',
        email: 'Owner@Example.com',
        password,
        teamName: 'Research',
        ...extra,
      },
    });
  }

  it('exposes setup state without exposing the configured token and sends no-store', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ needsSetup: true });
    expect(response.headers['cache-control']).toBe('no-store');
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(health.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(health.headers['x-frame-options']).toBe('DENY');
    expect(health.headers['strict-transport-security']).toBeUndefined();
  });

  it('does not consume setup on a wrong token and atomically creates one owner/team on success', async () => {
    const bad = await setup({ token: 'wrong' });
    expect(bad.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json()).toEqual({ needsSetup: true });

    const weak = await setup({ password: 'password123456789' });
    expect(weak.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json()).toEqual({ needsSetup: true });

    const responses = await Promise.all([setup(), setup()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM members WHERE role='owner'").get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM spaces').get()).toEqual({ count: 1 });
    expect((await app.inject({ method: 'GET', url: '/api/setup' })).json()).toEqual({ needsSetup: false });
    const user = responses.find((response) => response.statusCode === 201)!.json().user;
    expect(user.email).toBe('owner@example.com');
    expect(Object.keys(user).sort()).toEqual(['email', 'id', 'name']);
    const responseData = responses.map((response) => response.body).join('\n');
    expect(responseData).not.toContain(config.setupToken);
    expect(responseData).not.toContain(password);
    expect(responseData).not.toMatch(/password_hash|passwordHash|token_hash|tokenHash/i);
  });

  it('sets a random session cookie, stores only its hash, and verifies login and logout', async () => {
    const setupResponse = await setup();
    const cookieHeader = setupResponse.headers['set-cookie'] as string;
    const cookie = cookieHeader.split(';')[0];
    const rawSession = cookie.slice(cookie.indexOf('=') + 1);
    const row = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(row.token_hash).not.toBe(rawSession);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().teams[0].role).toBe('owner');

    const loggedOut = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...csrf, cookie } });
    expect(loggedOut.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: csrf,
      payload: { email: ' OWNER@example.com ', password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().teams[0].role).toBe('owner');
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('SameSite=Lax');
  });

  it('rejects mutations without the custom header or with a mismatched Origin before touching data', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS count FROM teams').get() as { count: number }).count;
    const noHeader = await app.inject({
      method: 'POST', url: '/api/setup', headers: { origin }, payload: {},
    });
    const wrongOrigin = await app.inject({
      method: 'POST', url: '/api/setup',
      headers: { 'x-requested-with': 'TeamShelf', origin: 'https://attacker.invalid' }, payload: {},
    });
    expect(noHeader.statusCode).toBe(403);
    expect(wrongOrigin.statusCode).toBe(403);
    expect((db.prepare('SELECT COUNT(*) AS count FROM teams').get() as { count: number }).count).toBe(before);
  });

  it('requires a strong password and revokes all old sessions after password change', async () => {
    const setupResponse = await setup();
    const cookie = (setupResponse.headers['set-cookie'] as string).split(';')[0];
    const userId = setupResponse.json().user.id as string;
    const staleHash = (db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId) as { password_hash: string }).password_hash;
    expect(await verifyPassword(password, staleHash)).toBe(true);
    const weak = await app.inject({
      method: 'POST', url: '/api/auth/password', headers: { ...csrf, cookie },
      payload: { currentPassword: password, newPassword: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    const changed = await app.inject({
      method: 'POST', url: '/api/auth/password', headers: { ...csrf, cookie },
      payload: { currentPassword: password, newPassword: 'a new correct horse battery staple 8' },
    });
    expect(changed.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    expect(() => createSessionAfterPasswordCheck(db, userId, staleHash)).toThrow();
    expect((db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(userId) as { count: number }).count).toBe(0);
    const staleLogin = await app.inject({ method: 'POST', url: '/api/auth/login', headers: csrf, payload: { email: 'owner@example.com', password } });
    expect(staleLogin.statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: csrf,
      payload: { email: 'owner@example.com', password: 'a new correct horse battery staple 8' },
    });
    expect(login.statusCode).toBe(200);
  });
});
