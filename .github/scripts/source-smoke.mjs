import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const repoRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const tempParent = realpathSync(process.env.RUNNER_TEMP || path.dirname(repoRoot));
if (tempParent === '/tmp' || tempParent.startsWith('/tmp/') || tempParent === '/var/tmp' || tempParent.startsWith('/var/tmp/')) {
  throw new Error('GitHub RUNNER_TEMP (or a persistent parent directory) is required; backup targets may not be under /tmp or /var/tmp');
}
const unique = randomUUID().replaceAll('-', '').slice(0, 16);
const project = 'tssrc' + unique;
const volume = project + '-data';
const tempRoot = mkdtempSync(path.join(tempParent, 'teamshelf-source-smoke-'));
const checkout = path.join(tempRoot, 'checkout');
const backupDir = path.join(tempRoot, 'external-backup');
const marker = path.join(tempRoot, '.teamshelf-source-smoke');
const host = '127.0.0.1';
const expectedBody = 'CI source deployment persistence smoke body';
const secrets = [];
let phase = 'prepare';
let port;
let origin;
let token;
let cookie;
let documentId;
let volumeWasAbsent = false;
let success = false;

writeFileSync(marker, 'teamshelf-source-smoke-v1', { flag: 'wx', mode: 0o600 });

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function redact(value) {
  if (!token) {
    const envPath = path.join(checkout, '.env');
    if (existsSync(envPath)) {
      const generated = readFileSync(envPath, 'utf8').match(/^SETUP_TOKEN=(.+)$/m)?.[1];
      if (generated) { token = generated; secrets.push(token); }
    }
  }
  let text = String(value ?? '');
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/SETUP_TOKEN=[^\s]+/g, 'SETUP_TOKEN=[redacted]')
    .replace(/teamshelf_session=[^;\s]+/g, 'teamshelf_session=[redacted]');
}

function verifyOwnedPaths() {
  const root = realpathSync(tempRoot);
  assert(root.startsWith(tempParent + path.sep), 'temporary root is outside the OS temporary directory');
  assert(readFileSync(marker, 'utf8') === 'teamshelf-source-smoke-v1', 'temporary ownership marker mismatch');
  if (existsSync(checkout)) assert(realpathSync(checkout).startsWith(root + path.sep), 'checkout escaped temporary root');
  assert(path.resolve(backupDir) !== path.resolve(checkout), 'backup directory overlaps checkout');
}

function copyCheckout() {
  const omitted = new Set(['.git', '.env', 'node_modules', 'dist', 'data', 'test-results', 'playwright-report', 'coverage']);
  cpSync(repoRoot, checkout, {
    recursive: true,
    filter(source) {
      const relative = path.relative(repoRoot, source);
      return !relative || !omitted.has(relative.split(path.sep)[0]);
    },
  });
  assert(existsSync(path.join(checkout, 'compose.yaml')), 'copied source is missing compose.yaml');
  assert(!existsSync(path.join(checkout, '.env')), 'copied source unexpectedly includes .env');
  assert(!existsSync(backupDir), 'backup leaf must not exist before source-up creates it');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? checkout, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const collect = chunk => {
      output += chunk.toString();
      if (output.length > 48_000) output = output.slice(-48_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      reject(new Error(phase + ': ' + command + ' timed out'));
    }, options.timeoutMs ?? 20 * 60 * 1000);
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(phase + ': could not start ' + command + ': ' + redact(error.message)));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve(output);
      const tail = redact(output.split(/\r?\n/).slice(-35).join('\n'));
      reject(new Error(phase + ': ' + command + ' exited ' + (code ?? signal) + (tail ? '\n' + tail : '')));
    });
  });
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? checkout,
    env: process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const tail = redact([result.stdout, result.stderr].filter(Boolean).join('\n').split(/\r?\n/).slice(-25).join('\n'));
    throw new Error(phase + ': ' + command + ' failed' + (tail ? '\n' + tail : ''));
  }
  return result.stdout.trim();
}

async function getUnusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'unable to allocate a loopback port');
  const selected = address.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return selected;
}

function assertNoExistingResources() {
  phase = 'isolation preflight';
  const volumeCheck = spawnSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' });
  assert(volumeCheck.status !== 0, 'random smoke volume already exists; refusing to use it');
  const containers = runSync('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]);
  assert(!containers, 'random smoke project already has containers; refusing to use it');
  volumeWasAbsent = true;
}

async function runSourceUp(firstInstall) {
  phase = firstInstall ? 'first source deployment' : 'same-volume source redeployment';
  const args = [
    'deploy/source-up.sh',
    '--project', project,
    '--volume', volume,
    '--backup-dir', backupDir,
    '--origin', origin,
    '--port', String(port),
    '--cookie-secure', 'false',
  ];
  if (firstInstall) args.push('--init-volume');
  await run('bash', args, { timeoutMs: 25 * 60 * 1000 });
}

async function request(apiPath, options = {}) {
  const response = await fetch(new URL(apiPath, origin), {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    ...options,
  });
  if (!response.ok) throw new Error(phase + ': ' + (options.method ?? 'GET') + ' ' + apiPath + ' returned HTTP ' + response.status);
  return response;
}

async function waitHealthy() {
  const deadline = Date.now() + 30_000;
  let state = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/health', origin), { redirect: 'error', signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      state = 'HTTP ' + response.status;
    } catch {
      state = 'connection unavailable';
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(phase + ': health endpoint did not become ready (' + state + ')');
}

function readSetupToken() {
  const envPath = path.join(checkout, '.env');
  assert(existsSync(envPath), 'source-up did not create the isolated .env');
  const match = readFileSync(envPath, 'utf8').match(/^SETUP_TOKEN=(.+)$/m);
  assert(match?.[1], 'isolated .env is missing SETUP_TOKEN');
  return match[1].replace(/^["']|["']$/g, '');
}

function readSession(response) {
  const all = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''];
  const match = all.find(value => value.startsWith('teamshelf_session='))?.match(/teamshelf_session=([^;,\s]+)/);
  assert(match?.[1], 'setup did not establish a session');
  return 'teamshelf_session=' + match[1];
}

async function initializeData() {
  phase = 'initialize real API data';
  assert((await (await request('/api/setup')).json()).needsSetup === true, 'first install did not use an empty volume');
  token = readSetupToken();
  secrets.push(token);
  const password = 'SourceSmoke-' + randomUUID() + '-Password!';
  secrets.push(password);
  const email = 'source-' + randomUUID() + '@example.test';
  const setupResponse = await request('/api/setup', {
    method: 'POST',
    headers: { origin, 'x-requested-with': 'TeamShelf', 'content-type': 'application/json' },
    body: JSON.stringify({ token, name: 'CI Source Smoke Admin', email, password, teamName: 'CI Source Smoke Team' }),
  });
  cookie = readSession(setupResponse);
  secrets.push(cookie);
  const setup = await setupResponse.json();
  const teamId = setup.teams?.[0]?.id;
  assert(teamId, 'setup response did not include the team');
  const spaces = await (await request('/api/teams/' + teamId + '/spaces', { headers: { cookie } })).json();
  const spaceId = spaces.spaces?.[0]?.id;
  assert(spaceId, 'setup did not create a knowledge space');
  const created = await request('/api/spaces/' + spaceId + '/documents', {
    method: 'POST',
    headers: { cookie, origin, 'x-requested-with': 'TeamShelf', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'CI source deployment persistence smoke', body: expectedBody }),
  });
  const document = (await created.json()).document;
  assert(document?.id && document.version === 1, 'document creation failed');
  documentId = document.id;
}

async function verifyServiceAndBackup() {
  phase = 'verify service and retained identity';
  await waitHealthy();
  const me = await (await request('/api/auth/me', { headers: { cookie } })).json();
  assert(me.user?.id && me.teams?.some(team => team.role === 'owner'), 'existing session did not survive redeployment');
  const document = (await (await request('/api/documents/' + documentId, { headers: { cookie } })).json()).document;
  assert(document?.id === documentId && document.body === expectedBody && document.version === 1, 'document did not survive redeployment');

  phase = 'verify consistency backup exists';
  const files = readdirSync(backupDir).filter(name => /^teamshelf-.*\.sqlite$/.test(name));
  assert(files.length > 0, 'source redeployment did not create a SQLite backup');
  const sql = [
    'import { DatabaseSync } from "node:sqlite";',
    'const db = new DatabaseSync("/backup/" + process.env.BACKUP_FILE, { readOnly: true });',
    'try {',
    '  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("integrity check failed");',
    '  const row = db.prepare("SELECT body, version FROM documents WHERE id = ?").get(process.env.DOCUMENT_ID);',
    '  if (row?.body !== process.env.EXPECTED_BODY || row.version !== 1) throw new Error("document missing from backup");',
    '} finally { db.close(); }',
    'process.stdout.write("SQLite backup content verified.\\n");',
  ].join('\n');
  runSync('docker', [
    'run', '--rm', '--network', 'none', '--user', '1000:1000',
    '--mount', 'type=bind,source=' + backupDir + ',target=/backup,readonly',
    '--env', 'BACKUP_FILE=' + files[0],
    '--env', 'DOCUMENT_ID=' + documentId,
    '--env', 'EXPECTED_BODY=' + expectedBody,
    '--entrypoint', 'node', 'node:24-bookworm-slim',
    '--input-type=module', '-e', sql,
  ]);
}

function cleanup() {
  phase = 'cleanup';
  verifyOwnedPaths();
  const envPath = path.join(checkout, '.env');
  if (existsSync(envPath)) {
    spawnSync('docker', ['compose', '--env-file', '.env', '-p', project, '-f', 'compose.yaml', 'down', '--remove-orphans'], {
      cwd: checkout,
      stdio: 'ignore',
      timeout: 90_000,
    });
  }
  const remainingIds = spawnSync('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (remainingIds.status === 0 && remainingIds.stdout.trim()) {
    for (const id of remainingIds.stdout.trim().split(/\s+/)) {
      const owner = spawnSync('docker', ['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project"}}', id], { encoding: 'utf8' });
      assert(owner.status === 0 && owner.stdout.trim() === project, 'refusing to remove a container outside the unique smoke project');
      spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore', timeout: 30_000 });
    }
  }
  if (volumeWasAbsent) {
    const present = spawnSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' });
    if (present.status === 0) {
      const attached = spawnSync('docker', ['ps', '-aq', '--filter', 'volume=' + volume], { encoding: 'utf8' });
      assert(attached.status === 0 && !attached.stdout.trim(), 'refusing to remove a smoke volume still attached to a container');
      const removed = spawnSync('docker', ['volume', 'rm', volume], { encoding: 'utf8' });
      assert(removed.status === 0, 'could not remove the unique smoke volume');
    }
  }
  verifyOwnedPaths();
  rmSync(tempRoot, { recursive: true, force: true });
}

try {
  assert(!process.env.SMOKE_ROOT, 'source smoke owns its temporary root; do not set SMOKE_ROOT');
  verifyOwnedPaths();
  copyCheckout();
  port = await getUnusedPort();
  origin = 'http://' + host + ':' + port;
  assertNoExistingResources();
  process.stdout.write('Prepared isolated source deployment smoke environment.\n');

  await runSourceUp(true);
  const created = spawnSync('docker', ['volume', 'inspect', volume], { stdio: 'ignore' });
  assert(created.status === 0, 'first install did not create its unique Docker volume');
  await waitHealthy();
  await initializeData();
  await runSourceUp(false);
  await verifyServiceAndBackup();
  success = true;
  process.stdout.write('Source deployment smoke passed: first install, same-volume redeploy, session/document persistence, and SQLite backup verified.\n');
} catch (error) {
  process.stderr.write('Source deployment smoke failed during ' + phase + ': ' + redact(error?.message ?? 'unknown failure') + '\n');
  process.exitCode = 1;
} finally {
  try {
    cleanup();
    if (success) process.stdout.write('Removed the isolated source snapshot and unique smoke volume.\n');
  } catch (error) {
    process.stderr.write('Source smoke cleanup failed: ' + redact(error?.message ?? 'unknown failure') + '\n');
    process.exitCode = 1;
    try {
      verifyOwnedPaths();
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Keep any path whose ownership can no longer be proven untouched.
    }
  }
}
