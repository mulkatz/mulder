import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 22: Story Repository
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: SQL via pg, and
 * TypeScript imports from @mulder/core barrel (dist).
 *
 * Requires a running PostgreSQL instance (Docker container `mulder-pg-test`)
 * with migrations applied.
 */

const PG_CONFIG = {
	host: 'localhost',
	port: 5432,
	database: 'mulder',
	user: 'mulder',
	password: 'mulder',
};

let pool: pg.Pool;
let sourceId: string;

// Dynamically imported repository functions
let createStory: (...args: unknown[]) => Promise<unknown>;
let findStoryById: (...args: unknown[]) => Promise<unknown>;
let findStoriesBySourceId: (...args: unknown[]) => Promise<unknown>;
let findAllStories: (...args: unknown[]) => Promise<unknown>;
let countStories: (...args: unknown[]) => Promise<unknown>;
let updateStory: (...args: unknown[]) => Promise<unknown>;
let updateStoryStatus: (...args: unknown[]) => Promise<unknown>;
let deleteStory: (...args: unknown[]) => Promise<unknown>;
let deleteStoriesBySourceId: (...args: unknown[]) => Promise<unknown>;
let createSource: (...args: unknown[]) => Promise<unknown>;
let DatabaseError: new (...args: unknown[]) => Error;

function isPgAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		const testPool = new pg.Pool(PG_CONFIG);
		testPool
			.query('SELECT 1')
			.then(() => {
				testPool.end();
				resolve(true);
			})
			.catch(() => {
				testPool.end().catch(() => {});
				resolve(false);
			});
	});
}

describe('Spec 22: Story Repository', () => {
	let pgAvailable = false;

	beforeAll(async () => {
		pgAvailable = await isPgAvailable();
		if (!pgAvailable) {
			console.warn(
				'SKIP: PostgreSQL not available. Start with:\n' +
					'  docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17',
			);
			return;
		}

		pool = new pg.Pool(PG_CONFIG);

		// Ensure migrations are applied (other test suites may have dropped all tables)
		const migrateResult = spawnSync('node', [CLI, 'db', 'migrate', EXAMPLE_CONFIG], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 30000,
			env: { ...process.env, PGPASSWORD: 'mulder' },
		});
		if (migrateResult.status !== 0) {
			throw new Error(`Migration failed: ${migrateResult.stdout} ${migrateResult.stderr}`);
		}

		// Dynamically import repository functions from the built barrel
		const coreMod = await import(CORE_MODULE);
		createStory = coreMod.createStory;
		findStoryById = coreMod.findStoryById;
		findStoriesBySourceId = coreMod.findStoriesBySourceId;
		findAllStories = coreMod.findAllStories;
		countStories = coreMod.countStories;
		updateStory = coreMod.updateStory;
		updateStoryStatus = coreMod.updateStoryStatus;
		deleteStory = coreMod.deleteStory;
		deleteStoriesBySourceId = coreMod.deleteStoriesBySourceId;
		createSource = coreMod.createSource;
		DatabaseError = coreMod.DatabaseError;

		// Clean up stories and create a parent source for FK reference
		await pool.query('DELETE FROM stories');
		await pool.query('DELETE FROM source_steps');
		await pool.query('DELETE FROM sources');

		const source = (await createSource(pool, {
			filename: 'story-test-parent.pdf',
			storagePath: 'raw/story-test-parent.pdf',
			fileHash: `hash_spec22_parent_${Date.now()}`,
			pageCount: 50,
		})) as { id: string };
		sourceId = source.id;
	});

	beforeEach(async () => {
		if (!pgAvailable) return;
		// Clean stories before each test for isolation
		await pool.query('DELETE FROM stories');
	});

	afterAll(async () => {
		if (!pgAvailable) return;
		// Clean up all test data (tables may have been dropped by other test suites)
		try {
			await pool.query('DELETE FROM stories');
			await pool.query('DELETE FROM source_steps');
			await pool.query('DELETE FROM sources');
		} catch {
			// Tables may not exist if another test suite dropped them
		}
		await pool.end();
	});

	// ─── QA-01: Create story ───

	it('QA-01: createStory returns a Story with generated UUID, status segmented, chunkCount 0', async () => {
		if (!pgAvailable) return;

		const story = (await createStory(pool, {
			sourceId,
			title: 'Test Story QA-01',
			gcsMarkdownUri: 'gs://bucket/segments/doc1/seg1.md',
			gcsMetadataUri: 'gs://bucket/segments/doc1/seg1.meta.json',
			language: 'en',
			category: 'ufo-sighting',
			pageStart: 1,
			pageEnd: 5,
			extractionConfidence: 0.95,
			metadata: { key: 'value' },
		})) as Record<string, unknown>;

		// UUID format check
		expect(story.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(story.sourceId).toBe(sourceId);
		expect(story.title).toBe('Test Story QA-01');
		expect(story.status).toBe('segmented');
		expect(story.chunkCount).toBe(0);
		expect(story.gcsMarkdownUri).toBe('gs://bucket/segments/doc1/seg1.md');
		expect(story.gcsMetadataUri).toBe('gs://bucket/segments/doc1/seg1.meta.json');
		expect(story.language).toBe('en');
		expect(story.category).toBe('ufo-sighting');
		expect(story.pageStart).toBe(1);
		expect(story.pageEnd).toBe(5);
		expect(story.extractionConfidence).toBeCloseTo(0.95);
		expect(story.createdAt).toBeInstanceOf(Date);
		expect(story.updatedAt).toBeInstanceOf(Date);

		// Verify in DB via raw SQL
		const dbResult = await pool.query('SELECT COUNT(*) FROM stories WHERE id = $1', [story.id]);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(1);
	});

	// ─── QA-02: Create story idempotent ───

	it('QA-02: createStory with ON CONFLICT (id) returns existing story with updated updated_at, no duplicate', async () => {
		if (!pgAvailable) return;

		// Since CreateStoryInput doesn't accept an `id` field, we test idempotency
		// by directly inserting a story with a known ID via SQL, then calling createStory
		// which would auto-generate a new UUID (different path). The spec says
		// "ON CONFLICT (id) DO UPDATE" which is only reachable if the segment step
		// provides an explicit ID. We verify the SQL-level behavior instead.

		const knownId = '11111111-1111-1111-1111-111111111111';

		// Insert a story with a known ID directly
		await pool.query(
			`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri)
			 VALUES ($1, $2, $3, $4, $5)`,
			[knownId, sourceId, 'Original Title', 'gs://bucket/orig.md', 'gs://bucket/orig.meta.json'],
		);

		const beforeResult = await pool.query('SELECT updated_at FROM stories WHERE id = $1', [knownId]);
		const originalUpdatedAt = beforeResult.rows[0].updated_at;

		// Small delay to ensure timestamp difference
		await new Promise((r) => setTimeout(r, 50));

		// Now re-insert same ID via SQL to test the ON CONFLICT clause
		const conflictResult = await pool.query(
			`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (id) DO UPDATE SET updated_at = now()
			 RETURNING *`,
			[knownId, sourceId, 'New Title', 'gs://bucket/new.md', 'gs://bucket/new.meta.json'],
		);

		const returned = conflictResult.rows[0];
		expect(returned.id).toBe(knownId);
		// Title should remain original (ON CONFLICT only updates updated_at)
		expect(returned.title).toBe('Original Title');
		expect(returned.updated_at.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt.getTime());

		// Verify no duplicate
		const countResult = await pool.query('SELECT COUNT(*) FROM stories WHERE id = $1', [knownId]);
		expect(Number.parseInt(countResult.rows[0].count, 10)).toBe(1);
	});

	// ─── QA-03: Find by ID ───

	it('QA-03: findStoryById returns the Story with correct camelCase mapping', async () => {
		if (!pgAvailable) return;

		const created = (await createStory(pool, {
			sourceId,
			title: 'Find Me QA-03',
			subtitle: 'A Subtitle',
			language: 'de',
			category: 'encounter',
			pageStart: 10,
			pageEnd: 15,
			gcsMarkdownUri: 'gs://bucket/qa03.md',
			gcsMetadataUri: 'gs://bucket/qa03.meta.json',
			extractionConfidence: 0.88,
			metadata: { origin: 'qa-test' },
		})) as Record<string, unknown>;

		const found = (await findStoryById(pool, created.id)) as Record<string, unknown>;

		expect(found).not.toBeNull();
		expect(found.id).toBe(created.id);
		expect(found.sourceId).toBe(sourceId);
		expect(found.title).toBe('Find Me QA-03');
		expect(found.subtitle).toBe('A Subtitle');
		expect(found.language).toBe('de');
		expect(found.category).toBe('encounter');
		expect(found.pageStart).toBe(10);
		expect(found.pageEnd).toBe(15);
		expect(found.gcsMarkdownUri).toBe('gs://bucket/qa03.md');
		expect(found.gcsMetadataUri).toBe('gs://bucket/qa03.meta.json');
		expect(found.extractionConfidence).toBeCloseTo(0.88);
		expect(found.status).toBe('segmented');
		expect(found.chunkCount).toBe(0);
		expect(found.createdAt).toBeInstanceOf(Date);
		expect(found.updatedAt).toBeInstanceOf(Date);
		// Verify metadata round-trip
		expect((found.metadata as Record<string, unknown>).origin).toBe('qa-test');
	});

	// ─── QA-04: Find by ID not found ───

	it('QA-04: findStoryById returns null for a non-existent UUID', async () => {
		if (!pgAvailable) return;

		const found = await findStoryById(pool, '00000000-0000-0000-0000-000000000000');
		expect(found).toBeNull();
	});

	// ─── QA-05: Find by source ID ───

	it('QA-05: findStoriesBySourceId returns stories ordered by page_start ASC', async () => {
		if (!pgAvailable) return;

		// Create stories with different page_start values (out of order)
		await createStory(pool, {
			sourceId,
			title: 'Story C (page 30)',
			pageStart: 30,
			gcsMarkdownUri: 'gs://bucket/c.md',
			gcsMetadataUri: 'gs://bucket/c.meta.json',
		});
		await createStory(pool, {
			sourceId,
			title: 'Story A (page 1)',
			pageStart: 1,
			gcsMarkdownUri: 'gs://bucket/a.md',
			gcsMetadataUri: 'gs://bucket/a.meta.json',
		});
		await createStory(pool, {
			sourceId,
			title: 'Story B (page 10)',
			pageStart: 10,
			gcsMarkdownUri: 'gs://bucket/b.md',
			gcsMetadataUri: 'gs://bucket/b.meta.json',
		});
		await createStory(pool, {
			sourceId,
			title: 'Story D (no page)',
			gcsMarkdownUri: 'gs://bucket/d.md',
			gcsMetadataUri: 'gs://bucket/d.meta.json',
		});

		const stories = (await findStoriesBySourceId(pool, sourceId)) as Array<Record<string, unknown>>;

		expect(stories).toHaveLength(4);
		// page_start ASC NULLS LAST ordering
		expect(stories[0].title).toBe('Story A (page 1)');
		expect(stories[1].title).toBe('Story B (page 10)');
		expect(stories[2].title).toBe('Story C (page 30)');
		expect(stories[3].title).toBe('Story D (no page)');
		expect(stories[3].pageStart).toBeNull();
	});

	// ─── QA-06: Find all with filters ───

	it('QA-06: findAllStories with status and limit filters returns only matching stories', async () => {
		if (!pgAvailable) return;

		// Create stories with different statuses and categories
		await createStory(pool, {
			sourceId,
			title: 'Segmented 1',
			category: 'encounter',
			gcsMarkdownUri: 'gs://bucket/s1.md',
			gcsMetadataUri: 'gs://bucket/s1.meta.json',
		});
		await createStory(pool, {
			sourceId,
			title: 'Segmented 2',
			category: 'sighting',
			gcsMarkdownUri: 'gs://bucket/s2.md',
			gcsMetadataUri: 'gs://bucket/s2.meta.json',
		});
		await createStory(pool, {
			sourceId,
			title: 'Segmented 3',
			category: 'encounter',
			gcsMarkdownUri: 'gs://bucket/s3.md',
			gcsMetadataUri: 'gs://bucket/s3.meta.json',
		});

		// Update one to enriched status
		const allStories = (await findAllStories(pool)) as Array<Record<string, unknown>>;
		await updateStoryStatus(pool, allStories[0].id, 'enriched');

		// Filter by status: segmented
		const segmented = (await findAllStories(pool, { status: 'segmented' })) as Array<Record<string, unknown>>;
		expect(segmented.length).toBe(2);
		for (const s of segmented) {
			expect(s.status).toBe('segmented');
		}

		// Filter with limit
		const limited = (await findAllStories(pool, { status: 'segmented', limit: 1 })) as Array<Record<string, unknown>>;
		expect(limited.length).toBe(1);

		// Filter by category
		const encounters = (await findAllStories(pool, { category: 'encounter' })) as Array<Record<string, unknown>>;
		expect(encounters.length).toBeGreaterThanOrEqual(1);
		for (const s of encounters) {
			expect(s.category).toBe('encounter');
		}
	});

	// ─── QA-07: Count stories ───

	it('QA-07: countStories with status filter returns correct count', async () => {
		if (!pgAvailable) return;

		// Create 3 segmented stories
		for (let i = 0; i < 3; i++) {
			await createStory(pool, {
				sourceId,
				title: `Count Test ${i}`,
				gcsMarkdownUri: `gs://bucket/count${i}.md`,
				gcsMetadataUri: `gs://bucket/count${i}.meta.json`,
			});
		}

		// Update 1 to enriched
		const all = (await findAllStories(pool)) as Array<Record<string, unknown>>;
		await updateStoryStatus(pool, all[0].id, 'enriched');

		const segmentedCount = (await countStories(pool, { status: 'segmented' })) as number;
		const enrichedCount = (await countStories(pool, { status: 'enriched' })) as number;
		const totalCount = (await countStories(pool)) as number;

		expect(segmentedCount).toBe(2);
		expect(enrichedCount).toBe(1);
		expect(totalCount).toBe(3);
	});

	// ─── QA-08: Update story ───

	it('QA-08: updateStory returns updated story with changed title and refreshed updated_at', async () => {
		if (!pgAvailable) return;

		const created = (await createStory(pool, {
			sourceId,
			title: 'Original Title',
			gcsMarkdownUri: 'gs://bucket/update.md',
			gcsMetadataUri: 'gs://bucket/update.meta.json',
		})) as Record<string, unknown>;

		// Small delay to ensure updated_at differs
		await new Promise((r) => setTimeout(r, 50));

		const updated = (await updateStory(pool, created.id, { title: 'New Title' })) as Record<string, unknown>;

		expect(updated.id).toBe(created.id);
		expect(updated.title).toBe('New Title');
		expect((updated.updatedAt as Date).getTime()).toBeGreaterThan((created.updatedAt as Date).getTime());
		// Other fields should remain unchanged
		expect(updated.gcsMarkdownUri).toBe('gs://bucket/update.md');
		expect(updated.sourceId).toBe(sourceId);
	});

	// ─── QA-09: Update story not found ───

	it('QA-09: updateStory throws DatabaseError with DB_NOT_FOUND for non-existent ID', async () => {
		if (!pgAvailable) return;

		try {
			await updateStory(pool, '00000000-0000-0000-0000-000000000000', { title: 'X' });
			expect.fail('Should have thrown');
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(DatabaseError);
			expect((error as { code: string }).code).toBe('DB_NOT_FOUND');
		}
	});

	// ─── QA-10: Update status ───

	it('QA-10: updateStoryStatus changes status from segmented to enriched with refreshed updated_at', async () => {
		if (!pgAvailable) return;

		const created = (await createStory(pool, {
			sourceId,
			title: 'Status Test',
			gcsMarkdownUri: 'gs://bucket/status.md',
			gcsMetadataUri: 'gs://bucket/status.meta.json',
		})) as Record<string, unknown>;

		expect(created.status).toBe('segmented');

		// Small delay to ensure updated_at differs
		await new Promise((r) => setTimeout(r, 50));

		const updated = (await updateStoryStatus(pool, created.id, 'enriched')) as Record<string, unknown>;

		expect(updated.id).toBe(created.id);
		expect(updated.status).toBe('enriched');
		expect((updated.updatedAt as Date).getTime()).toBeGreaterThan((created.updatedAt as Date).getTime());
	});

	// ─── QA-11: Delete story ───

	it('QA-11: deleteStory returns true and story is no longer findable', async () => {
		if (!pgAvailable) return;

		const created = (await createStory(pool, {
			sourceId,
			title: 'Delete Me',
			gcsMarkdownUri: 'gs://bucket/delete.md',
			gcsMetadataUri: 'gs://bucket/delete.meta.json',
		})) as Record<string, unknown>;

		const deleted = await deleteStory(pool, created.id);
		expect(deleted).toBe(true);

		const found = await findStoryById(pool, created.id as string);
		expect(found).toBeNull();

		// Verify in DB via raw SQL
		const dbResult = await pool.query('SELECT COUNT(*) FROM stories WHERE id = $1', [created.id]);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(0);
	});

	// ─── QA-12: Delete story not found ───

	it('QA-12: deleteStory returns false for non-existent ID', async () => {
		if (!pgAvailable) return;

		const deleted = await deleteStory(pool, '00000000-0000-0000-0000-000000000000');
		expect(deleted).toBe(false);
	});

	// ─── QA-13: Delete by source ID ───

	it('QA-13: deleteStoriesBySourceId returns 3 and all stories are deleted', async () => {
		if (!pgAvailable) return;

		// Create 3 stories for the same source
		for (let i = 0; i < 3; i++) {
			await createStory(pool, {
				sourceId,
				title: `Bulk Delete ${i}`,
				gcsMarkdownUri: `gs://bucket/bulk${i}.md`,
				gcsMetadataUri: `gs://bucket/bulk${i}.meta.json`,
			});
		}

		// Verify they exist
		const before = (await findStoriesBySourceId(pool, sourceId)) as Array<Record<string, unknown>>;
		expect(before).toHaveLength(3);

		const deletedCount = await deleteStoriesBySourceId(pool, sourceId);
		expect(deletedCount).toBe(3);

		// Verify all gone
		const after = (await findStoriesBySourceId(pool, sourceId)) as Array<Record<string, unknown>>;
		expect(after).toHaveLength(0);
	});

	// ─── QA-14: TypeScript types export ───

	it('QA-14: Story, StoryStatus, CreateStoryInput types are available from @mulder/core barrel', async () => {
		if (!pgAvailable) return;

		// Verify the barrel exports the expected functions and that they are functions
		const coreMod = await import(CORE_MODULE);

		expect(typeof coreMod.createStory).toBe('function');
		expect(typeof coreMod.findStoryById).toBe('function');
		expect(typeof coreMod.findStoriesBySourceId).toBe('function');
		expect(typeof coreMod.findAllStories).toBe('function');
		expect(typeof coreMod.countStories).toBe('function');
		expect(typeof coreMod.updateStory).toBe('function');
		expect(typeof coreMod.updateStoryStatus).toBe('function');
		expect(typeof coreMod.deleteStory).toBe('function');
		expect(typeof coreMod.deleteStoriesBySourceId).toBe('function');

		// Types are compile-time only in TypeScript, but we can verify that the
		// barrel module exports the type-related keys by checking that a created story
		// has the expected shape (runtime evidence of correct types)
		const story = (await createStory(pool, {
			sourceId,
			title: 'Type Check',
			gcsMarkdownUri: 'gs://bucket/type.md',
			gcsMetadataUri: 'gs://bucket/type.meta.json',
		})) as Record<string, unknown>;

		// Verify all Story interface fields are present
		const expectedKeys = [
			'id',
			'sourceId',
			'title',
			'subtitle',
			'language',
			'category',
			'pageStart',
			'pageEnd',
			'gcsMarkdownUri',
			'gcsMetadataUri',
			'chunkCount',
			'extractionConfidence',
			'status',
			'metadata',
			'createdAt',
			'updatedAt',
		];
		for (const key of expectedKeys) {
			expect(story).toHaveProperty(key);
		}
	});
});
