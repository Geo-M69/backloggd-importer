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
      stale               INTEGER NOT NULL DEFAULT 0 CHECK (typeof(stale) = 'integer' AND stale IN (0, 1)),
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

    CREATE INDEX IF NOT EXISTS idx_proposals_steam_app_id ON proposals(steam_app_id);

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
      failed_games        INTEGER NOT NULL DEFAULT 0 CHECK (typeof(failed_games) = 'integer' AND failed_games >= 0),
      policy_json         TEXT
    );

    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key           TEXT    PRIMARY KEY,
      response_body       TEXT    NOT NULL,
      fetched_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at          TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_matches_igdb_id ON matches(igdb_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(import_session_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_proposals_confidence ON proposals(match_confidence);

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

    CREATE INDEX IF NOT EXISTS idx_import_items_session_status ON import_items(import_session_id, status);
    CREATE INDEX IF NOT EXISTS idx_import_items_session_app ON import_items(import_session_id, steam_app_id);
    CREATE INDEX IF NOT EXISTS idx_import_items_status ON import_items(status);
  `;
}
