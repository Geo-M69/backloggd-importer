/**
 * Steam Web API client for fetching owned games.
 *
 * Supports live API calls with Steam credentials and offline development
 * using local fixture data. Raw API responses are cached in the database
 * for repeatable debugging and to reduce network requests.
 */

import type Database from 'better-sqlite3';
import type { Config } from '../config/index.js';
import { getDatabase } from '../storage/database.js';
import { fetchWithRetry } from '../fetch.js';
import { readFixture } from './fixtures.js';

// ---------------------------------------------------------------------------
// Raw API response types
// ---------------------------------------------------------------------------

/**
 * A single game entry from Steam's IPlayerService/GetOwnedGames response.
 */
export interface RawSteamGame {
  appid: number;
  /** Game title (present when include_appinfo=true). */
  name: string;
  /** Total lifetime playtime across all platforms, in minutes. */
  playtime_forever: number;
  /** Playtime on Windows, in minutes. May be absent when zero. */
  playtime_windows_forever?: number;
  /** Playtime on Mac, in minutes. May be absent when zero. */
  playtime_mac_forever?: number;
  /** Playtime on Linux, in minutes. May be absent when zero. */
  playtime_linux_forever?: number;
  /** Playtime in the last two weeks, in minutes. Optional field — commonly absent. */
  playtime_2weeks?: number;
  /** Unix timestamp of last play, or 0 if never played. May be absent. */
  rtime_last_played?: number;
  /** Whether the user has visible community stats for this game. May be absent. */
  has_community_visible_stats?: boolean;
  /** Icon hash (not a full URL), or null if unavailable. Optional field. */
  img_icon_url?: string | null;
  /** Optional — present only when include_appinfo=true and price info is available. */
  price?: number;
  /** Optional — present only when include_appinfo=true. */
  price_change_number?: number;
}

/**
 * Top-level response from IPlayerService/GetOwnedGames.
 */
export interface RawSteamResponse {
  response: {
    game_count: number;
    games: RawSteamGame[];
  };
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic cache key for a Steam API call.
 */
export function steamCacheKey(steamUserId: string): string {
  return `steam:GetOwnedGames:${steamUserId}`;
}

/**
 * Read a cached API response, or return null if not found / expired.
 */
function getCachedResponse(db: Database.Database, cacheKey: string): string | null {
  const row = db
    .prepare(
      `SELECT response_body FROM api_cache
       WHERE cache_key = ?
         AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    )
    .get(cacheKey) as { response_body: string } | undefined;

  return row?.response_body ?? null;
}

/**
 * Write a raw API response to the cache (upsert).
 */
function setCachedResponse(
  db: Database.Database,
  cacheKey: string,
  body: string,
  expiresAt: string | null = null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO api_cache (cache_key, response_body, fetched_at, expires_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`,
  ).run(cacheKey, body, expiresAt);
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Load the sanitised Steam fixture for offline development.
 * The fixture path is resolved relative to the project root.
 */
async function loadFixtureSteamResponse(): Promise<RawSteamResponse> {
  return readFixture('steam-owned-games.json') as Promise<RawSteamResponse>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the user's owned games from the Steam Web API.
 *
 * Resolution order:
 * 1. Return the cached response if available and not expired.
 * 2. If Steam API credentials are configured, call the live API.
 * 3. Otherwise, fall back to the local fixture.
 *
 * The raw response is always cached before returning.
 *
 * @param config     Application configuration (nullable credentials = fixture mode)
 * @param db         Database instance for caching
 * @param useFixture Force fixture mode regardless of credentials (for testing)
 */
export async function fetchOwnedGames(
  config: Pick<Config, 'STEAM_API_KEY' | 'STEAM_USER_ID'> | null,
  db?: Database.Database,
  useFixture?: boolean,
): Promise<RawSteamResponse> {
  const database = db ?? getDatabase();
  const useLive = config?.STEAM_API_KEY && config?.STEAM_USER_ID && !useFixture;

  // Try cache first (only for live mode — fixture data is always fresh)
  if (useLive) {
    const cacheKey = steamCacheKey(config.STEAM_USER_ID);
    const cached = getCachedResponse(database, cacheKey);
    if (cached) {
      // Validate cached responses too — TTL protects against staleness,
      // but a schema change could make an old cached response invalid.
      return validateSteamResponse(JSON.parse(cached) as RawSteamResponse);
    }
  }

  // Fetch from live API or load fixture
  let data: RawSteamResponse;

  if (useLive) {
    const url = new URL('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/');
    url.searchParams.set('key', config.STEAM_API_KEY);
    url.searchParams.set('steamid', config.STEAM_USER_ID);
    url.searchParams.set('include_appinfo', 'true');
    url.searchParams.set('include_played_free_games', 'true');
    url.searchParams.set('format', 'json');

    const response = await fetchWithRetry(url, { timeoutMs: 15_000 });
    if (!response.ok) {
      throw new Error(
        `Steam API responded with ${response.status}: ${response.statusText}. ` +
          'Check your STEAM_API_KEY and STEAM_USER_ID.',
      );
    }

    const raw = (await response.json()) as RawSteamResponse;

    // Validate that the response contains the expected structure.
    // Private profiles, malformed responses, or revoked keys can produce
    // a 200 with an empty or missing games array — catch that here.
    data = validateSteamResponse(raw);
  } else {
    data = await loadFixtureSteamResponse();
  }

  // Cache the raw response with a 24-hour TTL
  if (useLive) {
    const cacheKey = steamCacheKey(config.STEAM_USER_ID);
    const ttl = new Date(Date.now() + 86_400_000).toISOString(); // 24 hours
    setCachedResponse(database, cacheKey, JSON.stringify(data), ttl);
  }

  return data;
}

/**
 * Normalise a potentially-optional field to a safe default, validating
 * only when the field is present.
 *
 * @returns The validated value, or `defaultVal` when the field is absent.
 */
function optionalInt(
  val: unknown,
  field: string,
  appid: number,
  index: number,
  defaultVal: number,
): number {
  if (val === undefined) return defaultVal;
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
    throw new Error(
      `Steam API game[${index}] (appid=${appid}) has invalid ${field}=${JSON.stringify(val)}. ` +
        'Expected a non-negative integer or absent.',
    );
  }
  return val;
}

/**
 * Validate a single raw Steam game record.
 *
 * Throws an error if any consumed field has an invalid type or value.
 * Optional fields that are absent are normalised to a safe default (0 / false).
 */
function validateRawGame(game: RawSteamGame, index: number, seenAppIds: Set<number>): void {
  // appid must be a positive integer
  if (typeof game.appid !== 'number' || !Number.isInteger(game.appid) || game.appid <= 0) {
    throw new Error(
      `Steam API game[${index}] has invalid appid=${JSON.stringify(game.appid)}. ` +
        'The response is malformed. Try again later or clear the cache.',
    );
  }

  // Duplicate AppID detection
  if (seenAppIds.has(game.appid)) {
    throw new Error(
      `Steam API game[${index}] has duplicate appid=${game.appid}. ` +
        'The response contains duplicate entries. Try again later or clear the cache.',
    );
  }
  seenAppIds.add(game.appid);

  // title must be a non-empty string
  if (typeof game.name !== 'string' || game.name.trim().length === 0) {
    throw new Error(
      `Steam API game[${index}] (appid=${game.appid}) has invalid name=${JSON.stringify(game.name)}. ` +
        'Game titles must be non-empty strings.',
    );
  }

  // playtime_forever must be a non-negative integer
  if (
    typeof game.playtime_forever !== 'number' ||
    !Number.isInteger(game.playtime_forever) ||
    game.playtime_forever < 0
  ) {
    throw new Error(
      `Steam API game[${index}] (appid=${game.appid}) has invalid playtime_forever=${game.playtime_forever}. ` +
        'Playtime must be a non-negative integer.',
    );
  }

  // rtime_last_played must be a non-negative integer (0 = never played).
  // Some API responses may omit this field entirely.
  const rtimeLastPlayed = optionalInt(
    game.rtime_last_played,
    'rtime_last_played',
    game.appid,
    index,
    0,
  );
  game.rtime_last_played = rtimeLastPlayed as RawSteamGame['rtime_last_played'];

  // Validate that the timestamp, when non-zero, is within JavaScript Date's
  // safe range.  Out-of-range values cause new Date(value*1000).toISOString()
  // to throw RangeError in the normalisation step.  Catch it here so the
  // malformed response is rejected before caching.
  if (rtimeLastPlayed > 0) {
    const d = new Date(rtimeLastPlayed * 1000);
    if (!Number.isFinite(d.getTime())) {
      throw new Error(
        `Steam API game[${index}] (appid=${game.appid}) has invalid rtime_last_played=${rtimeLastPlayed}. ` +
          'The timestamp is out of range.',
      );
    }
  }

  // img_icon_url must be string or null when present; normalise absent to null
  if (game.img_icon_url === undefined) {
    game.img_icon_url = null;
  } else if (game.img_icon_url !== null && typeof game.img_icon_url !== 'string') {
    throw new Error(
      `Steam API game[${index}] (appid=${game.appid}) has invalid img_icon_url type. ` +
        'Icon URL must be a string or null.',
    );
  }

  // Optional numeric fields — normalise to 0 when absent
  game.playtime_windows_forever = optionalInt(
    game.playtime_windows_forever,
    'playtime_windows_forever',
    game.appid,
    index,
    0,
  );
  game.playtime_mac_forever = optionalInt(
    game.playtime_mac_forever,
    'playtime_mac_forever',
    game.appid,
    index,
    0,
  );
  game.playtime_linux_forever = optionalInt(
    game.playtime_linux_forever,
    'playtime_linux_forever',
    game.appid,
    index,
    0,
  );
  game.playtime_2weeks = optionalInt(game.playtime_2weeks, 'playtime_2weeks', game.appid, index, 0);

  // has_community_visible_stats must be boolean when present; default false
  if (
    game.has_community_visible_stats !== undefined &&
    typeof game.has_community_visible_stats !== 'boolean'
  ) {
    throw new Error(
      `Steam API game[${index}] (appid=${game.appid}) has invalid has_community_visible_stats type. ` +
        'Must be a boolean or absent.',
    );
  }
}

/**
 * Validate a parsed Steam API response and return a clean RawSteamResponse.
 *
 * Throws an actionable error for private profiles or unexpected shapes;
 * normalises a missing games array to an empty list.
 * Validates every consumed field on each game record and rejects duplicates.
 */
export function validateSteamResponse(raw: RawSteamResponse): RawSteamResponse {
  // Runtime safety: the parsed JSON could be null, a string, or any other type
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      'Steam API returned a non-object response. ' +
        'Your game library may be private. ' +
        'Visit https://steamcommunity.com/my/edit/settings and ensure ' +
        "'My profile' and 'Game details' are set to Public, then try again.",
    );
  }

  const resp = raw as { response?: Record<string, unknown> | null };

  if (!resp.response || typeof resp.response.game_count === 'undefined') {
    throw new Error(
      'Steam API returned an unexpected response shape. ' +
        'Your game library may be private. ' +
        'Visit https://steamcommunity.com/my/edit/settings and ensure ' +
        "'My profile' and 'Game details' are set to Public, then try again.",
    );
  }

  const gameCount = resp.response.game_count;

  // game_count must be a non-negative integer; strings, NaN, negatives, and
  // floats are malformed
  if (!Number.isInteger(gameCount) || (gameCount as number) < 0) {
    throw new Error(
      `Steam API returned invalid game_count=${gameCount}. ` +
        'The response was malformed. Try again later or clear the cache.',
    );
  }

  const rawResp = raw as RawSteamResponse;

  // Only normalise a missing games array when game_count is explicitly zero.
  // A non-zero game_count with no games array is a malformed response that
  // should not silently become empty.
  if (!Array.isArray(rawResp.response.games)) {
    if (gameCount === 0) {
      rawResp.response.games = [];
    } else {
      throw new Error(
        `Steam API returned game_count=${gameCount} but no games array. ` +
          'The response was malformed. Try again later or clear the cache.',
      );
    }
  }

  // Verify that the array length matches the declared count.
  // This is an unfiltered API request so the two must agree;
  // discrepancies can cause reconciliation to stale the wrong records.
  if (rawResp.response.games.length !== gameCount) {
    throw new Error(
      `Steam API returned game_count=${gameCount} but games array has ${rawResp.response.games.length} entries. ` +
        'The response is inconsistent. Try again later or clear the cache.',
    );
  }

  // Validate every individual game record and check for duplicate AppIDs
  const seenAppIds = new Set<number>();
  for (let i = 0; i < rawResp.response.games.length; i++) {
    validateRawGame(rawResp.response.games[i], i, seenAppIds);
  }

  return rawResp;
}

/**
 * Clear the cached Steam API response for a given user.
 */
export function clearSteamCache(steamUserId: string, db?: Database.Database): void {
  const database = db ?? getDatabase();
  database.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(steamCacheKey(steamUserId));
}

/**
 * Return the ISO timestamp at which the cached Steam response expires,
 * or null if no cache entry exists.
 */
export function getSteamCacheExpiry(steamUserId: string, db?: Database.Database): string | null {
  const database = db ?? getDatabase();
  const row = database
    .prepare('SELECT expires_at FROM api_cache WHERE cache_key = ?')
    .get(steamCacheKey(steamUserId)) as { expires_at: string | null } | undefined;
  return row?.expires_at ?? null;
}
