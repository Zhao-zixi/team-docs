import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import type { AppConfig } from '../../src/server/config.js';
import { hashPassword, isoNow } from '../../src/server/security.js';

const distBridge = path.resolve('dist/mcp/stdio.js');
const secret = 'production-bridge-test-password-42';
const tempDirs: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
const databases: Db[] = [];
const children: ChildProcess[] = [];
const transports: StdioClientTransport[] = [];
const clients: Client[] = [];
const skipped = !existsSync(distBridge);

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
  await Promise.all(transports.splice(0).map(transport => transport.close().catch(() => undefined)));
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('production stdio bridge to TeamShelf HTTP MCP', () => {
  it.skipIf(skipped)('uses the production dist bridge for account auth and observes password changes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-stdio-real-'));
    tempDirs.push(dir);
    const db: Db = openDatabase(dir);
    databases.push(db);
    const userId = randomUUID(); const teamId = randomUUID(); const spaceId = randomUUID(); const documentId = randomUUID();
    const now = isoNow();
    db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(userId, 'stdio@example.invalid', 'stdio@example.invalid', 'Stdio Test', await hashPassword(secret), now);
    db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamId, 'Stdio Live Team', now);
    db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(teamId, userId, 'viewer', now);
    db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(spaceId, teamId, 'Live Space', userId, now);
    db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'Production bridge body','inherit',1,?,?,?,?)").run(documentId, spaceId, 'Live MCP document', userId, now, userId, now);
    db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,1,?,?,?,?,?)').run(randomUUID(), documentId, 'Live MCP document', 'Production bridge body', now, userId, 'Stdio Test');
    const config: AppConfig = { port: 0, dataDir: dir, appOrigin: 'http://127.0.0.1', setupToken: '', cookieSecure: false, isProduction: false };
    const app = createApp({ db, config, logger: false, serveClient: false });
    apps.push(app);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const endpoint = new URL('/mcp', address).href;
    const transport = new StdioClientTransport({ command: process.execPath, args: [distBridge], cwd: process.cwd(), env: { ...process.env, TEAMSHELF_MCP_URL: endpoint, TEAMSHELF_MCP_EMAIL: 'stdio@example.invalid', TEAMSHELF_MCP_PASSWORD: secret }, stderr: 'pipe' });
    transports.push(transport);
    let stderr = '';
    const child = (transport as unknown as { _process?: ChildProcess })._process;
    if (child) { children.push(child); child.stderr?.on('data', chunk => { stderr += chunk.toString(); }); }
    const client = new Client({ name: 'teamshelf-production-stdio-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain('get_document');
    expect(listed.tools.map(tool => tool.name)).not.toContain('create_document');
    const read = await client.callTool({ name: 'get_document', arguments: { documentId } });
    expect(JSON.stringify(read)).toContain('Production bridge body');
    expect(JSON.stringify(read)).toContain('Live MCP document');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword('stdio-password-rotated-73'), userId);
    let rejection = '';
    try { await client.callTool({ name: 'whoami', arguments: {} }); }
    catch (error) { rejection = error instanceof Error ? error.message : 'error'; }
    expect(rejection).not.toBe('');
    expect(rejection).not.toContain(secret);
    await client.close();
    expect(stderr).not.toContain(secret);

    const renewedTransport = new StdioClientTransport({ command: process.execPath, args: [distBridge], cwd: process.cwd(), env: { ...process.env, TEAMSHELF_MCP_URL: endpoint, TEAMSHELF_MCP_EMAIL: 'stdio@example.invalid', TEAMSHELF_MCP_PASSWORD: 'stdio-password-rotated-73' }, stderr: 'pipe' });
    transports.push(renewedTransport);
    const renewedClient = new Client({ name: 'teamshelf-production-stdio-renewed-test', version: '1.0.0' }); clients.push(renewedClient);
    await renewedClient.connect(renewedTransport);
    expect((await renewedClient.callTool({ name: 'list_teams', arguments: {} })).isError).not.toBe(true);
  });
});
