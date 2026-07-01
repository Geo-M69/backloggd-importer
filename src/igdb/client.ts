/**
 * IGDB API client for querying external-game records.
 *
 * Uses the Twitch OAuth token from `auth.ts` and implements
 * rate limiting (4 requests/second per IGDB's restrictions).
 *
 * The primary endpoint used is:
 *   POST https://api.igdb.com/v4/external_games
 *
 * We match Steam AppIDs via `uid` where `external_game_source = 1` (Steam)
 * and fetch the linked game's id, name, and slug.
 *
 * IGDB returns a flat array of external-game records; the linked game
 * data lives in a nested `game` object: `{ uid, game: { id, name, slug } }`.
 */

import type Database from 'better-sqlite3';
import { getAccessToken, clearTokenCache } from './auth.js';
import { getDatabase } from '../storage/database.js';
import { fetchWithRetry, HttpError } from '../fetch.js';

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Concurrency-safe token-bucket rate limiter for IGDB's 4 req/s limit.
 *
 * IGDB allows 4 requests per second per application. We use a
 * conservative 3-per-second limit with a small burst allowance.
 *
 * A promise chain serializes token checks so concurrent callers never
 * both see the same available token count.
 */
export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private lastRefill: number;
  private chain = Promise.resolve();

  /**
   * @param maxTokens    Maximum burst size (default 1 — each call waits in turn)
   * @param refillMs     How often (in ms) one token is added (default 260 ≈ ~3.8/s,
   *                     safely under IGDB's 4 req/s limit)
   */
  constructor(maxTokens = 1, refillMs = 260) {
    this.tokens = maxTokens;
    this.maxTokens = maxTokens;
    this.refillIntervalMs = refillMs;
    this.lastRefill = Date.now();
  }

  /**
   * Wait until a token is available, then consume it.
   * Concurrent calls are serialized through an internal promise chain.
   */
  async acquire(): Promise<void> {
    this.chain = this.chain.then(() => this.doAcquire());
    return this.chain;
  }

  private async doAcquire(): Promise<void> {
    this.refill();

    if (this.tokens > 0) {
      this.tokens--;
      return;
    }

    // Wait for the next refill interval, then retry
    const waitMs = this.refillIntervalMs - (Date.now() - this.lastRefill);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const gained = Math.floor(elapsed / this.refillIntervalMs);
    if (gained > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + gained);
      this.lastRefill = now;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An external-game record from IGDB's v4 API.
 *
 * Each record maps a platform-specific UID (e.g. a Steam AppID)
 * to an IGDB Game record. We request the nested `game` object to
 * get the game id, name, and slug.
 *
 * Reference: https://api-docs.igdb.com/#external-game
 */
export interface IgdbExternalGame {
  /** The platform-specific identifier (e.g. Steam AppID as a string). */
  uid: string;
  /** The IGDB external game source (1 = Steam). */
  external_game_source: number;
  /** The linked IGDB game record. */
  game: {
    /** IGDB internal game ID. */
    id: number;
    /** Game name as recorded by IGDB. */
    name: string;
    /** URL-safe slug (used for Backloggd URLs). */
    slug: string;
  };
}

/**
 * Convenience type: an IGDB game id/name/slug extracted from
 * an external-game record.
 */
export interface IgdbResolvedGame {
  igdbId: number;
  igdbName: string;
  igdbSlug: string;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

const IGDB_API_BASE = 'https://api.igdb.com/v4';

/**
 * IGDB response size limit per request.
 */
const IGDB_PAGE_LIMIT = 500;

/**
 * Validate an IGDB external-games response.
 *
 * IGDB returns a flat JSON array of external-game records. This function
 * checks that every entry has the expected shape with valid fields,
 * filtering out records where `external_game_source !== 1` as a safety
 * net even though the query already requests only source=1.
 *
 * @returns The validated and filtered array.
 * @throws If the response is not an array or contains structurally invalid records.
 */
function validateIgdbExternalGamesResponse(data: unknown): IgdbExternalGame[] {
  if (!Array.isArray(data)) {
    throw new Error(
      `IGDB API returned a non-array response (${typeof data}). ` +
        'Expected an array of external-game records.',
    );
  }

  const validated: IgdbExternalGame[] = [];

  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Record<string, unknown>;

    // Must have a valid numeric uid
    if (typeof entry.uid !== 'string' || !/^\d+$/.test(entry.uid)) {
      throw new Error(
        `IGDB API entry[${i}] has invalid uid=${JSON.stringify(entry.uid)}. ` +
          'Expected a numeric string (Steam AppID).',
      );
    }

    // Must have external_game_source === 1 (Steam).
    // The IGDB query already filters by source=1, so receiving a non-Steam
    // record is an API anomaly. Throwing prevents silent data loss and
    // truncated pagination (filtered-out records reduce the page size,
    // causing the pagination loop to stop early).
    if (entry.external_game_source !== 1) {
      throw new Error(
        `IGDB API entry[${i}] (uid=${entry.uid}) has external_game_source=${entry.external_game_source}, ` +
          'expected 1 (Steam). The API returned an unexpected record.',
      );
    }

    // Must have a nested game object with valid id, name, slug
    if (typeof entry.game !== 'object' || entry.game === null) {
      throw new Error(
        `IGDB API entry[${i}] (uid=${entry.uid}) has missing or invalid game object.`,
      );
    }

    const game = entry.game as Record<string, unknown>;

    if (typeof game.id !== 'number' || !Number.isInteger(game.id) || game.id <= 0) {
      throw new Error(
        `IGDB API entry[${i}] (uid=${entry.uid}) has invalid game.id=${JSON.stringify(game.id)}. ` +
          'Expected a positive integer.',
      );
    }

    if (typeof game.name !== 'string' || game.name.length === 0) {
      throw new Error(
        `IGDB API entry[${i}] (uid=${entry.uid}) has invalid game.name=${JSON.stringify(game.name)}. ` +
          'Expected a non-empty string.',
      );
    }

    if (typeof game.slug !== 'string' || game.slug.length === 0) {
      throw new Error(
        `IGDB API entry[${i}] (uid=${entry.uid}) has invalid game.slug=${JSON.stringify(game.slug)}. ` +
          'Expected a non-empty string.',
      );
    }

    validated.push(entry as unknown as IgdbExternalGame);
  }

  return validated;
}

/**
 * Maximum number of 401-driven token refresh attempts per `queryExternalGames`
 * call. Prevents infinite recursion when a refreshed token is also expired.
 */
const MAX_TOKEN_REFRESH = 1;

/**
 * Query a single page of IGDB's external_games endpoint.
 *
 * @param accessToken   A valid IGDB access token.
 * @param clientId      IGDB client ID.
 * @param appIds        Array of Steam AppIDs to look up.
 * @param offset        Pagination offset.
 * @param rateLimiter   Rate limiter instance.
 * @returns The parsed API response (one page).
 * @throws {HttpError}  On HTTP 401 — callers should refresh the token and retry.
 */
async function queryExternalGamesPage(
  accessToken: string,
  clientId: string,
  appIds: number[],
  offset: number,
  rateLimiter: RateLimiter,
): Promise<IgdbExternalGame[]> {
  await rateLimiter.acquire();

  const uidList = appIds.map((id) => `"${id}"`).join(',');
  const body = `
    where external_game_source = 1 & uid = (${uidList});
    fields uid, external_game_source, game.id, game.name, game.slug;
    sort id asc;
    limit ${IGDB_PAGE_LIMIT};
    offset ${offset};
  `.trim();

  const response = await fetchWithRetry(`${IGDB_API_BASE}/external_games`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      Authorization: `Bearer ${accessToken}`,
      'Client-ID': clientId,
    },
    body,
    timeoutMs: 15_000,
  });

  // 401 means the token is expired — let the caller handle it once
  if (response.status === 401) {
    throw new HttpError(response);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`IGDB API returned ${response.status}: ${response.statusText}. ${text}`.trim());
  }

  const data = await response.json();
  return validateIgdbExternalGamesResponse(data);
}

/**
 * Query IGDB's external_games endpoint, automatically paginating when the
 * AppID list exceeds IGDB's 500-result limit.
 *
 * If the cached access token is expired (HTTP 401), the token cache is
 * cleared, a fresh token is obtained, and the entire multi-page query is
 * restarted once. This ensures all pages use the same refreshed token.
 *
 * @param accessToken   A valid IGDB access token.
 * @param clientId      IGDB client ID.
 * @param appIds        Array of Steam AppIDs to look up.
 * @param rateLimiter   Optional shared rate limiter instance.
 * @param clientSecret  IGDB client secret (needed for token refresh on 401).
 * @param db            Database instance (needed for token cache operations).
 * @returns             All pages concatenated.
 */
export async function queryExternalGames(
  accessToken: string,
  clientId: string,
  appIds: number[],
  rateLimiter?: RateLimiter,
  clientSecret?: string,
  db?: Database.Database,
): Promise<IgdbExternalGame[]> {
  if (appIds.length === 0) return [];

  const limiter = rateLimiter ?? globalRateLimiter;

  /**
   * Inner pagination loop. Extracted so it can be retried once on 401.
   */
  async function fetchAllPages(token: string): Promise<IgdbExternalGame[]> {
    const allResults: IgdbExternalGame[] = [];
    let offset = 0;

    while (true) {
      const page = await queryExternalGamesPage(token, clientId, appIds, offset, limiter);
      allResults.push(...page);

      if (page.length < IGDB_PAGE_LIMIT) {
        // Fewer results than the limit means we've reached the end
        break;
      }

      offset += IGDB_PAGE_LIMIT;
    }

    return allResults;
  }

  let refreshCount = 0;

  while (true) {
    try {
      return await fetchAllPages(refreshCount === 0 ? accessToken : accessToken);
    } catch (err) {
      if (
        err instanceof HttpError &&
        err.status === 401 &&
        clientSecret &&
        db &&
        refreshCount < MAX_TOKEN_REFRESH
      ) {
        // Token expired — clear cache, get a fresh one, and retry once
        clearTokenCache(clientId, db);
        accessToken = await getAccessToken(clientId, clientSecret, db);
        refreshCount++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Global rate limiter shared across all IGDB queries.
 * Uses the default one-token bucket at ~260 ms (~3.8 req/s),
 * safely under IGDB's 4 req/s limit.
 */
export const globalRateLimiter = new RateLimiter();

/**
 * Convenience function: obtain a token and query external games in one call.
 */
export async function fetchExternalGames(
  clientId: string,
  clientSecret: string,
  appIds: number[],
  db?: Database.Database,
  rateLimiter?: RateLimiter,
): Promise<IgdbExternalGame[]> {
  const database = db ?? getDatabase();
  const token = await getAccessToken(clientId, clientSecret, database);
  return queryExternalGames(token, clientId, appIds, rateLimiter, clientSecret, database);
}
