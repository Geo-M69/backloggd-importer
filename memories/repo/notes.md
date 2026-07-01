# backloggd-importer

## Seven actionable issues (2026-06-29)

### P1 — Unmatched IGDB results are permanent (matcher.ts)
- Added `UNMATCHED_RETRY_DAYS = 7` constant.
- `getUnmatchedAppIdsNoRow` now also returns AppIDs whose existing match row is 'unmatched' and older than the TTL.
- `matchGames` accepts a `force` parameter (default `false`). When `true`, re-matches all non-stale games via `getUnmatchedAppIds`.
- IGDB CLI supports `--force` flag via `process.argv`.

### P1 — Steam validates only the container, not game records (client.ts)
- Added `validateRawGame()` that validates every consumed field on each `RawSteamGame`:
  - `appid`: positive integer, checked for duplicates within the response.
  - `name`: non-empty string.
  - `playtime_forever`, `rtime_last_played`: non-negative integers.
  - `img_icon_url`: string or null.
  - Platform playtimes and `has_community_visible_stats`.
- Called from `validateSteamResponse()` after container checks pass.

### P2 — Network requests lack bounded failure handling (igdb/client.ts, igdb/auth.ts, steam/client.ts)
- Created `src/fetch.ts` with `fetchWithRetry()`: timeout (15s default), retry with exponential backoff for 408/429/5xx, respects `Retry-After` header, 3 max retries.
- In `igdb/client.ts`: uses `fetchWithRetry`, clears cached token and retries once on 401.
- In `igdb/auth.ts`: uses `fetchWithRetry` for OAuth token request.
- In `steam/client.ts`: uses `fetchWithRetry` for Steam API call.

### P2 — Partial credentials silently select fixture mode (steam-export.ts, igdb-match.ts)
- `loadSteamConfig()` and `loadIgdbConfig()` now check whether ANY credential env var is set. If at least one is set but validation fails, they throw an error instead of falling back to fixture. Fixture mode only activates when neither credential is provided.

### P2 — IGDB responses are unchecked assertions (igdb/client.ts)
- Added `validateIgdbExternalGamesResponse()` that checks:
  - Response is an array.
  - Each entry has a numeric-string `uid`.
  - `external_game_source === 1` (filters non-Steam records as safety net).
  - Nested `game` object has valid `id` (positive int), `name` (non-empty string), `slug` (non-empty string).
- Called in `queryExternalGamesPage` after JSON parse.

### P2 — Tests are not typechecked (tsconfig.json, matcher.test.ts)
- Created `tsconfig.test.json` extending the base config with `rootDir: "."` to include both `src` and `tests`.
- Added `typecheck:tests` script to package.json.
- Fixed `category` → `external_game_source` in all test fixtures (5 occurrences).
- Fixed `db.pragma()` type cast in database.test.ts.

### P3 — Export stems can escape the output directory (exporter.ts)
- Added `validateStem()` that rejects empty stems, stems with `/` or `\`, and bare `.` / `..`.
- Called from `exportGames()` before writing files.

### P1 — Valid Steam responses rejected (steam/client.ts)
- Made `img_icon_url`, `rtime_last_played`, `playtime_windows_forever`, `playtime_mac_forever`, `playtime_linux_forever`, `playtime_2weeks`, `has_community_visible_stats` optional in `RawSteamGame`.
- `validateRawGame` normalises absent optional fields to `0`/`false`/`null` via `optionalInt()`.
- `normalizeGame` uses `??` to safely default missing optional fields.

### P1 — 401 recovery was unreachable (fetch.ts, igdb/client.ts, igdb/auth.ts)
- `fetchWithRetry` now returns non-retryable responses (incl. 401) instead of throwing.
- Added `HttpError` class for retryable-exhaustion errors.
- IGDB 401 handling moved to `queryExternalGames`: restarts entire pagination once with refreshed token (`MAX_TOKEN_REFRESH = 1`).

### P2 — `--force` excluded exact/probable matches (matcher.ts)
- Added `getAllActiveAppIds()` selecting all `stale=0` AppIDs regardless of match status.
- Force mode uses this instead of `getUnmatchedAppIds()`.

### P2 — IGDB filtering truncated pagination (igdb/client.ts)
- `validateIgdbExternalGamesResponse` now **throws** on `external_game_source !== 1` (was silently skipping, which could truncate pagination).

### P2 — DB_PATH fixture isolation (steam-export.ts, igdb-match.ts)
- Fixture mode ignores `DB_PATH` entirely; always uses `import.fixture.db`.

### P2 — Removed incorrect export type (igdb/client.ts)
- Removed unused `IgdbExternalGamesResponse` interface and its barrel exports.

### P3 — Exported IGDB response type remained incorrect (igdb/client.ts)
- Removed `IgdbExternalGamesResponse` — the endpoint returns a flat array, not `{ games }`.

## Review fixes

### Finding 1 — Fixture mode uses separate DB
Both CLIs now use `import.fixture.db` in fixture mode to prevent fake data from
polluting the production database.

### Finding 2 — Stale game reconciliation
`processAndStoreGames` now accepts a `reconcile` flag. When true (only set after
a successful live API fetch), games not in the current response are deleted.
The `steam:export` CLI passes `reconcile=true` only for live mode.

### Finding 3 — Title filter too broad
Replaced blanket `/^Steam\s/i` with specific patterns for known utility names.
"Steam Marines" and "SteamWorld Dig" are no longer filtered. Regression tests
added.

### Finding 4 — Steam validation + cache
- `validateSteamResponse` only normalises a missing games array when
  `game_count === 0`; `game_count > 0` with no array now throws.
- Cache hits are now run through `validateSteamResponse()` too.

### Finding 5 — IGDB pagination sort
Added `sort id asc;` to IGDB requests for stable offset pagination.

### Finding 6 — Deprecated IGDB field
Replaced `category` with `external_game_source` in IGDB queries per the
migration docs. Response type updated accordingly.

### Finding 7 — OAuth cache key scoped to client
Token cache key changed from `igdb:oauth:access_token` to
`igdb:oauth:access_token:${clientId}` so changing `IGDB_CLIENT_ID` doesn't
reuse another app's token.

### Finding 8 — CSV formula injection (OWASP)
Extended protection to cover tab, CR, LF, space, and full-width formula
characters (`＝`, `＋`, `－`, `＠`). Dangerous fields are quoted with a
leading apostrophe per OWASP recommendations.
