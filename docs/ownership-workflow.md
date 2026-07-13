# Ownership Workflow — Operator Runbook

This document describes the explicit, step-by-step ownership workflow for
applying approved ownership changes to Backloggd through a safe,
operator-gated process.

> **Warning**: Do not run these commands against a live Backloggd account
> until you have reviewed the save plan and confirmed the confirmation rows.
> Each step is intentionally separated so you can inspect intermediate state
> before committing to a destructive action.

---

## Preconditions

Before beginning the ownership workflow, all of the following must be true:

1. **Database exists** — a valid SQLite import database has been created and
   populated by the normal import pipeline (Steam export → IGDB match →
   proposal → approval).
2. **Import session exists** — the approved ownership proposals belong to a
   known import session.
3. **Backloggd auth/profile configured** — a persistent Playwright browser
   profile exists at `.playwright/backloggd-profile` (or the location
   specified by `--profile-dir`).  You must have signed in to Backloggd at
   least once through this profile.
4. **Approved ownership import items exist** — at least one
   `proposal_kind = 'ownership'` item with `status = 'approved'` is present
   in the `import_items` table for the session.

---

## Step 1 — Read-only comparison

Compare the current Backloggd ownership state against the approved proposals.

```bash
npm run ownership:compare -- --session <id>
```

### What it does

- Opens each approved ownership item's Backloggd game page in a
  write-guarded browser session.
- Reads the visible ownership state (platform, ownership type).
- Compares the current state to the desired state in the proposal.
- Records the comparison result for each item.
- Returns a summary of: already-present, change-needed, conflict, unknown,
  left-importing, malformed, and unsupported-kind outcomes.

### What it may mutate through the audited runner

The comparison runner may update `import_items` status to terminal states
(e.g. `already-present`) for items whose ownership is already correct.  This
is the only mutation performed by the comparison step.

### What it never does

- Does **not** create confirmation rows.
- Does **not** stage or execute any save action.
- Does **not** call `runConfirmedOwnershipSave`.
- Does **not** call `applyOwnershipConfirmationSelection`.
- Does **not** call `stageOwnershipInBrowser` or `runConfirmedOwnershipStaging`.
- Does **not** call `processItem`, `transitionItem`, or `reconcileItem`.

### Exit codes

| Condition                            | Exit code |
| ------------------------------------ | --------- |
| No approved ownership items          | 0         |
| All already-present / change-needed  | 0         |
| Any conflict, unknown, left-importing, or malformed | 1 |

---

## Step 2 — Show plan

Display the ownership save plan for a session.  This step is **read-only**.

```bash
npm run ownership:confirm -- --session <id> --show-plan
```

### What it does

- Builds the ownership save plan from the current DB state.
- Displays eligible candidates with their proposal ID, Steam AppID, game
  title, Backloggd slug, desired platform, desired ownership type,
  proof-checked-at timestamp, and eligibility reason.
- Shows counts of eligible, excluded-terminal, excluded-unsupported-kind,
  excluded-malformed-metadata, excluded-missing-or-invalid-absent-proof,
  and excluded-stale-canonical items.

### Read-only behavior

- **No** confirmation rows are created.
- **No** import items are mutated.
- **No** proposals are mutated.
- **No** browser is launched.
- **No** Playwright code is imported or executed.

### Important output fields

| Field           | Description |
| --------------- | ----------- |
| `proposal`      | Unique proposal ID for this candidate. Use this with `--confirm-proposals`. |
| `title`         | Game title from the proposal. |
| `slug`          | Backloggd game slug. |
| `platform`      | Desired platform value (will be selected in the editor). |
| `ownership`     | Desired ownership type value (will be selected in the editor). |
| `eligibility`   | Reason this candidate is eligible for confirmation. |

---

## Step 3 — Confirm candidates

Record durable confirmation rows for eligible candidates.  No confirmation
happens by default — you must explicitly choose one of the following actions.

### Confirm exact proposals

Confirm one or more specific proposal IDs:

```bash
npm run ownership:confirm -- --session <id> --confirm-proposals <id1,id2,id3>
```

- Comma-separated list of proposal IDs.
- Unknown, duplicate, or stale selections are rejected with a nonzero exit.
- Empty tokens after trim are rejected (no silent filtering).
- Confirmation rows are created via the audited `applyOwnershipConfirmationSelection`.

### Confirm all eligible

Confirm every eligible candidate in the current save plan:

```bash
npm run ownership:confirm -- --session <id> --confirm-all-eligible
```

- Confirms all eligible candidates in one operation.
- Uses `applyOwnershipConfirmationSelection` with `selectAll: true`.

### Safety

- **No browser work** — these commands are pure DB operations.
- **No Playwright launch** — Playwright is not imported or executed.
- **No final saves** — confirmation does not trigger any save action.
- **No default confirmation** — if you omit both `--confirm-proposals` and
  `--confirm-all-eligible`, the command exits with an error.
- **Conflicting actions** — specifying more than one action causes an error.

---

## Step 4 — Execute confirmed saves

Apply the confirmed ownership changes to Backloggd.

```bash
npm run ownership:save -- --session <id> --execute-confirmed-ownership-saves
```

### Explicit dangerous flag

The `--execute-confirmed-ownership-saves` flag is **required**.  Without it,
the command fails with a clear error.  This flag exists to prevent accidental
final save execution from dry-run or normal import paths.

### What it does

1. Pre-checks confirmed rows in the database.
2. Launches a Playwright browser session using the shared `launchSession`.
3. For each confirmed row, navigates to the Backloggd game page,
   revalidates the confirmation, stages the ownership change, identifies
   the safe final save button, clicks it, observes the save request/response,
   and verifies the visible ownership state after saving.
4. Reports each result as `saved`, `stale`, `stagingFailed`, `unsupported`,
   `blockedWrite`, `saveFailed`, `verificationFailed`, or `browserFailed`.

### Final-save safety summary

- Write guard is installed before any browser interaction.
- Save allowance is narrowly scoped to exactly `POST /api/library/` and
  `POST /api/library/<numeric-id>` (POST-only).  Bare `POST /api/library`
  (no trailing slash) is blocked.  Prefix paths such as
  `/api/library-malicious` are blocked.  Non-POST methods are blocked.
- Only one safe final save action is identified and clicked.
- Only allowlisted names are accepted: `Save`, `Save changes`.
- Forbidden names (Delete, Remove, Full Editor, Create Log, Confirm,
  Submit, Update) are rejected.
- Save scope is tied to the verified editor/dialog only.
- Expected save request/response is observed before claiming success.
- Post-save visible verification confirms ownership was applied.
- Local state transition is atomic (both transitions in a DB transaction).

### Exit codes

| Condition                            | Exit code |
| ------------------------------------ | --------- |
| No confirmed rows                    | 0         |
| All saves successful                 | 0         |
| Any save failed (any nonzero status) | 1         |

### Save outcome reference

| Outcome             | Meaning |
| ------------------- | ------- |
| `saved`             | Final save executed and verified successfully. |
| `stale`             | DB revalidation failed before browser work. |
| `stagingFailed`     | Staging did not return `staged`. |
| `unsupported`       | No unique safe final save action or unsupported editor. |
| `blockedWrite`      | Unexpected write blocked by write guard. |
| `saveFailed`        | Click, response, or save signal failed. |
| `verificationFailed`| Post-save visible read did not prove ownership. |
| `browserFailed`     | Page disappeared or navigation failed. |

---

## Recovery guidance

### If compare reports unknown or conflict

Do not proceed with confirmation or save.  Investigate the affected items
manually:

- Open the Backloggd game page for each conflicting/unknown item.
- Determine the correct desired state.
- Update the proposal or mark the item as skipped/rejected in the import
  session.

Re-run comparison after resolving the unknowns/conflicts.

### If plan has no eligible rows

- Run `ownership:compare` first to ensure items have comparison results.
- Verify that your session ID is correct.
- Check that approved ownership items exist for the session.
- If items are present but excluded, review the plan counts to understand
  why (e.g. excluded-terminal, excluded-unsupported-kind,
  excluded-malformed-metadata).

### If confirmation rejects stale rows

Roll forward the import session by re-running comparison:

```bash
npm run ownership:compare -- --session <id>
```

This refreshes the comparison state for any items whose checkpoints may
be stale.  Then retry confirmation.

### If save returns blockedWrite

- The write guard detected unexpected write activity outside the allowed
  save scope.
- The save was not applied.
- Check whether the game page has changed or the editor interaction is
  selecting the wrong element.
- Do not retry without investigating the write guard log.

### If save returns saveFailed

- The save click did not produce an observable save request/response.
- The item remains in the `importing` state.
- Inspect command output and diagnostics to understand the failure.
- Manually check the current Backloggd ownership state on the game page.
- Only rerun the save command after verifying whether the previous save
  applied or did not apply.
- If the ownership state is ambiguous, stop and investigate before retrying.

### If save returns verificationFailed

- The save appeared to succeed (request/response observed) but the
  post-save visible read did not confirm the expected ownership state.
- The item remains in the `importing` state.
- Manually verify the Backloggd game page to determine whether the save
  was actually applied.
- If applied, manually transition the item to `saved`.
- If not applied, retry the save.

### If save returns browserFailed

- The browser page disappeared or navigation failed during processing.
- The item remains in the `importing` state.
- Do not retry until you verify whether the previous attempt applied.
- Manually check the Backloggd ownership state on the game page and the
  local DB checkpoint state.
- If the browser failure happened after the final save click, treat the
  state as ambiguous — stop and investigate before retrying.

---

## Non-goals

The ownership workflow does **not** support the following.  Each is explicitly
out of scope:

- **No status/playlog saves** — the ownership workflow only handles ownership
  proposals (`proposal_kind = 'ownership'`).  Status and playlog proposals
  are rejected.
- **No auto-confirm** — confirmation requires an explicit operator action
  (`--confirm-proposals` or `--confirm-all-eligible`).  No confirmation
  happens by default.
- **No retry automation** — the commands do not automatically retry failed
  saves.  The operator must investigate and re-run.
- **No browser final-save outside `ownership:save`** — the only way to
  execute final saves is `ownership:save -- --session <id>
  --execute-confirmed-ownership-saves`.
- **No one-shot "run all" command** — there is no single command that chains
  compare → confirm → save.  Each step must be invoked separately.
- **No automatic final-save default** — `ownership:save` refuses to run
  without `--execute-confirmed-ownership-saves`.
