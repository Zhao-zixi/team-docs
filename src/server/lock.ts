import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface LockRecord {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

const HEARTBEAT_MS = 10_000;
const STALE_AFTER_MS = 120_000;

export async function acquireDataLock(dataDir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(dataDir, '.teamshelf.lock');
  const startedAt = Date.now();
  const record: LockRecord = { pid: process.pid, startedAt, heartbeatAt: startedAt };
  const writeNew = async () => {
    const handle = await open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeNew();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let prior: LockRecord | undefined;
      try { prior = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord; } catch { /* damaged lock requires manual attention */ }
      if (!prior || !Number.isFinite(prior.heartbeatAt) || Date.now() - prior.heartbeatAt <= STALE_AFTER_MS) {
        throw new Error('TeamShelf data is already locked; stop the other instance or inspect the lock file.');
      }
      await unlink(lockPath).catch(() => {});
    }
    if (attempt === 1) throw new Error('Could not acquire TeamShelf data lock.');
  }

  let closed = false;
  const timer = setInterval(async () => {
    if (closed) return;
    record.heartbeatAt = Date.now();
    const temporary = `${lockPath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, lockPath);
    } catch {
      await unlink(temporary).catch(() => {});
    }
  }, HEARTBEAT_MS);
  timer.unref();

  return async () => {
    closed = true;
    clearInterval(timer);
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord;
      if (current.pid === record.pid && current.startedAt === record.startedAt) await unlink(lockPath);
    } catch {
      // A missing lock is already released; a replaced lock belongs to another owner.
    }
  };
}
