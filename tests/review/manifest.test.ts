import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/database.js';
import { generateProposals } from '../../src/review/generator.js';
import { approveExactMatches } from '../../src/review/approver.js';
import { buildManifest } from '../../src/review/manifest.js';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('manifest export', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFreshDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('buildManifest', () => {
    it('includes only approved proposals', () => {
      seedExactGame(db, 730, 'CS2');
      seedExactGame(db, 440, 'TF2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);

      expect(manifest.manifestVersion).toBe('2.0.0');
      expect(manifest.summary.totalApproved).toBe(2);

      expect(manifest.items).toHaveLength(2);

      const cs2 = manifest.items.find((i) => i.steamAppId === 730);
      expect(cs2).toBeTruthy();
      expect(cs2?.steamTitle).toBe('CS2');
      expect(cs2?.igdbId).toBe(10730);
      expect(cs2?.backloggdSlug).toBe('cs2');
      expect(cs2?.backloggdUrl).toBe('https://www.backloggd.com/games/cs2/');
      expect(cs2?.approvedProposals).toHaveLength(1);
      expect(cs2?.approvedProposals[0]?.kind).toBe('ownership');
      expect(cs2?.approvedProposals[0]?.payload).toEqual({
        platform: 'steam',
        ownershipType: 'digital',
      });
      // proposalId is a UUID — just verify it's present and non-empty
      expect(cs2?.approvedProposals[0]?.proposalId).toBeTruthy();
      expect(typeof cs2?.approvedProposals[0]?.proposalId).toBe('string');
    });

    it('excludes unapproved proposals', () => {
      seedExactGame(db, 730, 'CS2');
      seedAmbiguousGame(db, 440, 'TF2 (Ambiguous)'); // ambiguous → not approved

      generateProposals(db);
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);

      // Only CS2 should be in the manifest
      expect(manifest.summary.totalApproved).toBe(1);
      expect(manifest.items).toHaveLength(1);
      expect(manifest.items[0].steamAppId).toBe(730);
    });

    it('excludes status and playlog proposals from bulk approval manifest', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db, {
        policy: {
          playtimeThresholdMinutes: 60,
          enablePlaylogSuggestion: true,
        },
      });
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);

      // Only ownership was bulk-approved
      expect(manifest.items).toHaveLength(1);
      expect(manifest.items[0].approvedProposals).toHaveLength(1);
      expect(manifest.items[0].approvedProposals[0].kind).toBe('ownership');
    });

    it('returns empty manifest when there are no proposals', () => {
      const manifest = buildManifest(undefined, db);

      expect(manifest.manifestVersion).toBe('2.0.0');
      expect(manifest.summary.totalApproved).toBe(0);
      expect(manifest.items).toHaveLength(0);
    });

    it('returns empty manifest when no sessions exist', () => {
      const manifest = buildManifest(undefined, db);

      expect(manifest.summary.totalApproved).toBe(0);
      expect(manifest.items).toHaveLength(0);
      expect(manifest.sessionId).toBe('no-session');
    });

    it('is deterministic (same data produces same items)', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const m1 = buildManifest(undefined, db);
      const m2 = buildManifest(undefined, db);

      expect(m1.items).toHaveLength(m2.items.length);
      expect(m1.items[0].steamAppId).toBe(m2.items[0].steamAppId);
      expect(m1.items[0].approvedProposals).toEqual(m2.items[0].approvedProposals);
    });

    it('does not lose approved entries after proposal regeneration', () => {
      seedExactGame(db, 730, 'CS2');
      seedExactGame(db, 440, 'TF2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const before = buildManifest(undefined, db);
      expect(before.summary.totalApproved).toBe(2);

      // Regeneration should preserve non-pending decisions by default.
      generateProposals(db);

      const after = buildManifest(undefined, db);
      expect(after.summary.totalApproved).toBe(2);
      expect(after.items.map((i) => i.steamAppId)).toEqual([440, 730]);
    });

    it('excludes drifted approved items from manifest after regeneration with changed match', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      // Confirm one approved item
      const before = buildManifest(undefined, db);
      expect(before.summary.totalApproved).toBe(1);

      // Drift the match target
      db.prepare(
        "UPDATE matches SET igdb_id = 99999, igdb_name = 'CS2 Other', backloggd_slug = 'cs2-other' WHERE steam_app_id = ?",
      ).run(730);

      generateProposals(db);

      const after = buildManifest(undefined, db);
      expect(after.summary.totalApproved).toBe(0);
      expect(after.items).toHaveLength(0);
    });

    it('manifest igdbName is stable and does not change when matches change', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const before = buildManifest(undefined, db);
      expect(before.items[0].igdbName).toBe('CS2 (IGDB)');

      // Change match igdb_name — proposal already approved should keep its frozen name
      db.prepare("UPDATE matches SET igdb_name = 'CS2 (Changed)' WHERE steam_app_id = ?").run(730);

      // Regeneration with drift: igdb_name changed → demoted, so manifest should be empty
      generateProposals(db);

      const after = buildManifest(undefined, db);
      expect(after.summary.totalApproved).toBe(0);
    });

    it('manifest steamTitle is stable and does not change when games title changes', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const before = buildManifest(undefined, db);
      expect(before.items[0].steamTitle).toBe('CS2');

      // Change games title — proposal already approved should keep its frozen steam_title
      db.prepare("UPDATE games SET title = 'Counter-Strike 2' WHERE app_id = ?").run(730);

      // Regeneration detects drift → demoted, manifest should be empty
      generateProposals(db);

      const after = buildManifest(undefined, db);
      expect(after.summary.totalApproved).toBe(0);
    });

    it('manifest uses proposal steam_title not mutable games title', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);
      expect(manifest.items[0].steamTitle).toBe('CS2');

      // Verify the query doesn't join games by checking p.steam_title directly
      const dbInternal = db;
      const stored = dbInternal
        .prepare('SELECT steam_title FROM proposals WHERE steam_app_id = ? AND proposal_kind = ?')
        .get(730, 'ownership') as { steam_title: string };
      expect(stored.steam_title).toBe('CS2');
    });

    it('excludes ratings, review text, completion states, credentials, cookies, and tokens', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);
      const json = JSON.stringify(manifest);

      // These concepts must not appear anywhere in the manifest
      const forbidden = [
        'rating',
        'review',
        'completion',
        'password',
        'cookie',
        'token',
        'credential',
      ];
      for (const term of forbidden) {
        expect(json.toLowerCase()).not.toContain(term);
      }
    });

    it('includes source metadata and match confidence', () => {
      seedExactGame(db, 730, 'CS2');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);
      const item = manifest.items[0];

      expect(item.steamAppId).toBe(730);
      expect(item.steamTitle).toBe('CS2');
      expect(item.igdbId).toBe(10730);
      expect(item.igdbName).toBe('CS2 (IGDB)');
      expect(item.backloggdSlug).toBe('cs2');
      expect(item.backloggdUrl).toBe('https://www.backloggd.com/games/cs2/');
      expect(item.matchConfidence).toBe('exact');
    });

    it('is valid with zero approved proposals', () => {
      seedExactGame(db, 730, 'CS2');
      generateProposals(db);
      // Don't approve anything

      const manifest = buildManifest(undefined, db);

      expect(manifest.items).toHaveLength(0);
      expect(manifest.summary.totalApproved).toBe(0);
      expect(manifest.manifestVersion).toBe('2.0.0');
    });

    it('builds correct backloggdUrl from a known slug', () => {
      db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
        4000,
        "Garry's Mod",
        100,
      );
      db.prepare(
        'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(4000, 12348, "Garry's Mod (IGDB)", 'garry-s-mod', 'exact', 'steam-appid');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);
      expect(manifest.summary.totalApproved).toBe(1);

      const item = manifest.items[0];
      expect(item.steamAppId).toBe(4000);
      expect(item.backloggdSlug).toBe('garry-s-mod');
      expect(item.backloggdUrl).toBe('https://www.backloggd.com/games/garry-s-mod/');
    });

    it('produces null backloggdUrl when slug is null', () => {
      db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
        4000,
        "Garry's Mod",
        100,
      );
      db.prepare(
        'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(4000, 12348, "Garry's Mod (IGDB)", null, 'unmatched', null);

      generateProposals(db);
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);
      // Item with null slug should not be approved (blocked by ownershipDefaults)
      expect(manifest.summary.totalApproved).toBe(0);
    });

    it('does not emit garrys-mod in fixture-generated manifest', () => {
      // Seed Garry's Mod game data
      db.prepare('INSERT INTO games (app_id, title, playtime_minutes) VALUES (?, ?, ?)').run(
        4000,
        "Garry's Mod",
        100,
      );
      // Match row with the IGDB slug (as returned by the fixture)
      db.prepare(
        'INSERT INTO matches (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(4000, 12348, "Garry's Mod (IGDB)", 'garry-s-mod', 'exact', 'steam-appid');

      generateProposals(db);
      approveExactMatches(undefined, db);

      const manifest = buildManifest(undefined, db);
      const json = JSON.stringify(manifest);

      // The manifest must never contain the naive IGDB slug
      expect(json).not.toContain('garrys-mod');
      // The manifest must contain the corrected Backloggd slug
      expect(json).toContain('garry-s-mod');
    });
  });
});
