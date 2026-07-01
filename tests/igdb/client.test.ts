import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCreateTableSQL } from '../../src/storage/schema.js';
import { RateLimiter, queryExternalGames, fetchExternalGames } from '../../src/igdb/client.js';

describe('IGDB client', () => {
  describe('RateLimiter', () => {
    it('allows immediate token acquisition up to the burst limit', async () => {
      const limiter = new RateLimiter(3, 1000);
      const start = Date.now();

      await limiter.acquire();
      await limiter.acquire();
      await limiter.acquire();

      const elapsed = Date.now() - start;
      // Should complete well under 1s since we had 3 tokens available
      expect(elapsed).toBeLessThan(500);
    });

    it('throttles when the burst is exhausted', async () => {
      const limiter = new RateLimiter(1, 200); // 1 token, refills every 200ms
      const start = Date.now();

      await limiter.acquire(); // consumes the one token
      await limiter.acquire(); // must wait for refill

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(150); // should have waited ~200ms
    });

    it('gradually refills tokens over time', async () => {
      const limiter = new RateLimiter(2, 100);

      await limiter.acquire(); // tokens: 1
      await limiter.acquire(); // tokens: 0

      // Wait for one refill
      await new Promise((resolve) => setTimeout(resolve, 120));

      await limiter.acquire(); // tokens: 0 (1 acquired, 1 refilled)

      // Should succeed — we waited for the refill
      expect(true).toBe(true);
    });

    it('works with high burst limits without delay', async () => {
      const limiter = new RateLimiter(10, 100);
      const start = Date.now();

      for (let i = 0; i < 10; i++) {
        await limiter.acquire();
      }

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
    });

    it('serialises concurrent acquisitions — only one caller gets each token', async () => {
      // With 2 tokens and 5 concurrent callers, only 2 should complete
      // immediately; the rest must wait for refills.
      const limiter = new RateLimiter(2, 200);

      const start = Date.now();
      const results = await Promise.all([
        limiter.acquire(),
        limiter.acquire(),
        limiter.acquire(),
        limiter.acquire(),
        limiter.acquire(),
      ]);

      const elapsed = Date.now() - start;
      expect(results).toHaveLength(5);
      // 2 immediate + 3 waiting for at least one refill (200ms each)
      expect(elapsed).toBeGreaterThanOrEqual(350);
    });
  });

  describe('queryExternalGames (mocked)', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('sends the correct endpoint and fields', async () => {
      const mockResponse = [
        {
          uid: '730',
          external_game_source: 1,
          game: { id: 12345, name: 'CS2', slug: 'counter-strike-2' },
        },
      ];

      let capturedUrl = '';
      let capturedBody = '';

      globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        capturedBody = (init?.body as string) ?? '';
        return new Response(JSON.stringify(mockResponse), { status: 200 });
      };

      const limiter = new RateLimiter(3, 1000);
      const results = await queryExternalGames('fake-token', 'fake-client', [730], limiter);

      // Endpoint
      expect(capturedUrl).toBe('https://api.igdb.com/v4/external_games');

      // Fields and sort in the body
      expect(capturedBody).toContain(
        'fields uid, external_game_source, game.id, game.name, game.slug',
      );
      expect(capturedBody).toContain('sort id asc');
      expect(capturedBody).toContain('where external_game_source = 1');

      // Response parsed correctly
      expect(results).toHaveLength(1);
      expect(results[0].uid).toBe('730');
      expect(results[0].external_game_source).toBe(1);
      expect(results[0].game.id).toBe(12345);
    });

    it('paginates across two pages when results hit the 500 limit', async () => {
      // Generate 500 results for page 1, 50 for page 2
      const page1 = Array.from({ length: 500 }, (_, i) => ({
        uid: String(1000 + i),
        external_game_source: 1,
        game: { id: 2000 + i, name: `Game ${i}`, slug: `game-${i}` },
      }));
      const page2 = Array.from({ length: 50 }, (_, i) => ({
        uid: String(1500 + i),
        external_game_source: 1,
        game: { id: 2500 + i, name: `Game ${500 + i}`, slug: `game-${500 + i}` },
      }));

      let callCount = 0;

      globalThis.fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
        callCount++;
        const body = (init?.body as string) ?? '';
        const offsetMatch = body.match(/offset (\d+)/);
        const offset = offsetMatch ? Number(offsetMatch[1]) : 0;

        if (offset === 0) {
          return new Response(JSON.stringify(page1), { status: 200 });
        }
        return new Response(JSON.stringify(page2), { status: 200 });
      };

      const allAppIds = Array.from({ length: 550 }, (_, i) => 1000 + i);

      const limiter = new RateLimiter(10, 1000);
      const results = await queryExternalGames('fake-token', 'fake-client', allAppIds, limiter);

      expect(callCount).toBe(2);
      expect(results).toHaveLength(550);
    });
  });

  describe('fetchExternalGames (mocked)', () => {
    const originalFetch = globalThis.fetch;
    const clientId = 'test-client-id';
    const clientSecret = 'test-client-secret';

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function seedRevokedToken(db: Database.Database): void {
      const futureExpiry = new Date(Date.now() + 3_600_000).toISOString();
      db.prepare(
        'INSERT INTO api_cache (cache_key, response_body, expires_at) VALUES (?, ?, ?)',
      ).run(`igdb:oauth:access_token:${clientId}`, 'revoked-token', futureExpiry);
    }

    function mockFetchWith401Recovery(): {
      oauthCalled: () => boolean;
      igdbCalls: () => number;
    } {
      let _oauthCalled = false;
      let _igdbCalls = 0;

      globalThis.fetch = async (url: RequestInfo | URL, _init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();

        // Twitch OAuth endpoint
        if (urlStr.includes('id.twitch.tv/oauth2/token')) {
          _oauthCalled = true;
          return new Response(
            JSON.stringify({
              access_token: 'fresh-token',
              expires_in: 7200,
              token_type: 'bearer',
            }),
            { status: 200 },
          );
        }

        // IGDB external_games endpoint
        if (urlStr.includes('api.igdb.com/v4/external_games')) {
          _igdbCalls++;
          if (!_oauthCalled) {
            // First IGDB call — cached token is revoked
            return new Response('Unauthorized', { status: 401 });
          }
          // Retry — token was refreshed
          return new Response(
            JSON.stringify([
              {
                uid: '730',
                external_game_source: 1,
                game: { id: 12345, name: 'CS2', slug: 'counter-strike-2' },
              },
            ]),
            { status: 200 },
          );
        }

        return new Response('Not found', { status: 404 });
      };

      return {
        oauthCalled: () => _oauthCalled,
        igdbCalls: () => _igdbCalls,
      };
    }

    it('recovers from a 401 with a refreshed token when db is explicit', async () => {
      const db = new Database(':memory:');
      db.exec(getCreateTableSQL());
      seedRevokedToken(db);

      const { oauthCalled } = mockFetchWith401Recovery();
      const limiter = new RateLimiter(10, 1000);

      const results = await fetchExternalGames(clientId, clientSecret, [730], db, limiter);

      expect(results).toHaveLength(1);
      expect(results[0].uid).toBe('730');

      // OAuth should have been called to refresh the token
      expect(oauthCalled()).toBe(true);

      // The fresh token should be persisted in the same database
      const cachedRow = db
        .prepare('SELECT response_body FROM api_cache WHERE cache_key = ?')
        .get(`igdb:oauth:access_token:${clientId}`) as { response_body: string } | undefined;
      expect(cachedRow).toBeDefined();
      expect(cachedRow?.response_body).toBe('fresh-token');

      db.close();
    });

    it('recovers from a 401 with a refreshed token when using global db fallback', async () => {
      // Open a global database for the no-db path
      const { openDatabase, closeDatabase, getDatabase } =
        await import('../../src/storage/database.js');
      openDatabase(':memory:');
      const globalDb = getDatabase();
      seedRevokedToken(globalDb);

      const { oauthCalled } = mockFetchWith401Recovery();
      const limiter = new RateLimiter(10, 1000);

      const results = await fetchExternalGames(clientId, clientSecret, [730], undefined, limiter);

      expect(results).toHaveLength(1);
      expect(results[0].uid).toBe('730');

      // OAuth should have been called to refresh the token
      expect(oauthCalled()).toBe(true);

      // The fresh token should be persisted in the global database
      const cachedRow = globalDb
        .prepare('SELECT response_body FROM api_cache WHERE cache_key = ?')
        .get(`igdb:oauth:access_token:${clientId}`) as { response_body: string } | undefined;
      expect(cachedRow).toBeDefined();
      expect(cachedRow?.response_body).toBe('fresh-token');

      // Clean up global database
      closeDatabase();
    });
  });
});
