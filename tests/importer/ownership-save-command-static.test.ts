/**
 * Static safety tests for the ownership save command (Phase 5D Slice 1).
 *
 * These tests verify by source inspection that the integration module:
 *
 * - Does not import `processItem`.
 * - Does not import `transitionItem`.
 * - Does not import `reconcileItem`.
 * - Does not define save-button selectors.
 * - Does not define write-guard allowance logic.
 * - Calls only the audited save executor for final save behavior.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMMAND_SOURCE_PATH = resolve('src/importer/ownership-save-command.ts');
const SOURCE = readFileSync(COMMAND_SOURCE_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Import checks
// ---------------------------------------------------------------------------

describe('ownership-save-command — static import safety', () => {
  // -----------------------------------------------------------------------
  // Test: integration file does not import processItem
  // -----------------------------------------------------------------------
  it('does not import processItem', () => {
    const lines = SOURCE.split('\n');
    const processItemImports = lines.filter(
      (l) => l.includes('import') && l.includes('processItem'),
    );
    expect(processItemImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: integration file does not import transitionItem
  // -----------------------------------------------------------------------
  it('does not import transitionItem', () => {
    const lines = SOURCE.split('\n');
    const transitionItemImports = lines.filter(
      (l) => l.includes('import') && l.includes('transitionItem'),
    );
    expect(transitionItemImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: integration file does not import reconcileItem
  // -----------------------------------------------------------------------
  it('does not import reconcileItem', () => {
    const lines = SOURCE.split('\n');
    const reconcileItemImports = lines.filter(
      (l) => l.includes('import') && l.includes('reconcileItem'),
    );
    expect(reconcileItemImports).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test: integration file does not define save-button selectors
  // -----------------------------------------------------------------------
  it('does not define save-button selectors', () => {
    // Selector-like patterns for save actions should not be defined here.
    // Allow `ALLOWED_SAVE_NAMES` which is a string constant not a selector.
    const selectorPatterns = [
      /getByRole.*button.*save/i,
      /role=dialog/i,
      /select\[name="platform"\]/,
      /select\[name="ownership_type"\]/,
      /role=button.*name=/i,
    ];

    for (const pattern of selectorPatterns) {
      const matches = SOURCE.match(pattern);
      if (matches) {
        // Make sure these are not in the integration source itself
        // (allow references to the executor's types, not its selectors)
        const nonImportLines = SOURCE.split('\n').filter(
          (l) => !l.includes('import') && !l.includes('export.*from'),
        );
        const nonImportText = nonImportLines.join('\n');
        expect(nonImportText).not.toMatch(pattern);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test: integration file does not define write-guard allowance logic
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
      // Only check non-import lines
      const nonImportLines = SOURCE.split('\n').filter(
        (l) => !l.includes('import') && !l.includes('export.*from'),
      );
      const nonImportText = nonImportLines.join('\n');
      expect(nonImportText).not.toMatch(pattern);
    }
  });
});

// ---------------------------------------------------------------------------
// Final save behavior check
// ---------------------------------------------------------------------------

describe('ownership-save-command — final save delegation', () => {
  // -----------------------------------------------------------------------
  // Test: integration file calls only the audited save executor for final
  // save behavior.
  // -----------------------------------------------------------------------
  it('calls only runConfirmedOwnershipSave for final save behavior', () => {
    // The only function that performs final save logic should be
    // `runConfirmedOwnershipSave`.  Check that:
    // 1. The module imports runConfirmedOwnershipSave
    // 2. The module does NOT directly invoke other save-related logic

    const hasSaveExecutorImport = SOURCE.includes('runConfirmedOwnershipSave');
    expect(hasSaveExecutorImport).toBe(true);

    // Check that processItem is not called anywhere in the source
    const processItemCall = SOURCE.match(/processItem\(/);
    expect(processItemCall).toBeNull();
  });

  it('does not define click/save action logic', () => {
    // The integration layer must not define its own save-clicking logic.
    // Verify absence of key patterns found in the executor.
    const clickPatterns = [
      /await .*\.locator\(.*\)\.click/, // Playwright click
      /page\.click\(/, // page.click
      /saveCandidate\.locator\.click/, // executor's click pattern
      /clickFinalSave/, // executor's click function
      /findSafeSaveButton/, // executor's finder
    ];

    for (const pattern of clickPatterns) {
      const match = SOURCE.match(pattern);
      expect(match).toBeNull();
    }
  });
});
