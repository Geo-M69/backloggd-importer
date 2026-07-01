import Database from 'better-sqlite3';
import { getCreateTableSQL } from './schema.js';

let _db: Database.Database | null = null;
let _activePath: string | null = null;

/**
 * Run idempotent schema migrations for databases created before a column
 * or constraint existed.  Each migration checks whether the target column
 * is already present before modifying the table.
 */
export function runMigrations(db: Database.Database): void {
  // Migration 1: add `stale` column to `games` (added in Milestone 2)
  const gamesColumns = (db.pragma('table_info(games)') as { name: string }[]).map(
    (col) => col.name,
  );
  if (!gamesColumns.includes('stale')) {
    db.exec(`
      ALTER TABLE games
        ADD COLUMN stale INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(stale) = 'integer' AND stale IN (0, 1))
    `);
  }

  // Migration 2: add `policy_json` column to `import_sessions` (Milestone 3)
  // Guard: the table may not exist in very old databases or test fixtures.
  const hasImportSessions = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='import_sessions'")
    .get();
  if (hasImportSessions) {
    const sessionColumns = (db.pragma('table_info(import_sessions)') as { name: string }[]).map(
      (col) => col.name,
    );
    if (!sessionColumns.includes('policy_json')) {
      db.exec('ALTER TABLE import_sessions ADD COLUMN policy_json TEXT');
    }
  }

  // Migration 3: add `igdb_name` column to proposals (Milestone 3 immutability fix)
  const hasProposalsTable = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'")
    .get();
  if (hasProposalsTable) {
    const propCols = (db.pragma('table_info(proposals)') as { name: string }[]).map(
      (col) => col.name,
    );
    if (!propCols.includes('igdb_name')) {
      db.exec('ALTER TABLE proposals ADD COLUMN igdb_name TEXT');
      // Backfill from matches (safely skip if matches table doesn't exist)
      const hasMatchesTable = !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='matches'")
        .get();
      if (hasMatchesTable) {
        db.exec(`
          UPDATE proposals
          SET igdb_name = (
            SELECT m.igdb_name FROM matches m
            WHERE m.steam_app_id = proposals.steam_app_id
              AND m.igdb_id = proposals.igdb_id
            LIMIT 1
          )
          WHERE igdb_name IS NULL
        `);
      }
    }
  }

  // Migration 4a: add `steam_title` column to proposals
  if (hasProposalsTable) {
    const propCols2 = (db.pragma('table_info(proposals)') as { name: string }[]).map(
      (col) => col.name,
    );
    if (!propCols2.includes('steam_title')) {
      db.exec('ALTER TABLE proposals ADD COLUMN steam_title TEXT');
      // Backfill from games (safely skip if games table doesn't exist)
      const hasGamesTable = !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='games'")
        .get();
      if (hasGamesTable) {
        db.exec(`
          UPDATE proposals
          SET steam_title = (
            SELECT g.title FROM games g
            WHERE g.app_id = proposals.steam_app_id
            LIMIT 1
          )
          WHERE steam_title IS NULL
        `);
      }
    }
  }

  // Migration 4b: evolve proposals table to Milestone 3 schema
  const hasProposals = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'")
    .get();
  if (hasProposals) {
    const proposalColumns = (db.pragma('table_info(proposals)') as { name: string }[]).map(
      (col) => col.name,
    );
    if (proposalColumns.includes('action')) {
      // Old schema has `action` → migrate to `proposal_kind`
      // Check whether games has playtime_minutes (required for playlog payloads)
      const gamesForPlaylog = !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='games'")
        .get();
      const hasPlaytimeColumn = gamesForPlaylog
        ? (db.pragma('table_info(games)') as { name: string }[]).some(
            (c) => c.name === 'playtime_minutes',
          )
        : false;
      const playtimeSubquerySnippet = hasPlaytimeColumn
        ? 'COALESCE((SELECT g.playtime_minutes FROM games g WHERE g.app_id = proposals.steam_app_id LIMIT 1), 0)'
        : '0';

      db.exec(`
      CREATE TABLE IF NOT EXISTS proposals_new (
        id                      TEXT    PRIMARY KEY,
        import_session_id       TEXT    NOT NULL,
        steam_app_id            INTEGER NOT NULL,
        steam_title             TEXT,
        igdb_id                 INTEGER,
        igdb_name               TEXT,
        backloggd_slug          TEXT,
        proposal_kind           TEXT    NOT NULL CHECK (proposal_kind IN ('ownership', 'status', 'playlog')),
        status                  TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'skipped', 'deferred', 'blocked', 'applied', 'failed')),
        match_confidence        TEXT    NOT NULL CHECK (match_confidence IN ('exact', 'probable', 'ambiguous', 'unmatched')),
        requires_manual_review  INTEGER NOT NULL DEFAULT 0 CHECK (typeof(requires_manual_review) = 'integer' AND requires_manual_review IN (0, 1)),
        suggested_payload       TEXT,
        notes                   TEXT,
        decision_notes          TEXT,
        created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id),
        FOREIGN KEY (import_session_id) REFERENCES import_sessions(id)
      );

      INSERT INTO proposals_new (
        id, import_session_id, steam_app_id, steam_title, igdb_id, igdb_name, backloggd_slug,
        proposal_kind, status, match_confidence,
        requires_manual_review, suggested_payload, notes, decision_notes,
        created_at, updated_at
      )
      SELECT
        id, import_session_id, steam_app_id,
        (SELECT g.title FROM games g WHERE g.app_id = proposals.steam_app_id LIMIT 1),
        igdb_id, igdb_name, backloggd_slug,
        CASE action
          WHEN 'add-ownership' THEN 'ownership'
          WHEN 'update-status' THEN 'status'
          WHEN 'add-to-backlog' THEN 'status'
          WHEN 'mark-played' THEN 'playlog'
        END,
        CASE WHEN status = 'pending'   THEN 'pending'
             WHEN status = 'approved'  THEN 'approved'
             WHEN status = 'skipped'   THEN 'skipped'
             WHEN status = 'applied'   THEN 'applied'
             WHEN status = 'failed'    THEN 'failed'
        END,
           match_confidence,
        CASE WHEN match_confidence = 'unmatched' THEN 1 ELSE 0 END,
        CASE
          WHEN action = 'add-ownership' AND match_confidence IN ('ambiguous', 'probable')
            THEN CASE match_confidence
              WHEN 'ambiguous' THEN '{"platform":"steam","ownershipType":"digital","reason":"ambiguous"}'
              WHEN 'probable'  THEN '{"platform":"steam","ownershipType":"digital","reason":"probable"}'
            END
          WHEN action = 'add-ownership' THEN '{"platform":"steam","ownershipType":"digital"}'
          WHEN action IN ('update-status', 'add-to-backlog') THEN '{"suggestion":"none"}'
          WHEN action = 'mark-played'
            THEN '{"enabled":false,"sourcePlaytimeMinutes":' || ${playtimeSubquerySnippet} || '}'
          ELSE NULL
        END, notes, NULL,
        created_at, updated_at
      FROM proposals;

      DROP TABLE proposals;
      ALTER TABLE proposals_new RENAME TO proposals;
    `);

      // Re-create indexes on the migrated table
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_session_kind ON proposals(import_session_id, steam_app_id, proposal_kind)',
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(import_session_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_proposals_confidence ON proposals(match_confidence)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_proposals_steam_app_id ON proposals(steam_app_id)');
    }
  }

  // -----------------------------------------------------------------------
  // Repair / backfill steps — run unconditionally for databases that may
  // have been opened by a previous migration version that left NULL or
  // non-canonical snapshot columns.
  // -----------------------------------------------------------------------

  if (hasProposalsTable) {
    const propCols = (db.pragma('table_info(proposals)') as { name: string }[]).map(
      (col) => col.name,
    );

    // 1. Backfill NULL steam_title from games
    if (propCols.includes('steam_title')) {
      const hasGamesTable = !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='games'")
        .get();
      if (hasGamesTable) {
        db.exec(`
          UPDATE proposals
          SET steam_title = (
            SELECT g.title FROM games g
            WHERE g.app_id = proposals.steam_app_id
            LIMIT 1
          )
          WHERE steam_title IS NULL
        `);
      }
    }

    // 2. Backfill NULL igdb_name from matches
    if (propCols.includes('igdb_name')) {
      const hasMatchesTable = !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='matches'")
        .get();
      if (hasMatchesTable) {
        db.exec(`
          UPDATE proposals
          SET igdb_name = (
            SELECT m.igdb_name FROM matches m
            WHERE m.steam_app_id = proposals.steam_app_id
              AND m.igdb_id = proposals.igdb_id
            LIMIT 1
          )
          WHERE igdb_name IS NULL
        `);
      }
    }

    // 3. Repair non-canonical suggested_payload — fix old migration artifacts
    //    where playlog or ownership payloads match the *broken* old format.
    //    Idempotent: after the first fix the row no longer matches the WHERE.
    if (propCols.includes('suggested_payload')) {
      // 3a. Ownership payloads that are NULL or stuck as old non-canonical values
      db.exec(`
        UPDATE proposals
        SET suggested_payload =
          CASE
            WHEN match_confidence = 'ambiguous' THEN '{"platform":"steam","ownershipType":"digital","reason":"ambiguous"}'
            WHEN match_confidence = 'probable'  THEN '{"platform":"steam","ownershipType":"digital","reason":"probable"}'
            ELSE '{"platform":"steam","ownershipType":"digital"}'
          END
        WHERE proposal_kind = 'ownership'
          AND (suggested_payload IS NULL
               OR suggested_payload = '{"enabled":false}')
      `);

      // 3b. Playlog payloads that are NULL or missing sourcePlaytimeMinutes
      const hasGamesForPlaylog = !!db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='games'")
        .get();
      const hasPlaytimeColumn = hasGamesForPlaylog
        ? (db.pragma('table_info(games)') as { name: string }[]).some(
            (c) => c.name === 'playtime_minutes',
          )
        : false;
      if (hasGamesForPlaylog && hasPlaytimeColumn) {
        db.exec(`
          UPDATE proposals
          SET suggested_payload = '{"enabled":false,"sourcePlaytimeMinutes":' || COALESCE((SELECT g.playtime_minutes FROM games g WHERE g.app_id = proposals.steam_app_id LIMIT 1), 0) || '}'
          WHERE proposal_kind = 'playlog'
            AND (suggested_payload IS NULL
                 OR suggested_payload = '{"enabled":false}')
        `);
      }

      // 3c. Status payloads that are NULL
      db.exec(`
        UPDATE proposals
        SET suggested_payload = '{"suggestion":"none"}'
        WHERE proposal_kind = 'status'
          AND suggested_payload IS NULL
      `);
    }
  }

  // Final step: ensure all indexes exist regardless of migration history.
  if (hasProposalsTable) {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_session_kind ON proposals(import_session_id, steam_app_id, proposal_kind)',
    );
  }
}

/**
 * Open (or return the existing) database connection.
 * Creates tables and runs migrations on first connection.
 * Throws if called with a different path than the first open.
 */
export function openDatabase(dbPath: string): Database.Database {
  if (_db) {
    if (_activePath !== dbPath) {
      throw new Error(
        `Database already open at "${_activePath}". Cannot open "${dbPath}". ` +
          'Close the existing connection first with closeDatabase().',
      );
    }
    return _db;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(getCreateTableSQL());
  runMigrations(db);

  _db = db;
  _activePath = dbPath;
  return db;
}

/**
 * Close the database connection and reset the singleton.
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    _activePath = null;
  }
}

/**
 * Get the current database instance, or throw if not opened.
 */
export function getDatabase(): Database.Database {
  if (!_db) {
    throw new Error('Database not opened. Call openDatabase() first.');
  }
  return _db;
}
