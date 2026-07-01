/**
 * Normalize raw Steam API data into the internal SteamGame model,
 * filtering out known non-game entries and inserting results into
 * the database.
 */

import type Database from 'better-sqlite3';
import { createSteamGame } from '../models/game.js';
import type { SteamGame } from '../models/game.js';
import type { RawSteamGame, RawSteamResponse } from './client.js';

// ---------------------------------------------------------------------------
// Non-game definitions
//
// These lists capture Steam entries that are not user-playable games:
// redistributables, development tools, Steam client components, etc.
// Extend these as needed without changing the core logic.
// ---------------------------------------------------------------------------

/**
 * Steam AppIDs known to be non-game entries.
 *
 * Sources:
 * - Steamworks documentation
 * - Community-maintained blocklists
 * - Empirical observation
 */
const NON_GAME_APPIDS: ReadonlySet<number> = new Set([
  7, // Steam Client
  8, // Steam Ads
  228, // Steamworks Common Redistributables
  373, // Steamworks Common Redistributables (older)
  480, // Spacewar (internal Steamworks test app)
]);

/**
 * Title patterns that identify non-game entries.
 * All patterns are case-insensitive.
 */
const NON_GAME_TITLE_PATTERNS: readonly RegExp[] = [
  // Specific Steam client components & utilities (not a blanket /^Steam\s/i
  // which would block legitimate games like "Steam Marines")
  /^Steam (Client|Link|Remote Play|Audio|Controller|BPM)$/i,
  /^SteamVR$/i,
  // Server, development, and runtime entries (never user-playable)
  // Note: we avoid broad /\bRuntime\b/i (blocks "RUNTIME") and /\bSDK\b/i
  // (blocks unknown legit titles). Only known non-game names are listed.
  /\bDedicated Server\b/i,
  /\bRedistributable\b/i,
  /\bWorkshop Tool\b/i,
  /^Proton (Runtime|Experimental|EasyAntiCheat)/i,
  /^Linux Runtime$/i,
  /^Source\s+(SDK|Filmmaker|Multiplayer)/i,
  /^Steamworks\s/i,
  /^Linux Steam Integration/i,
];

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Determine whether a raw Steam game entry should be treated as a
 * user-playable game (true = keep, false = filter out).
 */
export function isPlayableGame(raw: RawSteamGame): boolean {
  if (NON_GAME_APPIDS.has(raw.appid)) return false;
  return !NON_GAME_TITLE_PATTERNS.some((pattern) => pattern.test(raw.name));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Convert a Unix timestamp (seconds) to an ISO-8601 string, or null for
 * falsy values (which Steam uses for "never played").
 */
function unixToIso(timestamp: number): string | null {
  if (!timestamp) return null;
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Build a full Steam CDN icon URL from an AppID and icon hash, or null
 * if no hash is available.
 */
function buildIconUrl(appId: number, hash: string | null): string | null {
  if (!hash) return null;
  return `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${appId}/${hash}.jpg`;
}

/**
 * Normalize a single raw Steam API entry into a SteamGame model.
 */
export function normalizeGame(raw: RawSteamGame): SteamGame {
  return createSteamGame({
    appId: raw.appid,
    title: raw.name,
    iconUrl: buildIconUrl(raw.appid, raw.img_icon_url ?? null),
    playtimeMinutes: raw.playtime_forever,
    lastPlayedAt: unixToIso(raw.rtime_last_played ?? 0),
    isFree: false, // Steam API does not reliably indicate free status in GetOwnedGames
    hasDetails: (raw.img_icon_url ?? null) !== null && raw.name.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Database integration
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Steam API response, filter non-games, upsert the
 * resulting games into the database with `stale = 0`, and optionally
 * mark non-current games as `stale = 1`.
 *
 * Using a `stale` flag instead of deleting rows avoids foreign-key
 * violations when matches or proposals reference the game.
 *
 * @param reconcile  When true, mark games not in the current response
 *                   as stale (safe only after a successful live fetch).
 * @returns The array of normalized (and stored) SteamGame objects.
 */
export function processAndStoreGames(
  db: Database.Database,
  rawResponse: RawSteamResponse,
  reconcile = false,
): SteamGame[] {
  const rawGames = rawResponse.response.games ?? [];
  const games: SteamGame[] = [];

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO games
      (app_id, title, icon_url, playtime_minutes, last_played_at, is_free, has_details, stale, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 0,
       COALESCE((SELECT created_at FROM games WHERE app_id = ?), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);

  // Mark-all-stale-first: set every existing row to stale, then upsert only
  // playable games with stale=0.  This avoids placeholder-count mismatches
  // when the response contains filtered (non-playable) entries, and also
  // correctly marks everything stale for empty libraries.
  const markAllStaleStmt = db.prepare(
    "UPDATE games SET stale = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
  );

  const transaction = db.transaction(() => {
    if (reconcile) {
      markAllStaleStmt.run();
    }

    for (const raw of rawGames) {
      if (!isPlayableGame(raw)) continue;

      const game = normalizeGame(raw);
      insertStmt.run(
        game.appId,
        game.title,
        game.iconUrl,
        game.playtimeMinutes,
        game.lastPlayedAt,
        game.isFree ? 1 : 0,
        game.hasDetails ? 1 : 0,
        game.appId, // for COALESCE on created_at
      );
      games.push(game);
    }
  });

  transaction();
  return games;
}
