import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const options = process.argv.slice(2);
const force = options.includes('--force');
if (options.some((option) => option !== '--force')) throw new Error('Usage: node scripts/configure.mjs [--force]');
const envPath = path.resolve(process.cwd(), '.env');
const appOrigin = process.env.APP_ORIGIN || 'http://localhost:8080';
const port = process.env.PORT || '8080';
const cookieSecure = process.env.COOKIE_SECURE || 'false';
const dataDir = process.env.DATA_DIR || './data';

try {
  await access(envPath, constants.F_OK);
  if (!force) throw new Error('.env already exists; pass --force to replace it.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

let origin;
try { origin = new URL(appOrigin); } catch { throw new Error('APP_ORIGIN must be an absolute http(s) origin.'); }
if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== appOrigin || origin.username || origin.password) {
  throw new Error('APP_ORIGIN must contain only the exact browser origin, for example http://localhost:8080.');
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
if (!['true', 'false'].includes(cookieSecure)) throw new Error('COOKIE_SECURE must be true or false.');

const token = randomBytes(32).toString('base64url');
const contents = [
  `PORT=${port}`,
  `APP_ORIGIN=${appOrigin}`,
  `COOKIE_SECURE=${cookieSecure}`,
  `SETUP_TOKEN=${token}`,
  `DATA_DIR=${dataDir}`,
  '',
].join('\n');
const temporaryPath = `${envPath}.${process.pid}.tmp`;
await mkdir(path.dirname(envPath), { recursive: true });
await writeFile(temporaryPath, contents, { mode: 0o600, flag: 'wx' });
try {
  await rename(temporaryPath, envPath);
} catch (error) {
  await unlink(temporaryPath).catch(() => {});
  throw error;
}

console.log(`Created ${envPath}. Set APP_ORIGIN to the exact URL users open on the NAS, then start TeamShelf.`);
console.log('The one-time setup token is stored in .env; retrieve it locally when completing first-time setup.');