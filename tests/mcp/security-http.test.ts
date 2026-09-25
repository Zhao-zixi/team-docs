import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import type { AppConfig } from '../../src/server/config.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashToken, isoNow } from '../../src/server/security.js';

const origin = 'http://127.0.0.1';
let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;
let endpoint: URL;
let ids: { owner: string; admin: string; viewer: string; team: string; space: string; doc: string; revision: string };
let viewerSpaceCredentialId: string;
const tokens: Record<string, string> = {};
const clients: Client[] = [];

async function connect(token: string, mode: 'legacy' | 'auto' = 'legacy') {
const client = new Client({ name: `mcp-security-${mode}`, version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: { token: async () => token } });
  await client.connect(transport);
  if (mode === 'auto') expect(transport.protocolVersion).toBe('2026-07-28');
  clients.push(client);
  return client;
}

function cookieRequest(url: string, method: 'PATCH' | 'DELETE' | 'PUT', payload?: unknown) {
  return app.inject({ method, url, payload, headers: { cookie: `teamshelf_session=${tokens.ownerSession}`, origin, 'x-requested-with': 'TeamShelf', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) } });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-mcp-security-'));
  db = openDatabase(dir);
  const now = isoNow();
  const owner = randomUUID(); const admin = randomUUID(); const viewer = randomUUID();
  const team = randomUUID(); const space = randomUUID(); const doc = randomUUID(); const revision = randomUUID();
  const users = db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)');
  for (const [id,email,name] of [[owner,'owner@mcp.test','Owner'],[admin,'admin@mcp.test','Admin'],[viewer,'viewer@mcp.test','Viewer']] as const) users.run(id,email,email,name,'unused',now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(team,'MCP Security Team',now);
  const addMember = db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)');
  addMember.run(team,owner,'owner',now); addMember.run(team,admin,'admin',now); addMember.run(team,viewer,'viewer',now);
  db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(space,team,'Private scope',owner,now);
  db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'Sensitive body','restricted',1,?,?,?,?)").run(doc,space,'Restricted note',owner,now,owner,now);
  db.prepare('INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,?)').run(doc,viewer,'viewer');
  db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,1,?,?,?,? ,?)').run(revision,doc,'Restricted note','Sensitive body',now,owner,'Owner');
  tokens.owner = `ts_agent_${'o'.repeat(40)}`; tokens.admin = `ts_agent_${'a'.repeat(40)}`; tokens.viewer = `ts_agent_${'v'.repeat(40)}`; tokens.ownerSession = `session-${randomUUID()}`;
  const addToken = db.prepare('INSERT INTO agent_tokens(id,user_id,team_id,space_id,name,scope,token_hash,token_hint,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  addToken.run(randomUUID(),owner,team,null,'Owner read','read',hashToken(tokens.owner),'ownhint',now,new Date(Date.now()+86400000).toISOString());
  addToken.run(randomUUID(),admin,team,null,'Admin manage','manage',hashToken(tokens.admin),'adminhint',now,new Date(Date.now()+86400000).toISOString());
  addToken.run(randomUUID(),viewer,team,null,'Viewer read','read',hashToken(tokens.viewer),'viewhint',now,new Date(Date.now()+86400000).toISOString());
tokens.viewerSpace = `ts_agent_${'s'.repeat(40)}`;
  viewerSpaceCredentialId = randomUUID();
  addToken.run(viewerSpaceCredentialId,viewer,team,space,'Viewer space read','read',hashToken(tokens.viewerSpace),'spaceshint',now,new Date(Date.now()+86400000).toISOString());
  db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(randomUUID(),hashToken(tokens.ownerSession),owner,now,new Date(Date.now()+86400000).toISOString());
  ids = { owner, admin, viewer, team, space, doc, revision };
  const config: AppConfig = { port: 0, dataDir: dir, appOrigin: origin, setupToken: '', cookieSecure: false, isProduction: false };
  app = createApp({ db, config, logger: false, serveClient: false });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  endpoint = new URL('/mcp', address);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => undefined)));
  await app?.close(); db?.close(); if (dir) await rm(dir, { recursive: true, force: true });
});

describe('MCP authorization remains current across HTTP sessions', () => {
  it('supports SDK legacy and auto negotiation with concurrent independent PAT identities', async () => {
    const owner = await connect(tokens.owner, 'legacy');
    const viewer = await connect(tokens.viewer, 'auto');
    const [ownerResult, viewerResult] = await Promise.all([
      owner.callTool({ name: 'whoami', arguments: {} }),
      viewer.callTool({ name: 'whoami', arguments: {} }),
    ]);
    expect(JSON.stringify(ownerResult)).toContain('Owner');
    expect(JSON.stringify(viewerResult)).toContain('Viewer');
    expect(JSON.stringify(ownerResult)).not.toContain('Sensitive body');
  });

  it('attributes outer MCP audit events to the token team for a space-bound PAT', async () => {
    const scoped = await connect(tokens.viewerSpace);
    const result = await scoped.callTool({ name: 'list_spaces', arguments: {} });
    expect(result.isError).not.toBe(true);
    const rows = db.prepare("SELECT target_type,target_id FROM audit_events WHERE json_extract(details_json,'$.credentialId')=? ORDER BY rowid DESC LIMIT 2").all(viewerSpaceCredentialId) as Array<{ target_type: string; target_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.target_type === 'team' && row.target_id === ids.team)).toBe(true);
  });
  it('rechecks current role and ACL on the same established MCP client', async () => {
    const admin = await connect(tokens.admin);
    expect((await admin.listTools()).tools.map(tool => tool.name)).toContain('list_audit');
    const demoted = await cookieRequest(`/api/teams/${ids.team}/members/${ids.admin}`, 'PATCH', { role: 'editor' });
    expect(demoted.statusCode).toBe(200);
    const identity = await admin.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.stringify(identity)).toContain('effectiveScope');
    expect(JSON.stringify(identity)).toContain('write');
    const deniedManage = await app.inject({ method: 'GET', url: '/api/teams/' + ids.team + '/audit', headers: { authorization: 'Bearer ' + tokens.admin, origin } });
    expect(deniedManage.statusCode).toBe(403);

    const viewer = await connect(tokens.viewer);
    const before = await viewer.callTool({ name: 'get_document', arguments: { documentId: ids.doc } });
    expect(before.isError).not.toBe(true);
    const changedAcl = await cookieRequest(`/api/documents/${ids.doc}/access`, 'PUT', { visibility: 'restricted', grants: [] });
    expect(changedAcl.statusCode).toBe(200);
    const after = await viewer.callTool({ name: 'get_document', arguments: { documentId: ids.doc } });
    expect(after.isError).toBe(true);
    expect(JSON.stringify(after)).not.toContain('Sensitive body');
  });
});
