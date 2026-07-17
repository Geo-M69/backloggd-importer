/**
 * CLI entry point for exporting the approved import manifest.
 *
 * Usage:
 *   npm run import:manifest
 *
 * Or directly:
 *   node --import dotenv/config dist/cli/proposal-manifest.js
 *
 * Writes the manifest as JSON to stdout by default, or to a file
 * when the --output flag is provided.
 *
 * Options:
 *   --output <path>   Write manifest to a file instead of stdout
 *   --session <id>    Export only proposals for the given session
 */

import { writeFile } from 'node:fs/promises';
import { openDatabase, closeDatabase } from '../storage/database.js';
import { buildManifest } from '../review/manifest.js';
import type { ImportManifest } from '../review/manifest.js';
import { resolveImportDbPath } from './import-db.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { hasHelpFlag } from './cli-help.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: npm run import:manifest');
    console.log();
    console.log('Export the approved import manifest as JSON.');
    console.log('Options:');
    console.log('  --output <path>    Write manifest to a file instead of stdout');
    console.log('  --session <id>     Export only proposals for the given session');
    process.exit(0);
  }

  console.log('Building import manifest\u2026');
  const result = await runProposalManifest(args, process.env);

  if (result.outputPath) {
    console.log(`  Manifest written to: ${result.outputPath}`);
  } else {
    process.stdout.write(result.json);
  }

  console.log(`  Approved games:   ${result.manifest.summary.totalApproved}`);
  console.log(`  Ownership items:  ${result.manifest.summary.ownershipProposals}`);
  console.log(`  Status items:     ${result.manifest.summary.statusProposals}`);
  console.log(`  Playlog items:    ${result.manifest.summary.playlogProposals}`);
  console.log('Manifest export complete.');
}

export function resolveProposalManifestDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveImportDbPath(env).dbPath;
}

export async function runProposalManifest(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ manifest: ImportManifest; json: string; outputPath?: string }> {
  const dbPath = resolveProposalManifestDbPath(env);
  const outputPath = getFlagValueFromArgs(args, '--output');
  const sessionId = getFlagValueFromArgs(args, '--session');

  try {
    const db = openDatabase(dbPath);

    const manifest = buildManifest(sessionId, db);
    const json = JSON.stringify(manifest, null, 2) + '\n';

    if (outputPath) {
      await writeFile(outputPath, json, 'utf-8');
      return { manifest, json, outputPath };
    }

    return { manifest, json };
  } finally {
    closeDatabase();
  }
}

function getFlagValueFromArgs(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  main().catch((error) => {
    console.error('Manifest export failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
