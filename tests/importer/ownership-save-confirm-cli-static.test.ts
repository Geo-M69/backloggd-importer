/**
 * Static safety tests for the ownership save confirmation CLI integration
 * (Phase 5D Slice 2).
 *
 * These tests verify by source inspection that the new module:
 *
 * - Does not import Playwright.
 * - Does not import Backloggd browser launcher.
 * - Does not import final-save executor (`runConfirmedOwnershipSave`).
 * - Does not import staging executor (`runConfirmedOwnershipStaging`,
 *   `stageOwnershipInBrowser`).
 * - Does not contain save/staging selector strings.
 * - Does not import `processItem`, `transitionItem`, or `reconcileItem`.
 * - Confirmation rows are created only via the audited
 *   `applyOwnershipConfirmationSelection` function.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODULE_SOURCE_PATH = resolve('src/importer/ownership-save-confirm-cli.ts');
const CLI_SOURCE_PATH = resolve('src/cli/ownership-confirm.ts');

const MODULE_SOURCE = readFileSync(MODULE_SOURCE_PATH, 'utf-8');
const CLI_SOURCE = readFileSync(CLI_SOURCE_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Import checks — module
// ---------------------------------------------------------------------------

describe('ownership-save-confirm-cli — static import safety (module)', () => {
  it('does not import playwright', () => {
    const lines = MODULE_SOURCE.split('\n');
    const playwrightImports = lines.filter((l) => l.includes('import') && l.includes('playwright'));
    expect(playwrightImports).toHaveLength(0);
  });

  it('does not import backloggd browser launcher', () => {
    const forbidden = ['backloggd/browser', 'launchSession'];
    for (const term of forbidden) {
      const lines = MODULE_SOURCE.split('\n').filter(
        (l) => l.includes('import') && l.includes(term),
      );
      expect(lines).toHaveLength(0);
    }
  });

  it('does not import final-save executor (runConfirmedOwnershipSave)', () => {
    const lines = MODULE_SOURCE.split('\n');
    const finalSaveImports = lines.filter(
      (l) => l.includes('import') && l.includes('runConfirmedOwnershipSave'),
    );
    expect(finalSaveImports).toHaveLength(0);
  });

  it('does not import staging executor (runConfirmedOwnershipStaging or stageOwnershipInBrowser)', () => {
    const forbidden = ['runConfirmedOwnershipStaging', 'stageOwnershipInBrowser'];
    for (const term of forbidden) {
      const importLines = MODULE_SOURCE.split('\n').filter(
        (l) => l.includes('import') && l.includes(term),
      );
      expect(importLines).toHaveLength(0);
    }
  });

  it('does not import processItem', () => {
    const importLines = MODULE_SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('processItem'),
    );
    expect(importLines).toHaveLength(0);
  });

  it('does not import transitionItem', () => {
    const importLines = MODULE_SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('transitionItem'),
    );
    expect(importLines).toHaveLength(0);
  });

  it('does not import reconcileItem', () => {
    const importLines = MODULE_SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('reconcileItem'),
    );
    expect(importLines).toHaveLength(0);
  });

  it('does not contain save/staging selector strings', () => {
    const selectorPatterns = [
      /role=dialog/i,
      /select\[name="platform"\]/,
      /select\[name="ownership_type"\]/,
    ];

    for (const pattern of selectorPatterns) {
      const nonImportLines = MODULE_SOURCE.split('\n').filter(
        (l) => !l.includes('import') && !l.includes('export.*from'),
      );
      const nonImportText = nonImportLines.join('\n');
      expect(nonImportText).not.toMatch(pattern);
    }
  });

  it('confirmation rows are created only via applyOwnershipConfirmationSelection', () => {
    // The module must call applyOwnershipConfirmationSelection for all
    // confirmation creation paths, and must NOT have any direct INSERT into
    // import_item_confirmations.
    const nonCommentLines = MODULE_SOURCE.split('\n').filter(
      (l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'),
    );
    const nonImportText = nonCommentLines.join('\n');

    // Must call applyOwnershipConfirmationSelection
    expect(nonImportText).toContain('applyOwnershipConfirmationSelection');

    // Must NOT have direct INSERT statements for confirmations
    const insertMatch = nonImportText.match(/INSERT\s+INTO\s+import_item_confirmations/i);
    expect(insertMatch).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Finding 1 — empty/whitespace token rejection in exact selection
  // -----------------------------------------------------------------------
  it('Finding 1: confirmExactProposals does not use a `.filter(pid => pid.length > 0)` pattern after trim', () => {
    // Regression: a previous implementation silently filtered empty tokens
    // after trim, which allowed the call to confirm only the valid IDs and
    // ignore the empty ones.  The fixed implementation must reject the
    // whole call as soon as any token trims to empty.
    const nonCommentLines = MODULE_SOURCE.split('\n').filter(
      (l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'),
    );
    const nonImportText = nonCommentLines.join('\n');
    // Look for a filter that drops empty strings within the proposalIds
    // trimming block.
    expect(nonImportText).not.toMatch(/\.filter\(\s*\(\s*pid\s*\)\s*=>\s*pid\.length\s*>\s*0\s*\)/);
  });

  it('Finding 1: confirmExactProposals throws when any token trims to empty', () => {
    // Extract just the confirmExactProposals function body so that
    // unrelated docstrings (which mention "non-empty after trim" for the
    // session ID) don't accidentally satisfy the check.
    const fnMatch = MODULE_SOURCE.match(/export function confirmExactProposals[\s\S]*?\n\}/);
    expect(fnMatch).not.toBeNull();
    if (fnMatch) {
      // The function should explicitly throw when any token trims to
      // empty.  The throw should be inside the per-token loop, not just
      // an empty-array guard.
      expect(fnMatch[0]).toMatch(/non-empty after trim/);
      // And the throw must use Error or a subclass of it.
      expect(fnMatch[0]).toMatch(/throw new Error/);
    }
  });
});

// ---------------------------------------------------------------------------
// Import checks — CLI
// ---------------------------------------------------------------------------

describe('ownership-confirm — static import safety (CLI)', () => {
  it('does not import playwright', () => {
    const playwrightImports = CLI_SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('playwright'),
    );
    expect(playwrightImports).toHaveLength(0);
  });

  it('does not import backloggd browser launcher', () => {
    const forbidden = ['backloggd/browser', 'launchSession'];
    for (const term of forbidden) {
      const lines = CLI_SOURCE.split('\n').filter((l) => l.includes('import') && l.includes(term));
      expect(lines).toHaveLength(0);
    }
  });

  it('does not import final-save executor', () => {
    const finalSaveImports = CLI_SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('runConfirmedOwnershipSave'),
    );
    expect(finalSaveImports).toHaveLength(0);
  });

  it('does not import staging executor', () => {
    const forbidden = ['runConfirmedOwnershipStaging', 'stageOwnershipInBrowser'];
    for (const term of forbidden) {
      const importLines = CLI_SOURCE.split('\n').filter(
        (l) => l.includes('import') && l.includes(term),
      );
      expect(importLines).toHaveLength(0);
    }
  });

  it('does not import processItem, transitionItem, or reconcileItem', () => {
    const forbidden = ['processItem', 'transitionItem', 'reconcileItem'];
    for (const term of forbidden) {
      const importLines = CLI_SOURCE.split('\n').filter(
        (l) => l.includes('import') && l.includes(term),
      );
      expect(importLines).toHaveLength(0);
    }
  });

  // -----------------------------------------------------------------------
  // Finding 2 — conflicting-action detection by flag presence
  // -----------------------------------------------------------------------
  it('Finding 2: CLI counts --confirm-proposals by flag presence, not by value', () => {
    // The CLI must use hasFlag() (or equivalent `.includes`) to detect
    // presence of --confirm-proposals when counting actions.  This ensures
    // an empty value still counts as the action being present.
    expect(CLI_SOURCE).toMatch(/hasFlag\(args,\s*['"]--confirm-proposals['"]\)/);
  });

  it('Finding 2: action exclusivity check runs before any DB read/write', () => {
    // The conflicting-action guard must be checked BEFORE openDatabase() is
    // called.
    const actionGuardIdx = CLI_SOURCE.indexOf('Conflicting actions');
    const dbOpenIdx = CLI_SOURCE.indexOf('openDatabase(');
    expect(actionGuardIdx).toBeGreaterThan(-1);
    expect(dbOpenIdx).toBeGreaterThan(-1);
    expect(actionGuardIdx).toBeLessThan(dbOpenIdx);
  });

  it('Finding 2: --confirm-proposals value validation is not used for action counting', () => {
    // The variable used for the action-counting array must be the flag
    // presence boolean, not the value.
    const nonCommentLines = CLI_SOURCE.split('\n').filter(
      (l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'),
    );
    const nonCommentText = nonCommentLines.join('\n');
    // Look for the actionCount computation: it should reference the
    // confirmProposalsPresent (or hasFlag result) variable, not the value
    // variable.
    const actionCountMatch = nonCommentText.match(/actionCount\s*=\s*\[([^\]]+)\]/);
    expect(actionCountMatch).not.toBeNull();
    if (actionCountMatch) {
      const inside = actionCountMatch[1];
      expect(inside).not.toMatch(/!!rawConfirmProposals/);
      expect(inside).not.toMatch(/rawConfirmProposals\s*\?\?/);
    }
  });

  // -----------------------------------------------------------------------
  // Finding 3 — rejected-result exit status
  // -----------------------------------------------------------------------
  it('Finding 3: CLI uses computeConfirmExitCode helper for the exit code', () => {
    // The CLI must centralize the exit-code decision in a helper so
    // tests can verify behavior without spawning a subprocess.
    expect(CLI_SOURCE).toContain('computeConfirmExitCode');
  });

  it('Finding 3: computeConfirmExitCode considers rejected length', () => {
    // The helper must return true when result.rejected.length > 0.
    const helperMatch = CLI_SOURCE.match(/export function computeConfirmExitCode[\s\S]*?\n\}/);
    expect(helperMatch).not.toBeNull();
    if (helperMatch) {
      expect(helperMatch[0]).toMatch(/result\.rejected\.length\s*>\s*0/);
    }
  });

  it('Finding 3: CLI helper considers rejected (not just confirmed/alreadyConfirmed empty)', () => {
    // Regression: prior behavior only treated
    // `confirmed.length === 0 && alreadyConfirmed.length === 0` as a
    // failure, ignoring rejected.  The new helper must explicitly consider
    // rejected.
    const helperMatch = CLI_SOURCE.match(/export function computeConfirmExitCode[\s\S]*?\n\}/);
    expect(helperMatch).not.toBeNull();
    if (helperMatch) {
      // The helper must check `rejected.length > 0` BEFORE the
      // confirmed/alreadyConfirmed emptiness check.
      const rejectedIdx = helperMatch[0].search(/result\.rejected\.length\s*>\s*0/);
      const emptyIdx = helperMatch[0].search(
        /result\.confirmed\.length\s*===\s*0\s*&&\s*result\.alreadyConfirmed\.length\s*===\s*0/,
      );
      expect(rejectedIdx).toBeGreaterThanOrEqual(0);
      expect(emptyIdx).toBeGreaterThanOrEqual(0);
      expect(rejectedIdx).toBeLessThan(emptyIdx);
    }
  });

  it('Finding 3: main() uses computeConfirmExitCode helper rather than inline decision', () => {
    // Strip the helper function from the source before checking the main
    // flow — the helper itself contains the same predicates.
    const helperMatch = CLI_SOURCE.match(/export function computeConfirmExitCode[\s\S]*?\n\}/);
    expect(helperMatch).not.toBeNull();
    if (helperMatch) {
      const mainOnly = CLI_SOURCE.replace(helperMatch[0], '');
      // The main() function should not contain a direct
      // `result.confirmed.length === 0 && result.alreadyConfirmed.length === 0`
      // check any more — it must go through the helper.
      expect(mainOnly).not.toMatch(
        /if\s*\(\s*result\.confirmed\.length\s*===\s*0\s*&&\s*result\.alreadyConfirmed\.length\s*===\s*0\s*\)/,
      );
    }
  });

  it('Finding 3: computeConfirmExitCode is exported', () => {
    // Must be exported so tests can import and verify directly.
    expect(CLI_SOURCE).toMatch(/export function computeConfirmExitCode/);
  });
});
