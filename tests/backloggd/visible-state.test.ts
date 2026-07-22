import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { resolve } from 'node:path';
import {
  readVisibleBackloggdState,
  type VisibleBackloggdState,
} from '../../src/backloggd/visible-state.js';
import { compareOwnership } from '../../src/backloggd/comparison.js';
import { installWriteGuard } from '../../src/backloggd/browser.js';

const FIXTURES_DIR = resolve('fixtures');

function openFixtureUrl(fileName: string): string {
  return `file://${FIXTURES_DIR}/${fileName}`;
}

async function openFixture(context: BrowserContext, fileName: string) {
  const page = await context.newPage();
  await page.goto(openFixtureUrl(fileName), { waitUntil: 'domcontentloaded' });
  await installWriteGuard(page);
  return page;
}

const STEAM_DIGITAL = { platform: 'Steam', ownershipType: 'Digital' };
const STEAM_PLAYED = { platform: 'Steam', ownershipType: 'Played' };

describe('readVisibleBackloggdState — fixture coverage', () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
  });

  afterAll(async () => {
    await context.close();
    await browser.close();
  });

  async function readFixture(
    fileName: string,
    title: string,
    slug: string,
  ): Promise<VisibleBackloggdState> {
    const page = await openFixture(context, fileName);
    const state = await readVisibleBackloggdState(page, title, slug, { timeout: 2000 });
    await page.close();
    return state;
  }

  // -----------------------------------------------------------------------
  // Core ownership scenarios
  // -----------------------------------------------------------------------

  it('reads exact Steam/Digital ownership already present', async () => {
    const state = await readFixture(
      'backloggd-ownership-steam-digital-present.html',
      'Team Fortress 2',
      'backloggd-ownership-steam-digital-present',
    );
    expect(state.game.verified).toBe(true);
    expect(state.library.membership).toBe('present');
    expect(state.library.completeness).toBe('complete');
    expect(state.library.ownershipEntries).toEqual([
      { platform: 'Steam', ownershipType: 'Digital' },
    ]);
    expect(state.library.addControl).toBe('unique');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('already-present');
  });

  it('reads other platforms present but Steam absent', async () => {
    const state = await readFixture(
      'backloggd-ownership-other-platforms.html',
      'BioShock',
      'backloggd-ownership-other-platforms',
    );
    expect(state.library.ownershipEntries).toHaveLength(2);
    expect(state.library.completeness).toBe('complete');
    expect(state.library.addControl).toBe('unique');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('change-needed');
  });

  it('reads Steam present with conflicting ownership type', async () => {
    const state = await readFixture(
      'backloggd-ownership-steam-conflict.html',
      'Doom',
      'backloggd-ownership-steam-conflict',
    );
    expect(state.library.ownershipEntries).toEqual([
      { platform: 'Steam', ownershipType: 'Physical' },
    ]);
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('conflict');
  });

  it('reads generic library membership with missing details', async () => {
    const state = await readFixture(
      'backloggd-ownership-generic.html',
      'Portal 2',
      'backloggd-ownership-generic',
    );
    expect(state.library.membership).toBe('present');
    expect(state.library.completeness).toBe('unsupported');
    expect(state.library.ownershipEntries).toEqual([]);
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('unknown');
  });

  it('reads explicitly empty library with one unique additive control', async () => {
    const state = await readFixture(
      'backloggd-ownership-empty.html',
      'Half-Life 2',
      'backloggd-ownership-empty',
    );
    expect(state.library.membership).toBe('absent');
    expect(state.library.completeness).toBe('complete');
    expect(state.library.ownershipEntries).toEqual([]);
    expect(state.library.addControl).toBe('unique');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('change-needed');
  });

  it('reads partial ownership row', async () => {
    const state = await readFixture(
      'backloggd-ownership-partial-row.html',
      'Stardew Valley',
      'backloggd-ownership-partial-row',
    );
    expect(state.library.completeness).toBe('partial');
    expect(state.library.ownershipEntries).toEqual([{ platform: 'Steam', ownershipType: null }]);
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('unknown');
  });

  it('reads duplicate exact ownership rows', async () => {
    const state = await readFixture(
      'backloggd-ownership-duplicate.html',
      'Celeste',
      'backloggd-ownership-duplicate',
    );
    expect(state.library.ownershipEntries).toHaveLength(2);
    expect(state.library.completeness).toBe('ambiguous');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('conflict');
  });

  it('reads contradictory ownership rows', async () => {
    const state = await readFixture(
      'backloggd-ownership-contradictory.html',
      'Hades',
      'backloggd-ownership-contradictory',
    );
    expect(state.library.ownershipEntries).toHaveLength(2);
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('conflict');
  });

  it('ignores hidden decoys', async () => {
    const state = await readFixture(
      'backloggd-ownership-hidden-decoys.html',
      'Hollow Knight',
      'backloggd-ownership-hidden-decoys',
    );
    // Only the visible Steam/Digital row must be captured; the hidden
    // decoy Steam/Physical and Steam Deck/Owned must not appear.
    expect(state.library.ownershipEntries).toEqual([
      { platform: 'Steam', ownershipType: 'Digital' },
    ]);
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('already-present');
  });

  it('treats duplicate visible ownership regions as ambiguous', async () => {
    const state = await readFixture(
      'backloggd-ownership-duplicate-regions.html',
      'Disco Elysium',
      'backloggd-ownership-duplicate-regions',
    );
    expect(state.diagnostics.regionCount).toBe(2);
    expect(state.library.completeness).toBe('ambiguous');
    expect(state.library.addControl).toBe('ambiguous');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('unknown');
  });

  it('treats missing ownership region as unsupported', async () => {
    const state = await readFixture(
      'backloggd-ownership-missing-region.html',
      'NieR Automata',
      'backloggd-ownership-missing-region',
    );
    expect(state.game.verified).toBe(true);
    expect(state.library.membership).toBe('unknown');
    expect(state.library.completeness).toBe('unsupported');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('unknown');
  });

  // -----------------------------------------------------------------------
  // Non-game pages
  // -----------------------------------------------------------------------

  it('detects login page as unsupported', async () => {
    const state = await readFixture('backloggd-login-page.html', 'Sign In', 'backloggd-login-page');
    expect(state.diagnostics.pageType).toBe('login');
    expect(state.game.verified).toBe(false);
    expect(state.library.completeness).toBe('unsupported');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('unknown');
  });

  it('detects challenge/CAPTCHA page as unsupported', async () => {
    const state = await readFixture(
      'backloggd-challenge-page.html',
      'Checking your browser',
      'backloggd-challenge-page',
    );
    expect(state.diagnostics.pageType).toBe('challenge');
    expect(state.library.completeness).toBe('unsupported');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('unknown');
  });

  it('detects rate-limit page as unsupported', async () => {
    const state = await readFixture(
      'backloggd-rate-limit-page.html',
      'Slow down',
      'backloggd-rate-limit-page',
    );
    expect(state.diagnostics.pageType).toBe('rate-limit');
    expect(state.library.completeness).toBe('unsupported');
    const result = compareOwnership(STEAM_DIGITAL, state.library);
    expect(result.classification).toBe('unknown');
  });

  // -----------------------------------------------------------------------
  // Finding 1 — hidden text must not become ownership evidence
  // -----------------------------------------------------------------------

  describe('hidden text is not ownership evidence', () => {
    it('visible Steam plus hidden " Deck" still reads as Steam', async () => {
      const state = await readFixture(
        'backloggd-ownership-hidden-descendant.html',
        'Team Fortress 2',
        'backloggd-ownership-hidden-descendant',
      );
      expect(state.library.ownershipEntries).toEqual([
        { platform: 'Steam', ownershipType: 'Digital' },
      ]);
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('already-present');
    });

    it('native select with multiple options reads only the selected option', async () => {
      const state = await readFixture(
        'backloggd-ownership-native-select.html',
        'Team Fortress 2',
        'backloggd-ownership-native-select',
      );
      expect(state.library.ownershipEntries).toEqual([
        { platform: 'Steam', ownershipType: 'Digital' },
      ]);
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('already-present');
    });

    it('unsupported field element type produces unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-unsupported-field.html',
        'Team Fortress 2',
        'backloggd-ownership-unsupported-field',
      );
      expect(state.library.ownershipEntries).toEqual([
        { platform: null, ownershipType: 'Digital' },
      ]);
      expect(state.library.completeness).toBe('partial');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });
  });

  // -----------------------------------------------------------------------
  // Finding 2 — missing/unrecognized entry structure must not become empty
  // -----------------------------------------------------------------------

  describe('unrecognized entry structure is not an empty library', () => {
    it('visible Steam/Digital content without row markers returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-unrecognized-content.html',
        'Portal 2',
        'backloggd-ownership-unrecognized-content',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.ownershipEntries).toEqual([]);
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('recognized explicit empty state plus unique additive control still supports change-needed', async () => {
      const state = await readFixture(
        'backloggd-ownership-empty.html',
        'Half-Life 2',
        'backloggd-ownership-empty',
      );
      expect(state.library.completeness).toBe('complete');
      expect(state.library.membership).toBe('absent');
      expect(state.library.addControl).toBe('unique');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('change-needed');
    });

    it('missing ownership region returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-missing-region.html',
        'NieR Automata',
        'backloggd-ownership-missing-region',
      );
      expect(state.library.completeness).toBe('unsupported');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('visible unrecognized ownership content plus Add button never returns change-needed', async () => {
      const state = await readFixture(
        'backloggd-ownership-unrecognized-content.html',
        'Portal 2',
        'backloggd-ownership-unrecognized-content',
      );
      expect(state.library.addControl).toBe('unique');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).not.toBe('change-needed');
    });

    it('recognized list with visible unmarked <li> plus Add Ownership is unknown, not change-needed', async () => {
      // Regression: a recognized list ([data-testid="ownership-entries"])
      // that contains a visible <li> with no recognized row markers must
      // NOT be declared empty.  With a unique Add Ownership control the
      // comparator must still return `unknown`, never `change-needed`.
      const state = await readFixture(
        'backloggd-ownership-visible-unrecognized-child.html',
        'Portal 2',
        'backloggd-ownership-visible-unrecognized-child',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.ownershipEntries).toEqual([]);
      expect(state.library.addControl).toBe('unique');
      expect(state.diagnostics.notes).toContain('unrecognized-visible-list-content');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
      expect(result.classification).not.toBe('change-needed');
    });

    it('recognized list with visible unmarked <li> and no Add control is unknown/unsupported', async () => {
      // Regression: a recognized list with visible unrecognized child
      // content must not be treated as empty, even when no Add Ownership
      // control is present.  The comparator must return `unknown`.
      const state = await readFixture(
        'backloggd-ownership-visible-unrecognized-child-no-add.html',
        'Portal 2',
        'backloggd-ownership-visible-unrecognized-child-no-add',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.ownershipEntries).toEqual([]);
      expect(state.library.addControl).toBe('absent');
      expect(state.diagnostics.notes).toContain('unrecognized-visible-list-content');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('recognized truly empty list plus valid Add Ownership still supports change-needed', async () => {
      // Regression: the existing empty-list path must still allow a
      // change-needed classification when a unique Add Ownership control
      // is present.  This is the only valid "empty library" representation.
      const state = await readFixture(
        'backloggd-ownership-empty.html',
        'Half-Life 2',
        'backloggd-ownership-empty',
      );
      expect(state.library.completeness).toBe('complete');
      expect(state.library.membership).toBe('absent');
      expect(state.library.ownershipEntries).toEqual([]);
      expect(state.library.addControl).toBe('unique');
      expect(state.diagnostics.notes).not.toContain('unrecognized-visible-list-content');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('change-needed');
    });

    it('hidden unrecognized children inside an otherwise empty list do not count as visible content', async () => {
      // Regression: hidden <li> (display:none) inside a recognized list
      // must not count as visible child content.  innerText excludes
      // hidden descendants, so the list is still proven empty and a
      // change-needed classification is allowed.
      const state = await readFixture(
        'backloggd-ownership-hidden-unrecognized-child.html',
        'Half-Life 2',
        'backloggd-ownership-hidden-unrecognized-child',
      );
      expect(state.library.completeness).toBe('complete');
      expect(state.library.membership).toBe('absent');
      expect(state.library.ownershipEntries).toEqual([]);
      expect(state.library.addControl).toBe('unique');
      expect(state.diagnostics.notes).not.toContain('unrecognized-visible-list-content');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('change-needed');
    });
  });

  // -----------------------------------------------------------------------
  // Finding 3 — nested ownership structures must require uniqueness
  // -----------------------------------------------------------------------

  describe('nested ownership structures require uniqueness', () => {
    it('one region with two visible ownership lists returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-two-lists.html',
        'Disco Elysium',
        'backloggd-ownership-two-lists',
      );
      expect(state.library.completeness).toBe('ambiguous');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('one row with multiple visible platform fields returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-row-multiple-platforms.html',
        'Celeste',
        'backloggd-ownership-row-multiple-platforms',
      );
      expect(state.library.completeness).toBe('ambiguous');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('one row with multiple visible ownership fields returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-row-multiple-ownerships.html',
        'Hades',
        'backloggd-ownership-row-multiple-ownerships',
      );
      expect(state.library.completeness).toBe('ambiguous');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('hidden duplicate fields do not count as visible duplicates', async () => {
      const state = await readFixture(
        'backloggd-ownership-hidden-duplicate-fields.html',
        'Hollow Knight',
        'backloggd-ownership-hidden-duplicate-fields',
      );
      expect(state.library.ownershipEntries).toEqual([
        { platform: 'Steam', ownershipType: 'Digital' },
      ]);
      expect(state.library.completeness).toBe('complete');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('already-present');
    });
  });

  // -----------------------------------------------------------------------
  // Finding 4 — delayed login/challenge/rate-limit UI must be rechecked
  // -----------------------------------------------------------------------

  describe('delayed blocker UI is rechecked', () => {
    it('challenge overlay appearing after initial check returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-delayed-challenge.html',
        'Team Fortress 2',
        'backloggd-ownership-delayed-challenge',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.diagnostics.notes).toContain('blocker-appeared-after-read');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('login cue appearing after initial check returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-delayed-login.html',
        'Team Fortress 2',
        'backloggd-ownership-delayed-login',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.diagnostics.notes).toContain('blocker-appeared-after-read');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('rate-limit cue appearing after initial check returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-delayed-rate-limit.html',
        'Team Fortress 2',
        'backloggd-ownership-delayed-rate-limit',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.diagnostics.notes).toContain('blocker-appeared-after-read');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('normal fixture without blockers still reads correctly', async () => {
      const state = await readFixture(
        'backloggd-ownership-steam-digital-present.html',
        'Team Fortress 2',
        'backloggd-ownership-steam-digital-present',
      );
      expect(state.library.completeness).toBe('complete');
      expect(state.library.ownershipEntries).toEqual([
        { platform: 'Steam', ownershipType: 'Digital' },
      ]);
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('already-present');
    });
  });

  // -----------------------------------------------------------------------
  // Finding 5 — unique additive control must be actionable without clicking
  // -----------------------------------------------------------------------

  describe('additive control must be actionable', () => {
    it('disabled Add Ownership button returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-disabled-add.html',
        'BioShock',
        'backloggd-ownership-disabled-add',
      );
      expect(state.library.addControl).toBe('absent');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('span with add-ownership test id returns unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-span-add.html',
        'BioShock',
        'backloggd-ownership-span-add',
      );
      expect(state.library.addControl).toBe('absent');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('visible enabled button with correct accessible name is accepted', async () => {
      const state = await readFixture(
        'backloggd-ownership-other-platforms.html',
        'BioShock',
        'backloggd-ownership-other-platforms',
      );
      expect(state.library.addControl).toBe('unique');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('change-needed');
    });

    it('visible enabled link with correct accessible name is accepted', async () => {
      const state = await readFixture(
        'backloggd-ownership-link-add.html',
        'BioShock',
        'backloggd-ownership-link-add',
      );
      expect(state.library.addControl).toBe('unique');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('change-needed');
    });

    it('duplicate enabled additive controls return unknown', async () => {
      const state = await readFixture(
        'backloggd-ownership-duplicate-add.html',
        'BioShock',
        'backloggd-ownership-duplicate-add',
      );
      expect(state.library.addControl).toBe('ambiguous');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('<a> without href is not counted as an Add control', async () => {
      // Regression: an <a> element without an href has no implicit "link"
      // role, so Playwright's getByRole('link') must not match it.  The
      // element exists in the DOM and has the testid + class hooks, but
      // the reader must NOT count it as a unique additive control.
      const state = await readFixture(
        'backloggd-ownership-anchor-no-href.html',
        'BioShock',
        'backloggd-ownership-anchor-no-href',
      );
      expect(state.library.addControl).toBe('absent');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('valid <a href="#"> with supported accessible name is accepted', async () => {
      // Regression: an <a href="#"> has the implicit "link" role and a
      // valid supported accessible name.  The reader must accept it.
      const state = await readFixture(
        'backloggd-ownership-link-add.html',
        'BioShock',
        'backloggd-ownership-link-add',
      );
      expect(state.library.addControl).toBe('unique');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('change-needed');
    });

    it('button with hidden descendant text is accepted when computed accessible name matches', async () => {
      // Regression: hidden descendant text must NOT contribute to the
      // accepted accessible name.  The button has a hidden <span>Delete</span>
      // plus visible "Add Ownership" — the computed accessible name is
      // "Add Ownership" (hidden excluded per the Accessible Name and
      // Description Computation spec), so the button is accepted.
      const state = await readFixture(
        'backloggd-ownership-button-hidden-descendant.html',
        'BioShock',
        'backloggd-ownership-button-hidden-descendant',
      );
      expect(state.library.addControl).toBe('unique');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('change-needed');
    });

    it('button inside <fieldset disabled> is not counted as an Add control', async () => {
      // Regression: a button with no `disabled` attribute but inside a
      // <fieldset disabled> is disabled by the HTML ancestor-walk rule.
      // Playwright's `disabled: false` filter must exclude it.
      const state = await readFixture(
        'backloggd-ownership-button-fieldset-disabled.html',
        'BioShock',
        'backloggd-ownership-button-fieldset-disabled',
      );
      expect(state.library.addControl).toBe('absent');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });

    it('visible enabled button with exact accessible name is still accepted', async () => {
      // Regression: the happy-path visible enabled button with the exact
      // supported accessible name must still be counted as a unique
      // additive control after the role-locator refactor.
      const state = await readFixture(
        'backloggd-ownership-other-platforms.html',
        'BioShock',
        'backloggd-ownership-other-platforms',
      );
      expect(state.library.addControl).toBe('unique');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('change-needed');
    });

    it('duplicate valid Add Ownership controls still produce ambiguous', async () => {
      // Regression: two visible enabled buttons with the exact supported
      // accessible name must still produce `ambiguous`, never `unique`.
      const state = await readFixture(
        'backloggd-ownership-duplicate-add.html',
        'BioShock',
        'backloggd-ownership-duplicate-add',
      );
      expect(state.library.addControl).toBe('ambiguous');
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
    });
  });

  // -----------------------------------------------------------------------
  // Read-only proof: the reader must never click any control.
  // -----------------------------------------------------------------------

  describe('read-only proof', () => {
    it('does not click ownership options', async () => {
      const page = await openFixture(context, 'backloggd-ownership-click-tracker.html');
      await readVisibleBackloggdState(
        page,
        'Team Fortress 2',
        'backloggd-ownership-click-tracker',
        {
          timeout: 2000,
        },
      );
      const counters = await page.evaluate(() => {
        const w = window as unknown as {
          __ownershipTriggerClickCount?: number;
          __ownershipOptionClickCount?: number;
        };
        return {
          trigger: w.__ownershipTriggerClickCount ?? -1,
          option: w.__ownershipOptionClickCount ?? -1,
        };
      });
      expect(counters.trigger).toBe(0);
      expect(counters.option).toBe(0);
      await page.close();
    });

    it('does not click platform options', async () => {
      const page = await openFixture(context, 'backloggd-ownership-click-tracker.html');
      await readVisibleBackloggdState(
        page,
        'Team Fortress 2',
        'backloggd-ownership-click-tracker',
        {
          timeout: 2000,
        },
      );
      const changes = await page.evaluate(() => {
        const w = window as unknown as { __platformChangeCount?: number };
        return w.__platformChangeCount ?? -1;
      });
      expect(changes).toBe(0);
      await page.close();
    });

    it('does not click status buttons', async () => {
      const page = await openFixture(context, 'backloggd-ownership-click-tracker.html');
      await readVisibleBackloggdState(
        page,
        'Team Fortress 2',
        'backloggd-ownership-click-tracker',
        {
          timeout: 2000,
        },
      );
      const status = await page.evaluate(() => {
        const w = window as unknown as { __statusClickCount?: number };
        return w.__statusClickCount ?? -1;
      });
      expect(status).toBe(0);
      await page.close();
    });

    it('does not click final actions (Save/Submit/Create Log/Update/Confirm/Delete/Remove/Add/Full Editor)', async () => {
      const page = await openFixture(context, 'backloggd-ownership-click-tracker.html');
      await readVisibleBackloggdState(
        page,
        'Team Fortress 2',
        'backloggd-ownership-click-tracker',
        {
          timeout: 2000,
        },
      );
      const counts = await page.evaluate(() => {
        const w = window as unknown as Record<string, number | undefined>;
        return {
          save: w.__saveClickCount ?? -1,
          submit: w.__submitClickCount ?? -1,
          createLog: w.__createLogClickCount ?? -1,
          update: w.__updateClickCount ?? -1,
          confirm: w.__confirmClickCount ?? -1,
          delete: w.__deleteClickCount ?? -1,
          remove: w.__removeClickCount ?? -1,
          add: w.__addClickCount ?? -1,
          fullEditor: w.__fullEditorClickCount ?? -1,
          addOwnership: w.__addOwnershipClickCount ?? -1,
          star: w.__starClickCount ?? -1,
          reviewInput: w.__reviewInputCount ?? -1,
        };
      });
      expect(counts.save).toBe(0);
      expect(counts.submit).toBe(0);
      expect(counts.createLog).toBe(0);
      expect(counts.update).toBe(0);
      expect(counts.confirm).toBe(0);
      expect(counts.delete).toBe(0);
      expect(counts.remove).toBe(0);
      expect(counts.add).toBe(0);
      expect(counts.fullEditor).toBe(0);
      expect(counts.addOwnership).toBe(0);
      expect(counts.star).toBe(0);
      expect(counts.reviewInput).toBe(0);
      await page.close();
    });

    it('does not trigger the write guard on the read-only path', async () => {
      const page = await openFixture(context, 'backloggd-ownership-click-tracker.html');
      const blocked: string[] = [];
      page.on('requestfailed', (req) => {
        const failure = req.failure();
        if (failure && failure.errorText.includes('ERR_BLOCKED_BY_CLIENT')) {
          blocked.push(`${req.method()} ${req.url()}`);
        }
      });
      // Trigger a deliberate POST to confirm the guard is installed and would
      // catch a write — proving the read path itself does not.
      await page.evaluate(async () => {
        try {
          await fetch('https://backloggd.com/render-editor/1', { method: 'POST' });
        } catch {
          // Expected to be blocked.
        }
      });
      await new Promise((r) => setTimeout(r, 300));
      const before = blocked.length;
      // Now run the read-only reader.
      await readVisibleBackloggdState(
        page,
        'Team Fortress 2',
        'backloggd-ownership-click-tracker',
        {
          timeout: 2000,
        },
      );
      await new Promise((r) => setTimeout(r, 300));
      // The read-only path must not have produced any additional blocked write.
      expect(blocked.length).toBe(before);
      await page.close();
    });
  });

  // -----------------------------------------------------------------------
  // Phase 5F Slice 4n — button-based Backloggd logged-in UI support
  // -----------------------------------------------------------------------

  describe('button-based Backloggd logged-in UI', () => {
    it('returns present state when a visible enabled Played container has btn-play-fill', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based.html',
        'The Legend of Zelda: Breath of the Wild',
        'backloggd-ownership-button-based',
      );
      // Game must be verified.
      expect(state.game.verified).toBe(true);
      // Library membership must be present (status button is active).
      expect(state.library.membership).toBe('present');
      // Completeness must NOT be 'unsupported' — the old unsupported-read
      // path must not fire for a recognizable button-based page.
      expect(state.library.completeness).not.toBe('unsupported');
      // No platform/ownership entries — button-based UI has no such detail.
      expect(state.library.ownershipEntries).toEqual([]);
      // The active status must be captured.
      expect(state.status.value).toBe('Played');
      expect(state.status.evidence).toBe('explicit-value');
      expect(state.library.buttonStatus).toEqual({
        value: 'Played',
        evidence: 'btn-play-fill',
      });
      // Diagnostics must contain the button-based note.
      expect(state.diagnostics.notes).toContain('button-based-status:Played');
      expect(state.diagnostics.notes).toContain('button-based-evidence:btn-play-fill');

      const playedResult = compareOwnership(STEAM_PLAYED, state.library);
      expect(playedResult.classification).toBe('already-present');
      expect(playedResult.reasonCode).toBe('button-status-match');

      // A filled status alone must not create save-eligible absent proof for
      // ordinary Steam/Digital ownership.
      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.reasonCode).not.toBe('unsupported-read');
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('no-safe-add-path');
      expect(result.classification).not.toBe('change-needed');
    });

    it('hidden Log a Game h1 is ignored for title verification', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based.html',
        'The Legend of Zelda: Breath of the Wild',
        'backloggd-ownership-button-based',
      );
      // The visible game title h1 must be used, not the hidden "Log a Game".
      expect(state.game.verified).toBe(true);
      expect(state.game.visibleTitle).toBe('The Legend of Zelda: Breath of the Wild');
    });

    it('unfilled all-four button state returns unsupported without absent proof', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based-ambiguous.html',
        'Hollow Knight',
        'backloggd-ownership-button-based-ambiguous',
      );
      // No active status button → falls through to the existing unsupported path.
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.membership).toBe('unknown');
      expect(state.status.evidence).toBe('unknown');
      expect(state.diagnostics.notes).toContain('no-visible-library-region');
      expect(state.diagnostics.notes).toContain('ambiguous-button-state:no-filled-status');

      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('unsupported-read');
      expect(result.classification).not.toBe('change-needed');
    });

    it('multiple filled status containers return unsupported without save eligibility', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based-multiple-filled.html',
        'Hollow Knight',
        'backloggd-ownership-button-based-multiple-filled',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.membership).toBe('unknown');
      expect(state.status.evidence).toBe('unknown');
      expect(state.diagnostics.notes).toContain('ambiguous-button-state:multiple-filled-status');

      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('unsupported-read');
      expect(result.classification).not.toBe('change-needed');
    });

    it('hidden filled status container is ignored and remains unsupported', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based-hidden-filled.html',
        'Hollow Knight',
        'backloggd-ownership-button-based-hidden-filled',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.membership).toBe('unknown');
      expect(state.status.evidence).toBe('unknown');
      expect(state.diagnostics.notes).toContain('ambiguous-button-state:no-filled-status');

      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('unsupported-read');
      expect(result.classification).not.toBe('change-needed');
    });

    it('title mismatch does not masquerade as login/challenge', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based-title-mismatch.html',
        'The Legend of Zelda',
        'backloggd-ownership-button-based-title-mismatch',
      );
      // Title mismatch: visible h1 says "Some Other Game", expected is
      // "The Legend of Zelda".  Must NOT look like a login/challenge.
      expect(state.game.verified).toBe(false);
      expect(state.game.visibleTitle).toBe('Some Other Game');
      expect(state.diagnostics.pageType).toBe('unknown');
      expect(state.diagnostics.notes).toContain('game-verification-failed');
      // Must not be detected as login or challenge.
      expect(state.diagnostics.pageType).not.toBe('login');
      expect(state.diagnostics.pageType).not.toBe('challenge');
      expect(state.diagnostics.pageType).not.toBe('rate-limit');

      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).toBe('unknown');
      expect(result.reasonCode).toBe('unsupported-read');
    });

    it('visible game title h1 takes precedence over hidden Log a Game', async () => {
      // Verify that the hidden "Log a Game" h1 is never used for heading
      // lookup.  Our fixture has it as hidden, but even if visible strategies
      // accidentally match it, the visible-title path uses innerText which
      // excludes hidden descendants.
      const state = await readFixture(
        'backloggd-ownership-button-based.html',
        'The Legend of Zelda: Breath of the Wild',
        'backloggd-ownership-button-based',
      );
      expect(state.game.visibleTitle).not.toBe('Log a Game');
      expect(state.game.visibleTitle).toBe('The Legend of Zelda: Breath of the Wild');
    });

    it('read-only path does not click status buttons', async () => {
      // The button-based detection uses only locators, counts, and DOM
      // evaluation. It never clicks or mutates the page.
      // The existing click-tracker tests above already prove the overall
      // reader never clicks any control, including status buttons.
      const state = await readFixture(
        'backloggd-ownership-button-based.html',
        'The Legend of Zelda: Breath of the Wild',
        'backloggd-ownership-button-based',
      );
      expect(state.game.verified).toBe(true);
      expect(state.library.completeness).not.toBe('unsupported');
    });

    it('disabled active status button does not produce trustworthy state', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based-disabled-active.html',
        'The Legend of Zelda: Breath of the Wild',
        'backloggd-ownership-button-based-disabled-active',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.membership).toBe('unknown');
      expect(state.status.evidence).toBe('unknown');
      expect(state.diagnostics.notes).toContain('ambiguous-button-state:disabled-filled-status');
    });

    it('aria-pressed true enabled status button support is retained', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based-aria-pressed.html',
        'The Legend of Zelda: Breath of the Wild',
        'backloggd-ownership-button-based-aria-pressed',
      );
      expect(state.library.membership).toBe('present');
      expect(state.library.completeness).toBe('complete');
      expect(state.status.value).toBe('Played');
      expect(state.library.buttonStatus).toEqual({
        value: 'Played',
        evidence: 'aria-pressed',
      });
      expect(state.diagnostics.notes).toContain('button-based-evidence:aria-pressed');

      const result = compareOwnership(STEAM_PLAYED, state.library);
      expect(result.classification).toBe('already-present');
      expect(result.reasonCode).toBe('button-status-match');
    });

    it('disabled aria-pressed true status button remains unsupported', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based-disabled-aria-pressed.html',
        'The Legend of Zelda: Breath of the Wild',
        'backloggd-ownership-button-based-disabled-aria-pressed',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.membership).toBe('unknown');
      expect(state.status.evidence).toBe('unknown');
      expect(state.diagnostics.notes).toContain('ambiguous-button-state:no-filled-status');
    });

    it('mismatched filled container class does not produce false status', async () => {
      const state = await readFixture(
        'backloggd-ownership-button-based-mismatched-container.html',
        'Hollow Knight',
        'backloggd-ownership-button-based-mismatched-container',
      );
      expect(state.library.completeness).toBe('unsupported');
      expect(state.library.membership).toBe('unknown');
      expect(state.status.evidence).toBe('unknown');

      const result = compareOwnership(STEAM_DIGITAL, state.library);
      expect(result.classification).not.toBe('already-present');
      expect(result.classification).not.toBe('change-needed');
      expect(result.classification).toBe('unknown');
    });
  });
});
