/**
 * Match Steam games to IGDB records and store results.
 *
 * The matcher resolves unmatched Steam AppIDs against IGDB's
 * external-games endpoint. Only Steam→IGDB mappings (external_game_source = 1)
 * are considered. Results are recorded in the `matches` table with
 * an appropriate confidence level.
 *
 * This module is strictly AppID-based (Milestone 2). Title-fuzzy
 * and release-year fallback matching will be added in a later
 * milestone.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../storage/database.js';
import type { MatchConfidence, MatchMethod } from '../models/match.js';
import { fetchExternalGames } from './client.js';
import type { IgdbExternalGame } from './client.js';
import { readFixture } from '../steam/fixtures.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long (in days) to wait before retrying an 'unmatched' row.
 * IGDB's external-game data is updated periodically, so stale unmatched
 * entries may later resolve to a match.
 */
const UNMATCHED_RETRY_DAYS = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A resolved match for a single Steam AppID.
 */
export interface MatchResult {
  steamAppId: number;
  igdbId: number | null;
  igdbName: string | null;
  backloggdSlug: string | null;
  confidence: MatchConfidence;
  matchMethod: MatchMethod;
}

/**
 * Statistics from a match run.
 */
export interface MatchRunStats {
  totalUnmatched: number;
  exactMatches: number;
  ambiguousMatches: number;
  unmatched: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Core matching logic
// ---------------------------------------------------------------------------

/**
 * Build a Backloggd game URL slug from an IGDB slug.
 *
 * Backloggd uses the same slug format as IGDB for game pages:
 *   https://www.backloggd.com/games/<slug>/
 */
function buildBackloggdSlug(igdbSlug: string): string {
  return igdbSlug;
}

/**
 * Classify confidence based on match details.
 *
 * Strict AppID matching (external_game_source = 1) always produces `exact` confidence
 * for now. Ambiguity arises when one Steam AppID matches multiple
 * IGDB records.
 */
export function classifyConfidence(
  entries: IgdbExternalGame[],
  steamAppId: number,
): {
  confidence: MatchConfidence;
  igdbId: number | null;
  igdbName: string | null;
  backloggdSlug: string | null;
} {
  // All entries returned from the query already match our AppID
  // (the IGDB query filters by uid + external_game_source = 1)
  const matchingEntries = entries.filter((e) => e.uid === String(steamAppId));

  if (matchingEntries.length === 0) {
    return { confidence: 'unmatched', igdbId: null, igdbName: null, backloggdSlug: null };
  }

  if (matchingEntries.length === 1) {
    const entry = matchingEntries[0];
    return {
      confidence: 'exact',
      igdbId: entry.game.id,
      igdbName: entry.game.name,
      backloggdSlug: buildBackloggdSlug(entry.game.slug),
    };
  }

  // Multiple IGDB external-game records claim this Steam AppID → ambiguous
  const primary = matchingEntries[0];
  return {
    confidence: 'ambiguous',
    igdbId: primary.game.id,
    igdbName: primary.game.name,
    backloggdSlug: buildBackloggdSlug(primary.game.slug),
  };
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Get all Steam AppIDs from the `games` table that do not yet have
 * a confirmed match in the `matches` table.
 */
export function getUnmatchedAppIds(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT g.app_id FROM games g
       WHERE g.stale = 0
         AND g.app_id NOT IN (
           SELECT m.steam_app_id FROM matches m
           WHERE m.confidence IN ('exact', 'probable')
         )
       ORDER BY g.app_id`,
    )
    .all() as { app_id: number }[];

  return rows.map((r) => r.app_id);
}

/**
 * Get all Steam AppIDs from the `games` table that are fully unmatched
 * (no match row at all), OR whose existing match row is 'unmatched' and
 * older than the retry TTL.
 *
 * This prevents permanent stagnation: an unmatched entry will be retried
 * after UNMATCHED_RETRY_DAYS, giving IGDB time to link the AppID.
 */
export function getUnmatchedAppIdsNoRow(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT g.app_id FROM games g
       WHERE g.stale = 0
         AND (
           g.app_id NOT IN (SELECT m.steam_app_id FROM matches m)
           OR (
             g.app_id IN (
               SELECT m.steam_app_id FROM matches m
               WHERE m.confidence = 'unmatched'
                 AND m.matched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
             )
           )
         )
       ORDER BY g.app_id`,
    )
    .all(`-${UNMATCHED_RETRY_DAYS} days`) as { app_id: number }[];

  return rows.map((r) => r.app_id);
}

/**
 * Get ALL non-stale AppIDs from the `games` table, regardless of whether
 * they already have a match row. Used by force-refresh mode to re-match
 * every active game, including those with existing exact/probable matches.
 */
function getAllActiveAppIds(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT g.app_id FROM games g
       WHERE g.stale = 0
       ORDER BY g.app_id`,
    )
    .all() as { app_id: number }[];

  return rows.map((r) => r.app_id);
}

/**
 * Upsert a single match result into the `matches` table.
 */
function storeMatch(db: Database.Database, result: MatchResult): void {
  db.prepare(
    `INSERT OR REPLACE INTO matches
       (steam_app_id, igdb_id, igdb_name, backloggd_slug, confidence, match_method, matched_at)
     VALUES
       (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).run(
    result.steamAppId,
    result.igdbId,
    result.igdbName,
    result.backloggdSlug,
    result.confidence,
    result.matchMethod,
  );
}

// ---------------------------------------------------------------------------
// Fixture support
// ---------------------------------------------------------------------------

/**
 * Expected match results for the current fixture data.
 */
interface FixtureMatchedResults {
  matches: {
    steamAppId: number;
    igdbId: number | null;
    igdbName: string | null;
    backloggdSlug: string | null;
    confidence: MatchConfidence;
    matchMethod: MatchMethod;
  }[];
}

/**
 * Load match expectations from the fixture file.
 */
async function loadFixtureMatches(): Promise<FixtureMatchedResults> {
  return readFixture('matched-results.json') as Promise<FixtureMatchedResults>;
}

// ---------------------------------------------------------------------------
// Live-matching helpers
// ---------------------------------------------------------------------------

/**
 * Group a flat list of IGDB external-game records by Steam AppID.
 */
export function groupByAppId(entries: IgdbExternalGame[]): Map<number, IgdbExternalGame[]> {
  const map = new Map<number, IgdbExternalGame[]>();
  for (const entry of entries) {
    const appId = Number(entry.uid);
    if (!Number.isFinite(appId)) continue;
    const group = map.get(appId) ?? [];
    group.push(entry);
    map.set(appId, group);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the matching pipeline for a set of Steam AppIDs against IGDB.
 *
 * Resolution order:
 * 1. Query AppIDs that need matching from the database.
 * 2. If IGDB credentials are available, query the live API and group results.
 * 3. Otherwise, load expected matches from the fixture.
 * 4. Every requested AppID gets a row — unmatched ones are stored as 'unmatched'.
 *
 * By default, only AppIDs that have never been matched or whose 'unmatched' row
 * is older than {@link UNMATCHED_RETRY_DAYS} are processed. Pass `force = true`
 * to re-match every non-stale AppID (including those with existing exact/ambiguous
 * matches).
 *
 * @param force When true, re-match all non-stale games. When false (default),
 *              only retry never-matched or expired-unmatched entries.
 * @returns Statistics about the match run.
 */
export async function matchGames(
  clientId: string | undefined,
  clientSecret: string | undefined,
  db?: Database.Database,
  useFixture?: boolean,
  force = false,
): Promise<MatchRunStats> {
  const database = db ?? getDatabase();
  const useLive = clientId && clientSecret && !useFixture;

  // Gather AppIDs that need matching
  const appIds = force ? getAllActiveAppIds(database) : getUnmatchedAppIdsNoRow(database);
  if (appIds.length === 0) {
    return { totalUnmatched: 0, exactMatches: 0, ambiguousMatches: 0, unmatched: 0, errors: 0 };
  }

  // Build a lookup: AppID → IGDB entries (from live API or fixture)
  let appIdToEntries: Map<number, IgdbExternalGame[]>;

  if (useLive) {
    const igdbEntries = await fetchExternalGames(clientId, clientSecret, appIds, database);
    appIdToEntries = groupByAppId(igdbEntries);
  } else {
    const fixture = await loadFixtureMatches();
    const matchByAppId = new Map<number, FixtureMatchedResults['matches'][number]>();
    for (const m of fixture.matches) {
      matchByAppId.set(m.steamAppId, m);
    }

    // Convert fixture matches into IgdbExternalGame[] per AppID so the
    // classification path remains unified.
    appIdToEntries = new Map();
    for (const appId of appIds) {
      const fm = matchByAppId.get(appId);
      if (fm && fm.igdbId !== null) {
        appIdToEntries.set(appId, [
          {
            uid: String(appId),
            external_game_source: 1,
            game: { id: fm.igdbId, name: fm.igdbName ?? '', slug: fm.backloggdSlug ?? '' },
          },
        ]);
      }
      // AppIDs absent from the fixture or with igdbId=null get no entries,
      // which classifyConfidence will resolve as 'unmatched'.
    }
  }

  // Classify and store each match
  const stats: MatchRunStats = {
    totalUnmatched: appIds.length,
    exactMatches: 0,
    ambiguousMatches: 0,
    unmatched: 0,
    errors: 0,
  };

  const transaction = database.transaction(() => {
    for (const appId of appIds) {
      const entries = appIdToEntries.get(appId) ?? [];
      const { confidence, igdbId, igdbName, backloggdSlug } = classifyConfidence(entries, appId);

      storeMatch(database, {
        steamAppId: appId,
        igdbId,
        igdbName,
        backloggdSlug,
        confidence,
        matchMethod: igdbId !== null ? 'steam-appid' : null,
      });

      if (confidence === 'exact') stats.exactMatches++;
      else if (confidence === 'ambiguous') stats.ambiguousMatches++;
      else stats.unmatched++;
    }
  });

  transaction();
  return stats;
}
