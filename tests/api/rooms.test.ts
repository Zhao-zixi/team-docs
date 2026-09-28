import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/server/app.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashToken, isoNow } from '../../src/server/security.js';

let root:string;let db:Db;let app:FastifyInstance;
const f={owner:randomUUID(),viewer:randomUUID(),team:randomUUID(),space:randomUUID(),doc:randomUUID()};
const sessions={owner:`room-owner-${randomUUID()}`,viewer:`room-viewer-${randomUUID()}`};
function request(user:'owner'|'viewer',method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:unknown){const headers:Record<string,string>={cookie:`teamshelf_session=${sessions[user]}`};if(method!=='GET')headers['x-requested-with']='TeamShelf';if(payload!==undefined)headers['content-type']='application/json';return app.inject({method,url,headers,...(payload===undefined?{}:{payload:JSON.stringify(payload)})});}
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'teamshelf-rooms-'));db=openDatabase(root);const now=isoNow();for(const [key,id] of Object.entries({owner:f.owner,viewer:f.viewer})){db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(id,`${key}@example.test`,`${key}@example.test`,key,'unused',now);db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(randomUUID(),hashToken(sessions[key as keyof typeof sessions]),id,now,new Date(Date.now()+86400000).toISOString());}db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(f.team,'Room Team',now);db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(f.team,f.owner,'owner',now);db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(f.team,f.viewer,'viewer',now);db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(f.space,f.team,'Space',f.owner,now);db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,'inherit',1,?,?,?,?)").run(f.doc,f.space,'Pinned title','Pinned body',f.owner,now,f.owner,now);db.prepare('INSERT INTO revisions(id,document_id,version,title,body,created_at,created_by,author_name) VALUES(?,?,1,?,?,?,?,?)').run(randomUUID(),f.doc,'Pinned title','Pinned body',now,f.owner,'owner');app=createApp({db,config:{port:3000,dataDir:root,appOrigin:'http://localhost:5173',setupToken:'unused',cookieSecure:false,isProduction:false},logger:false,serveClient:false});await app.ready();});
afterEach(async()=>{await app.close();db.close();await rm(root,{recursive:true,force:true});});

describe('external rooms',()=>{
 it('denies an existing public session after expiry, creator demotion, revocation, and physical document deletion',async()=>{
  async function createSession(){
   const created=await request('owner','POST','/api/teams/'+f.team+'/rooms',{name:'Lifecycle',expiresAt:new Date(Date.now()+86400000).toISOString(),password:'separate-room-secret',items:[{documentId:f.doc,publishedVersion:1}]});
   expect(created.statusCode).toBe(201);const {room,url}=created.json();const token=new URL(url).pathname.split('/').pop()!;
   const login=await app.inject({method:'POST',url:'/api/share/'+token+'/session',headers:{origin:'http://localhost:5173','x-requested-with':'TeamShelf','content-type':'application/json'},payload:{password:'separate-room-secret'}});
   expect(login.statusCode).toBe(200);return{room,token,cookie:String(login.headers['set-cookie']??'').split(';')[0]};
  }
  const first=await createSession();
  db.prepare('UPDATE external_rooms SET expires_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),first.room.id);
  expect((await app.inject({method:'GET',url:'/api/share/'+first.token+'/items',headers:{cookie:first.cookie}})).statusCode).toBe(404);
  const second=await createSession();
  db.prepare("UPDATE members SET role='editor' WHERE team_id=? AND user_id=?").run(f.team,f.owner);
  expect((await app.inject({method:'GET',url:'/api/share/'+second.token+'/items',headers:{cookie:second.cookie}})).statusCode).toBe(404);
  db.prepare("UPDATE members SET role='owner' WHERE team_id=? AND user_id=?").run(f.team,f.owner);
  const third=await createSession();
  expect((await request('owner','DELETE','/api/rooms/'+third.room.id)).statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:'/api/share/'+third.token+'/items',headers:{cookie:third.cookie}})).statusCode).toBe(404);
  const fourth=await createSession();
  db.prepare('DELETE FROM documents WHERE id=?').run(f.doc);
  expect((await app.inject({method:'GET',url:'/api/share/'+fourth.token+'/documents/'+f.doc,headers:{cookie:fourth.cookie}})).statusCode).toBe(404);
 }); it('keeps an independent low rate limit on password checks',async()=>{
  const created=await request('owner','POST',`/api/teams/${f.team}/rooms`,{name:'Rate test',expiresAt:new Date(Date.now()+86400000).toISOString(),password:'separate-room-secret',items:[{documentId:f.doc,publishedVersion:1}]});
  expect(created.statusCode).toBe(201);const token=new URL(created.json().url).pathname.split('/').pop()!;
  const statuses:number[]=[];
  for(let i=0;i<6;i++)statuses.push((await app.inject({method:'POST',url:`/api/share/${token}/session`,headers:{origin:'http://localhost:5173','x-requested-with':'TeamShelf','content-type':'application/json'},payload:{password:'wrong-room-password'}})).statusCode);
  expect(statuses.slice(0,5)).toEqual([403,403,403,403,403]);expect(statuses[5]).toBe(429);
 });
 it('pins selected published snapshots, protects them with password sessions, and invalidates sessions on ACL change/rotation/removal',async()=>{
  expect((await request('viewer','GET',`/api/teams/${f.team}/rooms`)).statusCode).toBe(403);
  const created=await request('owner','POST',`/api/teams/${f.team}/rooms`,{name:'Partner pack',expiresAt:new Date(Date.now()+86400000).toISOString(),password:'separate-room-secret',items:[{documentId:f.doc,publishedVersion:1}]});
  expect(created.statusCode).toBe(201);expect(created.headers['referrer-policy']).toBe('no-referrer');
  const {room,url}=created.json();const token=new URL(url).pathname.split('/').pop()!;
  expect(db.prepare('SELECT token_hash FROM external_rooms WHERE id=?').get(room.id)).not.toHaveProperty('token_hash',token);
  expect(JSON.stringify(db.prepare('SELECT details_json FROM audit_events WHERE target_id=?').get(room.id))).not.toContain(token);
  const wrong=await app.inject({method:'POST',url:`/api/share/${token}/session`,headers:{origin:'http://localhost:5173','x-requested-with':'TeamShelf','content-type':'application/json'},payload:{password:'wrong-room-password'}});expect(wrong.statusCode).toBe(403);
  const login=await app.inject({method:'POST',url:`/api/share/${token}/session`,headers:{origin:'http://localhost:5173','x-requested-with':'TeamShelf','content-type':'application/json'},payload:{password:'separate-room-secret'}});expect(login.statusCode).toBe(200);expect(login.headers['referrer-policy']).toBe('no-referrer');
  const setCookie=String(login.headers['set-cookie']??'');expect(setCookie).toContain('teamshelf_share=');expect(setCookie).toContain('HttpOnly');expect(setCookie).toContain('SameSite=Strict');const roomCookie=setCookie.split(';')[0];
  const list=await app.inject({method:'GET',url:`/api/share/${token}/items`,headers:{cookie:roomCookie}});expect(list.statusCode).toBe(200);expect(list.headers['referrer-policy']).toBe('no-referrer');expect(list.json().documents).toEqual([{title:'Pinned title',body:'Pinned body'}]);
  const read=await app.inject({method:'GET',url:`/api/share/${token}/documents/${f.doc}`,headers:{cookie:roomCookie}});expect(read.json().document).toEqual({title:'Pinned title',body:'Pinned body'});
  db.prepare("UPDATE documents SET visibility='restricted' WHERE id=?").run(f.doc);db.prepare("INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,'viewer')").run(f.doc,f.owner);
  expect((await app.inject({method:'GET',url:`/api/share/${token}/documents/${f.doc}`,headers:{cookie:roomCookie}})).statusCode).toBe(404);
  const rotated=await request('owner','POST',`/api/rooms/${room.id}/rotate`,{password:'changed-room-secret'});expect(rotated.statusCode).toBe(200);const rotatedToken=new URL(rotated.json().url).pathname.split('/').pop()!;expect(rotatedToken).not.toBe(token);
  expect((await app.inject({method:'GET',url:`/api/share/${rotatedToken}/items`,headers:{cookie:roomCookie}})).statusCode).toBe(403);
  const oldPassword=await app.inject({method:'POST',url:`/api/share/${rotatedToken}/session`,headers:{origin:'http://localhost:5173','x-requested-with':'TeamShelf','content-type':'application/json'},payload:{password:'separate-room-secret'}});expect(oldPassword.statusCode).toBe(403);
  const rotatedLogin=await app.inject({method:'POST',url:`/api/share/${rotatedToken}/session`,headers:{origin:'http://localhost:5173','x-requested-with':'TeamShelf','content-type':'application/json'},payload:{password:'changed-room-secret'}});expect(rotatedLogin.statusCode).toBe(200);
  const rotatedCookie=String(rotatedLogin.headers['set-cookie']??'').split(';')[0];
  expect((await request('owner','DELETE',`/api/rooms/${room.id}/items/${f.doc}`)).statusCode).toBe(200);
  expect((await app.inject({method:'GET',url:`/api/share/${rotatedToken}/documents/${f.doc}`,headers:{cookie:rotatedCookie}})).statusCode).toBe(403);
  expect((await request('owner','GET',`/api/rooms/${room.id}/access-log`)).json().events.length).toBeGreaterThan(0);
 });
});
