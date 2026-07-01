/**
 * IGDB (Twitch) OAuth client-credentials token management.
 *
 * IGDB uses Twitch's OAuth 2.0 client-credentials flow:
 *   POST https://id.twitch.tv/oauth2/token
 *   ?client_id=<id>
 *   &client_secret=<secret>
 *   &grant_type=client_credentials
 *
 * The returned access token is valid for an unspecified duration
 * (typically ~60 days). We cache it in the database to avoid
 * unnecessary token requests on every import run.
 */

import type Database from 'better-sqlite3';
import { getDatabase } from '../storage/database.js';
import { fetchWithRetry } from '../fetch.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Response from the Twitch OAuth token endpoint.
 */
export interface TwitchTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: 'bearer';
}

/**
 * A cached token record.
 */
export interface CachedToken {
  accessToken: string;
  fetchedAt: string;
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Cache constants
// ---------------------------------------------------------------------------

/**
 * Build a cache key that includes the client ID so tokens from different
 * Twitch applications are never mixed.
 */
function tokenCacheKey(clientId: string): string {
  return `igdb:oauth:access_token:${clientId}`;
}

/**
 * How many seconds before expiry to consider the token stale and refresh it.
 * We refresh early to avoid race conditions at the expiry boundary.
 */
const REFRESH_MARGIN_SECONDS = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

/**
 * Read a cached token from the database, or return null.
 */
function getCachedToken(db: Database.Database, clientId: string): CachedToken | null {
  const row = db
    .prepare('SELECT response_body, fetched_at, expires_at FROM api_cache WHERE cache_key = ?')
    .get(tokenCacheKey(clientId)) as
    { response_body: string; fetched_at: string; expires_at: string | null } | undefined;

  if (!row) return null;

  return {
    accessToken: row.response_body,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Store a token response in the cache.
 */
function setCachedToken(
  db: Database.Database,
  clientId: string,
  accessToken: string,
  expiresAt: string | null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO api_cache (cache_key, response_body, fetched_at, expires_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`,
  ).run(tokenCacheKey(clientId), accessToken, expiresAt);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Determine whether a cached token is still valid (not expired, with margin).
 */
export function isTokenValid(cached: CachedToken): boolean {
  if (!cached.expiresAt) return true; // no expiry recorded
  const expiry = new Date(cached.expiresAt).getTime();
  return Date.now() + REFRESH_MARGIN_SECONDS * 1000 < expiry;
}

/**
 * Obtain a valid IGDB access token.
 *
 * Resolution order:
 * 1. Return a cached non-expired token.
 * 2. Fetch a new token via Twitch OAuth.
 * 3. Cache the new token before returning.
 *
 * @param clientId     Twitch/IGDB client ID
 * @param clientSecret Twitch/IGDB client secret
 * @param db           Database instance for token caching
 */
export async function getAccessToken(
  clientId: string,
  clientSecret: string,
  db?: Database.Database,
): Promise<string> {
  const database = db ?? getDatabase();

  // Try cache first (scoped to clientId)
  const cached = getCachedToken(database, clientId);
  if (cached && isTokenValid(cached)) {
    return cached.accessToken;
  }

  // Fetch a new token via POST body (avoids secret in URL logs)
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });

  const response = await fetchWithRetry('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeoutMs: 15_000,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Twitch OAuth returned ${response.status}: ${response.statusText}. ${text}`.trim(),
    );
  }

  const tokenData = (await response.json()) as TwitchTokenResponse;

  // Compute expiry
  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();

  // Cache (scoped to clientId)
  setCachedToken(database, clientId, tokenData.access_token, expiresAt);

  return tokenData.access_token;
}

/**
 * Clear the cached IGDB access token for a specific client (forces re-auth
 * on next call).
 */
export function clearTokenCache(clientId: string, db?: Database.Database): void {
  const database = db ?? getDatabase();
  database.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(tokenCacheKey(clientId));
}
