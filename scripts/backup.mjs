import { backup, DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { access, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
const dbPath = path.join(dataDir, 'teamshelf.sqlite');
const targetArg = process.argv[2];

if (!targetArg || process.argv.length !== 3) {
  console.error('Usage: node scripts/backup.mjs <backup-file>');
  process.exit(2);
}

const target = path.resolve(targetArg);
if (target === dbPath) throw new Error('Backup destination must differ from the live database.');
await access(dbPath, constants.F_OK);
await mkdir(path.dirname(target), { recursive: true });
let reservation;
try {
  reservation = await open(target, 'wx', 0o600);
  await reservation.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(db, target);
    const backupDb = new DatabaseSync(target, { readOnly: true });
    const result = backupDb.prepare('PRAGMA integrity_check').get();
    backupDb.close();
    if (result.integrity_check !== 'ok') throw new Error('Source database integrity check failed.');
  } finally {
    db.close();
  }
  console.log(`Backup created: ${target}`);
} catch (error) {
  await reservation?.close().catch(() => {});
  if (reservation) await unlink(target).catch(() => {});
  throw error;
}
