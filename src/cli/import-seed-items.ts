/**
 * CLI entry point for seeding import_items from an approved manifest.
 *
 * Usage:
 *   npm run import:seed-items -- --manifest <manifest.json>
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/import-seed-items.js --manifest <manifest.json>
 *
 * Options:
 *   --manifest <path>   Required. Path to the approved manifest JSON file.
 *
 * Safety:
 *   This command is local-DB-only.  It does not contact Steam, IGDB,
 *   Backloggd, or any external service.  It does not create confirmation
 *   rows, and it does not call ownership compare/confirm/save code.
 */

import { readFileSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../storage/database.js';
import { seedApprovedManifest } from '../importer/import-items.js';
import type { SeedResult } from '../importer/import-items.js';
import { resolveImportDbPath } from './import-db.js';
import type { ImportManifest } from '../review/manifest.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { hasHelpFlag } from './cli-help.js';

export function resolveSeedItemsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveImportDbPath(env).dbPath;
}

export function runSeedItems(
  manifestPath: string,
  env: NodeJS.ProcessEnv = process.env,
): SeedResult {
  let content: string;
  try {
    content = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Cannot read manifest "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let manifest: ImportManifest;
  try {
    manifest = JSON.parse(content) as ImportManifest;
  } catch (err) {
    throw new Error(
      `Invalid JSON in manifest "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Manifest must be a non-null object.');
  }
  if (typeof manifest.manifestVersion !== 'string') {
    throw new Error('Manifest must have a string manifestVersion field.');
  }
  if (!Array.isArray(manifest.items)) {
    throw new Error('Manifest must have an items array.');
  }

  const dbPath = resolveSeedItemsDbPath(env);
  const db = openDatabase(dbPath);
  try {
    return seedApprovedManifest(db, manifest);
  } finally {
    closeDatabase();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: npm run import:seed-items -- --manifest <manifest.json>');
    console.log();
    console.log('Seed import_items from an approved manifest (local DB only).');
    console.log('Options:');
    console.log('  --manifest <path>    Required. Path to the approved manifest JSON file.');
    process.exit(0);
  }

  const manifestIndex = args.indexOf('--manifest');
  if (manifestIndex === -1 || manifestIndex + 1 >= args.length) {
    console.error('Error: --manifest <path> is required and must be non-empty.');
    console.error('Usage: npm run import:seed-items -- --manifest <manifest.json>');
    process.exit(1);
  }

  const manifestPath = args[manifestIndex + 1];

  let content: string;
  try {
    content = readFileSync(manifestPath, 'utf-8');
  } catch {
    console.error(`Error: Manifest file not found or unreadable: "${manifestPath}"`);
    process.exit(1);
  }

  let manifest: ImportManifest;
  try {
    manifest = JSON.parse(content) as ImportManifest;
  } catch {
    console.error(`Error: Invalid manifest JSON in "${manifestPath}"`);
    process.exit(1);
  }

  if (!manifest || typeof manifest !== 'object') {
    console.error('Error: Manifest must be a non-null object.');
    process.exit(1);
  }
  if (typeof manifest.manifestVersion !== 'string') {
    console.error('Error: Manifest must have a string manifestVersion field.');
    process.exit(1);
  }
  if (!Array.isArray(manifest.items)) {
    console.error('Error: Manifest must have an items array.');
    process.exit(1);
  }

  console.log(`Seeding import_items from manifest: ${manifestPath}`);
  if (manifest.sessionId) {
    console.log(`  Session: ${manifest.sessionId}`);
  }

  let result: SeedResult;
  try {
    result = runSeedItems(manifestPath, process.env);
  } catch (err) {
    console.error('Seed failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`  Manifest proposals:  ${result.totalManifestProposals}`);
  console.log(`  Items created:       ${result.created}`);
  console.log(`  Already present:     ${result.alreadyPresent}`);
  console.log(`  Drifted/skipped:     ${result.drifted}`);
  console.log(`  Preserved (terminal): ${result.preserved}`);
  console.log('Seed complete.');
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error('Seed failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
