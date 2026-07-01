import Database from 'better-sqlite3';
import { getCreateTableSQL } from './schema.js';

let _db: Database.Database | null = null;
let _activePath: string | null = null;

/**
 * Run idempotent schema migrations for databases created before a column
 * or constraint existed.  Each migration checks whether the target column
 * is already present before modifying the table.
 */
export function runMigrations(db: Database.Database): void {
  // Migration 1: add `stale` column to `games` (added in Milestone 2)
  const columns = (db.pragma('table_info(games)') as { name: string }[]).map((col) => col.name);
  if (!columns.includes('stale')) {
    db.exec(`
      ALTER TABLE games
        ADD COLUMN stale INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(stale) = 'integer' AND stale IN (0, 1))
    `);
  }
}

/**
 * Open (or return the existing) database connection.
 * Creates tables and runs migrations on first connection.
 * Throws if called with a different path than the first open.
 */
export function openDatabase(dbPath: string): Database.Database {
  if (_db) {
    if (_activePath !== dbPath) {
      throw new Error(
        `Database already open at "${_activePath}". Cannot open "${dbPath}". ` +
          'Close the existing connection first with closeDatabase().',
      );
    }
    return _db;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(getCreateTableSQL());
  runMigrations(db);

  _db = db;
  _activePath = dbPath;
  return db;
}

/**
 * Close the database connection and reset the singleton.
 */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    _activePath = null;
  }
}

/**
 * Get the current database instance, or throw if not opened.
 */
export function getDatabase(): Database.Database {
  if (!_db) {
    throw new Error('Database not opened. Call openDatabase() first.');
  }
  return _db;
}
