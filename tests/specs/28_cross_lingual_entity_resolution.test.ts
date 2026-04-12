import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');
const ENRICH_MODULE = resolve(ROOT, 'packages/pipeline/dist/enrich/index.js');

/**
 * Black-box QA tests for Spec 28: Cross-Lingual Entity Resolution -- 3-tier
 *
 * Each `it()` maps to one QA-NN condition from Section 5 of the spec.
 * Section 5b (CLI Test Matrix) is N/A -- no CLI surface for this step.
 *
 * Tests interact through system boundaries:
 * - Direct SQL via pg (setup + verification)
 * - Exported functions from @mulder/core (entity + alias repositories)
 * - Exported function resolveEntity from @mulder/pipeline (resolution module)
 * - Service registry from @mulder/core (dev mode fixture-based services)
 *
 * Requires a running PostgreSQL instance with pgvector, pg_trgm, PostGIS extensions
 * and migrations through 017 (entity_name_embedding).
 */

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

let pool: pg.Pool;

// Dynamically imported modules
let createEntity: (...args: unknown[]) => Promise<unknown>;
let findEntityById: (...args: unknown[]) => Promise<unknown>;
let updateEntityEmbedding: (...args: unknown[]) => Promise<unknown>;
let findAliasesByEntityId: (...args: unknown[]) => Promise<unknown>;
let resolveEntity: (options: unknown) => Promise<unknown>;
let loadConfig: (...args: unknown[]) => Promise<unknown>;
let createServiceRegistry: (...args: unknown[]) => unknown;
let createLogger: (...args: unknown[]) => unknown;

// Services and config
let services: Record<string, unknown>;
let config: Record<string, unknown>;

/**
 * Generate a deterministic 768-dim unit vector seeded by a numeric key.
 * Different keys produce vectors with controlled cosine similarity.
 */
function makeVector(seed: number, dim = 768): number[] {
	const v = new Array(dim).fill(0);
	// Place most of the magnitude in a few seed-dependent dimensions
	// so similarity between vectors can be controlled.
	v[seed % dim] = 1.0;
	v[(seed + 1) % dim] = 0.5;
	v[(seed + 2) % dim] = 0.3;
	// Normalize
	const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return v.map((x) => x / mag);
}

/**
 * Create two vectors that have a known high cosine similarity (> 0.85).
 * We make them nearly identical with a small perturbation.
 */
function makeHighSimilarityPair(dim = 768): [number[], number[]] {
	const base = new Array(dim).fill(0);
	base[0] = 1.0;
	base[1] = 0.8;
	base[2] = 0.6;
	const mag = Math.sqrt(base.reduce((s, x) => s + x * x, 0));
	const a = base.map((x) => x / mag);

	// Perturb slightly -- cosine sim will be very close to 1.0
	const b = [...a];
	b[3] = 0.05; // tiny perturbation
	const magB = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
	return [a, b.map((x) => x / magB)];
}

/**
 * Create two vectors with known low cosine similarity (< 0.85).
 * We make them point in very different directions.
 */
function makeLowSimilarityPair(dim = 768): [number[], number[]] {
	const a = new Array(dim).fill(0);
	a[0] = 1.0;
	const b = new Array(dim).fill(0);
	b[100] = 1.0; // orthogonal
	return [a, b];
}

function cosineSim(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function isPgAvailable(): Promise<boolean> {
	return db.isPgAvailable();
}

/** Build entity resolution config with all tiers enabled by default. */
function makeResolutionConfig(overrides?: {
	attribute_match?: boolean;
	embedding_similarity?: boolean;
	embedding_threshold?: number;
	llm_assisted?: boolean;
}) {
	return {
		strategies: [
			{
				type: 'attribute_match' as const,
				enabled: overrides?.attribute_match ?? true,
			},
			{
				type: 'embedding_similarity' as const,
				enabled: overrides?.embedding_similarity ?? true,
				threshold: overrides?.embedding_threshold ?? 0.85,
			},
			{
				type: 'llm_assisted' as const,
				enabled: overrides?.llm_assisted ?? true,
				model: 'gemini-2.5-flash',
			},
		],
		cross_lingual: true,
	};
}

/**
 * Create a mock Services object that overrides embedding and LLM for testing.
 * The embedding service returns a provided vector or deterministic vectors.
 * The LLM service can return a controlled entity resolution response.
 */
function makeMockServices(
	baseServices: Record<string, unknown>,
	opts?: {
		embedResult?: number[];
		llmResult?: { same_entity: boolean; confidence: number; reasoning: string };
	},
): Record<string, unknown> {
	return {
		...baseServices,
		embedding: {
			embed: async (texts: string[]) => {
				if (opts?.embedResult) {
					return texts.map((t) => ({ text: t, vector: opts.embedResult }));
				}
				// Default: return zero vectors (same as dev service)
				return texts.map((t) => ({ text: t, vector: new Array(768).fill(0) }));
			},
		},
		llm: {
			generateStructured: async () => {
				if (opts?.llmResult) {
					return opts.llmResult;
				}
				return {};
			},
			generateText: async () => '',
			groundedGenerate: async () => ({ text: '', groundingMetadata: {} }),
		},
	};
}

describe('Spec 28: Cross-Lingual Entity Resolution -- QA Contract', () => {
	let pgAvailable = false;

	beforeAll(async () => {
		pgAvailable = await isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		pool = new pg.Pool(PG_CONFIG);

		// Ensure migrations are applied (including 017)
		const migrateResult = spawnSync('node', [CLI, 'db', 'migrate', EXAMPLE_CONFIG], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 30000,
			env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD },
		});
		if (migrateResult.status !== 0) {
			throw new Error(`Migration failed: ${migrateResult.stdout} ${migrateResult.stderr}`);
		}

		// Dynamically import modules
		const coreMod = await import(CORE_MODULE);
		const dbMod = await import(DB_MODULE);
		const enrichMod = await import(ENRICH_MODULE);

		createEntity = dbMod.createEntity;
		findEntityById = dbMod.findEntityById;
		updateEntityEmbedding = dbMod.updateEntityEmbedding;
		findAliasesByEntityId = dbMod.findAliasesByEntityId;
		resolveEntity = enrichMod.resolveEntity;
		loadConfig = coreMod.loadConfig;
		createServiceRegistry = coreMod.createServiceRegistry;
		createLogger = coreMod.createLogger;

		// Load config and create dev services
		config = (await loadConfig(EXAMPLE_CONFIG)) as Record<string, unknown>;
		const logger = createLogger({ level: 'silent' }) as unknown;
		services = createServiceRegistry(config, logger) as Record<string, unknown>;
	});

	beforeEach(async () => {
		if (!pgAvailable) return;
		// Clean entities and aliases for test isolation
		await pool.query('DELETE FROM entity_aliases');
		await pool.query('DELETE FROM story_entities');
		await pool.query('DELETE FROM entity_edges');
		await pool.query('DELETE FROM entities');
	});

	afterAll(async () => {
		if (!pgAvailable) return;
		try {
			await pool.query('DELETE FROM entity_aliases');
			await pool.query('DELETE FROM story_entities');
			await pool.query('DELETE FROM entity_edges');
			await pool.query('DELETE FROM entities');
		} catch {
			// Tables may not exist
		}
		await pool.end();
	});

	// ─── QA-01: Tier 1 -- attribute match on Wikidata ID ───

	it('QA-01: Tier 1 -- attribute match on Wikidata ID resolves to merged', async () => {
		if (!pgAvailable) return;

		// Insert entity A with wikidata_id
		await createEntity(pool, {
			name: 'Munich',
			type: 'location',
			attributes: { wikidata_id: 'Q1726' },
		});

		// Insert entity B with same wikidata_id but different name
		const entityB = (await createEntity(pool, {
			name: 'München',
			type: 'location',
			attributes: { wikidata_id: 'Q1726' },
		})) as Record<string, unknown>;

		const resConfig = makeResolutionConfig({ embedding_similarity: false, llm_assisted: false });
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services,
			config: resConfig,
		})) as Record<string, unknown>;

		expect(result.action).toBe('merged');
		const match = result.match as Record<string, unknown>;
		expect(match).not.toBeNull();
		expect(match.tier).toBe('attribute_match');
		expect(match.score).toBe(1.0);
	});

	// ─── QA-02: Tier 1 -- attribute match on geo_point proximity ───

	it('QA-02: Tier 1 -- attribute match on geo_point proximity within 100m resolves to merged', async () => {
		if (!pgAvailable) return;

		await createEntity(pool, {
			name: 'Roswell',
			type: 'location',
			attributes: { geo_point: { lat: 33.3943, lng: -104.523 } },
		});

		const entityB = (await createEntity(pool, {
			name: 'Roswell NM',
			type: 'location',
			attributes: { geo_point: { lat: 33.3944, lng: -104.5231 } },
		})) as Record<string, unknown>;

		const resConfig = makeResolutionConfig({ embedding_similarity: false, llm_assisted: false });
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services,
			config: resConfig,
		})) as Record<string, unknown>;

		expect(result.action).toBe('merged');
		const match = result.match as Record<string, unknown>;
		expect(match).not.toBeNull();
		expect(match.tier).toBe('attribute_match');
	});

	// ─── QA-03: Tier 1 -- no match when attributes differ ───

	it('QA-03: Tier 1 -- no match when type differs and wikidata_id differs', async () => {
		if (!pgAvailable) return;

		await createEntity(pool, {
			name: 'Munich',
			type: 'location',
			attributes: { wikidata_id: 'Q1726' },
		});

		const entityB = (await createEntity(pool, {
			name: 'Munich',
			type: 'person',
			attributes: { wikidata_id: 'Q9999' },
		})) as Record<string, unknown>;

		// Only Tier 1 enabled
		const resConfig = makeResolutionConfig({ embedding_similarity: false, llm_assisted: false });
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services,
			config: resConfig,
		})) as Record<string, unknown>;

		// Should NOT match -- different type AND different wikidata_id
		expect(result.action).toBe('new');
		expect(result.match).toBeNull();
	});

	// ─── QA-04: Tier 2 -- embedding similarity finds candidate above threshold ───

	it('QA-04: Tier 2 -- embedding similarity finds candidate above threshold and merges', async () => {
		if (!pgAvailable) return;

		const [vecA, vecB] = makeHighSimilarityPair();
		// Verify our vectors actually have high cosine similarity
		expect(cosineSim(vecA, vecB)).toBeGreaterThan(0.85);

		// Insert entity A with a stored name_embedding
		const entityA = (await createEntity(pool, {
			name: 'Josef Allen Hynek',
			type: 'person',
		})) as Record<string, unknown>;
		await updateEntityEmbedding(pool, entityA.id, vecA);

		// Insert entity B
		const entityB = (await createEntity(pool, {
			name: 'J. Allen Hynek',
			type: 'person',
		})) as Record<string, unknown>;

		// Mock embedding service to return vecB for entity B's name
		const mockServices = makeMockServices(services, { embedResult: vecB });

		const resConfig = makeResolutionConfig({ attribute_match: false, llm_assisted: false });
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services: mockServices,
			config: resConfig,
		})) as Record<string, unknown>;

		expect(result.action).toBe('merged');
		const match = result.match as Record<string, unknown>;
		expect(match).not.toBeNull();
		expect(match.tier).toBe('embedding_similarity');
	});

	// ─── QA-05: Tier 2 -- embedding similarity rejects candidate below threshold ───

	it('QA-05: Tier 2 -- embedding similarity rejects candidate below threshold', async () => {
		if (!pgAvailable) return;

		const [vecA, vecB] = makeLowSimilarityPair();
		// Verify our vectors have low cosine similarity
		expect(cosineSim(vecA, vecB)).toBeLessThan(0.85);

		const entityA = (await createEntity(pool, {
			name: 'Josef Allen Hynek',
			type: 'person',
		})) as Record<string, unknown>;
		await updateEntityEmbedding(pool, entityA.id, vecA);

		const entityB = (await createEntity(pool, {
			name: 'Jacques Vallée',
			type: 'person',
		})) as Record<string, unknown>;

		// Mock embedding service returns vecB (orthogonal to vecA)
		const mockServices = makeMockServices(services, { embedResult: vecB });

		const resConfig = makeResolutionConfig({ attribute_match: false, llm_assisted: false });
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services: mockServices,
			config: resConfig,
		})) as Record<string, unknown>;

		// Should NOT match -- below threshold
		expect(result.action).toBe('new');
	});

	// ─── QA-06: Tier 2 -- stores name embedding for new entity ───

	it('QA-06: Tier 2 -- stores name_embedding for new entity after resolution', async () => {
		if (!pgAvailable) return;

		const testVector = makeVector(42);
		const entityB = (await createEntity(pool, {
			name: 'Test Entity Embedding',
			type: 'person',
		})) as Record<string, unknown>;

		// Verify no embedding before resolution
		const beforeResult = await pool.query('SELECT name_embedding FROM entities WHERE id = $1', [entityB.id]);
		expect(beforeResult.rows[0].name_embedding).toBeNull();

		// Mock embedding service returns our test vector
		const mockServices = makeMockServices(services, { embedResult: testVector });

		const resConfig = makeResolutionConfig({ attribute_match: false, llm_assisted: false });
		await resolveEntity({
			entity: entityB,
			pool,
			services: mockServices,
			config: resConfig,
		});

		// Verify embedding is now stored
		const afterResult = await pool.query('SELECT name_embedding FROM entities WHERE id = $1', [entityB.id]);
		expect(afterResult.rows[0].name_embedding).not.toBeNull();
	});

	// ─── QA-07: Tier 3 -- LLM resolves ambiguous pair ───

	it('QA-07: Tier 3 -- LLM resolves ambiguous pair when dev LLM returns same_entity=true', async () => {
		if (!pgAvailable) return;

		// Insert entity A
		const entityA = (await createEntity(pool, {
			name: 'Munich',
			type: 'location',
		})) as Record<string, unknown>;

		// Insert entity B
		const entityB = (await createEntity(pool, {
			name: 'Monaco di Baviera',
			type: 'location',
		})) as Record<string, unknown>;

		// To trigger Tier 3, we need Tier 2 to produce a "near-miss":
		// a candidate with similarity between threshold*0.8 (0.68) and threshold (0.85).
		// We construct vectors with controlled cosine similarity ~0.75 (in the near-miss zone).
		const vecA = new Array(768).fill(0);
		vecA[0] = 1.0; // unit vector along dimension 0
		await updateEntityEmbedding(pool, entityA.id, vecA);

		// Near-miss vector: cos(theta) = 0.75 means sin(theta) = sqrt(1-0.5625) ~ 0.6614
		// v_B = 0.75 * e_0 + 0.6614 * e_1 (already normalized)
		const nearMissVec = new Array(768).fill(0);
		nearMissVec[0] = 0.75;
		nearMissVec[1] = Math.sqrt(1 - 0.75 * 0.75); // ~0.6614
		// Verify similarity is in near-miss range
		const simCheck = nearMissVec[0]; // dot product with [1,0,...] = nearMissVec[0] = 0.75
		expect(simCheck).toBeGreaterThan(0.85 * 0.8); // > 0.68
		expect(simCheck).toBeLessThan(0.85); // < 0.85

		// Mock services: embedding returns the near-miss vector, LLM says same_entity
		const mockServices = makeMockServices(services, {
			embedResult: nearMissVec,
			llmResult: {
				same_entity: true,
				confidence: 0.9,
				reasoning: 'Monaco di Baviera is the Italian name for Munich',
			},
		});

		const resConfig = makeResolutionConfig({ attribute_match: false });
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services: mockServices,
			config: resConfig,
		})) as Record<string, unknown>;

		expect(result.action).toBe('merged');
		const match = result.match as Record<string, unknown>;
		expect(match).not.toBeNull();
		expect(match.tier).toBe('llm_assisted');
		expect(match.score).toBe(0.9);
	});

	// ─── QA-08: Merge operation -- sets canonical_id and adds alias ───

	it('QA-08: Merge operation sets canonical_id on entity B and adds alias on entity A', async () => {
		if (!pgAvailable) return;

		// Insert entity A with a wikidata_id
		const entityA = (await createEntity(pool, {
			name: 'Munich',
			type: 'location',
			attributes: { wikidata_id: 'Q1726' },
		})) as Record<string, unknown>;

		// Insert entity B with same wikidata_id
		const entityB = (await createEntity(pool, {
			name: 'München',
			type: 'location',
			attributes: { wikidata_id: 'Q1726' },
		})) as Record<string, unknown>;

		const resConfig = makeResolutionConfig({ embedding_similarity: false, llm_assisted: false });
		await resolveEntity({
			entity: entityB,
			pool,
			services,
			config: resConfig,
		});

		// Verify: entity B's canonical_id points to entity A
		const updatedB = (await findEntityById(pool, entityB.id)) as Record<string, unknown>;
		expect(updatedB.canonicalId).toBe(entityA.id);

		// Verify: alias record exists for entity A with entity B's name
		const aliases = (await findAliasesByEntityId(pool, entityA.id)) as Array<Record<string, unknown>>;
		const aliasNames = aliases.map((a) => a.alias);
		expect(aliasNames).toContain('München');
	});

	// ─── QA-09: Resolution with no match -- creates new entity ───

	it('QA-09: Resolution with no match returns action=new and match=null', async () => {
		if (!pgAvailable) return;

		// Insert a single entity -- no other entities of same type
		const entityB = (await createEntity(pool, {
			name: 'Unique Entity',
			type: 'person',
		})) as Record<string, unknown>;

		// Mock embedding to return a valid vector (so Tier 2 runs but finds nothing)
		const mockServices = makeMockServices(services, { embedResult: makeVector(99) });

		const resConfig = makeResolutionConfig();
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services: mockServices,
			config: resConfig,
		})) as Record<string, unknown>;

		expect(result.action).toBe('new');
		expect(result.match).toBeNull();

		// Verify entity's canonical_id remains null
		const entity = (await findEntityById(pool, entityB.id)) as Record<string, unknown>;
		expect(entity.canonicalId).toBeNull();
	});

	// ─── QA-10: Disabled strategy is skipped ───

	it('QA-10: Disabled embedding_similarity strategy is not included in tiersExecuted', async () => {
		if (!pgAvailable) return;

		const entityB = (await createEntity(pool, {
			name: 'Test Skip',
			type: 'person',
		})) as Record<string, unknown>;

		const resConfig = makeResolutionConfig({ embedding_similarity: false });
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services,
			config: resConfig,
		})) as Record<string, unknown>;

		const tiersExecuted = result.tiersExecuted as string[];
		expect(tiersExecuted).not.toContain('embedding_similarity');
	});

	// ─── QA-11: All strategies disabled returns new ───

	it('QA-11: All strategies disabled returns action=new with empty tiersExecuted', async () => {
		if (!pgAvailable) return;

		const entityB = (await createEntity(pool, {
			name: 'All Disabled',
			type: 'person',
		})) as Record<string, unknown>;

		const resConfig = makeResolutionConfig({
			attribute_match: false,
			embedding_similarity: false,
			llm_assisted: false,
		});
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services,
			config: resConfig,
		})) as Record<string, unknown>;

		expect(result.action).toBe('new');
		const tiersExecuted = result.tiersExecuted as string[];
		expect(tiersExecuted).toEqual([]);
	});

	// ─── QA-12: Migration 017 -- name_embedding column exists ───

	it('QA-12: Migration 017 -- entities table has name_embedding column', async () => {
		if (!pgAvailable) return;

		const result = await pool.query(
			"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'entities' AND column_name = 'name_embedding'",
		);
		expect(result.rows).toHaveLength(1);
	});

	// ─── QA-13: Resolution respects entity type boundary ───

	it('QA-13: Resolution does not match entity of different type even with same name', async () => {
		if (!pgAvailable) return;

		// Entity A is a location named Phoenix
		const entityA = (await createEntity(pool, {
			name: 'Phoenix',
			type: 'location',
			attributes: { wikidata_id: 'Q16556' },
		})) as Record<string, unknown>;

		// Store embedding for entity A
		const vecA = makeVector(10);
		await updateEntityEmbedding(pool, entityA.id, vecA);

		// Entity B is an organization named Phoenix
		const entityB = (await createEntity(pool, {
			name: 'Phoenix',
			type: 'organization',
		})) as Record<string, unknown>;

		// Mock embedding service returns the SAME vector as entity A (max similarity)
		const mockServices = makeMockServices(services, { embedResult: vecA });

		const resConfig = makeResolutionConfig();
		const result = (await resolveEntity({
			entity: entityB,
			pool,
			services: mockServices,
			config: resConfig,
		})) as Record<string, unknown>;

		// Should NOT match -- different type
		expect(result.action).toBe('new');
		expect(result.match).toBeNull();
	});
});
