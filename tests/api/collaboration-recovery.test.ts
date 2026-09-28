import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/server/app.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashToken, isoNow } from '../../src/server/security.js';
import { getCollaborativeTitle, seedMarkdownDraft } from '../../src/shared/collaboration-schema.js';

let root: string;
let db: Db;
let app: FastifyInstance;
let userId: string;
let documentId: string;
let session: string;
let draftId: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-draft-recovery-'));
  db = openDatabase(root);
  const now = isoNow(), teamId = randomUUID(), spaceId = randomUUID();
  userId = randomUUID(); documentId = randomUUID(); session = `recovery-${randomUUID()}`;
  db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(userId,'recovery@example.test','recovery@example.test','Recovery Editor','unused',now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamId,'Recovery Team',now);
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(teamId,userId,'editor',now);
  db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(spaceId,teamId,'Recovery Space',userId,now);
  db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,'inherit',1,?,?,?,?)").run(documentId,spaceId,'Restart title','# Published',userId,now,userId,now);
  db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(randomUUID(),hashToken(session),userId,now,new Date(Date.now()+3600000).toISOString());
  app = createApp({ db, config:{port:3000,dataDir:root,appOrigin:'http://localhost:5173',setupToken:'unused',cookieSecure:false,isProduction:false},logger:false,serveClient:false });
  await app.ready();
  const response=await app.inject({method:'POST',url:`/api/documents/${documentId}/draft`,headers:{cookie:`teamshelf_session=${session}`,'x-requested-with':'TeamShelf'},payload:{mode:'markdown'}});
  expect(response.statusCode).toBe(201); draftId=response.json().draft.id;
});

afterEach(async()=>{await app.close();db.close();await rm(root,{recursive:true,force:true});});

function websocketQueue() {
  const queue:Buffer[]=[]; const waiters:Array<(data:Buffer)=>void>=[];
  return { attach(socket:{on(event:'message',listener:(data:Buffer)=>void):unknown}) { socket.on('message',data=>{const waiter=waiters.shift();if(waiter)waiter(Buffer.from(data));else queue.push(Buffer.from(data));}); },
    next():Promise<Buffer>{const item=queue.shift();if(item)return Promise.resolve(item);return new Promise(resolve=>waiters.push(resolve));} };
}
function applyStep2(doc:Y.Doc,packet:Uint8Array){const decoder=decoding.createDecoder(packet);expect(decoding.readVarUint(decoder)).toBe(0);expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsSyncStep2);Y.applyUpdate(doc,decoding.readVarUint8Array(decoder));}

describe('draft persistence and flush barrier',()=>{
  it('returns 409 for each stale flush field and leaves both the official document and editable Yjs state intact',async()=>{
    const draft=new Y.Doc(); const seeded=seedMarkdownDraft(draft,'# Published\nlocal draft','Restart title');expect(seeded.ok).toBe(true);
    const yState=Buffer.from(Y.encodeStateAsUpdate(draft));draft.destroy();
    db.prepare("UPDATE document_drafts SET y_state=?,seq=1 WHERE id=?").run(yState,draftId);
    const before=db.prepare('SELECT title,body,version FROM documents WHERE id=?').get(documentId);
    const expected={expectedSeq:1,expectedBaseVersion:1,expectedTitle:'Restart title',expectedBody:'# Published\nlocal draft'};
    const stale=[{...expected,expectedSeq:2},{...expected,expectedBaseVersion:2},{...expected,expectedTitle:'wrong'},{...expected,expectedBody:'wrong'}];
    for(const payload of stale){
      const response=await app.inject({method:'POST',url:`/api/documents/${documentId}/draft/publish`,headers:{cookie:`teamshelf_session=${session}`,'x-requested-with':'TeamShelf'},payload});
      expect(response.statusCode).toBe(409);
      expect(db.prepare('SELECT title,body,version FROM documents WHERE id=?').get(documentId)).toEqual(before);
      const saved=db.prepare('SELECT y_state,seq,state FROM document_drafts WHERE id=?').get(draftId) as {y_state:Uint8Array;seq:number;state:string};
      expect(saved.seq).toBe(1);expect(saved.state).toBe('editing');expect(Buffer.from(saved.y_state).equals(yState)).toBe(true);
    }
    const accepted=await app.inject({method:'POST',url:`/api/documents/${documentId}/draft/publish`,headers:{cookie:`teamshelf_session=${session}`,'x-requested-with':'TeamShelf'},payload:expected});
    expect(accepted.statusCode).toBe(200);
    expect(db.prepare('SELECT title,body,version FROM documents WHERE id=?').get(documentId)).toEqual({title:'Restart title',body:'# Published\nlocal draft',version:2});
  });

  it('rejects blank collaborative titles for publish and submit while preserving the editable draft',async()=>{
    const draft=new Y.Doc();const seeded=seedMarkdownDraft(draft,'# Still private','A valid title');expect(seeded.ok).toBe(true);
    const title=getCollaborativeTitle(draft)!;title.delete(0,title.length);title.insert(0,'   ');
    const yState=Buffer.from(Y.encodeStateAsUpdate(draft));draft.destroy();db.prepare('UPDATE document_drafts SET y_state=?,seq=1 WHERE id=?').run(yState,draftId);
    const teamId=(db.prepare('SELECT s.team_id FROM spaces s JOIN documents d ON d.space_id=s.id WHERE d.id=?').get(documentId) as {team_id:string}).team_id;
    db.prepare('UPDATE spaces SET require_review=1 WHERE team_id=?').run(teamId);
    const body={expectedSeq:1,expectedBaseVersion:1,expectedTitle:'   ',expectedBody:'# Still private'};
    for(const route of ['publish','submit']){
      const response=await app.inject({method:'POST',url:`/api/documents/${documentId}/draft/${route}`,headers:{cookie:`teamshelf_session=${session}`,'x-requested-with':'TeamShelf'},payload:body});
      expect(response.statusCode).toBe(400);
      expect(db.prepare('SELECT title,body,version FROM documents WHERE id=?').get(documentId)).toEqual({title:'Restart title',body:'# Published',version:1});
      const saved=db.prepare('SELECT y_state,seq,state FROM document_drafts WHERE id=?').get(draftId) as {y_state:Uint8Array;seq:number;state:string};
      expect(saved.seq).toBe(1);expect(saved.state).toBe('editing');expect(Buffer.from(saved.y_state).equals(yState)).toBe(true);
    }
  });
  it('restores through GET and a fresh WebSocket after app close/reopen, then accepts another edit',async()=>{
    const stored=db.prepare('SELECT y_state FROM document_drafts WHERE id=?').get(draftId) as {y_state:Uint8Array};
    const offline=new Y.Doc();Y.applyUpdate(offline,Uint8Array.from(stored.y_state));offline.getText('body').insert(offline.getText('body').length,'\ncommitted before restart');
    const update=encoding.createEncoder();encoding.writeVarUint(update,0);syncProtocol.writeUpdate(update,Y.encodeStateAsUpdate(offline));
    const pending=websocketQueue();
    const socket=await app.injectWS(`/api/collaboration/${draftId}`,{headers:{host:'localhost',cookie:`teamshelf_session=${session}`,origin:'http://localhost:5173'},socket:{remoteAddress:'127.0.0.1'} as never},{onInit:ws=>pending.attach(ws as never)});
    const ack=pending.next();socket.send(encoding.toUint8Array(update));await ack;socket.close();offline.destroy();await app.close();

    app=createApp({db,config:{port:3000,dataDir:root,appOrigin:'http://localhost:5173',setupToken:'unused',cookieSecure:false,isProduction:false},logger:false,serveClient:false});await app.ready();
    const got=await app.inject({method:'GET',url:`/api/documents/${documentId}/draft`,headers:{cookie:`teamshelf_session=${session}`}});
    expect(got.statusCode).toBe(200);expect(got.json().draft).toMatchObject({id:draftId,documentId,mode:'markdown',state:'editing',seq:1,baseVersion:1});
    const restored=new Y.Doc(),messages=websocketQueue();
    const reconnected=await app.injectWS(`/api/collaboration/${draftId}`,{headers:{host:'localhost',cookie:`teamshelf_session=${session}`,origin:'http://localhost:5173'},socket:{remoteAddress:'127.0.0.1'} as never},{onInit:ws=>messages.attach(ws as never)});
    const hello=encoding.createEncoder();encoding.writeVarUint(hello,0);syncProtocol.writeSyncStep1(hello,restored);
    const initial=messages.next();reconnected.send(encoding.toUint8Array(hello));applyStep2(restored,await initial);
    expect(restored.getText('body').toString()).toBe('# Published\ncommitted before restart');
    const vector=Y.encodeStateVector(restored);restored.getText('body').insert(restored.getText('body').length,'\nafter restart');
    const next=encoding.createEncoder();encoding.writeVarUint(next,0);syncProtocol.writeUpdate(next,Y.encodeStateAsUpdate(restored,vector));
    reconnected.send(encoding.toUint8Array(next)); for(let attempt=0;attempt<50;attempt++){const current=db.prepare('SELECT seq FROM document_drafts WHERE id=?').get(draftId) as {seq:number};if(current.seq===2)break;await new Promise(resolve=>setTimeout(resolve,10));}
    const saved=db.prepare('SELECT y_state,seq FROM document_drafts WHERE id=?').get(draftId) as {y_state:Uint8Array;seq:number};
    const finalDoc=new Y.Doc();Y.applyUpdate(finalDoc,Uint8Array.from(saved.y_state));expect(saved.seq).toBe(2);expect(finalDoc.getText('body').toString()).toBe('# Published\ncommitted before restart\nafter restart');
    reconnected.close();restored.destroy();finalDoc.destroy();
  });
  it('reopens a conflicted submitted draft, explicitly rebases it, and allows resubmission without replacing its Y state',async()=>{
    const now=isoNow(),managerId=randomUUID(),managerSession=`reviewer-${randomUUID()}`;
    const teamId=(db.prepare('SELECT team_id FROM spaces WHERE id=(SELECT space_id FROM documents WHERE id=?)').get(documentId) as {team_id:string}).team_id;
    db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(managerId,'reviewer@example.test','reviewer@example.test','Reviewer','unused',now);
    db.prepare("INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,'owner',?)").run(teamId,managerId,now);
    db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(randomUUID(),hashToken(managerSession),managerId,now,new Date(Date.now()+3600000).toISOString());
    db.prepare('UPDATE spaces SET require_review=1 WHERE team_id=?').run(teamId);
    const draft=new Y.Doc();const seeded=seedMarkdownDraft(draft,'# Published\\nconflict-safe edit','Restart title');expect(seeded.ok).toBe(true);
    const yState=Buffer.from(Y.encodeStateAsUpdate(draft));draft.destroy();db.prepare("UPDATE document_drafts SET y_state=?,seq=1 WHERE id=?").run(yState,draftId);
    const snapshot={expectedSeq:1,expectedBaseVersion:1,expectedTitle:'Restart title',expectedBody:'# Published\\nconflict-safe edit'};
    const submitted=await app.inject({method:'POST',url:`/api/documents/${documentId}/draft/submit`,headers:{cookie:`teamshelf_session=${session}`,'x-requested-with':'TeamShelf'},payload:snapshot});
    expect(submitted.statusCode).toBe(200);const proposalId=submitted.json().proposal.id;
    db.prepare("UPDATE documents SET body='concurrent published edit',version=2 WHERE id=?").run(documentId);
    const decision=await app.inject({method:'POST',url:`/api/proposals/${proposalId}/decision`,headers:{cookie:`teamshelf_session=${managerSession}`,'x-requested-with':'TeamShelf'},payload:{decision:'approve'}});
    expect(decision.statusCode).toBe(409);
    expect((db.prepare('SELECT status FROM proposals WHERE id=?').get(proposalId) as {status:string}).status).toBe('conflicted');
    const reopened=db.prepare('SELECT y_state,seq,state,base_version FROM document_drafts WHERE id=?').get(draftId) as {y_state:Uint8Array;seq:number;state:string;base_version:number};
    expect(reopened.state).toBe('editing');expect(reopened.seq).toBe(1);expect(reopened.base_version).toBe(1);expect(Buffer.from(reopened.y_state).equals(yState)).toBe(true);
    const rebased=await app.inject({method:'POST',url:`/api/documents/${documentId}/draft/rebase`,headers:{cookie:`teamshelf_session=${session}`,'x-requested-with':'TeamShelf'},payload:{...snapshot,expectedDocumentVersion:2,acknowledged:true}});
    expect(rebased.statusCode).toBe(200);expect(rebased.json().draft).toMatchObject({id:draftId,baseVersion:2,state:'editing',seq:1});expect(rebased.json().previousBaseVersion).toBe(1);
    const afterRebase=db.prepare('SELECT y_state,seq,state,base_version FROM document_drafts WHERE id=?').get(draftId) as {y_state:Uint8Array;seq:number;state:string;base_version:number};
    expect(Buffer.from(afterRebase.y_state).equals(yState)).toBe(true);expect(afterRebase.seq).toBe(1);
    const resubmitted=await app.inject({method:'POST',url:`/api/documents/${documentId}/draft/submit`,headers:{cookie:`teamshelf_session=${session}`,'x-requested-with':'TeamShelf'},payload:{...snapshot,expectedBaseVersion:2}});
    expect(resubmitted.statusCode).toBe(200);expect(resubmitted.json().proposal.status).toBe('pending');
    expect((db.prepare('SELECT state,base_version FROM document_drafts WHERE id=?').get(draftId) as {state:string;base_version:number})).toEqual({state:'reviewing',base_version:2});
  });});
