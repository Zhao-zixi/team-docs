import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const scripts = path.join(projectRoot, 'scripts');

function run(script, args, cwd, env = {}) {
  return spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function rows(database, query) {
  return database.prepare(query).all().map((row) => ({ ...row }));
}

test('backup and restore preserve data and rollback; refuse overwrite and active lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-ops-'));
  const dataDir = path.join(root, 'data');
  const livePath = path.join(dataDir, 'teamshelf.sqlite');
  const backupPath = path.join(root, 'nested', 'backups', 'snapshot.sqlite');
  try {
    await mkdir(dataDir, { recursive: true });
    const live = new DatabaseSync(livePath);
    try { live.exec(`CREATE TABLE notes (value TEXT NOT NULL); INSERT INTO notes VALUES ('before backup'); CREATE TABLE sessions (token_hash TEXT); INSERT INTO sessions VALUES ('session-secret'); CREATE TABLE invitations (token_hash TEXT, used_at INTEGER); INSERT INTO invitations VALUES ('pending', NULL), ('used', 100); CREATE TABLE agent_tokens (id TEXT, revoked_at TEXT); INSERT INTO agent_tokens VALUES ('pat-active', NULL), ('pat-revoked', 'old-revocation');`); }
    finally { live.close(); }

    const backupResult = run('backup.mjs', [backupPath], root, { DATA_DIR: dataDir });
    assert.equal(backupResult.status, 0, backupResult.stderr);
    assert.match(backupResult.stdout, /Backup created:/);
    const snapshot = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.deepEqual(rows(snapshot, 'SELECT value FROM notes'), [{ value: 'before backup' }]);
      assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { snapshot.close(); }

    const overwrite = run('backup.mjs', [backupPath], root, { DATA_DIR: dataDir });
    assert.notEqual(overwrite.status, 0);
    const unchanged = new DatabaseSync(backupPath, { readOnly: true });
    try { assert.deepEqual(rows(unchanged, 'SELECT value FROM notes'), [{ value: 'before backup' }]); }
    finally { unchanged.close(); }

    const edited = new DatabaseSync(livePath);
    try { edited.exec(`DELETE FROM notes; INSERT INTO notes VALUES ('after backup');`); }
    finally { edited.close(); }

    await writeFile(path.join(dataDir, '.teamshelf.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now() }));
    const lockedRestore = run('restore.mjs', [backupPath, '--confirm'], root, { DATA_DIR: dataDir });
    assert.notEqual(lockedRestore.status, 0);
    assert.match(lockedRestore.stderr, /active TeamShelf lock/);
    await rm(path.join(dataDir, '.teamshelf.lock'));

    const noConfirm = run('restore.mjs', [backupPath], root, { DATA_DIR: dataDir });
    assert.notEqual(noConfirm.status, 0);
    const restore = run('restore.mjs', [backupPath, '--confirm'], root, { DATA_DIR: dataDir });
    assert.equal(restore.status, 0, restore.stderr);
    assert.match(restore.stdout, /Previous database preserved:/);

    const restored = new DatabaseSync(livePath, { readOnly: true });
    try {
      assert.deepEqual(rows(restored, 'SELECT value FROM notes'), [{ value: 'before backup' }]);
      assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
      assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM invitations WHERE used_at IS NULL').get().count, 0);
      assert.equal(restored.prepare('SELECT used_at FROM invitations WHERE token_hash = ?').get('used').used_at, 100);
      assert.ok(restored.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').get('pat-active').revoked_at);
      assert.equal(restored.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').get('pat-revoked').revoked_at, 'old-revocation');
    } finally { restored.close(); }
    const rollbackName = (await readdir(dataDir)).find((name) => name.startsWith('teamshelf.sqlite.rollback-'));
    assert.ok(rollbackName, 'old database rollback copy exists');
    const rollback = new DatabaseSync(path.join(dataDir, rollbackName), { readOnly: true });
    try { assert.deepEqual(rows(rollback, 'SELECT value FROM notes'), [{ value: 'after backup' }]); }
    finally { rollback.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restore accepts a legacy v1 backup without agent_tokens', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-v1-restore-'));
  const dataDir = path.join(root, 'data');
  const backupPath = path.join(root, 'legacy-v1.sqlite');
  const livePath = path.join(dataDir, 'teamshelf.sqlite');
  try {
    await mkdir(dataDir, { recursive: true });
    const legacy = new DatabaseSync(backupPath);
    try { legacy.exec("CREATE TABLE notes (value TEXT NOT NULL); INSERT INTO notes VALUES ('legacy snapshot'); PRAGMA user_version=1;"); }
    finally { legacy.close(); }
    const live = new DatabaseSync(livePath);
    try { live.exec("CREATE TABLE notes (value TEXT NOT NULL); INSERT INTO notes VALUES ('current data');"); }
    finally { live.close(); }
    const restored = run('restore.mjs', [backupPath, '--confirm'], root, { DATA_DIR: dataDir });
    assert.equal(restored.status, 0, restored.stderr);
    const reopened = new DatabaseSync(livePath, { readOnly: true });
    try {
      assert.deepEqual(rows(reopened, 'SELECT value FROM notes'), [{ value: 'legacy snapshot' }]);
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='agent_tokens'").get().count, 0);
    } finally { reopened.close(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('configure creates a random secret without displaying it and refuses overwrite unless forced', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teamshelf-config-'));
  try {
    const created = run('configure.mjs', [], root);
    assert.equal(created.status, 0, created.stderr);
    const envText = await readFile(path.join(root, '.env'), 'utf8');
    const token = envText.match(/^SETUP_TOKEN=(.+)$/m)?.[1];
    assert.ok(token && token.length >= 40);
    assert.equal(created.stdout.includes(token), false);

    const refused = run('configure.mjs', [], root);
    assert.notEqual(refused.status, 0);
    const replaced = run('configure.mjs', ['--force'], root);
    assert.equal(replaced.status, 0, replaced.stderr);
    const replacedText = await readFile(path.join(root, '.env'), 'utf8');
    assert.notEqual(replacedText.match(/^SETUP_TOKEN=(.+)$/m)?.[1], token);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('container declarations keep valid continuations and deliver stop signals to Node', async () => {
  const dockerfile = await readFile(path.join(projectRoot, 'Dockerfile'), 'utf8');
  const compose = await readFile(path.join(projectRoot, 'compose.yaml'), 'utf8');
  const continuedLines = dockerfile.split(/\r?\n/).filter((line) => /\\+$/.test(line));
  assert.ok(continuedLines.length >= 2, 'Dockerfile has expected continuation lines');
  assert.ok(continuedLines.every((line) => !/\\\\$/.test(line)), 'each Dockerfile continuation ends with exactly one backslash');
  assert.match(dockerfile, /^CMD \["node", "dist\/server\/index\.js"\]$/m);
  assert.doesNotMatch(dockerfile, /^CMD \["npm"/m);
  assert.match(compose, /^    init: true$/m);
  assert.match(compose, /^    stop_grace_period: 30s$/m);
  assert.match(compose, /^    read_only: true$/m);
  assert.match(compose, /^    cap_drop:\r?\n      - ALL$/m);
});
