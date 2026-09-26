import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { Db } from './db.js';
import { isoNow } from './security.js';

const KEY_FILE = 'mail-encryption.key';
const AES_ALGORITHM = 'aes-256-gcm';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailSender = (db: Db, dataDir: string, userId: string, message: OutgoingMail) => Promise<void>;

interface MailSettingsRow {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
  username: string;
  from_email: string;
  from_name: string;
  password_ciphertext: string;
  password_iv: string;
  password_tag: string;
}

function keyPath(dataDir: string): string {
  return path.join(dataDir, KEY_FILE);
}

function readKey(file: string): Buffer {
  if (process.platform === 'win32') {
    const pathInfo = lstatSync(file);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw new Error('MAIL_KEY_INVALID');
  }
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(file, constants.O_RDONLY | noFollow);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('MAIL_KEY_INVALID');
    if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
      throw new Error('MAIL_KEY_PERMISSIONS');
    }
    const key = readFileSync(fd);
    if (key.length !== 32) throw new Error('MAIL_KEY_INVALID');
    return key;
  } finally { closeSync(fd); }
}

function encryptionKey(db: Db, dataDir: string): Buffer {
  const file = keyPath(dataDir);
  try {
    return readKey(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('MAIL_KEY_UNAVAILABLE');
  }

  const configured = Number((db.prepare('SELECT COUNT(*) AS count FROM mail_settings').get() as { count: number }).count);
  if (configured > 0) throw new Error('MAIL_KEY_UNAVAILABLE');

  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, key); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return readKey(file);
    }
    return key;
  } catch {
    throw new Error('MAIL_KEY_UNAVAILABLE');
  } finally {
    try { unlinkSync(temporary); } catch { /* Already removed. */ }
  }
}

export function assertMailEncryptionKey(db: Db, dataDir: string): void {
  encryptionKey(db, dataDir);
}

export function encryptMailPassword(db: Db, dataDir: string, userId: string, password: string): { ciphertext: string; iv: string; tag: string } {
  const key = encryptionKey(db, dataDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(userId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

function decryptMailPassword(db: Db, dataDir: string, userId: string, row: MailSettingsRow): string {
  const key = encryptionKey(db, dataDir);
  const decipher = createDecipheriv(AES_ALGORITHM, key, Buffer.from(row.password_iv, 'base64url'));
  decipher.setAAD(Buffer.from(userId, 'utf8'));
  decipher.setAuthTag(Buffer.from(row.password_tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(row.password_ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export async function sendConfiguredMail(db: Db, dataDir: string, userId: string, message: OutgoingMail): Promise<void> {
  const row = db.prepare(`SELECT host,port,security,username,from_email,from_name,password_ciphertext,password_iv,password_tag
    FROM mail_settings WHERE user_id=?`).get(userId) as MailSettingsRow | undefined;
  if (!row) throw new Error('MAIL_NOT_CONFIGURED');
  let password: string;
  try { password = decryptMailPassword(db, dataDir, userId, row); } catch { throw new Error('MAIL_KEY_UNAVAILABLE'); }

  const transport = nodemailer.createTransport({
    host: row.host,
    port: row.port,
    secure: row.security === 'tls',
    requireTLS: row.security === 'starttls',
    auth: { user: row.username, pass: password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({
      from: { address: row.from_email, name: row.from_name },
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
  } catch {
    // Provider errors can include server replies or account details; never surface them.
    throw new Error('MAIL_SEND_FAILED');
  } finally {
    transport.close();
  }
}

export function mailKeyFilePath(dataDir: string): string { return keyPath(dataDir); }





