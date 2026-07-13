/**
 * Static safety tests for the ownership compare command (Phase 5D Slice 3).
 *
 * These tests verify by source inspection that the integration module:
 *
 * - Does not import `runConfirmedOwnershipSave` (final-save executor).
 * - Does not import `executeConfirmedOwnershipSaves` (confirmed-save command).
 * - Does not import `applyOwnershipConfirmationSelection` (confirmation selection).
 * - Does not import `confirmExactProposals` or `confirmAllEligibleProposals` (confirm CLI).
 * - Does not import `runConfirmedOwnershipStaging` or `stageOwnershipInBrowser` (staging executor).
 * - Does not import `processItem`.
 * - Does not import `transitionItem`.
 * - Does not import `reconcileItem`.
 * - Does not define final-save selector strings.
 * - Does not define write-guard allowance logic.
 * - Browser creation uses shared `launchSession` or existing shared browser factory.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMMAND_SOURCE_PATH = resolve('src/importer/ownership-compare-command.ts');
const SOURCE = readFileSync(COMMAND_SOURCE_PATH, 'utf-8');

const CLI_SOURCE_PATH = resolve('src/cli/ownership-compare.ts');
const CLI_SOURCE = readFileSync(CLI_SOURCE_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Import checks — integration module
// ---------------------------------------------------------------------------

describe('ownership-compare-command — static import safety', () => {
  // -----------------------------------------------------------------------
  // Test: does not import final-save executor
  // -----------------------------------------------------------------------
  it('does not import runConfirmedOwnershipSave', () => {
    const lines = SOURCE.split('\n');
    const finalSaveImports = lines.filter(
      (l) => l.includes('import') && l.includes('runConfirmedOwnershipSave'),
    );
    expect(finalSaveImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not import confirmed-save command
  // -----------------------------------------------------------------------
  it('does not import executeConfirmedOwnershipSaves', () => {
    const lines = SOURCE.split('\n');
    const confirmedSaveImports = lines.filter(
      (l) => l.includes('import') && l.includes('executeConfirmedOwnershipSaves'),
    );
    expect(confirmedSaveImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not import confirmation-selection
  // -----------------------------------------------------------------------
  it('does not import applyOwnershipConfirmationSelection', () => {
    const lines = SOURCE.split('\n');
    const confirmationImports = lines.filter(
      (l) => l.includes('import') && l.includes('applyOwnershipConfirmationSelection'),
    );
    expect(confirmationImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not import confirmation CLI
  // -----------------------------------------------------------------------
  it('does not import confirmExactProposals or confirmAllEligibleProposals', () => {
    const forbidden = ['confirmExactProposals', 'confirmAllEligibleProposals'];
    for (const term of forbidden) {
      const importLines = SOURCE.split('\n').filter(
        (l) => l.includes('import') && l.includes(term),
      );
      expect(importLines).toHaveLength(0);
    }
  });

  // -----------------------------------------------------------------------
  // Test: does not import staging executor
  // -----------------------------------------------------------------------
  it('does not import runConfirmedOwnershipStaging or stageOwnershipInBrowser', () => {
    const forbidden = ['runConfirmedOwnershipStaging', 'stageOwnershipInBrowser'];
    for (const term of forbidden) {
      const importLines = SOURCE.split('\n').filter(
        (l) => l.includes('import') && l.includes(term),
      );
      expect(importLines).toHaveLength(0);
    }
  });

  // -----------------------------------------------------------------------
  // Test: does not import processItem
  // -----------------------------------------------------------------------
  it('does not import processItem', () => {
    const lines = SOURCE.split('\n');
    const processItemImports = lines.filter(
      (l) => l.includes('import') && l.includes('processItem'),
    );
    expect(processItemImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not import transitionItem
  // -----------------------------------------------------------------------
  it('does not import transitionItem', () => {
    const lines = SOURCE.split('\n');
    const transitionItemImports = lines.filter(
      (l) => l.includes('import') && l.includes('transitionItem'),
    );
    expect(transitionItemImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not import reconcileItem
  // -----------------------------------------------------------------------
  it('does not import reconcileItem', () => {
    const lines = SOURCE.split('\n');
    const reconcileItemImports = lines.filter(
      (l) => l.includes('import') && l.includes('reconcileItem'),
    );
    expect(reconcileItemImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not define final-save selector strings
  // -----------------------------------------------------------------------
  it('does not define final-save selector strings', () => {
    const selectorPatterns = [
      /role=dialog/i,
      /select\[name="platform"\]/,
      /select\[name="ownership_type"\]/,
      /role=button.*name=/i,
      /getByRole.*button.*save/i,
    ];

    for (const pattern of selectorPatterns) {
      const nonImportLines = SOURCE.split('\n').filter(
        (l) => !l.includes('import') && !l.includes('export.*from'),
      );
      const nonImportText = nonImportLines.join('\n');
      expect(nonImportText).not.toMatch(pattern);
    }
  });

  // -----------------------------------------------------------------------
  // Test: does not define write-guard allowance logic
  // -----------------------------------------------------------------------
  it('does not define write-guard allowance logic', () => {
    const allowancePatterns = [
      /installWriteGuard/,
      /enableSaveAllowance/,
      /disableSaveAllowance/,
      /wasSavePostSeen/,
      /writeGuard/,
    ];

    for (const pattern of allowancePatterns) {
      const nonImportLines = SOURCE.split('\n').filter(
        (l) => !l.includes('import') && !l.includes('export.*from'),
      );
      const nonImportText = nonImportLines.join('\n');
      expect(nonImportText).not.toMatch(pattern);
    }
  });

  // -----------------------------------------------------------------------
  // Test: does not call processItem
  // -----------------------------------------------------------------------
  it('does not call processItem', () => {
    expect(SOURCE).not.toMatch(/processItem\(/);
  });

  // -----------------------------------------------------------------------
  // Test: does not call transitionItem
  // -----------------------------------------------------------------------
  it('does not call transitionItem', () => {
    expect(SOURCE).not.toMatch(/transitionItem\(/);
  });

  // -----------------------------------------------------------------------
  // Test: does not call reconcileItem
  // -----------------------------------------------------------------------
  it('does not call reconcileItem', () => {
    expect(SOURCE).not.toMatch(/reconcileItem\(/);
  });

  // -----------------------------------------------------------------------
  // Test: delegates only to runOwnershipComparison for comparison behavior
  // -----------------------------------------------------------------------
  it('delegates only to runOwnershipComparison for comparison behavior', () => {
    // The only function that performs comparison should be `runOwnershipComparison`.
    // Check that:
    // 1. The module imports runOwnershipComparison
    // 2. The module does NOT directly invoke other comparison-related logic
    expect(SOURCE).toContain('runOwnershipComparison');
    expect(SOURCE).toContain("from './ownership-comparison-runner.js'");

    // Verify that the module doesn't define its own comparison logic
    const nonImportLines = SOURCE.split('\n').filter(
      (l) => !l.includes('import') && !l.includes('export.*from'),
    );
    const nonImportText = nonImportLines.join('\n');
    // Should not contain patterns from the comparison runner
    expect(nonImportText).not.toMatch(/readVisibleBackloggdState/);
    expect(nonImportText).not.toMatch(/compareOwnership/);
  });
});

// ---------------------------------------------------------------------------
// Import checks — CLI
// ---------------------------------------------------------------------------

describe('ownership-compare CLI — static import safety', () => {
  // -----------------------------------------------------------------------
  // Test: does not import final-save executor
  // -----------------------------------------------------------------------
  it('does not import runConfirmedOwnershipSave', () => {
    const lines = CLI_SOURCE.split('\n');
    const finalSaveImports = lines.filter(
      (l) => l.includes('import') && l.includes('runConfirmedOwnershipSave'),
    );
    expect(finalSaveImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not import confirmed-save command
  // -----------------------------------------------------------------------
  it('does not import executeConfirmedOwnershipSaves', () => {
    const lines = CLI_SOURCE.split('\n');
    const confirmedSaveImports = lines.filter(
      (l) => l.includes('import') && l.includes('executeConfirmedOwnershipSaves'),
    );
    expect(confirmedSaveImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not import confirmation-selection
  // -----------------------------------------------------------------------
  it('does not import applyOwnershipConfirmationSelection', () => {
    const lines = CLI_SOURCE.split('\n');
    const confirmationImports = lines.filter(
      (l) => l.includes('import') && l.includes('applyOwnershipConfirmationSelection'),
    );
    expect(confirmationImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: does not import confirmation CLI
  // -----------------------------------------------------------------------
  it('does not import confirmExactProposals or confirmAllEligibleProposals', () => {
    const forbidden = ['confirmExactProposals', 'confirmAllEligibleProposals'];
    for (const term of forbidden) {
      const importLines = CLI_SOURCE.split('\n').filter(
        (l) => l.includes('import') && l.includes(term),
      );
      expect(importLines).toHaveLength(0);
    }
  });

  // -----------------------------------------------------------------------
  // Test: does not import staging executor
  // -----------------------------------------------------------------------
  it('does not import runConfirmedOwnershipStaging or stageOwnershipInBrowser', () => {
    const forbidden = ['runConfirmedOwnershipStaging', 'stageOwnershipInBrowser'];
    for (const term of forbidden) {
      const importLines = CLI_SOURCE.split('\n').filter(
        (l) => l.includes('import') && l.includes(term),
      );
      expect(importLines).toHaveLength(0);
    }
  });

  // -----------------------------------------------------------------------
  // Test: does not import processItem, transitionItem, or reconcileItem
  // -----------------------------------------------------------------------
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
  // Test: uses shared browser launcher
  // -----------------------------------------------------------------------
  it('uses shared launchSession from backloggd/browser', () => {
    expect(CLI_SOURCE).toContain("import { launchSession } from '../backloggd/browser.js'");
  });

  it('does not directly import chromium from playwright', () => {
    const importLines = CLI_SOURCE.split('\n').filter(
      (l) => l.includes('import') && l.includes('playwright'),
    );
    // Type-only imports are acceptable (they are erased at runtime)
    const valueImports = importLines.filter((l) => !l.includes('import type'));
    expect(valueImports).toHaveLength(0);
  });

  it('does not call chromium.launch directly', () => {
    expect(CLI_SOURCE).not.toContain('chromium.launch');
    expect(CLI_SOURCE).not.toContain('chromium');
  });

  // -----------------------------------------------------------------------
  // Test: trims session ID
  // -----------------------------------------------------------------------
  it('trims session ID after parsing', () => {
    expect(CLI_SOURCE).toContain('.trim()');
  });

  it('rejects whitespace-only session with error message', () => {
    expect(CLI_SOURCE).toContain('must be non-empty');
  });

  // -----------------------------------------------------------------------
  // Test: has unsafe outcome exit code
  // -----------------------------------------------------------------------
  it('sets process.exitCode = 1 for unsafe outcomes', () => {
    expect(CLI_SOURCE).toContain('process.exitCode = 1');
  });

  it('computes hasFailures from hasUnsafeComparisonOutcomes', () => {
    expect(CLI_SOURCE).toContain('hasUnsafeComparisonOutcomes(result)');
  });

  // -----------------------------------------------------------------------
  // Test: does not define final-save selector strings in CLI
  // -----------------------------------------------------------------------
  it('does not define final-save selector strings in CLI', () => {
    const selectorPatterns = [
      /role=dialog/i,
      /select\[name="platform"\]/,
      /select\[name="ownership_type"\]/,
    ];

    for (const pattern of selectorPatterns) {
      const nonImportLines = CLI_SOURCE.split('\n').filter(
        (l) => !l.includes('import') && !l.includes('export.*from'),
      );
      const nonImportText = nonImportLines.join('\n');
      expect(nonImportText).not.toMatch(pattern);
    }
  });
});
