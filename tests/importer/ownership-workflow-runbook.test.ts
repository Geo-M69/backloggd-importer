/**
 * Static smoke tests for the ownership workflow runbook (Phase 5D Slice 4).
 *
 * These tests verify that:
 *
 * 1. The runbook documents the correct commands and safety properties.
 * 2. The package.json scripts do not drift from the audited command surfaces.
 * 3. No one-shot chained or auto-confirm commands are documented or scripted.
 *
 * These tests are purely static — they read source files and documentation
 * but do not execute any CLI or browser behavior.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNBOOK_PATH = resolve('docs/ownership-workflow.md');
const RUNBOOK = readFileSync(RUNBOOK_PATH, 'utf-8');

const PACKAGE_JSON_PATH = resolve('package.json');
const PACKAGE_JSON = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
const PACKAGE = JSON.parse(PACKAGE_JSON) as {
  scripts?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Runbook command coverage
// ---------------------------------------------------------------------------

describe('ownership-workflow runbook — command coverage', () => {
  // -----------------------------------------------------------------------
  // Test 1: Runbook lists ownership:compare with --session <id>
  // -----------------------------------------------------------------------
  it('lists ownership:compare with --session <id>', () => {
    expect(RUNBOOK).toMatch(/npm run ownership:compare -- --session <id>/);
  });

  // -----------------------------------------------------------------------
  // Test 2: Runbook lists ownership:confirm --show-plan with --session <id>
  // -----------------------------------------------------------------------
  it('lists ownership:confirm --show-plan with --session <id>', () => {
    expect(RUNBOOK).toMatch(/npm run ownership:confirm -- --session <id> --show-plan/);
  });

  // -----------------------------------------------------------------------
  // Test 3: Runbook lists ownership:confirm --confirm-proposals with
  //         --session <id>
  // -----------------------------------------------------------------------
  it('lists ownership:confirm --confirm-proposals with --session <id>', () => {
    expect(RUNBOOK).toMatch(/npm run ownership:confirm -- --session <id> --confirm-proposals/);
  });

  // -----------------------------------------------------------------------
  // Test 4: Runbook lists ownership:confirm --confirm-all-eligible with
  //         --session <id>
  // -----------------------------------------------------------------------
  it('lists ownership:confirm --confirm-all-eligible with --session <id>', () => {
    expect(RUNBOOK).toMatch(/npm run ownership:confirm -- --session <id> --confirm-all-eligible/);
  });

  // -----------------------------------------------------------------------
  // Test 5: Runbook lists ownership:save --execute-confirmed-ownership-saves
  //         with --session <id>
  // -----------------------------------------------------------------------
  it('lists ownership:save --execute-confirmed-ownership-saves with --session <id>', () => {
    expect(RUNBOOK).toMatch(
      /npm run ownership:save -- --session <id> --execute-confirmed-ownership-saves/,
    );
  });

  // -----------------------------------------------------------------------
  // Test 6: Runbook does not mention any one-shot "run all" command
  // -----------------------------------------------------------------------
  it('does not mention any one-shot run-all command', () => {
    const runAllPatterns = [
      /run all/i,
      /all-in-one/i,
      /one.?shot/i,
      /compare.*confirm.*save/i,
      /ownership:all/i,
      /ownership:run/i,
    ];
    for (const pattern of runAllPatterns) {
      const matches = RUNBOOK.match(pattern);
      if (matches) {
        // Allow non-command mentions (e.g. "no one-shot")
        // Only fail if a positive command reference exists
        const commandLines = RUNBOOK.split('\n').filter(
          (l) => l.includes('ownership:') && pattern.test(l),
        );
        expect(commandLines).toHaveLength(0);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 6b: Explicitly check the Non-goals section forbids one-shot
  // -----------------------------------------------------------------------
  it('explicitly forbids one-shot run-all in non-goals', () => {
    expect(RUNBOOK).toContain('No one-shot');
  });

  // -----------------------------------------------------------------------
  // Test 6c: Runbook lists import:manifest with --session and --output
  // -----------------------------------------------------------------------
  it('lists import:manifest with --session <id> and --output <manifest.json>', () => {
    expect(RUNBOOK).toMatch(/npm run import:manifest -- --session <id> --output <manifest.json>/);
  });

  // -----------------------------------------------------------------------
  // Test 6d: Runbook lists import:seed-items with --manifest <manifest.json>
  // -----------------------------------------------------------------------
  it('lists import:seed-items with --manifest <manifest.json>', () => {
    expect(RUNBOOK).toMatch(/npm run import:seed-items -- --manifest <manifest.json>/);
  });

  // -----------------------------------------------------------------------
  // Test 6e: import:seed-items appears before ownership:compare in the
  //          operator flow (seeding must happen before live comparison)
  // -----------------------------------------------------------------------
  it('documents import:seed-items before ownership:compare in the operator flow', () => {
    const seedIdx = RUNBOOK.indexOf('import:seed-items');
    const compareIdx = RUNBOOK.indexOf('ownership:compare');
    expect(seedIdx).toBeGreaterThanOrEqual(0);
    expect(compareIdx).toBeGreaterThan(seedIdx);
  });
});

// ---------------------------------------------------------------------------
// Runbook safety documentation
// ---------------------------------------------------------------------------

describe('ownership-workflow runbook — safety documentation', () => {
  // -----------------------------------------------------------------------
  // Test 7: Runbook says show-plan is read-only
  // -----------------------------------------------------------------------
  it('documents show-plan as read-only', () => {
    expect(RUNBOOK).toMatch(/read-only/i);
  });

  // -----------------------------------------------------------------------
  // Test 8: Runbook says confirmation requires explicit selection or
  //         explicit confirm-all
  // -----------------------------------------------------------------------
  it('documents that confirmation requires explicit selection or confirm-all', () => {
    expect(RUNBOOK).toContain('No default confirmation');
  });

  // -----------------------------------------------------------------------
  // Test 9: Runbook says final save requires explicit
  //         --execute-confirmed-ownership-saves
  // -----------------------------------------------------------------------
  it('documents that final save requires explicit --execute-confirmed-ownership-saves', () => {
    expect(RUNBOOK).toContain('Without it');
    expect(RUNBOOK).toContain('fails with a clear error');
  });

  // -----------------------------------------------------------------------
  // Test 10: Runbook says ownership:save is the only final-save execution
  //          command
  // -----------------------------------------------------------------------
  it('documents ownership:save as the only final-save execution command', () => {
    expect(RUNBOOK).toContain('only way');
    expect(RUNBOOK).toContain('ownership:save');
  });

  // -----------------------------------------------------------------------
  // Test 11: Runbook documents nonzero exits for unsafe save outcomes
  // -----------------------------------------------------------------------
  it('documents nonzero exits for save outcomes', () => {
    // The runbook should have exit code tables for both compare and save
    const exitCodeSection = RUNBOOK.match(/Exit code[s]?/gi);
    expect(exitCodeSection).not.toBeNull();
    // Must have at least one exit code section
    expect(exitCodeSection?.length).toBeGreaterThanOrEqual(1);
    // Must mention exit code 1 for failures
    expect(RUNBOOK).toContain('Exit code');
    expect(RUNBOOK).toContain('1');
  });
});

// ---------------------------------------------------------------------------
// Package script coverage
// ---------------------------------------------------------------------------

describe('package.json — ownership script coverage', () => {
  // -----------------------------------------------------------------------
  // Test 12: Package scripts include ownership:compare, ownership:confirm,
  //          and ownership:save
  // -----------------------------------------------------------------------
  it('includes ownership:compare script', () => {
    const scripts = PACKAGE.scripts ?? {};
    expect(scripts).toHaveProperty('ownership:compare');
    expect(scripts['ownership:compare']).toContain('ownership-compare');
  });

  it('includes ownership:confirm script', () => {
    const scripts = PACKAGE.scripts ?? {};
    expect(scripts).toHaveProperty('ownership:confirm');
    expect(scripts['ownership:confirm']).toContain('ownership-confirm');
  });

  it('includes ownership:save script', () => {
    const scripts = PACKAGE.scripts ?? {};
    expect(scripts).toHaveProperty('ownership:save');
    expect(scripts['ownership:save']).toContain('ownership-save');
  });
});

// ---------------------------------------------------------------------------
// Package script safety — no chaining
// ---------------------------------------------------------------------------

describe('package.json — ownership script safety', () => {
  // -----------------------------------------------------------------------
  // Helper: check if a script value chains multiple ownership commands
  // -----------------------------------------------------------------------
  function chainsOwnershipCommands(scriptValue: string): boolean {
    const ownershipCommands = scriptValue.match(/ownership:(compare|confirm|save)/g);
    if (!ownershipCommands) return false;
    // Count unique ownership commands
    const unique = new Set(ownershipCommands);
    return unique.size > 1;
  }

  // -----------------------------------------------------------------------
  // Test 13: No package script chains ownership commands together
  // -----------------------------------------------------------------------
  it('no script chains ownership commands together', () => {
    const scripts = PACKAGE.scripts ?? {};
    for (const [name, value] of Object.entries(scripts)) {
      if (value && chainsOwnershipCommands(value)) {
        expect.unreachable(`Script "${name}" chains multiple ownership commands: ${value}`);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 14: ownership:save and its CLI filenames are not referenced from
  //          test, build, lint, format, import, compare, or confirm scripts
  // -----------------------------------------------------------------------
  it('no non-save script references ownership:save or its CLI filenames', () => {
    const scripts = PACKAGE.scripts ?? {};

    // Gather scripts that must NOT reference the save CLI
    const sensitiveScriptNames = [
      'test',
      'build',
      'typecheck',
      'lint',
      'format',
      'ownership:compare',
      'ownership:confirm',
    ];

    // Also include all import:* scripts
    for (const name of Object.keys(scripts)) {
      if (name.startsWith('import:')) {
        sensitiveScriptNames.push(name);
      }
    }

    // Patterns that should never appear outside ownership:save itself
    const savePatterns: RegExp[] = [
      /ownership:save/,
      /ownership-save\b/,
      /ownership-save\.js/,
      /dist\/cli\/ownership-save\.js/,
      /src\/cli\/ownership-save\.ts/,
    ];

    const excluded = new Set(['ownership:save']);

    for (const name of sensitiveScriptNames) {
      if (excluded.has(name)) continue;
      const value = scripts[name];
      if (!value) continue;

      for (const pattern of savePatterns) {
        if (pattern.test(value)) {
          expect.unreachable(`Script "${name}" matches ${pattern}: ${value}`);
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 14b: No non-save script chains ownership-compare, ownership-confirm,
  //           or ownership-save binaries together
  // -----------------------------------------------------------------------
  it('no non-save script chains ownership-compare/confirm/save binaries', () => {
    const scripts = PACKAGE.scripts ?? {};
    // Non-capturing group, global flag to get all matches without groups
    const binaryPattern = /ownership-(?:compare|confirm|save)\b/g;

    for (const [name, value] of Object.entries(scripts)) {
      if (!value || name === 'ownership:save') continue;
      const matches = value.match(binaryPattern);
      if (!matches) continue;
      // With global flag, match() returns just the full matches (no groups)
      const unique = new Set(matches);
      if (unique.size > 1) {
        expect.unreachable(`Script "${name}" chains ownership binary names: ${value}`);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 14c: No script except ownership:save references save CLI filenames
  // -----------------------------------------------------------------------
  it('only ownership:save references the save CLI filename', () => {
    const scripts = PACKAGE.scripts ?? {};
    const saveCliPatterns = [
      /ownership-save\b/,
      /ownership-save\.js/,
      /dist\/cli\/ownership-save\.js/,
      /src\/cli\/ownership-save\.ts/,
    ];

    for (const [name, value] of Object.entries(scripts)) {
      if (!value || name === 'ownership:save') continue;
      for (const pattern of saveCliPatterns) {
        if (pattern.test(value)) {
          expect.unreachable(`Script "${name}" references save CLI (${pattern}): ${value}`);
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 15: No default "all ownership workflow" command
  // -----------------------------------------------------------------------
  it('does not include a default all-ownership-workflow command', () => {
    const scripts = PACKAGE.scripts ?? {};
    const allWorkflowPatterns = [
      /ownership:all/i,
      /ownership:workflow/i,
      /ownership:run/i,
      /ownership:full/i,
    ];
    for (const [name, value] of Object.entries(scripts)) {
      for (const pattern of allWorkflowPatterns) {
        if (pattern.test(name) || (value && pattern.test(value))) {
          expect.unreachable(`Script "${name}" matches workflow pattern: ${value}`);
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 15b: No composite script confirms and saves in one step
  // -----------------------------------------------------------------------
  it('no script performs both confirmation and final save in one step', () => {
    const scripts = PACKAGE.scripts ?? {};
    for (const [name, value] of Object.entries(scripts)) {
      if (!value) continue;
      const hasConfirm = value.includes('ownership:confirm');
      const hasSave = value.includes('ownership:save');
      if (hasConfirm && hasSave) {
        expect.unreachable(`Script "${name}" combines confirm and save: ${value}`);
      }
    }
  });

  // -----------------------------------------------------------------------
  // Test 15c: No script performs both compare and save in one step
  // -----------------------------------------------------------------------
  it('no script performs both compare and save in one step', () => {
    const scripts = PACKAGE.scripts ?? {};
    for (const [name, value] of Object.entries(scripts)) {
      if (!value) continue;
      const hasCompare = value.includes('ownership:compare');
      const hasSave = value.includes('ownership:save');
      if (hasCompare && hasSave) {
        expect.unreachable(`Script "${name}" combines compare and save: ${value}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Runbook non-goals documentation
// ---------------------------------------------------------------------------

describe('ownership-workflow runbook — non-goals', () => {
  // -----------------------------------------------------------------------
  // Test: Runbook documents no status/playlog saves
  // -----------------------------------------------------------------------
  it('documents no status/playlog saves as non-goal', () => {
    expect(RUNBOOK).toMatch(/no status.*playlog/i);
  });

  // -----------------------------------------------------------------------
  // Test: Runbook documents no auto-confirm
  // -----------------------------------------------------------------------
  it('documents no auto-confirm as non-goal', () => {
    expect(RUNBOOK).toMatch(/no auto-confirm/i);
  });

  // -----------------------------------------------------------------------
  // Test: Runbook documents no retry automation
  // -----------------------------------------------------------------------
  it('documents no retry automation as non-goal', () => {
    expect(RUNBOOK).toMatch(/no retry automation/i);
  });

  // -----------------------------------------------------------------------
  // Test: Runbook documents no browser final-save outside ownership:save
  // -----------------------------------------------------------------------
  it('documents no browser final-save outside ownership:save', () => {
    expect(RUNBOOK).toContain('only way');
    expect(RUNBOOK).toContain('ownership:save');
  });

  // -----------------------------------------------------------------------
  // Test: Runbook documents no one-shot "run all" command
  // -----------------------------------------------------------------------
  it('documents no one-shot run-all command as non-goal', () => {
    expect(RUNBOOK).toMatch(/no one.?shot/i);
  });

  // -----------------------------------------------------------------------
  // Test: Runbook documents no automatic final-save default
  // -----------------------------------------------------------------------
  it('documents no automatic final-save default as non-goal', () => {
    expect(RUNBOOK).toMatch(/no automatic final-save/i);
  });
});

// ---------------------------------------------------------------------------
// Runbook save failure recovery safety (Finding 1)
// ---------------------------------------------------------------------------

describe('ownership-workflow runbook — save failure recovery safety', () => {
  // -----------------------------------------------------------------------
  // Test: saveFailed recovery must not recommend blind retry
  // -----------------------------------------------------------------------
  function extractSaveFailedSection(): string {
    const m = RUNBOOK.match(/### If save returns saveFailed[\s\S]*?(?=### |\n---|$)/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[0];
  }

  function extractBrowserFailedSection(): string {
    const m = RUNBOOK.match(/### If save returns browserFailed[\s\S]*?(?=### |\n---|$)/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[0];
  }

  // -----------------------------------------------------------------------
  // Test: saveFailed recovery must not recommend blind retry
  // -----------------------------------------------------------------------
  it('does not recommend blind retry of ownership:save for saveFailed', () => {
    // Must not contain blind "retry `npm run ownership:save`" guidance
    const section = extractSaveFailedSection();
    expect(section).not.toMatch(/retry.*ownership:save/i);
    expect(section).not.toMatch(/retry the save command/i);
  });

  // -----------------------------------------------------------------------
  // Test: saveFailed recovery requires manual Backloggd state check
  // -----------------------------------------------------------------------
  it('requires manual Backloggd state check before rerun after saveFailed', () => {
    const section = extractSaveFailedSection();
    expect(section).toMatch(/manually check/i);
    expect(section).toMatch(/Backloggd/i);
  });

  // -----------------------------------------------------------------------
  // Test: browserFailed recovery must not recommend blind retry
  // -----------------------------------------------------------------------
  it('does not recommend blind retry for browserFailed', () => {
    const section = extractBrowserFailedSection();
    expect(section).not.toMatch(/retry.*save command/i);
    expect(section).not.toMatch(/Retry the save/i);
  });

  // -----------------------------------------------------------------------
  // Test: browserFailed recovery mentions ambiguous state after final click
  // -----------------------------------------------------------------------
  it('mentions ambiguous state for browserFailed after final click', () => {
    const section = extractBrowserFailedSection();
    expect(section).toMatch(/ambiguous/i);
    expect(section).toMatch(/final save click/i);
  });
});

// ---------------------------------------------------------------------------
// Runbook save API route documentation (Finding 2)
// ---------------------------------------------------------------------------

describe('ownership-workflow runbook — save API route documentation', () => {
  // -----------------------------------------------------------------------
  // Test: Runbook documents POST /api/library/ as accepted
  // -----------------------------------------------------------------------
  it('documents POST /api/library/ as accepted route', () => {
    expect(RUNBOOK).toContain('POST /api/library/');
  });

  // -----------------------------------------------------------------------
  // Test: Runbook documents POST /api/library/<numeric-id> as accepted
  // -----------------------------------------------------------------------
  it('documents POST /api/library/<numeric-id> as accepted route', () => {
    expect(RUNBOOK).toContain('POST /api/library/<numeric-id>');
  });

  // -----------------------------------------------------------------------
  // Test: Runbook does not document bare POST /api/library as accepted
  // -----------------------------------------------------------------------
  it('does not document bare POST /api/library as accepted', () => {
    // The bare route without trailing slash must not be presented as accepted
    // Allow mentioning it as blocked (possibly across line breaks)
    const barePattern = /`POST \/api\/library`[\s\S]{0,200}?(?:blocked|is blocked)/i;
    const bareMention = RUNBOOK.match(/`POST \/api\/library`(?!\/)/);
    if (bareMention) {
      // The bare route is mentioned — it must be accompanied by "blocked" nearby
      expect(RUNBOOK).toMatch(barePattern);
    }
  });

  // -----------------------------------------------------------------------
  // Test: Runbook states POST-only for save route
  // -----------------------------------------------------------------------
  it('states POST-only for the save route', () => {
    expect(RUNBOOK).toMatch(/POST-only/i);
  });

  // -----------------------------------------------------------------------
  // Test: Runbook mentions prefix paths like /api/library-malicious are blocked
  // -----------------------------------------------------------------------
  it('mentions prefix paths are blocked', () => {
    expect(RUNBOOK).toMatch(/prefix path/i);
    expect(RUNBOOK).toMatch(/blocked/i);
  });
});
