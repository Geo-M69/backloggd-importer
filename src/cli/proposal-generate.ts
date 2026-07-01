/**
 * CLI entry point for proposal generation.
 *
 * Usage:
 *   npm run import:propose
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/proposal-generate.js
 *
 * Pipeline:
 *   1. Load configuration (or fall back to fixture mode)
 *   2. Open the local database
 *   3. Generate proposals from active games and IGDB matches
 *   4. Print summary
 */

import { openDatabase, closeDatabase } from '../storage/database.js';
import { generateProposals } from '../review/generator.js';
import type { GenerateResult } from '../review/generator.js';
import type { ProposalPolicy } from '../models/proposal.js';
import { resolveImportDbPath } from './import-db.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function parseIntArg(args: readonly string[], flag: string): number | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const val = Number(args[idx + 1]);
  return Number.isFinite(val) ? val : undefined;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

export function resolveProposalGenerateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveImportDbPath(env).dbPath;
}

export function runProposalGenerate(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): GenerateResult {
  const dbPath = resolveProposalGenerateDbPath(env);

  // Parse policy flags
  const policy: ProposalPolicy = {};
  const threshold = parseIntArg(args, '--playtime-threshold');
  if (threshold !== undefined) policy.playtimeThresholdMinutes = threshold;
  if (hasFlag(args, '--suggest-backlog')) policy.suggestBacklogWhenZeroPlaytime = true;
  if (hasFlag(args, '--enable-playlog')) policy.enablePlaylogSuggestion = true;

  try {
    const db = openDatabase(dbPath);

    return generateProposals(db, { policy });
  } finally {
    closeDatabase();
  }
}

async function main(): Promise<void> {
  console.log('Generating proposals…');
  const result = runProposalGenerate(process.argv.slice(2), process.env);

  console.log(`  Session:           ${result.sessionId}`);
  console.log(`  Active games:      ${result.totalGames}`);
  console.log(`  Ownership props:   ${result.ownershipProposals}`);
  console.log(`  Status props:      ${result.statusProposals}`);
  console.log(`  Playlog props:     ${result.playlogProposals}`);
  console.log(`  Require review:    ${result.requiresReview}`);

  if (
    result.ownershipProposals === 0 &&
    result.statusProposals === 0 &&
    result.playlogProposals === 0
  ) {
    console.log('No proposals generated.');
  } else {
    console.log('Proposal generation complete.');
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error('Proposal generation failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
