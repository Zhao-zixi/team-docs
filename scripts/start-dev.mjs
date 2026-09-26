import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const children = [];
let stopping = false;
let failed = false;
function start(name, args) {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: 'inherit', windowsHide: true, detached: false });
  child.name = name;
  children.push(child);
  child.once('error', (error) => { failed = true; console.error(`${name} failed to start: ${error.message}`); void shutdown(); });
  child.once('exit', (code, signal) => {
    if (!stopping) { failed = true; console.error(`${name} exited unexpectedly (${signal ?? code ?? 'unknown'}).`); void shutdown(); }
  });
  console.log(`${name} started (PID ${child.pid}).`);
  return child;
}
async function waitFor(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${child.name} exited before becoming ready.`);
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (response.ok) return; } catch {}
    await delay(350);
  }
  throw new Error(`${child.name} did not become ready at ${url}.`);
}
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Ctrl+C is delivered by the shared console to this process group on Windows.
  const exited = Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve))));
  await Promise.race([exited, delay(10_000)]);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    console.error(`${child.name} did not stop within 10 seconds; terminating only its PID ${child.pid}.`);
    try { child.kill('SIGTERM'); } catch {}
  }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
const api = start('TeamShelf API', ['--env-file-if-exists=.env', '--import', './scripts/dev-env.mjs', '--import', 'tsx/esm', 'src/server/index.ts']);
try {
  await waitFor('http://127.0.0.1:3000/api/health', api, 60_000);
  const vite = start('TeamShelf Vite', ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1']);
  await waitFor('http://127.0.0.1:5173', vite, 30_000);
  console.log('TeamShelf development is ready at http://localhost:5173');
  console.log('Press Ctrl+C to stop the API and Vite.');
  await Promise.race(children.map((child) => new Promise((resolve) => child.once('exit', resolve))));
  if (!stopping) await shutdown();
} catch (error) { failed = true; console.error(error.message); await shutdown(); }
if (failed) process.exitCode = 1;
