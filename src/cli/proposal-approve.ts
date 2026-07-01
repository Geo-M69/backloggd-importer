/**
 * CLI entry point for bulk‑approving exact‑match ownership proposals.
 *
 * Usage:
 *   npm run import:approve-exact
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/proposal-approve.js
 *
 * Pipeline:
 *   1. Open the local database
 *   2. Bulk‑approve eligible exact‑match ownership proposals
 *   3. Print summary
 */

import { openDatabase, closeDatabase } from '../storage/database.js';
import { approveExactMatches } from '../review/approver.js';
import type { ApproveResult } from '../review/approver.js';
import { resolveImportDbPath } from './import-db.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function resolveProposalApproveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveImportDbPath(env).dbPath;
}

export function runProposalApprove(env: NodeJS.ProcessEnv = process.env): ApproveResult {
  const dbPath = resolveProposalApproveDbPath(env);

  try {
    const db = openDatabase(dbPath);

    return approveExactMatches(undefined, db);
  } finally {
    closeDatabase();
  }
}

async function main(): Promise<void> {
  console.log('Approving exact‑match ownership proposals…');
  const result = runProposalApprove(process.env);

  if (result.approved === 0) {
    console.log('No eligible proposals to approve.');
  } else {
    console.log(`  Approved: ${result.approved}`);
    console.log(`  Skipped:  ${result.skipped}`);
  }

  console.log('Bulk approval complete.');
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error('Bulk approval failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
