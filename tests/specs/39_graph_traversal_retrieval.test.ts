import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig, type MulderConfig, mulderConfigSchema, RetrievalError, traverseGraph } from '@mulder/core';
import { graphSearch } from '@mulder/retrieval';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';
const PG_DATABASE = 'mulder';
const PG_HOST = 'localhost';
const PG_PORT = 5432;

/**
 * Black-box QA tests for Spec 39: Graph Traversal Retrieval (M4-E3).
 *
 * System boundary: the public package surface of `@mulder/retrieval`
 * (`graphSearch`) and `@mulder/core` (`traverseGraph`). No internal source
 * files are imported.
 *
 * Each `it()` maps to one QA condition (QA-01..QA-12) from the spec's QA
 * Contract. Section 5b is N/A (no CLI commands).
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
		[
			"DELETE FROM chunks WHERE story_id IN (SELECT id FROM stories WHERE title LIKE 'spec39-%');",
			"DELETE FROM story_entities WHERE story_id IN (SELECT id FROM stories WHERE title LIKE 'spec39-%');",
			"DELETE FROM entity_edges WHERE source_entity_id IN (SELECT id FROM entities WHERE name LIKE 'spec39-%') OR target_entity_id IN (SELECT id FROM entities WHERE name LIKE 'spec39-%');",
			"DELETE FROM entity_aliases WHERE entity_id IN (SELECT id FROM entities WHERE name LIKE 'spec39-%');",
			"DELETE FROM entities WHERE name LIKE 'spec39-%';",
			"DELETE FROM stories WHERE title LIKE 'spec39-%';",
			"DELETE FROM source_steps WHERE source_id IN (SELECT id FROM sources WHERE filename LIKE 'spec39-%');",
			"DELETE FROM sources WHERE filename LIKE 'spec39-%';",
		].join(' '),
	);
}

/** Build a fresh, mutable config from the example file. */
function makeConfig(overrides?: { topK?: number; maxHops?: number; supernodeThreshold?: number }): MulderConfig {
	const base = loadConfig(EXAMPLE_CONFIG);
	// Deep clone to break deepFreeze
	const cloned = JSON.parse(JSON.stringify(base)) as MulderConfig;
	if (overrides?.topK !== undefined) {
		cloned.retrieval.top_k = overrides.topK;
	}
	if (overrides?.maxHops !== undefined) {
		cloned.retrieval.strategies.graph.max_hops = overrides.maxHops;
	}
	if (overrides?.supernodeThreshold !== undefined) {
		cloned.retrieval.strategies.graph.supernode_threshold = overrides.supernodeThreshold;
	}
	// Re-parse to apply schema defaults / validation
	return mulderConfigSchema.parse(cloned);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface SeededData {
	sourceId: string;
	/** Story S1 — connected to entity B */
	storyS1: string;
	/** Story S2 — connected to entity C (for storyIds filter test) */
	storyS2: string;
	/** Story S3 — connected to entity D (2-hop away) */
	storyS3: string;
	/** Entity A — seed entity */
	entityA: string;
	/** Entity B — RELATIONSHIP from A, appears in S1 */
	entityB: string;
	/** Entity C — RELATIONSHIP from A, appears in S2 */
	entityC: string;
	/** Entity D — RELATIONSHIP from B, appears in S3 (2 hops from A) */
	entityD: string;
	/** Entity E — DUPLICATE_OF from A (non-RELATIONSHIP edge) */
	entityE: string;
	/** Entity F — POTENTIAL_CONTRADICTION from A (non-RELATIONSHIP edge) */
	entityF: string;
	/** Entity supernode — high source_count, RELATIONSHIP from A */
	entitySupernode: string;
	/** Chunk IDs in S1 */
	chunksS1: string[];
	/** Chunk IDs in S2 */
	chunksS2: string[];
	/** Chunk IDs in S3 */
	chunksS3: string[];
	/** Story for entity E (DUPLICATE_OF) */
	storySE: string;
	/** Story for entity F (POTENTIAL_CONTRADICTION) */
	storySF: string;
	/** Chunks in storySE */
	chunksSE: string[];
	/** Chunks in storySF */
	chunksSF: string[];
}

async function seedFixture(): Promise<SeededData> {
	// Source
	const sourceId = runSqlReturning(
		`INSERT INTO sources (filename, storage_path, file_hash, status)
		 VALUES ('spec39-source.pdf', 'gs://test/spec39.pdf', 'spec39-hash', 'ingested')
		 RETURNING id;`,
	);

	// Stories
	const storyS1 = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceId}', 'spec39-story-s1', 'gs://test/s1.md', 'gs://test/s1.json', 'embedded')
		 RETURNING id;`,
	);
	const storyS2 = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceId}', 'spec39-story-s2', 'gs://test/s2.md', 'gs://test/s2.json', 'embedded')
		 RETURNING id;`,
	);
	const storyS3 = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceId}', 'spec39-story-s3', 'gs://test/s3.md', 'gs://test/s3.json', 'embedded')
		 RETURNING id;`,
	);
	const storySE = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceId}', 'spec39-story-se', 'gs://test/se.md', 'gs://test/se.json', 'embedded')
		 RETURNING id;`,
	);
	const storySF = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceId}', 'spec39-story-sf', 'gs://test/sf.md', 'gs://test/sf.json', 'embedded')
		 RETURNING id;`,
	);

	// Entities
	const entityA = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-entity-a', 'person', 3)
		 RETURNING id;`,
	);
	const entityB = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-entity-b', 'person', 2)
		 RETURNING id;`,
	);
	const entityC = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-entity-c', 'location', 2)
		 RETURNING id;`,
	);
	const entityD = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-entity-d', 'event', 1)
		 RETURNING id;`,
	);
	const entityE = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-entity-e', 'person', 1)
		 RETURNING id;`,
	);
	const entityF = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-entity-f', 'person', 1)
		 RETURNING id;`,
	);
	const entitySupernode = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-entity-supernode', 'organization', 200)
		 RETURNING id;`,
	);

	// Entity edges
	// A → B: RELATIONSHIP (confidence 0.9)
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityA}', '${entityB}', 'knows', 'RELATIONSHIP', 0.9, '${storyS1}');`,
	);
	// A → C: RELATIONSHIP (confidence 0.8)
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityA}', '${entityC}', 'visited', 'RELATIONSHIP', 0.8, '${storyS2}');`,
	);
	// B → D: RELATIONSHIP (confidence 0.8) — 2 hops from A
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityB}', '${entityD}', 'attended', 'RELATIONSHIP', 0.8, '${storyS3}');`,
	);
	// A → E: DUPLICATE_OF (should NOT be traversed)
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityA}', '${entityE}', 'duplicate', 'DUPLICATE_OF', 0.95, '${storySE}');`,
	);
	// A → F: POTENTIAL_CONTRADICTION (should NOT be traversed)
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityA}', '${entityF}', 'contradicts', 'POTENTIAL_CONTRADICTION', 0.7, '${storySF}');`,
	);
	// A → supernode: RELATIONSHIP (should be pruned by supernode threshold)
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityA}', '${entitySupernode}', 'works_for', 'RELATIONSHIP', 0.85, '${storyS1}');`,
	);

	// Story-entity links
	runSql(
		`INSERT INTO story_entities (story_id, entity_id, confidence) VALUES
		 ('${storyS1}', '${entityB}', 0.95),
		 ('${storyS2}', '${entityC}', 0.90),
		 ('${storyS3}', '${entityD}', 0.85),
		 ('${storySE}', '${entityE}', 0.90),
		 ('${storySF}', '${entityF}', 0.90);`,
	);

	// Chunks
	const chunksS1: string[] = [];
	for (let i = 0; i < 3; i++) {
		const id = runSqlReturning(
			`INSERT INTO chunks (story_id, content, chunk_index, is_question)
			 VALUES ('${storyS1}', 'spec39 story-s1 chunk ${i} about entity B', ${i}, FALSE)
			 RETURNING id;`,
		);
		chunksS1.push(id);
	}

	const chunksS2: string[] = [];
	for (let i = 0; i < 3; i++) {
		const id = runSqlReturning(
			`INSERT INTO chunks (story_id, content, chunk_index, is_question)
			 VALUES ('${storyS2}', 'spec39 story-s2 chunk ${i} about entity C', ${i}, FALSE)
			 RETURNING id;`,
		);
		chunksS2.push(id);
	}

	const chunksS3: string[] = [];
	for (let i = 0; i < 3; i++) {
		const id = runSqlReturning(
			`INSERT INTO chunks (story_id, content, chunk_index, is_question)
			 VALUES ('${storyS3}', 'spec39 story-s3 chunk ${i} about entity D', ${i}, FALSE)
			 RETURNING id;`,
		);
		chunksS3.push(id);
	}

	const chunksSE: string[] = [];
	for (let i = 0; i < 2; i++) {
		const id = runSqlReturning(
			`INSERT INTO chunks (story_id, content, chunk_index, is_question)
			 VALUES ('${storySE}', 'spec39 story-se chunk ${i} about entity E duplicate', ${i}, FALSE)
			 RETURNING id;`,
		);
		chunksSE.push(id);
	}

	const chunksSF: string[] = [];
	for (let i = 0; i < 2; i++) {
		const id = runSqlReturning(
			`INSERT INTO chunks (story_id, content, chunk_index, is_question)
			 VALUES ('${storySF}', 'spec39 story-sf chunk ${i} about entity F contradiction', ${i}, FALSE)
			 RETURNING id;`,
		);
		chunksSF.push(id);
	}

	return {
		sourceId,
		storyS1,
		storyS2,
		storyS3,
		entityA,
		entityB,
		entityC,
		entityD,
		entityE,
		entityF,
		entitySupernode,
		chunksS1,
		chunksS2,
		chunksS3,
		storySE,
		storySF,
		chunksSE,
		chunksSF,
	};
}

// ---------------------------------------------------------------------------
// Cycle fixture: A → B → C → A
// ---------------------------------------------------------------------------

interface CycleData {
	sourceId: string;
	storyCA: string;
	storyCB: string;
	storyCC: string;
	entityCA: string;
	entityCB: string;
	entityCC: string;
	chunksCA: string[];
	chunksCB: string[];
	chunksCC: string[];
}

async function seedCycleFixture(): Promise<CycleData> {
	const sourceId = runSqlReturning(
		`INSERT INTO sources (filename, storage_path, file_hash, status)
		 VALUES ('spec39-cycle-source.pdf', 'gs://test/spec39-cycle.pdf', 'spec39-cycle-hash', 'ingested')
		 RETURNING id;`,
	);

	const storyCA = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceId}', 'spec39-cycle-story-a', 'gs://test/ca.md', 'gs://test/ca.json', 'embedded')
		 RETURNING id;`,
	);
	const storyCB = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceId}', 'spec39-cycle-story-b', 'gs://test/cb.md', 'gs://test/cb.json', 'embedded')
		 RETURNING id;`,
	);
	const storyCC = runSqlReturning(
		`INSERT INTO stories (source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${sourceId}', 'spec39-cycle-story-c', 'gs://test/cc.md', 'gs://test/cc.json', 'embedded')
		 RETURNING id;`,
	);

	const entityCA = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-cycle-a', 'person', 1)
		 RETURNING id;`,
	);
	const entityCB = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-cycle-b', 'person', 1)
		 RETURNING id;`,
	);
	const entityCC = runSqlReturning(
		`INSERT INTO entities (name, type, source_count)
		 VALUES ('spec39-cycle-c', 'person', 1)
		 RETURNING id;`,
	);

	// Cycle: A → B → C → A
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityCA}', '${entityCB}', 'knows', 'RELATIONSHIP', 0.9, '${storyCA}');`,
	);
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityCB}', '${entityCC}', 'knows', 'RELATIONSHIP', 0.85, '${storyCB}');`,
	);
	runSql(
		`INSERT INTO entity_edges (source_entity_id, target_entity_id, relationship, edge_type, confidence, story_id)
		 VALUES ('${entityCC}', '${entityCA}', 'knows', 'RELATIONSHIP', 0.8, '${storyCC}');`,
	);

	// Story-entity links
	runSql(
		`INSERT INTO story_entities (story_id, entity_id, confidence) VALUES
		 ('${storyCA}', '${entityCA}', 0.9),
		 ('${storyCB}', '${entityCB}', 0.9),
		 ('${storyCC}', '${entityCC}', 0.9);`,
	);

	// Chunks
	const chunksCA: string[] = [];
	const id1 = runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question)
		 VALUES ('${storyCA}', 'spec39 cycle story-a chunk about entity cycle-a', 0, FALSE)
		 RETURNING id;`,
	);
	chunksCA.push(id1);

	const chunksCB: string[] = [];
	const id2 = runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question)
		 VALUES ('${storyCB}', 'spec39 cycle story-b chunk about entity cycle-b', 0, FALSE)
		 RETURNING id;`,
	);
	chunksCB.push(id2);

	const chunksCC: string[] = [];
	const id3 = runSqlReturning(
		`INSERT INTO chunks (story_id, content, chunk_index, is_question)
		 VALUES ('${storyCC}', 'spec39 cycle story-c chunk about entity cycle-c', 0, FALSE)
		 RETURNING id;`,
	);
	chunksCC.push(id3);

	return {
		sourceId,
		storyCA,
		storyCB,
		storyCC,
		entityCA,
		entityCB,
		entityCC,
		chunksCA,
		chunksCB,
		chunksCC,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 39 — Graph Traversal Retrieval', () => {
	const pgAvailable = isPgAvailable();
	let pool: pg.Pool;
	let seed: SeededData;
	let cycleSeed: CycleData;
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

		cleanTestData();
		seed = await seedFixture();
		cycleSeed = await seedCycleFixture();
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

	// ─── QA-01: Empty seed returns RetrievalError ───
	it.skipIf(!pgAvailable)(
		'QA-01: empty entityIds array throws RetrievalError with RETRIEVAL_INVALID_INPUT',
		async () => {
			await expect(graphSearch(pool, baseConfig, { entityIds: [] })).rejects.toMatchObject({
				name: 'RetrievalError',
				code: 'RETRIEVAL_INVALID_INPUT',
			});
		},
	);

	// ─── QA-02: Seed entities with no edges return empty results ───
	it.skipIf(!pgAvailable)('QA-02: seed entities with no outgoing RELATIONSHIP edges return []', async () => {
		// Entity A has edges but D has no outgoing RELATIONSHIP edges
		// Create a lonely entity with no edges at all
		const lonelyId = runSqlReturning(
			`INSERT INTO entities (name, type, source_count)
				 VALUES ('spec39-lonely', 'person', 1)
				 RETURNING id;`,
		);

		const results = await graphSearch(pool, baseConfig, {
			entityIds: [lonelyId],
		});

		expect(Array.isArray(results)).toBe(true);
		expect(results).toEqual([]);

		// Cleanup
		runSql(`DELETE FROM entities WHERE id = '${lonelyId}';`);
	});

	// ─── QA-03: Single-hop traversal returns connected chunks ───
	it.skipIf(!pgAvailable)('QA-03: single-hop traversal returns connected chunks with strategy graph', async () => {
		const results = await graphSearch(pool, baseConfig, {
			entityIds: [seed.entityA],
			maxHops: 1,
			limit: 50,
		});

		expect(Array.isArray(results)).toBe(true);
		expect(results.length).toBeGreaterThan(0);

		// Results should contain chunks from stories connected to B and C (1 hop from A)
		const storyIds = new Set(results.map((r) => r.storyId));
		expect(storyIds.has(seed.storyS1)).toBe(true); // B's story
		expect(storyIds.has(seed.storyS2)).toBe(true); // C's story

		for (const r of results) {
			expect(r.strategy).toBe('graph');
			expect(r.score).toBeGreaterThan(0);
		}
	});

	// ─── QA-04: Cycle detection prevents infinite loops ───
	it.skipIf(!pgAvailable)('QA-04: cycle detection prevents infinite loops (A → B → C → A)', async () => {
		// Run with high maxHops — should complete without hanging
		const results = await graphSearch(pool, baseConfig, {
			entityIds: [cycleSeed.entityCA],
			maxHops: 10,
			limit: 50,
		});

		expect(Array.isArray(results)).toBe(true);
		// Should have results but no duplicates
		const chunkIds = results.map((r) => r.chunkId);
		const uniqueChunkIds = new Set(chunkIds);
		expect(chunkIds.length).toBe(uniqueChunkIds.size);
	});

	// ─── QA-05: Supernode pruning excludes high-degree entities ───
	it.skipIf(!pgAvailable)(
		'QA-05: supernode pruning excludes entities with source_count >= supernodeThreshold',
		async () => {
			// Supernode entity has source_count=200. Set threshold to 5
			const results = await graphSearch(pool, baseConfig, {
				entityIds: [seed.entityA],
				maxHops: 1,
				supernodeThreshold: 5,
				limit: 50,
			});

			// Supernode should be excluded — no chunks from its stories should appear
			// that are ONLY reachable via the supernode path
			// B and C have source_count=2, so they should still be included
			const storyIds = new Set(results.map((r) => r.storyId));
			expect(storyIds.has(seed.storyS1)).toBe(true); // B's story (source_count=2)
			expect(storyIds.has(seed.storyS2)).toBe(true); // C's story (source_count=2)

			// The supernode entity (source_count=200) should NOT have yielded extra results.
			// We verify by checking metadata: no result should reference the supernode entity.
			for (const r of results) {
				const md = r.metadata as Record<string, unknown>;
				if (md.entityId) {
					expect(md.entityId).not.toBe(seed.entitySupernode);
				}
			}
		},
	);

	// ─── QA-06: Max hops limits traversal depth ───
	it.skipIf(!pgAvailable)('QA-06: maxHops=1 returns B chunks but NOT C/D (2-hop) chunks', async () => {
		const results = await graphSearch(pool, baseConfig, {
			entityIds: [seed.entityA],
			maxHops: 1,
			limit: 50,
		});

		const storyIds = new Set(results.map((r) => r.storyId));
		// B is 1-hop from A → S1 should be present
		expect(storyIds.has(seed.storyS1)).toBe(true);
		// D is 2-hops from A (A → B → D) → S3 should NOT be present
		expect(storyIds.has(seed.storyS3)).toBe(false);
	});

	// ─── QA-07: Results are RetrievalResult shaped ───
	it.skipIf(!pgAvailable)('QA-07: every result satisfies the RetrievalResult shape contract', async () => {
		const results = await graphSearch(pool, baseConfig, {
			entityIds: [seed.entityA],
			maxHops: 2,
			limit: 50,
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
			expect(r.rank).toBeGreaterThanOrEqual(1);
			expect(r.strategy).toBe('graph');
			expect(r.metadata).toBeDefined();

			const md = r.metadata as Record<string, unknown>;
			expect(typeof md.depth).toBe('number');
			expect(typeof md.entityId).toBe('string');
		}

		// Ranks contiguous 1..N
		const ranks = results.map((r) => r.rank);
		expect(ranks).toEqual(Array.from({ length: results.length }, (_, i) => i + 1));
	});

	// ─── QA-08: Config defaults are applied ───
	it.skipIf(!pgAvailable)('QA-08: config defaults are applied (max_hops, top_k, supernode_threshold)', async () => {
		const cfg = makeConfig({ maxHops: 2, topK: 10, supernodeThreshold: 100 });
		expect(cfg.retrieval.strategies.graph.max_hops).toBe(2);
		expect(cfg.retrieval.top_k).toBe(10);
		expect(cfg.retrieval.strategies.graph.supernode_threshold).toBe(100);

		// Call without explicit overrides — should use config defaults
		const results = await graphSearch(pool, cfg, {
			entityIds: [seed.entityA],
		});

		expect(Array.isArray(results)).toBe(true);
		// With maxHops=2, we should reach D (2 hops away)
		const storyIds = new Set(results.map((r) => r.storyId));
		expect(storyIds.has(seed.storyS3)).toBe(true); // D is 2 hops from A

		// Results should be limited by top_k (10)
		expect(results.length).toBeLessThanOrEqual(10);
	});

	// ─── QA-09: storyIds filter limits results ───
	it.skipIf(!pgAvailable)('QA-09: storyIds filter restricts results to specified stories only', async () => {
		const results = await graphSearch(pool, baseConfig, {
			entityIds: [seed.entityA],
			maxHops: 2,
			storyIds: [seed.storyS1],
			limit: 50,
		});

		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.storyId).toBe(seed.storyS1);
		}

		// Specifically should NOT contain S2's or S3's chunks
		const storyIds = new Set(results.map((r) => r.storyId));
		expect(storyIds.has(seed.storyS2)).toBe(false);
		expect(storyIds.has(seed.storyS3)).toBe(false);
	});

	// ─── QA-10: Only RELATIONSHIP edges are traversed ───
	it.skipIf(!pgAvailable)(
		'QA-10: only RELATIONSHIP edges are traversed, not DUPLICATE_OF or POTENTIAL_CONTRADICTION',
		async () => {
			const results = await graphSearch(pool, baseConfig, {
				entityIds: [seed.entityA],
				maxHops: 1,
				limit: 50,
			});

			const allChunkIds = new Set(results.map((r) => r.chunkId));
			const allStoryIds = new Set(results.map((r) => r.storyId));

			// B is reachable via RELATIONSHIP → chunks from S1 should be present
			expect(allStoryIds.has(seed.storyS1)).toBe(true);

			// E is connected via DUPLICATE_OF → chunks from storySE should NOT be present
			for (const chunkId of seed.chunksSE) {
				expect(allChunkIds.has(chunkId)).toBe(false);
			}
			expect(allStoryIds.has(seed.storySE)).toBe(false);

			// F is connected via POTENTIAL_CONTRADICTION → chunks from storySF should NOT be present
			for (const chunkId of seed.chunksSF) {
				expect(allChunkIds.has(chunkId)).toBe(false);
			}
			expect(allStoryIds.has(seed.storySF)).toBe(false);
		},
	);

	// ─── QA-11: Path confidence decays with depth ───
	it.skipIf(!pgAvailable)('QA-11: path confidence decays with depth (deeper = lower score)', async () => {
		// A → B (confidence 0.9) → D (confidence 0.8)
		// B's path_confidence should be 0.9
		// D's path_confidence should be 0.9 * 0.8 = 0.72

		const results = await graphSearch(pool, baseConfig, {
			entityIds: [seed.entityA],
			maxHops: 2,
			limit: 50,
		});

		expect(results.length).toBeGreaterThan(0);

		// Find chunks from S1 (B, depth 1) and S3 (D, depth 2)
		const s1Chunks = results.filter((r) => r.storyId === seed.storyS1);
		const s3Chunks = results.filter((r) => r.storyId === seed.storyS3);

		expect(s1Chunks.length).toBeGreaterThan(0);
		expect(s3Chunks.length).toBeGreaterThan(0);

		// All S1 scores (depth 1) should be > all S3 scores (depth 2)
		const minS1Score = Math.min(...s1Chunks.map((r) => r.score));
		const maxS3Score = Math.max(...s3Chunks.map((r) => r.score));
		expect(minS1Score).toBeGreaterThan(maxS3Score);
	});

	// ─── QA-12: DB error wrapped in RetrievalError ───
	it.skipIf(!pgAvailable)('QA-12: database error wrapped in RetrievalError with RETRIEVAL_QUERY_FAILED', async () => {
		// Create a pool pointing to a non-existent database
		const badPool = new pg.Pool({
			host: PG_HOST,
			port: PG_PORT,
			user: PG_USER,
			password: PG_PASSWORD,
			database: 'spec39_nonexistent_db',
		});

		try {
			await expect(
				graphSearch(badPool, baseConfig, {
					entityIds: [seed.entityA],
				}),
			).rejects.toMatchObject({
				name: 'RetrievalError',
				code: 'RETRIEVAL_QUERY_FAILED',
			});
		} finally {
			await badPool.end();
		}
	});

	// ─── Extra: traverseGraph is exported and callable from @mulder/core ───
	it.skipIf(!pgAvailable)('traverseGraph is exported from @mulder/core and callable directly', async () => {
		expect(typeof traverseGraph).toBe('function');

		const results = await traverseGraph(
			pool,
			[seed.entityA],
			1, // maxHops
			50, // limit
			100, // supernodeThreshold
		);

		expect(Array.isArray(results)).toBe(true);
		expect(results.length).toBeGreaterThan(0);

		// Each result should have the GraphTraversalResult shape
		for (const r of results) {
			expect(typeof r.chunk.id).toBe('string');
			expect(typeof r.chunk.storyId).toBe('string');
			expect(typeof r.chunk.content).toBe('string');
			expect(typeof r.entityId).toBe('string');
			expect(typeof r.entityName).toBe('string');
			expect(typeof r.entityType).toBe('string');
			expect(typeof r.depth).toBe('number');
			expect(typeof r.pathConfidence).toBe('number');
		}
	});

	// ─── Extra: RetrievalError is a real instance ───
	it.skipIf(!pgAvailable)('RetrievalError is a real instance (instanceof check)', async () => {
		let caught: unknown;
		try {
			await graphSearch(pool, baseConfig, { entityIds: [] });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(RetrievalError);
	});
});
