import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/server/app.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashToken, isoNow } from '../../src/server/security.js';

interface Fixture {
  owner: string; editor: string; viewer: string; spaceViewer: string; docOnly: string; otherOwner: string;
  team: string; otherTeam: string; teamSpace: string; restrictedSpace: string; otherSpace: string;
  inherited: string; docRestricted: string; nested: string; nestedNoGrant: string; otherDoc: string;
  tokens: Record<string, string>;
}

let root: string;
let db: Db;
let app: FastifyInstance;
let f: Fixture;

function addMember(teamId: string, userId: string, role: string) {
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(teamId, userId, role, isoNow());
}

function addSpace(teamId: string, creatorId: string, name: string, visibility: 'team' | 'restricted') {
  const id = randomUUID();
  db.prepare(`INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'',?,?,?)`)
    .run(id, teamId, name, visibility, creatorId, isoNow());
  return id;
}

function addDocument(spaceId: string, userId: string, title: string, body: string, visibility: 'inherit' | 'restricted' = 'inherit') {
  const id = randomUUID();
  const now = isoNow();
  db.prepare(`INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at)
    VALUES(?,?,?,?,?,1,?,?,?,?)`).run(id, spaceId, title, body, visibility, userId, now, userId, now);
  db.prepare(`INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name)
    VALUES(?,?,1,?,?,?,?,?)`).run(randomUUID(), id, title, body, now, userId, 'Seed User');
  return id;
}

function addGrant(table: 'space_grants' | 'document_grants', key: 'space_id' | 'document_id', resourceId: string, userId: string, role: string) {
  db.prepare(`INSERT INTO ${table}(${key},user_id,role) VALUES(?,?,?)`).run(resourceId, userId, role);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-content-'));
  db = openDatabase(root);
  const ids = {
    owner: randomUUID(), editor: randomUUID(), viewer: randomUUID(), spaceViewer: randomUUID(),
    docOnly: randomUUID(), otherOwner: randomUUID(), team: randomUUID(), otherTeam: randomUUID(),
  };
  const now = isoNow();
  const userInsert = db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)');
  for (const [key, id] of Object.entries(ids).filter(([key]) => !['team', 'otherTeam'].includes(key))) {
    userInsert.run(id, `${key}@example.test`, `${key}@example.test`, key, 'not-used', now);
  }
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(ids.team, 'Content Team', now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(ids.otherTeam, 'Other Team', now);
  addMember(ids.team, ids.owner, 'owner');
  addMember(ids.team, ids.editor, 'editor');
  addMember(ids.team, ids.viewer, 'viewer');
  addMember(ids.team, ids.spaceViewer, 'editor');
  addMember(ids.team, ids.docOnly, 'editor');
  addMember(ids.otherTeam, ids.otherOwner, 'owner');

  const teamSpace = addSpace(ids.team, ids.owner, 'Team Space', 'team');
  const restrictedSpace = addSpace(ids.team, ids.owner, 'Restricted Space', 'restricted');
  const otherSpace = addSpace(ids.otherTeam, ids.otherOwner, 'Other Space', 'team');
  addGrant('space_grants', 'space_id', restrictedSpace, ids.spaceViewer, 'viewer');

  const inherited = addDocument(teamSpace, ids.owner, 'Open notes', '# Visible needle\n**Markdown** stays intact.');
  const docRestricted = addDocument(teamSpace, ids.owner, 'Restricted notes', 'Secret needle belongs only to a document grant.', 'restricted');
  addGrant('document_grants', 'document_id', docRestricted, ids.viewer, 'editor');
  addGrant('document_grants', 'document_id', docRestricted, ids.editor, 'editor');
  const nested = addDocument(restrictedSpace, ids.owner, 'Nested restricted', 'Nested secret needle.', 'restricted');
  addGrant('document_grants', 'document_id', nested, ids.spaceViewer, 'editor');
  const nestedNoGrant = addDocument(restrictedSpace, ids.owner, 'No document grant', 'Do not disclose nested body.', 'restricted');
  addGrant('document_grants', 'document_id', nestedNoGrant, ids.docOnly, 'editor');
  const otherDoc = addDocument(otherSpace, ids.otherOwner, 'Cross team secret', 'Never visible across teams.');

  const tokens: Record<string, string> = {};
  for (const [key, userId] of Object.entries(ids).filter(([key]) => !['team', 'otherTeam'].includes(key))) {
    const token = `test-session-${key}-${randomUUID()}`;
    tokens[key] = token;
    db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), hashToken(token), userId, now, new Date(Date.now() + 86_400_000).toISOString());
  }
  f = { ...ids, teamSpace, restrictedSpace, otherSpace, inherited, docRestricted, nested, nestedNoGrant, otherDoc, tokens };
  app = createApp({
    db,
    config: { port: 3000, dataDir: root, appOrigin: 'http://localhost:5173', setupToken: 'unused-test-token', cookieSecure: false, isProduction: false },
    logger: false,
    serveClient: false,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

function request(user: keyof Fixture['tokens'], method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const headers: Record<string, string> = { cookie: `teamshelf_session=${f.tokens[user]}` };
  if (method !== 'GET') headers['x-requested-with'] = 'TeamShelf';
  if (payload !== undefined) headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

function bearerOwner() {
  const token = `ts_agent_${randomUUID().replaceAll('-', '')}`;
  const now = isoNow();
  db.prepare(`INSERT INTO agent_tokens(id,user_id,team_id,space_id,name,scope,token_hash,token_hint,created_at,expires_at)
    VALUES(?,?,?,NULL,'review test','manage',?, 'test…token',?,?)`)
    .run(randomUUID(), f.owner, f.team, hashToken(token), now, new Date(Date.now() + 86_400_000).toISOString());
  return token;
}
function docAccess(userId: string, documentId: string, role: string) {
  addGrant('document_grants', 'document_id', documentId, userId, role);
}

describe('content and ACL API', () => {
  it('filters spaces and documents by the shared layered ACL, including cross-team isolation', async () => {
    const ownerSpaces = await request('owner', 'GET', `/api/teams/${f.team}/spaces`);
    expect(ownerSpaces.statusCode).toBe(200);
    expect(ownerSpaces.json().spaces.map((space: { id: string }) => space.id)).toContain(f.restrictedSpace);

    const viewerSpaces = await request('viewer', 'GET', `/api/teams/${f.team}/spaces`);
    expect(viewerSpaces.json().spaces.map((space: { id: string }) => space.id)).toEqual([f.teamSpace]);
    const spaceViewerSpaces = await request('spaceViewer', 'GET', `/api/teams/${f.team}/spaces`);
    expect(spaceViewerSpaces.json().spaces.map((space: { id: string }) => space.id)).toContain(f.restrictedSpace);

    const viewerDocs = await request('viewer', 'GET', `/api/spaces/${f.teamSpace}/documents`);
    const viewerDocIds = viewerDocs.json().documents.map((doc: { id: string }) => doc.id);
    expect(viewerDocIds).toContain(f.inherited);
    expect(viewerDocIds).toContain(f.docRestricted);
    expect(viewerDocs.json().documents.find((doc: { id: string }) => doc.id === f.docRestricted).canEdit).toBe(false);
    expect((await request('viewer', 'GET', `/api/documents/${f.nested}`)).statusCode).toBe(404);

    const spaceViewerDocs = await request('spaceViewer', 'GET', `/api/spaces/${f.restrictedSpace}/documents`);
    expect(spaceViewerDocs.json().documents.map((doc: { id: string }) => doc.id)).toEqual([f.nested]);
    expect(spaceViewerDocs.json().documents[0].canEdit).toBe(false);
    expect((await request('docOnly', 'GET', `/api/documents/${f.nestedNoGrant}`)).statusCode).toBe(404);
    expect((await request('owner', 'GET', `/api/documents/${f.otherDoc}`)).statusCode).toBe(404);
    expect((await request('owner', 'GET', '/api/teams/' + f.otherTeam + '/search?q=Cross')).statusCode).toBe(404);
  });

  it('searches only documents visible to the requester and does not leak hidden match counts or excerpts', async () => {
    const viewerSearch = await request('viewer', 'GET', `/api/teams/${f.team}/search?q=needle`);
    const viewerIds = viewerSearch.json().documents.map((doc: { id: string }) => doc.id);
    expect(viewerIds).toContain(f.inherited);
    expect(viewerIds).toContain(f.docRestricted);
    expect(viewerIds).not.toContain(f.nested);
    expect(viewerSearch.json().documents.some((doc: { excerpt: string }) => doc.excerpt.includes('Nested secret'))).toBe(false);

    const spaceViewerSearch = await request('spaceViewer', 'GET', `/api/teams/${f.team}/search?q=Nested`);
    expect(spaceViewerSearch.json().documents.map((doc: { id: string }) => doc.id)).toEqual([f.nested]);
    const badQuery = await request('viewer', 'GET', `/api/teams/${f.team}/search?q=%20%20`);
    expect(badQuery.statusCode).toBe(400);
    expect((await request('viewer', 'GET', `/api/teams/${f.team}/search?q=${'x'.repeat(101)}`)).statusCode).toBe(400);
  });

  it('preserves Markdown export bytes and safely encodes the attachment filename', async () => {
    const response = await request('viewer', 'GET', `/api/documents/${f.inherited}/export`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(response.body).toBe('# Visible needle\n**Markdown** stays intact.');
    expect(response.headers['cache-control']).toBe('no-store');
    expect((await request('spaceViewer', 'GET', `/api/documents/${f.nestedNoGrant}/export`)).statusCode).toBe(404);
  });

  it('applies optimistic content updates atomically, preserves raw Markdown, and stores revisions and audit', async () => {
    const editedBody = '# Header\n\n- [ ] task\n\n` code  `\n';
    const first = await request('editor', 'PATCH', `/api/documents/${f.inherited}`, { title: 'Edited title', body: editedBody, version: 1 });
    expect(first.statusCode).toBe(200);
    expect(first.json().document.body).toBe(editedBody);
    expect(first.json().document.version).toBe(2);

    const stale = await request('editor', 'PATCH', `/api/documents/${f.inherited}`, { title: 'Overwrite', body: 'bad', version: 1 });
    expect(stale.statusCode).toBe(409);
    const unchanged = await request('viewer', 'GET', `/api/documents/${f.inherited}`);
    expect(unchanged.json().document.title).toBe('Edited title');
    expect(unchanged.json().document.body).toBe(editedBody);
    expect((await request('viewer', 'PATCH', `/api/documents/${f.inherited}`, { title: 'Forbidden', body: 'x', version: 2 })).statusCode).toBe(403);

    const revisions = await request('viewer', 'GET', `/api/documents/${f.inherited}/revisions`);
    expect(revisions.json().revisions.map((revision: { version: number }) => revision.version)).toEqual([2, 1]);
    const audit = await request('owner', 'GET', `/api/teams/${f.team}/audit`);
    expect(audit.json().events.some((event: { action: string; targetId: string }) => event.action === 'document.update' && event.targetId === f.inherited)).toBe(true);
    expect((await request('editor', 'GET', `/api/teams/${f.team}/audit`)).statusCode).toBe(403);
  });

  it('restricts ACL mutations and space/document management, validates grants atomically', async () => {
    const created = await request('owner', 'POST', `/api/teams/${f.team}/spaces`, {
      name: 'New restricted', visibility: 'restricted', grants: [{ userId: f.viewer, role: 'viewer' }],
    });
    expect(created.statusCode).toBe(201);
    const newSpaceId = created.json().space.id;
    expect((await request('viewer', 'GET', `/api/spaces/${newSpaceId}/documents`)).statusCode).toBe(200);
    expect((await request('editor', 'POST', `/api/teams/${f.team}/spaces`, { name: 'Nope' })).statusCode).toBe(403);

    const before = db.prepare('SELECT COUNT(*) AS count FROM spaces WHERE team_id=?').get(f.team) as { count: number };
    const crossTeam = await request('owner', 'POST', `/api/teams/${f.team}/spaces`, {
      name: 'Invalid grant', visibility: 'restricted', grants: [{ userId: f.otherOwner, role: 'editor' }],
    });
    expect(crossTeam.statusCode).toBe(400);
    const after = db.prepare('SELECT COUNT(*) AS count FROM spaces WHERE team_id=?').get(f.team) as { count: number };
    expect(after.count).toBe(before.count);

    const access = await request('owner', 'PUT', `/api/spaces/${newSpaceId}/access`, { visibility: 'restricted', grants: [{ userId: f.editor, role: 'editor' }] });
    expect(access.statusCode).toBe(200);
    expect(access.json().grants).toEqual([{ userId: f.editor, role: 'editor' }]);
    expect((await request('viewer', 'PUT', `/api/spaces/${newSpaceId}/access`, { visibility: 'team', grants: [] })).statusCode).toBe(404);
    expect((await request('owner', 'DELETE', `/api/spaces/${f.teamSpace}`)).statusCode).toBe(409);
    expect((await request('owner', 'DELETE', `/api/spaces/${newSpaceId}`)).statusCode).toBe(200);

    const restrictedCreate = await request('editor', 'POST', `/api/spaces/${f.teamSpace}/documents`, { title: 'Private', visibility: 'restricted', grants: [] });
    expect(restrictedCreate.statusCode).toBe(403);
    const docCreated = await request('owner', 'POST', `/api/spaces/${f.teamSpace}/documents`, {
      title: 'Private for viewer', body: 'A private body.', visibility: 'restricted', grants: [{ userId: f.viewer, role: 'editor' }],
    });
    expect(docCreated.statusCode).toBe(201);
    const newDocId = docCreated.json().document.id;
    const viewerDoc = await request('viewer', 'GET', `/api/documents/${newDocId}`);
    expect(viewerDoc.statusCode).toBe(200);
    expect(viewerDoc.json().document.canEdit).toBe(false);
    expect((await request('viewer', 'PUT', `/api/documents/${newDocId}/access`, { visibility: 'inherit', grants: [] })).statusCode).toBe(403);
    expect((await request('editor', 'DELETE', '/api/documents/' + newDocId)).statusCode).toBe(404);
    expect((await request('owner', 'DELETE', `/api/documents/${newDocId}`)).statusCode).toBe(200);
  });

  it('restores only as a manager with current version and appends a new revision', async () => {
    const editorUpdate = await request('editor', 'PATCH', `/api/documents/${f.inherited}`, { title: 'Version 2', body: 'body version 2', version: 1 });
    expect(editorUpdate.statusCode).toBe(200);
    const revisions = await request('owner', 'GET', `/api/documents/${f.inherited}/revisions`);
    const versionOne = revisions.json().revisions.find((revision: { version: number }) => revision.version === 1);
    expect(versionOne).toBeTruthy();

    expect((await request('editor', 'POST', `/api/documents/${f.inherited}/revisions/${versionOne.id}/restore`, { version: 2 })).statusCode).toBe(403);
    expect((await request('owner', 'POST', `/api/documents/${f.inherited}/revisions/${versionOne.id}/restore`, { version: 1 })).statusCode).toBe(409);
    const restored = await request('owner', 'POST', `/api/documents/${f.inherited}/revisions/${versionOne.id}/restore`, { version: 2 });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().document.version).toBe(3);
    expect(restored.json().document.title).toBe('Open notes');
    expect(restored.json().document.body).toBe('# Visible needle\n**Markdown** stays intact.');
    const finalRevisions = await request('owner', 'GET', `/api/documents/${f.inherited}/revisions`);
    expect(finalRevisions.json().revisions.map((revision: { version: number }) => revision.version).sort((a: number, b: number) => a - b)).toEqual([1, 2, 3]);
  });

  it('rejects oversized content and unknown mutation fields', async () => {
    const tooLarge = await request('editor', 'PATCH', `/api/documents/${f.inherited}`, { title: 'Large', body: '🧭'.repeat(130_000), version: 1 });
    expect(tooLarge.statusCode).toBe(413);
    const extra = await request('editor', 'PATCH', `/api/documents/${f.inherited}`, { title: 'No', body: 'x', version: 1, visibility: 'restricted' });
    expect(extra.statusCode).toBe(400);
    const badTitle = await request('owner', 'POST', `/api/spaces/${f.teamSpace}/documents`, { title: '   ', body: '' });
    expect(badTitle.statusCode).toBe(400);
  });
  it('explains effective access and previews space/document ACL changes without side effects', async () => {
    const explanation = await request('owner', 'GET', `/api/spaces/${f.restrictedSpace}/access/explain?userId=${f.spaceViewer}`);
    expect(explanation.statusCode).toBe(200);
    expect(explanation.json().effective).toEqual({ canRead: true, canEdit: false, canManage: false });
    expect(explanation.json().reasons.some((reason: { layer: string; code: string }) => reason.layer === 'space' && reason.code === 'space_grant')).toBe(true);
    expect((await request('spaceViewer', 'GET', `/api/spaces/${f.restrictedSpace}/access/explain?userId=${f.spaceViewer}`)).statusCode).toBe(403);
    expect((await request('owner', 'GET', `/api/spaces/${f.otherSpace}/access/explain?userId=${f.otherOwner}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/spaces/${f.restrictedSpace}/access/explain?userId=${f.spaceViewer}`, headers: { authorization: `Bearer ${bearerOwner()}`, origin: 'http://localhost:5173' } })).statusCode).toBe(403);

    const spaceBefore = db.prepare('SELECT visibility FROM spaces WHERE id=?').get(f.teamSpace) as { visibility: string };
    const spacePreview = await request('owner', 'POST', `/api/spaces/${f.teamSpace}/access/preview`, {
      visibility: 'restricted', grants: [{ userId: f.viewer, role: 'viewer' }], offset: 0, limit: 1,
    });
    expect(spacePreview.statusCode).toBe(200);
    expect(spacePreview.json().totals.membersChanged).toBeGreaterThan(0);
    expect(spacePreview.json().totals.documentsReadLost).toBeGreaterThan(0);
    expect(spacePreview.json().hasMore).toBe(true);
    expect((db.prepare('SELECT visibility FROM spaces WHERE id=?').get(f.teamSpace) as { visibility: string }).visibility).toBe(spaceBefore.visibility);
    expect(db.prepare('SELECT 1 FROM space_grants WHERE space_id=?').get(f.teamSpace)).toBeUndefined();

    const docPreview = await request('owner', 'POST', `/api/documents/${f.docRestricted}/access/preview`, {
      visibility: 'restricted', grants: [],
    });
    expect(docPreview.statusCode).toBe(200);
    expect(docPreview.json().totals.readLost).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM document_grants WHERE document_id=?').get(f.docRestricted)).toEqual({ count: 2 });
    expect((await request('editor', 'POST', `/api/documents/${f.docRestricted}/access/preview`, { visibility: 'inherit', grants: [] })).statusCode).toBe(403);
    expect((await request('owner', 'POST', `/api/documents/${f.otherDoc}/access/preview`, { visibility: 'inherit', grants: [] })).statusCode).toBe(404);
  });

  it('submits immutable proposals and approves create/update/delete only by a different current manager', async () => {
    db.prepare('UPDATE spaces SET require_review=1 WHERE id=?').run(f.teamSpace);
    const create = await request('editor','POST',`/api/spaces/${f.teamSpace}/proposals`,{kind:'create',title:'Proposed note',body:'snapshot body',visibility:'inherit',grants:[]});
    expect(create.statusCode).toBe(201);
    const createId=create.json().proposal.id;
    expect((await request('editor','POST',`/api/proposals/${createId}/decision`,{decision:'approve'})).statusCode).toBe(403);
    const approvedCreate=await request('owner','POST',`/api/proposals/${createId}/decision`,{decision:'approve'});
    expect(approvedCreate.statusCode).toBe(200);
    const createdDoc=db.prepare("SELECT id,title,body,version FROM documents WHERE space_id=? AND title='Proposed note'").get(f.teamSpace) as {id:string;title:string;body:string;version:number};
    expect(createdDoc).toMatchObject({title:'Proposed note',body:'snapshot body',version:1});
    expect(db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE document_id=?').get(createdDoc.id)).toEqual({n:1});

    const update=await request('editor','POST',`/api/documents/${f.inherited}/proposals`,{kind:'update',baseVersion:1,title:'Proposed title',body:'proposed body'});
    expect(update.statusCode).toBe(201);
    expect(update.json().proposal.body).toBe('proposed body');
    expect((await request('owner','POST',`/api/proposals/${update.json().proposal.id}/decision`,{decision:'approve'})).statusCode).toBe(200);
    expect((await request('viewer','GET',`/api/documents/${f.inherited}`)).json().document).toMatchObject({title:'Proposed title',body:'proposed body',version:2});

    db.prepare("UPDATE members SET role='admin' WHERE team_id=? AND user_id=?").run(f.team,f.editor);
    const deleteProposal=await request('owner','POST',`/api/documents/${f.inherited}/proposals`,{kind:'delete',baseVersion:2});
    expect(deleteProposal.statusCode).toBe(201);
    expect((await request('editor','POST',`/api/proposals/${deleteProposal.json().proposal.id}/decision`,{decision:'approve'})).statusCode).toBe(200);
    expect(db.prepare('SELECT 1 FROM documents WHERE id=?').get(f.inherited)).toBeUndefined();
    const retained=db.prepare('SELECT status,target_document_id,body FROM proposals WHERE id=?').get(deleteProposal.json().proposal.id) as {status:string;target_document_id:string;body:string};
    expect(retained).toMatchObject({status:'approved',target_document_id:f.inherited,body:'proposed body'});
    const teamQueue=await request('editor','GET',`/api/teams/${f.team}/proposals?status=approved&limit=10`);
    expect(teamQueue.statusCode).toBe(200);
    expect(teamQueue.json().proposals.length).toBeGreaterThanOrEqual(3);
    expect(teamQueue.json().proposals[0]).not.toHaveProperty('body');
    const editorMine=await request('editor','GET',`/api/teams/${f.team}/proposals?mine=true&status=approved`);
    expect(editorMine.statusCode).toBe(200);
    expect(editorMine.json().proposals.every((item:{authorId:string})=>item.authorId===f.editor)).toBe(true);
    expect((await request('viewer','GET',`/api/proposals/${createId}`)).statusCode).toBe(404);
    const ownerToken=bearerOwner();
    const agentMine=await app.inject({method:'GET',url:`/api/teams/${f.team}/proposals`,headers:{authorization:`Bearer ${ownerToken}`,origin:'http://localhost:5173'}});
    expect(agentMine.statusCode).toBe(200);
    expect(agentMine.json().proposals.every((item:{authorId:string})=>item.authorId===f.owner)).toBe(true);
    expect((await app.inject({method:'GET',url:`/api/proposals/${createId}`,headers:{authorization:`Bearer ${ownerToken}`,origin:'http://localhost:5173'}})).statusCode).toBe(404);
    expect((await request('viewer','GET',`/api/proposals/${createId}`)).statusCode).toBe(404);
  });
  it('rechecks review policy, author permissions and CAS during decision; supports restore and withdraw', async () => {
    const enabled=await request('owner','PUT',`/api/spaces/${f.teamSpace}/review-policy`,{requireReview:true});
    expect(enabled.statusCode).toBe(200);
    expect((await request('editor','PUT',`/api/spaces/${f.teamSpace}/review-policy`,{requireReview:false})).statusCode).toBe(403);
    const revision=db.prepare('SELECT id FROM revisions WHERE document_id=? AND version=1').get(f.inherited) as {id:string};
    const restore=await request('owner','POST',`/api/documents/${f.inherited}/proposals`,{kind:'restore',baseVersion:1,revisionId:revision.id});
    expect(restore.statusCode).toBe(201);
    const token=bearerOwner();
    const agentDecision=await app.inject({method:'POST',url:`/api/proposals/${restore.json().proposal.id}/decision`,headers:{authorization:`Bearer ${token}`,origin:'http://localhost:5173','content-type':'application/json'},payload:JSON.stringify({decision:'approve'})});
    expect(agentDecision.statusCode).toBe(403);
    expect((await request('editor','POST',`/api/proposals/${restore.json().proposal.id}/decision`,{decision:'approve'})).statusCode).toBe(403);
    expect((await request('owner','POST',`/api/proposals/${restore.json().proposal.id}/decision`,{decision:'approve'})).statusCode).toBe(403);
    db.prepare("UPDATE members SET role='admin' WHERE team_id=? AND user_id=?").run(f.team,f.editor);
    expect((await request('editor','POST',`/api/proposals/${restore.json().proposal.id}/decision`,{decision:'approve'})).statusCode).toBe(200);
    expect((await request('owner','GET',`/api/documents/${f.inherited}`)).json().document).toMatchObject({version:2,title:'Open notes'});

    const stale=await request('editor','POST',`/api/documents/${f.inherited}/proposals`,{kind:'update',baseVersion:2,title:'Stale proposal',body:'must not publish'});
    expect(stale.statusCode).toBe(201);
    expect((await request('owner','PUT',`/api/spaces/${f.teamSpace}/review-policy`,{requireReview:false})).statusCode).toBe(200);
    expect((await request('editor','PATCH',`/api/documents/${f.inherited}`,{title:'Direct v3',body:'direct v3',version:2})).statusCode).toBe(200);
    expect((await request('owner','PUT',`/api/spaces/${f.teamSpace}/review-policy`,{requireReview:true})).statusCode).toBe(200);
    const staleDecision=await request('owner','POST',`/api/proposals/${stale.json().proposal.id}/decision`,{decision:'approve'});
    expect(staleDecision.statusCode).toBe(409);
    expect((db.prepare('SELECT status FROM proposals WHERE id=?').get(stale.json().proposal.id) as {status:string}).status).toBe('conflicted');
    expect((await request('owner','GET',`/api/documents/${f.inherited}`)).json().document).toMatchObject({version:3,title:'Direct v3',body:'direct v3'});

    const authorLoss=await request('editor','POST',`/api/documents/${f.inherited}/proposals`,{kind:'update',baseVersion:3,title:'Lost author',body:'blocked'});
    expect(authorLoss.statusCode).toBe(201);
    db.prepare("UPDATE members SET role='viewer' WHERE team_id=? AND user_id=?").run(f.team,f.editor);
    const lostDecision=await request('owner','POST',`/api/proposals/${authorLoss.json().proposal.id}/decision`,{decision:'approve'});
    expect(lostDecision.statusCode).toBe(409);
    expect((db.prepare('SELECT status FROM proposals WHERE id=?').get(authorLoss.json().proposal.id) as {status:string}).status).toBe('conflicted');

    const withdraw=await request('owner','POST',`/api/documents/${f.inherited}/proposals`,{kind:'delete',baseVersion:3});
    expect(withdraw.statusCode).toBe(201);
    expect((await request('owner','POST',`/api/proposals/${withdraw.json().proposal.id}/withdraw`,{})).statusCode).toBe(200);
    db.prepare("UPDATE members SET role='admin' WHERE team_id=? AND user_id=?").run(f.team,f.editor);
    expect((await request('editor','POST',`/api/proposals/${withdraw.json().proposal.id}/decision`,{decision:'approve'})).statusCode).toBe(409);
  });

  it('reports team access health with ACL-derived counts, pagination and manager-only access', async () => {
    const response = await request('owner', 'GET', `/api/teams/${f.team}/access/health?offset=0&limit=1`);
    expect(response.statusCode).toBe(200);
    expect(response.json().totals).toMatchObject({ members: 5, spaces: 2, documents: 4 });
    expect(response.json().members).toHaveLength(1);
    expect(response.json().hasMore).toBe(true);
    expect(response.json().nextOffset).toBe(1);
    const firstPage = response.json();
    const secondPage = await request('owner', 'GET', `/api/teams/${f.team}/access/health?offset=${firstPage.nextOffset}&limit=10`);
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json().hasMore).toBe(false);
    expect(secondPage.json().nextOffset).toBeNull();
    const allMembers = [...firstPage.members, ...secondPage.json().members] as Array<{userId:string;spacesReadable:number;spacesEditable:number;documentsReadable:number;documentsEditable:number}>;
    expect(allMembers).toHaveLength(response.json().totals.members);
    expect(new Set(allMembers.map((member) => member.userId)).size).toBe(response.json().totals.members);
    const viewerRow = allMembers.find((member) => member.userId === f.viewer);
    expect(viewerRow).toMatchObject({spacesReadable:1,spacesEditable:0,documentsReadable:2,documentsEditable:0});
    expect((await request('editor', 'GET', `/api/teams/${f.team}/access/health`)).statusCode).toBe(403);
    const bearer = await app.inject({method:'GET',url:`/api/teams/${f.team}/access/health`,headers:{authorization:`Bearer ${bearerOwner()}`,origin:'http://localhost:5173'}});
    expect(bearer.statusCode).toBe(403);
    expect((await request('owner', 'GET', `/api/teams/${f.otherTeam}/access/health`)).statusCode).toBe(404);
  });
  it('blocks all direct document mutations in review-required spaces without altering published state', async () => {
    db.prepare('UPDATE spaces SET require_review=1 WHERE id=?').run(f.teamSpace);
    const policy = await request('owner', 'GET', `/api/spaces/${f.teamSpace}/review-policy`);
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toEqual({ requireReview: true });
    expect((await request('editor', 'GET', `/api/spaces/${f.teamSpace}/review-policy`)).statusCode).toBe(403);

    const created = await request('owner', 'POST', `/api/spaces/${f.teamSpace}/documents`, { title: 'Blocked', body: 'draft' });
    const patched = await request('editor', 'PATCH', `/api/documents/${f.inherited}`, { title: 'Blocked', body: 'new body', version: 1 });
    const restored = await request('owner', 'POST', `/api/documents/${f.inherited}/revisions/${db.prepare('SELECT id FROM revisions WHERE document_id=? AND version=1').get(f.inherited)?.id}/restore`, { version: 1 });
    const deleted = await request('owner', 'DELETE', `/api/documents/${f.inherited}`);
    for (const response of [created, patched, restored, deleted]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('REVIEW_REQUIRED');
    }
    expect((await request('owner', 'GET', `/api/documents/${f.inherited}`)).json().document).toMatchObject({ version: 1, body: '# Visible needle\n**Markdown** stays intact.' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM documents WHERE space_id=?').get(f.teamSpace)).toEqual({ count: 2 });

    const token = bearerOwner();
    const mcpRest = await app.inject({ method: 'PATCH', url: `/api/documents/${f.inherited}`, headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:5173', 'content-type': 'application/json' }, payload: JSON.stringify({ title: 'Agent blocked', body: 'blocked', version: 1 }) });
    expect(mcpRest.statusCode).toBe(409);
    expect(mcpRest.json().error.code).toBe('REVIEW_REQUIRED');
  });
});
