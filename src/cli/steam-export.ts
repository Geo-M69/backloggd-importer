/**
 * CLI entry point for the Steam library export pipeline.
 *
 * Usage:
 *   npm run steam:export
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/steam-export.js
 *
 * Pipeline:
 *   1. Load configuration (or fall back to fixture mode)
 *   2. Open the local database
 *   3. Fetch owned games (live API or fixture)
 *   4. Normalise, filter, and store games
 *   5. Export games to JSON and CSV
 *   6. Print summary
 */

import { z } from 'zod';
import { openDatabase, closeDatabase } from '../storage/database.js';
import { fetchOwnedGames } from '../steam/client.js';
import { processAndStoreGames } from '../steam/normalize.js';
import { exportGames } from '../steam/exporter.js';
import { hasHelpFlag } from './cli-help.js';

/**
 * Per-command validation: only STEAM_API_KEY and STEAM_USER_ID are required.
 * IGDB credentials are irrelevant to this command.
 */
const steamConfigSchema = z.object({
  STEAM_API_KEY: z.string().min(1, 'Steam API key is required'),
  STEAM_USER_ID: z.string().min(1, 'Steam user ID is required'),
});

type SteamConfig = z.infer<typeof steamConfigSchema>;

function loadSteamConfig(): SteamConfig | null {
  const result = steamConfigSchema.safeParse(process.env);
  if (!result.success) {
    // If any Steam env var is set (non-empty), partial config is an error.
    // Only return null (fixture mode) when neither var is provided.
    const hasApiKey = !!process.env.STEAM_API_KEY;
    const hasUserId = !!process.env.STEAM_USER_ID;
    if (hasApiKey || hasUserId) {
      throw new Error(
        'Partial Steam credentials: both STEAM_API_KEY and STEAM_USER_ID must be set ' +
          'for live mode, or neither for fixture mode.',
      );
    }
    return null;
  }
  return result.data;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: npm run steam:export');
    console.log();
    console.log('Export a Steam library to the local database and JSON/CSV files.');
    process.exit(0);
  }

  // Try loading config; fall back to fixture mode if missing
  const config = loadSteamConfig();
  const isFixture = !config;
  if (isFixture) {
    console.log('No valid Steam credentials found — running in fixture mode.');
  }

  // Use a separate database for fixture mode so fake data never pollutes
  // the production database. In fixture mode, DB_PATH is ignored to
  // prevent accidental writes to the production database.
  const dbPath = isFixture ? './import.fixture.db' : (process.env.DB_PATH ?? './import.db');

  try {
    const db = openDatabase(dbPath);

    // Step 1: Fetch
    console.log('Fetching owned games…');
    const rawResponse = await fetchOwnedGames(
      config ? { STEAM_API_KEY: config.STEAM_API_KEY, STEAM_USER_ID: config.STEAM_USER_ID } : null,
      db,
    );
    console.log(`  Received ${rawResponse.response.game_count} games from API.`);

    // Step 2: Normalize, filter, store
    console.log('Normalising and filtering…');
    const games = processAndStoreGames(db, rawResponse, !isFixture);
    console.log(`  Stored ${games.length} playable games.`);
    console.log(
      `  Filtered out ${rawResponse.response.game_count - games.length} non-game entries.`,
    );

    // Step 3: Export
    console.log('Exporting…');
    const { jsonPath, csvPath } = await exportGames(db);
    console.log(`  JSON: ${jsonPath}`);
    console.log(`  CSV:  ${csvPath}`);

    console.log('Steam export complete.');
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('Steam export failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
