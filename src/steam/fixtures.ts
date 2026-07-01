/**
 * Fixture loader for offline development and testing.
 *
 * All fixture files are expected in the project's `fixtures/` directory
 * and contain sanitised mock data that mimics real API responses without
 * requiring network access or credentials.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Root of the fixtures directory, relative to this source file. */
const FIXTURES_ROOT = resolve(__dirname, '..', '..', 'fixtures');

/**
 * Read and parse a fixture JSON file.
 *
 * @param filename  Filename within the fixtures/ directory (e.g. `steam-owned-games.json`).
 * @type T          The expected parsed type.
 */
export async function readFixture<T = unknown>(filename: string): Promise<T> {
  const filePath = resolve(FIXTURES_ROOT, filename);
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as T;
}
