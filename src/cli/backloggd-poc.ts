/**
 * CLI entry point for Milestone 4 — Backloggd interaction proof of concept.
 *
 * Usage:
 *   npm run backloggd:poc -- --manifest <path>
 *
 * Options:
 *   --manifest <path>        Required. Path to approved manifest JSON.
 *   --profile-dir <path>     Optional. Persistent browser profile directory.
 *                            Default: .playwright/backloggd-profile
 *   --limit <n>              Optional. Max items to process. Default: 1
 *   --steam-app-id <id>      Optional. Filter to specific AppID(s). Repeatable.
 *   --diag-dir <path>        Optional. Diagnostics output directory.
 *                            Default: exports/backloggd-diagnostics
 * Safety: this command NEVER clicks save/submit/update controls.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasHelpFlag } from './cli-help.js';
import {
  loadManifest,
  selectItems,
  launchSession,
  runPocSession,
  writeDiagnostics,
  ManifestValidationError,
} from '../backloggd/index.js';

function getFlagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function getFlagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  let idx = args.indexOf(flag);
  while (idx !== -1 && idx + 1 < args.length) {
    values.push(args[idx + 1]);
    idx = args.indexOf(flag, idx + 1);
  }
  return values;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function parseAppIds(args: readonly string[]): number[] {
  const raw = getFlagValues(args, '--steam-app-id');
  const ids: number[] = [];
  for (const r of raw) {
    for (const part of r.split(',')) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      const n = Number(trimmed);
      if (Number.isFinite(n)) ids.push(n);
    }
  }
  return ids;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (hasHelpFlag(args)) {
    console.log('Usage: npm run backloggd:poc -- --manifest <path> [options]');
    console.log('');
    console.log('Backloggd interaction proof of concept — read-only page inspection.');
    console.log('Options:');
    console.log('  --manifest <path>       Required. Path to approved manifest JSON.');
    console.log('  --profile-dir <path>    Optional. Persistent browser profile directory.');
    console.log('                          Default: .playwright/backloggd-profile');
    console.log('  --limit <n>             Optional. Max items to process. Default: 1');
    console.log('  --steam-app-id <id>     Optional. Filter to specific AppID(s). Repeatable.');
    console.log('  --diag-dir <path>       Optional. Diagnostics output directory.');
    process.exit(0);
  }

  const manifestPath = getFlagValue(args, '--manifest');
  if (!manifestPath) {
    console.error('Error: --manifest <path> is required');
    console.error('Usage: npm run backloggd:poc -- --manifest <path> [options]');
    process.exit(1);
  }

  const profileDir = resolve(
    getFlagValue(args, '--profile-dir') ?? '.playwright/backloggd-profile',
  );
  const limit = Number(getFlagValue(args, '--limit') ?? '1');
  const steamAppIds = parseAppIds(args);
  const diagDir = resolve(getFlagValue(args, '--diag-dir') ?? 'exports/backloggd-diagnostics');
  if (hasFlag(args, '--headless')) {
    console.error('Error: --headless is not supported in Milestone 4.');
    console.error('This proof of concept requires a visible browser for manual sign-in.');
    process.exit(1);
  }

  console.log('Milestone 4 — Backloggd Interaction Proof of Concept');
  console.log('====================================================');
  console.log('Safety: this command NEVER clicks save/submit/update controls.\n');

  // Load manifest
  let manifest;
  try {
    manifest = await loadManifest(resolve(manifestPath));
  } catch (err) {
    if (err instanceof ManifestValidationError) {
      console.error(`Manifest error: ${err.message}`);
    } else {
      console.error(`Failed to load manifest: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  console.log(`Loaded manifest: ${manifest.sessionId}`);
  console.log(`  Total approved items: ${manifest.summary.totalApproved}`);
  console.log(`  Ownership proposals:  ${manifest.summary.ownershipProposals}`);

  // Select items
  const selected = selectItems(manifest, {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 1,
    steamAppIds: steamAppIds.length > 0 ? steamAppIds : undefined,
  });

  if (selected.length === 0) {
    console.log('\nNo eligible items found for POC.');
    console.log(
      'Eligible items need a Backloggd URL and an approved Steam/digital ownership proposal.',
    );
    process.exit(0);
  }

  console.log(`\nSelected ${selected.length} item(s) for POC:`);
  for (const item of selected) {
    console.log(`  - ${item.steamTitle} (AppID ${item.steamAppId}) → ${item.backloggdUrl}`);
  }

  // Launch browser
  console.log(`\nLaunching browser with persistent profile: ${profileDir}`);
  const context = await launchSession({ profileDir });

  try {
    const { results, diagnostics } = await runPocSession(context, selected, manifest.sessionId);

    // Write diagnostics if any were collected
    if (diagnostics.length > 0) {
      const diagPath = await writeDiagnostics(diagDir, diagnostics);
      console.log(`\nDiagnostics written to: ${diagPath}`);
    }

    // Summary — outcome-aware language
    console.log('\n--- POC Summary ---');
    if (results.length === 0) {
      console.log('  No items were processed.');
    } else {
      const preparedCount = results.filter((r) => r.filled && !r.error).length;
      for (const result of results) {
        const status = result.error ? `ERROR: ${result.error}` : 'prepared (save skipped)';
        console.log(`  [${result.item.steamAppId}] ${result.item.steamTitle}: ${status}`);
      }
      if (preparedCount === results.length) {
        console.log(
          `\nMilestone 4 POC finished: ${preparedCount}/${results.length} items prepared. No saves were submitted.`,
        );
      } else {
        console.log(
          `\nMilestone 4 POC finished with failures: ${preparedCount}/${results.length} items prepared. No saves were submitted.`,
        );
      }
    }
  } finally {
    await context.close();
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error('POC failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
