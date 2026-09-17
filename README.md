# backloggd-importer

An assisted importer for matching a user's Steam library to Backloggd and
preparing ownership and status updates for review.

The project is intentionally designed around user confirmation: it will not
publish ratings or reviews, store Backloggd credentials, or silently submit
account changes.

See [ROADMAP.md](ROADMAP.md) for the planned milestones and MVP boundary.

## Current v1 support boundary

Supported and demonstrated: Steam/IGDB import and matching, proposal review,
manifest export and item seeding, checkpoint/state-machine safety,
conservative read-only ownership comparison, M6 hardening, and the Milestone 7
browser-extension feasibility evaluation. Comparison handles unknown, conflict,
and login/challenge/rate-limit outcomes safely. The ownership flow is
deliberately separated into compare → plan → explicit confirmation → save. CI
at commit `135149c0` passed the full suite (48 files / 1967 tests), including
Chromium setup, on Ubuntu, Windows, and macOS.

Milestone 7 evaluated a browser extension and concluded `DEFER`: an extension
does not solve the current ownership-read limitation, and no extension code has
been created. Playwright remains the supported write path.

Guarded confirmation, staging, and final-save paths are implemented, but the
live ownership-add path has not been demonstrated. In particular, the observed
button-only Backloggd UI provides no trustworthy ownership-absence evidence:
all-unfilled or non-pressed controls are `unknown` and are never eligible as
proof of `change-needed`. Unsupported or ambiguous UI must not be treated as
absence, and this release makes no claim of verified live final-save behavior.
This is a safety limitation, not permission to weaken the absence-proof gate.

Release packages must be created from tracked files only; local credentials,
databases, and browser-profile data are not release artifacts.

## Prerequisites

- **Node.js** >= 20
- **npm**
- A **Steam Web API key** — obtain from https://steamcommunity.com/dev/apikey
- A **Twitch (IGDB) client ID and secret** — register an app at
  https://dev.twitch.tv/console/apps

## Setup

```bash
# 1. Clone the repository
git clone https://github.com/Geo-M69/backloggd-importer.git
cd backloggd-importer

# 2. Install dependencies
npm install

# 3. Copy the environment template and fill in your credentials
cp .env.example .env
# Edit .env with your Steam API key, Steam user ID, and IGDB credentials

# 4. Build the TypeScript source
npm run build

# 5. Validate your configuration (requires a populated .env file)
npm run validate:config

# 6. Run the test suite (no external API calls required)
npm test
```

PowerShell equivalent for copying the environment template:

```powershell
Copy-Item .env.example .env
```

## Browser-assisted commands

The ownership workflow (`ownership:compare`, `ownership:confirm`,
`ownership:save`) uses Playwright to drive a local Chromium browser that you
sign into Backloggd yourself.

1. Install Playwright's browser binaries (this applies on all platforms):

   ```bash
   npx playwright install chromium
   ```

2. On some Linux distributions you may also need system dependencies (Linux only):

   ```bash
   npx playwright install-deps chromium
   ```

3. The first time you run an ownership command, sign in to Backloggd manually
   in the opened browser window. The persistent profile is stored at
   `.playwright/backloggd-profile` by default (override with `--profile-dir`).
   Do not delete this directory unless you are prepared to sign in again.

Browser-assisted commands default to visible (non-headless) mode so you can
supervise sign-in and any blocker pages. Pass `--headless` only after you have
already authenticated and your environment supports unattended Chromium
launches.

> The examples above use bash. On Windows, use equivalent PowerShell or CMD
> commands. Automated CI validates install, Chromium setup, build, lint,
> source/test typechecks, and the full test suite (48 files / 1967 tests) on
> Ubuntu, Windows, and macOS.

Playwright's `npx playwright install chromium` command is cross-platform;
`npx playwright install-deps chromium` is Linux-specific.

On most platforms, `better-sqlite3` installs using a prebuilt binary. If Windows
falls back to building it from source, install Python and Visual Studio Build
Tools with the required C++ tooling.

## Backup before operational work

Before running commands that mutate the database or browser state, make a copy
of:

- `import.db` (or the file pointed to by `DB_PATH`) — contains games, matches,
  proposals, import sessions, items, and cached API responses.
- `.playwright/backloggd-profile/` — contains your signed-in Backloggd browser
  session.
- Any manifest JSON files you generated and intend to reuse.

Example (bash):

```bash
cp import.db "import.db.$(date +%F).backup"
cp -r .playwright/backloggd-profile "backloggd-profile.$(date +%F).backup"
```

PowerShell equivalents:

```powershell
Copy-Item import.db "import.db.$(Get-Date -Format yyyy-MM-dd).backup"
Copy-Item .playwright/backloggd-profile "backloggd-profile.$(Get-Date -Format yyyy-MM-dd).backup" -Recurse
```

If something goes wrong, restore by closing all importer processes, replacing
the files, and rerunning from a known-good step. Do not manually edit database
rows to mark unresolved items as `saved`; `saved` requires the audited save
path and verified proof. Preserving unresolved state is the safe recovery
choice.

## Troubleshooting

### Browser does not launch or Chromium fails to start

- Ensure Playwright browsers are installed:
  `npx playwright install chromium`
- On Linux, try installing system dependencies:
  `npx playwright install-deps chromium`
- In sandboxed or containerized Linux environments, Chromium may fail with
  `sandbox_host_linux.cc ... Operation not permitted`. This is an environment
  limitation, not a product failure. Run browser-assisted commands on a host
  where Playwright Chromium can start.
- The test suite includes browser tests; if they fail only during browser
  launch, the host likely cannot run the Chromium sandbox.

### `ownership:compare` exits with unsafe outcomes

This is expected when the live Backloggd UI cannot be read unambiguously.
Review the output, do not proceed to confirmation or save, and follow the
recovery steps in [`docs/ownership-workflow.md`](docs/ownership-workflow.md).

### Lost or corrupted browser profile

Delete `.playwright/backloggd-profile` and sign in again during the next
ownership command.

### Stale `importing` rows

If a process is interrupted, an item may remain in the `importing` state. Do
not manually mark it `saved`. Treat it as unresolved: investigate the item on
Backloggd, then use the retry workflow documented in
[`docs/ownership-workflow.md`](docs/ownership-workflow.md).

## Available commands

| Command                          | Description                                  |
| -------------------------------- | -------------------------------------------- |
| `npm run build`                  | Compile TypeScript to `dist/`                |
| `npm run typecheck`              | Type-check without emitting                  |
| `npm test`                       | Run all tests                                |
| `npm run test:watch`             | Run tests in watch mode                      |
| `npm run lint`                   | Lint source and test files                   |
| `npm run lint:fix`               | Lint and auto-fix                            |
| `npm run format`                 | Format source files with Prettier            |
| `npm run format:check`           | Check formatting without writing             |
| `npm run validate:config`        | Validate loaded environment variables        |
| `npm run cache:clear -- --steam` | Clear the cached Steam library response      |
| `npm run cache:clear -- --igdb`  | Clear the cached IGDB OAuth token            |
| `npm run cache:clear -- --all`   | Clear both explicitly selected cache entries |
| `npm run clean`                  | Remove the `dist/` directory                 |

## Project structure

```
src/
  config/          Configuration loading and validation
  models/          Data types for games, matches, proposals, and sessions
  storage/         SQLite schema and database connection helpers
  index.ts         Public API entry point

tests/
  config/          Config validation tests
  models/          Model construction tests
  storage/         Schema tests (in-memory SQLite)

fixtures/          Sanitised mock data for offline development and testing
```

## Security notes

- **Never commit your `.env` file** — it is ignored by `.gitignore`.
- The importer **never** asks for or stores your Backloggd password.
- Authentication with Backloggd happens **in your own browser** via a
  Playwright session that you control.
- No ratings, reviews, or completion states are inferred or published
  automatically — every change requires your explicit approval.
