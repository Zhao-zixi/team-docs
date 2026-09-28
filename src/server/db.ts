import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDatabase(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'teamshelf.sqlite'), { timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      normalized_email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS members_user_idx ON members(user_id, team_id);
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL CHECK (visibility IN ('team','restricted')),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS spaces_team_idx ON spaces(team_id, name);
    CREATE TABLE IF NOT EXISTS space_grants (
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      PRIMARY KEY (space_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL CHECK (visibility IN ('inherit','restricted')),
      version INTEGER NOT NULL CHECK (version > 0),
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL REFERENCES users(id),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS documents_space_idx ON documents(space_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS document_grants (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      PRIMARY KEY (document_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      author_name TEXT NOT NULL,
      UNIQUE (document_id, version)
    );
    CREATE INDEX IF NOT EXISTS revisions_document_idx ON revisions(document_id, version DESC);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      normalized_email TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (delivery_status IN ('not_sent','sending','sent','failed')),
      last_sent_at TEXT,
      send_generation INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS invitations_team_idx ON invitations(team_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      created_at TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS audit_team_idx ON audit_events(team_id, created_at DESC);

  `);
  const currentVersion = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (currentVersion > 4) throw new Error('Database schema version ' + currentVersion + ' is newer than this application supports.');
  if (currentVersion < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        space_id TEXT,
        name TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('read','write','manage')),
        token_hash TEXT NOT NULL UNIQUE,
        token_hint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_tokens_user_idx ON agent_tokens(user_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS agent_tokens_team_idx ON agent_tokens(team_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS agent_tokens_space_idx ON agent_tokens(space_id);
      PRAGMA user_version = 2;
    `);
  }
  if (currentVersion < 3) {
    transaction(db, () => {
      const invitationColumns = new Set((db.prepare('PRAGMA table_info(invitations)').all() as Array<{ name: string }>).map((column) => column.name));
      if (!invitationColumns.has('delivery_status')) db.exec("ALTER TABLE invitations ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'not_sent'");
      if (!invitationColumns.has('last_sent_at')) db.exec('ALTER TABLE invitations ADD COLUMN last_sent_at TEXT');
      if (!invitationColumns.has('send_generation')) db.exec('ALTER TABLE invitations ADD COLUMN send_generation INTEGER NOT NULL DEFAULT 0');
      db.exec([
        "CREATE TABLE IF NOT EXISTS mail_settings (",
        "  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,",
        "  host TEXT NOT NULL,",
        "  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),",
        "  security TEXT NOT NULL CHECK (security IN ('tls','starttls')),",
        "  username TEXT NOT NULL,",
        "  from_email TEXT NOT NULL,",
        "  from_name TEXT NOT NULL,",
        "  password_ciphertext TEXT NOT NULL,",
        "  password_iv TEXT NOT NULL,",
        "  password_tag TEXT NOT NULL,",
        "  created_at TEXT NOT NULL,",
        "  updated_at TEXT NOT NULL",
        ");"
      ].join('\n'));
      db.exec('PRAGMA user_version = 3');
    });
  }
  if (currentVersion < 4) {
    const spaceColumns = new Set((db.prepare('PRAGMA table_info(spaces)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!spaceColumns.has('require_review')) db.exec('ALTER TABLE spaces ADD COLUMN require_review INTEGER NOT NULL DEFAULT 0 CHECK (require_review IN (0,1))');
    db.exec('PRAGMA user_version = 4');
  }
  return db;
}

export function transaction<T>(db: Db, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
