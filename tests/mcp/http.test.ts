import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import type { AppConfig } from '../../src/server/config.js';
import { hashToken, isoNow } from '../../src/server/security.js';

const teamId = randomUUID();
const userId = randomUUID();
const spaceId = randomUUID();
const documentId = randomUUID();
const credentialId = randomUUID();
const secret = `ts_agent_${'x'.repeat(40)}`;
const origin = 'http://127.0.0.1';
let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;
let endpoint: URL;
let ownerClient: Client;
let writeClient: Client;

async function connect(token: string) {
  const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: { token: async () => token } });
  const client = new Client({ name: 'teamshelf-http-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-mcp-http-'));
  db = openDatabase(dir);
  const now = isoNow();
  db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(userId, 'owner@test.invalid', 'owner@test.invalid', 'Owner', 'unused', now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamId, 'MCP Team', now);
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(teamId, userId, 'owner', now);
  db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(spaceId, teamId, 'Knowledge', userId, now);
  db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'# Seed body','inherit',1,?,?,?,?)").run(documentId, spaceId, 'Seed document', userId, now, userId, now);
  db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,1,?,?,?,?,?)').run(randomUUID(), documentId, 'Seed document', '# Seed body', now, userId, 'Owner');
  for (const [id, token, scope] of [[credentialId, secret, 'read'], [randomUUID(), `ts_agent_${'w'.repeat(40)}`, 'write']] as const) {
    db.prepare('INSERT INTO agent_tokens(id,user_id,team_id,space_id,name,scope,token_hash,token_hint,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, teamId, null, scope, scope, hashToken(token), 'hint', now, new Date(Date.now() + 86_400_000).toISOString());
  }
  const config: AppConfig = { port: 0, dataDir: dir, appOrigin: origin, setupToken: '', cookieSecure: false, isProduction: false };
  app = createApp({ db, config, logger: false, serveClient: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  endpoint = new URL('/mcp', address);
  ownerClient = await connect(secret);
  writeClient = await connect(`ts_agent_${'w'.repeat(40)}`);
});

afterEach(async () => {
  await Promise.all([ownerClient?.close().catch(() => undefined), writeClient?.close().catch(() => undefined)]);
  await app?.close();
  db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('TeamShelf HTTP MCP tools', () => {
  it('supports SDK listing, identity and ACL-filtered reads while omitting writes for read scope', async () => {
    const listed = await ownerClient.listTools();
    const names = listed.tools.map(tool => tool.name);
    expect(names).toContain('whoami');
    expect(names).toContain('get_document');
    expect(names).not.toContain('create_document');
    const identity = await ownerClient.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.stringify(identity)).toContain('MCP Team');
    const doc = await ownerClient.callTool({ name: 'get_document', arguments: { documentId } });
    expect(JSON.stringify(doc)).toContain('# Seed body');
    const denied = await ownerClient.callTool({ name: 'get_document', arguments: { documentId: randomUUID() } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain('# Seed body');
  });

  it('limits create/update to write scope and keeps document creation on inherited ACL', async () => {
    const listed = await writeClient.listTools();
    expect(listed.tools.map(tool => tool.name)).toContain('create_document');
    const created = await writeClient.callTool({ name: 'create_document', arguments: { spaceId, title: 'Created through MCP', markdown: 'Plain body' } });
    expect(created.isError).not.toBe(true);
    const row = db.prepare('SELECT visibility,body FROM documents WHERE title=?').get('Created through MCP') as { visibility: string; body: string };
    expect(row).toEqual({ visibility: 'inherit', body: 'Plain body' });
    const version = db.prepare('SELECT version FROM documents WHERE id=?').get(documentId) as { version: number };
    const updated = await writeClient.callTool({ name: 'update_document', arguments: { documentId, title: 'Updated', markdown: 'Updated body', version: version.version } });
    expect(updated.isError).not.toBe(true);
  });

  it('finds a specific older revision across the REST pagination boundary', async () => {
    const insert = db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,?,?,?,?,?,?)');
    for (let version = 2; version <= 110; version++) insert.run(randomUUID(), documentId, version, `Version ${version}`, `body-${version}`, isoNow(), userId, 'Owner');
    const original = db.prepare('SELECT id FROM revisions WHERE document_id=? AND version=1').get(documentId) as { id: string };
    const result = await ownerClient.callTool({ name: 'get_revision', arguments: { documentId, revisionId: original.id } });
    expect(JSON.stringify(result)).toContain('# Seed body');
    expect(result.isError).not.toBe(true);
  });
  it('re-authenticates each call so revocation takes effect in an existing MCP client', async () => {
    db.prepare('UPDATE agent_tokens SET revoked_at=? WHERE id=?').run(isoNow(), credentialId);
    let rejection = '';
    try { await ownerClient.callTool({ name: 'whoami', arguments: {} }); }
    catch (error) { rejection = error instanceof Error ? error.name : 'error'; }
    expect(rejection).toBe('UnauthorizedError');
  });
});





describe('MCP single revision lookup', () => {
  it('finds an older revision and rejects a revision belonging to another document', async () => {
    const insert = db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,?,?,?,?,?,?)');
    for (let version = 2; version <= 110; version++) insert.run(randomUUID(), documentId, version, `Version ${version}`, `body-${version}`, isoNow(), userId, 'Owner');
    const original = db.prepare('SELECT id FROM revisions WHERE document_id=? AND version=1').get(documentId) as { id: string };
    const result = await ownerClient.callTool({ name: 'get_revision', arguments: { documentId, revisionId: original.id } });
    expect(JSON.stringify(result)).toContain('# Seed body');
    expect(result.isError).not.toBe(true);
    const otherDocument = randomUUID(); const otherRevision = randomUUID(); const now = isoNow();
    db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'private','inherit',1,?,?,?,?)").run(otherDocument, spaceId, 'Other document', userId, now, userId, now);
    db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,1,?,?,?,?,?)').run(otherRevision, otherDocument, 'Other document', 'private', now, userId, 'Owner');
    const mismatch = await ownerClient.callTool({ name: 'get_revision', arguments: { documentId, revisionId: otherRevision } });
    expect(mismatch.isError).toBe(true);
    expect(JSON.stringify(mismatch)).not.toContain('private');
  });
});
