/**
 * CLI entry point to validate configuration.
 *
 * Usage: node --import dotenv/config dist/config/validate.js
 * or via npm: npm run validate:config
 */

import { loadConfig } from './index.js';

try {
  loadConfig();
  console.log('Configuration is valid.');
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unknown configuration error');
  process.exit(1);
}
