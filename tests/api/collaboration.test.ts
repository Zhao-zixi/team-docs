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
import type { WebSocket } from 'ws';
import { createApp } from '../../src/server/app.js';
import { openDatabase, type Db } from '../../src/server/db.js';
import { hashToken, isoNow } from '../../src/server/security.js';

let root: string;
let db: Db;
let app: FastifyInstance;
let userId: string;
let documentId: string;
let session: string;
let draftId: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-collab-'));
  db = openDatabase(root);
  const now = isoNow();
  userId = randomUUID();
  const teamId = randomUUID();
  const spaceId = randomUUID();
  documentId = randomUUID();
  session = `collab-${randomUUID()}`;
  db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(userId, 'collab@example.test', 'collab@example.test', 'Collab Editor', 'unused', now);
  db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(teamId, 'Collab Team', now);
  db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(teamId, userId, 'editor', now);
  db.prepare(`INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)`)
    .run(spaceId, teamId, 'Collab Space', userId, now);
  db.prepare(`INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at)
    VALUES(?,?,?,?,'inherit',1,?,?,?,?)`).run(documentId, spaceId, 'Draft title', '# Start', userId, now, userId, now);
  db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(randomUUID(), hashToken(session), userId, now, new Date(Date.now() + 60 * 60_000).toISOString());
  app = createApp({
    db,
    config: { port: 3000, dataDir: root, appOrigin: 'http://localhost:5173', setupToken: 'unused', cookieSecure: false, isProduction: false },
    logger: false,
    serveClient: false,
  });
  await app.ready();
  const created = await app.inject({ method: 'POST', url: `/api/documents/${documentId}/draft`, headers: { cookie: `teamshelf_session=${session}`, 'x-requested-with': 'TeamShelf', 'content-type': 'application/json' }, payload: { mode: 'markdown' } });
  expect(created.statusCode).toBe(201);
  draftId = created.json().draft.id;
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

function queuedMessages() {
  const queue: Buffer[] = [];
  const waiters: Array<(value: Buffer) => void> = [];
  return {
    attach(socket: WebSocket) { socket.on('message', data => { const value = Buffer.from(data as Buffer); const waiter = waiters.shift(); if (waiter) waiter(value); else queue.push(value); }); },
    next(timeout = 3000): Promise<Buffer> {
      const ready = queue.shift(); if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('websocket message timeout')), timeout); waiters.push(value => { clearTimeout(timer); resolve(value); }); });
    },
  };
}

function applyServerMessage(doc: Y.Doc, data: Uint8Array): void {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  if (type !== 0) return;
  const subtype = decoding.readVarUint(decoder);
  if (subtype === syncProtocol.messageYjsSyncStep2 || subtype === syncProtocol.messageYjsUpdate) {
    Y.applyUpdate(doc, decoding.readVarUint8Array(decoder));
  }
}

function awarenessPacket(id:number,clock:number,state:unknown):Uint8Array{const update=encoding.createEncoder();encoding.writeVarUint(update,1);encoding.writeVarUint(update,id);encoding.writeVarUint(update,clock);encoding.writeVarString(update,JSON.stringify(state));const packet=encoding.createEncoder();encoding.writeVarUint(packet,1);encoding.writeVarUint8Array(packet,encoding.toUint8Array(update));return encoding.toUint8Array(packet);}
function awarenessState(data:Uint8Array,id:number):unknown{const outer=decoding.createDecoder(data);if(decoding.readVarUint(outer)!==1)throw new Error('not awareness');const inner=decoding.createDecoder(decoding.readVarUint8Array(outer));const count=decoding.readVarUint(inner);for(let i=0;i<count;i++){const clientId=decoding.readVarUint(inner);decoding.readVarUint(inner);const value=JSON.parse(decoding.readVarString(inner)) as unknown;if(clientId===id)return value;}return undefined;}
describe('collaborative drafts websocket', () => {
  it('authenticates the session, persists a validated Yjs update before making it authoritative, and rejects a wrong Origin', async () => {
    await expect(app.injectWS(`/api/collaboration/${draftId}`, { headers: { host: 'localhost', cookie: `teamshelf_session=${session}`, origin: 'https://attacker.example' }, socket: { remoteAddress: '127.0.0.1' } as never })).rejects.toThrow();

    const client = new Y.Doc();
    const original = db.prepare('SELECT y_state FROM document_drafts WHERE id=?').get(draftId) as { y_state: Uint8Array };
    Y.applyUpdate(client, Uint8Array.from(original.y_state));
    const offlineVector = Y.encodeStateVector(client);
    client.getText('body').insert(client.getText('body').length, '\noffline edit');
    const messages = queuedMessages();
    const socket = await app.injectWS(`/api/collaboration/${draftId}`, { headers: { host: 'localhost', cookie: `teamshelf_session=${session}`, origin: 'http://localhost:5173' }, socket: { remoteAddress: '127.0.0.1' } as never }, { onInit: ws => messages.attach(ws) });
    const initial = encoding.createEncoder();
    encoding.writeVarUint(initial, 0);
    syncProtocol.writeSyncStep1(initial, client);
    const firstPromise = messages.next();
    socket.send(encoding.toUint8Array(initial));
    const first = await firstPromise;
    applyServerMessage(client, first);
    const second = await messages.next();
    const serverDecoder = decoding.createDecoder(second);
    expect(decoding.readVarUint(serverDecoder)).toBe(0);
    expect(decoding.readVarUint(serverDecoder)).toBe(syncProtocol.messageYjsSyncStep1);
    const serverVector = decoding.readVarUint8Array(serverDecoder);
    const clientReply = encoding.createEncoder();
    encoding.writeVarUint(clientReply, 0);
    syncProtocol.writeSyncStep2(clientReply, client, serverVector);
    const syncEcho = messages.next();
    socket.send(encoding.toUint8Array(clientReply));
    await syncEcho;
    expect(client.getText('body').toString()).toBe('# Start\noffline edit');
    expect(client.getMap('meta').get('title')).toBeInstanceOf(Y.Text);

    const vector = Y.encodeStateVector(client);
    client.getText('body').insert(client.getText('body').length, '\nappended safely');
    const update = Y.encodeStateAsUpdate(client, vector);
    const packet = encoding.createEncoder();
    encoding.writeVarUint(packet, 0);
    syncProtocol.writeUpdate(packet, update);
    const ack = messages.next();
    socket.send(encoding.toUint8Array(packet));
    await ack;

    const persisted = db.prepare('SELECT y_state,seq FROM document_drafts WHERE id=?').get(draftId) as { y_state: Uint8Array; seq: number };
    expect(persisted.seq).toBe(2);
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, Uint8Array.from(persisted.y_state));
    expect(reloaded.getText('body').toString()).toBe('# Start\noffline edit\nappended safely');
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    const rejectedUpdate = encoding.createEncoder();
    encoding.writeVarUint(rejectedUpdate, 0);
    syncProtocol.writeUpdate(rejectedUpdate, Y.encodeStateAsUpdate(client));
    socket.send(encoding.toUint8Array(rejectedUpdate));
    expect(await closed).toBe(4403);
    expect((db.prepare('SELECT seq FROM document_drafts WHERE id=?').get(draftId) as {seq:number}).seq).toBe(2);
    client.destroy();
    reloaded.destroy();
  });
  it('filters foreign awareness echoes and forged removals without changing another peer identity', async () => {
    const otherUser=randomUUID(),otherSession=`other-${randomUUID()}`,now=isoNow();
    db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(otherUser,'other@example.test','other@example.test','Other Editor','unused',now);
    db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES((SELECT team_id FROM spaces WHERE id=(SELECT space_id FROM documents WHERE id=?)),?,?,?)').run(documentId,otherUser,'editor',now);
    db.prepare('INSERT INTO sessions(id,token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(randomUUID(),hashToken(otherSession),otherUser,now,new Date(Date.now()+3600000).toISOString());
    const first=queuedMessages(),second=queuedMessages();
    const socket1=await app.injectWS(`/api/collaboration/${draftId}`,{headers:{host:'localhost',cookie:`teamshelf_session=${session}`,origin:'http://localhost:5173'},socket:{remoteAddress:'127.0.0.1'} as never},{onInit:ws=>first.attach(ws)});
    const socket2=await app.injectWS(`/api/collaboration/${draftId}`,{headers:{host:'localhost',cookie:`teamshelf_session=${otherSession}`,origin:'http://localhost:5173'},socket:{remoteAddress:'127.0.0.1'} as never},{onInit:ws=>second.attach(ws)});
    const clientId=77123;
    const firstAwareness=awarenessPacket(clientId,1,{user:{userId:'forged',name:'forged',role:'owner'},cursor:{anchor:null,head:null}});
    const broadcast=second.next();socket1.send(firstAwareness);const received=await broadcast;
    expect((awarenessState(received,clientId) as {user:{userId:string;name:string;role:string}}).user).toMatchObject({userId,name:'Collab Editor',role:'editor'});
    socket2.send(awarenessPacket(clientId,999,null));
    const query=encoding.createEncoder();encoding.writeVarUint(query,3);const afterRemoval=second.next();socket2.send(encoding.toUint8Array(query));
    expect((awarenessState(await afterRemoval,clientId) as {user:{userId:string}}).user.userId).toBe(userId);
    socket2.send(awarenessPacket(clientId,1000,{user:{userId:otherUser,name:'forged admin',role:'owner'},cursor:{anchor:null,head:null}}));
    const nextQuery=encoding.createEncoder();encoding.writeVarUint(nextQuery,3);const afterForgery=second.next();socket2.send(encoding.toUint8Array(nextQuery));
    expect((awarenessState(await afterForgery,clientId) as {user:{userId:string;name:string;role:string}}).user).toMatchObject({userId,name:'Collab Editor',role:'editor'});
    expect(socket1.readyState).toBe(1);expect(socket2.readyState).toBe(1);socket1.close();socket2.close();
  });
});


