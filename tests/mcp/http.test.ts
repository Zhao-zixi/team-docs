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

  it('exposes author-scoped proposal tools and scoped workflow operations without approval or sharing tools', async () => {
    db.prepare('UPDATE spaces SET require_review=1 WHERE id=?').run(spaceId);
    const writeNames=(await writeClient.listTools()).tools.map(tool=>tool.name);
    expect(writeNames).toContain('propose_document_create');expect(writeNames).toContain('propose_document_update');expect(writeNames).toContain('withdraw_my_proposal');expect(writeNames).not.toContain('propose_document_delete');expect(writeNames).not.toContain('decide_proposal');expect(writeNames).not.toContain('create_external_room');expect(writeNames).not.toContain('set_mail_settings');

    const createResult=await writeClient.callTool({name:'propose_document_create',arguments:{spaceId,title:'MCP proposed page',markdown:'proposal body'}});
    expect(createResult.isError).not.toBe(true);
    const created=JSON.parse((createResult.content[0] as {text:string}).text) as {proposal:{id:string;status:string;kind:string}};
    expect(created.proposal).toMatchObject({status:'pending',kind:'create'});
    expect(db.prepare("SELECT COUNT(*) AS count FROM documents WHERE title='MCP proposed page'").get()).toEqual({count:0});

    const own=await ownerClient.callTool({name:'list_my_proposals',arguments:{status:'pending'}});
    expect(JSON.stringify(own)).toContain(created.proposal.id);
    expect((await ownerClient.callTool({name:'get_my_proposal',arguments:{proposalId:created.proposal.id}})).isError).not.toBe(true);
    const withdrawn=await writeClient.callTool({name:'withdraw_my_proposal',arguments:{proposalId:created.proposal.id}});
    expect(withdrawn.isError).not.toBe(true);
    expect((db.prepare('SELECT status FROM proposals WHERE id=?').get(created.proposal.id) as {status:string}).status).toBe('withdrawn');

    const updated=await writeClient.callTool({name:'propose_document_update',arguments:{documentId,version:1,title:'Proposed update',markdown:'proposed body'}});
    const updateProposalId=(JSON.parse((updated.content[0] as {text:string}).text) as {proposal:{id:string}}).proposal.id;
    expect(updated.isError).not.toBe(true);
    expect(db.prepare('SELECT title,body,version FROM documents WHERE id=?').get(documentId)).toEqual({title:'Seed document',body:'# Seed body',version:1});
    const added=await writeClient.callTool({name:'add_document_comment',arguments:{documentId,source:{kind:'published',version:1},quote:'Seed body',anchor:{paragraphIndex:0,startOffset:0,endOffset:10},body:'Review this paragraph',mentionUserIds:[]}});
    expect(added.isError).not.toBe(true);const thread=JSON.parse((added.content[0] as {text:string}).text) as {comment:{id:string}};
    const listedComments=await ownerClient.callTool({name:'list_document_comments',arguments:{documentId}});
    expect(JSON.stringify(listedComments)).toContain('Review this paragraph');
    const reply=await writeClient.callTool({name:'reply_to_comment',arguments:{threadId:thread.comment.id,body:'I will revise it.',mentionUserIds:[]}});
    expect(reply.isError).not.toBe(true);
    const resolved=await writeClient.callTool({name:'resolve_comment',arguments:{threadId:thread.comment.id,resolved:true}});
    expect(resolved.isError).not.toBe(true);

    const manageSecret='ts_agent_'+'m'.repeat(40);
    db.prepare('INSERT INTO agent_tokens(id,user_id,team_id,space_id,name,scope,token_hash,token_hint,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),userId,teamId,null,'manage test','manage',hashToken(manageSecret),'hint',isoNow(),new Date(Date.now()+86400000).toISOString());
    const manager=await connect(manageSecret);
    try {
      const bearerHeaders={authorization:`Bearer ${manageSecret}`,'x-requested-with':'TeamShelf','content-type':'application/json'};
      expect((await app.inject({method:'POST',url:`/api/proposals/${updateProposalId}/decision`,headers:bearerHeaders,payload:{decision:'approve'}})).statusCode).toBe(403);
      expect((await app.inject({method:'PUT',url:'/api/mail/settings',headers:bearerHeaders,payload:{host:'localhost',port:465,security:'tls',username:'x',fromEmail:'x@example.test',fromName:'x',password:'x'}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:`/api/teams/${teamId}/rooms`,headers:bearerHeaders,payload:{name:'must not create',expiresAt:new Date(Date.now()+3600000).toISOString(),password:'room secret',items:[{documentId,publishedVersion:1}]}})).statusCode).toBe(403);
      expect((await app.inject({method:'PUT',url:`/api/teams/${teamId}/reminders`,headers:bearerHeaders,payload:{enabled:true,senderUserId:userId}})).statusCode).toBe(403);
      const names=(await manager.listTools()).tools.map(tool=>tool.name);
      expect(names).toContain('propose_document_restore');expect(names).toContain('propose_document_delete');expect(names).toContain('set_document_workflow');expect(names).toContain('mark_document_reviewed');
      expect(names).not.toContain('decide_proposal');expect(names).not.toContain('create_external_room');expect(names).not.toContain('set_mail_settings');
      const revisionId=(db.prepare('SELECT id FROM revisions WHERE document_id=? AND version=1').get(documentId) as {id:string}).id;
      const restore=await manager.callTool({name:'propose_document_restore',arguments:{documentId,version:1,revisionId}});
      expect(restore.isError).not.toBe(true);
      const removal=await manager.callTool({name:'propose_document_delete',arguments:{documentId,version:1}});
      expect(removal.isError).not.toBe(true);
      const workflow=await manager.callTool({name:'set_document_workflow',arguments:{documentId,responsibleUserId:userId,reviewAt:null,dueAt:null,metadataVersion:0}});
      expect(workflow.isError).not.toBe(true);
      const viewed=await writeClient.callTool({name:'get_document_workflow',arguments:{documentId}});
      expect(JSON.stringify(viewed)).toContain(userId);
      const reviewed=await writeClient.callTool({name:'mark_document_reviewed',arguments:{documentId,metadataVersion:1}});
      expect(reviewed.isError).not.toBe(true);
    } finally { await manager.close(); }
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
