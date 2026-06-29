# backloggd-importer

An assisted importer for matching a user's Steam library to Backloggd and
preparing ownership and status updates for review.

The project is intentionally designed around user confirmation: it will not
publish ratings or reviews, store Backloggd credentials, or silently submit
account changes.

See [ROADMAP.md](ROADMAP.md) for the planned milestones and MVP boundary.

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

## Available commands

| Command                   | Description                           |
| ------------------------- | ------------------------------------- |
| `npm run build`           | Compile TypeScript to `dist/`         |
| `npm run typecheck`       | Type-check without emitting           |
| `npm test`                | Run all tests                         |
| `npm run test:watch`      | Run tests in watch mode               |
| `npm run lint`            | Lint source and test files            |
| `npm run lint:fix`        | Lint and auto-fix                     |
| `npm run format`          | Format source files with Prettier     |
| `npm run format:check`    | Check formatting without writing      |
| `npm run validate:config` | Validate loaded environment variables |
| `npm run clean`           | Remove the `dist/` directory          |

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
