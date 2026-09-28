import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/server/app.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { processReminderOutbox } from '../../src/server/workflow.js';
import { hashToken, isoNow } from '../../src/server/security.js';

let root:string;let db:Db;let app:FastifyInstance;
const f={owner:randomUUID(),editor:randomUUID(),viewer:randomUUID(),team:randomUUID(),space:randomUUID(),doc:randomUUID()};
const token:{owner:string;editor:string;viewer:string}={owner:'',editor:'',viewer:''};
const sent:Array<{to:string;subject:string;text:string}>=[];
function req(user:'owner'|'editor'|'viewer',method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:unknown){const headers:Record<string,string>={cookie:`teamshelf_session=${token[user]}`};if(method!=='GET')headers['x-requested-with']='TeamShelf';if(payload!==undefined)headers['content-type']='application/json';return app.inject({method,url,headers,...(payload===undefined?{}:{payload:JSON.stringify(payload)})});}
beforeEach(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'teamshelf-workflow-'));db=openDatabase(root);const now=isoNow();
 for(const [key,id] of Object.entries({owner:f.owner,editor:f.editor,viewer:f.viewer})){db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(id,`${key}@example.test`,`${key}@example.test`,key,'unused',now);const session=`wf-${key}-${randomUUID()}`;token[key as keyof typeof token]=session;db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(randomUUID(),hashToken(session),id,now,new Date(Date.now()+86400000).toISOString());}
 db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(f.team,'Workflow Team',now);
 for(const [id,role] of [[f.owner,'owner'],[f.editor,'editor'],[f.viewer,'viewer']] as const)db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(f.team,id,role,now);
 db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(f.space,f.team,'Space',f.owner,now);
 db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'body','inherit',1,?,?,?,?)").run(f.doc,f.space,'Workflow doc',f.owner,now,f.owner,now);
 db.prepare('INSERT INTO mail_settings(user_id,host,port,security,username,from_email,from_name,password_ciphertext,password_iv,password_tag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(f.owner,'smtp.example.test',465,'tls','owner','owner@example.test','Owner','cipher','iv','tag',now,now);
 sent.length=0;
 app=createApp({db,config:{port:3000,dataDir:root,appOrigin:'http://localhost:5173',setupToken:'unused',cookieSecure:false,isProduction:false},logger:false,serveClient:false,mailSender:async(_db,_dir,_sender,message)=>{sent.push(message);}});await app.ready();
});
afterEach(async()=>{await app.close();db.close();await rm(root,{recursive:true,force:true});});

describe('workflow and reminder outbox',()=>{
 it('uses independent metadata CAS and only assigns a current editor',async()=>{
  const payload={responsibleUserId:f.editor,reviewAt:null,dueAt:null,metadataVersion:0};
  const result=await req('owner','PATCH',`/api/documents/${f.doc}/workflow`,payload);expect(result.statusCode).toBe(200);expect(result.json().workflow.metadataVersion).toBe(1);expect(result.json().workflow.responsibleName).toBe('editor');
  expect((await req('owner','PATCH',`/api/documents/${f.doc}/workflow`,payload)).statusCode).toBe(409);
  expect((await req('editor','PATCH',`/api/documents/${f.doc}/workflow`,{...payload,metadataVersion:1})).statusCode).toBe(403);
  expect((await req('owner','PATCH',`/api/documents/${f.doc}/workflow`,{...payload,responsibleUserId:f.viewer,metadataVersion:1})).statusCode).toBe(403);
  const document=db.prepare('SELECT version,body FROM documents WHERE id=?').get(f.doc) as {version:number;body:string};expect(document).toEqual({version:1,body:'body'});
 });
 it('requires a responsible editor to retain live edit ACL when marking reviewed',async()=>{
  expect((await req('owner','PATCH',`/api/documents/${f.doc}/workflow`,{responsibleUserId:f.editor,reviewAt:new Date(Date.now()-1000).toISOString(),dueAt:null,metadataVersion:0})).statusCode).toBe(200);
  db.prepare("UPDATE spaces SET visibility='restricted' WHERE id=?").run(f.space);
  db.prepare("INSERT INTO space_grants(space_id,user_id,role) VALUES(?,?,'viewer')").run(f.space,f.editor);
  const denied=await req('editor','POST',`/api/documents/${f.doc}/workflow/mark-reviewed`,{metadataVersion:1});
  expect(denied.statusCode).toBe(403);
  expect((db.prepare('SELECT last_reviewed_at FROM document_workflow WHERE document_id=?').get(f.doc) as {last_reviewed_at:string|null}).last_reviewed_at).toBeNull();
  const manager=await req('owner','POST',`/api/documents/${f.doc}/workflow/mark-reviewed`,{metadataVersion:1});
  expect(manager.statusCode).toBe(200);expect(manager.json().workflow.lastReviewedAt).toBeTruthy();expect(manager.json().workflow.metadataVersion).toBe(2);
 }); it('sends only current due reminders once and cancels tasks after recipient access is revoked',async()=>{
  const past=new Date(Date.now()-60_000).toISOString();
  expect((await req('owner','PUT',`/api/teams/${f.team}/reminders`,{enabled:true,senderUserId:f.owner})).statusCode).toBe(200);
  expect((await req('owner','PATCH',`/api/documents/${f.doc}/workflow`,{responsibleUserId:f.editor,reviewAt:past,dueAt:past,metadataVersion:0})).statusCode).toBe(200);
  await processReminderOutbox({db,config:{port:3000,dataDir:root,appOrigin:'http://localhost:5173',setupToken:'unused',cookieSecure:false,isProduction:false},mailSender:async(_db,_dir,_sender,message)=>{sent.push(message);}});
  expect(sent).toHaveLength(2);expect(sent.every(message=>message.to==='editor@example.test')).toBe(true);
  expect((db.prepare("SELECT count(*) AS count FROM reminder_outbox WHERE status='sent'").get() as {count:number}).count).toBe(2);
  const nextDue = new Date(Date.now()-30_000).toISOString();
  expect((await req('owner','PATCH',`/api/documents/${f.doc}/workflow`,{responsibleUserId:f.editor,reviewAt:past,dueAt:nextDue,metadataVersion:1})).statusCode).toBe(200);
  await processReminderOutbox({db,config:{port:3000,dataDir:root,appOrigin:'http://localhost:5173',setupToken:'unused',cookieSecure:false,isProduction:false},mailSender:async()=>{throw new Error('smtp details must not escape');}});
  db.prepare("UPDATE reminder_outbox SET next_attempt_at=? WHERE status='pending'").run(isoNow());
  expect(sent).toHaveLength(2);
  db.prepare("UPDATE documents SET visibility='restricted' WHERE id=?").run(f.doc);
  db.prepare("INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,'editor')").run(f.doc,f.owner);
  await processReminderOutbox({db,config:{port:3000,dataDir:root,appOrigin:'http://localhost:5173',setupToken:'unused',cookieSecure:false,isProduction:false},mailSender:async(_db,_dir,_sender,message)=>{sent.push(message);}});
  expect((db.prepare("SELECT count(*) AS count FROM reminder_outbox WHERE status='cancelled'").get() as {count:number}).count).toBe(1);
  expect(sent).toHaveLength(2);
 });
});
