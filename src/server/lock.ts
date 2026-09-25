import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

interface LockRecord {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

export async function acquireDataLock(dataDir: string): Promise<() => Promise<void>> {
  const lockPath = path.join(dataDir, '.teamshelf.lock');
  const startedAt = Date.now();
  const record: LockRecord = { pid: process.pid, startedAt, heartbeatAt: startedAt };
  const handle = await open(lockPath, 'wx', 0o600).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    let prior: LockRecord | undefined;
    try { prior = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord; } catch { /* retain unreadable lock for manual review */ }
    if (!prior || !Number.isFinite(prior.pid) || !Number.isFinite(prior.startedAt)) {
      throw new Error('TeamShelf lock is unreadable; verify all instances are stopped, then remove the lock file manually.');
    }
    throw new Error('TeamShelf data is locked; verify all instances are stopped, then remove the lock file manually.');
  });
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();

  return async () => {
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8')) as LockRecord;
      if (current.pid === record.pid && current.startedAt === record.startedAt) await unlink(lockPath);
    } catch {
      // A missing lock is already released; a replaced lock belongs to another owner.
    }
  };
}


