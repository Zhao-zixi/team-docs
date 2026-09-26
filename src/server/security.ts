import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 96 * 1024 * 1024 };

function derivePasswordKey(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeSecretEqual(provided: string, expected: string): boolean {
  const left = createHash('sha256').update(provided).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePasswordKey(password, salt, 64);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltText, hashText, extra] = encoded.split('$');
  if (algorithm !== 'scrypt' || nText !== `${SCRYPT_N}` || rText !== `${SCRYPT_R}` || pText !== `${SCRYPT_P}` || !saltText || !hashText || extra !== undefined) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await derivePasswordKey(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function expiresInDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function isPasswordLength(password: string, min: number, max = 128): boolean {
  const length = [...password].length;
  return length >= min && length <= max && Buffer.byteLength(password, 'utf8') <= 512;
}

const COMMON_PASSWORDS = new Set(['password', 'password123', 'password1234', 'password12345', 'password123456', 'password1234567', 'password12345678', 'password123456789', 'qwerty', 'qwerty123', 'letmein', 'welcome', 'admin', 'changeme', 'iloveyou', '123456789012345']);
export function isStrongNewPassword(password: string): boolean {
  if (!isPasswordLength(password, 15, 128)) return false;
  const normalized = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (COMMON_PASSWORDS.has(normalized)) return false;
  if (/^(.)\1{7,}$/.test(password)) return false;
  return true;
}
