import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db.js';
import { isoNow } from '../../src/server/security.js';
import { encryptMailPassword, sendConfiguredMail } from '../../src/server/mailer.js';
import { processReminderOutbox } from '../../src/server/workflow.js';
import { startLocalTlsSmtpSink } from '../helpers/local-smtp.mjs';

let dir: string | undefined;
let db: Db | undefined;
let sink: Awaited<ReturnType<typeof startLocalTlsSmtpSink>> | undefined;

afterEach(async () => {
  await sink?.close(); sink = undefined;
  db?.close(); db = undefined;
  if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined;
});

describe('reminder outbox with the local TLS SMTP sink', () => {
  it('delivers once, retries transient SMTP failure, and cancels after live edit access is revoked', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-workflow-smtp-'));
    db = openDatabase(dir);
    sink = await startLocalTlsSmtpSink();
    const now = isoNow();
    const owner = randomUUID(), editor = randomUUID(), team = randomUUID(), space = randomUUID(), document = randomUUID();
    for (const [id, name, email] of [[owner, 'Owner', 'owner@example.test'], [editor, 'Editor', 'editor@example.test']] as const) {
      db.prepare('INSERT INTO users(id,email,normalized_email,name,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(id,email,email,name,'unused',now);
    }
    db.prepare('INSERT INTO teams(id,name,created_at) VALUES(?,?,?)').run(team,'SMTP Test Team',now);
    for (const [id, role] of [[owner, 'owner'], [editor, 'editor']] as const) db.prepare('INSERT INTO members(team_id,user_id,role,created_at) VALUES(?,?,?,?)').run(team,id,role,now);
    db.prepare("INSERT INTO spaces(id,team_id,name,description,visibility,created_by,created_at) VALUES(?,?,?,'','team',?,?)").run(space,team,'SMTP Test Space',owner,now);
    db.prepare("INSERT INTO documents(id,space_id,title,body,visibility,version,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,'review body','inherit',1,?,?,?,?)").run(document,space,'SMTP reminder document',owner,now,owner,now);
    const password = sink.password;
    const encrypted = encryptMailPassword(db, dir, owner, password);
    db.prepare('INSERT INTO mail_settings(user_id,host,port,security,username,from_email,from_name,password_ciphertext,password_iv,password_tag,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(owner,'localhost',sink.port,'tls',sink.username,'owner@example.test','Owner',encrypted.ciphertext,encrypted.iv,encrypted.tag,now,now);
    db.prepare('INSERT INTO team_reminders(team_id,enabled,sender_user_id,updated_at) VALUES(?,1,?,?)').run(team,owner,now);
    const past = new Date(Date.now() - 60_000).toISOString();
    db.prepare('INSERT INTO document_workflow(document_id,responsible_user_id,review_at,last_reviewed_at,due_at,metadata_version,updated_at) VALUES(?,?,?,NULL,?,0,?)')
      .run(document,editor,past,past,now);
    const context = { db, config: { port: 0, dataDir: dir, appOrigin: 'http://localhost:4173', setupToken: 'unused', cookieSecure: false, isProduction: false } };

    await processReminderOutbox(context);
    expect(sink.received).toHaveLength(2);
    expect(sink.received.every(message => message.to.includes('editor@example.test'))).toBe(true);
    await processReminderOutbox(context);
    expect(sink.received).toHaveLength(2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM reminder_outbox WHERE status='sent'").get() as {count:number}).count).toBe(2);

    const nextDue = new Date(Date.now() - 30_000).toISOString();
    db.prepare('UPDATE document_workflow SET due_at=?,metadata_version=metadata_version+1 WHERE document_id=?').run(nextDue,document);
    sink.rejectAuth = true;
    await processReminderOutbox(context);
    const retry = db.prepare("SELECT status,attempts,last_error FROM reminder_outbox WHERE kind='due' AND due_at=?").get(nextDue) as {status:string;attempts:number;last_error:string};
    expect(retry).toEqual({status:'pending',attempts:1,last_error:'delivery_failed'});
    db.prepare("UPDATE reminder_outbox SET next_attempt_at=? WHERE kind='due' AND due_at=?").run(isoNow(),nextDue);
    sink.rejectAuth = false;
    await processReminderOutbox(context);
    expect((db.prepare("SELECT status,attempts FROM reminder_outbox WHERE kind='due' AND due_at=?").get(nextDue) as {status:string;attempts:number})).toEqual({status:'sent',attempts:2});
    expect(sink.received).toHaveLength(3);

    const revokedDue = new Date(Date.now() - 10_000).toISOString();
    db.prepare('UPDATE document_workflow SET due_at=?,metadata_version=metadata_version+1 WHERE document_id=?').run(revokedDue,document);
    db.prepare("UPDATE documents SET visibility='restricted' WHERE id=?").run(document);
    db.prepare("INSERT INTO document_grants(document_id,user_id,role) VALUES(?,?,'editor')").run(document,owner);
    await processReminderOutbox(context);
    expect((db.prepare("SELECT status FROM reminder_outbox WHERE kind='due' AND due_at=?").get(revokedDue) as {status:string}).status).toBe('cancelled');
    expect(sink.received).toHaveLength(3);
  });
});
