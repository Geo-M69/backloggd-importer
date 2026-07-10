/**
 * CLI entry point for executing confirmed ownership saves (Phase 5D Slice 1).
 *
 * Usage:
 *   npm run ownership:save -- --session <id> --execute-confirmed-ownership-saves
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/ownership-save.js \
 *     --session <session-id> \
 *     --execute-confirmed-ownership-saves
 *
 * Options:
 *   --session <id>                          Required. Import session ID.
 *   --execute-confirmed-ownership-saves     Required. Opt-in to final save execution.
 *   --profile-dir <path>                    Optional. Persistent browser profile directory.
 *                                           Default: .playwright/backloggd-profile
 *   --headless                              Optional. Run browser in headless mode.
 *
 * Safety:
 *   This command has an explicit opt-in flag (--execute-confirmed-ownership-saves)
 *   that MUST be provided.  Without it, the command fails with a clear error.
 *   The flag exists to prevent accidental final save execution from dry-run
 *   or normal import paths.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDatabase, closeDatabase } from '../storage/database.js';
import { resolveImportDbPath } from './import-db.js';
import { launchSession } from '../backloggd/browser.js';
import {
  executeConfirmedOwnershipSaves,
  countConfirmedRows,
} from '../importer/ownership-save-command.js';

// ---------------------------------------------------------------------------
// Flag helpers
// ---------------------------------------------------------------------------

function getFlagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------

function formatResultStatus(status: string): string {
  switch (status) {
    case 'saved':
      return '✓ saved';
    case 'stale':
      return '✗ stale (pre-browser revalidation failed)';
    case 'stagingFailed':
      return '✗ staging failed';
    case 'unsupported':
      return '✗ unsupported editor';
    case 'blockedWrite':
      return '✗ blocked write';
    case 'saveFailed':
      return '✗ save failed';
    case 'verificationFailed':
      return '✗ verification failed';
    case 'browserFailed':
      return '✗ browser failed';
    default:
      return `? ${status}`;
  }
}

function printResults(results: { proposalId: string; status: string; detail?: string }[]): boolean {
  if (results.length === 0) {
    console.log('  No confirmed ownership rows to process.');
    return false;
  }

  for (const r of results) {
    const status = formatResultStatus(r.status);
    console.log(`  [${r.proposalId}] ${status}`);
    if (r.detail) {
      console.log(`       detail: ${r.detail}`);
    }
  }

  const saved = results.filter((r) => r.status === 'saved').length;
  const failed = results.length - saved;
  console.log(`\n  Total: ${results.length} | Saved: ${saved} | Failed: ${failed}`);

  return failed > 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // --- Parse required flags ---
  const rawSessionId = getFlagValue(args, '--session');
  const executeConfirmed = hasFlag(args, '--execute-confirmed-ownership-saves');

  // --- Finding 1: trim session ID immediately after parsing ---
  const sessionId = (rawSessionId ?? '').trim();

  if (!sessionId) {
    console.error('Error: --session <id> is required and must be non-empty.');
    console.error(
      'Usage: npm run ownership:save -- --session <id> --execute-confirmed-ownership-saves',
    );
    process.exit(1);
  }

  if (!executeConfirmed) {
    console.error(
      'Error: --execute-confirmed-ownership-saves is required to enable final save execution.',
    );
    console.error(
      '  This flag is an explicit safety gate — without it, no final saves are performed.',
    );
    process.exit(1);
  }

  const profileDir = resolve(
    getFlagValue(args, '--profile-dir') ?? '.playwright/backloggd-profile',
  );
  const headless = hasFlag(args, '--headless');

  // --- Resolve database ---
  const dbPath = resolveImportDbPath(process.env).dbPath;
  console.log(`Database: ${dbPath}`);

  const db = openDatabase(dbPath);

  try {
    // --- Pre-check: confirmed rows exist before launching browser ---
    const rowCount = countConfirmedRows(db, sessionId);
    console.log(`Session: ${sessionId}`);
    console.log(`Confirmed rows: ${rowCount}`);

    if (rowCount === 0) {
      console.log('No confirmed rows found. Nothing to save.');
      return;
    }

    // --- Launch browser via shared automation path (Finding 3) ---
    console.log(`Launching browser (headless: ${headless})…`);
    const context = await launchSession({ profileDir, headless });
    const page = await context.newPage();

    try {
      // --- Execute confirmed ownership saves ---
      console.log('Executing confirmed ownership saves…');
      const results = await executeConfirmedOwnershipSaves({
        db,
        sessionId,
        confirmedSaveEnabled: true,
        page,
      });

      console.log('\n--- Result ---');
      const hasFailures = printResults(results);

      // --- Finding 2: exit nonzero if any result is not saved ---
      if (hasFailures) {
        process.exitCode = 1;
      }
    } finally {
      await context.close();
    }
  } finally {
    closeDatabase();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error('Ownership save failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
