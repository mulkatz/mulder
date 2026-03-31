/**
 * SQLite-based LLM response cache for dev mode.
 *
 * Stores request-hash to response mappings in a local SQLite database.
 * Eliminates redundant Vertex AI calls during prompt iteration, reducing
 * cost from O(docs x iterations) to O(docs) for the first run and O(1)
 * for unchanged prompts.
 *
 * The cache is LOCAL only (`.mulder-cache.db` in project root, gitignored).
 * Enabled via `MULDER_LLM_CACHE=true` env var — never in production.
 * No TTL — manual clear only (prompt iteration is the use case).
 *
 * @see docs/specs/17_vertex_ai_wrapper_dev_cache.spec.md §4.1
 * @see docs/functional-spec.md §4.8
 */

import { statSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Logger } from './shared/logger.js';

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** A single cache entry stored in the SQLite database. */
export interface CacheEntry {
	request_hash: string;
	response: string;
	model: string;
	tokens_saved: number;
	created_at: number;
}

/** Statistics about the cache database. */
export interface CacheStats {
	entries: number;
	totalTokensSaved: number;
	dbSizeBytes: number;
}

/** LLM response cache interface. */
export interface LlmCache {
	/** Retrieve a cached response by request hash. */
	get(hash: string): CacheEntry | undefined;

	/** Store a response in the cache. */
	set(hash: string, entry: Omit<CacheEntry, 'request_hash' | 'created_at'>): void;

	/** Clear all cache entries. Returns the number of entries deleted. */
	clear(): number;

	/** Get cache statistics (entry count, tokens saved, db size). */
	stats(): CacheStats;

	/** Close the database connection. */
	close(): void;
}

// ────────────────────────────────────────────────────────────
// SQL
// ────────────────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS cache_entries (
		request_hash TEXT PRIMARY KEY,
		response TEXT NOT NULL,
		model TEXT NOT NULL,
		tokens_saved INTEGER NOT NULL,
		created_at INTEGER NOT NULL
	)
`;

const GET_SQL =
	'SELECT request_hash, response, model, tokens_saved, created_at FROM cache_entries WHERE request_hash = ?';
const SET_SQL =
	'INSERT OR REPLACE INTO cache_entries (request_hash, response, model, tokens_saved, created_at) VALUES (?, ?, ?, ?, ?)';
const CLEAR_SQL = 'DELETE FROM cache_entries';
const COUNT_SQL = 'SELECT COUNT(*) AS cnt FROM cache_entries';
const SUM_TOKENS_SQL = 'SELECT COALESCE(SUM(tokens_saved), 0) AS total FROM cache_entries';

// ────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────

/**
 * Creates an LLM response cache backed by SQLite.
 *
 * The database file and schema are created automatically on first access.
 * Uses synchronous SQLite operations via `better-sqlite3` for simplicity.
 *
 * @param dbPath - Path to the SQLite database file (e.g., `.mulder-cache.db`).
 * @param logger - Logger instance for cache operation logging.
 * @returns An `LlmCache` instance.
 */
export function createLlmCache(dbPath: string, logger: Logger): LlmCache {
	const db = new Database(dbPath);

	// Enable WAL mode for better concurrent read performance
	db.pragma('journal_mode = WAL');

	// Create the table if it doesn't exist (auto-migration)
	db.exec(CREATE_TABLE_SQL);

	logger.debug({ dbPath }, 'LlmCache: initialized');

	// Prepare statements for performance
	const getStmt = db.prepare(GET_SQL);
	const setStmt = db.prepare(SET_SQL);
	const clearStmt = db.prepare(CLEAR_SQL);
	const countStmt = db.prepare(COUNT_SQL);
	const sumTokensStmt = db.prepare(SUM_TOKENS_SQL);

	return {
		get(hash: string): CacheEntry | undefined {
			const row = getStmt.get(hash) as CacheEntry | undefined;
			return row;
		},

		set(hash: string, entry: Omit<CacheEntry, 'request_hash' | 'created_at'>): void {
			const now = Date.now();
			setStmt.run(hash, entry.response, entry.model, entry.tokens_saved, now);
		},

		clear(): number {
			const result = clearStmt.run();
			const count = result.changes;
			logger.info({ entriesCleared: count }, 'LlmCache: cleared');
			return count;
		},

		stats(): CacheStats {
			const countRow = countStmt.get() as { cnt: number };
			const sumRow = sumTokensStmt.get() as { total: number };

			let dbSizeBytes = 0;
			try {
				const stat = statSync(dbPath);
				dbSizeBytes = stat.size;
			} catch {
				// File may not exist yet or be inaccessible
			}

			return {
				entries: countRow.cnt,
				totalTokensSaved: sumRow.total,
				dbSizeBytes,
			};
		},

		close(): void {
			db.close();
			logger.debug('LlmCache: closed');
		},
	};
}
