import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { clearTokenCache, isTokenValid } from '../../src/igdb/auth.js';
import type { CachedToken } from '../../src/igdb/auth.js';

describe('IGDB auth', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(getCreateTableSQL());
  });

  afterEach(() => {
    db.close();
  });

  describe('isTokenValid', () => {
    it('returns true for a token with no expiry', () => {
      const token: CachedToken = {
        accessToken: 'test-token',
        fetchedAt: '2024-01-01T00:00:00.000Z',
        expiresAt: null,
      };
      expect(isTokenValid(token)).toBe(true);
    });

    it('returns true for a token that expires far in the future', () => {
      const farFuture = new Date(Date.now() + 86_400_000 * 30).toISOString(); // 30 days
      const token: CachedToken = {
        accessToken: 'test-token',
        fetchedAt: new Date().toISOString(),
        expiresAt: farFuture,
      };
      expect(isTokenValid(token)).toBe(true);
    });

    it('returns false for an expired token', () => {
      const past = new Date(Date.now() - 86_400_000).toISOString(); // 1 day ago
      const token: CachedToken = {
        accessToken: 'expired-token',
        fetchedAt: past,
        expiresAt: past,
      };
      expect(isTokenValid(token)).toBe(false);
    });

    it('returns false for a token expiring within the safety margin', () => {
      // 2 minutes from now — within the 5-minute margin
      const nearFuture = new Date(Date.now() + 120_000).toISOString();
      const token: CachedToken = {
        accessToken: 'about-to-expire',
        fetchedAt: new Date().toISOString(),
        expiresAt: nearFuture,
      };
      expect(isTokenValid(token)).toBe(false);
    });
  });

  describe('clearTokenCache', () => {
    it('removes the cached token entry for the specified client', () => {
      // Insert a cached token for a given client
      db.prepare(
        `INSERT INTO api_cache (cache_key, response_body, fetched_at, expires_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`,
      ).run('igdb:oauth:access_token:test-client-id', 'test-token', null);

      clearTokenCache('test-client-id', db);

      const count = db
        .prepare(
          "SELECT COUNT(*) as count FROM api_cache WHERE cache_key = 'igdb:oauth:access_token:test-client-id'",
        )
        .get() as { count: number };
      expect(count.count).toBe(0);
    });
  });
});
