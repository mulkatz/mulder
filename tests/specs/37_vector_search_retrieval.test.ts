import { resolve } from 'node:path';
import {
	type EmbeddingResult,
	type EmbeddingService,
	loadConfig,
	type MulderConfig,
	mulderConfigSchema,
	RetrievalError,
	searchByVectorWithEfSearch,
} from '@mulder/core';
import { vectorSearch } from '@mulder/retrieval';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_USER = db.TEST_PG_USER;
const PG_PASSWORD = db.TEST_PG_PASSWORD;
const PG_DATABASE = db.TEST_PG_DATABASE;
const PG_HOST = db.TEST_PG_HOST;
const PG_PORT = db.TEST_PG_PORT;

/**
 * Black-box QA tests for Spec 37: Vector Search Retrieval (M4-E1).
 *
 * This is the first spec where black-box tests must call into a library rather
 * than the CLI. The system boundary is the public package surface of
 * `@mulder/retrieval` and `@mulder/core` — never internal source files.
 *
 * Each `it()` maps to one QA condition (QA-01..QA-12) from the spec's QA Contract.
 *
 * Requires:
 * - PostgreSQL reachable through the standard PG env vars with migrations applied
 * - Built dist artifacts for `@mulder/core` and `@mulder/retrieval`
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPgAvailable(): boolean {
	return db.isPgAvailable();
}

function runSql(sql: string): string {
	return db.runSql(sql);
}

/**
 * Run a SQL statement that uses RETURNING and produce only the first column
 * of the first row. psql `-t -A` for INSERT … RETURNING also prints the
 * "INSERT 0 N" command tag — we strip it here.
 */
function runSqlReturning(sql: string): string {
	const out = runSql(sql);
	const firstLine = out.split('\n')[0];
	return firstLine.trim();
}

function cleanTestData(): void {
	runSql(
		"DELETE FROM chunks; DELETE FROM story_entities; DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities; DELETE FROM stories WHERE title LIKE 'spec37-%'; DELETE FROM source_steps WHERE source_id IN (SELECT id FROM sources WHERE filename LIKE 'spec37-%'); DELETE FROM sources WHERE filename LIKE 'spec37-%';",
	);
}

/**
 * Build a deterministic 768-dim "embedding" with a varying first dimension.
 * Each chunk gets a distinct vector that's still close enough to all other
 * chunks for ANN search to return them all.
 */
function makeEmbedding(seed: number): number[] {
	const v = new Array(768).fill(0).map((_, i) => Math.sin((i + 1) * 0.01) * 0.1);
	v[0] = seed;
	return v;
}

function vectorLiteral(v: number[]): string {
	return `[${v.join(',')}]`;
}

/** Build a fresh, mutable config from the example file. */
function makeConfig(overrides?: { topK?: number; efSearch?: number }): MulderConfig {
	const base = loadConfig(EXAMPLE_CONFIG);
	// Deep clone to break the deepFreeze
	const cloned = JSON.parse(JSON.stringify(base)) as MulderConfig;
	if (overrides?.topK !== undefined) {
		cloned.retrieval.top_k = overrides.topK;
	}
	if (overrides?.efSearch !== undefined) {
		cloned.retrieval.strategies.vector.ef_search = overrides.efSearch;
	}
	// Re-parse to apply schema defaults / validation, ensures shape is real.
	return mulderConfigSchema.parse(cloned);
}

/** A working stub embedding service that returns a deterministic 768-dim vector. */
function workingEmbeddingService(): EmbeddingService {
	return {
		embed: async (texts: string[]): Promise<EmbeddingResult[]> =>
			texts.map((t) => ({
				text: t,
				vector: makeEmbedding(0.5),
			})),
	};
}

/** A throwing stub: any call to embed() throws. */
function throwingEmbeddingService(error: Error): EmbeddingService {
	return {
		embed: async (): Promise<EmbeddingResult[]> => {
			throw error;
		},
	};
}

/** A spy stub that records whether embed() was called. */
function spyEmbeddingService(): { service: EmbeddingService; called: () => boolean } {
	let invoked = false;
	return {
		service: {
			embed: async (): Promise<EmbeddingResult[]> => {
				invoked = true;
				throw new Error('spy: embed() should not have been called');
			},
		},
		called: () => invoked,
	};
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface SeededData {
	sourceA: string;
	sourceB: string;
	storyA: string;
	storyB: string;
	chunkIdsA: string[];
	chunkIdsB: string[];
}

async function seedFixture(): Promise<SeededData> {
	// Two sources
	const sourceA = runSqlReturning(
		`INSERT INTO sources (filename, storage_path, file_hash, status)
		 VALUES ('spec37-source-a.pdf', 'gs://test/spec37-a.pdf', 'spec37-hash-a', 'ingested')
		 RETURNING id;`,
	);
	const sourceB = runSqlReturning(
		`INSERT INTO sources (filename, storage_path, file_hash, status)
		 VALUES ('spec37-source-b.pdf', 'gs://test/spec37-b.pdf', 'spec37-hash-b', 'ingested')
		 RETURNING id;`,
	);

	// Two stories (one per source)
	const storyA = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceA}', 'spec37-story-a', 'gs://test/a.md', 'gs://test/a.json', 'embedded')
		 RETURNING id;`,
	);
	const storyB = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceB}', 'spec37-story-b', 'gs://test/b.md', 'gs://test/b.json', 'embedded')
		 RETURNING id;`,
	);

	// Seed enough chunks: 5 for storyA, 5 for storyB = 10 total > 7 (for QA-09).
	const chunkIdsA: string[] = [];
	const chunkIdsB: string[] = [];

	for (let i = 0; i < 5; i++) {
		const seed = 0.9 - i * 0.1; // 0.9, 0.8, 0.7, 0.6, 0.5
		const v = makeEmbedding(seed);
		const id = runSqlReturning(
			`INSERT INTO chunks (story_id, content, chunk_index, embedding)
			 VALUES ('${storyA}', 'spec37 story-a chunk ${i}', ${i}, '${vectorLiteral(v)}'::vector)
			 RETURNING id;`,
		);
		chunkIdsA.push(id);
	}

	for (let i = 0; i < 5; i++) {
		const seed = -0.9 + i * 0.1; // -0.9, -0.8, -0.7, -0.6, -0.5
		const v = makeEmbedding(seed);
		const id = runSqlReturning(
			`INSERT INTO chunks (story_id, content, chunk_index, embedding)
			 VALUES ('${storyB}', 'spec37 story-b chunk ${i}', ${i}, '${vectorLiteral(v)}'::vector)
			 RETURNING id;`,
		);
		chunkIdsB.push(id);
	}

	return { sourceA, sourceB, storyA, storyB, chunkIdsA, chunkIdsB };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 37 — Vector Search Retrieval', () => {
	const pgAvailable = isPgAvailable();
	let pool: pg.Pool;
	let seed: SeededData;
	let baseConfig: MulderConfig;

	beforeAll(async () => {
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		ensureSchema();

		cleanTestData();
		seed = await seedFixture();
		baseConfig = makeConfig();

		pool = new pg.Pool({
			host: PG_HOST,
			port: PG_PORT,
			user: PG_USER,
			password: PG_PASSWORD,
			database: PG_DATABASE,
		});
	}, 60_000);

	afterAll(async () => {
		if (!pgAvailable) return;
		try {
			cleanTestData();
		} catch {
			// ignore
		}
		if (pool) {
			await pool.end();
		}
	});

	// ─── QA-01: Vector search by text query returns ranked chunks ───
	it.skipIf(!pgAvailable)('QA-01: vector search by text query returns ranked chunks', async () => {
		const results = await vectorSearch(pool, workingEmbeddingService(), baseConfig, {
			query: 'find me something',
			limit: 5,
		});

		expect(Array.isArray(results)).toBe(true);
		expect(results.length).toBeGreaterThan(0);
		expect(results.length).toBeLessThanOrEqual(5);

		for (const r of results) {
			expect(r.strategy).toBe('vector');
			expect(typeof r.chunkId).toBe('string');
			expect(typeof r.storyId).toBe('string');
		}

		// Ranks are contiguous 1..N
		const ranks = results.map((r) => r.rank);
		expect(ranks).toEqual(Array.from({ length: results.length }, (_, i) => i + 1));

		// Scores descending (higher = better)
		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
		}
	});

	// ─── QA-02: Precomputed embedding bypasses embedding service ───
	it.skipIf(!pgAvailable)('QA-02: precomputed embedding bypasses the embedding service', async () => {
		const spy = spyEmbeddingService();
		const queryEmbedding = makeEmbedding(0.85);

		const results = await vectorSearch(pool, spy.service, baseConfig, {
			embedding: queryEmbedding,
			limit: 3,
		});

		expect(spy.called()).toBe(false);
		expect(results.length).toBeGreaterThan(0);
		expect(results.length).toBeLessThanOrEqual(3);
	});

	// ─── QA-03: Story-id filter restricts results ───
	it.skipIf(!pgAvailable)('QA-03: storyIds filter restricts results to that story', async () => {
		const results = await vectorSearch(pool, workingEmbeddingService(), baseConfig, {
			query: 'something',
			storyIds: [seed.storyA],
			limit: 10,
		});

		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.storyId).toBe(seed.storyA);
		}
	});

	// ─── QA-04: Empty (whitespace) query rejected ───
	it.skipIf(!pgAvailable)('QA-04: whitespace-only query throws RETRIEVAL_INVALID_INPUT', async () => {
		await expect(vectorSearch(pool, workingEmbeddingService(), baseConfig, { query: '   ' })).rejects.toMatchObject({
			name: 'RetrievalError',
			code: 'RETRIEVAL_INVALID_INPUT',
		});
	});

	// ─── QA-05: Missing input rejected ───
	it.skipIf(!pgAvailable)('QA-05: no query and no embedding throws RETRIEVAL_INVALID_INPUT', async () => {
		await expect(vectorSearch(pool, workingEmbeddingService(), baseConfig, {})).rejects.toMatchObject({
			name: 'RetrievalError',
			code: 'RETRIEVAL_INVALID_INPUT',
		});
	});

	// ─── QA-06: Dimension mismatch rejected ───
	it.skipIf(!pgAvailable)('QA-06: wrong-dimension embedding throws RETRIEVAL_DIMENSION_MISMATCH', async () => {
		const wrongDim = new Array(384).fill(0).map((_, i) => Math.sin(i));
		await expect(
			vectorSearch(pool, workingEmbeddingService(), baseConfig, { embedding: wrongDim }),
		).rejects.toMatchObject({
			name: 'RetrievalError',
			code: 'RETRIEVAL_DIMENSION_MISMATCH',
		});
	});

	// ─── QA-07: Embedding failure wrapped in RETRIEVAL_EMBEDDING_FAILED ───
	it.skipIf(!pgAvailable)(
		'QA-07: embedding service failure wrapped in RetrievalError(RETRIEVAL_EMBEDDING_FAILED) with cause',
		async () => {
			const original = new Error('boom');
			let caught: unknown;
			try {
				await vectorSearch(pool, throwingEmbeddingService(original), baseConfig, {
					query: 'anything',
				});
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(RetrievalError);
			const err = caught as RetrievalError & { cause?: unknown };
			expect(err.code).toBe('RETRIEVAL_EMBEDDING_FAILED');
			// Either cause is the original Error, or its message is preserved
			const causeIsOriginal = err.cause === original;
			const causeMatchesByMessage = err.cause instanceof Error && err.cause.message === original.message;
			const messagePreserved = typeof err.message === 'string' && err.message.includes('boom');
			expect(causeIsOriginal || causeMatchesByMessage || messagePreserved).toBe(true);
		},
	);

	// ─── QA-08: Empty result set returns [] ───
	it.skipIf(!pgAvailable)('QA-08: storyIds filter matching nothing returns []', async () => {
		const results = await vectorSearch(pool, workingEmbeddingService(), baseConfig, {
			query: 'something',
			storyIds: ['00000000-0000-0000-0000-000000000000'],
		});
		expect(Array.isArray(results)).toBe(true);
		expect(results).toEqual([]);
	});

	// ─── QA-09: Default limit respects retrieval.top_k ───
	it.skipIf(!pgAvailable)('QA-09: default limit equals retrieval.top_k from config', async () => {
		// Pre-condition: at least 8 embedded chunks total (we seeded 10)
		const total = Number(runSql('SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL;'));
		expect(total).toBeGreaterThanOrEqual(8);

		const cfg = makeConfig({ topK: 7 });
		expect(cfg.retrieval.top_k).toBe(7);

		const results = await vectorSearch(pool, workingEmbeddingService(), cfg, {
			query: 'something',
			// no `limit` — should fall back to top_k
		});
		expect(results.length).toBe(7);
	});

	// ─── QA-10: ef_search per-query (via configured value) ───
	it.skipIf(!pgAvailable)(
		'QA-10: ef_search is set per query when configured (and searchByVectorWithEfSearch is callable)',
		async () => {
			// (a) Through the high-level API: a query with ef_search=80 succeeds
			const cfg = makeConfig({ efSearch: 80 });
			expect(cfg.retrieval.strategies.vector.ef_search).toBe(80);

			const results = await vectorSearch(pool, workingEmbeddingService(), cfg, {
				query: 'something',
				limit: 5,
			});
			expect(Array.isArray(results)).toBe(true);
			expect(results.length).toBeGreaterThan(0);

			// (b) Direct call to the public repository API
			const queryEmbedding = makeEmbedding(0.85);
			const direct = await searchByVectorWithEfSearch(pool, queryEmbedding, 5, 80);
			expect(Array.isArray(direct)).toBe(true);
			expect(direct.length).toBeGreaterThan(0);
		},
	);

	// ─── QA-11: RetrievalResult shape contract ───
	it.skipIf(!pgAvailable)('QA-11: every RetrievalResult satisfies the documented shape contract', async () => {
		const results = await vectorSearch(pool, workingEmbeddingService(), baseConfig, {
			query: 'something',
			limit: 5,
		});
		expect(results.length).toBeGreaterThan(0);

		const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

		for (const r of results) {
			expect(typeof r.chunkId).toBe('string');
			expect(uuidRe.test(r.chunkId)).toBe(true);
			expect(typeof r.storyId).toBe('string');
			expect(uuidRe.test(r.storyId)).toBe(true);
			expect(typeof r.content).toBe('string');
			expect(typeof r.score).toBe('number');
			expect(r.score).toBeGreaterThanOrEqual(0);
			expect(typeof r.rank).toBe('number');
			expect(Number.isInteger(r.rank)).toBe(true);
			expect(r.rank).toBeGreaterThan(0);
			expect(r.strategy).toBe('vector');
			expect(r.metadata).toBeDefined();
			const md = r.metadata as Record<string, unknown>;
			expect(typeof md.distance).toBe('number');
			expect(typeof md.similarity).toBe('number');
		}

		// Ranks contiguous 1..N
		const ranks = results.map((r) => r.rank);
		expect(ranks).toEqual(Array.from({ length: results.length }, (_, i) => i + 1));
	});

	// ─── QA-12: searchByVectorWithEfSearch exported from @mulder/core ───
	it.skipIf(!pgAvailable)('QA-12: searchByVectorWithEfSearch is exported from @mulder/core and callable', async () => {
		expect(typeof searchByVectorWithEfSearch).toBe('function');

		const queryEmbedding = makeEmbedding(0.85);
		const rows = await searchByVectorWithEfSearch(pool, queryEmbedding, 3, 40);
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeGreaterThan(0);
	});
});
