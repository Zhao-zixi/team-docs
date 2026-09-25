import { mkdir } from 'node:fs/promises';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { acquireDataLock } from './lock.js';

async function main(): Promise<void> {
  const config = readConfig();
  if (!config.setupToken || config.setupToken.length < 32) {
    throw new Error('SETUP_TOKEN must contain at least 32 characters. Run npm run configure first.');
  }
  await mkdir(config.dataDir, { recursive: true });
  const releaseLock = await acquireDataLock(config.dataDir);
  const app = createApp({ config, logger: false });
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    await app.close().catch(() => {});
    await releaseLock();
    throw error;
  }

  let closing = false;
  const shutdownKeepAlive = setInterval(() => {}, 1_000);
  shutdownKeepAlive.unref();
  const close = async () => {
    if (closing) return;
    closing = true;
    shutdownKeepAlive.ref();
    try {
      await app.close();
      await releaseLock();
    } finally {
      clearInterval(shutdownKeepAlive);
    }
  };
  const handleSignal = () => {
    void close().catch((error: unknown) => {
      console.error(`TeamShelf shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  console.info(`TeamShelf listening on port ${config.port}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`TeamShelf failed to start: ${message}`);
  process.exitCode = 1;
});
