/**
 * Ownership staging executor — Phase 5C Slice 3.
 *
 * Takes durable confirmation rows (status = 'confirmed') from Phase 5C
 * Slice 2 and stages the ownership change in the Backloggd browser UI
 * **without saving it**.
 *
 * ## Safety guarantees
 *
 * - Pre-browser revalidation against current DB state before any page work.
 * - Write guard is installed before any browser interaction.
 * - No final save/submit/update/create-log/confirm click.
 * - No mutation of import_item status.
 * - No mutation of confirmation row status.
 * - No processing of items without a confirmation row.
 * - No processing of stale confirmations.
 */

import type Database from 'better-sqlite3';
import type { Page } from 'playwright';
import { installWriteGuard } from '../backloggd/browser.js';
import { verifyGamePage } from '../backloggd/page-reader.js';
import { readVisibleBackloggdState } from '../backloggd/visible-state.js';
import { textContainsForbiddenTerm } from '../backloggd/selectors.js';
import { getItem } from './import-items.js';
import type { ImportItem } from './import-items.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKLOGGD_GAME_BASE = 'https://backloggd.com/games/';

/**
 * Short timeout for quick UI probes (finding openers, checking for controls).
 * Independent of the caller's timeout to avoid long per-strategy waits.
 */
const PROBE_TIMEOUT_MS = 200;

/**
 * Timeout for page navigation.
 */
const NAV_TIMEOUT_MS = 5000;

/**
 * Timeout for page verification (trySelectors per-strategy).
 */
const VERIFY_TIMEOUT_MS = 1000;

/**
 * Settling window after visible verification — allows delayed Backloggd POST
 * requests (e.g. autosave scheduled via setTimeout) to fire and be captured
 * by the write guard before returning `staged`.
 */
const SETTLE_TIMEOUT_MS = 1500;

/**
 * Regex to parse an absent reconciliation proof from outcome_reason.
 */
const RECONCILED_ABSENT_RE = /^reconciled:absent:(?<reason>.+):checkedAt=(?<checkedAt>.+)$/;

/**
 * Regex to validate ISO timestamps (accepts date plus at least the hour).
 */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Status for a single confirmation staging attempt.
 *
 * - `staged` — fields were staged and verified, no final save clicked.
 * - `stale` — DB revalidation failed before browser work.
 * - `blockedWrite` — write guard blocked a network write during staging.
 * - `browserFailed` — page disappeared/navigation failed/editor unavailable.
 * - `verificationFailed` — staged visible values did not match expected.
 * - `unsupported` — page/editor structure cannot be safely staged.
 */
export type StagingResultStatus =
  'staged' | 'stale' | 'blockedWrite' | 'browserFailed' | 'verificationFailed' | 'unsupported';

/**
 * Result for a single confirmation staging attempt.
 */
export interface StagingResult {
  /** Proposal ID of the confirmation row. */
  proposalId: string;
  /** Outcome of the staging attempt. */
  status: StagingResultStatus;
  /** Batch ID from the confirmation row. */
  confirmationBatchId: string;
  /** Human-readable detail about the outcome. */
  detail?: string;
}

/**
 * A DB row from `import_item_confirmations`.
 */
export interface ConfirmationRow {
  proposal_id: string;
  import_session_id: string;
  confirmation_batch_id: string;
  planned_platform: string | null;
  planned_ownership_type: string | null;
  planned_slug: string | null;
  planned_absent_checked_at: string | null;
  status: string;
}

/**
 * Options for {@link runConfirmedOwnershipStaging}.
 */
export interface OwnershipStagingExecutorOptions {
  /** Database instance. */
  db: Database.Database;
  /** Import session ID. */
  sessionId: string;
  /** Playwright page, navigable by the executor. */
  page: Page;
  /** Timeout passed to page operations. */
  timeout?: number;
  /**
   * Custom URL resolver for navigation.
   *
   * Default constructs `https://backloggd.com/games/{slug}/`.
   * Tests override this to point at fixture files, e.g.
   * `(slug) => \`file:///fixtures/${slug}.html\``.
   */
  resolvePageUrl?: (slug: string) => string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CanonicalProposal {
  import_session_id: string;
  steam_app_id: number;
  proposal_kind: string;
  status: string;
  backloggd_slug: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an absent reconciliation proof from an import item's outcome_reason.
 */
function parseAbsentProof(
  outcomeReason: string | null,
): { reason: string; checkedAt: string } | null {
  if (!outcomeReason) return null;
  const match = RECONCILED_ABSENT_RE.exec(outcomeReason);
  if (!match?.groups) return null;
  const reason = match.groups.reason.trim();
  const checkedAt = match.groups.checkedAt.trim();
  if (reason.length === 0) return null;
  if (reason.includes(':checkedAt=')) return null;
  if (!ISO_TIMESTAMP_RE.test(checkedAt)) return null;
  const parsed = new Date(checkedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString() !== checkedAt) return null;
  return { reason, checkedAt };
}

/**
 * Parse an ownership payload from a frozen payload JSON string.
 */
function parseOwnershipPayload(
  frozenPayload: string | null,
): { platform: string; ownershipType: string } | null {
  if (!frozenPayload) return null;
  try {
    const parsed = JSON.parse(frozenPayload);
    if (typeof parsed.platform !== 'string' || typeof parsed.ownershipType !== 'string')
      return null;
    const platform = parsed.platform.trim();
    const ownershipType = parsed.ownershipType.trim();
    if (platform.length === 0 || ownershipType.length === 0) return null;
    return { platform, ownershipType };
  } catch {
    return null;
  }
}

/**
 * Default URL resolver.
 */
function defaultResolvePageUrl(slug: string): string {
  const encoded = encodeURIComponent(slug);
  return `${BACKLOGGD_GAME_BASE}${encoded}/`;
}

/**
 * Look up the game title from the games table.
 */
function lookUpGameTitle(db: Database.Database, steamAppId: number): string | null {
  const row = db.prepare('SELECT title FROM games WHERE app_id = ?').get(steamAppId) as
    { title: string } | undefined;
  return row?.title ?? null;
}

// ---------------------------------------------------------------------------
// Pre-browser revalidation
// ---------------------------------------------------------------------------

/**
 * Revalidate a single confirmation row against current DB state.
 *
 * Performs all 13 checks described in the Phase 5C Slice 3 spec.
 *
 * @returns `{ ok: true }` if all checks pass, or `{ ok: false, reason }`
 *          with a descriptive reason string if any check fails.
 */
export function revalidateConfirmation(
  db: Database.Database,
  sessionId: string,
  confirmation: ConfirmationRow,
): { ok: true } | { ok: false; reason: string } {
  const pid = confirmation.proposal_id;

  // 1. Confirmation row status is 'confirmed'
  if (confirmation.status !== 'confirmed') {
    return { ok: false, reason: `confirmation_status_not_confirmed:${confirmation.status}` };
  }

  // 2. Import item exists
  const item: ImportItem | null = getItem(db, pid);
  if (!item) {
    return { ok: false, reason: 'import_item_missing' };
  }

  // 3. Import item status is still 'approved'
  if (item.status !== 'approved') {
    return { ok: false, reason: `import_item_status_${item.status}` };
  }

  // 4. Import item proposal kind is still 'ownership'
  if (item.proposalKind !== 'ownership') {
    return { ok: false, reason: `import_item_kind_not_ownership:${item.proposalKind}` };
  }

  // 5. Canonical proposal exists
  const canonical = db
    .prepare(
      `SELECT import_session_id, steam_app_id, proposal_kind, status, backloggd_slug
       FROM proposals WHERE id = ?`,
    )
    .get(pid) as CanonicalProposal | undefined;

  if (!canonical) {
    return { ok: false, reason: 'missing_canonical_proposal' };
  }

  // 6. Canonical proposal belongs to the same session
  if (canonical.import_session_id !== sessionId) {
    return { ok: false, reason: 'canonical_session_mismatch' };
  }

  // 7. Canonical proposal status is still 'approved'
  if (canonical.status !== 'approved') {
    return { ok: false, reason: `canonical_status_not_approved:${canonical.status}` };
  }

  // 8. Canonical proposal kind is still 'ownership'
  if (canonical.proposal_kind !== 'ownership') {
    return { ok: false, reason: `canonical_kind_not_ownership:${canonical.proposal_kind}` };
  }

  // 9. Canonical Steam AppID matches import item and confirmation
  if (canonical.steam_app_id !== item.steamAppId) {
    return { ok: false, reason: 'canonical_steam_appid_mismatch' };
  }

  // 10. Canonical Backloggd slug matches confirmation
  const canonicalSlug = (canonical.backloggd_slug ?? '').trim();
  const plannedSlug = (confirmation.planned_slug ?? '').trim();
  if (canonicalSlug.length === 0 || canonicalSlug !== plannedSlug) {
    return { ok: false, reason: 'canonical_slug_mismatch' };
  }

  // 11. Frozen payload still matches confirmation platform/type
  const parsedPayload = parseOwnershipPayload(item.frozenPayload);
  if (!parsedPayload) {
    return { ok: false, reason: 'frozen_payload_malformed' };
  }
  if (
    parsedPayload.platform !== (confirmation.planned_platform ?? '').trim() ||
    parsedPayload.ownershipType !== (confirmation.planned_ownership_type ?? '').trim()
  ) {
    return { ok: false, reason: 'frozen_payload_mismatch' };
  }

  // 12. Prior absent proof is still valid and checkedAt matches confirmation
  const parsedProof = parseAbsentProof(item.outcomeReason);
  if (!parsedProof) {
    return { ok: false, reason: 'absent_proof_missing_or_invalid' };
  }
  if (parsedProof.checkedAt !== (confirmation.planned_absent_checked_at ?? '').trim()) {
    return { ok: false, reason: 'absent_proof_checked_at_mismatch' };
  }

  // 13. Confirmation planned data still matches (implicit audit)
  if (
    parsedPayload.platform !== (confirmation.planned_platform ?? '').trim() ||
    parsedPayload.ownershipType !== (confirmation.planned_ownership_type ?? '').trim() ||
    parsedProof.checkedAt !== (confirmation.planned_absent_checked_at ?? '').trim()
  ) {
    return { ok: false, reason: 'confirmation_planned_data_mismatch' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Browser staging — stage ownership fields
// ---------------------------------------------------------------------------

/**
 * Stage ownership fields in the browser for a single revalidated confirmation.
 *
 * The write guard must be installed on the page before calling this function.
 *
 * This function:
 *   1. Navigates to the confirmed Backloggd game URL.
 *   2. Verifies the page matches the expected slug/game.
 *   3. Reveals the ownership editor (direct controls, standard editor via
 *      opener, or "Log or review" modal).
 *   4. Stages Platform and Ownership according to the confirmed plan.
 *   5. Verifies the visible UI shows the intended values.
 *   6. Stops before clicking any final action.
 *
 * @returns The staging result status and detail.
 */
export async function stageOwnershipInBrowser(
  page: Page,
  confirmation: ConfirmationRow,
  options: OwnershipStagingExecutorOptions,
): Promise<{ status: StagingResultStatus; detail?: string }> {
  const { db, sessionId } = options;
  const resolvePageUrl = options.resolvePageUrl ?? defaultResolvePageUrl;
  const slug = (confirmation.planned_slug ?? '').trim();
  const targetUrl = resolvePageUrl(slug);

  // Track blocked writes via requestfailed listener
  const blockedWrites: string[] = [];
  const SAFE_METHODS = new Set(['GET', 'HEAD']);
  const RENDER_EDITOR_REGEX = /^\/render-editor\/\d+$/;

  const onRequestFailed = (request: { method: () => string; url: () => string }) => {
    const method = request.method().toUpperCase();
    if (SAFE_METHODS.has(method)) return;
    const url = request.url();
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'backloggd.com' || hostname.endsWith('.backloggd.com')) {
        const fullPath = `${method} ${parsed.origin}${parsed.pathname}`;
        if (method === 'POST' && RENDER_EDITOR_REGEX.test(parsed.pathname)) {
          blockedWrites.push(`RENDER_EDITOR:${fullPath}`);
        } else {
          blockedWrites.push(fullPath);
        }
      }
    } catch {
      // ignore invalid URLs
    }
  };

  page.on('requestfailed', onRequestFailed);

  try {
    // --- Step 1: Navigate to the game page ---
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch {
      return { status: 'browserFailed', detail: 'navigation_failed' };
    }

    // Check for blocked writes from navigation
    if (blockedWrites.length > 0) {
      return { status: 'blockedWrite', detail: blockedWrites.join('; ') };
    }

    // --- Step 2: Verify the page ---
    // Look up the game title from the DB for page verification
    const itemDb = getItem(db, confirmation.proposal_id);
    const gameTitle: string = itemDb ? (lookUpGameTitle(db, itemDb.steamAppId) ?? '') : '';
    const verified = await verifyGamePage(page, gameTitle, slug, { timeout: VERIFY_TIMEOUT_MS });
    if (!verified) {
      return { status: 'browserFailed', detail: 'game_verification_failed' };
    }

    // Check for blocked writes during verification
    if (blockedWrites.length > 0) {
      return { status: 'blockedWrite', detail: blockedWrites.join('; ') };
    }

    // --- Step 3: Stage ownership fields (probe before mutate) ---

    // Helper: attempt to stage both fields for a given strategy.
    // Returns { ok: boolean } — true only if both fields were probed
    // and successfully filled. Never mutates only one field.
    const stagedBy = await stageBothIfProbeOk(page, confirmation, slug, sessionId);
    const platformOk = stagedBy.ok;
    const ownershipOk = stagedBy.ok;

    // Check for blocked writes during staging
    if (blockedWrites.length > 0) {
      return { status: 'blockedWrite', detail: blockedWrites.join('; ') };
    }

    // If we couldn't fill both fields, the page structure is unsupported.
    // Since we probe before mutate, no partial mutation occurred.
    if (!platformOk || !ownershipOk) {
      return { status: 'unsupported', detail: 'could_not_fill_ownership_fields' };
    }

    // --- Step 4: Verify visible staged values ---
    let readFailed = false;
    const visibleState = await readVisibleBackloggdState(page, gameTitle, slug, {
      timeout: VERIFY_TIMEOUT_MS,
    }).catch(() => {
      readFailed = true;
      return null;
    });

    if (readFailed || !visibleState) {
      return { status: 'browserFailed', detail: 'visible_state_read_failed' };
    }

    if (blockedWrites.length > 0) {
      return { status: 'blockedWrite', detail: blockedWrites.join('; ') };
    }

    const plannedPlatform = (confirmation.planned_platform ?? '').trim().toLowerCase();
    const plannedOwnership = (confirmation.planned_ownership_type ?? '').trim().toLowerCase();

    // Check if the planned values appear in the visible ownership entries
    const matchFound = visibleState.library.ownershipEntries.some((entry) => {
      const entryPlatform = (entry.platform ?? '').trim().toLowerCase();
      const entryOwnership = (entry.ownershipType ?? '').trim().toLowerCase();
      return entryPlatform === plannedPlatform && entryOwnership === plannedOwnership;
    });

    if (!matchFound) {
      return {
        status: 'verificationFailed',
        detail: `planned values (${plannedPlatform}/${plannedOwnership}) not visible after staging`,
      };
    }

    // Check for blocked writes after verification
    if (blockedWrites.length > 0) {
      return { status: 'blockedWrite', detail: blockedWrites.join('; ') };
    }

    // --- Step 5: Settling window — catch delayed Backloggd POSTs ---
    // The select change can update visible UI immediately and schedule a
    // delayed POST (e.g. autosave via setTimeout).  Wait for the settling
    // period so any such request is blocked and tracked before we declare
    // the result as `staged`.
    await page.waitForTimeout(SETTLE_TIMEOUT_MS);

    if (blockedWrites.length > 0) {
      return { status: 'blockedWrite', detail: blockedWrites.join('; ') };
    }

    return { status: 'staged' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'browserFailed', detail: msg };
  } finally {
    page.removeListener('requestfailed', onRequestFailed);
  }
}

// ---------------------------------------------------------------------------
// Probe-before-mutate helpers (Finding 1)
// ---------------------------------------------------------------------------

/**
 * Check that a native `<select>` is visible, enabled, and has an option whose
 * label (case-insensitive) matches the intended value.
 *
 * Returns `true` if the control is fillable — does NOT mutate the page.
 */
async function isSelectFillable(page: Page, selectName: string, value: string): Promise<boolean> {
  if (value.length === 0) return false;
  const locator = page.locator(`select[name="${selectName}"]`).first();
  try {
    await locator.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    if (!(await locator.isVisible().catch(() => false))) return false;
    if (!(await locator.isEnabled().catch(() => false))) return false;
    // Check the intended option exists (case-insensitive label match)
    const label = value.charAt(0).toUpperCase() + value.slice(1);
    const option = locator
      .locator('option')
      .filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') });
    const optCount = await option.count().catch(() => 0);
    if (optCount !== 1) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Fill a native `<select>` with the option matching the intended value.
 * MUST only be called after `isSelectFillable` returns true for the same
 * select/value pair.
 */
async function fillSelectByName(page: Page, selectName: string, value: string): Promise<void> {
  const locator = page.locator(`select[name="${selectName}"]`).first();
  const label = value.charAt(0).toUpperCase() + value.slice(1);
  await locator.selectOption({ label });
}

/**
 * Fill both platform and ownership selects using confirmed planned values.
 * Caller must have proven both are fillable first.
 */
async function fillBothSelects(page: Page, confirmation: ConfirmationRow): Promise<void> {
  const platformValue = (confirmation.planned_platform ?? '').trim();
  const ownershipValue = (confirmation.planned_ownership_type ?? '').trim();
  await fillSelectByName(page, 'platform', platformValue);
  await fillSelectByName(page, 'ownership_type', ownershipValue);
}

/**
 * Probe both controls, then fill both if both are fillable.
 *
 * Tries three strategies in order:
 *   A — directly visible platform/ownership selects
 *   B — "Log or review" modal (platform in Review tab, Ownership in Details tab)
 *   C — standard editor opener (Add Ownership / Edit Library)
 *
 * Each strategy probes both controls before mutating either.
 * Returns `{ ok: true }` if both were filled, `{ ok: false }` otherwise.
 */
async function stageBothIfProbeOk(
  page: Page,
  confirmation: ConfirmationRow,
  slug: string,
  sessionId: string,
): Promise<{ ok: boolean }> {
  const platformValue = (confirmation.planned_platform ?? '').trim();
  const ownershipValue = (confirmation.planned_ownership_type ?? '').trim();

  // Strategy A: directly visible selects
  const platformFillable = await isSelectFillable(page, 'platform', platformValue);
  const ownershipFillable = await isSelectFillable(page, 'ownership_type', ownershipValue);

  if (platformFillable && ownershipFillable) {
    await fillBothSelects(page, confirmation);
    return { ok: true };
  }

  // Strategy B: "Log or review" modal
  const logModalOpened = await tryOpenLogOrReviewModal(page, slug, sessionId);
  if (logModalOpened) {
    // After modal opens, Review tab shows platform select, Details tab shows ownership
    const platformAfterOpen = await isSelectFillable(page, 'platform', platformValue);

    if (platformAfterOpen) {
      // Try clicking Details tab to reveal ownership control
      const detailsClicked = await clickDetailsTab(page);
      if (detailsClicked) {
        const ownershipAfterDetails = await isSelectFillable(
          page,
          'ownership_type',
          ownershipValue,
        );
        if (ownershipAfterDetails) {
          await fillBothSelects(page, confirmation);
          return { ok: true };
        }
        // Ownership not fillable after Details — do NOT fill platform alone
      }
    }
  }

  // Strategy C: standard editor opener
  const editorOpened = await tryOpenEditorViaOpener(page, slug, sessionId);
  if (editorOpened) {
    const platformAfterOpen = await isSelectFillable(page, 'platform', platformValue);
    const ownershipAfterOpen = await isSelectFillable(page, 'ownership_type', ownershipValue);

    if (platformAfterOpen && ownershipAfterOpen) {
      await fillBothSelects(page, confirmation);
      return { ok: true };
    }
    // Both controls must be fillable — do not mutate only one
  }

  return { ok: false };
}

/**
 * Try to open the "Log or review" modal by finding and clicking its opener.
 */
async function tryOpenLogOrReviewModal(
  page: Page,
  _slug: string,
  _sessionId: string,
): Promise<boolean> {
  // Look for a visible "Log or review" button via accessible role
  const logReviewBtn = page.getByRole('button', { name: 'Log or review', exact: true }).first();
  try {
    await logReviewBtn.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    const btnText = (await logReviewBtn.textContent().catch(() => '')) ?? '';
    if (textContainsForbiddenTerm(btnText)) return false;
    await logReviewBtn.click();
  } catch {
    return false;
  }

  // Wait for a visible select to appear (editor opened)
  await page.waitForTimeout(300);
  const platformSelect = page.locator('select[name="platform"]').first();
  try {
    await platformSelect.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to open the ownership editor via a safe opener button.
 */
async function tryOpenEditorViaOpener(
  page: Page,
  _slug: string,
  _sessionId: string,
): Promise<boolean> {
  // Look for a visible "Add Ownership" button via accessible role
  const addOwnBtn = page.getByRole('button', { name: 'Add Ownership', exact: true }).first();
  try {
    await addOwnBtn.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    const btnText = (await addOwnBtn.textContent().catch(() => '')) ?? '';
    if (textContainsForbiddenTerm(btnText)) return false;
    await addOwnBtn.click();
  } catch {
    return false;
  }

  // Wait for the editor to appear (platform select becomes visible)
  await page.waitForTimeout(300);
  const platformSelect = page.locator('select[name="platform"]').first();
  try {
    await platformSelect.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Click the Details tab in a log/review modal to reveal ownership controls.
 */
async function clickDetailsTab(page: Page): Promise<boolean> {
  const detailsBtn = page.getByRole('button', { name: 'Details', exact: true }).first();
  try {
    await detailsBtn.waitFor({ state: 'visible', timeout: PROBE_TIMEOUT_MS });
    await detailsBtn.click();
    await page.waitForTimeout(200);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run confirmed ownership staging for a session.
 *
 * Reads all confirmed confirmation rows, revalidates each against current
 * DB state, and for each valid row, stages the ownership change in the
 * browser without saving.
 *
 * @returns Array of staging results, one per confirmation row processed.
 */
export async function runConfirmedOwnershipStaging(
  options: OwnershipStagingExecutorOptions,
): Promise<StagingResult[]> {
  const { db, sessionId, page } = options;

  const results: StagingResult[] = [];

  // 1. Read all confirmed confirmation rows for this session
  const rows = db
    .prepare(
      `SELECT proposal_id, import_session_id, confirmation_batch_id,
              planned_platform, planned_ownership_type, planned_slug,
              planned_absent_checked_at, status
       FROM import_item_confirmations
       WHERE import_session_id = ?
         AND status = 'confirmed'
       ORDER BY id ASC`,
    )
    .all(sessionId) as ConfirmationRow[];

  if (rows.length === 0) {
    return results;
  }

  // 2. Install write guard on the page
  await installWriteGuard(page);

  // 3. Process each confirmation
  for (const confirmation of rows) {
    // Pre-browser revalidation
    const revalidation = revalidateConfirmation(db, sessionId, confirmation);
    if (!revalidation.ok) {
      results.push({
        proposalId: confirmation.proposal_id,
        status: 'stale',
        confirmationBatchId: confirmation.confirmation_batch_id,
        detail: revalidation.reason,
      });
      continue;
    }

    // Browser staging
    const stagingResult = await stageOwnershipInBrowser(page, confirmation, options);

    results.push({
      proposalId: confirmation.proposal_id,
      status: stagingResult.status,
      confirmationBatchId: confirmation.confirmation_batch_id,
      detail: stagingResult.detail,
    });
  }

  return results;
}
