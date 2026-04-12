import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');
const TAXONOMY_MODULE = resolve(ROOT, 'packages/taxonomy/dist/index.js');

/**
 * Black-box QA tests for Spec 27: Taxonomy Normalization — pg_trgm matching
 *
 * Each `it()` maps to one QA-NN condition from Section 5 of the spec.
 * Section 5b (CLI Test Matrix) is N/A — no CLI surface for this step.
 *
 * Tests interact through system boundaries:
 * - Direct SQL via pg (setup + verification)
 * - Exported functions from @mulder/core (taxonomy repository)
 * - Exported functions from @mulder/taxonomy (normalizeTaxonomy)
 * - Config loader from @mulder/core
 *
 * Requires a running PostgreSQL instance with pg_trgm extension
 * and taxonomy table (migrations through 007+).
 */

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

let pool: pg.Pool;

// Dynamically imported repository functions (from @mulder/core)
let createTaxonomyEntry: (...args: unknown[]) => Promise<unknown>;
let _findTaxonomyEntryById: (...args: unknown[]) => Promise<unknown>;
let _findTaxonomyEntryByName: (...args: unknown[]) => Promise<unknown>;
let findAllTaxonomyEntries: (...args: unknown[]) => Promise<unknown>;
let _countTaxonomyEntries: (...args: unknown[]) => Promise<unknown>;
let updateTaxonomyEntry: (...args: unknown[]) => Promise<unknown>;
let deleteTaxonomyEntry: (...args: unknown[]) => Promise<unknown>;
let searchTaxonomyBySimilarity: (...args: unknown[]) => Promise<unknown>;

// Dynamically imported normalize function (from @mulder/taxonomy)
let normalizeTaxonomy: (...args: unknown[]) => Promise<unknown>;

// Config loader
let loadConfig: (...args: unknown[]) => Promise<unknown>;

async function isPgAvailable(): Promise<boolean> {
	return db.isPgAvailable();
}

describe('Spec 27: Taxonomy Normalization — QA Contract', () => {
	let pgAvailable = false;

	beforeAll(async () => {
		// Dynamically import repository functions from built packages.
		// These public API checks should work even when PostgreSQL is unavailable.
		const dbMod = await import(DB_MODULE);
		const coreMod = await import(CORE_MODULE);
		const taxMod = await import(TAXONOMY_MODULE);

		createTaxonomyEntry = dbMod.createTaxonomyEntry;
		_findTaxonomyEntryById = dbMod.findTaxonomyEntryById;
		_findTaxonomyEntryByName = dbMod.findTaxonomyEntryByName;
		findAllTaxonomyEntries = dbMod.findAllTaxonomyEntries;
		_countTaxonomyEntries = dbMod.countTaxonomyEntries;
		updateTaxonomyEntry = dbMod.updateTaxonomyEntry;
		deleteTaxonomyEntry = dbMod.deleteTaxonomyEntry;
		searchTaxonomyBySimilarity = dbMod.searchTaxonomyBySimilarity;
		normalizeTaxonomy = taxMod.normalizeTaxonomy;
		loadConfig = coreMod.loadConfig;

		pgAvailable = await isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		pool = new pg.Pool(PG_CONFIG);

		// Ensure migrations are applied
		const migrateResult = spawnSync('node', [CLI, 'db', 'migrate', EXAMPLE_CONFIG], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 30000,
			env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD },
		});
		if (migrateResult.status !== 0) {
			throw new Error(`Migration failed: ${migrateResult.stdout} ${migrateResult.stderr}`);
		}

		// Clean taxonomy table
		await pool.query('DELETE FROM taxonomy');
	});

	beforeEach(async () => {
		if (!pgAvailable) return;
		// Clean taxonomy table before each test for isolation
		await pool.query('DELETE FROM taxonomy');
	});

	afterAll(async () => {
		if (!pgAvailable) return;
		try {
			await pool.query('DELETE FROM taxonomy');
		} catch {
			// Table may not exist
		}
		await pool.end();
	});

	// ─── QA-01: Taxonomy CRUD — create and read ───

	it('QA-01: createTaxonomyEntry creates entry with status=auto, correct canonical_name and entity_type', async () => {
		if (!pgAvailable) return;

		const entry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Josef Allen Hynek',
			entityType: 'person',
		})) as Record<string, unknown>;

		expect(entry).toBeDefined();
		expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

		// Verify via raw SQL
		const dbResult = await pool.query('SELECT canonical_name, entity_type, status FROM taxonomy WHERE id = $1', [
			entry.id,
		]);
		expect(dbResult.rows).toHaveLength(1);
		expect(dbResult.rows[0].canonical_name).toBe('Josef Allen Hynek');
		expect(dbResult.rows[0].entity_type).toBe('person');
		expect(dbResult.rows[0].status).toBe('auto');
	});

	// ─── QA-02: Taxonomy CRUD — idempotent upsert ───

	it('QA-02: createTaxonomyEntry is idempotent — no duplicate for same name+type', async () => {
		if (!pgAvailable) return;

		// Create first
		await createTaxonomyEntry(pool, {
			canonicalName: 'Josef Allen Hynek',
			entityType: 'person',
		});

		// Create again with additional aliases
		const entry2 = (await createTaxonomyEntry(pool, {
			canonicalName: 'Josef Allen Hynek',
			entityType: 'person',
			aliases: ['Hynek'],
		})) as Record<string, unknown>;

		expect(entry2).toBeDefined();

		// Verify only one row exists
		const dbResult = await pool.query(
			"SELECT COUNT(*) FROM taxonomy WHERE canonical_name = 'Josef Allen Hynek' AND entity_type = 'person'",
		);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(1);
	});

	// ─── QA-03: Taxonomy CRUD — update entry ───

	it('QA-03: updateTaxonomyEntry updates status and bumps updated_at', async () => {
		if (!pgAvailable) return;

		const entry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Test Entry Update',
			entityType: 'person',
		})) as Record<string, unknown>;

		const originalUpdatedAt = entry.updatedAt as Date;

		// Small delay to ensure timestamp difference
		await new Promise((r) => setTimeout(r, 50));

		const updated = (await updateTaxonomyEntry(pool, entry.id, {
			status: 'confirmed',
		})) as Record<string, unknown>;

		expect(updated).toBeDefined();

		// Verify via raw SQL
		const dbResult = await pool.query('SELECT status, updated_at FROM taxonomy WHERE id = $1', [entry.id]);
		expect(dbResult.rows[0].status).toBe('confirmed');
		expect(new Date(dbResult.rows[0].updated_at).getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
	});

	// ─── QA-04: Taxonomy CRUD — delete entry ───

	it('QA-04: deleteTaxonomyEntry removes the entry from the database', async () => {
		if (!pgAvailable) return;

		const entry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Delete Me',
			entityType: 'person',
		})) as Record<string, unknown>;

		await deleteTaxonomyEntry(pool, entry.id);

		// Verify via raw SQL
		const dbResult = await pool.query('SELECT COUNT(*) FROM taxonomy WHERE id = $1', [entry.id]);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(0);
	});

	// ─── QA-05: Trigram search — finds similar names ───

	it('QA-05: searchTaxonomyBySimilarity finds similar names by type, excludes wrong type', async () => {
		if (!pgAvailable) return;

		// Insert test entries via repository
		await createTaxonomyEntry(pool, {
			canonicalName: 'Josef Allen Hynek',
			entityType: 'person',
		});
		await createTaxonomyEntry(pool, {
			canonicalName: 'Jacques Vallée',
			entityType: 'person',
		});
		await createTaxonomyEntry(pool, {
			canonicalName: 'Roswell',
			entityType: 'location',
		});

		const results = (await searchTaxonomyBySimilarity(pool, 'J. Allen Hynek', 'person', 0.3)) as Array<{
			entry: Record<string, unknown>;
			similarity: number;
		}>;

		expect(results.length).toBeGreaterThanOrEqual(1);

		// Must include Josef Allen Hynek with similarity > 0.3
		const hynekMatch = results.find((r) => (r.entry as Record<string, unknown>).canonicalName === 'Josef Allen Hynek');
		expect(hynekMatch).toBeDefined();
		expect(hynekMatch?.similarity).toBeGreaterThan(0.3);

		// Must NOT include Roswell (wrong entity_type)
		const roswellMatch = results.find((r) => (r.entry as Record<string, unknown>).canonicalName === 'Roswell');
		expect(roswellMatch).toBeUndefined();
	});

	// ─── QA-06: Trigram search — matches aliases ───

	it('QA-06: searchTaxonomyBySimilarity matches via alias with similarity > 0.3', async () => {
		if (!pgAvailable) return;

		await createTaxonomyEntry(pool, {
			canonicalName: 'Munich',
			entityType: 'location',
			aliases: ['München', 'Monaco di Baviera'],
		});

		const results = (await searchTaxonomyBySimilarity(pool, 'München', 'location', 0.3)) as Array<{
			entry: Record<string, unknown>;
			similarity: number;
		}>;

		expect(results.length).toBeGreaterThanOrEqual(1);

		const munichMatch = results.find((r) => (r.entry as Record<string, unknown>).canonicalName === 'Munich');
		expect(munichMatch).toBeDefined();
		expect(munichMatch?.similarity).toBeGreaterThan(0.3);
	});

	// ─── QA-07: Trigram search — excludes rejected entries ───

	it('QA-07: searchTaxonomyBySimilarity excludes rejected entries', async () => {
		if (!pgAvailable) return;

		// Create and then reject an entry
		const entry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Rejected Entity',
			entityType: 'person',
		})) as Record<string, unknown>;

		await updateTaxonomyEntry(pool, entry.id, { status: 'rejected' });

		const results = (await searchTaxonomyBySimilarity(pool, 'Rejected Entity', 'person', 0.3)) as Array<{
			entry: Record<string, unknown>;
			similarity: number;
		}>;

		// The rejected entry must NOT appear
		const rejectedMatch = results.find((r) => (r.entry as Record<string, unknown>).id === entry.id);
		expect(rejectedMatch).toBeUndefined();
	});

	// ─── QA-08: Normalize — matches existing taxonomy entry ───

	it('QA-08: normalizeTaxonomy matches existing entry and returns action=matched with similarity', async () => {
		if (!pgAvailable) return;

		// Set up a taxonomy entry
		await createTaxonomyEntry(pool, {
			canonicalName: 'Josef Allen Hynek',
			entityType: 'person',
			status: 'auto',
		});

		const result = (await normalizeTaxonomy(pool, 'J. Allen Hynek', 'person', 0.3)) as Record<string, unknown>;

		expect(result.action).toBe('matched');
		expect(result.similarity).toBeGreaterThanOrEqual(0.3);
		expect((result.taxonomyEntry as Record<string, unknown>).canonicalName).toBe('Josef Allen Hynek');
	});

	// ─── QA-09: Normalize — creates new entry when no match ───

	it('QA-09: normalizeTaxonomy creates new entry when no match exists', async () => {
		if (!pgAvailable) return;

		// Taxonomy table is empty (cleaned in beforeEach)
		const result = (await normalizeTaxonomy(pool, 'Bob Lazar', 'person', 0.4)) as Record<string, unknown>;

		expect(result.action).toBe('created');
		expect(result.similarity).toBeNull();

		const entry = result.taxonomyEntry as Record<string, unknown>;
		expect(entry.canonicalName).toBe('Bob Lazar');
		expect(entry.entityType).toBe('person');
		expect(entry.status).toBe('auto');

		// Verify in DB
		const dbResult = await pool.query(
			"SELECT canonical_name, entity_type, status FROM taxonomy WHERE canonical_name = 'Bob Lazar' AND entity_type = 'person'",
		);
		expect(dbResult.rows).toHaveLength(1);
		expect(dbResult.rows[0].status).toBe('auto');
	});

	// ─── QA-10: Normalize — does not modify confirmed entries ───

	it('QA-10: normalizeTaxonomy does not modify aliases of confirmed entries', async () => {
		if (!pgAvailable) return;

		// Create a confirmed entry with specific aliases
		const entry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Josef Allen Hynek',
			entityType: 'person',
			status: 'confirmed',
			aliases: ['Hynek'],
		})) as Record<string, unknown>;

		// Normalize with a variant name
		const result = (await normalizeTaxonomy(pool, 'Dr. J. Allen Hynek', 'person', 0.3)) as Record<string, unknown>;

		expect(result.action).toBe('matched');

		// Verify aliases are NOT modified
		const dbResult = await pool.query('SELECT aliases FROM taxonomy WHERE id = $1', [entry.id]);
		const aliases = dbResult.rows[0].aliases as string[];
		expect(aliases).toEqual(['Hynek']);
		expect(aliases).not.toContain('Dr. J. Allen Hynek');
	});

	// ─── QA-11: Normalize — adds alias to auto entries on match ───

	it('QA-11: normalizeTaxonomy adds entity name as alias to auto entries on match', async () => {
		if (!pgAvailable) return;

		const entry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Josef Allen Hynek',
			entityType: 'person',
			status: 'auto',
			aliases: [],
		})) as Record<string, unknown>;

		const result = (await normalizeTaxonomy(pool, 'J. Allen Hynek', 'person', 0.3)) as Record<string, unknown>;

		expect(result.action).toBe('matched');

		// Verify alias was added
		const dbResult = await pool.query('SELECT aliases FROM taxonomy WHERE id = $1', [entry.id]);
		const aliases = dbResult.rows[0].aliases as string[];
		expect(aliases).toContain('J. Allen Hynek');
	});

	// ─── QA-12: Config — taxonomy normalization_threshold accessible ───

	it('QA-12: config.taxonomy.normalization_threshold defaults to 0.4', async () => {
		// This test does not need PostgreSQL
		const config = (await loadConfig(EXAMPLE_CONFIG)) as Record<string, unknown>;
		const taxonomy = config.taxonomy as Record<string, unknown>;

		expect(taxonomy).toBeDefined();
		expect(taxonomy.normalization_threshold).toBe(0.4);
	});

	// ─── QA-13: Taxonomy filter — by entity type ───

	it('QA-13: findAllTaxonomyEntries filters by entityType', async () => {
		if (!pgAvailable) return;

		await createTaxonomyEntry(pool, {
			canonicalName: 'Person One',
			entityType: 'person',
		});
		await createTaxonomyEntry(pool, {
			canonicalName: 'Location One',
			entityType: 'location',
		});
		await createTaxonomyEntry(pool, {
			canonicalName: 'Org One',
			entityType: 'organization',
		});

		const results = (await findAllTaxonomyEntries(pool, {
			entityType: 'person',
		})) as Array<Record<string, unknown>>;

		expect(results.length).toBe(1);
		expect(results.every((r) => r.entityType === 'person')).toBe(true);
	});

	// ─── QA-14: Taxonomy filter — by status ───

	it('QA-14: findAllTaxonomyEntries filters by status', async () => {
		if (!pgAvailable) return;

		// Create entries with different statuses
		const _autoEntry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Auto Entry',
			entityType: 'person',
			status: 'auto',
		})) as Record<string, unknown>;

		const confirmedEntry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Confirmed Entry',
			entityType: 'person',
		})) as Record<string, unknown>;
		await updateTaxonomyEntry(pool, confirmedEntry.id, { status: 'confirmed' });

		const rejectedEntry = (await createTaxonomyEntry(pool, {
			canonicalName: 'Rejected Entry',
			entityType: 'person',
		})) as Record<string, unknown>;
		await updateTaxonomyEntry(pool, rejectedEntry.id, { status: 'rejected' });

		const results = (await findAllTaxonomyEntries(pool, {
			status: 'confirmed',
		})) as Array<Record<string, unknown>>;

		expect(results.length).toBe(1);
		expect(results.every((r) => r.status === 'confirmed')).toBe(true);
	});
});
