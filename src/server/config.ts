import path from 'node:path';

export interface AppConfig {
  port: number;
  dataDir: string;
  appOrigin: string;
  setupToken: string;
  cookieSecure: boolean;
  isProduction: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const isProduction = env.NODE_ENV === 'production';
  const appOrigin = env.APP_ORIGIN ?? (isProduction ? '' : 'http://localhost:5173');
  if (isProduction && !appOrigin) throw new Error('APP_ORIGIN is required in production.');
  if (appOrigin) {
    const origin = new URL(appOrigin);
    if (origin.origin !== appOrigin || !['http:', 'https:'].includes(origin.protocol)) {
      throw new Error('APP_ORIGIN must be an exact http(s) origin without a path.');
    }
  }
  return {
    port,
    dataDir: path.resolve(env.DATA_DIR ?? path.join(process.cwd(), 'data')),
    appOrigin,
    setupToken: env.SETUP_TOKEN ?? '',
    cookieSecure: env.COOKIE_SECURE === 'true',
    isProduction,
  };
}
