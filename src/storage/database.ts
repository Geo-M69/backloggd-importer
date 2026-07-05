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

  // -----------------------------------------------------------------------
  // Migration 5: Create / repair import_items table (Phase 5A)
  //
  // Phase 5A audit-fix: any partial import_items table is rebuilt into the
  // canonical schema. Valid legacy rows are copied/backfilled; uncopyable rows
  // are quarantined outside the live queue.
  // -----------------------------------------------------------------------
  const REQUIRED_ITEM_COLS = [
    'proposal_id',
    'import_session_id',
    'steam_app_id',
    'proposal_kind',
    'frozen_payload',
    'status',
    'attempt_count',
    'outcome_reason',
    'last_error',
    'last_attempt_at',
    'verified_at',
    'created_at',
    'updated_at',
  ];

  const createCanonicalImportItems = (): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS import_items (
        proposal_id         TEXT    NOT NULL PRIMARY KEY,
        import_session_id   TEXT    NOT NULL,
        steam_app_id        INTEGER NOT NULL,
        proposal_kind       TEXT    NOT NULL CHECK (proposal_kind IN ('ownership', 'status', 'playlog')),
        frozen_payload      TEXT,
        status              TEXT    NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'importing', 'saved', 'skipped', 'failed')),
        attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
        outcome_reason      TEXT,
        last_error          TEXT,
        last_attempt_at     TEXT,
        verified_at         TEXT,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (proposal_id) REFERENCES proposals(id),
        FOREIGN KEY (import_session_id) REFERENCES import_sessions(id),
        FOREIGN KEY (steam_app_id) REFERENCES games(app_id)
      );
    `);
  };

  const hasImportItems = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='import_items'")
    .get();

  const isImportItemsCanonical = (): boolean => {
    const createSqlRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='import_items'")
      .get() as { sql: string } | undefined;
    if (!createSqlRow?.sql) return false;

    const itemCols = (db.pragma('table_info(import_items)') as { name: string }[]).map(
      (col) => col.name,
    );
    const existingCols = new Set(itemCols);
    if (REQUIRED_ITEM_COLS.some((c) => !existingCols.has(c))) return false;

    const tableInfo = db.pragma('table_info(import_items)') as {
      name: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }[];
    const byName = new Map(tableInfo.map((col) => [col.name, col]));
    if (byName.get('proposal_id')?.pk !== 1) return false;
    for (const col of [
      'proposal_id',
      'import_session_id',
      'steam_app_id',
      'proposal_kind',
      'status',
      'attempt_count',
      'created_at',
      'updated_at',
    ]) {
      if (byName.get(col)?.notnull !== 1) return false;
    }

    const fkRows = db.pragma('foreign_key_list(import_items)') as {
      from: string;
      table: string;
      to: string;
    }[];
    const hasFk = (from: string, table: string, to: string) =>
      fkRows.some((fk) => fk.from === from && fk.table === table && fk.to === to);
    if (!hasFk('proposal_id', 'proposals', 'id')) return false;
    if (!hasFk('import_session_id', 'import_sessions', 'id')) return false;
    if (!hasFk('steam_app_id', 'games', 'app_id')) return false;

    const normalizedSql = createSqlRow.sql.replace(/\s+/g, ' ').toLowerCase();
    return (
      normalizedSql.includes("proposal_kind in ('ownership', 'status', 'playlog')") &&
      normalizedSql.includes("status in ('approved', 'importing', 'saved', 'skipped', 'failed')") &&
      normalizedSql.includes('typeof(attempt_count) =') &&
      normalizedSql.includes('attempt_count >= 0') &&
      normalizedSql.includes("default 'approved'") &&
      normalizedSql.includes('default 0')
    );
  };

  const legacyValue = (legacyCols: Set<string>, col: string, fallback: string): string =>
    legacyCols.has(col) ? `l.${col}` : fallback;

  const legacyTextValue = (legacyCols: Set<string>, col: string): string =>
    legacyValue(legacyCols, col, 'NULL');

  const rebuildImportItemsFromLegacy = db.transaction(() => {
    const legacyTable = 'import_items_legacy_migration';
    db.exec(`DROP TABLE IF EXISTS ${legacyTable}`);
    db.exec(`ALTER TABLE import_items RENAME TO ${legacyTable}`);
    createCanonicalImportItems();

    const legacyRowCount = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM ${legacyTable}`).get() as { cnt: number }
    ).cnt;
    if (legacyRowCount === 0) {
      db.exec(`DROP TABLE ${legacyTable}`);
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS import_items_legacy_unbackfillable (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        legacy_proposal_id        TEXT,
        legacy_import_session_id  TEXT,
        legacy_status             TEXT,
        legacy_attempt_count      INTEGER,
        legacy_outcome_reason     TEXT,
        legacy_last_error         TEXT,
        legacy_last_attempt_at    TEXT,
        legacy_verified_at        TEXT,
        legacy_created_at         TEXT,
        legacy_updated_at         TEXT,
        reason                    TEXT NOT NULL,
        quarantined_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `);

    const legacyCols = new Set(
      (db.pragma(`table_info(${legacyTable})`) as { name: string }[]).map((col) => col.name),
    );
    const sessionExpr = 'p.import_session_id';
    const rawStatusExpr = legacyValue(legacyCols, 'status', "'approved'");
    const normalizedStatusExpr = `
      CASE
        WHEN ${rawStatusExpr} IN ('approved', 'importing', 'saved', 'skipped', 'failed')
          THEN ${rawStatusExpr}
        ELSE 'failed'
      END
    `;
    const outcomeExpr = `
      CASE
        WHEN ${rawStatusExpr} IN ('approved', 'importing', 'saved', 'skipped', 'failed')
          THEN ${legacyTextValue(legacyCols, 'outcome_reason')}
        ELSE COALESCE(
          CASE
            WHEN ${legacyTextValue(legacyCols, 'outcome_reason')} IS NULL
              OR ${legacyTextValue(legacyCols, 'outcome_reason')} = ''
              THEN NULL
            ELSE ${legacyTextValue(legacyCols, 'outcome_reason')} || '; '
          END,
          ''
        ) || 'legacy-invalid-status'
      END
    `;
    const attemptExpr = legacyCols.has('attempt_count')
      ? "CASE WHEN typeof(l.attempt_count) = 'integer' AND l.attempt_count >= 0 THEN l.attempt_count ELSE 0 END"
      : '0';
    const createdAtExpr = legacyCols.has('created_at')
      ? "COALESCE(NULLIF(l.created_at, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
      : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    const updatedAtExpr = legacyCols.has('updated_at')
      ? "COALESCE(NULLIF(l.updated_at, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
      : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

    db.exec(`
      INSERT INTO import_items_legacy_unbackfillable (
        legacy_proposal_id, legacy_import_session_id, legacy_status,
        legacy_attempt_count, legacy_outcome_reason, legacy_last_error,
        legacy_last_attempt_at, legacy_verified_at, legacy_created_at,
        legacy_updated_at, reason
      )
      SELECT
        l.proposal_id,
        ${legacyTextValue(legacyCols, 'import_session_id')},
        ${legacyTextValue(legacyCols, 'status')},
        ${legacyValue(legacyCols, 'attempt_count', 'NULL')},
        ${legacyTextValue(legacyCols, 'outcome_reason')},
        ${legacyTextValue(legacyCols, 'last_error')},
        ${legacyTextValue(legacyCols, 'last_attempt_at')},
        ${legacyTextValue(legacyCols, 'verified_at')},
        ${legacyTextValue(legacyCols, 'created_at')},
        ${legacyTextValue(legacyCols, 'updated_at')},
        CASE
          WHEN p.id IS NULL THEN 'missing-proposal'
          WHEN s.id IS NULL THEN 'missing-session'
          WHEN g.app_id IS NULL THEN 'missing-game'
          WHEN p.proposal_kind NOT IN ('ownership', 'status', 'playlog') THEN 'invalid-proposal-kind'
          ELSE 'unknown'
        END
      FROM ${legacyTable} l
      LEFT JOIN proposals p ON p.id = l.proposal_id
      LEFT JOIN import_sessions s ON s.id = ${sessionExpr}
      LEFT JOIN games g ON g.app_id = p.steam_app_id
      WHERE p.id IS NULL
         OR s.id IS NULL
         OR g.app_id IS NULL
         OR p.proposal_kind NOT IN ('ownership', 'status', 'playlog')
    `);

    db.exec(`
      INSERT INTO import_items (
        proposal_id, import_session_id, steam_app_id, proposal_kind,
        frozen_payload, status, attempt_count, outcome_reason, last_error,
        last_attempt_at, verified_at, created_at, updated_at
      )
      SELECT
        l.proposal_id,
        ${sessionExpr},
        p.steam_app_id,
        p.proposal_kind,
        p.suggested_payload,
        ${normalizedStatusExpr},
        ${attemptExpr},
        ${outcomeExpr},
        ${legacyTextValue(legacyCols, 'last_error')},
        ${legacyTextValue(legacyCols, 'last_attempt_at')},
        ${legacyTextValue(legacyCols, 'verified_at')},
        ${createdAtExpr},
        ${updatedAtExpr}
      FROM ${legacyTable} l
      JOIN proposals p ON p.id = l.proposal_id
      JOIN import_sessions s ON s.id = ${sessionExpr}
      JOIN games g ON g.app_id = p.steam_app_id
      WHERE p.proposal_kind IN ('ownership', 'status', 'playlog')
    `);

    db.exec(`DROP TABLE ${legacyTable}`);
  });

  if (!hasImportItems) {
    createCanonicalImportItems();
  } else if (!isImportItemsCanonical()) {
    rebuildImportItemsFromLegacy();
  }

  const hasCanonicalImportItems = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='import_items'")
    .get();

  // Migration 6: add pause_reason column to import_sessions (Phase 5A)
  if (hasImportSessions) {
    const sessionCols2 = (db.pragma('table_info(import_sessions)') as { name: string }[]).map(
      (col) => col.name,
    );
    if (!sessionCols2.includes('pause_reason')) {
      db.exec('ALTER TABLE import_sessions ADD COLUMN pause_reason TEXT');
    }
  }

  // Final step: ensure all indexes exist regardless of migration history.
  if (hasProposalsTable) {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_session_kind ON proposals(import_session_id, steam_app_id, proposal_kind)',
    );
  }

  // Ensure import_items indexes exist.
  if (hasCanonicalImportItems) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_import_items_session_status ON import_items(import_session_id, status)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_import_items_session_app ON import_items(import_session_id, steam_app_id)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_import_items_status ON import_items(status)');
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
