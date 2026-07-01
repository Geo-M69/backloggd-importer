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

/** Seed a game and an exact match row. */
function seedExactGame(db: Database.Database, appId: number, title: string, playtimeMinutes = 100) {
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
    appId,
    title,
    playtimeMinutes,
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

/** Seed a game and an ambiguous match row. */
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

/** Seed a game and an unmatched match row. */
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

/** Seed a stale (inactive) game with an exact match. */
function seedStaleGame(db: Database.Database, appId: number, title: string) {
  db.prepare('INSERT INTO games (app_id, title, playtime_minutes, stale) VALUES (?, ?, ?, ?)').run(
    appId,
    title,
    100,
    1,
  );
  db.prepare(
    'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(appId, 30000 + appId, `${title} (IGDB)`, title.toLowerCase(), 'exact', 'steam-appid');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proposal generator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFreshDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('exact matches', () => {
    it('creates pending ownership proposals eligible for bulk approval', () => {
      seedExactGame(db, 730, 'Counter-Strike 2');

      const result = generateProposals(db);

      expect(result.ownershipProposals).toBe(1);
      expect(result.statusProposals).toBe(0);
      expect(result.playlogProposals).toBe(0);
      expect(result.requiresReview).toBe(0);

      // Verify the proposal in DB
      const proposal = db
        .prepare('SELECT * FROM proposals WHERE steam_app_id = ?')
        .get(730) as Record<string, unknown>;

      expect(proposal.proposal_kind).toBe('ownership');
      expect(proposal.status).toBe('pending');
      expect(proposal.match_confidence).toBe('exact');
      expect(proposal.requires_manual_review).toBe(0);
      expect(proposal.igdb_id).toBe(10730);
      expect(proposal.backloggd_slug).toBe('counter-strike-2');
      expect(proposal.suggested_payload).toBeTruthy();

      // Verify payload content
      const payload = JSON.parse(proposal.suggested_payload as string);
      expect(payload).toEqual({ platform: 'steam', ownershipType: 'digital' });
    });

    it('sets requires_manual_review = 0 for exact matches', () => {
      seedExactGame(db, 730, 'CS2');
      // Generate proposals first
      generateProposals(db);

      const rows = db
        .prepare(
          `SELECT requires_manual_review FROM proposals
           WHERE import_session_id = (
             SELECT id FROM import_sessions ORDER BY started_at DESC LIMIT 1
           )
           AND proposal_kind = 'ownership'`,
        )
        .all() as { requires_manual_review: number }[];

      expect(rows).toHaveLength(1);
      expect(rows[0].requires_manual_review).toBe(0);
    });
  });

  describe('ambiguous and unmatched matches', () => {
    it('requires manual review for ambiguous matches', () => {
      seedAmbiguousGame(db, 440, 'Team Fortress 2');

      const result = generateProposals(db);

      expect(result.ownershipProposals).toBe(1);
      expect(result.requiresReview).toBe(1);

      const proposal = db
        .prepare('SELECT * FROM proposals WHERE steam_app_id = ?')
        .get(440) as Record<string, unknown>;

      expect(proposal.match_confidence).toBe('ambiguous');
      expect(proposal.requires_manual_review).toBe(1);
    });

    it('keeps unmatched games review-visible with blocked ownership proposals', () => {
      seedUnmatchedGame(db, 999999, 'Unknown App');

      const result = generateProposals(db);

      expect(result.ownershipProposals).toBe(1);
      expect(result.totalGames).toBe(1);

      const proposal = db
        .prepare('SELECT * FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(999999, 'ownership') as Record<string, unknown>;
      expect(proposal).toBeTruthy();
      expect(proposal.status).toBe('blocked');
      expect(proposal.requires_manual_review).toBe(1);

      const payload = JSON.parse(proposal.suggested_payload as string) as Record<string, unknown>;
      expect(payload.reason).toBe('unmatched');
    });
  });

  describe('stale games', () => {
    it('does not create proposals for stale games', () => {
      seedStaleGame(db, 1, 'Stale Game');
      seedExactGame(db, 730, 'Active Game');

      const result = generateProposals(db);

      expect(result.totalGames).toBe(1); // only active
      expect(result.ownershipProposals).toBe(1);

      const proposals = db.prepare('SELECT DISTINCT steam_app_id FROM proposals').all() as {
        steam_app_id: number;
      }[];

      expect(proposals).toHaveLength(1);
      expect(proposals[0].steam_app_id).toBe(730);
    });
  });

  describe('idempotency', () => {
    it('does not create duplicate proposals across reruns', () => {
      seedExactGame(db, 730, 'CS2');
      seedExactGame(db, 440, 'TF2');

      const first = generateProposals(db);
      expect(first.ownershipProposals).toBe(2);

      const second = generateProposals(db);
      expect(second.ownershipProposals).toBe(2); // same count, no duplicates

      // Each game should still have exactly one ownership proposal
      const count = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM proposals
           WHERE proposal_kind = 'ownership'`,
        )
        .get() as { cnt: number };
      expect(count.cnt).toBe(2); // still 2, not 4
    });

    it('preserves approved proposals on regeneration', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      db.prepare("UPDATE proposals SET status = 'approved' WHERE steam_app_id = ?").run(730);
      generateProposals(db);

      const proposal = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ?')
        .get(730) as { status: string };
      expect(proposal.status).toBe('approved');
    });

    it('preserves skipped proposals on regeneration', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      db.prepare("UPDATE proposals SET status = 'skipped' WHERE steam_app_id = ?").run(730);
      generateProposals(db);

      const proposal = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ?')
        .get(730) as { status: string };
      expect(proposal.status).toBe('skipped');
    });

    it('preserves deferred and blocked proposals on regeneration', () => {
      seedExactGame(db, 730, 'CS2');
      seedUnmatchedGame(db, 999999, 'Unknown App');

      generateProposals(db);
      db.prepare("UPDATE proposals SET status = 'deferred' WHERE steam_app_id = ?").run(730);
      generateProposals(db);

      const deferred = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(730, 'ownership') as { status: string };
      const blocked = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(999999, 'ownership') as { status: string };

      expect(deferred.status).toBe('deferred');
      expect(blocked.status).toBe('blocked');
    });
  });

  describe('approved-proposal immutability on drift', () => {
    it('preserves approved status when regeneration has no drift', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const before = db
        .prepare(
          'SELECT igdb_id, igdb_name, backloggd_slug, match_confidence, requires_manual_review, suggested_payload FROM proposals WHERE steam_app_id = ?',
        )
        .get(730) as Record<string, unknown>;

      generateProposals(db);

      const after = db
        .prepare(
          'SELECT status, igdb_id, igdb_name, backloggd_slug, match_confidence, requires_manual_review, suggested_payload FROM proposals WHERE steam_app_id = ?',
        )
        .get(730) as Record<string, unknown>;

      expect(after.status).toBe('approved');
      expect(after.igdb_id).toBe(before.igdb_id);
      expect(after.igdb_name).toBe(before.igdb_name);
      expect(after.backloggd_slug).toBe(before.backloggd_slug);
      expect(after.match_confidence).toBe(before.match_confidence);
      expect(after.requires_manual_review).toBe(before.requires_manual_review);
      expect(after.suggested_payload).toBe(before.suggested_payload);
    });

    it('demotes approved proposal when match confidence changes', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Change match confidence
      db.prepare("UPDATE matches SET confidence = 'ambiguous' WHERE steam_app_id = ?").run(730);

      generateProposals(db);

      const proposal = db
        .prepare(
          'SELECT status, match_confidence, decision_notes, requires_manual_review FROM proposals WHERE steam_app_id = ?',
        )
        .get(730) as Record<string, unknown>;

      expect(proposal.status).toBe('blocked');
      expect(proposal.match_confidence).toBe('ambiguous');
      expect(proposal.requires_manual_review).toBe(1);
      expect(proposal.decision_notes).toContain('previously approved');
    });

    it('demotes approved proposal when IGDB target changes', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Point to a different IGDB target
      db.prepare(
        "UPDATE matches SET igdb_id = 99999, igdb_name = 'CS2 (Other)', backloggd_slug = 'cs2-other' WHERE steam_app_id = ?",
      ).run(730);

      generateProposals(db);

      const proposal = db
        .prepare(
          'SELECT status, igdb_id, igdb_name, backloggd_slug, decision_notes FROM proposals WHERE steam_app_id = ?',
        )
        .get(730) as Record<string, unknown>;

      expect(proposal.status).toBe('blocked');
      expect(proposal.igdb_id).toBe(99999);
      expect(proposal.igdb_name).toBe('CS2 (Other)');
      expect(proposal.backloggd_slug).toBe('cs2-other');
      expect(proposal.decision_notes).toContain('previously approved');
    });

    it('demotes approved proposal when match becomes unmatched', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Wipe the match target
      db.prepare(
        "UPDATE matches SET igdb_id = NULL, igdb_name = NULL, backloggd_slug = NULL, confidence = 'unmatched' WHERE steam_app_id = ?",
      ).run(730);

      generateProposals(db);

      const proposal = db
        .prepare(
          'SELECT status, igdb_id, igdb_name, backloggd_slug, match_confidence, decision_notes FROM proposals WHERE steam_app_id = ?',
        )
        .get(730) as Record<string, unknown>;

      expect(proposal.status).toBe('blocked');
      expect(proposal.igdb_id).toBeNull();
      expect(proposal.backloggd_slug).toBeNull();
      expect(proposal.match_confidence).toBe('unmatched');
      expect(proposal.decision_notes).toContain('previously approved');
    });

    it('demotes approved proposal when suggested_payload changes', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Regenerate with a different policy that changes the payload
      // For ownership we can't easily change the payload without changing match data,
      // so directly mutate the suggested payload to simulate drift:
      db.prepare(
        'UPDATE proposals SET suggested_payload = \'{"platform":"steam","ownershipType":"physical"}\' WHERE steam_app_id = ?',
      ).run(730);

      generateProposals(db);

      const proposal = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ?')
        .get(730) as { status: string };
      expect(proposal.status).toBe('blocked');
    });

    it('pending proposals still update generated fields normally', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);

      // Update match data
      db.prepare(
        "UPDATE matches SET igdb_name = 'Counter-Strike 2 (Updated)' WHERE steam_app_id = ?",
      ).run(730);

      generateProposals(db);

      const proposal = db
        .prepare('SELECT status, igdb_name FROM proposals WHERE steam_app_id = ?')
        .get(730) as Record<string, unknown>;

      // Pending → still pending, and fields updated
      expect(proposal.status).toBe('pending');
      expect(proposal.igdb_name).toBe('Counter-Strike 2 (Updated)');
    });

    it('demotes approved proposal when Steam title changes', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Check steam_title was captured
      const before = db
        .prepare('SELECT steam_title FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(730, 'ownership') as { steam_title: string };

      expect(before.steam_title).toBe('CS2');

      // Change the game title in games table
      db.prepare("UPDATE games SET title = 'Counter-Strike 2' WHERE app_id = ?").run(730);

      generateProposals(db);

      const after = db
        .prepare(
          'SELECT status, steam_title, decision_notes FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?',
        )
        .get(730, 'ownership') as Record<string, unknown>;

      expect(after.status).toBe('blocked');
      expect(after.steam_title).toBe('Counter-Strike 2');
      expect(after.decision_notes).toContain('drift');
    });

    it('is NULL-safe: null to empty string triggers drift', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Set igdb_name to empty string (was non-null)
      db.prepare("UPDATE matches SET igdb_name = '' WHERE steam_app_id = ?").run(730);

      generateProposals(db);

      const proposal = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(730, 'ownership') as { status: string };
      expect(proposal.status).toBe('blocked');
    });

    it('is NULL-safe: empty string to null triggers drift', () => {
      seedExactGame(db, 730, 'CS2');

      // Set igdb_name to empty first, then approve
      db.prepare("UPDATE matches SET igdb_name = '' WHERE steam_app_id = ?").run(730);
      generateProposals(db);
      approveExactMatches(undefined, db);

      // Null it
      db.prepare('UPDATE matches SET igdb_name = NULL WHERE steam_app_id = ?').run(730);

      generateProposals(db);

      const proposal = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(730, 'ownership') as { status: string };
      expect(proposal.status).toBe('blocked');
    });

    it('is NULL-safe: null to null does not trigger drift', () => {
      seedUnmatchedGame(db, 999999, 'Unknown');
      generateProposals(db);

      const before = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(999999, 'ownership') as { status: string };
      expect(before.status).toBe('blocked'); // unmatched → blocked

      // The igdb_id stays null; regeneration with same null should keep blocked
      generateProposals(db);

      const after = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(999999, 'ownership') as { status: string };
      // Blocked preserves blocked (not a drift test per se, just confirming NULL=NULL is safe)
      expect(after.status).toBe('blocked');
    });

    it('demotes approved status proposal when target becomes unmatched', () => {
      seedExactGame(db, 730, 'CS2');

      // Create with status policy
      generateProposals(db, {
        policy: { playtimeThresholdMinutes: 60, suggestBacklogWhenZeroPlaytime: false },
      });

      // Manually approve both ownership and status
      db.prepare(
        "UPDATE proposals SET status = 'approved' WHERE steam_app_id = ? AND proposal_kind IN ('ownership', 'status')",
      ).run(730);

      // Make target unmatched
      db.prepare(
        "UPDATE matches SET igdb_id = NULL, igdb_name = NULL, backloggd_slug = NULL, confidence = 'unmatched' WHERE steam_app_id = ?",
      ).run(730);

      generateProposals(db, {
        policy: { playtimeThresholdMinutes: 60, suggestBacklogWhenZeroPlaytime: false },
      });

      const statusProposal = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(730, 'status') as { status: string };
      expect(statusProposal.status).toBe('blocked');

      const ownershipProposal = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(730, 'ownership') as { status: string };
      expect(ownershipProposal.status).toBe('blocked');
    });

    it('demotes approved playlog proposal when target becomes unmatched', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db, { policy: { enablePlaylogSuggestion: true } });

      db.prepare(
        "UPDATE proposals SET status = 'approved' WHERE steam_app_id = ? AND proposal_kind IN ('ownership', 'playlog')",
      ).run(730);

      db.prepare(
        "UPDATE matches SET igdb_id = NULL, igdb_name = NULL, backloggd_slug = NULL, confidence = 'unmatched' WHERE steam_app_id = ?",
      ).run(730);

      generateProposals(db, { policy: { enablePlaylogSuggestion: true } });

      const playlogProposal = db
        .prepare('SELECT status FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(730, 'playlog') as { status: string };
      expect(playlogProposal.status).toBe('blocked');
    });

    it('preserves user-authored decision_notes during drift', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Add user-authored decision notes
      db.prepare(
        "UPDATE proposals SET decision_notes = 'User verified this match manually' WHERE steam_app_id = ?",
      ).run(730);

      // Drift the target
      db.prepare(
        "UPDATE matches SET igdb_id = 99999, igdb_name = 'CS2 (Other)', backloggd_slug = 'cs2-other' WHERE steam_app_id = ?",
      ).run(730);

      generateProposals(db);

      const proposal = db
        .prepare(
          'SELECT status, decision_notes FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?',
        )
        .get(730, 'ownership') as { status: string; decision_notes: string };

      expect(proposal.status).toBe('blocked');
      expect(proposal.decision_notes).toContain('User verified this match manually');
      expect(proposal.decision_notes).toContain('drift');
    });

    it('does not duplicate drift message across repeated regenerations', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Drift
      db.prepare("UPDATE matches SET confidence = 'ambiguous' WHERE steam_app_id = ?").run(730);

      generateProposals(db); // first drift → blocked

      const firstDrift = db
        .prepare('SELECT decision_notes FROM proposals WHERE steam_app_id = ?')
        .get(730) as { decision_notes: string };
      const firstCount = (firstDrift.decision_notes.match(/drift/g) || []).length;
      expect(firstCount).toBe(1);

      generateProposals(db); // second regeneration (still blocked, no reinport)

      const secondDrift = db
        .prepare('SELECT decision_notes FROM proposals WHERE steam_app_id = ?')
        .get(730) as { decision_notes: string };
      const secondCount = (secondDrift.decision_notes.match(/drift/g) || []).length;
      // The drift message from the first regeneration is the existing decision_notes.
      // Since the proposal is now blocked (not approved), the drift clause doesn't trigger again.
      // The decision_notes preservation clause fires, preserving the existing content.
      expect(secondCount).toBeLessThanOrEqual(1);
    });
  });

  describe('proposal kinds remain separate', () => {
    it('only creates ownership proposals by default', () => {
      seedExactGame(db, 730, 'CS2', 500);

      const result = generateProposals(db);

      expect(result.ownershipProposals).toBe(1);
      expect(result.statusProposals).toBe(0);
      expect(result.playlogProposals).toBe(0);
    });

    it('creates status proposals when policy is provided', () => {
      seedExactGame(db, 730, 'CS2', 500);

      const result = generateProposals(db, {
        policy: { playtimeThresholdMinutes: 120, suggestBacklogWhenZeroPlaytime: false },
      });

      expect(result.ownershipProposals).toBe(1);
      expect(result.statusProposals).toBe(1);
      expect(result.playlogProposals).toBe(0);
    });

    it('creates playlog proposals when policy enables them', () => {
      seedExactGame(db, 730, 'CS2', 500);

      const result = generateProposals(db, {
        policy: { enablePlaylogSuggestion: true },
      });

      expect(result.ownershipProposals).toBe(1);
      expect(result.statusProposals).toBe(0);
      expect(result.playlogProposals).toBe(1);
    });

    it('creates all three kinds when fully configured', () => {
      seedExactGame(db, 730, 'CS2', 500);

      const result = generateProposals(db, {
        policy: {
          playtimeThresholdMinutes: 120,
          suggestBacklogWhenZeroPlaytime: false,
          enablePlaylogSuggestion: true,
        },
      });

      expect(result.ownershipProposals).toBe(1);
      expect(result.statusProposals).toBe(1);
      expect(result.playlogProposals).toBe(1);
    });
  });

  describe('session handling', () => {
    it('creates a new session when none exists', () => {
      seedExactGame(db, 730, 'CS2');

      const result = generateProposals(db);

      expect(result.sessionId).toBeTruthy();

      const sessionCount = db.prepare('SELECT COUNT(*) AS cnt FROM import_sessions').get() as {
        cnt: number;
      };
      expect(sessionCount.cnt).toBe(1);
    });

    it('reuses an existing in-progress session', () => {
      seedExactGame(db, 730, 'CS2');

      // First generation creates a session
      const first = generateProposals(db);

      // Second generation reuses it
      const second = generateProposals(db);

      expect(second.sessionId).toBe(first.sessionId);

      const sessionCount = db.prepare('SELECT COUNT(*) AS cnt FROM import_sessions').get() as {
        cnt: number;
      };
      expect(sessionCount.cnt).toBe(1); // still one session
    });

    it('updates session counters after generation', () => {
      seedExactGame(db, 730, 'CS2');
      seedAmbiguousGame(db, 440, 'TF2');

      generateProposals(db);

      const session = db
        .prepare('SELECT * FROM import_sessions ORDER BY started_at DESC LIMIT 1')
        .get() as Record<string, unknown>;

      expect(session.total_games).toBe(2);
      expect(session.matched_games).toBe(2);
      expect(session.proposed_changes).toBe(2); // 2 ownership proposals
      expect(session.policy_json).toBeTruthy();
    });
  });
});
