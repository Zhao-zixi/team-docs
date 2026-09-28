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
  if (currentVersion > 8) throw new Error('Database schema version ' + currentVersion + ' is newer than this application supports.');
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
  if (currentVersion < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_drafts (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('markdown','rich')),
        base_version INTEGER NOT NULL CHECK (base_version > 0),
        state TEXT NOT NULL CHECK (state IN ('editing','reviewing')),
        y_state BLOB NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
        title TEXT NOT NULL,
        updated_by TEXT NOT NULL REFERENCES users(id),
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS document_drafts_editing_idx ON document_drafts(doc_id) WHERE state='editing';
      CREATE INDEX IF NOT EXISTS document_drafts_doc_idx ON document_drafts(doc_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS draft_updates (
        draft_id TEXT NOT NULL REFERENCES document_drafts(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        update_blob BLOB NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (draft_id,seq)
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
        target_document_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('create','update','restore','delete')),
        author_id TEXT NOT NULL REFERENCES users(id),
        base_version INTEGER,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'inherit' CHECK (visibility IN ('inherit','restricted')),
        grants_json TEXT NOT NULL DEFAULT '[]',
        source_draft_id TEXT REFERENCES document_drafts(id) ON DELETE SET NULL,
        revision_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn','conflicted')),
        reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        decision_note TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS proposals_team_idx ON proposals(team_id,status,created_at DESC,id);
      CREATE INDEX IF NOT EXISTS proposals_author_idx ON proposals(author_id,status,created_at DESC);
      CREATE INDEX IF NOT EXISTS proposals_document_idx ON proposals(target_document_id,created_at DESC);
      PRAGMA user_version = 5;
    `);
  }
  if (currentVersion < 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_comments (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES document_comments(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('published','draft','proposal')),
        source_version INTEGER,
        source_draft_id TEXT REFERENCES document_drafts(id) ON DELETE CASCADE,
        source_seq INTEGER,
        source_proposal_id TEXT REFERENCES proposals(id) ON DELETE CASCADE,
        quote TEXT NOT NULL,
        paragraph_index INTEGER NOT NULL CHECK (paragraph_index >= 0),
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
        body TEXT NOT NULL,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mention_user_ids_json TEXT NOT NULL DEFAULT '[]',
        resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (source_kind='published' AND source_version IS NOT NULL AND source_draft_id IS NULL AND source_seq IS NULL AND source_proposal_id IS NULL) OR
          (source_kind='draft' AND source_version IS NULL AND source_draft_id IS NOT NULL AND source_seq IS NOT NULL AND source_proposal_id IS NULL) OR
          (source_kind='proposal' AND source_version IS NULL AND source_draft_id IS NULL AND source_seq IS NULL AND source_proposal_id IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS document_comments_doc_thread_idx ON document_comments(document_id,parent_id,created_at,id);
      CREATE TABLE IF NOT EXISTS comment_notifications (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL REFERENCES document_comments(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        read_at TEXT,
        UNIQUE(comment_id,recipient_id)
      );
      CREATE INDEX IF NOT EXISTS comment_notifications_recipient_idx ON comment_notifications(recipient_id,created_at DESC,id);
      PRAGMA user_version = 6;
    `);
  }
  if (currentVersion < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_workflow (
        document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        responsible_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        review_at TEXT,
        last_reviewed_at TEXT,
        due_at TEXT,
        metadata_version INTEGER NOT NULL DEFAULT 0 CHECK (metadata_version >= 0),
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_reminders (
        team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
        sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminder_outbox (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('review','due')),
        due_at TEXT NOT NULL,
        recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        claimed_at TEXT,
        sent_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(document_id,kind,due_at,recipient_id)
      );
      CREATE INDEX IF NOT EXISTS reminder_outbox_due_idx ON reminder_outbox(status,next_attempt_at,created_at);
      PRAGMA user_version = 7;
    `);
  }
  if (currentVersion < 8) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS external_rooms (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        session_generation INTEGER NOT NULL DEFAULT 1 CHECK (session_generation > 0),
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        rotated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS external_rooms_team_idx ON external_rooms(team_id,created_at DESC,id);
      CREATE TABLE IF NOT EXISTS external_room_items (
        room_id TEXT NOT NULL REFERENCES external_rooms(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        published_version INTEGER NOT NULL CHECK (published_version > 0),
        title_snapshot TEXT NOT NULL,
        body_snapshot TEXT NOT NULL,
        acl_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(room_id,document_id)
      );
      CREATE TABLE IF NOT EXISTS external_room_sessions (
        token_hash TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES external_rooms(id) ON DELETE CASCADE,
        session_generation INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS external_room_sessions_room_idx ON external_room_sessions(room_id,expires_at);
      CREATE TABLE IF NOT EXISTS external_room_access_logs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES external_rooms(id) ON DELETE CASCADE,
        document_id TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('session_created','items_viewed','document_viewed')),
        accessed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS external_room_access_idx ON external_room_access_logs(room_id,accessed_at DESC,id);
      PRAGMA user_version = 8;
    `);
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
