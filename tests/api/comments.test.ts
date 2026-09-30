import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { registerCommentRoutes } from '../../src/server/comments.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashToken, isoNow } from '../../src/server/security.js';

let root: string; let db: Db; let app: FastifyInstance;
const u = { owner: randomUUID(), editor: randomUUID(), viewer: randomUUID(), stranger: randomUUID(), team: randomUUID(), space: randomUUID(), doc: randomUUID(), otherDoc: randomUUID(), draft: randomUUID(), proposal: randomUUID() };
const tokens: Record<string,string> = {};
function addUser(id:string,name:string){db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(id,`${name}@example.test`,`${name}@example.test`,name,'unused',isoNow());}
function req(user:'owner'|'editor'|'viewer'|'stranger',method:'GET'|'POST'|'PATCH',url:string,payload?:unknown){const headers:Record<string,string>={cookie:`teamshelf_session=${tokens[user]}`};if(method!=='GET')headers['x-requested-with']='TeamShelf';if(payload!==undefined)headers['content-type']='application/json';return app.inject({method,url,headers,...(payload===undefined?{}:{payload:JSON.stringify(payload)})});}

function agentReq(method:'GET'|'POST',url:string){return app.inject({method,url,headers:{authorization:'Basic test-agent',accept:'application/json'}});}
beforeEach(async()=>{
 root=await mkdtemp(path.join(os.tmpdir(),'teamshelf-comments-'));db=openDatabase(root);const now=isoNow();
 for(const [key,id] of Object.entries(u).filter(([key])=>['owner','editor','viewer','stranger'].includes(key)))addUser(id,key);
 db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(u.team,'Comments Team',now);
 for(const [id,role] of [[u.owner,'owner'],[u.editor,'editor'],[u.viewer,'viewer']] as const)db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(u.team,id,role,now);
 db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(u.space,u.team,'Space',u.owner,now);
 for(const id of [u.doc,u.otherDoc])db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'Published text',?,1,?,?,?,?)").run(id,u.space,id===u.doc?'Comment doc':'Other doc','inherit',u.owner,now,u.owner,now);
 db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,1,?,?,?, ?,?)').run(randomUUID(),u.doc,'Comment doc','Published text',now,u.owner,'owner');
 db.prepare("INSERT INTO document_drafts(id,doc_id,mode,base_version,state,y_state,seq,title,updated_by,updated_at) VALUES(?,?,'markdown',1,'editing',?,0,'Draft title',?,?)").run(u.draft,u.doc,Buffer.alloc(0),u.owner,now);
 db.prepare("INSERT INTO proposals(id,team_id,space_id,document_id,target_document_id,kind,author_id,base_version,title,body,status,created_at) VALUES(?,?,?,? ,?,'update',?,1,'Proposed title','Proposed body','pending',?)").run(u.proposal,u.team,u.space,u.doc,u.doc,u.editor,now);
 for(const [key,id] of Object.entries(u).filter(([key])=>['owner','editor','viewer','stranger'].includes(key))){const token=`comments-${key}-${randomUUID()}`;tokens[key]=token;db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(randomUUID(),hashToken(token),id,now,new Date(Date.now()+86400000).toISOString());}
 const config={port:3000,dataDir:root,appOrigin:'http://localhost:5173',setupToken:'unused',cookieSecure:false,isProduction:false};
 app=Fastify({logger:false}); await app.register(cookie); app.addHook('preHandler',async request=>{if(request.headers.authorization==='Basic test-agent')request.agentPrincipal={userId:u.owner};});
 app.register(async api=>registerCommentRoutes(api,{db,config}),{prefix:'/api'}); await app.ready();
});
afterEach(async()=>{if(app)await app.close();db?.close();if(root)await rm(root,{recursive:true,force:true});});

describe('document comments and notifications',()=>{
 it('supports published threads, mentions, replies, resolve/reopen, and stale source flags',async()=>{
  const created=await req('editor','POST',`/api/documents/${u.doc}/comments`,{source:{kind:'published',version:1},quote:'Published text',anchor:{paragraphIndex:0,startOffset:0,endOffset:14},body:'Please review this paragraph.',mentionUserIds:[u.viewer]});
  expect(created.statusCode).toBe(201);const rootComment=created.json().comment;expect(rootComment.mentionUserIds).toEqual([u.viewer]);
  const notifications=await req('viewer','GET','/api/notifications');expect(notifications.statusCode).toBe(200);expect(notifications.json().notifications[0].body).toContain('Please review');
  expect((await req('viewer','POST',`/api/notifications/${notifications.json().notifications[0].id}/read`)).statusCode).toBe(200);
  const reply=await req('viewer','POST',`/api/comments/${rootComment.id}/replies`,{body:'I have checked it.',mentionUserIds:[]});expect(reply.statusCode).toBe(403);
  const ownerReply=await req('owner','POST',`/api/comments/${rootComment.id}/replies`,{body:'Added an owner note.',mentionUserIds:[]});expect(ownerReply.statusCode).toBe(201);
  expect((await req('viewer','PATCH',`/api/comments/${rootComment.id}`,{resolved:true})).statusCode).toBe(403);
  expect((await req('editor','PATCH',`/api/comments/${rootComment.id}`,{resolved:true})).statusCode).toBe(200);
  expect((await req('editor','PATCH',`/api/comments/${rootComment.id}`,{resolved:false})).json().comment.resolved).toBe(false);
  db.prepare("UPDATE documents SET version=2,updated_at=? WHERE id=?").run(isoNow(),u.doc);
  db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,2,?,?,?, ?,?)').run(randomUUID(),u.doc,'Comment doc','Published text changed',isoNow(),u.owner,'owner');
  const listed=await req('viewer','GET',`/api/documents/${u.doc}/comments`);expect(listed.json().comments[0].stale).toBe(true);expect(listed.json().comments[0].replies).toHaveLength(1);
 });

 it('blocks invisible mentions and hides notifications after source access is revoked',async()=>{
  const body={source:{kind:'published',version:1},quote:'Published text',anchor:{paragraphIndex:0,startOffset:0,endOffset:1},body:'Confidential reference',mentionUserIds:[u.stranger]};
  expect((await req('editor','POST',`/api/documents/${u.doc}/comments`,body)).statusCode).toBe(400);
  db.prepare("UPDATE documents SET visibility='restricted' WHERE id=?").run(u.doc);
  db.prepare("INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,'editor')").run(u.doc,u.editor);
  db.prepare("INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,'viewer')").run(u.doc,u.viewer);
  const created=await req('editor','POST',`/api/documents/${u.doc}/comments`,{...body,mentionUserIds:[u.viewer]});expect(created.statusCode).toBe(201);
  expect((await req('viewer','GET','/api/notifications')).json().notifications).toHaveLength(1);
  db.prepare('DELETE FROM document_grants WHERE document_id=? AND user_id=?').run(u.doc,u.viewer);
  const notifications=await req('viewer','GET','/api/notifications');expect(notifications.json().notifications).toHaveLength(0);
  const notifId=db.prepare('SELECT id FROM comment_notifications WHERE recipient_id=?').get(u.viewer) as {id:string};
  expect((await req('viewer','POST',`/api/notifications/${notifId.id}/read`)).statusCode).toBe(404);
  expect((await req('viewer','GET',`/api/documents/${u.doc}/comments`)).statusCode).toBe(404);
 });

 it('allows draft comments only while editing and scopes proposal comments to author or manager',async()=>{
  const draftSource={kind:'draft',draftId:u.draft,seq:0};
  const draft=await req('editor','POST',`/api/documents/${u.doc}/comments`,{source:draftSource,quote:'draft text',anchor:{paragraphIndex:0,startOffset:0,endOffset:4},body:'Draft note',mentionUserIds:[]});expect(draft.statusCode).toBe(201);
  db.prepare("UPDATE document_drafts SET state='reviewing' WHERE id=?").run(u.draft);
  expect((await req('editor','POST',`/api/comments/${draft.json().comment.id}/replies`,{body:'too late',mentionUserIds:[]})).statusCode).toBe(403);
  const proposal=await req('editor','POST',`/api/documents/${u.doc}/comments`,{source:{kind:'proposal',proposalId:u.proposal},quote:'proposed text',anchor:{paragraphIndex:0,startOffset:0,endOffset:7},body:'Proposal note',mentionUserIds:[]});expect(proposal.statusCode).toBe(201);
  expect((await req('owner','GET',`/api/documents/${u.doc}/comments`)).json().comments.map((item:any)=>item.body)).toContain('Proposal note');
  expect((await agentReq('GET','/api/documents/'+u.doc+'/comments')).json().comments.map((item:any)=>item.body)).not.toContain('Proposal note');
  expect((await req('viewer','GET',`/api/documents/${u.doc}/comments`)).json().comments.map((item:any)=>item.body)).not.toContain('Proposal note');
 });

 it('hides draft comments from members who can only read the published document',async()=>{
  const source={kind:'draft',draftId:u.draft,seq:0};
  const created=await req('editor','POST',`/api/documents/${u.doc}/comments`,{source,quote:'private draft text',anchor:{paragraphIndex:0,startOffset:0,endOffset:12},body:'Private draft discussion',mentionUserIds:[]});expect(created.statusCode).toBe(201);
  const listed=await req('viewer','GET',`/api/documents/${u.doc}/comments`);expect(listed.statusCode).toBe(200);expect(listed.json().comments).toHaveLength(0);
  const mention=await req('editor','POST',`/api/documents/${u.doc}/comments`,{source,quote:'private draft text',anchor:{paragraphIndex:0,startOffset:0,endOffset:12},body:'Draft mention',mentionUserIds:[u.viewer]});expect(mention.statusCode).toBe(400);
  expect((await req('viewer','GET','/api/notifications')).json().notifications).toHaveLength(0);
 });
 it('rejects malformed payloads and cross-document reply access',async()=>{
  const bad=await req('editor','POST',`/api/documents/${u.doc}/comments`,{source:{kind:'published',version:1},quote:'x',anchor:{paragraphIndex:0,startOffset:4,endOffset:1},body:'Comment',mentionUserIds:[],extra:true});expect(bad.statusCode).toBe(400);
  const created=await req('editor','POST',`/api/documents/${u.doc}/comments`,{source:{kind:'published',version:1},quote:'x',anchor:{paragraphIndex:0,startOffset:0,endOffset:1},body:'Comment',mentionUserIds:[]});
  expect((await req('stranger','POST',`/api/comments/${created.json().comment.id}/replies`,{body:'Cross team',mentionUserIds:[]})).statusCode).toBe(404);
 });
});
