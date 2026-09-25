import { backup, DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'));
const dbPath = path.join(dataDir, 'teamshelf.sqlite');
const lockPath = path.join(dataDir, '.teamshelf.lock');
const [sourceArg, confirmArg, ...rest] = process.argv.slice(2);

if (!sourceArg || confirmArg !== '--confirm' || rest.length) {
  console.error('Usage: node scripts/restore.mjs <backup-file> --confirm');
  console.error('Stop TeamShelf before restoring.');
  process.exit(2);
}

const source = path.resolve(sourceArg);
if (source === dbPath) throw new Error('Restore source must differ from the live database.');
await access(source, constants.F_OK);
await mkdir(dataDir, { recursive: true });

let lockHandle;
let heartbeat;
let rollbackPath;
let stagedPath;
try {
  lockHandle = await open(lockPath, 'wx', 0o600);
} catch (error) {
  if (error.code === 'EEXIST') throw new Error('An active TeamShelf lock exists. Stop the app and retry after it exits cleanly.');
  throw error;
}

const startedAt = Date.now();
const writeHeartbeat = async () => {
  await lockHandle.truncate(0);
  await lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: Date.now() }));
  await lockHandle.sync();
};
const integrity = (dbFile) => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').get();
    if (result.integrity_check !== 'ok') throw new Error(`Integrity check failed: ${dbFile}`);
  } finally {
    db.close();
  }
};

try {
  await writeHeartbeat();
  heartbeat = setInterval(() => { void writeHeartbeat(); }, 10_000);
  heartbeat.unref();
  integrity(source);

  const stamp = new Date().toISOString().replaceAll(':', '-');
  rollbackPath = `${dbPath}.rollback-${stamp}`;
  stagedPath = `${dbPath}.restore-${process.pid}.tmp`;
  try {
    await access(dbPath, constants.F_OK);
    const current = new DatabaseSync(dbPath, { readOnly: true });
    try {
      await backup(current, rollbackPath);
    } finally {
      current.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    rollbackPath = undefined;
  }

  await copyFile(source, stagedPath, constants.COPYFILE_EXCL);
  const restoredDb = new DatabaseSync(stagedPath);
  try {
    const tables = new Set(restoredDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (tables.has('sessions')) restoredDb.exec('DELETE FROM sessions');
    if (tables.has('invitations')) {
      const columns = new Set(restoredDb.prepare('PRAGMA table_info(invitations)').all().map((row) => row.name));
      if (columns.has('used_at')) {
        restoredDb.prepare('UPDATE invitations SET used_at = ? WHERE used_at IS NULL').run(new Date().toISOString());
      }
    }
  } finally {
    restoredDb.close();
  }
  integrity(stagedPath);

  // The service is stopped and this script owns its lock, so remaining WAL sidecars are stale.
  await unlink(`${dbPath}-wal`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await unlink(`${dbPath}-shm`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await unlink(dbPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await rename(stagedPath, dbPath);
  stagedPath = undefined;
  console.log(`Restore completed: ${dbPath}`);
  if (rollbackPath) console.log(`Previous database preserved: ${rollbackPath}`);
} finally {
  if (heartbeat) clearInterval(heartbeat);
  await lockHandle.close();
  await unlink(lockPath).catch(() => {});
  if (stagedPath) await unlink(stagedPath).catch(() => {});
}