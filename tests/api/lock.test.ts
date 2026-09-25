import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataLock } from '../../src/server/lock.js';

const dirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-lock-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('data lock', () => {
  it('serializes concurrent instances and releases only its own lock', async () => {
    const dir = await tempDir();
    const release = await acquireDataLock(dir);
    const lockPath = path.join(dir, '.teamshelf.lock');
    const record = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(record.pid).toBe(process.pid);
    await expect(acquireDataLock(dir)).rejects.toThrow(/locked/);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(record);
    await release();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const releaseAgain = await acquireDataLock(dir);
    await releaseAgain();
  });

  it('refuses stale and malformed existing locks without deleting them', async () => {
    const dir = await tempDir();
    const lockPath = path.join(dir, '.teamshelf.lock');
    const stale = { pid: 999999, startedAt: 1, heartbeatAt: 1 };
    await writeFile(lockPath, JSON.stringify(stale));
    await expect(acquireDataLock(dir)).rejects.toThrow(/manually/);
    expect(await readFile(lockPath, 'utf8')).toBe(JSON.stringify(stale));
    await writeFile(lockPath, '{broken');
    await expect(acquireDataLock(dir)).rejects.toThrow(/unreadable/);
    expect(await readFile(lockPath, 'utf8')).toBe('{broken');
  });
});
