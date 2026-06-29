/**
 * SQLite schema definitions for the importer's local database.
 */

/**
 * Get the full DDL string to create all tables.
 */
export function getCreateTableSQL(): string {
  return `
    CREATE TABLE IF NOT EXISTS games (
      app_id              INTEGER PRIMARY KEY,
      title               TEXT    NOT NULL,
      icon_url            TEXT,
      playtime_minutes    INTEGER NOT NULL DEFAULT 0 CHECK (typeof(playtime_minutes) = 'integer' AND playtime_minutes >= 0),
      last_played_at      TEXT,
      is_free             INTEGER NOT NULL DEFAULT 0 CHECK (typeof(is_free) = 'integer' AND is_free IN (0, 1)),
      has_details         INTEGER NOT NULL DEFAULT 1 CHECK (typeof(has_details) = 'integer' AND has_details IN (0, 1)),
      created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS matches (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      steam_app_id        INTEGER NOT NULL UNIQUE,
      igdb_id             INTEGER,
      igdb_name           TEXT,
      backloggd_slug      TEXT,
      confidence          TEXT    NOT NULL DEFAULT 'unmatched' CHECK (confidence IN ('exact', 'probable', 'ambiguous', 'unmatched')),
      match_method        TEXT    CHECK (match_method IS NULL OR match_method IN ('steam-appid', 'title-fuzzy', 'title-year', 'manual')),
      matched_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (steam_app_id) REFERENCES games(app_id)
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id                  TEXT    PRIMARY KEY,
      import_session_id   TEXT    NOT NULL,
      steam_app_id        INTEGER NOT NULL,
      igdb_id             INTEGER NOT NULL,
      backloggd_slug      TEXT    NOT NULL,
      action              TEXT    NOT NULL CHECK (action IN ('add-ownership', 'update-status', 'add-to-backlog', 'mark-played')),
      status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'skipped', 'applied', 'failed')),
      match_confidence    TEXT    NOT NULL CHECK (match_confidence IN ('exact', 'probable', 'ambiguous', 'unmatched')),
      notes               TEXT,
      created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (steam_app_id) REFERENCES games(app_id),
      FOREIGN KEY (import_session_id) REFERENCES import_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS import_sessions (
      id                  TEXT    PRIMARY KEY,
      started_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at        TEXT,
      status              TEXT    NOT NULL DEFAULT 'in-progress' CHECK (status IN ('in-progress', 'paused', 'completed', 'aborted')),
      total_games         INTEGER NOT NULL DEFAULT 0 CHECK (typeof(total_games) = 'integer' AND total_games >= 0),
      matched_games       INTEGER NOT NULL DEFAULT 0 CHECK (typeof(matched_games) = 'integer' AND matched_games >= 0),
      proposed_changes    INTEGER NOT NULL DEFAULT 0 CHECK (typeof(proposed_changes) = 'integer' AND proposed_changes >= 0),
      approved_changes    INTEGER NOT NULL DEFAULT 0 CHECK (typeof(approved_changes) = 'integer' AND approved_changes >= 0),
      applied_changes     INTEGER NOT NULL DEFAULT 0 CHECK (typeof(applied_changes) = 'integer' AND applied_changes >= 0),
      skipped_games       INTEGER NOT NULL DEFAULT 0 CHECK (typeof(skipped_games) = 'integer' AND skipped_games >= 0),
      failed_games        INTEGER NOT NULL DEFAULT 0 CHECK (typeof(failed_games) = 'integer' AND failed_games >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_igdb_id ON matches(igdb_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
  `;
}
