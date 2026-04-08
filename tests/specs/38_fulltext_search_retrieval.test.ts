import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig, type MulderConfig, mulderConfigSchema, RetrievalError, searchByFts } from '@mulder/core';
import { fulltextSearch } from '@mulder/retrieval';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';
const PG_DATABASE = 'mulder';
const PG_HOST = 'localhost';
const PG_PORT = 5432;

/**
 * Black-box QA tests for Spec 38: Full-Text Search Retrieval (M4-E2).
 *
 * System boundary: the public package surface of `@mulder/retrieval` and
 * `@mulder/core`. No internal source files are imported.
 *
 * Each `it()` maps to one QA condition (QA-01..QA-12) from the spec's QA
 * Contract. Section 5b is N/A (library-only).
 *
 * Requires:
 * - Running PostgreSQL container `mulder-pg-test` with migrations applied
 * - Built dist artifacts for `@mulder/core` and `@mulder/retrieval`
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPgAvailable(): boolean {
	try {
		const result = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', PG_USER], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function runSql(sql: string): string {
	const result = spawnSync(
		'docker',
		['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DATABASE, '-t', '-A', '-c', sql],
		{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
	);
	if (result.status !== 0) {
		throw new Error(`psql failed (exit ${result.status}): ${result.stderr}`);
	}
	return (result.stdout ?? '').trim();
}

function runSqlReturning(sql: string): string {
	const out = runSql(sql);
	const firstLine = out.split('\n')[0];
	return firstLine.trim();
}

function cleanTestData(): void {
	runSql(
		"DELETE FROM chunks WHERE content LIKE 'spec38-%'; DELETE FROM stories WHERE title LIKE 'spec38-%'; DELETE FROM source_steps WHERE source_id IN (SELECT id FROM sources WHERE filename LIKE 'spec38-%'); DELETE FROM sources WHERE filename LIKE 'spec38-%';",
	);
}

/** Build a fresh, mutable config from the example file. */
function makeConfig(overrides?: { topK?: number }): MulderConfig {
	const base = loadConfig(EXAMPLE_CONFIG);
	// Deep clone to break deepFreeze
	const cloned = JSON.parse(JSON.stringify(base)) as MulderConfig;
	if (overrides?.topK !== undefined) {
		cloned.retrieval.top_k = overrides.topK;
	}
	// Re-parse to apply schema defaults / validation
	return mulderConfigSchema.parse(cloned);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface SeededData {
	sourceA: string;
	sourceB: string;
	storyA: string;
	storyB: string;
	/** Content chunk in storyA containing the word "Phoenix" */
	contentChunkA: string;
	/** Question chunk in storyA referencing contentChunkA, containing "Phoenix" */
	questionChunkA: string;
	/** Content chunk in storyB containing the word "phoenix" */
	contentChunkB: string;
	/** Question chunk in storyB referencing contentChunkB, containing "phoenix" */
	questionChunkB: string;
}

async function seedFixture(): Promise<SeededData> {
	// Two sources
	const sourceA = runSqlReturning(
		`INSERT INTO sources (filename, storage_path, file_hash, status)
		 VALUES ('spec38-source-a.pdf', 'gs://test/spec38-a.pdf', 'spec38-hash-a', 'ingested')
		 RETURNING id;`,
	);
	const sourceB = runSqlReturning(
		`INSERT INTO sources (filename, storage_path, file_hash, status)
		 VALUES ('spec38-source-b.pdf', 'gs://test/spec38-b.pdf', 'spec38-hash-b', 'ingested')
		 RETURNING id;`,
	);

	// Two stories (one per source)
	const storyA = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceA}', 'spec38-story-a', 'gs://test/a.md', 'gs://test/a.json', 'embedded')
		 RETURNING id;`,
	);
	const storyB = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceB}', 'spec38-story-b', 'gs://test/b.md', 'gs://test/b.json', 'embedded')
		 RETURNING id;`,
	);

	// --- Story A seed chunks ---
	// Content chunk 0 with "Phoenix"
	const contentChunkA = runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question)
		 VALUES ('${storyA}',
		         'spec38-a0 The Phoenix lights case remains one of the most studied events in Arizona history.',
		         0, FALSE)
		 RETURNING id;`,
	);
	// Content chunk 1 also with "Phoenix" (for more than-one-content-match tests)
	runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question)
		 VALUES ('${storyA}',
		         'spec38-a1 Phoenix witnesses reported bright lights over the desert.',
		         1, FALSE)
		 RETURNING id;`,
	);
	// Content chunk 2 with NO keyword match (noise)
	runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question)
		 VALUES ('${storyA}',
		         'spec38-a2 Unrelated local weather report from the same day.',
		         2, FALSE)
		 RETURNING id;`,
	);
	// Question chunk referencing contentChunkA, containing "Phoenix"
	const questionChunkA = runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question, parent_chunk_id)
		 VALUES ('${storyA}',
		         'spec38-aq What happened during the Phoenix lights incident?',
		         3, TRUE, '${contentChunkA}')
		 RETURNING id;`,
	);

	// --- Story B seed chunks ---
	// Content chunk with "phoenix" (lowercase)
	const contentChunkB = runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question)
		 VALUES ('${storyB}',
		         'spec38-b0 The phoenix case drew international attention after the arizona sighting.',
		         0, FALSE)
		 RETURNING id;`,
	);
	// Content chunk 1 unrelated
	runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question)
		 VALUES ('${storyB}',
		         'spec38-b1 Local diner menu updates for summer season.',
		         1, FALSE)
		 RETURNING id;`,
	);
	// Question chunk referencing contentChunkB, containing "phoenix"
	const questionChunkB = runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question, parent_chunk_id)
		 VALUES ('${storyB}',
		         'spec38-bq Why was the phoenix sighting so significant?',
		         2, TRUE, '${contentChunkB}')
		 RETURNING id;`,
	);

	// Extra content chunks containing the word "test" for QA-08 (need > 7)
	for (let i = 0; i < 10; i++) {
		runSqlReturning(
			`INSERT INTO chunks (story_id, content, chunk_index, is_question)
			 VALUES ('${storyA}',
			         'spec38-t${i} test test content test body number ${i}',
			         ${10 + i}, FALSE)
			 RETURNING id;`,
		);
	}

	return {
		sourceA,
		sourceB,
		storyA,
		storyB,
		contentChunkA,
		questionChunkA,
		contentChunkB,
		questionChunkB,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 38 — Full-Text Search Retrieval', () => {
	const pgAvailable = isPgAvailable();
	let pool: pg.Pool;
	let seed: SeededData;
	let baseConfig: MulderConfig;

	beforeAll(async () => {
		if (!pgAvailable) {
			console.warn(
				'SKIP: PostgreSQL container not available. Start with:\n' +
					'  docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17',
			);
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

	// ─── QA-01: FTS returns ranked chunks for matching query ───
	it.skipIf(!pgAvailable)('QA-01: FTS returns ranked chunks for matching query', async () => {
		const results = await fulltextSearch(pool, baseConfig, {
			query: 'Phoenix',
			limit: 5,
		});

		expect(Array.isArray(results)).toBe(true);
		expect(results.length).toBeGreaterThan(0);
		expect(results.length).toBeLessThanOrEqual(5);

		for (const r of results) {
			expect(r.strategy).toBe('fulltext');
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

	// ─── QA-02: Story-id filter restricts results ───
	it.skipIf(!pgAvailable)('QA-02: storyIds filter restricts results to that story', async () => {
		const results = await fulltextSearch(pool, baseConfig, {
			query: 'phoenix',
			storyIds: [seed.storyA],
			limit: 20,
		});

		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.storyId).toBe(seed.storyA);
		}
	});

	// ─── QA-03: Whitespace-only query rejected ───
	it.skipIf(!pgAvailable)('QA-03: whitespace-only query throws RETRIEVAL_INVALID_INPUT', async () => {
		await expect(fulltextSearch(pool, baseConfig, { query: '   ' })).rejects.toMatchObject({
			name: 'RetrievalError',
			code: 'RETRIEVAL_INVALID_INPUT',
		});
	});

	// ─── QA-04: Empty-string query rejected ───
	it.skipIf(!pgAvailable)('QA-04: empty-string query throws RETRIEVAL_INVALID_INPUT', async () => {
		await expect(fulltextSearch(pool, baseConfig, { query: '' })).rejects.toMatchObject({
			name: 'RetrievalError',
			code: 'RETRIEVAL_INVALID_INPUT',
		});
	});

	// ─── QA-05: Question chunks excluded by default ───
	it.skipIf(!pgAvailable)('QA-05: question chunks excluded by default', async () => {
		const results = await fulltextSearch(pool, baseConfig, {
			query: 'Phoenix',
			limit: 50,
		});

		expect(results.length).toBeGreaterThan(0);
		// Zero results from either question chunk
		const resultIds = results.map((r) => r.chunkId);
		expect(resultIds).not.toContain(seed.questionChunkA);
		expect(resultIds).not.toContain(seed.questionChunkB);

		// No result has metadata.isQuestion === true
		for (const r of results) {
			const md = r.metadata as Record<string, unknown>;
			expect(md.isQuestion).toBe(false);
		}
	});

	// ─── QA-06: includeQuestions: true returns question chunks ───
	it.skipIf(!pgAvailable)('QA-06: includeQuestions: true returns question chunks', async () => {
		const results = await fulltextSearch(pool, baseConfig, {
			query: 'Phoenix',
			includeQuestions: true,
			limit: 50,
		});

		expect(results.length).toBeGreaterThan(0);
		const resultIds = results.map((r) => r.chunkId);
		// Both content and question chunks from both stories should be findable
		expect(resultIds).toContain(seed.contentChunkA);
		expect(resultIds).toContain(seed.questionChunkA);

		// At least one result has metadata.isQuestion === true
		const hasQuestion = results.some((r) => {
			const md = r.metadata as Record<string, unknown>;
			return md.isQuestion === true;
		});
		expect(hasQuestion).toBe(true);
	});

	// ─── QA-07: Empty result set returns [] ───
	it.skipIf(!pgAvailable)('QA-07: non-matching query returns [] (no error)', async () => {
		const results = await fulltextSearch(pool, baseConfig, {
			query: 'zzzzzzzz_no_match_xxxxxxx',
		});
		expect(Array.isArray(results)).toBe(true);
		expect(results).toEqual([]);
	});

	// ─── QA-08: Default limit respects retrieval.top_k config ───
	it.skipIf(!pgAvailable)('QA-08: default limit equals retrieval.top_k from config', async () => {
		const cfg = makeConfig({ topK: 7 });
		expect(cfg.retrieval.top_k).toBe(7);

		// Default limit: should be <= 7 (we seeded 10 content chunks all matching "test")
		const defaultResults = await fulltextSearch(pool, cfg, {
			query: 'test',
		});
		expect(defaultResults.length).toBeLessThanOrEqual(7);

		// Explicit limit: more than 7
		const explicitResults = await fulltextSearch(pool, cfg, {
			query: 'test',
			limit: 100,
		});
		expect(explicitResults.length).toBeGreaterThan(7);
	});

	// ─── QA-09: RetrievalResult shape contract ───
	it.skipIf(!pgAvailable)('QA-09: every RetrievalResult satisfies the documented shape contract', async () => {
		const results = await fulltextSearch(pool, baseConfig, {
			query: 'Phoenix',
			limit: 10,
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
			expect(r.strategy).toBe('fulltext');
			expect(r.metadata).toBeDefined();
			const md = r.metadata as Record<string, unknown>;
			expect(typeof md.tsRank).toBe('number');
			expect(typeof md.isQuestion).toBe('boolean');
		}

		// Ranks contiguous 1..N
		const ranks = results.map((r) => r.rank);
		expect(ranks).toEqual(Array.from({ length: results.length }, (_, i) => i + 1));
	});

	// ─── QA-10: Repository helper backwards-compatible (legacy 3-arg form) ───
	it.skipIf(!pgAvailable)('QA-10: searchByFts legacy 3-arg form returns chunks regardless of is_question', async () => {
		// Legacy signature — no filter argument
		const rows = await searchByFts(pool, 'phoenix', 50);
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeGreaterThan(0);

		// Must contain at least one content chunk AND at least one question chunk
		const hasContent = rows.some((r) => r.chunk.isQuestion === false);
		const hasQuestion = rows.some((r) => r.chunk.isQuestion === true);
		expect(hasContent).toBe(true);
		expect(hasQuestion).toBe(true);
	});

	// ─── QA-11: Repository helper honors new filter (excludeQuestions: true) ───
	it.skipIf(!pgAvailable)('QA-11: searchByFts with excludeQuestions: true returns only content chunks', async () => {
		const rows = await searchByFts(pool, 'phoenix', 50, { excludeQuestions: true });
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.chunk.isQuestion).toBe(false);
		}
	});

	// ─── QA-12: storyIds filter and excludeQuestions combine ───
	it.skipIf(!pgAvailable)(
		'QA-12: storyIds + default excludeQuestions restricts results to one story of content chunks',
		async () => {
			const results = await fulltextSearch(pool, baseConfig, {
				query: 'phoenix',
				storyIds: [seed.storyA],
				limit: 50,
			});

			expect(results.length).toBeGreaterThan(0);
			for (const r of results) {
				expect(r.storyId).toBe(seed.storyA);
				const md = r.metadata as Record<string, unknown>;
				expect(md.isQuestion).toBe(false);
			}

			// Neither story-B content nor any question chunk appears
			const resultIds = results.map((r) => r.chunkId);
			expect(resultIds).not.toContain(seed.contentChunkB);
			expect(resultIds).not.toContain(seed.questionChunkA);
			expect(resultIds).not.toContain(seed.questionChunkB);
		},
	);

	// Ensure the thrown error is truly a RetrievalError instance (not just a shape match).
	it.skipIf(!pgAvailable)('RetrievalError is a real instance (instanceof check)', async () => {
		let caught: unknown;
		try {
			await fulltextSearch(pool, baseConfig, { query: '' });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(RetrievalError);
	});
});
