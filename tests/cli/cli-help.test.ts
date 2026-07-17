import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function sourceOf(cliName: string): string {
  return readFileSync(resolve(`src/cli/${cliName}.ts`), 'utf-8');
}

// ---------------------------------------------------------------------------
// Shared helper — cli-help.ts
// ---------------------------------------------------------------------------

describe('cli-help.ts — shared helper', () => {
  const source = sourceOf('cli-help');

  it('exports hasHelpFlag function', () => {
    expect(source).toContain('export function hasHelpFlag');
  });

  it('detects --help flag', () => {
    expect(source).toContain("args.includes('--help')");
  });

  it('detects -h flag', () => {
    expect(source).toContain("args.includes('-h')");
  });
});

// ---------------------------------------------------------------------------
// Each CLI’s main() must check --help before any side effect
// ---------------------------------------------------------------------------

interface CliHelpExpectation {
  name: string;
  sourceName: string;
  npmScript?: string;
  usagePattern: RegExp;
}

const cliEntries: CliHelpExpectation[] = [
  {
    name: 'steam:export',
    sourceName: 'steam-export',
    usagePattern: /Usage: npm run steam:export/,
  },
  {
    name: 'igdb:match',
    sourceName: 'igdb-match',
    usagePattern: /Usage: npm run igdb:match/,
  },
  {
    name: 'import:propose',
    sourceName: 'proposal-generate',
    usagePattern: /Usage: npm run import:propose/,
  },
  {
    name: 'import:approve-exact',
    sourceName: 'proposal-approve',
    usagePattern: /Usage: npm run import:approve-exact/,
  },
  {
    name: 'import:manifest',
    sourceName: 'proposal-manifest',
    usagePattern: /Usage: npm run import:manifest/,
  },
  {
    name: 'ownership:compare',
    sourceName: 'ownership-compare',
    usagePattern: /Usage: npm run ownership:compare/,
  },
  {
    name: 'ownership:confirm',
    sourceName: 'ownership-confirm',
    usagePattern: /Usage: npm run ownership:confirm/,
  },
  {
    name: 'ownership:save',
    sourceName: 'ownership-save',
    usagePattern: /Usage: npm run ownership:save/,
  },
  {
    name: 'backloggd:poc',
    sourceName: 'backloggd-poc',
    usagePattern: /Usage: npm run backloggd:poc/,
  },
];

describe('CLI help safety — all entrypoints', () => {
  for (const entry of cliEntries) {
    const source = sourceOf(entry.sourceName);

    describe(`${entry.name} (${entry.sourceName}.ts)`, () => {
      it('imports hasHelpFlag from cli-help', () => {
        expect(source).toContain("import { hasHelpFlag } from './cli-help.js'");
      });

      it('has usage text with npm run pattern', () => {
        expect(source).toMatch(entry.usagePattern);
      });

      it('exits or returns 0 for help', () => {
        const usesProcessExit0 = source.includes('process.exit(0)');
        const usesReturn0 = source.includes('return 0');
        expect(usesProcessExit0 || usesReturn0).toBe(true);
      });

      it('checks help before any DB or external work', () => {
        const helpWithArgs = source.includes('hasHelpFlag(args)');
        const helpWithArgv = source.includes('hasHelpFlag(argv)');
        expect(helpWithArgs || helpWithArgv).toBe(true);
        const callPattern = helpWithArgs ? 'hasHelpFlag(args)' : 'hasHelpFlag(argv)';
        const helpLine = source.indexOf(callPattern);
        expect(helpLine).not.toBe(-1);
        const functionStartSearch = source.indexOf('async function main');
        const runnerStartSearch = source.indexOf('export async function runOwnershipCompareCli');
        const mainStart = functionStartSearch !== -1 ? functionStartSearch : runnerStartSearch;
        expect(mainStart).not.toBe(-1);
        const helpIndex = source.indexOf(callPattern, mainStart);

        const beforeHelp = source.slice(mainStart, helpIndex);

        const dbOpens = (beforeHelp.match(/openDatabase/g) || []).length;
        const apiCalls = (
          beforeHelp.match(
            /fetchOwnedGames|matchGames|generateProposals|approveExactMatches|buildManifest|launchSession|buildAndShowPlan|executeConfirmedOwnershipSaves|runOwnershipCompareCommand/g,
          ) || []
        ).length;

        expect(dbOpens).toBe(0);
        expect(apiCalls).toBe(0);
      });
    });
  }
});
