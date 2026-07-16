/**
 * Phase 5E Slice 3 — ownership workflow regression guardrails.
 *
 * Static and lightweight executable guardrail tests that make it hard for
 * future changes to accidentally create an unsafe ownership workflow path.
 *
 * Each test targets a specific regression risk and documents WHY it exists.
 *
 * ## Safety guarantees
 *
 * - No Playwright import.
 * - No write-guard / final-save selector / allowance helper imported.
 * - No live Backloggd calls.
 * - No real browser creation.
 * - No new runtime orchestrator.
 * - No DB mutations in executable tests (mocked deps).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { OwnershipCompareResult } from '../../src/importer/ownership-compare-command.js';
import type { ImportDbResolution } from '../../src/cli/import-db.js';
import type { OwnershipCompareCliDeps } from '../../src/cli/ownership-compare.js';
import { runOwnershipCompareCli } from '../../src/cli/ownership-compare.js';

// ---------------------------------------------------------------------------
// Constants — paths for source inspection
// ---------------------------------------------------------------------------

const IMPORTER_DIR = resolve('src/importer');
const CLI_DIR = resolve('src/cli');
const BACKLOGGD_DIR = resolve('src/backloggd');
const PACKAGE_JSON_PATH = resolve('package.json');

// ---------------------------------------------------------------------------
// Dynamic source discovery (Finding 1 / Phase 5E Slice 3)
// ---------------------------------------------------------------------------
// WHY: Hardcoded file lists let future source files bypass guardrails.
// Discovered files are automatically included.

function discoverTsFiles(baseDir: string, excludeIndex = true): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        if (excludeIndex && entry.name === 'index.ts') continue;
        results.push(relative(baseDir, fullPath));
      }
    }
  }
  walk(baseDir);
  return results.sort();
}

const IMPORTER_FILES = discoverTsFiles(IMPORTER_DIR);
const CLI_FILES = discoverTsFiles(CLI_DIR);

// Audited Backloggd source files that are ownership-relevant
const AUDITED_BACKLOGGD = [
  'browser.ts',
  'selectors.ts',
  'page-reader.ts',
  'visible-state.ts',
  'comparison.ts',
];

// All ownership-relevant source files under src/backloggd
const BACKLOGGD_AUDIT_FILES = AUDITED_BACKLOGGD;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a source file relative to its base directory. */
function readSource(base: string, name: string): string {
  return readFileSync(resolve(base, name), 'utf-8');
}

/** Return import-from lines that import from a given module basename. */
function importsFrom(source: string, moduleBasename: string): string[] {
  return source.split('\n').filter((l) => l.includes('from') && l.includes(moduleBasename));
}

/** Return true if the source file imports a given module basename (value or type). */
function hasImport(source: string, moduleBasename: string): boolean {
  return importsFrom(source, moduleBasename).length > 0;
}

/**
 * Parse all named imported symbols from import declarations.
 * Handles: import { foo } from ...; import { foo as bar } from ...
 * Returns unique symbol names (original name before 'as').
 */
function parseImportedSymbols(source: string): Set<string> {
  const symbols = new Set<string>();
  const importBlockRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
  let match: RegExpExecArray | null;
  while ((match = importBlockRe.exec(source)) !== null) {
    const block = match[1];
    for (const part of block.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Handle type-only re-exports mixed in: "type Foo, Bar" → "Bar"
      const noTypePrefix = trimmed.replace(/^type\s+/, '');
      // Get the original name before 'as'
      const originalName = noTypePrefix.split(/\s+as\s+/)[0].trim();
      if (originalName) symbols.add(originalName);
    }
  }
  return symbols;
}

/**
 * Check whether a set of imported symbols contains any from the given list.
 */
function importsAnySymbol(imported: Set<string>, symbols: string[]): boolean {
  return symbols.some((s) => imported.has(s));
}

// ---------------------------------------------------------------------------
// Sensitive API symbol groups for barrel/alias import-boundary checks
// (Finding 3 / Phase 5E Slice 3)
// ---------------------------------------------------------------------------

const CONFIRMATION_SYMBOLS = [
  'applyOwnershipConfirmationSelection',
  'confirmExactProposals',
  'confirmAllEligibleProposals',
  'buildAndShowPlan',
];

const SAVE_EXECUTOR_SYMBOLS = ['runConfirmedOwnershipSave', 'executeConfirmedOwnershipSaves'];

const COMPARISON_RUNNER_SYMBOLS = ['runOwnershipComparison', 'runOwnershipCompareCommand'];

const STAGING_EXECUTOR_SYMBOLS = ['stageOwnershipInBrowser', 'runConfirmedOwnershipStaging'];

// ---------------------------------------------------------------------------
// Read all source files once
// ---------------------------------------------------------------------------

const importerSources: Record<string, string> = {};
for (const f of IMPORTER_FILES) {
  importerSources[f] = readSource(IMPORTER_DIR, f);
}

const cliSources: Record<string, string> = {};
for (const f of CLI_FILES) {
  cliSources[f] = readSource(CLI_DIR, f);
}

const backloggdSources: Record<string, string> = {};
for (const f of BACKLOGGD_AUDIT_FILES) {
  backloggdSources[f] = readSource(BACKLOGGD_DIR, f);
}

const PACKAGE_JSON = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
  scripts?: Record<string, string>;
};
const SCRIPTS = PACKAGE_JSON.scripts ?? {};

// ---------------------------------------------------------------------------
// Dynamic source discovery self-test (Finding 1 / Phase 5E Slice 3)
// ---------------------------------------------------------------------------

describe('guardrail — dynamic source discovery includes expected files', () => {
  it('discovers importer command modules (ownership-save-command, ownership-compare-command)', () => {
    expect(IMPORTER_FILES).toContain('ownership-save-command.ts');
    expect(IMPORTER_FILES).toContain('ownership-compare-command.ts');
    expect(IMPORTER_FILES).toContain('ownership-comparison-runner.ts');
    expect(IMPORTER_FILES).toContain('ownership-save-executor.ts');
    expect(IMPORTER_FILES).toContain('ownership-save-confirm-cli.ts');
    expect(IMPORTER_FILES).toContain('ownership-save-confirmation.ts');
    expect(IMPORTER_FILES).toContain('ownership-save-plan.ts');
    expect(IMPORTER_FILES).toContain('ownership-staging-executor.ts');
    expect(IMPORTER_FILES).toContain('import-items.ts');
  });

  it('discovers CLI entrypoints (ownership-compare, ownership-confirm, ownership-save)', () => {
    expect(CLI_FILES).toContain('ownership-compare.ts');
    expect(CLI_FILES).toContain('ownership-confirm.ts');
    expect(CLI_FILES).toContain('ownership-save.ts');
  });

  it('discovers audited backloggd source files', () => {
    for (const f of AUDITED_BACKLOGGD) {
      expect(backloggdSources).toHaveProperty(f);
    }
  });

  it('excludes barrel index.ts files from the dynamic scan', () => {
    expect(IMPORTER_FILES).not.toContain('index.ts');
  });

  it('discovers ownership-relevant backloggd browser modules', () => {
    expect(backloggdSources).toHaveProperty('browser.ts');
    expect(backloggdSources).toHaveProperty('selectors.ts');
  });
});

// ==========================================================================
// Guardrail 1 — No source file defines a one-shot workflow function/command
// ==========================================================================
// WHY: A single compare→confirm→save command would bypass the explicit
// operator gates. Each step must remain an explicit, separable action.
//
// Finding 2 (Phase 5E Slice 3): Apply the full forbidden one-shot workflow
// name set with word-boundary matching across all ownership-relevant files.

describe('guardrail — no one-shot workflow function names', () => {
  const allSourceFiles: { name: string; source: string }[] = [
    ...IMPORTER_FILES.map((f) => ({ name: `src/importer/${f}`, source: importerSources[f] })),
    ...CLI_FILES.map((f) => ({ name: `src/cli/${f}`, source: cliSources[f] })),
    ...BACKLOGGD_AUDIT_FILES.map((f) => ({
      name: `src/backloggd/${f}`,
      source: backloggdSources[f],
    })),
  ];

  // Full forbidden one-shot workflow pattern set with word-boundary matching.
  // Each pattern is a complete identifier that would define or reference
  // a dangerous one-shot workflow command.
  const FORBIDDEN_PATTERNS = [
    /\brunOwnershipWorkflow\b/,
    /\bexecuteOwnershipWorkflow\b/,
    /\brunAllOwnership\b/,
    /\bownershipWorkflow\b/,
    /\bconfirmAndSave\b/,
    /\bcompareConfirmSave\b/,
    /\bautoConfirm\b/,
    /\bautoSave\b/,
    /\brunFullWorkflow\b/,
    /\bexecuteWorkflow\b/,
    /\bchainOwnership\b/,
    /\bcompareAndConfirm\b/,
    /\bcompareAndSave\b/,
  ];

  for (const { name, source } of allSourceFiles) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      it(`${name} does not match pattern ${pattern} in function/const/variable definitions`, () => {
        const lines = source.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          // Skip comment-only lines and JSDoc lines
          if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
          // Only flag definitions, not usage in string literals
          if (
            (trimmed.startsWith('function ') ||
              trimmed.startsWith('const ') ||
              trimmed.startsWith('let ') ||
              trimmed.startsWith('var ') ||
              trimmed.startsWith('export function ') ||
              trimmed.startsWith('export const ') ||
              trimmed.startsWith('export let ') ||
              trimmed.startsWith('export default ') ||
              trimmed.startsWith('async function ')) &&
            pattern.test(trimmed)
          ) {
            expect.unreachable(`File ${name} defines a name matching "${pattern}": ${trimmed}`);
          }
        }
      });
    }
  }
});

// ==========================================================================
// Guardrails 2-4 — Cross-module import boundaries (Finding 3)
// ==========================================================================
// WHY: A module that imports both a "gather" step and an "apply" step
// is one refactor away from short-circuiting the explicit gates.
//
// Finding 3 (Phase 5E Slice 3): Also check for sensitive symbol names
// imported from barrels/aliases (e.g. ../importer/index.js).

describe('guardrail — cross-module import boundaries', () => {
  // Helper: check that a list of files does NOT import both group A and group B.
  // Checks both module-basename imports (legacy) AND named-symbol imports (barrel).
  function checkNoDualImport(
    files: { name: string; source: string }[],
    groupA: string[],
    groupB: string[],
    symbolsA: string[],
    symbolsB: string[],
    labelA: string,
    labelB: string,
  ): void {
    for (const { name, source } of files) {
      it(`${name} does not import both ${labelA} and ${labelB}`, () => {
        // Module-basename check (existing)
        const hasA = groupA.some((mod) => hasImport(source, mod));
        const hasB = groupB.some((mod) => hasImport(source, mod));

        // Named-symbol check (barrel/alias - Finding 3)
        const importedSymbols = parseImportedSymbols(source);
        const hasSymbolA = importsAnySymbol(importedSymbols, symbolsA);
        const hasSymbolB = importsAnySymbol(importedSymbols, symbolsB);

        const bothModule = hasA && hasB;
        const bothSymbol = hasSymbolA && hasSymbolB;

        if (bothModule || bothSymbol) {
          const aLines = groupA.flatMap((mod) => importsFrom(source, mod));
          const bLines = groupB.flatMap((mod) => importsFrom(source, mod));
          const aSymbols = symbolsA.filter((s) => importedSymbols.has(s));
          const bSymbols = symbolsB.filter((s) => importedSymbols.has(s));
          const details: string[] = [];
          if (aLines.length) details.push(`module-A: [${aLines.join('; ')}]`);
          if (bLines.length) details.push(`module-B: [${bLines.join('; ')}]`);
          if (aSymbols.length) details.push(`symbol-A: ${aSymbols.join(', ')}`);
          if (bSymbols.length) details.push(`symbol-B: ${bSymbols.join(', ')}`);
          expect.unreachable(
            `File ${name} imports both ${labelA} and ${labelB}: ${details.join(' | ')}`,
          );
        }
      });
    }
  }

  // Group labels
  const CONFIRMATION_MODULES = ['ownership-save-confirmation', 'ownership-save-confirm-cli'];
  const SAVE_EXECUTOR_MODULES = ['ownership-save-executor', 'ownership-save-command'];
  const COMPARISON_RUNNER = ['ownership-comparison-runner'];
  const STAGING_EXECUTOR = ['ownership-staging-executor'];

  // All non-barrel importer files plus CLI files
  const allChecked = [
    ...IMPORTER_FILES.map((f) => ({ name: `src/importer/${f}`, source: importerSources[f] })),
    ...CLI_FILES.map((f) => ({ name: `src/cli/${f}`, source: cliSources[f] })),
  ];

  // Guardrail 2: No file imports both confirmation AND save executor/command
  checkNoDualImport(
    allChecked,
    CONFIRMATION_MODULES,
    SAVE_EXECUTOR_MODULES,
    CONFIRMATION_SYMBOLS,
    SAVE_EXECUTOR_SYMBOLS,
    'confirmation-selection',
    'save-executor/command',
  );

  // Guardrail 3: No file imports both comparison runner AND save executor/command
  checkNoDualImport(
    allChecked,
    COMPARISON_RUNNER,
    SAVE_EXECUTOR_MODULES,
    COMPARISON_RUNNER_SYMBOLS,
    SAVE_EXECUTOR_SYMBOLS,
    'comparison-runner',
    'save-executor/command',
  );

  // Guardrail 4: No file imports both staging executor AND confirmation
  // The authorized importer is ownership-save-executor.ts (staging executor
  // is a dependency, NOT confirmation).  ownership-save-confirm-cli.ts
  // imports confirmation (authorized) but not staging executor.
  checkNoDualImport(
    allChecked,
    STAGING_EXECUTOR,
    CONFIRMATION_MODULES,
    STAGING_EXECUTOR_SYMBOLS,
    CONFIRMATION_SYMBOLS,
    'staging-executor',
    'confirmation-selection',
  );
});

// ==========================================================================
// Guardrails 5-6 — CLI-specific forbidden imports
// ==========================================================================
// WHY: CLI entry points must not cross the compare/confirm/save boundary.
// Finding 3 additions: also check via symbol names imported from barrels.

describe('guardrail — CLI cross-module import boundaries', () => {
  // Guardrail 5: ownership-compare and ownership-confirm must not import
  // save executor or save command.
  for (const cli of ['ownership-compare.ts', 'ownership-confirm.ts'] as const) {
    it(`${cli} does not import save executor/command`, () => {
      const source = cliSources[cli];
      const imports = [
        ...importsFrom(source, 'ownership-save-executor'),
        ...importsFrom(source, 'ownership-save-command'),
      ];
      expect(imports).toHaveLength(0);
    });

    // Finding 3: barrel-symbol check — must not import save executor symbols
    it(`${cli} does not import save executor/command symbols from barrels`, () => {
      const source = cliSources[cli];
      const symbols = parseImportedSymbols(source);
      const forbidden = SAVE_EXECUTOR_SYMBOLS.filter((s) => symbols.has(s));
      expect(forbidden).toHaveLength(0);
    });
  }

  // Guardrail 6: ownership-save must not import confirmation selection
  // or confirmation CLI.
  it('ownership-save.ts does not import confirmation-selection', () => {
    const source = cliSources['ownership-save.ts'];
    const imports = [
      ...importsFrom(source, 'ownership-save-confirmation'),
      ...importsFrom(source, 'ownership-save-confirm-cli'),
    ];
    expect(imports).toHaveLength(0);
  });

  // Finding 3: barrel-symbol check — must not import confirmation symbols
  it('ownership-save.ts does not import confirmation symbols from barrels', () => {
    const source = cliSources['ownership-save.ts'];
    const symbols = parseImportedSymbols(source);
    const forbidden = CONFIRMATION_SYMBOLS.filter((s) => symbols.has(s));
    expect(forbidden).toHaveLength(0);
  });
});

// ==========================================================================
// Guardrail 7 — Confirm CLI must not import Playwright
// ==========================================================================
// WHY: ownership:confirm is a DB-only operation.  Playwright must not leak
// into the confirmation path.

describe('guardrail — confirm CLI no Playwright', () => {
  it('ownership-confirm.ts does not import Playwright', () => {
    const source = cliSources['ownership-confirm.ts'];
    const playwrightImports = source
      .split('\n')
      .filter((l) => l.includes('import') && l.includes('playwright'));
    expect(playwrightImports).toHaveLength(0);
  });
});

// ==========================================================================
// Guardrail 8 — Compare/save CLI uses shared launcher, not direct Playwright
// ==========================================================================
// WHY: All browser usage must go through the shared launchSession in
// backloggd/browser.ts to ensure write-guard installation.
// Finding 4 (Phase 5E Slice 3): Also explicitly reject chromium/firefox/webkit.launch.

describe('guardrail — compare/save CLI uses shared browser launcher', () => {
  for (const cli of ['ownership-compare.ts', 'ownership-save.ts'] as const) {
    it(`${cli} does not directly import chromium from playwright`, () => {
      const source = cliSources[cli];
      const directChromium = source
        .split('\n')
        .filter(
          (l) => l.includes('import') && l.includes('playwright') && !l.includes('import type'),
        );
      expect(directChromium).toHaveLength(0);
    });

    // Finding 4: Explicitly check for direct Playwright launch calls
    it(`${cli} does not call chromium.launch directly`, () => {
      const source = cliSources[cli];
      expect(source).not.toContain('chromium.launch');
    });

    it(`${cli} does not call firefox.launch directly`, () => {
      const source = cliSources[cli];
      expect(source).not.toContain('firefox.launch');
    });

    it(`${cli} does not call webkit.launch directly`, () => {
      const source = cliSources[cli];
      expect(source).not.toContain('webkit.launch');
    });

    it(`${cli} imports launchSession from backloggd/browser`, () => {
      const source = cliSources[cli];
      expect(source).toContain('launchSession');
      expect(source).toContain('../backloggd/browser.js');
    });
  }
});

// ==========================================================================
// Guardrails 9-10 — Audited module uniqueness
// ==========================================================================
// WHY: enableSaveAllowance, SAVE_API_REGEX, and final-save button selectors
// are sensitive safety-critical constants.  Only the audited modules may
// define them.
// Finding 6 (Phase 5E Slice 3): Also check for raw final-save selector
// value patterns outside the save executor.

describe('guardrail — audited module uniqueness', () => {
  // Guardrail 9: enableSaveAllowance and SAVE_API_REGEX only in browser.ts
  // and ownership-save-executor.ts
  const auditedFiles = [
    resolve(BACKLOGGD_DIR, 'browser.ts'),
    resolve(IMPORTER_DIR, 'ownership-save-executor.ts'),
  ];

  const IMPORTER_PATHS = IMPORTER_FILES.map((f) => resolve(IMPORTER_DIR, f));
  const CLI_PATHS = CLI_FILES.map((f) => resolve(CLI_DIR, f));
  const BACKLOGGD_OWNERSHIP_PATHS = BACKLOGGD_AUDIT_FILES.map((f) => resolve(BACKLOGGD_DIR, f));

  // Collect all source files under src/importer and src/cli plus ownership-relevant backloggd files
  const allCheckPaths = [...IMPORTER_PATHS, ...CLI_PATHS, ...BACKLOGGD_OWNERSHIP_PATHS];

  // enableSaveAllowance and SAVE_API_REGEX
  for (const fp of allCheckPaths) {
    const isAudited = auditedFiles.includes(fp);
    const source = readFileSync(fp, 'utf-8');
    const shortName = fp.replace(resolve('src') + '/', '');

    it(`${shortName} does not define enableSaveAllowance unless audited`, () => {
      if (source.includes('enableSaveAllowance') || source.includes('disableSaveAllowance')) {
        if (!isAudited) {
          expect.unreachable(
            `Non-audited file ${shortName} references enableSaveAllowance/disableSaveAllowance`,
          );
        }
      }
    });

    it(`${shortName} does not define SAVE_API_REGEX unless audited`, () => {
      const lines = source.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.includes('SAVE_API_REGEX') &&
          (trimmed.startsWith('const ') ||
            trimmed.startsWith('export const ') ||
            trimmed.startsWith('let ') ||
            trimmed.startsWith('var '))
        ) {
          if (!isAudited) {
            expect.unreachable(`Non-audited file ${shortName} defines SAVE_API_REGEX`);
          }
        }
      }
    });
  }

  // Guardrail 10: Button names/selectors and final-save selector patterns
  // only in ownership-save-executor.ts (Finding 6)
  const SAVE_EXECUTOR_PATH = resolve(IMPORTER_DIR, 'ownership-save-executor.ts');

  const saveSelectorNames = [
    'ALLOWED_SAVE_NAMES',
    'ALLOWED_SAVE_NAME_PATTERNS',
    'FORBIDDEN_SAVE_TERMS',
  ];

  // Finding 6: Final-save selector value patterns that must NOT appear
  // outside the save executor.
  const FORBIDDEN_SAVE_PATTERNS: RegExp[] = [
    /\/\^save\$\//i,
    /\/\^save changes\$\//i,
    /getByRole\s*\(\s*['"]button['"]\s*,\s*\{\s*name:\s*\/\^save/i,
    /getByRole\s*\(\s*["']button["']\s*,\s*\{\s*name:\s*\/\^save/i,
    /getByRole\s*\(\s*['"]button['"]\s*,\s*\{\s*name:\s*['"]save['"]\s*\}\s*\)/i,
    /getByRole\s*\(\s*['"]button['"]\s*,\s*\{\s*name:\s*['"]save changes['"]\s*\}\s*\)/i,
  ];

  // Final-save button selector cluster strings that must be scoped
  // to the save executor (Finding 6).
  const FORBIDDEN_SAVE_STRINGS = ['save changes'];

  for (const fp of allCheckPaths) {
    const isSaveExecutor = fp === SAVE_EXECUTOR_PATH;
    const source = readFileSync(fp, 'utf-8');
    const shortName = fp.replace(resolve('src') + '/', '');

    // Existing const-name checks
    for (const name of saveSelectorNames) {
      it(`${shortName} does not define ${name} unless it is the save executor`, () => {
        const lines = source.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (
            trimmed.includes(name) &&
            (trimmed.startsWith('const ') ||
              trimmed.startsWith('export const ') ||
              trimmed.startsWith('let ') ||
              trimmed.startsWith('var '))
          ) {
            if (!isSaveExecutor) {
              expect.unreachable(`Non-save-executor file ${shortName} defines ${name}`);
            }
          }
        }
      });
    }

    // Finding 6: Final-save selector value pattern checks
    it(`${shortName} does not contain final-save selector patterns unless it is the save executor`, () => {
      if (isSaveExecutor) return;
      const nonImportLines = source
        .split('\n')
        .filter(
          (l) => !l.includes('import') && !l.trim().startsWith('*') && !l.trim().startsWith('//'),
        );
      const nonImportText = nonImportLines.join('\n');
      for (const pattern of FORBIDDEN_SAVE_PATTERNS) {
        if (pattern.test(nonImportText)) {
          expect.unreachable(
            `Non-save-executor file ${shortName} contains final-save pattern: ${pattern}`,
          );
        }
      }
    });

    it(`${shortName} does not contain final-save string literals unless it is the save executor`, () => {
      if (isSaveExecutor) return;
      const nonImportLines = source
        .split('\n')
        .filter(
          (l) => !l.includes('import') && !l.trim().startsWith('*') && !l.trim().startsWith('//'),
        );
      const nonImportText = nonImportLines.join('\n');
      for (const str of FORBIDDEN_SAVE_STRINGS) {
        // Match as a standalone string literal, not within a comment or import
        const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const stringRe = new RegExp(`['"\`]${escaped}['"\`]`);
        if (stringRe.test(nonImportText)) {
          expect.unreachable(
            `Non-save-executor file ${shortName} contains final-save string "${str}"`,
          );
        }
      }
    });
  }
});

// ==========================================================================
// Guardrail 11 — No command file directly calls transitionItem/reconcileItem
// ==========================================================================
// WHY: transitionItem and reconcileItem must only be called through the
// audited comparison runner or save executor.  CLI files and importer
// command modules must not bypass those layers.
//
// Finding 5 (Phase 5E Slice 3): Extend to importer command modules.

describe('guardrail — CLI and command files do not call transitionItem/reconcileItem', () => {
  const checkedFiles: { name: string; source: string }[] = [
    // CLI files
    ...(['ownership-compare.ts', 'ownership-confirm.ts', 'ownership-save.ts'] as const).map(
      (f) => ({ name: `src/cli/${f}`, source: cliSources[f] }),
    ),
    // Importer command modules (Finding 5)
    ...(['ownership-save-command.ts', 'ownership-compare-command.ts'] as const).map((f) => ({
      name: `src/importer/${f}`,
      source: importerSources[f],
    })),
  ];

  for (const { name, source } of checkedFiles) {
    it(`${name} does not reference transitionItem`, () => {
      const lines = source.split('\n').filter((l) => l.includes('transitionItem('));
      const nonComment = lines.filter((l) => !l.trim().startsWith('*'));
      expect(nonComment).toHaveLength(0);
    });

    it(`${name} does not reference reconcileItem`, () => {
      const lines = source.split('\n').filter((l) => l.includes('reconcileItem('));
      const nonComment = lines.filter((l) => !l.trim().startsWith('*'));
      expect(nonComment).toHaveLength(0);
    });
  }
});

// ==========================================================================
// Guardrail 12 — No CLI/command file directly INSERT/UPDATE/DELETE
// import_item_confirmations
// ==========================================================================
// WHY: INSERT into import_item_confirmations must only happen through the
// audited applyOwnershipConfirmationSelection function.  UPDATE and DELETE
// must go through the audited staging executor.
// Finding 5 (Phase 5E Slice 3): Extend to importer command modules.

describe('guardrail — no direct import_item_confirmations SQL in CLI/command files', () => {
  const checkedFiles: { name: string; source: string }[] = [
    // CLI files
    ...(['ownership-compare.ts', 'ownership-confirm.ts', 'ownership-save.ts'] as const).map(
      (f) => ({ name: `src/cli/${f}`, source: cliSources[f] }),
    ),
    // Importer command modules (Finding 5)
    ...(['ownership-save-command.ts', 'ownership-compare-command.ts'] as const).map((f) => ({
      name: `src/importer/${f}`,
      source: importerSources[f],
    })),
  ];

  for (const { name, source } of checkedFiles) {
    it(`${name} does not directly INSERT INTO import_item_confirmations`, () => {
      const lines = source
        .split('\n')
        .filter((l) => /INSERT\s+INTO\s+import_item_confirmations/i.test(l));
      const nonComment = lines.filter((l) => !l.trim().startsWith('*'));
      expect(nonComment).toHaveLength(0);
    });

    it(`${name} does not directly UPDATE import_item_confirmations`, () => {
      const lines = source.split('\n').filter((l) => /UPDATE\s+import_item_confirmations/i.test(l));
      const nonComment = lines.filter((l) => !l.trim().startsWith('*'));
      expect(nonComment).toHaveLength(0);
    });

    it(`${name} does not directly DELETE FROM import_item_confirmations`, () => {
      const lines = source
        .split('\n')
        .filter((l) => /DELETE\s+FROM\s+import_item_confirmations/i.test(l));
      const nonComment = lines.filter((l) => !l.trim().startsWith('*'));
      expect(nonComment).toHaveLength(0);
    });
  }
});

// ==========================================================================
// Guardrails 13-15 — Package script composition safety (Finding 7)
// ==========================================================================
// WHY: Script chains or accidental inclusion of save in build/test paths
// could create an unsafe execution path.
//
// Finding 7 (Phase 5E Slice 3): Use one CLI-aware ownership command regex
// for all package scripts.  Broaden detection to include direct CLI
// filenames, npm script names, and dist/src paths.

describe('guardrail — package script composition', () => {
  // Finding 7: Comprehensive ownership command regex that matches:
  //   ownership:compare, ownership:confirm, ownership:save
  //   ownership-compare, ownership-confirm, ownership-save
  //   ownership-compare.js, ownership-confirm.js, ownership-save.js
  //   dist/cli/ownership-compare.js, src/cli/ownership-compare.ts, etc.
  const OWNERSHIP_CMD_RE =
    /\b(?:ownership[-:](compare|confirm|save)|(?:dist\/cli\/|src\/cli\/)ownership-(compare|confirm|save)(?:\.(?:js|ts))?)\b/g;

  // Guardrail 13: No script chains multiple ownership commands
  // (Finding 7: broadened regex, no exemption for ownership:save)
  it('no script chains multiple ownership commands', () => {
    for (const [name, value] of Object.entries(SCRIPTS)) {
      if (!value) continue;
      const matches = [...value.matchAll(OWNERSHIP_CMD_RE)];
      if (matches.length < 2) continue;
      const uniqueTypes = new Set(matches.map((m) => m[1] ?? m[2]));
      if (uniqueTypes.size > 1) {
        expect.unreachable(
          `Script "${name}" chains multiple ownership commands: ${value} (types: ${[...uniqueTypes].join(', ')})`,
        );
      }
    }
  });

  // Finding 7: ownership:save must reference only the save CLI, not compare or confirm
  it('ownership:save references only save CLI, not compare or confirm', () => {
    const value = SCRIPTS['ownership:save'];
    if (!value) return;
    const matches = [...value.matchAll(OWNERSHIP_CMD_RE)];
    for (const match of matches) {
      const type = match[1] ?? match[2];
      if (type !== 'save') {
        expect.unreachable(`ownership:save references non-save command "${type}": ${value}`);
      }
    }
  });

  // Guardrail 14: No non-save script references the save CLI directly
  // (Finding 7: using the comprehensive regex)
  it('only ownership:save references the save CLI', () => {
    const savePattern =
      /\b(?:ownership[-:]save|(?:dist\/cli\/|src\/cli\/)ownership-save(?:\.(?:js|ts))?)\b/;
    for (const [name, value] of Object.entries(SCRIPTS)) {
      if (!value) continue;
      if (name === 'ownership:save') continue;
      if (savePattern.test(value)) {
        expect.unreachable(`Script "${name}" references ownership save: ${value}`);
      }
    }

    // Verify the save script itself exists
    expect(SCRIPTS['ownership:save']).toBeDefined();
    expect(SCRIPTS['ownership:save']).toContain('ownership-save');
  });

  // Guardrail 15: Ownership save is NOT part of test, build, import,
  // compare, or confirm scripts.
  it('ownership save not part of test script', () => {
    const testScript = SCRIPTS['test'] ?? '';
    expect(testScript).not.toContain('ownership:save');
    expect(testScript).not.toContain('ownership-save');
  });

  it('ownership save not part of build script', () => {
    const buildScript = SCRIPTS['build'] ?? '';
    expect(buildScript).not.toContain('ownership:save');
    expect(buildScript).not.toContain('ownership-save');
  });

  it('ownership save not part of import scripts', () => {
    for (const [name, value] of Object.entries(SCRIPTS)) {
      if (!value) continue;
      if (name.startsWith('import:')) {
        expect(value).not.toContain('ownership:save');
        expect(value).not.toContain('ownership-save');
      }
    }
  });

  for (const cmd of ['ownership:compare', 'ownership:confirm']) {
    it(`ownership save not part of ${cmd} script`, () => {
      const script = SCRIPTS[cmd] ?? '';
      expect(script).not.toContain('ownership:save');
      expect(script).not.toContain('ownership-save');
    });
  }
});

// ==========================================================================
// Guardrail 16 — Explicit command surfaces still exist
// ==========================================================================
// WHY: Removing or renaming the explicit workflow gates would silently
// break the intended compare → confirm → save workflow.

describe('guardrail — explicit command surfaces exist', () => {
  const EXPECTED_SCRIPTS = ['ownership:compare', 'ownership:confirm', 'ownership:save'];

  for (const script of EXPECTED_SCRIPTS) {
    it(`${script} script exists`, () => {
      expect(SCRIPTS[script]).toBeDefined();
    });

    it(`${script} references the correct CLI entry point`, () => {
      const cliName = script.replace(':', '-');
      expect(SCRIPTS[script]).toContain(`dist/cli/${cliName}.js`);
    });
  }
});

// ==========================================================================
// Guardrail 17 — Save CLI requires --execute-confirmed-ownership-saves
// ==========================================================================
// WHY: Without this opt-in flag, an operator could accidentally trigger
// final save execution by running the save command without understanding
// the consequences.

describe('guardrail — save CLI requires opt-in flag', () => {
  it('ownership-save.ts checks for --execute-confirmed-ownership-saves', () => {
    const source = cliSources['ownership-save.ts'];
    expect(source).toContain('--execute-confirmed-ownership-saves');
    expect(source).toContain('executeConfirmed');
  });

  it('ownership-save.ts rejects missing flag with error', () => {
    const source = cliSources['ownership-save.ts'];
    expect(source).toContain('--execute-confirmed-ownership-saves is required');
  });

  it('ownership-save.ts rejects missing flag before browser launch', () => {
    const source = cliSources['ownership-save.ts'];
    // The flag check must happen before the browser launchSession call
    const flagCheckIndex = source.indexOf('--execute-confirmed-ownership-saves');
    const launchIndex = source.indexOf('launchSession');
    expect(flagCheckIndex).toBeGreaterThan(0);
    expect(launchIndex).toBeGreaterThan(flagCheckIndex);
  });
});

// ==========================================================================
// Guardrail 18 — Confirm CLI requires explicit action
// ==========================================================================
// WHY: The confirm CLI must have an explicit action flag.  Running without
// one must fail before any DB mutation.

describe('guardrail — confirm CLI requires explicit action', () => {
  it('ownership-confirm.ts rejects missing action', () => {
    const source = cliSources['ownership-confirm.ts'];
    expect(source).toContain('No action specified');
    expect(source).toContain('--show-plan');
    expect(source).toContain('--confirm-proposals');
    expect(source).toContain('--confirm-all-eligible');
  });

  it('ownership-confirm.ts rejects conflicting actions', () => {
    const source = cliSources['ownership-confirm.ts'];
    expect(source).toContain('Conflicting actions');
  });

  it('ownership-confirm.ts requires at least one action flag', () => {
    const source = cliSources['ownership-confirm.ts'];
    const actionCount = (
      source.match(/hasFlag\(args, '--(show-plan|confirm-proposals|confirm-all-eligible)'\)/g) ?? []
    ).length;
    // Must check all three flags
    expect(actionCount).toBeGreaterThanOrEqual(3);
  });

  it('ownership-confirm.ts validates --confirm-proposals is non-empty', () => {
    const source = cliSources['ownership-confirm.ts'];
    expect(source).toContain('non-empty proposal ID');
  });

  it('ownership-confirm.ts rejects --confirm-proposals with empty value', () => {
    const source = cliSources['ownership-confirm.ts'];
    // Must check for empty/comma-only values after trimming
    expect(source).toContain('.every((id) => id.length === 0)');
  });
});

// ==========================================================================
// Guardrails 19-21 — Whitespace-only session rejection
// ==========================================================================
// WHY: Each CLI must trim the session ID and reject whitespace-only values
// before opening the database or launching a browser.
//
// Finding 9 (Phase 5E Slice 3): Add executable guardrail for compare CLI
// (which exports a runner).  Save and confirm CLIs do not export runners;
// their whitespace-session behavior is verified by existing executable
// tests in tests/cli/ownership-save.test.ts and
// tests/importer/ownership-save-confirm-cli.test.ts (referenced below).

describe('guardrail — CLI refuses whitespace-only sessions (static)', () => {
  for (const cli of [
    'ownership-compare.ts',
    'ownership-confirm.ts',
    'ownership-save.ts',
  ] as const) {
    const source = cliSources[cli];

    it(`${cli} trims session ID`, () => {
      expect(source).toContain('.trim()');
    });

    it(`${cli} rejects whitespace-only session`, () => {
      const lines = source.split('\n');
      const afterTrim = lines.filter((l) => l.includes('trim()'));
      const afterEmptyCheck = lines.filter(
        (l) => l.includes('must be non-empty') || l.includes('sessionId.length === 0'),
      );
      expect(afterTrim.length).toBeGreaterThanOrEqual(1);
      expect(afterEmptyCheck.length).toBeGreaterThanOrEqual(1);
    });

    it(`${cli} validates session before resolving database`, () => {
      const sourceLines = source.split('\n');
      // Find the trim in the main function body (not in type defs or imports)
      const mainTrimIndex = sourceLines.findIndex(
        (l) => l.includes('.trim()') && (l.includes('sessionId') || l.includes('rawSessionId')),
      );
      // Find the DB path resolution CALL (function call with no space between
      // the function name and the opening paren, which excludes type declarations
      // like `resolveImportDbPath: (env: ...)`).
      const dbResolveIndex = sourceLines.findIndex((l) => l.includes('resolveImportDbPath('));
      // The trim must appear before the DB resolution in execution order
      expect(mainTrimIndex).toBeGreaterThan(0);
      expect(dbResolveIndex).toBeGreaterThan(0);
      expect(mainTrimIndex).toBeLessThan(dbResolveIndex);
    });
  }
});

// ==========================================================================
// Executable guardrail — Compare CLI whitespace session rejection (Finding 9)
// ==========================================================================
// WHY: Validates that the compare CLI (which exports runOwnershipCompareCli)
// returns nonzero and does not open the database or launch a browser when
// passed a whitespace-only --session value.

describe('guardrail — compare CLI executable whitespace session rejection', () => {
  function createFakeDeps(): {
    deps: OwnershipCompareCliDeps;
    calls: Record<string, ReturnType<typeof vi.fn>>;
  } {
    const openDatabase = vi.fn<(dbPath: string) => Database>();
    const closeDatabase = vi.fn<() => void>();
    const launchSession = vi.fn();
    const runOwnershipCompareCommand = vi.fn<() => Promise<OwnershipCompareResult>>();
    const resolveImportDbPath = vi
      .fn<() => ImportDbResolution>()
      .mockReturnValue({ mode: 'fixture', dbPath: ':memory:' });
    const countApprovedOwnershipItems = vi.fn<() => number>().mockReturnValue(0);
    const hasUnsafeComparisonOutcomes = vi.fn<() => boolean>().mockReturnValue(false);
    const formatCompareResult = vi.fn<() => string>().mockReturnValue('');
    const consoleLog = vi.fn<(message: string) => void>();
    const consoleError = vi.fn<(message: string) => void>();

    return {
      deps: {
        openDatabase,
        closeDatabase,
        launchSession,
        runOwnershipCompareCommand,
        resolveImportDbPath,
        countApprovedOwnershipItems,
        hasUnsafeComparisonOutcomes,
        formatCompareResult,
        consoleLog,
        consoleError,
      },
      calls: {
        openDatabase,
        closeDatabase,
        launchSession,
        runOwnershipCompareCommand,
        resolveImportDbPath,
        countApprovedOwnershipItems,
        hasUnsafeComparisonOutcomes,
        formatCompareResult,
        consoleLog,
        consoleError,
      },
    };
  }

  it('returns nonzero when --session value is whitespace only', async () => {
    const { deps } = createFakeDeps();
    const exitCode = await runOwnershipCompareCli(['--session', '   '], deps);
    expect(exitCode).toBe(1);
  });

  it('does not call openDatabase when --session is whitespace only', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', '   '], deps);
    expect(calls.openDatabase).not.toHaveBeenCalled();
  });

  it('does not call launchSession when --session is whitespace only', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', '   '], deps);
    expect(calls.launchSession).not.toHaveBeenCalled();
  });

  it('does not call runOwnershipCompareCommand when --session is whitespace only', async () => {
    const { deps, calls } = createFakeDeps();
    await runOwnershipCompareCli(['--session', '   '], deps);
    expect(calls.runOwnershipCompareCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Whitespace-session coverage for save and confirm CLIs (Finding 9)
// ---------------------------------------------------------------------------
// WHY: ownership-save.ts and ownership-confirm.ts do not export CLI runners
// suitable for dependency injection.  Their whitespace-session rejection
// behavior is covered by existing executable tests:
//
//   - tests/cli/ownership-save.test.ts — static string checks only
//   - tests/importer/ownership-save-command.test.ts — executable test at the
//     command layer (test 3: "fails with whitespace-only session id") uses
//     the real exported executeConfirmedOwnershipSaves function.
//   - tests/importer/ownership-save-confirm-cli.test.ts — executable test 2
//     ("rejects whitespace-only session ID") tests all three entrypoints
//     (buildAndShowPlan, confirmExactProposals, confirmAllEligibleProposals).
//   - tests/importer/ownership-save-confirm-cli-static.test.ts — static checks.
//
// Therefore the guardrails below are STATIC (source-string only), relying
// on the above executable tests for runtime behavior coverage.
describe('guardrail — save/confirm CLI whitespace session coverage reference', () => {
  it('ownership-save.ts session trimming is statically verified above; executable coverage in ownership-save-command.test.ts (test 3)', () => {
    // Static check already done in "CLI refuses whitespace-only sessions"
    const source = cliSources['ownership-save.ts'];
    expect(source).toContain('.trim()');
    expect(source).toContain('must be non-empty');
  });

  it('ownership-confirm.ts session trimming is statically verified above; executable coverage in ownership-save-confirm-cli.test.ts (test 2)', () => {
    // Static check already done in "CLI refuses whitespace-only sessions"
    const source = cliSources['ownership-confirm.ts'];
    expect(source).toContain('.trim()');
    expect(source).toContain('must be non-empty');
  });
});

// ==========================================================================
// Static guardrail — Save CLI failure statuses (Finding 8)
// ==========================================================================
// WHY: The save command must NOT treat blockedWrite, saveFailed,
// verificationFailed, browserFailed, stagingFailed, unsupported, or stale
// as success.  This guardrail is STATIC (source-string only); the
// executable behavior is verified by ownership-save-command.test.ts
// (Finding 2 section) which imports and runs the real
// executeConfirmedOwnershipSaves function with mock executors.

describe('guardrail — save command does not treat failures as success (static)', () => {
  const FAILURE_STATUSES = [
    'blockedWrite',
    'saveFailed',
    'verificationFailed',
    'browserFailed',
    'stagingFailed',
    'unsupported',
    'stale',
  ] as const;

  // The ownership-save.ts formatResultStatus maps these to ✗ prefixes.
  // The save CLI's printResults treats any non-'saved' status as failure.
  it('ownership-save.ts formatResultStatus prefixes each failure with ✗', () => {
    const source = cliSources['ownership-save.ts'];
    for (const status of FAILURE_STATUSES) {
      expect(source).toContain(status);
      // Each failure case must return a ✗-prefixed string
      const returnLine = source
        .split('\n')
        .find((l) => l.includes(`'${status}'`) && l.trimStart().startsWith('case'));
      expect(returnLine).toBeDefined();
      // The next non-blank line after the case should contain ✗
      const sourceLines = source.split('\n');
      const caseIdx = sourceLines.findIndex(
        (l) => l.includes(`'${status}'`) && l.trimStart().startsWith('case'),
      );
      const returnValLine = sourceLines
        .slice(caseIdx, caseIdx + 2)
        .find((l) => l.includes('return'));
      expect(returnValLine).toBeDefined();
      if (returnValLine) {
        expect(returnValLine).toContain('✗');
      }
    }
  });

  it('ownership-save.ts printResults returns true when any result is not saved', () => {
    const source = cliSources['ownership-save.ts'];
    expect(source).toContain('failed > 0');
  });
});

// ==========================================================================
// Static guardrail — Compare CLI delegates to hasUnsafeComparisonOutcomes
// ==========================================================================
// WHY: The compare CLI must correctly delegate to hasUnsafeComparisonOutcomes
// for exit-code decisions.  This section performs source-string checks only;
// executable delegation behavior is covered by
// tests/cli/ownership-compare.test.ts.

describe('guardrail — compare CLI delegates to hasUnsafeComparisonOutcomes', () => {
  it('ownership-compare.ts calls hasUnsafeComparisonOutcomes for exit decision', () => {
    const source = cliSources['ownership-compare.ts'];
    expect(source).toContain('hasUnsafeComparisonOutcomes');
  });

  it('ownership-compare.ts sets exitCode 1 for unsafe outcomes', () => {
    const source = cliSources['ownership-compare.ts'];
    expect(source).toContain('return 1');
  });
});

// ==========================================================================
// Executable guardrail — Compare CLI treats unsupported-kind-only as
// intentional (not failure)
// ==========================================================================
// WHY: Items with unsupported proposal kinds (status/playlog) are skipped
// during ownership comparison.  A result where only unsupported-kind items
// exist is intentional and must not trigger a nonzero exit.

describe('guardrail — compare CLI unsupported-kind-only behavior', () => {
  it('hasUnsafeComparisonOutcomes returns false for unsupportedKind-only', async () => {
    const { hasUnsafeComparisonOutcomes } =
      await import('../../src/importer/ownership-compare-command.js');

    expect(
      hasUnsafeComparisonOutcomes({
        processed: 0,
        alreadyPresent: 0,
        changeNeeded: 0,
        conflict: 0,
        unknown: 0,
        leftImporting: 0,
        malformed: 0,
        unsupportedKind: 3,
      }),
    ).toBe(false);
  });
});
