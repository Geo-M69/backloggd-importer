import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { generateProposals } from '../../src/review/generator.js';
import { approveExactMatches } from '../../src/review/approver.js';

function createFreshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(getCreateTableSQL());
  runMigrations(db);
  return db;
}

function seedExactGame(db: Database.Database, appId: number, title: string) {
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
    appId,
    title,
    100,
  );
  db.prepare(
    'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    appId,
    10000 + appId,
    `${title} (IGDB)`,
    `${title.toLowerCase().replace(/\s+/g, '-')}`,
    'exact',
    'steam-appid',
  );
}

function seedAmbiguousGame(db: Database.Database, appId: number, title: string) {
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
    appId,
    title,
    50,
  );
  db.prepare(
    'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    appId,
    20000 + appId,
    `${title} (IGDB)`,
    `${title.toLowerCase().replace(/\s+/g, '-')}`,
    'ambiguous',
    'steam-appid',
  );
}

function seedProbableGame(db: Database.Database, appId: number, title: string) {
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
    appId,
    title,
    25,
  );
  db.prepare(
    'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    appId,
    30000 + appId,
    `${title} (IGDB)`,
    `${title.toLowerCase().replace(/\s+/g, '-')}`,
    'probable',
    'title-fuzzy',
  );
}

function seedUnmatchedGame(db: Database.Database, appId: number, title: string) {
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
    appId,
    title,
    0,
  );
  db.prepare(
    'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(appId, null, null, null, 'unmatched', null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approver', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFreshDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('approveExactMatches', () => {
    it('approves only exact-match ownership proposals', () => {
      seedExactGame(db, 730, 'CS2');
      seedExactGame(db, 440, 'TF2');

      generateProposals(db);
      const result = approveExactMatches(undefined, db);

      expect(result.approved).toBe(2);

      // Verify all ownership proposals are approved
      const approved = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM proposals
           WHERE proposal_kind = 'ownership' AND status = 'approved'`,
        )
        .get() as { cnt: number };
      expect(approved.cnt).toBe(2);
    });

    it('does not approve ambiguous matches', () => {
      seedExactGame(db, 730, 'CS2');
      seedAmbiguousGame(db, 440, 'TF2');

      generateProposals(db);
      const result = approveExactMatches(undefined, db);

      expect(result.approved).toBe(1); // only exact

      // Verify ambiguous is still pending
      const ambiguousProposal = db
        .prepare(
          `SELECT status FROM proposals p
           JOIN matches m ON m.steam_app_id = p.steam_app_id
           WHERE p.steam_app_id = 440`,
        )
        .get() as { status: string };
      expect(ambiguousProposal.status).toBe('pending');
    });

    it('does not approve unmatched games', () => {
      seedExactGame(db, 730, 'CS2');
      seedUnmatchedGame(db, 999999, 'Unknown');

      generateProposals(db);
      const result = approveExactMatches(undefined, db);

      expect(result.approved).toBe(1); // only CS2

      const unmatched = db
        .prepare(
          `SELECT status, requires_manual_review FROM proposals
           WHERE steam_app_id = ? AND proposal_kind = 'ownership'`,
        )
        .get(999999) as { status: string; requires_manual_review: number };
      expect(unmatched.status).toBe('blocked');
      expect(unmatched.requires_manual_review).toBe(1);
    });

    it('keeps ambiguous/probable proposals review-visible and not bulk-approved', () => {
      seedExactGame(db, 730, 'CS2');
      seedAmbiguousGame(db, 440, 'TF2');
      seedProbableGame(db, 570, 'Dota 2');

      generateProposals(db);
      const result = approveExactMatches(undefined, db);

      expect(result.approved).toBe(1);

      const ambiguous = db
        .prepare(
          `SELECT status, requires_manual_review FROM proposals
           WHERE steam_app_id = ? AND proposal_kind = 'ownership'`,
        )
        .get(440) as { status: string; requires_manual_review: number };
      const probable = db
        .prepare(
          `SELECT status, requires_manual_review FROM proposals
           WHERE steam_app_id = ? AND proposal_kind = 'ownership'`,
        )
        .get(570) as { status: string; requires_manual_review: number };

      expect(ambiguous.status).toBe('pending');
      expect(ambiguous.requires_manual_review).toBe(1);
      expect(probable.status).toBe('pending');
      expect(probable.requires_manual_review).toBe(1);
    });

    it('does not approve status or playlog proposals', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db, {
        policy: {
          playtimeThresholdMinutes: 60,
          enablePlaylogSuggestion: true,
        },
      });

      const result = approveExactMatches(undefined, db);

      // Only ownership approved
      expect(result.approved).toBe(1);

      // Status and playlog should still be pending
      const statusCount = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM proposals
           WHERE proposal_kind = 'status' AND status = 'pending'`,
        )
        .get() as { cnt: number };
      expect(statusCount.cnt).toBe(1);

      const playlogCount = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM proposals
           WHERE proposal_kind = 'playlog' AND status = 'pending'`,
        )
        .get() as { cnt: number };
      expect(playlogCount.cnt).toBe(1);
    });

    it('does not approve already-skipped proposals', () => {
      seedExactGame(db, 730, 'CS2');
      seedExactGame(db, 440, 'TF2');

      generateProposals(db);

      // Manually skip one
      db.prepare("UPDATE proposals SET status = 'skipped' WHERE steam_app_id = ?").run(440);

      const result = approveExactMatches(undefined, db);

      // Only the non-skipped one
      expect(result.approved).toBe(1);
    });

    it('returns zero when no eligible proposals exist', () => {
      const result = approveExactMatches(undefined, db);
      expect(result.approved).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('updates session approved_changes counter', () => {
      seedExactGame(db, 730, 'CS2');
      seedExactGame(db, 440, 'TF2');

      generateProposals(db);

      const before = db
        .prepare('SELECT approved_changes FROM import_sessions ORDER BY started_at DESC LIMIT 1')
        .get() as { approved_changes: number };
      expect(before.approved_changes).toBe(0);

      approveExactMatches(undefined, db);

      const after = db
        .prepare('SELECT approved_changes FROM import_sessions ORDER BY started_at DESC LIMIT 1')
        .get() as { approved_changes: number };
      expect(after.approved_changes).toBe(2);
    });
  });
});
