/**
 * Phase 5E Slice 4 — ownership workflow coverage map.
 *
 * A lightweight data-driven test that documents and verifies the Phase 5E
 * coverage layout.  Every ownership-workflow safety invariant is mapped to
 * the test files that protect it, so future maintainers can see the safety
 * contract clearly.
 *
 * ## Design
 *
 * This test is purely a coverage MAP — it asserts file existence, evidence
 * presence, and structural properties of the invariant→owner mapping.
 * It does NOT duplicate any runtime behavior from the mapped test files.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InvariantEntry {
  /** Human-readable description of the safety invariant. */
  invariant: string;
  /** Relative paths to test files that protect this invariant. */
  protectedBy: string[];
  /** Strings (describe titles or test titles) that must appear in each file. */
  evidence: string[];
  /**
   * True when enforcing this invariant requires executable (runtime) test
   * behaviour — e.g. creating a database, mocking executors, async calls.
   * False for purely static source-inspection guardrails.
   */
  requiresExecutableBehavior: boolean;
}

// ---------------------------------------------------------------------------
// Coverage map
// ---------------------------------------------------------------------------

const OWNERSHIP_WORKFLOW_COVERAGE: InvariantEntry[] = [
  // ==========================================================================
  // Positive offline workflow contract
  // ==========================================================================

  {
    invariant: 'save plan eligibility requires comparison proof (absent proof)',
    protectedBy: ['tests/importer/ownership-workflow-contract.test.ts'],
    evidence: ['ownership workflow — save plan eligibility requires comparison proof'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'show-plan is read-only (no confirmation rows, no item mutations)',
    protectedBy: [
      'tests/importer/ownership-workflow-contract.test.ts',
      'tests/importer/ownership-save-confirm-cli.test.ts',
    ],
    evidence: [
      'ownership workflow — show-plan is read-only',
      'show-plan is read-only — does not mutate any table',
    ],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'confirm creates durable confirmation rows with batch IDs',
    protectedBy: ['tests/importer/ownership-workflow-contract.test.ts'],
    evidence: ['ownership workflow — confirm creates durable confirmation rows'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'save operates only on confirmed rows',
    protectedBy: [
      'tests/importer/ownership-workflow-contract.test.ts',
      'tests/importer/ownership-save-command.test.ts',
    ],
    evidence: [
      'ownership workflow — save command safety gates',
      'ownership-save-command — safety gates',
    ],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'save results surfaced without remapping',
    protectedBy: [
      'tests/importer/ownership-workflow-contract.test.ts',
      'tests/importer/ownership-save-command.test.ts',
    ],
    evidence: [
      'ownership workflow — save result surfacing',
      'ownership-save-command — result preservation',
    ],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'session isolation in save command',
    protectedBy: ['tests/importer/ownership-workflow-contract.test.ts'],
    evidence: ['ownership workflow — save command session isolation'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'confirmation rows remain durable between confirm and save',
    protectedBy: ['tests/importer/ownership-workflow-contract.test.ts'],
    evidence: ['ownership workflow — confirmation durability across steps'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'no auto-created confirmation rows from compare or show-plan',
    protectedBy: ['tests/importer/ownership-workflow-contract.test.ts'],
    evidence: ['ownership workflow — no auto-created confirmation rows'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'confirm-all operates on eligible candidates only',
    protectedBy: ['tests/importer/ownership-workflow-contract.test.ts'],
    evidence: ['ownership workflow — confirm-all eligibility'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'no hidden browser/live Backloggd behavior in contract tests',
    protectedBy: [
      'tests/importer/ownership-workflow-contract.test.ts',
      'tests/importer/ownership-workflow-negative-contract.test.ts',
    ],
    evidence: [
      'ownership workflow — test file import safety',
      'ownership workflow negative — static import safety',
    ],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'positive offline workflow composes compare -> show-plan -> confirm -> save',
    protectedBy: ['tests/importer/ownership-workflow-contract.test.ts'],
    evidence: ['composes compare -> show-plan -> confirm -> save offline'],
    requiresExecutableBehavior: true,
  },

  // ==========================================================================
  // Negative offline workflow contract
  // ==========================================================================

  {
    invariant: 'cross-session confirmation rows rejected',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — confirmation-row gate'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'non-confirmed status in confirmation rows rejected (CHECK constraint)',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — confirmation-row gate'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'stale import item status rejected after confirmation',
    protectedBy: [
      'tests/importer/ownership-workflow-negative-contract.test.ts',
      'tests/importer/ownership-staging-executor.test.ts',
    ],
    evidence: [
      'ownership workflow negative — stale-data revalidation',
      'ownership-staging-executor — revalidation',
    ],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'stale canonical proposal status rejected after confirmation',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — stale-data revalidation'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'changed frozen payload rejected after confirmation',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — stale-data revalidation'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'changed absent-proof checkedAt rejected after confirmation',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — stale-data revalidation'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'terminal items excluded from confirm-all',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — confirm-all exclusion'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'malformed frozen payload rows excluded from confirm-all',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — confirm-all exclusion'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'invalid absent proof rows excluded from confirm-all',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — confirm-all exclusion'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'status proposals excluded from ownership workflow',
    protectedBy: [
      'tests/importer/ownership-workflow-contract.test.ts',
      'tests/importer/ownership-workflow-negative-contract.test.ts',
    ],
    evidence: [
      'ownership workflow — status/playlog exclusion',
      'ownership workflow negative — confirm-exact rejection',
    ],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'playlog proposals excluded from ownership workflow',
    protectedBy: [
      'tests/importer/ownership-workflow-contract.test.ts',
      'tests/importer/ownership-workflow-negative-contract.test.ts',
    ],
    evidence: [
      'ownership workflow — status/playlog exclusion',
      'ownership workflow negative — confirm-exact rejection',
    ],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'unsafe save statuses surfaced without remapping',
    protectedBy: [
      'tests/importer/ownership-workflow-negative-contract.test.ts',
      'tests/importer/ownership-save-command.test.ts',
    ],
    evidence: [
      'ownership workflow negative — save result status safety',
      'ownership-save-command — result preservation',
    ],
    requiresExecutableBehavior: true,
  },
  {
    invariant:
      'no copied failure-decision helper: negative contract uses real executeConfirmedOwnershipSaves import',
    protectedBy: [
      'tests/importer/ownership-workflow-negative-contract.test.ts',
      'tests/importer/ownership-save-command.test.ts',
      'tests/importer/ownership-workflow-guardrails.test.ts',
    ],
    evidence: [
      'ownership workflow negative — save result status safety',
      'ownership-save-command — exit-status decisions',
      'guardrail — save command does not treat failures as success (static)',
    ],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'cross-session eligible candidates not confirmed by current-session confirm-all',
    protectedBy: ['tests/importer/ownership-workflow-negative-contract.test.ts'],
    evidence: ['ownership workflow negative — cross-session isolation'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'no orchestrator function defined in contract test files',
    protectedBy: [
      'tests/importer/ownership-workflow-contract.test.ts',
      'tests/importer/ownership-workflow-negative-contract.test.ts',
    ],
    evidence: [
      'ownership workflow — no new orchestrator source',
      'ownership workflow negative — contract test helper safety',
    ],
    requiresExecutableBehavior: false,
  },

  // ==========================================================================
  // Guardrails
  // ==========================================================================

  {
    invariant: 'no one-shot workflow function names in source files',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — no one-shot workflow function names'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'no cross-module unsafe import pairs',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — cross-module import boundaries'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'CLI cross-module import boundaries enforced',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — CLI cross-module import boundaries'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'confirm CLI does not import Playwright',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — confirm CLI no Playwright'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'compare/save CLI uses shared browser launcher, not direct Playwright',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — compare/save CLI uses shared browser launcher'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'enableSaveAllowance/SAVE_API_REGEX only in audited modules',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — audited module uniqueness'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'final-save selector patterns absent outside save executor',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — audited module uniqueness'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'CLI/command files do not call transitionItem/reconcileItem directly',
    protectedBy: [
      'tests/importer/ownership-workflow-guardrails.test.ts',
      'tests/importer/ownership-save-command-static.test.ts',
      'tests/importer/ownership-save-confirm-cli-static.test.ts',
      'tests/importer/ownership-compare-command-static.test.ts',
    ],
    evidence: [
      'guardrail — CLI and command files do not call transitionItem/reconcileItem',
      'ownership-save-command — static import safety',
      'ownership-save-confirm-cli — static import safety (module)',
      'ownership-compare-command — static import safety',
    ],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'no direct import_item_confirmations SQL in CLI/command files',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — no direct import_item_confirmations SQL in CLI/command files'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'no package-script chaining of ownership commands',
    protectedBy: [
      'tests/importer/ownership-workflow-guardrails.test.ts',
      'tests/importer/ownership-workflow-runbook.test.ts',
    ],
    evidence: ['guardrail — package script composition', 'package.json — ownership script safety'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'ownership:save CLI requires --execute-confirmed-ownership-saves opt-in',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — save CLI requires opt-in flag'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'ownership:confirm CLI requires explicit action flag',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — confirm CLI requires explicit action'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'CLI refuses whitespace-only session values (static)',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — CLI refuses whitespace-only sessions (static)'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'whitespace session rejection: compare CLI returns nonzero (executable)',
    protectedBy: [
      'tests/importer/ownership-workflow-guardrails.test.ts',
      'tests/cli/ownership-compare.test.ts',
    ],
    evidence: [
      'guardrail — compare CLI executable whitespace session rejection',
      'ownership-compare CLI — executable behaviour',
    ],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'whitespace session rejection: save/confirm via command layer',
    protectedBy: [
      'tests/importer/ownership-save-command.test.ts',
      'tests/importer/ownership-save-confirm-cli.test.ts',
    ],
    evidence: ['ownership-save-command — safety gates', 'rejects whitespace-only session ID'],
    requiresExecutableBehavior: true,
  },
  {
    invariant: 'explicit compare/confirm/save command surfaces exist',
    protectedBy: [
      'tests/importer/ownership-workflow-guardrails.test.ts',
      'tests/importer/ownership-workflow-runbook.test.ts',
    ],
    evidence: [
      'guardrail — explicit command surfaces exist',
      'package.json — ownership script coverage',
    ],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'save CLI failure statuses not treated as success',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — save command does not treat failures as success (static)'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'compare CLI delegates to hasUnsafeComparisonOutcomes for exit code',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — compare CLI delegates to hasUnsafeComparisonOutcomes'],
    requiresExecutableBehavior: false,
  },
  {
    invariant: 'compare CLI unsupported-kind-only does not trigger failure',
    protectedBy: ['tests/importer/ownership-workflow-guardrails.test.ts'],
    evidence: ['guardrail — compare CLI unsupported-kind-only behavior'],
    requiresExecutableBehavior: false,
  },
];

// =============================================================================
// File-level checks
// =============================================================================

describe('ownership-workflow coverage map — file existence', () => {
  const allReferencedPaths = new Set(OWNERSHIP_WORKFLOW_COVERAGE.flatMap((e) => e.protectedBy));

  for (const relPath of allReferencedPaths) {
    it(`${relPath} exists`, () => {
      const fullPath = resolve(relPath);
      expect(existsSync(fullPath), `${relPath} does not exist`).toBe(true);
    });
  }
});

describe('ownership-workflow coverage map — evidence presence', () => {
  // Cache file contents to avoid redundant reads
  const contentCache = new Map<string, string>();

  function getFileContent(relPath: string): string {
    const cached = contentCache.get(relPath);
    if (cached !== undefined) return cached;
    const fullPath = resolve(relPath);
    const content = readFileSync(fullPath, 'utf-8');
    contentCache.set(relPath, content);
    return content;
  }

  for (const entry of OWNERSHIP_WORKFLOW_COVERAGE) {
    // Group evidence by file for efficiency
    const fileEvidence = new Map<string, string[]>();
    for (let i = 0; i < entry.protectedBy.length; i++) {
      const file = entry.protectedBy[i];
      const ev = entry.evidence[i] ?? entry.evidence[entry.protectedBy.indexOf(file)];
      const list = fileEvidence.get(file) ?? [];
      list.push(ev);
      fileEvidence.set(file, list);
    }

    for (const [filePath, evidenceList] of fileEvidence) {
      for (const ev of evidenceList) {
        it(`"${entry.invariant}" evidence "${ev}" found in ${filePath}`, () => {
          const content = getFileContent(filePath);
          expect(content.includes(ev), `${filePath} does not contain expected text: "${ev}"`).toBe(
            true,
          );
        });
      }
    }
  }
});

// =============================================================================
// Structural assertions
// =============================================================================

describe('ownership-workflow coverage map — structural integrity', () => {
  it('every invariant has at least one coverage owner', () => {
    for (const entry of OWNERSHIP_WORKFLOW_COVERAGE) {
      expect(
        entry.protectedBy.length,
        `Invariant "${entry.invariant}" has no coverage owner`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('no invariant references a production file as its test owner', () => {
    const productionPrefixes = ['src/', 'dist/', 'node_modules/'];
    for (const entry of OWNERSHIP_WORKFLOW_COVERAGE) {
      for (const file of entry.protectedBy) {
        const isProd = productionPrefixes.some((p) => file.startsWith(p));
        expect(isProd, `Invariant "${entry.invariant}" references production file: ${file}`).toBe(
          false,
        );
      }
    }
  });

  it('no executable invariant is covered only by the guardrails file', () => {
    const guardrailsFile = 'tests/importer/ownership-workflow-guardrails.test.ts';
    for (const entry of OWNERSHIP_WORKFLOW_COVERAGE) {
      if (!entry.requiresExecutableBehavior) continue;
      const onlyGuardrails =
        entry.protectedBy.length === 1 && entry.protectedBy[0] === guardrailsFile;
      expect(
        onlyGuardrails,
        `Invariant "${entry.invariant}" requires executable behavior but is only covered by guardrails file`,
      ).toBe(false);
    }
  });
});

// =============================================================================
// Required-invariant completeness
// =============================================================================

describe('ownership-workflow coverage map — required invariant completeness', () => {
  const invariantSet = new Set(OWNERSHIP_WORKFLOW_COVERAGE.map((e) => e.invariant));

  const requiredPositive = [
    'save plan eligibility requires comparison proof',
    'show-plan is read-only',
    'confirm creates durable confirmation rows',
    'save operates only on confirmed rows',
    'no hidden browser',
    'positive offline workflow composes',
  ];

  const requiredNegative = [
    'cross-session confirmation rows rejected',
    'non-confirmed status in confirmation rows rejected',
    'stale import item status rejected after confirmation',
    'status proposals excluded from ownership workflow',
    'playlog proposals excluded from ownership workflow',
    'unsafe save statuses surfaced without remapping',
    'no orchestrator function defined in contract test files',
  ];

  const requiredGuardrails = [
    'no one-shot workflow function names',
    'no cross-module unsafe import pairs',
    'compare/save CLI uses shared browser launcher',
    'final-save selector patterns absent outside save executor',
    'no direct import_item_confirmations SQL',
    'no package-script chaining',
    'ownership:save CLI requires',
    'ownership:confirm CLI requires explicit action flag',
    'explicit compare/confirm/save command surfaces exist',
  ];

  it('covers all required positive-workflow invariants', () => {
    for (const keyword of requiredPositive) {
      const found = [...invariantSet].some((i) => i.includes(keyword));
      expect(found, `No coverage map entry matches positive invariant: "${keyword}"`).toBe(true);
    }
  });

  it('covers all required negative-workflow invariants', () => {
    for (const keyword of requiredNegative) {
      const found = [...invariantSet].some((i) => i.includes(keyword));
      expect(found, `No coverage map entry matches negative invariant: "${keyword}"`).toBe(true);
    }
  });

  it('covers all required guardrail invariants', () => {
    for (const keyword of requiredGuardrails) {
      const found = [...invariantSet].some((i) => i.includes(keyword));
      expect(found, `No coverage map entry matches guardrail invariant: "${keyword}"`).toBe(true);
    }
  });

  it('maps at least 5 positive workflow invariants', () => {
    const positives = [...invariantSet].filter(
      (i) =>
        !i.includes('negative') &&
        !i.includes('guardrail') &&
        !i.includes('stale') &&
        !i.includes('excluded') &&
        !i.includes('rejected') &&
        !i.includes('orchestrator') &&
        i !== 'no hidden browser/live Backloggd behavior in contract tests' &&
        i !== 'no auto-created confirmation rows from compare or show-plan',
    );
    expect(positives.length).toBeGreaterThanOrEqual(5);
  });

  it('maps at least 8 negative workflow invariants', () => {
    const negatives = [...invariantSet].filter(
      (i) =>
        i.includes('negative') ||
        i.includes('rejected') ||
        i.includes('stale') ||
        i.includes('excluded'),
    );
    expect(negatives.length).toBeGreaterThanOrEqual(8);
  });

  it('maps at least 12 guardrail invariants', () => {
    const guardrails = [...invariantSet].filter(
      (i) =>
        i.includes('guardrail') ||
        i.includes('no one-shot') ||
        i.includes('no direct') ||
        i.includes('no package') ||
        i.includes('no cross-module') ||
        i.includes('CLI') ||
        i.includes('explicit') ||
        i.includes('whitespace'),
    );
    expect(guardrails.length).toBeGreaterThanOrEqual(12);
  });
});
