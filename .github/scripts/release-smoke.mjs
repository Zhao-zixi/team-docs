import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const origin = process.env.APP_ORIGIN;
const setupToken = process.env.SETUP_TOKEN;
const statePath = process.env.RELEASE_SMOKE_STATE;
const documentBody = 'CI release persistence smoke body';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function loadState() {
  assert(statePath, 'release smoke state path is not configured');
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

async function request(apiPath, options = {}) {
  const response = await fetch(new URL(apiPath, origin), { redirect: 'error', ...options });
  if (!response.ok) throw new Error(`release smoke request failed: ${options.method ?? 'GET'} ${apiPath} (${response.status})`);
  return response;
}

async function initialize() {
  assert(origin && setupToken && statePath, 'release smoke environment is incomplete');
  const needsSetup = await (await request('/api/setup')).json();
  assert(needsSetup.needsSetup === true, 'fresh release volume was not empty');
  const setupResponse = await request('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'x-requested-with': 'TeamShelf' },
    body: JSON.stringify({
      token: setupToken,
      name: 'CI Release Smoke',
      email: `release-${randomUUID()}@example.test`,
      password: `Smoke-${randomUUID()}-Password!`,
      teamName: 'CI Release Smoke Team',
    }),
  });
  const cookie = setupResponse.headers.get('set-cookie')?.match(/teamshelf_session=([^;,]+)/)?.[1];
  assert(cookie, 'setup did not establish a session');
  const setup = await setupResponse.json();
  const teamId = setup.teams?.[0]?.id;
  assert(teamId, 'setup response did not include the new team');
  const spaces = await (await request(`/api/teams/${teamId}/spaces`, { headers: { cookie: `teamshelf_session=${cookie}` } })).json();
  const spaceId = spaces.spaces?.[0]?.id;
  assert(spaceId, 'setup did not create a team space');
  const created = await request(`/api/spaces/${spaceId}/documents`, {
    method: 'POST',
    headers: { cookie: `teamshelf_session=${cookie}`, origin, 'x-requested-with': 'TeamShelf', 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'CI release persistence smoke', body: documentBody }),
  });
  const document = (await created.json()).document;
  assert(document?.id, 'document creation response was invalid');
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ cookie: `teamshelf_session=${cookie}`, documentId: document.id }), { mode: 0o600 });
  chmodSync(statePath, 0o600);
  process.stdout.write('Release smoke initialized persistent test data.\n');
}

async function verifyService() {
  assert(origin && statePath, 'release smoke environment is incomplete');
  const state = loadState();
  const document = (await (await request(`/api/documents/${state.documentId}`, { headers: { cookie: state.cookie } })).json()).document;
  assert(document?.id === state.documentId && document.body === documentBody && document.version === 1, 'document data was not retained across release');
  const identity = await request('/api/auth/me', { headers: { cookie: state.cookie } });
  assert(identity.status === 200, 'pre-upgrade session was not retained');
  process.stdout.write('Release smoke retained the session and document after redeployment.\n');
}

const [mode] = process.argv.slice(2);
if (mode === 'initialize') await initialize();
else if (mode === 'verify') await verifyService();
else throw new Error('usage: release-smoke.mjs initialize|verify');