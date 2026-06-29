# Backloggd Importer Roadmap

## Goal

Build a local, assisted importer that:

1. Reads a user's owned Steam games and playtime.
2. Matches Steam AppIDs to the corresponding IGDB and Backloggd games.
3. Lets the user review every proposed ownership and status change.
4. Uses Backloggd's visible browser interface to help apply approved changes.

The importer should save repetitive searching and data entry without making
unreviewed claims about what the user played, completed, rated, or reviewed.

## Guiding constraints

- Backloggd does not currently offer a public write API or import feature.
- Backloggd authentication remains inside the user's browser.
- The importer never asks for or stores a Backloggd password.
- Ratings, review text, completion states, and detailed play logs are never
  inferred or published automatically.
- Uncertain game matches require manual confirmation.
- Every operation must be safe to retry without creating duplicate entries.
- Development starts read-only and adds account changes only after the data
  pipeline has been validated.

## Proposed architecture

The initial implementation will use:

- TypeScript and Node.js for the local companion application.
- The Steam Web API for owned games and playtime.
- IGDB external-game records for Steam AppID matching.
- SQLite for the resumable import queue and cached matches.
- A small local review interface for approving and correcting suggestions.
- Playwright for assisted interaction with Backloggd.

A browser extension is a later packaging option, not an MVP requirement.

## Milestone 0 — Project foundation

Set up the smallest maintainable application skeleton.

- [ ] Initialize the TypeScript project and development commands.
- [ ] Add linting, formatting, and automated tests.
- [ ] Define configuration for Steam and IGDB credentials.
- [ ] Add `.env.example` and ensure secret files are ignored.
- [ ] Define normalized game, match, proposal, and import-state models.
- [ ] Add sanitized fixture data for offline development.
- [ ] Document local setup and credential requirements.

Exit criteria:

- A new contributor can install dependencies, validate configuration, and run
  the test suite using documented commands.
- Secrets cannot be committed through the normal project workflow.
- Tests can run without calling Steam, IGDB, or Backloggd.

## Milestone 1 — Read-only Steam library export

Create a reliable source-of-truth export from Steam.

- [ ] Call `IPlayerService/GetOwnedGames`.
- [ ] Include app information and played free games.
- [ ] Normalize AppID, title, icon, lifetime playtime, and last-played time.
- [ ] Cache the raw response for repeatable development and debugging.
- [ ] Detect private or unavailable game details and explain the remedy.
- [ ] Add filters for obvious non-game entries where they can be identified.
- [ ] Export normalized data as JSON and CSV.

Exit criteria:

- The same cached response always produces the same normalized export.
- Empty, private, malformed, and large libraries have automated test coverage.
- A real library can be exported without exposing the Steam API key in output
  or logs.

## Milestone 2 — IGDB and Backloggd matching

Resolve Steam games to stable game records without relying primarily on title
similarity.

- [ ] Obtain and refresh an IGDB application access token.
- [ ] Batch-query IGDB external-game records using Steam AppIDs.
- [ ] Record the IGDB game ID, name, slug, and match source.
- [ ] Cache successful and unsuccessful matches.
- [ ] Detect editions, demos, DLC, soundtracks, and ambiguous results.
- [ ] Add normalized-title and release-year matching as a fallback.
- [ ] Assign `exact`, `probable`, `ambiguous`, or `unmatched` confidence.
- [ ] Never approve a non-exact match automatically.

Exit criteria:

- Exact Steam AppID matches are correct for at least 95% of a representative
  100-game sample, with the remainder visibly queued for review.
- False-positive fallback matches are not imported automatically.
- Each accepted match produces a valid candidate Backloggd URL.

## Milestone 3 — Proposal and review interface

Turn matched data into explicit changes the user can inspect.

- [ ] Create a local review screen with search and filters.
- [ ] Show Steam title, playtime, match confidence, and destination game.
- [ ] Let users correct a match, skip it, or defer it.
- [ ] Keep ownership, game status, and play-log suggestions separate.
- [ ] Default ownership to a digital Steam library entry.
- [ ] Make playtime thresholds and status suggestions configurable.
- [ ] Support bulk approval only for exact matches.
- [ ] Export an approved import manifest before any browser interaction.

Suggested default policy:

| Steam data                              | Suggested Backloggd change  |
| --------------------------------------- | --------------------------- |
| Any owned game                          | Add digital Steam ownership |
| Zero playtime                           | Optionally suggest Backlog  |
| Playtime above the configured threshold | Optionally suggest Played   |
| Any rating, review, or completion state | Leave unchanged             |

Exit criteria:

- A user can review an entire library and produce an approved manifest without
  signing in to Backloggd.
- Every proposed field can be changed or disabled.
- No Backloggd account writes exist in this milestone.

## Milestone 4 — Backloggd interaction proof of concept

Prove that approved data can be transferred through Backloggd's visible UI.

- [ ] Launch a persistent browser session with Playwright.
- [ ] Require the user to sign in to Backloggd manually.
- [ ] Open the matched Backloggd game page.
- [ ] Locate controls using labels and accessible roles where possible.
- [ ] Read and display the game's existing ownership and status.
- [ ] Fill one approved ownership proposal without submitting it.
- [ ] Stop safely when the expected page or controls are unavailable.
- [ ] Capture sanitized diagnostics for selector failures.

Exit criteria:

- The tool can repeatedly open and prepare five representative games.
- It does not extract or persist Backloggd credentials or session cookies.
- It does not click Backloggd's final save control.

## Milestone 5 — Safe assisted importer (MVP)

Add user-confirmed saves, verification, and resumability.

- [ ] Compare each proposal with existing Backloggd data.
- [ ] Skip changes that are already present.
- [ ] Preserve other platforms and existing library entries.
- [ ] Require an explicit user confirmation before each save.
- [ ] Verify the saved result before advancing.
- [ ] Checkpoint each item as approved, importing, saved, skipped, or failed.
- [ ] Resume cleanly after browser closure or process failure.
- [ ] Add conservative pacing and pause on login, CAPTCHA, or rate-limit pages.
- [ ] Produce a final import report.

Exit criteria:

- A 25-game pilot handles new entries, existing entries, skips, and deliberate
  interruption without creating duplicates.
- Restarting the same import results in no unintended changes.
- Failed items remain reviewable and retryable.

This milestone is the first usable release.

## Milestone 6 — Hardening and packaging

Make the MVP comfortable and dependable for users other than its author.

- [ ] Add integration tests around Steam and IGDB clients.
- [ ] Add browser interaction tests using local HTML fixtures.
- [ ] Redact keys, tokens, cookies, and personal identifiers from logs.
- [ ] Provide clear setup, backup, recovery, and troubleshooting instructions.
- [ ] Add data-reset and cache-refresh controls.
- [ ] Test Windows, macOS, and Linux setup.
- [ ] Run a reviewed 100-game import and document the results.
- [ ] Contact Backloggd about the project and request integration guidance.

Exit criteria:

- A user can install and complete an assisted import from the documentation.
- Common failures produce actionable messages rather than partial silent work.
- The security and account-safety assumptions are documented.

## Milestone 7 — Browser extension evaluation

Decide whether an extension materially improves the supported workflow.

- [ ] Compare extension installation with the Playwright experience.
- [ ] Prototype communication with the local companion.
- [ ] Limit host permissions to Backloggd and the local companion.
- [ ] Confirm that Backloggd authentication remains browser-owned.
- [ ] Re-evaluate maintenance cost when Backloggd changes its UI.

Ship an extension only if it is meaningfully easier to use and no less safe
than the Playwright workflow.

## Milestone 8 — Supported automation

This milestone depends on Backloggd providing an official API/import mechanism
or explicitly approving a more automated integration.

- [ ] Replace browser interaction with the supported integration.
- [ ] Add authenticated duplicate-safe batch submission.
- [ ] Retain preview, approval, audit, and rollback-friendly records.
- [ ] Consider optional periodic synchronization.

Unattended submission is out of scope until this dependency is satisfied.

## Explicit non-goals

- Scraping or storing a user's Backloggd password.
- Copying Backloggd session cookies into the companion application.
- Reverse-engineering private write endpoints for a public bulk importer.
- Automatically writing ratings or review text.
- Treating Steam playtime as proof of completion.
- Overwriting existing Backloggd logs or ownership records.
- Continuous synchronization in the first release.

## MVP definition

The MVP consists of Milestones 0 through 5. It is complete when a user can:

1. Import and match a Steam library.
2. Review and approve exact proposed changes.
3. Sign in to Backloggd themselves.
4. Apply entries one at a time with explicit confirmation.
5. Stop and resume without duplicates or lost progress.

## Open decisions

- What playtime threshold, if any, should trigger a `Played` suggestion?
- Should zero-playtime games default to `Backlog` or ownership only?
- Should manual match corrections be stored globally or per import?
- Is a local web interface preferable to a terminal interface for the first
  review workflow?
- Does Backloggd want to support or collaborate on this importer?
