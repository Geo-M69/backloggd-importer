/**
 * Playwright browser session for Milestone 4 Backloggd interaction proof of concept.
 *
 * Safety rules enforced:
 * - Never click final save/submit/update controls.
 * - Never extract or persist passwords, cookies, tokens, or hidden auth values.
 * - Never dump full page HTML.
 * - Browser auth remains only inside Playwright's persistent profile.
 */

import { chromium, type BrowserContext, type Locator, type Page, type Route } from 'playwright';
import type { SelectedItem } from './item-selector.js';
import {
  trySelectors,
  trySelectorsInLocator,
  platformSelectStrategies,
  ownershipTypeStrategies,
  ownershipLabelStrategies,
  ownershipTriggerAccessibleStrategies,
  ownershipTriggerNearbyExactStrategies,
  ownershipTriggerNearbyUniqueStrategies,
  ownershipValueStrategies,
  ownershipOptionStrategies,
  ownershipOpenPopupStrategies,
  saveButtonStrategies,
  fullEditorStrategies,
  statusButtonStrategies,
  loginCueStrategies,
  loggedInCueStrategies,
  openerStrategies,
  logOrReviewOpenerStrategies,
  editorRegionStrategies,
  logModalExpectedCuesStrategies,
  modalTabStrategies,
  detailsPanelCueStrategies,
  strategyNames,
  textContainsForbiddenTerm,
} from './selectors.js';
import { readPageState, verifyGamePage } from './page-reader.js';
import { buildDiagnostic, sanitizeUrl, type DiagnosticEntry } from './diagnostics.js';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Write guard — blocks non-safe requests to Backloggd during item processing
// ---------------------------------------------------------------------------

/** Methods that are always safe for read-only browsing. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Matches Backloggd's browser-triggered modal render path:
 * POST /render-editor/<numeric-id>
 *
 * Only allowed during the "Log or review" opener-reveal window.
 * See enableRenderEditorAllowance / disableRenderEditorAllowance.
 */
const RENDER_EDITOR_REGEX = /^\/render-editor\/\d+$/;

/**
 * Minimum time to keep the opener reveal window active while Backloggd
 * schedules its asynchronous render-editor POST and renders the dialog.
 */
const RENDER_EDITOR_REVEAL_TIMEOUT_MS = 2000;

/**
 * Per-page write-guard state for the render-editor POST allowance.
 *
 * The route handler reads this at request time to decide whether to
 * allow POST /render-editor/<numeric-id> through when the temporary
 * opener-reveal window is active.
 */
interface WriteGuardState {
  renderEditorAllowed: boolean;
  /** Set to true when the route handler allows POST /render-editor/<numeric-id>
   *  through during an active allowance window.  Reset after each reveal
   *  attempt so subsequent windows can be tracked independently. */
  renderEditorPostSeen: boolean;
}

/**
 * Map of pages to their write-guard state.
 */
const writeGuardStates = new WeakMap<Page, WriteGuardState>();

/**
 * Set of pages where the Backloggd write guard has been installed.
 * Used by processItem to assert the guard is present before any
 * opener click or modal interaction.
 */
const guardedPages = new WeakSet<Page>();

/**
 * Install a route guard on the page that allows only safe read methods
 * (GET, HEAD) to Backloggd domains and blocks all other methods.
 *
 * Also supports a temporary allowance for POST /render-editor/<numeric-id>
 * during the "Log or review" opener-reveal window.  See
 * enableRenderEditorAllowance / disableRenderEditorAllowance.
 *
 * Manual login is unaffected because the guard is installed *after* login
 * confirmation and *before* game-page processing.
 */
export async function installWriteGuard(page: Page): Promise<void> {
  // Keep one route handler and one shared state object per page. Reinstalling
  // would create multiple handlers whose allowance flags could disagree.
  if (guardedPages.has(page)) return;

  const state: WriteGuardState = { renderEditorAllowed: false, renderEditorPostSeen: false };
  writeGuardStates.set(page, state);

  // Match both apex (backloggd.com) and any subdomain (*.backloggd.com)
  await page.route(
    (url: URL) => {
      const hostname = url.hostname.toLowerCase();
      return hostname === 'backloggd.com' || hostname.endsWith('.backloggd.com');
    },
    async (route: Route) => {
      const method = route.request().method().toUpperCase();
      if (SAFE_METHODS.has(method)) {
        await route.continue();
        return;
      }

      // Temporary allowance for POST /render-editor/<numeric-id> during the
      // "Log or review" opener-reveal window.
      if (method === 'POST' && state.renderEditorAllowed) {
        const requestUrl = route.request().url();
        try {
          const parsed = new URL(requestUrl);
          if (RENDER_EDITOR_REGEX.test(parsed.pathname)) {
            state.renderEditorPostSeen = true;
            await route.fallback();
            return;
          }
        } catch {
          // Invalid URL — fall through to block
        }
      }

      const blockedUrl = route.request().url();
      // Log only the sanitized URL (origin + pathname) — never query/hash
      console.log(`  Write guard blocked: ${method} ${sanitizeUrl(blockedUrl)}`);
      await route.abort('blockedbyclient');
    },
  );
  guardedPages.add(page);
}

/**
 * Temporarily allow POST /render-editor/<numeric-id> on the given page.
 *
 * Must be called *before* clicking the "Log or review" opener and
 * paired with a subsequent disableRenderEditorAllowance() call after
 * the modal has been verified or the reveal attempt has failed.
 *
 * The allowance is scoped to the page's write-guard route handler and
 * has no effect if the guard has not been installed.
 */
export function enableRenderEditorAllowance(page: Page): void {
  const state = writeGuardStates.get(page);
  if (state) {
    state.renderEditorPostSeen = false;
    state.renderEditorAllowed = true;
  }
}

/**
 * Revoke the render-editor POST allowance.
 *
 * Call this immediately after the modal has been verified (or the
 * reveal attempt has failed) so that any stray POST /render-editor
 * requests are blocked.
 */
export function disableRenderEditorAllowance(page: Page): void {
  const state = writeGuardStates.get(page);
  if (state) {
    state.renderEditorAllowed = false;
  }
}

interface ExpectedLogDialogResult {
  dialog: import('playwright').Locator | null;
  sawVisibleDialog: boolean;
}

/**
 * Wait for a visible dialog containing an expected Log-or-review cue.
 *
 * The write-guard allowance remains active in the caller while this polls.
 * This gives Backloggd time to schedule its browser-owned render-editor POST
 * after the opener click and then render the returned modal content.
 */
async function waitForExpectedLogDialog(
  page: Page,
  timeout: number,
): Promise<ExpectedLogDialogResult> {
  const deadline = Date.now() + timeout;
  let sawVisibleDialog = false;
  const protocol = new URL(page.url()).protocol;
  const requireRenderEditorPost = protocol === 'http:' || protocol === 'https:';

  do {
    const dialogs = page.locator('role=dialog');
    const dialogCount = await dialogs.count().catch(() => 0);

    for (let index = 0; index < dialogCount; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) continue;
      sawVisibleDialog = true;

      for (const strategy of logModalExpectedCuesStrategies) {
        const cueVisible = await dialog
          .locator(strategy.selector)
          .first()
          .isVisible()
          .catch(() => false);
        if (cueVisible) {
          const renderEditorPostSeen = writeGuardStates.get(page)?.renderEditorPostSeen === true;
          if (!requireRenderEditorPost || renderEditorPostSeen) {
            return { dialog, sawVisibleDialog };
          }
        }
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(25, remaining));
  } while (Date.now() < deadline);

  return { dialog: null, sawVisibleDialog };
}

export interface PocResult {
  item: SelectedItem;
  pageState: Awaited<ReturnType<typeof readPageState>>;
  filled: boolean;
  saveDetected: boolean;
  error?: string;
  diagnostics: DiagnosticEntry[];
}

export interface PocSessionOptions {
  profileDir: string;
  headless?: boolean;
}

/**
 * Launch a persistent headed Chromium browser session.
 */
export async function launchSession(options: PocSessionOptions): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(options.profileDir, {
    headless: false,
    viewport: { width: 1280, height: 720 },
  });
  return context;
}

/**
 * Prompt the user in the terminal to sign in to Backloggd manually.
 */
export async function promptForLogin(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question(
      'Please sign in to Backloggd in the opened browser, then press Enter to continue...',
      () => {
        rl.close();
        resolve();
      },
    );
  });
}

/**
 * Check whether the user appears to be signed in by looking for visible cues.
 * Returns true if logged-in cues are found, false if login cues are found,
 * null if ambiguous.
 */
export async function detectLoginState(
  page: Page,
  options: { timeout?: number } = {},
): Promise<boolean | null> {
  const timeout = options.timeout ?? 1500;
  const loginResult = await trySelectors(page, loginCueStrategies, { visible: true, timeout });
  if (loginResult) return false;

  const loggedInResult = await trySelectors(page, loggedInCueStrategies, {
    visible: true,
    timeout,
  });
  if (loggedInResult) return true;

  return null;
}

// ---------------------------------------------------------------------------
// Helper: attempt to fill platform control
// ---------------------------------------------------------------------------

export async function attemptFillPlatform(page: Page, timeout?: number): Promise<boolean> {
  const platformResult = await trySelectors(page, platformSelectStrategies, {
    visible: true,
    timeout,
  });
  if (!platformResult) return false;
  try {
    await platformResult.locator.selectOption('Steam');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper: attempt to fill ownership type control
// ---------------------------------------------------------------------------

export async function attemptFillOwnership(page: Page, timeout?: number): Promise<boolean> {
  const ownershipResult = await trySelectors(page, ownershipTypeStrategies, {
    visible: true,
    timeout,
  });
  if (!ownershipResult) return false;
  try {
    await ownershipResult.locator.selectOption('Digital');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Probe whether a control is visible without mutating it.
// Returns true if at least one strategy matches a visible element.
// ---------------------------------------------------------------------------

async function probeControl(
  page: Page,
  strategies: import('./selectors.js').SelectorStrategy[],
  timeout?: number,
): Promise<boolean> {
  const result = await trySelectors(page, strategies, { visible: true, timeout });
  return result !== null;
}

// ---------------------------------------------------------------------------
// Reveal the library/ownership editor by locating and clicking a safe opener.
//
// Returns true if the editor appeared, false otherwise.  Pushes diagnostics
// for: no safe opener found, or missing editor.
//
// Blocked-write tracking is NOT handled here — it is managed at the
// processItem level so that delayed writes (e.g. setTimeout POST) are
// captured throughout the entire item-processing lifecycle.
// ---------------------------------------------------------------------------

export async function revealEditor(
  page: Page,
  item: SelectedItem,
  sessionId: string,
  diagnostics: DiagnosticEntry[],
  options: { timeout?: number } = {},
): Promise<boolean> {
  // Use a short fixed timeout for all internal searches — opener buttons and
  // editor regions should be visible quickly if they exist.  Long timeouts
  // here cause the whole item to stall when no safe opener is present.
  const searchTimeout = options.timeout ?? 500;

  // Find a safe opener using accessible selectors first
  const openerResult = await trySelectors(page, openerStrategies, {
    visible: true,
    timeout: searchTimeout,
  });
  if (!openerResult) {
    diagnostics.push(
      buildDiagnostic({
        step: 'find-opener',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: strategyNames(openerStrategies),
        error: 'No safe opener found. Cannot reveal library/ownership editor.',
      }),
    );
    return false;
  }

  // Validate the opener candidate does NOT contain forbidden final-action
  // terms in its visible text, aria-label, aria-labelledby references, or
  // browser-computed accessible name.
  //
  // The browser computes an accessible name from, in priority order:
  //   aria-labelledby → aria-label → text content
  // We must check all three explicit sources plus a best-effort computed
  // name so that a fallback text-matched opener with an unsafe accessible
  // name (e.g. via aria-labelledby) is rejected.
  const openerText = (await openerResult.locator.textContent().catch(() => '')) ?? '';
  const openerAriaLabel = await openerResult.locator.getAttribute('aria-label').catch(() => null);
  const openerLabelledby = await openerResult.locator
    .getAttribute('aria-labelledby')
    .catch(() => null);

  // --- Visible text --------------------------------------------------------
  if (textContainsForbiddenTerm(openerText)) {
    diagnostics.push(
      buildDiagnostic({
        step: 'find-opener',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [openerResult.strategyName],
        error: `Opener candidate "${openerText.trim()}" (visible text) contains a forbidden final-action term and was rejected.`,
      }),
    );
    return false;
  }

  // --- aria-label ----------------------------------------------------------
  if (openerAriaLabel && textContainsForbiddenTerm(openerAriaLabel)) {
    diagnostics.push(
      buildDiagnostic({
        step: 'find-opener',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [openerResult.strategyName],
        error: `Opener candidate with aria-label "${openerAriaLabel}" contains a forbidden final-action term and was rejected.`,
      }),
    );
    return false;
  }

  // --- aria-labelledby (resolve referenced element texts) ------------------
  if (openerLabelledby) {
    const refIds = openerLabelledby
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean);
    for (const id of refIds) {
      const refText = await page
        .locator(`#${id}`)
        .textContent()
        .catch(() => '');
      if (textContainsForbiddenTerm(refText ?? '')) {
        diagnostics.push(
          buildDiagnostic({
            step: 'find-opener',
            url: page.url(),
            sessionId,
            steamAppId: item.steamAppId,
            backloggdSlug: item.backloggdSlug,
            attemptedSelectors: [openerResult.strategyName],
            error: `Opener candidate references "#${id}" via aria-labelledby (text: "${(refText ?? '').trim()}") which contains a forbidden final-action term and was rejected.`,
          }),
        );
        return false;
      }
    }
  }

  // NOTE: The browser-computed accessible name is not directly exposed via
  // a simple DOM property.  The ariaLabel IDL attribute simply reflects the
  // aria-label content attribute, which is already checked above.  For a
  // full computed-name check we would need CDP accessibility tree support.
  // The aria-labelledby resolution above provides the needed coverage for
  // the most common case where the computed name differs from the visible
  // text.

  // Click the opener
  await openerResult.locator.click();

  // Wait for the editor/modal to appear
  const editorResult = await trySelectors(page, editorRegionStrategies, {
    visible: true,
    timeout: searchTimeout,
  });
  if (!editorResult) {
    diagnostics.push(
      buildDiagnostic({
        step: 'wait-for-editor',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: strategyNames(editorRegionStrategies),
        error: 'Modal/editor did not appear after clicking opener.',
      }),
    );
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// "Log or review" modal — find, validate, click, and verify the expected
// Backloggd game-log dialog appears.
//
// Returns the verified dialog locator on success, or null on failure.
// Pushes diagnostics for:
//   log-or-review-opener-not-found
//   expected-log-modal-not-found
//
// The caller is responsible for blocked-write tracking (handled at the
// processItem level).
// ---------------------------------------------------------------------------

export async function revealLogOrReviewModal(
  page: Page,
  item: SelectedItem,
  sessionId: string,
  diagnostics: DiagnosticEntry[],
  options: { timeout?: number } = {},
): Promise<import('playwright').Locator | null> {
  const searchTimeout = options.timeout ?? 1000;

  // Find "Log or review" via the dedicated opener strategies.
  const openerResult = await trySelectors(page, logOrReviewOpenerStrategies, {
    visible: true,
    timeout: searchTimeout,
  });
  if (!openerResult) {
    diagnostics.push(
      buildDiagnostic({
        step: 'log-or-review-opener-not-found',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: strategyNames(logOrReviewOpenerStrategies),
        error: 'No safe Log or review opener found. Cannot reveal game-log dialog.',
      }),
    );
    return null;
  }

  // Validate opener with forbidden-term check (same as revealEditor)
  const openerText = (await openerResult.locator.textContent().catch(() => '')) ?? '';
  const openerAriaLabel = await openerResult.locator.getAttribute('aria-label').catch(() => null);
  const openerLabelledby = await openerResult.locator
    .getAttribute('aria-labelledby')
    .catch(() => null);

  if (textContainsForbiddenTerm(openerText)) {
    diagnostics.push(
      buildDiagnostic({
        step: 'find-opener',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [openerResult.strategyName],
        error: `Opener candidate "${openerText.trim()}" (visible text) contains a forbidden final-action term and was rejected.`,
      }),
    );
    return null;
  }

  if (openerAriaLabel && textContainsForbiddenTerm(openerAriaLabel)) {
    diagnostics.push(
      buildDiagnostic({
        step: 'find-opener',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [openerResult.strategyName],
        error: `Opener candidate with aria-label "${openerAriaLabel}" contains a forbidden final-action term and was rejected.`,
      }),
    );
    return null;
  }

  if (openerLabelledby) {
    const refIds = openerLabelledby
      .split(/\s+/)
      .map((id) => id.trim())
      .filter(Boolean);
    for (const id of refIds) {
      const refText = await page
        .locator(`#${id}`)
        .textContent()
        .catch(() => '');
      if (textContainsForbiddenTerm(refText ?? '')) {
        diagnostics.push(
          buildDiagnostic({
            step: 'find-opener',
            url: page.url(),
            sessionId,
            steamAppId: item.steamAppId,
            backloggdSlug: item.backloggdSlug,
            attemptedSelectors: [openerResult.strategyName],
            error: `Opener candidate references "#${id}" via aria-labelledby (text: "${(refText ?? '').trim()}") which contains a forbidden final-action term and was rejected.`,
          }),
        );
        return null;
      }
    }
  }

  // Enable the render-editor POST allowance so the browser can load modal
  // content via POST /render-editor/<numeric-id>.  The allowance is scoped
  // to the write-guard route handler and lasts only until we disable it.
  //
  // The allowance is always disabled in a finally block below, regardless
  // of whether the opener click, modal detection, or cue verification
  // succeeds, fails, or throws.
  enableRenderEditorAllowance(page);

  try {
    // Click the opener.  The browser may fire a POST /render-editor/<id>
    // which the write guard will now allow through.
    await openerResult.locator.click();

    // Keep the allowance active while waiting for both the asynchronous
    // render-editor request (tracked by the route handler) and the expected
    // modal cues. Static fixtures may render cues without a network request,
    // while the live page renders them after renderEditorPostSeen becomes true.
    const revealTimeout = Math.max(searchTimeout, RENDER_EDITOR_REVEAL_TIMEOUT_MS);
    const dialogResult = await waitForExpectedLogDialog(page, revealTimeout);

    if (!dialogResult.dialog) {
      diagnostics.push(
        buildDiagnostic({
          step: 'expected-log-modal-not-found',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: strategyNames(logModalExpectedCuesStrategies),
          error: dialogResult.sawVisibleDialog
            ? 'Expected Backloggd game-log dialog cues not found inside the dialog after clicking Log or review.'
            : 'No dialog appeared after clicking Log or review.',
        }),
      );
      return null;
    }

    return dialogResult.dialog;
  } finally {
    // Always disable the render-editor allowance, whether we succeeded,
    // failed, or an exception was thrown.  This guarantees the write
    // guard returns to its strict default even if the opener click or
    // modal verification throws unexpectedly.
    disableRenderEditorAllowance(page);

    const guardState = writeGuardStates.get(page);
    if (guardState?.renderEditorPostSeen) {
      guardState.renderEditorPostSeen = false;
      diagnostics.push(
        buildDiagnostic({
          step: 'render-editor-request-allowed',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: strategyNames(logOrReviewOpenerStrategies),
          error:
            'POST /render-editor/<numeric-id> was allowed during the Log-or-review reveal window.',
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Fill ownership in the "Log or review" modal.
//
// Strategy:
//   1. Locate and click the exact Details tab inside the verified dialog.
//   2. Require a visible Details-only cue before searching for Ownership.
//   3. If the Details tab click triggers a blocked write, fail closed.
//   4. Search for and fill Ownership only after Details activation.
//
// Returns:
//   { ownershipOk, detailsTabClicked } — ownershipOk indicates ownership was
//   filled, detailsTabClicked indicates the Details control was clicked.
// ---------------------------------------------------------------------------

interface ScopedOwnershipTrigger {
  locator: Locator;
  region: Locator;
  strategyName: string;
}

async function findFirstVisibleInScope(
  scope: Locator,
  strategies: readonly { name: string; selector: string }[],
): Promise<{ locator: Locator; strategyName: string } | null> {
  for (const strategy of strategies) {
    const matches = scope.locator(strategy.selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      if (await match.isVisible().catch(() => false)) {
        return { locator: match, strategyName: strategy.name };
      }
    }
  }
  return null;
}

async function findUniqueVisibleInScope(
  scope: Locator,
  strategies: readonly { name: string; selector: string }[],
): Promise<{ locator: Locator; strategyName: string } | null> {
  for (const strategy of strategies) {
    const matches = scope.locator(strategy.selector);
    const count = await matches.count().catch(() => 0);
    const visible: Locator[] = [];
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      if (await match.isVisible().catch(() => false)) {
        visible.push(match);
      }
    }
    if (visible.length === 1) {
      return { locator: visible[0], strategyName: strategy.name };
    }
  }
  return null;
}

async function findOwnershipTriggerNearLabel(
  dialogLocator: Locator,
  ownershipLabel: Locator,
): Promise<ScopedOwnershipTrigger | null> {
  const accessible = await findFirstVisibleInScope(
    dialogLocator,
    ownershipTriggerAccessibleStrategies,
  );
  if (accessible) {
    return {
      ...accessible,
      region: ownershipLabel.locator('xpath=..'),
    };
  }

  // Walk outward from the exact Ownership label. Generic custom-dropdown
  // shapes are accepted only when exactly one is visible in the current,
  // smallest region. This prevents selecting Played on or Bundle played.
  let region = ownershipLabel;
  for (let depth = 0; depth < 4; depth += 1) {
    region = region.locator('xpath=..');

    const exact = await findFirstVisibleInScope(region, ownershipTriggerNearbyExactStrategies);
    if (exact) {
      return { ...exact, region };
    }

    const nearbyOtherLabels = region.locator(':text-is("Played on"), :text-is("Bundle played")');
    const otherLabelCount = await nearbyOtherLabels.count().catch(() => 0);
    let containsVisibleOtherLabel = false;
    for (let index = 0; index < otherLabelCount; index += 1) {
      if (
        await nearbyOtherLabels
          .nth(index)
          .isVisible()
          .catch(() => false)
      ) {
        containsVisibleOtherLabel = true;
        break;
      }
    }

    if (!containsVisibleOtherLabel) {
      const unique = await findUniqueVisibleInScope(region, ownershipTriggerNearbyUniqueStrategies);
      if (unique) {
        return { ...unique, region };
      }
    }
  }

  return null;
}

async function ownershipValueIsVisiblyOwned(
  page: Page,
  trigger: Locator,
  region: Locator,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout;

  do {
    const candidates = [
      trigger,
      ...ownershipValueStrategies.map((strategy) => region.locator(strategy.selector).first()),
    ];

    for (const candidate of candidates) {
      if (!(await candidate.isVisible().catch(() => false))) continue;

      const visibleText = await candidate
        .innerText()
        .then((text) => text.replace(/\s+/g, ' ').trim())
        .catch(() => '');
      if (visibleText === 'Owned') return true;

      const ariaValue = await candidate.getAttribute('aria-valuetext').catch(() => null);
      if (ariaValue?.trim() === 'Owned') return true;

      const inputValue = await candidate.inputValue().catch(() => '');
      if (inputValue.trim() === 'Owned') return true;
    }

    if (Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
  } while (Date.now() < deadline);

  return false;
}

interface VisibleStrategyMatches {
  locators: Locator[];
  strategyName: string;
}

type OwnedOptionResolution =
  | {
      status: 'found';
      locator: Locator;
      optionStrategyName: string;
      popupStrategyName: string;
    }
  | {
      status: 'ambiguous';
      optionStrategyName: string;
      popupStrategyName: string;
      visibleCount: number;
    }
  | {
      status: 'not-found';
      popupStrategyName: string;
    };

async function findVisibleMatchesByStrategy(
  scope: Locator,
  strategies: readonly { name: string; selector: string }[],
): Promise<VisibleStrategyMatches | null> {
  for (const strategy of strategies) {
    const matches = scope.locator(strategy.selector);
    const count = await matches.count().catch(() => 0);
    const visible: Locator[] = [];
    for (let index = 0; index < count; index += 1) {
      const match = matches.nth(index);
      if (await match.isVisible().catch(() => false)) {
        visible.push(match);
      }
    }
    if (visible.length > 0) {
      return { locators: visible, strategyName: strategy.name };
    }
  }
  return null;
}

async function resolveOwnedAcrossPopups(
  popups: VisibleStrategyMatches,
): Promise<OwnedOptionResolution> {
  const visibleOptions: Locator[] = [];
  let optionStrategyName = '';

  for (const popup of popups.locators) {
    const options = await findVisibleMatchesByStrategy(popup, ownershipOptionStrategies);
    if (!options) continue;
    if (!optionStrategyName) optionStrategyName = options.strategyName;
    visibleOptions.push(...options.locators);
  }

  if (visibleOptions.length === 1) {
    return {
      status: 'found',
      locator: visibleOptions[0],
      optionStrategyName,
      popupStrategyName: popups.strategyName,
    };
  }
  if (visibleOptions.length > 1) {
    return {
      status: 'ambiguous',
      optionStrategyName,
      popupStrategyName: popups.strategyName,
      visibleCount: visibleOptions.length,
    };
  }
  return { status: 'not-found', popupStrategyName: popups.strategyName };
}

async function resolveVisibleOwnedOption(
  page: Page,
  dialogLocator: Locator,
  ownershipTrigger: ScopedOwnershipTrigger,
): Promise<OwnedOptionResolution> {
  // Prefer an explicit trigger-to-popup association. This supports popups
  // portaled outside the dialog without broadening the search prematurely.
  const controlledIds = [
    await ownershipTrigger.locator.getAttribute('aria-controls').catch(() => null),
    await ownershipTrigger.locator.getAttribute('aria-owns').catch(() => null),
  ]
    .flatMap((value) => value?.split(/\s+/) ?? [])
    .filter((value) => value.length > 0);

  const controlledPopups: Locator[] = [];
  for (const id of controlledIds) {
    const escapedId = id.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const popup = page.locator(`[id="${escapedId}"]`);
    if ((await popup.count()) === 1 && (await popup.isVisible().catch(() => false))) {
      controlledPopups.push(popup);
    }
  }
  if (controlledPopups.length > 0) {
    return resolveOwnedAcrossPopups({
      locators: controlledPopups,
      strategyName: 'ownership-popup-trigger-associated',
    });
  }

  const popupScopes: { scope: Locator; prefix: string }[] = [
    { scope: ownershipTrigger.region, prefix: 'ownership-region' },
    { scope: dialogLocator, prefix: 'ownership-dialog' },
    { scope: page.locator('body'), prefix: 'ownership-page-portal' },
  ];

  for (const popupScope of popupScopes) {
    const popups = await findVisibleMatchesByStrategy(
      popupScope.scope,
      ownershipOpenPopupStrategies,
    );
    if (!popups) continue;
    return resolveOwnedAcrossPopups({
      locators: popups.locators,
      strategyName: `${popupScope.prefix}:${popups.strategyName}`,
    });
  }

  // Last resort: after the trigger was opened, accept only one exact visible
  // Owned option on the page. Multiple matches fail closed.
  const pageOptions = await findVisibleMatchesByStrategy(
    page.locator('body'),
    ownershipOptionStrategies,
  );
  if (!pageOptions) {
    return { status: 'not-found', popupStrategyName: 'ownership-page-exact-fallback' };
  }
  if (pageOptions.locators.length > 1) {
    return {
      status: 'ambiguous',
      optionStrategyName: pageOptions.strategyName,
      popupStrategyName: 'ownership-page-exact-fallback',
      visibleCount: pageOptions.locators.length,
    };
  }
  return {
    status: 'found',
    locator: pageOptions.locators[0],
    optionStrategyName: pageOptions.strategyName,
    popupStrategyName: 'ownership-page-exact-fallback',
  };
}

async function handleLogOrReviewOwnership(
  page: Page,
  dialogLocator: import('playwright').Locator,
  item: SelectedItem,
  sessionId: string,
  itemDiagnostics: DiagnosticEntry[],
  blockedWrites: string[],
  timeout?: number,
): Promise<{ ownershipOk: boolean; detailsTabClicked: boolean }> {
  // --- Phase 1: Locate and activate Details (real Backloggd UI) ---
  const detailsTab = await trySelectorsInLocator(dialogLocator, modalTabStrategies, {
    visible: true,
    timeout,
  });

  if (!detailsTab) {
    itemDiagnostics.push(
      buildDiagnostic({
        step: 'details-tab-not-found',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: strategyNames(modalTabStrategies),
        error: 'Exact Details tab/control not found in the Log or review modal.',
      }),
    );
    return { ownershipOk: false, detailsTabClicked: false };
  }

  const preClickBlocked = blockedWrites.length;
  try {
    await detailsTab.locator.click({ timeout: timeout ?? 3000 });
  } catch {
    itemDiagnostics.push(
      buildDiagnostic({
        step: 'details-tab-click-failed',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [detailsTab.strategyName],
        error: 'Exact Details tab/control was found but could not be clicked.',
      }),
    );
    return { ownershipOk: false, detailsTabClicked: false };
  }

  itemDiagnostics.push(
    buildDiagnostic({
      step: 'details-tab-clicked',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: [detailsTab.strategyName],
      error: 'Exact Details tab/control was clicked.',
    }),
  );

  await page.waitForTimeout(300);

  if (blockedWrites.length > preClickBlocked) {
    itemDiagnostics.push(
      buildDiagnostic({
        step: 'details-tab-blocked-write',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [detailsTab.strategyName],
        error: 'Details tab click triggered a blocked write request.',
      }),
    );
    return { ownershipOk: false, detailsTabClicked: true };
  }

  const detailsCue = await trySelectorsInLocator(dialogLocator, detailsPanelCueStrategies, {
    visible: true,
    timeout,
  });
  if (!detailsCue) {
    itemDiagnostics.push(
      buildDiagnostic({
        step: 'details-tab-not-active',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: strategyNames(detailsPanelCueStrategies),
        error: 'Details tab was clicked, but no visible Details-only cue appeared.',
      }),
    );
    return { ownershipOk: false, detailsTabClicked: true };
  }

  itemDiagnostics.push(
    buildDiagnostic({
      step: 'details-tab-active',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: [detailsCue.strategyName],
      error: `Details panel activation verified via "${detailsCue.strategyName}".`,
    }),
  );

  // --- Phase 2: Find the exact label, then its nearby trigger ---
  const ownershipLabel = await findFirstVisibleInScope(dialogLocator, ownershipLabelStrategies);
  if (!ownershipLabel) {
    itemDiagnostics.push(
      buildDiagnostic({
        step: 'ownership-control-missing-details',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: strategyNames(ownershipLabelStrategies),
        error: 'Exact Ownership label not found in the active Details panel.',
      }),
    );
    return { ownershipOk: false, detailsTabClicked: true };
  }

  itemDiagnostics.push(
    buildDiagnostic({
      step: 'ownership-label-found',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: [ownershipLabel.strategyName],
      error: `Exact Ownership label found via "${ownershipLabel.strategyName}".`,
    }),
  );

  const ownershipTrigger = await findOwnershipTriggerNearLabel(
    dialogLocator,
    ownershipLabel.locator,
  );
  if (!ownershipTrigger) {
    itemDiagnostics.push(
      buildDiagnostic({
        step: 'ownership-trigger-not-found',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [
          ...strategyNames(ownershipTriggerAccessibleStrategies),
          ...strategyNames(ownershipTriggerNearbyExactStrategies),
          ...strategyNames(ownershipTriggerNearbyUniqueStrategies),
        ],
        error: 'Ownership label was found, but no safe associated dropdown trigger was found.',
      }),
    );
    return { ownershipOk: false, detailsTabClicked: true };
  }

  itemDiagnostics.push(
    buildDiagnostic({
      step: 'ownership-trigger-found',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: [ownershipTrigger.strategyName],
      error: `Ownership trigger found near its exact label via "${ownershipTrigger.strategyName}".`,
    }),
  );

  // Retain the established diagnostic for downstream compatibility.
  itemDiagnostics.push(
    buildDiagnostic({
      step: 'ownership-control-found-details',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: [ownershipTrigger.strategyName],
      error: `Ownership control found in Details tab via strategy "${ownershipTrigger.strategyName}".`,
    }),
  );

  // --- Phase 3: Open the dropdown and select exact option "Owned" ---
  const ownershipTagName = await ownershipTrigger.locator
    .evaluate((element) => element.tagName)
    .catch(() => '');

  if (ownershipTagName === 'SELECT') {
    const ownedNativeOption = ownershipTrigger.locator
      .locator('option')
      .filter({ hasText: /^Owned$/ })
      .first();
    if ((await ownedNativeOption.count()) === 0) {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'ownership-owned-option-not-found',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: ['native-option-owned'],
          error: 'Ownership dropdown opened, but exact option "Owned" was not found.',
        }),
      );
      return { ownershipOk: false, detailsTabClicked: true };
    }

    itemDiagnostics.push(
      buildDiagnostic({
        step: 'ownership-dropdown-opened',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [ownershipTrigger.strategyName],
        error: 'Ownership dropdown opened.',
      }),
      buildDiagnostic({
        step: 'ownership-owned-option-found',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: ['native-option-owned'],
        error: 'Exact Ownership option "Owned" found.',
      }),
    );

    const targetValue = await ownedNativeOption.getAttribute('value');
    await ownershipTrigger.locator.selectOption(targetValue ?? { label: 'Owned' });
  } else {
    const preOpenBlocked = blockedWrites.length;
    try {
      await ownershipTrigger.locator.click({ timeout: timeout ?? 3000 });
    } catch {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'ownership-selection-unverified',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: [ownershipTrigger.strategyName],
          error: 'Ownership trigger was found but could not be clicked.',
        }),
      );
      return { ownershipOk: false, detailsTabClicked: true };
    }
    await page.waitForTimeout(200);

    if (blockedWrites.length > preOpenBlocked) {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'ownership-selection-unverified',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: [ownershipTrigger.strategyName],
          error: 'Opening the Ownership dropdown triggered a blocked write request.',
        }),
      );
      return { ownershipOk: false, detailsTabClicked: true };
    }

    itemDiagnostics.push(
      buildDiagnostic({
        step: 'ownership-dropdown-opened',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [ownershipTrigger.strategyName],
        error: 'Ownership dropdown trigger clicked.',
      }),
    );

    const ownedOption = await resolveVisibleOwnedOption(page, dialogLocator, ownershipTrigger);
    if (ownedOption.status === 'not-found') {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'ownership-owned-option-not-found',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: [
            ownedOption.popupStrategyName,
            ...strategyNames(ownershipOptionStrategies),
          ],
          error: 'Ownership dropdown opened, but exact option "Owned" was not found.',
        }),
      );
      return { ownershipOk: false, detailsTabClicked: true };
    }
    if (ownedOption.status === 'ambiguous') {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'ownership-owned-option-ambiguous',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: [ownedOption.popupStrategyName, ownedOption.optionStrategyName],
          error:
            'Multiple visible exact "Owned" options were found without a safe unique association.',
        }),
      );
      return { ownershipOk: false, detailsTabClicked: true };
    }

    itemDiagnostics.push(
      buildDiagnostic({
        step: 'ownership-owned-option-found',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [ownedOption.optionStrategyName, ownedOption.popupStrategyName],
        error: 'Exact Ownership option "Owned" found.',
      }),
      buildDiagnostic({
        step: 'ownership-owned-option-visible',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [ownedOption.optionStrategyName, ownedOption.popupStrategyName],
        error: 'Exact Ownership option "Owned" is uniquely visible in the open popup.',
      }),
    );

    const optionEnabled = await ownedOption.locator.isEnabled().catch(() => false);
    const optionAriaDisabled = await ownedOption.locator
      .getAttribute('aria-disabled')
      .catch(() => null);
    const optionBox = await ownedOption.locator.boundingBox().catch(() => null);
    const pointerEvents = await ownedOption.locator
      .evaluate((element) => getComputedStyle(element).pointerEvents)
      .catch(() => 'none');
    if (
      !optionEnabled ||
      optionAriaDisabled === 'true' ||
      optionBox === null ||
      pointerEvents === 'none'
    ) {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'ownership-owned-option-not-actionable',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: [ownedOption.optionStrategyName, ownedOption.popupStrategyName],
          error: 'Exact visible Ownership option "Owned" was not actionable.',
        }),
      );
      return { ownershipOk: false, detailsTabClicked: true };
    }

    const preSelectBlocked = blockedWrites.length;
    try {
      await ownedOption.locator.scrollIntoViewIfNeeded({ timeout: 1500 });
      await ownedOption.locator.click({ timeout: Math.max(timeout ?? 3000, 2000) });
    } catch {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'ownership-owned-click-failed',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: [ownedOption.optionStrategyName, ownedOption.popupStrategyName],
          error: 'Exact visible Ownership option "Owned" failed a normal click.',
        }),
      );
      return { ownershipOk: false, detailsTabClicked: true };
    }
    await page.waitForTimeout(200);

    if (blockedWrites.length > preSelectBlocked) {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'ownership-selection-unverified',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: [ownedOption.optionStrategyName, ownedOption.popupStrategyName],
          error: 'Selecting "Owned" in Ownership dropdown triggered a blocked write request.',
        }),
      );
      return { ownershipOk: false, detailsTabClicked: true };
    }
  }

  itemDiagnostics.push(
    buildDiagnostic({
      step: 'ownership-owned-clicked',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: ['exact-owned'],
      error: 'Exact Ownership option "Owned" clicked.',
    }),
  );

  const verified = await ownershipValueIsVisiblyOwned(
    page,
    ownershipTrigger.locator,
    ownershipTrigger.region,
    500,
  );
  if (!verified) {
    itemDiagnostics.push(
      buildDiagnostic({
        step: 'ownership-selection-unverified',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: strategyNames(ownershipValueStrategies),
        error: 'Exact option "Owned" was clicked, but the visible Ownership value did not update.',
      }),
    );
    return { ownershipOk: false, detailsTabClicked: true };
  }

  itemDiagnostics.push(
    buildDiagnostic({
      step: 'ownership-owned-verified',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: strategyNames(ownershipValueStrategies),
      error: 'Visible Ownership value verified as "Owned".',
    }),
    buildDiagnostic({
      step: 'ownership-owned-selected',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: ['exact-owned'],
      error: 'Successfully selected "Owned" in the Ownership control.',
    }),
  );

  return { ownershipOk: true, detailsTabClicked: true };
}

// ---------------------------------------------------------------------------
// Re-check login state after the manual sign-in prompt.
// Returns true if logged in, emits a diagnostic and returns false otherwise.
// ---------------------------------------------------------------------------

export async function checkLoginAfterPrompt(
  page: Page,
  sessionId: string,
  diagnostics: DiagnosticEntry[],
  options: { timeout?: number } = {},
): Promise<boolean> {
  const loginState = await detectLoginState(page, options);
  if (loginState === false) {
    diagnostics.push(
      buildDiagnostic({
        step: 'signed-out-cue-visible',
        url: page.url(),
        sessionId,
        attemptedSelectors: [
          ...strategyNames(loginCueStrategies),
          ...strategyNames(loggedInCueStrategies),
        ],
        error: 'Not logged in after manual prompt. Sign-in cues are still visible.',
      }),
    );
    return false;
  }
  if (loginState === null) {
    diagnostics.push(
      buildDiagnostic({
        step: 'ambiguous-login-state',
        url: page.url(),
        sessionId,
        attemptedSelectors: [
          ...strategyNames(loginCueStrategies),
          ...strategyNames(loggedInCueStrategies),
        ],
        error: 'Not logged in after manual prompt. Neither logged-in nor sign-in cues detected.',
      }),
    );
    return false;
  }
  return true;
}

/**
 * Process a single selected item: open page, read state, fill ownership, stop before save.
 *
 * Safety rules:
 * - Never click final save/submit/update controls.
 * - Probe required controls without mutating them; fill only when BOTH
 *   required controls are present and fillable (no partial mutation).
 * - Track blocked Backloggd write requests throughout processing and fail
 *   the item if any are observed.
 */

// ---------------------------------------------------------------------------
// Helper: emit blocked-write diagnostics for every entry in blockedWrites.
// Returns a human-readable error string if any writes were blocked, or null
// if the array is empty.  This is called at least twice during processItem:
// once after the settling window and once before the final success return.
// ---------------------------------------------------------------------------

function emitBlockedWriteDiagnostics(
  blockedWrites: string[],
  page: Page,
  item: SelectedItem,
  sessionId: string,
  itemDiagnostics: DiagnosticEntry[],
): string | null {
  if (blockedWrites.length === 0) return null;

  for (const entry of blockedWrites) {
    if (entry.startsWith('RENDER_EDITOR:')) {
      const detail = entry.slice('RENDER_EDITOR:'.length);
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'render-editor-request-blocked-outside-window',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: strategyNames(openerStrategies),
          error: `Render-editor POST blocked outside allowance window: ${detail}`,
        }),
      );
    } else {
      itemDiagnostics.push(
        buildDiagnostic({
          step: 'blocked-write-request',
          url: page.url(),
          sessionId,
          steamAppId: item.steamAppId,
          backloggdSlug: item.backloggdSlug,
          attemptedSelectors: [
            ...strategyNames(openerStrategies),
            ...strategyNames(platformSelectStrategies),
            ...strategyNames(ownershipTypeStrategies),
          ],
          error: `Blocked write request detected: ${entry}`,
        }),
      );
    }
  }

  return `Blocked write request detected: ${blockedWrites.map((e) => e.replace(/^RENDER_EDITOR:/, '')).join(', ')}`;
}

export async function processItem(
  page: Page,
  item: SelectedItem,
  sessionId: string,
  options: { timeout?: number } = {},
): Promise<PocResult> {
  const itemDiagnostics: DiagnosticEntry[] = [];
  const timeout = options.timeout;

  // -----------------------------------------------------------------------
  // Write-guard prerequisite — assert the page is guarded before any
  // opener click or modal interaction.
  // -----------------------------------------------------------------------
  if (!guardedPages.has(page)) {
    itemDiagnostics.push(
      buildDiagnostic({
        step: 'write-guard-missing',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [],
        error: 'Write guard is not installed on this page. Cannot proceed with item processing.',
      }),
    );
    return {
      item,
      pageState: {
        pageTitle: await page.title().catch(() => ''),
        currentPlatform: null,
        currentOwnershipType: null,
        currentStatus: null,
        saveButtonVisible: false,
      },
      filled: false,
      saveDetected: false,
      error: 'Write guard is not installed. Cannot proceed with item processing.',
      diagnostics: itemDiagnostics,
    };
  }

  // Track blocked Backloggd write requests from before the opener click
  // through the end of item processing (captures delayed writes).
  //
  // Each entry is tagged with a type prefix so that the post-processing
  // check can emit the correct diagnostic step name:
  //   RENDER_EDITOR: → render-editor-request-blocked-outside-window
  //   (no prefix)    → blocked-write-request
  const blockedWrites: string[] = [];
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
    await page.goto(item.backloggdUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Verify page matches expected game
    const verified = await verifyGamePage(page, item.steamTitle, item.backloggdSlug);
    if (!verified) {
      const diag = buildDiagnostic({
        step: 'verify-game-page',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: ['heading-role', 'page-title'],
        error: `Page does not appear to match expected game: ${item.steamTitle}`,
      });
      itemDiagnostics.push(diag);

      // Emit blocked-write diagnostics from navigation so they are
      // attributed to this item rather than silently lost.
      const writeDiag = emitBlockedWriteDiagnostics(
        blockedWrites,
        page,
        item,
        sessionId,
        itemDiagnostics,
      );

      return {
        item,
        pageState: await readPageState(page, { timeout }),
        filled: false,
        saveDetected: false,
        error: writeDiag
          ? `Page verification failed; blocked non-render write detected during navigation: ${writeDiag}`
          : 'Page verification failed',
        diagnostics: itemDiagnostics,
      };
    }

    // -----------------------------------------------------------------------
    // Probe phase — non-mutating visibility checks
    // -----------------------------------------------------------------------
    const PROBE_TIMEOUT = 100;

    const pageState = await readPageState(page, { timeout: PROBE_TIMEOUT });

    // Probe for both required controls WITHOUT mutating them.
    const platformPresent = await probeControl(page, platformSelectStrategies, PROBE_TIMEOUT);
    const ownershipPresent = await probeControl(page, ownershipTypeStrategies, PROBE_TIMEOUT);

    let platformOk = false;
    let ownershipOk = false;
    let editorWasRevealed = false;
    let logModalDialog: import('playwright').Locator | null = null;

    if (platformPresent && ownershipPresent) {
      // Both controls are directly visible — fill both.
      platformOk = await attemptFillPlatform(page, PROBE_TIMEOUT);
      ownershipOk = await attemptFillOwnership(page, PROBE_TIMEOUT);
    } else {
      // At least one required control is missing — do NOT mutate partial
      // controls. Try the "Log or review" modal first. The opener itself is
      // expected to be immediately visible; revealLogOrReviewModal keeps its
      // own longer async-render window after the opener is clicked.
      logModalDialog = await revealLogOrReviewModal(page, item, sessionId, itemDiagnostics, {
        timeout: 200,
      });

      if (logModalDialog) {
        // Do not fill "Played on" — the manifest's Steam source proves the
        // user owns the game on Steam but does not prove they played it on
        // any specific platform.  Leave the field unchanged.
        itemDiagnostics.push(
          buildDiagnostic({
            step: 'played-on-left-unchanged-no-approved-platform-proposal',
            url: page.url(),
            sessionId,
            steamAppId: item.steamAppId,
            backloggdSlug: item.backloggdSlug,
            attemptedSelectors: strategyNames(platformSelectStrategies),
            error: 'Played on left unchanged: no approved platform-played proposal in manifest.',
          }),
        );
        // Played on is intentionally not filled — mark platformOk as true
        // so that filled only depends on ownershipOk in the modal path.
        platformOk = true;

        // Handle ownership via Details tab only (skip Review tab).
        const ownershipResult = await handleLogOrReviewOwnership(
          page,
          logModalDialog,
          item,
          sessionId,
          itemDiagnostics,
          blockedWrites,
          500,
        );
        ownershipOk = ownershipResult.ownershipOk;
      } else {
        // "Log or review" not found — try standard editor reveal.
        editorWasRevealed = await revealEditor(page, item, sessionId, itemDiagnostics, {
          timeout: 300,
        });
        if (editorWasRevealed) {
          platformOk = await attemptFillPlatform(page, timeout);
          ownershipOk = await attemptFillOwnership(page, timeout);
        }
      }
    }

    // -----------------------------------------------------------------------
    // Settling window — allow any delayed writes that may have been scheduled
    // (e.g. setTimeout POST after opener click or tab switch) to fire and get
    // captured by the requestfailed listener before the blocked-write gate.
    // This is a best-effort settling period, not a safety boundary: the
    // onRequestFailed listener stays active through the entire processItem
    // lifetime (removed only in the finally block), so any write that fires
    // between now and the final return below is still tracked.
    // -----------------------------------------------------------------------
    if (editorWasRevealed || logModalDialog) {
      await page.waitForTimeout(500);
    }

    // -----------------------------------------------------------------------
    // Blocked-write gate (phase 1) — fail the item if any non-GET request was
    // blocked during opener click or fill processing.  This is the first check;
    // a second check runs before the final success return below to catch writes
    // that fire during the detection steps.
    // -----------------------------------------------------------------------
    {
      const writeError = emitBlockedWriteDiagnostics(
        blockedWrites,
        page,
        item,
        sessionId,
        itemDiagnostics,
      );
      if (writeError) {
        return {
          item,
          pageState,
          filled: false,
          saveDetected: false,
          error: writeError,
          diagnostics: itemDiagnostics,
        };
      }
    }

    // -----------------------------------------------------------------------
    // Save / submit / update / Create Log detection (NEVER click)
    // Scope to the dialog when the log modal is active.
    // -----------------------------------------------------------------------
    let saveDetected = false;
    if (logModalDialog) {
      const saveResult = await trySelectorsInLocator(logModalDialog, saveButtonStrategies, {
        visible: true,
        timeout: PROBE_TIMEOUT,
      });
      saveDetected = saveResult !== null;

      if (saveDetected) {
        if (saveResult?.strategyName?.includes('create-log')) {
          itemDiagnostics.push(
            buildDiagnostic({
              step: 'create-log-detected-skipped',
              url: page.url(),
              sessionId,
              steamAppId: item.steamAppId,
              backloggdSlug: item.backloggdSlug,
              attemptedSelectors: [saveResult.strategyName],
              error: 'Create Log final action detected and intentionally skipped',
            }),
          );
        } else {
          itemDiagnostics.push(
            buildDiagnostic({
              step: 'save-detected',
              url: page.url(),
              sessionId,
              steamAppId: item.steamAppId,
              backloggdSlug: item.backloggdSlug,
              attemptedSelectors: strategyNames(saveButtonStrategies),
              error: 'Final save/submit/update control detected and intentionally skipped',
            }),
          );
        }
      }
    } else {
      const saveResult = await trySelectors(page, saveButtonStrategies, {
        visible: true,
        timeout: PROBE_TIMEOUT,
      });
      saveDetected = saveResult !== null;

      if (saveDetected) {
        itemDiagnostics.push(
          buildDiagnostic({
            step: 'save-detected',
            url: page.url(),
            sessionId,
            steamAppId: item.steamAppId,
            backloggdSlug: item.backloggdSlug,
            attemptedSelectors: strategyNames(saveButtonStrategies),
            error: 'Final save/submit/update control detected and intentionally skipped',
          }),
        );
      }
    }

    // -----------------------------------------------------------------------
    // "Use Full Editor" detection (NEVER click) — scoped to dialog
    // -----------------------------------------------------------------------
    if (logModalDialog) {
      const fullEditorResult = await trySelectorsInLocator(logModalDialog, fullEditorStrategies, {
        visible: true,
        timeout: PROBE_TIMEOUT,
      });
      if (fullEditorResult) {
        itemDiagnostics.push(
          buildDiagnostic({
            step: 'full-editor-detected-skipped',
            url: page.url(),
            sessionId,
            steamAppId: item.steamAppId,
            backloggdSlug: item.backloggdSlug,
            attemptedSelectors: [fullEditorResult.strategyName],
            error: 'Use Full Editor link detected and intentionally skipped',
          }),
        );
      }

      // -----------------------------------------------------------------------
      // Status buttons detection (NEVER click) — scoped to dialog
      // -----------------------------------------------------------------------
      const statusResult = await trySelectorsInLocator(logModalDialog, statusButtonStrategies, {
        visible: true,
        timeout: PROBE_TIMEOUT,
      });
      if (statusResult) {
        itemDiagnostics.push(
          buildDiagnostic({
            step: 'status-controls-detected-skipped',
            url: page.url(),
            sessionId,
            steamAppId: item.steamAppId,
            backloggdSlug: item.backloggdSlug,
            attemptedSelectors: [statusResult.strategyName],
            error:
              'Status button (Completed/Playing/Backlog/Wishlist) detected and intentionally skipped',
          }),
        );
      }
    }

    // -----------------------------------------------------------------------
    // Fill-outcome report
    // -----------------------------------------------------------------------
    const filled = platformOk && ownershipOk;
    if (!filled) {
      const missing: string[] = [];
      if (!platformOk) missing.push('platform');
      if (!ownershipOk) missing.push('ownership');

      // If a more specific modal-path diagnostic already exists (e.g.
      // log-or-review-opener-not-found, expected-log-modal-not-found,
      // ownership-unsupported-in-current-ui), preserve its error message
      // instead of overwriting with the generic "Required fill failed" text.
      const specificSteps = new Set([
        'log-or-review-opener-not-found',
        'expected-log-modal-not-found',
        'details-tab-not-found',
        'details-tab-click-failed',
        'details-tab-not-active',
        'details-tab-blocked-write',
        'ownership-control-missing-details',
        'ownership-trigger-not-found',
        'ownership-owned-option-not-found',
        'ownership-owned-option-ambiguous',
        'ownership-owned-option-not-actionable',
        'ownership-owned-click-failed',
        'ownership-selection-unverified',
        'ownership-unsupported-in-current-ui',
      ]);
      // Find the last matching diagnostic (works with ES2022 target).
      const specificDiag = itemDiagnostics
        .slice()
        .reverse()
        .find((d) => specificSteps.has(d.step));
      const resultError = specificDiag
        ? specificDiag.errorMessage
        : `Required fill failed for: ${missing.join(', ')}`;

      const diag = buildDiagnostic({
        step: 'fill-ownership',
        url: page.url(),
        sessionId,
        steamAppId: item.steamAppId,
        backloggdSlug: item.backloggdSlug,
        attemptedSelectors: [
          ...strategyNames(platformSelectStrategies),
          ...strategyNames(ownershipTypeStrategies),
        ],
        error: `Required fill failed for: ${missing.join(', ')}`,
      });
      itemDiagnostics.push(diag);
      return {
        item,
        pageState,
        filled: false,
        saveDetected,
        error: resultError,
        diagnostics: itemDiagnostics,
      };
    }

    // -----------------------------------------------------------------------
    // Blocked-write gate (phase 2) — final check before the success return.
    // The onRequestFailed listener has been active since before page.goto()
    // and is still listening, so any blocked write that fired during the
    // detection steps above will be in blockedWrites now.  Without this
    // second check, a delayed write arriving between phase 1 and here could
    // allow the item to return success despite a blocked write.
    // -----------------------------------------------------------------------
    {
      const writeError = emitBlockedWriteDiagnostics(
        blockedWrites,
        page,
        item,
        sessionId,
        itemDiagnostics,
      );
      if (writeError) {
        return {
          item,
          pageState,
          filled: false,
          saveDetected,
          error: writeError,
          diagnostics: itemDiagnostics,
        };
      }
    }

    return {
      item,
      pageState,
      filled,
      saveDetected,
      diagnostics: itemDiagnostics,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const diag = buildDiagnostic({
      step: 'process-item',
      url: page.url(),
      sessionId,
      steamAppId: item.steamAppId,
      backloggdSlug: item.backloggdSlug,
      attemptedSelectors: [
        ...strategyNames(platformSelectStrategies),
        ...strategyNames(ownershipTypeStrategies),
        ...strategyNames(saveButtonStrategies),
      ],
      error: errorMessage,
    });
    itemDiagnostics.push(diag);

    return {
      item,
      pageState: await readPageState(page, { timeout }).catch(() => ({
        pageTitle: '',
        currentPlatform: null,
        currentOwnershipType: null,
        currentStatus: null,
        saveButtonVisible: false,
      })),
      filled: false,
      saveDetected: false,
      error: errorMessage,
      diagnostics: itemDiagnostics,
    };
  } finally {
    page.removeListener('requestfailed', onRequestFailed);
  }
}

/** Options for runPocSession (minimal DI surface). */
export interface PocSessionRunOptions {
  /** Override the login-prompt function (default: promptForLogin).
   *  Provided so that tests can inject a no-op without blocking on stdin. */
  promptFn?: () => Promise<void>;
}

/**
 * Run the full POC session.
 *
 * @param options.promptFn  Override for the login-prompt call (default:
 *   promptForLogin).  Only the CLI entry point uses the default; tests
 *   may inject a no-op to avoid blocking on stdin.
 */
export async function runPocSession(
  context: BrowserContext,
  items: SelectedItem[],
  sessionId: string,
  options?: PocSessionRunOptions,
): Promise<{ results: PocResult[]; diagnostics: DiagnosticEntry[] }> {
  const page = await context.newPage();
  const results: PocResult[] = [];
  const allDiagnostics: DiagnosticEntry[] = [];

  // Open Backloggd and prompt for login
  await page.goto('https://www.backloggd.com/', { waitUntil: 'domcontentloaded' });

  const loginState = await detectLoginState(page);
  if (loginState === false || loginState === null) {
    console.log('Waiting for manual sign-in to Backloggd...');
    const promptFn = options?.promptFn ?? promptForLogin;
    await promptFn();

    // Re-check login state after the user pressed Enter
    const loginOk = await checkLoginAfterPrompt(page, sessionId, allDiagnostics);
    if (!loginOk) {
      console.log(
        '  Login check failed — stopping item processing. No items were opened or filled.',
      );
      await page.close();
      return { results, diagnostics: allDiagnostics };
    }
  }

  // Install write guard before processing game pages (login is done by now)
  console.log('Installing write guard: non-GET requests to Backloggd will be blocked.');
  await installWriteGuard(page);

  for (const item of items) {
    console.log(`\nOpening: ${item.steamTitle} (${item.backloggdUrl})`);
    const result = await processItem(page, item, sessionId);
    results.push(result);

    // Collect per-item diagnostics
    for (const d of result.diagnostics) {
      allDiagnostics.push(d);
    }

    if (result.error) {
      console.log(`  Error: ${result.error}`);
    } else {
      console.log(`  Page title: ${result.pageState.pageTitle}`);
      console.log(`  Current platform: ${result.pageState.currentPlatform ?? 'not detected'}`);
      console.log(
        `  Current ownership: ${result.pageState.currentOwnershipType ?? 'not detected'}`,
      );
      console.log(`  Current status: ${result.pageState.currentStatus ?? 'not detected'}`);
      console.log(`  Ownership fields prepared: ${result.filled ? 'yes' : 'no'}`);
      console.log(`  Save button detected: ${result.saveDetected ? 'yes' : 'no'}`);
      console.log(`  Final save/submit/update: INTENTIONALLY SKIPPED (Milestone 4 safety rule)`);
    }
  }

  await page.close();
  return { results, diagnostics: allDiagnostics };
}
