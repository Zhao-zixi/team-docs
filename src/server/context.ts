import type { AppConfig } from './config.js';
import type { Db } from './db.js';

export interface AppContext {
  db: Db;
  config: AppConfig;
}
