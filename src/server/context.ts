import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import type { MailSender } from './mailer.js';

export interface AppContext {
  db: Db;
  config: AppConfig;
  mailSender?: MailSender;
}
