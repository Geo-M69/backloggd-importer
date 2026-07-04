/**
 * Centralized selector strategies for Backloggd game pages.
 *
 * Priority order:
 * 1. Accessible role + name
 * 2. Label-based selectors
 * 3. Stable visible text fallback
 *
 * These selectors are based on assumptions about Backloggd's visible UI
 * and may need adjustment if the site structure changes.
 */

export interface SelectorStrategy {
  name: string;
  selector: string;
}

// ---------------------------------------------------------------------------
// Game page verification
// ---------------------------------------------------------------------------

export const gameTitleStrategies: SelectorStrategy[] = [
  { name: 'heading-role', selector: 'role=heading[level=1]' },
  { name: 'h1-tag', selector: 'h1' },
  { name: 'page-title', selector: '[data-testid="game-title"]' },
];

// ---------------------------------------------------------------------------
// Ownership / library controls
// ---------------------------------------------------------------------------

export const addToLibraryStrategies: SelectorStrategy[] = [
  { name: 'role-add', selector: 'role=button[name="Add to Library"]' },
  { name: 'button-role-add', selector: 'button:has-text("Add to Library")' },
  { name: 'button-role-add-alt', selector: 'button:has-text("Add Game")' },
];

export const platformSelectStrategies: SelectorStrategy[] = [
  {
    name: 'role-platform',
    selector: 'role=combobox[name="Platform"]',
  },
  {
    name: 'aria-platform',
    selector: '[aria-label="Platform"]',
  },
  {
    name: 'label-platform',
    selector: 'label:has-text("Platform") + select, label:has-text("Platform") ~ select',
  },
  { name: 'select-platform', selector: 'select[name="platform"]' },
];

export const ownershipTypeStrategies: SelectorStrategy[] = [
  // Accessible combobox — the real Backloggd UI uses a custom combobox with
  // role=combobox and aria-label="Ownership" on the trigger element.
  { name: 'role-ownership', selector: 'role=combobox[name="Ownership"]' },
  // Data-field attribute set by the real UI's custom dropdown.
  { name: 'data-field-ownership', selector: '[data-field="ownership"]' },
  // aria-label fallback.
  { name: 'aria-ownership', selector: '[aria-label="Ownership"]' },
  // Legacy: native select for backwards compatibility.
  { name: 'select-ownership', selector: 'select[name="ownership_type"]' },
];

/** Exact visible Ownership label strategies, scoped to the verified dialog. */
export const ownershipLabelStrategies: SelectorStrategy[] = [
  { name: 'ownership-label-element', selector: 'label:text-is("Ownership")' },
  { name: 'ownership-label-exact-text', selector: ':text-is("Ownership")' },
];

/** Accessible or exact-value Ownership triggers that are safe dialog-wide. */
export const ownershipTriggerAccessibleStrategies: SelectorStrategy[] = [
  { name: 'ownership-trigger-combobox-name', selector: 'role=combobox[name="Ownership"]' },
  {
    name: 'ownership-trigger-button-placeholder',
    selector: 'role=button[name="physical, digital, subscr..."]',
  },
  {
    name: 'ownership-trigger-exact-placeholder',
    selector: ':text-is("physical, digital, subscr...")',
  },
];

/** Exact trigger strategies used only in the Ownership label's nearby region. */
export const ownershipTriggerNearbyExactStrategies: SelectorStrategy[] = [
  {
    name: 'ownership-trigger-nearby-placeholder',
    selector: ':text-is("physical, digital, subscr...")',
  },
  { name: 'ownership-trigger-nearby-native', selector: 'select[name="ownership_type"]' },
  { name: 'ownership-trigger-nearby-data-field', selector: '[data-field="ownership"]' },
  { name: 'ownership-trigger-nearby-aria', selector: '[aria-label="Ownership"]' },
];

/**
 * Generic custom-dropdown shapes. These are safe only when exactly one is
 * visible in the smallest region surrounding the exact Ownership label.
 */
export const ownershipTriggerNearbyUniqueStrategies: SelectorStrategy[] = [
  { name: 'ownership-trigger-nearby-combobox', selector: '[role="combobox"]' },
  { name: 'ownership-trigger-nearby-choices-inner', selector: '.choices__inner' },
  { name: 'ownership-trigger-nearby-select2', selector: '.select2-selection' },
  { name: 'ownership-trigger-nearby-tom-select', selector: '.ts-control' },
  { name: 'ownership-trigger-nearby-selectize', selector: '.selectize-input' },
  { name: 'ownership-trigger-nearby-dropdown', selector: '.dropdown-trigger' },
  { name: 'ownership-trigger-nearby-toggle', selector: '.dropdown-toggle' },
];

/**
 * Strategies for finding the Ownership dropdown's visible value display
 * element — the trigger/button that shows the currently selected option.
 */
export const ownershipValueStrategies: SelectorStrategy[] = [
  {
    name: 'choices-single-ownership-value',
    selector: '.choices__list--single .choices__item',
  },
  { name: 'choices-single-ownership-list', selector: '.choices__list--single' },
  { name: 'trigger-ownership', selector: '[data-field="ownership"] .dropdown-trigger' },
  { name: 'nearby-dropdown-ownership-value', selector: '.dropdown-trigger' },
  {
    name: 'combobox-ownership',
    selector: 'role=combobox[name="Ownership"]',
  },
];

/**
 * Strategies for finding a specific option inside an Ownership dropdown.
 * Matches the option by its visible text.
 */
export const ownershipOptionStrategies: SelectorStrategy[] = [
  { name: 'role-option-owned', selector: 'role=option[name="Owned"]' },
  { name: 'role-menuitem-owned', selector: 'role=menuitem[name="Owned"]' },
  {
    name: 'choices-option-owned',
    selector: '.choices__list--dropdown .choices__item:text-is("Owned")',
  },
  { name: 'option-owned', selector: '[data-field="ownership"] [data-value="Owned"]' },
  { name: 'text-owned', selector: '[data-field="ownership"] .dropdown-option:text-is("Owned")' },
  { name: 'exact-text-owned', selector: ':text-is("Owned")' },
];

/** Visible popup/listbox shapes checked only after the Ownership trigger opens. */
export const ownershipOpenPopupStrategies: SelectorStrategy[] = [
  { name: 'ownership-popup-listbox', selector: 'role=listbox' },
  { name: 'ownership-popup-menu', selector: 'role=menu' },
  { name: 'ownership-popup-choices', selector: '.choices__list--dropdown' },
  { name: 'ownership-popup-dropdown-options', selector: '.dropdown-options' },
  { name: 'ownership-popup-dropdown-menu', selector: '.dropdown-menu' },
  { name: 'ownership-popup-select2', selector: '.select2-container--open .select2-results' },
  { name: 'ownership-popup-tom-select', selector: '.ts-dropdown' },
];

// ---------------------------------------------------------------------------
// Status controls
// ---------------------------------------------------------------------------

export const statusSelectStrategies: SelectorStrategy[] = [
  {
    name: 'role-status',
    selector: 'role=combobox[name="Status"]',
  },
  { name: 'aria-status', selector: '[aria-label="Game Status"]' },
  {
    name: 'label-status',
    selector: 'label:has-text("Status") + select, label:has-text("Status") ~ select',
  },
  { name: 'select-status', selector: 'select[name="status"]' },
];

// ---------------------------------------------------------------------------
// Save / submit controls (detected but NEVER clicked)
// ---------------------------------------------------------------------------

export const saveButtonStrategies: SelectorStrategy[] = [
  { name: 'role-save', selector: 'role=button[name="Save"]' },
  { name: 'role-submit', selector: 'role=button[name="Submit"]' },
  { name: 'role-update', selector: 'role=button[name="Update"]' },
  { name: 'role-create-log', selector: 'role=button[name="Create Log"]' },
  { name: 'button-role-save', selector: 'button:has-text("Save")' },
  { name: 'button-role-submit', selector: 'button:has-text("Submit")' },
  { name: 'button-role-update', selector: 'button:has-text("Update")' },
  { name: 'button-create-log', selector: 'button:text-is("Create Log")' },
  { name: 'input-submit', selector: 'input[type="submit"]' },
];

// ---------------------------------------------------------------------------
// Opener controls — safe to click to reveal the library/ownership editor.
// These are NOT final save/submit/update controls.
// ---------------------------------------------------------------------------

/**
 * Forbidden final-action terms.  Any opener candidate whose normalized visible
 * text or accessible name contains one of these terms (as a whole word) is
 * rejected and must not be clicked.
 */
export const FORBIDDEN_OPENER_TERMS = [
  'save',
  'submit',
  'update',
  'confirm',
  'create',
  'delete',
  'remove',
  'add game',
  'add to backloggd',
];

/**
 * Check whether normalized text contains a forbidden final-action term.
 */
export function textContainsForbiddenTerm(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return FORBIDDEN_OPENER_TERMS.some((term) => {
    // Use word-boundary matching so e.g. "save" in "Add to Library and Save"
    // is caught, but a false check on "saves" would not fire (though no
    // opener text is likely to end in "saves").
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(normalized);
  });
}

export const openerStrategies: SelectorStrategy[] = [
  // Accessible role + name (preferred) — these match the *exact* accessible
  // name computed by the browser, so "Add to Library and Save" would NOT
  // match role=button[name="Add to Library"].
  { name: 'role-add-to-library', selector: 'role=button[name="Add to Library"]' },
  { name: 'role-edit-library', selector: 'role=button[name="Edit Library"]' },
  { name: 'role-add-ownership', selector: 'role=button[name="Add Ownership"]' },
  { name: 'role-edit-ownership', selector: 'role=button[name="Edit Ownership"]' },
  { name: 'role-manage-library', selector: 'role=button[name="Manage Library"]' },
  { name: 'role-library', selector: 'role=button[name="Library"]' },
  { name: 'role-ownership', selector: 'role=button[name="Ownership"]' },
  // Text-based fallbacks — use :text-is() for EXACT text matching, NOT
  // :has-text() which does substring matching.  A button labelled "Add to
  // Library and Save" would NOT match :text-is("Add to Library").
  { name: 'button-add-to-library', selector: 'button:text-is("Add to Library")' },
  { name: 'button-edit-library', selector: 'button:text-is("Edit Library")' },
  { name: 'button-add-ownership', selector: 'button:text-is("Add Ownership")' },
  { name: 'button-edit-ownership', selector: 'button:text-is("Edit Ownership")' },
  { name: 'button-manage-library', selector: 'button:text-is("Manage Library")' },
];

// ---------------------------------------------------------------------------
// "Log or review" opener — Backloggd's primary action for unlogged games.
// Kept separate from openerStrategies because the resulting modal is
// structurally different (tabs, Create Log instead of Save).
// ---------------------------------------------------------------------------

export const logOrReviewOpenerStrategies: SelectorStrategy[] = [
  // Accessible role + name (preferred) — each is a separate entry because
  // Playwright cannot combine role= selectors via comma in a single locator.
  { name: 'role-link-log-or-review', selector: 'role=link[name="Log or review"]' },
  { name: 'role-button-log-or-review', selector: 'role=button[name="Log or review"]' },
  { name: 'role-link-log-or-review-alt', selector: 'role=link[name="Log or Review"]' },
  { name: 'role-button-log-or-review-alt', selector: 'role=button[name="Log or Review"]' },
  // Tag-independent exact visible-text fallback — works on any element
  // regardless of HTML tag (div, span, button, a, etc.).
  { name: 'text-log-or-review', selector: ':text-is("Log or review")' },
  { name: 'text-log-or-review-alt', selector: ':text-is("Log or Review")' },
];

// ---------------------------------------------------------------------------
// Editor / modal regions that appear after clicking an opener.
// ---------------------------------------------------------------------------

export const editorRegionStrategies: SelectorStrategy[] = [
  { name: 'role-dialog', selector: 'role=dialog' },
  { name: 'aria-dialog', selector: '[role="dialog"]' },
  { name: 'platform-select', selector: 'select[name="platform"]' },
  { name: 'ownership-select', selector: 'select[name="ownership_type"]' },
  { name: 'form-tag', selector: 'form' },
];

// ---------------------------------------------------------------------------
// "Log or review" modal — expected cues after opening
// ---------------------------------------------------------------------------

/**
 * Strategies that confirm the expected Backloggd "Log or review" modal is
 * visible.  At least one of these cues should be present before we consider
 * the modal ready for interaction.
 */
export const logModalExpectedCuesStrategies: SelectorStrategy[] = [
  // Specific cues that distinguish the "Log or review" modal from a generic
  // dialog.  We do NOT start with a bare role=dialog — that would match any
  // dialog, including the wrong one.  Instead we require at least one of:
  //   - Create Log button (final action)
  //   - Platform label (specific to game-log form)
  //   - Review / Details / Journal tab (modal navigation)
  //
  // Each role= variant is a separate entry because Playwright cannot combine
  // role= selectors with CSS text selectors via comma in a single locator.
  { name: 'create-log-button', selector: 'role=button[name="Create Log"]' },
  { name: 'create-log-text', selector: 'button:text-is("Create Log")' },
  { name: 'platform-label-text', selector: 'label:text-is("Platform")' },
  { name: 'platform-label-aria', selector: '[aria-label="Platform"]' },
  { name: 'review-tab-role', selector: 'role=tab[name="Review"]' },
  { name: 'review-tab-button', selector: 'button:text-is("Review")' },
  { name: 'review-tab-link', selector: 'a:text-is("Review")' },
  { name: 'details-tab-role', selector: 'role=tab[name="Details"]' },
  { name: 'details-tab-button', selector: 'button:text-is("Details")' },
  { name: 'details-tab-link', selector: 'a:text-is("Details")' },
  { name: 'journal-tab-role', selector: 'role=tab[name="Journal"]' },
  { name: 'journal-tab-button', selector: 'button:text-is("Journal")' },
  { name: 'journal-tab-link', selector: 'a:text-is("Journal")' },
];

// ---------------------------------------------------------------------------
// Modal tab selectors — for navigating Review / Details tabs
// ---------------------------------------------------------------------------

export const modalTabStrategies: SelectorStrategy[] = [
  // Prefer the exact accessible button/tab name used by the live UI.
  { name: 'details-tab-button-role', selector: 'role=button[name="Details"]' },
  { name: 'details-tab-role', selector: 'role=tab[name="Details"]' },
  // Exact, tag-scoped fallbacks for conventional markup.
  { name: 'details-tab-button', selector: 'button:text-is("Details")' },
  { name: 'details-tab-link', selector: 'a:text-is("Details")' },
  // The live control is not guaranteed to be a semantic button, so retain a
  // tag-independent exact-text fallback scoped to the verified dialog.
  { name: 'details-tab-exact-text', selector: ':text-is("Details")' },
];

// Visible cues that exist only in the Details panel.  At least one must become
// visible after clicking Details before Ownership may be searched or changed.
export const detailsPanelCueStrategies: SelectorStrategy[] = [
  { name: 'details-cue-ownership-combobox', selector: 'role=combobox[name="Ownership"]' },
  { name: 'details-cue-log-title-textbox', selector: 'role=textbox[name="Log Title"]' },
  { name: 'details-cue-ownership-label', selector: 'label:text-is("Ownership")' },
  { name: 'details-cue-played-on-label', selector: 'label:text-is("Played on")' },
  { name: 'details-cue-time-played-label', selector: 'label:text-is("Time Played")' },
  { name: 'details-cue-log-title-label', selector: 'label:text-is("Log Title")' },
  { name: 'details-cue-ownership-text', selector: ':text-is("Ownership")' },
  { name: 'details-cue-played-on-text', selector: ':text-is("Played on")' },
  { name: 'details-cue-time-played-text', selector: ':text-is("Time Played")' },
  { name: 'details-cue-log-title-text', selector: ':text-is("Log Title")' },
];

// ---------------------------------------------------------------------------
// "Create Log" final-action detection
// ---------------------------------------------------------------------------

export const createLogButtonStrategies: SelectorStrategy[] = [
  { name: 'role-create-log', selector: 'role=button[name="Create Log"]' },
  { name: 'button-create-log', selector: 'button:text-is("Create Log")' },
];

// ---------------------------------------------------------------------------
// "Use Full Editor" detection (never click)
// ---------------------------------------------------------------------------

export const fullEditorStrategies: SelectorStrategy[] = [
  { name: 'role-full-editor-link', selector: 'role=link[name="Use Full Editor"]' },
  { name: 'role-full-editor-button', selector: 'role=button[name="Use Full Editor"]' },
  { name: 'button-full-editor-link', selector: 'a:text-is("Use Full Editor")' },
  { name: 'button-full-editor-button', selector: 'button:text-is("Use Full Editor")' },
];

// ---------------------------------------------------------------------------
// Status button detection (never click)
// ---------------------------------------------------------------------------

export const statusButtonStrategies: SelectorStrategy[] = [
  { name: 'role-completed', selector: 'role=button[name="Completed"]' },
  { name: 'role-playing', selector: 'role=button[name="Playing"]' },
  { name: 'role-backlog', selector: 'role=button[name="Backlog"]' },
  { name: 'role-wishlist', selector: 'role=button[name="Wishlist"]' },
  { name: 'button-completed', selector: 'button:text-is("Completed")' },
  { name: 'button-playing', selector: 'button:text-is("Playing")' },
  { name: 'button-backlog', selector: 'button:text-is("Backlog")' },
  { name: 'button-wishlist', selector: 'button:text-is("Wishlist")' },
];

// ---------------------------------------------------------------------------
// Controls that are explicitly NOT safe to click — for detection and
// skip-safety only (never matched as openers).
// ---------------------------------------------------------------------------

export const forbiddenControlStrategies: SelectorStrategy[] = [
  { name: 'role-save', selector: 'role=button[name="Save"]' },
  { name: 'role-submit', selector: 'role=button[name="Submit"]' },
  { name: 'role-update', selector: 'role=button[name="Update"]' },
  { name: 'role-confirm', selector: 'role=button[name="Confirm"]' },
  { name: 'role-create', selector: 'role=button[name="Create"]' },
  { name: 'role-create-log', selector: 'role=button[name="Create Log"]' },
  { name: 'role-add-game', selector: 'role=button[name="Add Game"]' },
  { name: 'role-add-backloggd', selector: 'role=button[name="Add to Backloggd"]' },
  { name: 'role-delete', selector: 'role=button[name="Delete"]' },
  { name: 'role-remove', selector: 'role=button[name="Remove"]' },
  { name: 'role-add', selector: 'role=button[name="Add"]' },
  // "Use Full Editor" — detected but never clicked.
  {
    name: 'role-full-editor',
    selector: 'role=link[name="Use Full Editor"], role=button[name="Use Full Editor"]',
  },
  {
    name: 'button-full-editor',
    selector: 'a:text-is("Use Full Editor"), button:text-is("Use Full Editor")',
  },
  // Status buttons — never click.
  { name: 'role-completed', selector: 'role=button[name="Completed"]' },
  { name: 'role-playing', selector: 'role=button[name="Playing"]' },
  { name: 'role-backlog', selector: 'role=button[name="Backlog"]' },
  { name: 'role-wishlist', selector: 'role=button[name="Wishlist"]' },
  { name: 'button-completed', selector: 'button:text-is("Completed")' },
  { name: 'button-playing', selector: 'button:text-is("Playing")' },
  { name: 'button-backlog', selector: 'button:text-is("Backlog")' },
  { name: 'button-wishlist', selector: 'button:text-is("Wishlist")' },
];

// ---------------------------------------------------------------------------
// Login detection cues
// ---------------------------------------------------------------------------

export const loginCueStrategies: SelectorStrategy[] = [
  {
    name: 'role-sign-in',
    selector: 'role=link[name="Sign In"], role=button[name="Sign In"]',
  },
  {
    name: 'sign-in-link',
    selector: 'a:has-text("Sign In"), a:has-text("Log In"), button:has-text("Sign In")',
  },
];

export const loggedInCueStrategies: SelectorStrategy[] = [
  {
    name: 'role-library',
    selector: 'role=link[name="My Library"], role=link[name="Library"]',
  },
  { name: 'user-avatar', selector: '[data-testid="user-avatar"], img[alt*="avatar"]' },
  { name: 'my-library-link', selector: 'a:has-text("My Library"), a:has-text("Library")' },
  // Accessible role + exact name for "+ Log a Game" / "Log a Game".
  // These are visible on the top navigation bar when signed in.
  // The "+" prefix is used by Backloggd's nav; both variants are accepted.
  {
    name: 'role-log-a-game-plus',
    selector: 'role=link[name="+ Log a Game"], role=button[name="+ Log a Game"]',
  },
  {
    name: 'role-log-a-game',
    selector: 'role=link[name="Log a Game"], role=button[name="Log a Game"]',
  },
  // Text-based exact-match fallbacks using :text-is() — no substring matching.
  {
    name: 'button-log-a-game-plus',
    selector: 'a:text-is("+ Log a Game"), button:text-is("+ Log a Game")',
  },
  { name: 'button-log-a-game', selector: 'a:text-is("Log a Game"), button:text-is("Log a Game")' },
];

// ---------------------------------------------------------------------------
// Helper: try selectors in order and return the first matching element
// ---------------------------------------------------------------------------

import type { Page, Locator } from 'playwright';

export async function trySelectors(
  page: Page,
  strategies: SelectorStrategy[],
  options: { timeout?: number; visible?: boolean } = {},
): Promise<{ locator: Locator; strategyName: string } | null> {
  const timeout = options.timeout ?? 3000;
  for (const strategy of strategies) {
    const locator = page.locator(strategy.selector);
    try {
      await locator.first().waitFor({ state: options.visible ? 'visible' : 'attached', timeout });
      const count = await locator.count();
      if (count > 0) {
        return { locator: locator.first(), strategyName: strategy.name };
      }
    } catch {
      // Strategy failed, try next
    }
  }
  return null;
}

/**
 * Get the list of strategy names for diagnostics.
 */
export function strategyNames(strategies: SelectorStrategy[]): string[] {
  return strategies.map((s) => s.name);
}

/**
 * Try selectors in order within a given locator scope and return the first
 * matching element.  This is the locator-scoped equivalent of trySelectors.
 */
export async function trySelectorsInLocator(
  scope: import('playwright').Locator,
  strategies: SelectorStrategy[],
  options: { timeout?: number; visible?: boolean } = {},
): Promise<{ locator: import('playwright').Locator; strategyName: string } | null> {
  const timeout = options.timeout ?? 3000;
  for (const strategy of strategies) {
    const locator = scope.locator(strategy.selector);
    try {
      await locator.first().waitFor({ state: options.visible ? 'visible' : 'attached', timeout });
      const count = await locator.count();
      if (count > 0) {
        return { locator: locator.first(), strategyName: strategy.name };
      }
    } catch {
      // Strategy failed, try next
    }
  }
  return null;
}
