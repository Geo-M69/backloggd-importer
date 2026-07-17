/**
 * CLI entry point for the IGDB matching pipeline.
 *
 * Usage:
 *   npm run igdb:match
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/igdb-match.js
 *
 * Pipeline:
 *   1. Load configuration (or fall back to fixture mode)
 *   2. Open the local database
 *   3. Match unmatched Steam AppIDs against IGDB
 *   4. Print summary
 */

import { z } from 'zod';
import { openDatabase, closeDatabase } from '../storage/database.js';
import { matchGames } from '../igdb/matcher.js';
import { hasHelpFlag } from './cli-help.js';

/**
 * Per-command validation: only IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are required.
 * Steam credentials are irrelevant to this command.
 */
const igdbConfigSchema = z.object({
  IGDB_CLIENT_ID: z.string().min(1, 'IGDB client ID is required'),
  IGDB_CLIENT_SECRET: z.string().min(1, 'IGDB client secret is required'),
});

type IgdbConfig = z.infer<typeof igdbConfigSchema>;

function loadIgdbConfig(): IgdbConfig | null {
  const result = igdbConfigSchema.safeParse(process.env);
  if (!result.success) {
    // If any IGDB env var is set (non-empty), partial config is an error.
    // Only return null (fixture mode) when neither var is provided.
    const hasClientId = !!process.env.IGDB_CLIENT_ID;
    const hasClientSecret = !!process.env.IGDB_CLIENT_SECRET;
    if (hasClientId || hasClientSecret) {
      throw new Error(
        'Partial IGDB credentials: both IGDB_CLIENT_ID and IGDB_CLIENT_SECRET must be set ' +
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
    console.log('Usage: npm run igdb:match');
    console.log();
    console.log(
      'Match Steam games against IGDB to identify exact, ambiguous, and unmatched titles.',
    );
    console.log('Options:');
    console.log('  --force    Re-match already matched games');
    process.exit(0);
  }

  // Parse CLI flags
  const force = process.argv.includes('--force');

  // Try loading config; fall back to fixture mode if missing
  const config = loadIgdbConfig();
  const isFixture = !config;
  if (isFixture) {
    console.log('No valid IGDB credentials found — running in fixture mode.');
  }

  // Use a separate database for fixture mode so fake data never pollutes
  // the production database. In fixture mode, DB_PATH is ignored to
  // prevent accidental writes to the production database.
  const dbPath = isFixture ? './import.fixture.db' : (process.env.DB_PATH ?? './import.db');

  try {
    const db = openDatabase(dbPath);

    console.log('Matching Steam games against IGDB…');
    const stats = await matchGames(
      config?.IGDB_CLIENT_ID,
      config?.IGDB_CLIENT_SECRET,
      db,
      undefined,
      force,
    );

    console.log(`  Total unmatched:   ${stats.totalUnmatched}`);
    console.log(`  Exact matches:     ${stats.exactMatches}`);
    console.log(`  Ambiguous matches: ${stats.ambiguousMatches}`);
    console.log(`  Still unmatched:   ${stats.unmatched}`);
    if (stats.errors > 0) {
      console.log(`  Errors:            ${stats.errors}`);
    }

    console.log('Matching complete.');
  } finally {
    closeDatabase();
  }
}

main().catch((error) => {
  console.error('IGDB matching failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
