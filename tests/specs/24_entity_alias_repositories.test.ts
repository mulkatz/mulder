import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');

/**
 * Black-box QA tests for Spec 24: Entity + Alias Repositories
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: SQL via pg, and
 * TypeScript imports from the database barrel (dist).
 *
 * Requires a running PostgreSQL instance (Docker container `mulder-pg-test`)
 * with migrations applied through 015.
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
const storyIds: string[] = [];

// Dynamically imported repository functions
let createEntity: (...args: unknown[]) => Promise<unknown>;
let upsertEntityByNameType: (...args: unknown[]) => Promise<unknown>;
let findEntityById: (...args: unknown[]) => Promise<unknown>;
let findAllEntities: (...args: unknown[]) => Promise<unknown>;
let countEntities: (...args: unknown[]) => Promise<unknown>;
let updateEntity: (...args: unknown[]) => Promise<unknown>;
let deleteEntity: (...args: unknown[]) => Promise<unknown>;
let createEntityAlias: (...args: unknown[]) => Promise<unknown>;
let findAliasesByEntityId: (...args: unknown[]) => Promise<unknown>;
let findEntityByAlias: (...args: unknown[]) => Promise<unknown>;
let linkStoryEntity: (...args: unknown[]) => Promise<unknown>;
let findEntitiesByStoryId: (...args: unknown[]) => Promise<unknown>;
let findStoriesByEntityId: (...args: unknown[]) => Promise<unknown>;
let deleteStoryEntitiesByStoryId: (...args: unknown[]) => Promise<unknown>;
let createSource: (...args: unknown[]) => Promise<unknown>;
let createStory: (...args: unknown[]) => Promise<unknown>;
let deleteStory: (...args: unknown[]) => Promise<unknown>;
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

describe('Spec 24: Entity + Alias Repositories', () => {
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

		// Ensure migrations are applied (including 015)
		const migrateResult = spawnSync('node', [CLI, 'db', 'migrate', EXAMPLE_CONFIG], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 30000,
			env: { ...process.env, PGPASSWORD: 'mulder' },
		});
		if (migrateResult.status !== 0) {
			throw new Error(`Migration failed: ${migrateResult.stdout} ${migrateResult.stderr}`);
		}

		// Dynamically import repository functions from the built database barrel
		const dbMod = await import(DB_MODULE);
		const coreMod = await import(CORE_MODULE);
		createEntity = dbMod.createEntity;
		upsertEntityByNameType = dbMod.upsertEntityByNameType;
		findEntityById = dbMod.findEntityById;
		findAllEntities = dbMod.findAllEntities;
		countEntities = dbMod.countEntities;
		updateEntity = dbMod.updateEntity;
		deleteEntity = dbMod.deleteEntity;
		createEntityAlias = dbMod.createEntityAlias;
		findAliasesByEntityId = dbMod.findAliasesByEntityId;
		findEntityByAlias = dbMod.findEntityByAlias;
		linkStoryEntity = dbMod.linkStoryEntity;
		findEntitiesByStoryId = dbMod.findEntitiesByStoryId;
		findStoriesByEntityId = dbMod.findStoriesByEntityId;
		deleteStoryEntitiesByStoryId = dbMod.deleteStoryEntitiesByStoryId;
		createSource = dbMod.createSource;
		createStory = dbMod.createStory;
		deleteStory = dbMod.deleteStory;
		DatabaseError = coreMod.DatabaseError;

		// Clean up test data and create parent source + stories for FK references
		await pool.query('DELETE FROM story_entities');
		await pool.query('DELETE FROM entity_aliases');
		await pool.query('DELETE FROM entities');
		await pool.query('DELETE FROM stories');
		await pool.query('DELETE FROM source_steps');
		await pool.query('DELETE FROM sources');

		const source = (await createSource(pool, {
			filename: 'entity-test-parent.pdf',
			storagePath: 'raw/entity-test-parent.pdf',
			fileHash: `hash_spec24_parent_${Date.now()}`,
			pageCount: 100,
		})) as { id: string };
		sourceId = source.id;

		// Create 3 stories for story-entity junction tests
		for (let i = 0; i < 3; i++) {
			const story = (await createStory(pool, {
				sourceId,
				title: `Entity Test Story ${i}`,
				gcsMarkdownUri: `gs://bucket/entity-test/story${i}.md`,
				gcsMetadataUri: `gs://bucket/entity-test/story${i}.meta.json`,
			})) as { id: string };
			storyIds.push(story.id);
		}
	});

	beforeEach(async () => {
		if (!pgAvailable) return;
		// Clean entity-related tables before each test for isolation
		await pool.query('DELETE FROM story_entities');
		await pool.query('DELETE FROM entity_aliases');
		await pool.query('DELETE FROM entities');
	});

	afterAll(async () => {
		if (!pgAvailable) return;
		try {
			await pool.query('DELETE FROM story_entities');
			await pool.query('DELETE FROM entity_aliases');
			await pool.query('DELETE FROM entities');
			await pool.query('DELETE FROM stories');
			await pool.query('DELETE FROM source_steps');
			await pool.query('DELETE FROM sources');
		} catch {
			// Tables may not exist if another test suite dropped them
		}
		await pool.end();
	});

	// ─── QA-01: Entity creation ───

	it('QA-01: createEntity returns Entity with generated UUID and defaults (sourceCount=0, taxonomyStatus=auto, attributes={})', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'UFO Sighting',
			type: 'event',
		})) as Record<string, unknown>;

		// UUID format check
		expect(entity.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(entity.name).toBe('UFO Sighting');
		expect(entity.type).toBe('event');
		expect(entity.sourceCount).toBe(0);
		expect(entity.taxonomyStatus).toBe('auto');
		expect(entity.attributes).toEqual({});
		expect(entity.canonicalId).toBeNull();
		expect(entity.corroborationScore).toBeNull();
		expect(entity.createdAt).toBeInstanceOf(Date);
		expect(entity.updatedAt).toBeInstanceOf(Date);

		// Verify in DB via raw SQL
		const dbResult = await pool.query('SELECT COUNT(*) FROM entities WHERE id = $1', [entity.id]);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(1);
	});

	// ─── QA-02: Entity idempotent upsert ───

	it('QA-02: upsertEntityByNameType returns existing entity when name+type already exists, no duplicate created', async () => {
		if (!pgAvailable) return;

		// First create
		const first = (await upsertEntityByNameType(pool, {
			name: 'Area 51',
			type: 'location',
		})) as Record<string, unknown>;

		expect(first.id).toBeDefined();
		expect(first.name).toBe('Area 51');
		expect(first.type).toBe('location');

		// Second upsert with same name+type
		const second = (await upsertEntityByNameType(pool, {
			name: 'Area 51',
			type: 'location',
		})) as Record<string, unknown>;

		// Should return existing entity, same ID
		expect(second.id).toBe(first.id);

		// Verify no duplicate in DB
		const countResult = await pool.query("SELECT COUNT(*) FROM entities WHERE name = 'Area 51' AND type = 'location'");
		expect(Number.parseInt(countResult.rows[0].count, 10)).toBe(1);
	});

	// ─── QA-03: Entity findById ───

	it('QA-03: findEntityById returns entity with all fields mapped to camelCase', async () => {
		if (!pgAvailable) return;

		const created = (await createEntity(pool, {
			name: 'Bob Lazar',
			type: 'person',
			attributes: { role: 'whistleblower' },
		})) as Record<string, unknown>;

		const found = (await findEntityById(pool, created.id)) as Record<string, unknown>;

		expect(found).not.toBeNull();
		expect(found.id).toBe(created.id);
		expect(found.name).toBe('Bob Lazar');
		expect(found.type).toBe('person');
		expect(found.canonicalId).toBeNull();
		expect((found.attributes as Record<string, unknown>).role).toBe('whistleblower');
		expect(found.sourceCount).toBe(0);
		expect(found.taxonomyStatus).toBe('auto');
		expect(found.corroborationScore).toBeNull();
		expect(found.createdAt).toBeInstanceOf(Date);
		expect(found.updatedAt).toBeInstanceOf(Date);
	});

	// ─── QA-04: Entity findById not found ───

	it('QA-04: findEntityById returns null for a non-existent UUID', async () => {
		if (!pgAvailable) return;

		const found = await findEntityById(pool, '00000000-0000-0000-0000-000000000000');
		expect(found).toBeNull();
	});

	// ─── QA-05: Entity update ───

	it('QA-05: updateEntity returns updated entity with changed name and corroborationScore, updatedAt changed', async () => {
		if (!pgAvailable) return;

		const created = (await createEntity(pool, {
			name: 'Original Name',
			type: 'event',
		})) as Record<string, unknown>;

		// Small delay to ensure updatedAt differs
		await new Promise((r) => setTimeout(r, 50));

		const updated = (await updateEntity(pool, created.id, {
			name: 'Updated Name',
			corroborationScore: 0.8,
		})) as Record<string, unknown>;

		expect(updated.id).toBe(created.id);
		expect(updated.name).toBe('Updated Name');
		expect(updated.corroborationScore).toBeCloseTo(0.8);
		expect(updated.type).toBe('event'); // unchanged
		expect((updated.updatedAt as Date).getTime()).toBeGreaterThan((created.updatedAt as Date).getTime());
	});

	// ─── QA-06: Entity update not found ───

	it('QA-06: updateEntity throws DatabaseError with DB_NOT_FOUND for non-existent ID', async () => {
		if (!pgAvailable) return;

		try {
			await updateEntity(pool, '00000000-0000-0000-0000-000000000000', {
				name: 'X',
			});
			expect.fail('Should have thrown');
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(DatabaseError);
			expect((error as { code: string }).code).toBe('DB_NOT_FOUND');
		}
	});

	// ─── QA-07: Entity filter by type ───

	it('QA-07: findAllEntities with type filter returns only matching entities', async () => {
		if (!pgAvailable) return;

		// Create entities of different types
		await createEntity(pool, { name: 'John Doe', type: 'person' });
		await createEntity(pool, { name: 'Jane Doe', type: 'person' });
		await createEntity(pool, { name: 'Roswell', type: 'location' });
		await createEntity(pool, { name: 'UFO Crash', type: 'event' });

		const persons = (await findAllEntities(pool, {
			type: 'person',
		})) as Array<Record<string, unknown>>;

		expect(persons).toHaveLength(2);
		for (const p of persons) {
			expect(p.type).toBe('person');
		}
	});

	// ─── QA-08: Entity count with filter ───

	it('QA-08: countEntities with type filter returns correct count', async () => {
		if (!pgAvailable) return;

		await createEntity(pool, { name: 'Place A', type: 'location' });
		await createEntity(pool, { name: 'Place B', type: 'location' });
		await createEntity(pool, { name: 'Place C', type: 'location' });
		await createEntity(pool, { name: 'Person A', type: 'person' });

		const locationCount = (await countEntities(pool, {
			type: 'location',
		})) as number;
		expect(locationCount).toBe(3);

		const totalCount = (await countEntities(pool)) as number;
		expect(totalCount).toBe(4);
	});

	// ─── QA-09: Entity delete ───

	it('QA-09: deleteEntity returns true and entity is gone', async () => {
		if (!pgAvailable) return;

		const created = (await createEntity(pool, {
			name: 'Delete Me',
			type: 'event',
		})) as Record<string, unknown>;

		const deleted = await deleteEntity(pool, created.id);
		expect(deleted).toBe(true);

		const found = await findEntityById(pool, created.id as string);
		expect(found).toBeNull();

		// Verify in DB via raw SQL
		const dbResult = await pool.query('SELECT COUNT(*) FROM entities WHERE id = $1', [created.id]);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(0);
	});

	// ─── QA-10: Alias creation ───

	it('QA-10: createEntityAlias returns alias with generated UUID', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'Roswell Incident',
			type: 'event',
		})) as Record<string, unknown>;

		const alias = (await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Roswell',
			source: 'doc-1',
		})) as Record<string, unknown>;

		expect(alias.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(alias.entityId).toBe(entity.id);
		expect(alias.alias).toBe('Roswell');
		expect(alias.source).toBe('doc-1');
	});

	// ─── QA-11: Alias idempotent ───

	it('QA-11: createEntityAlias with same entityId+alias returns existing alias, no error', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'Area 51 Base',
			type: 'location',
		})) as Record<string, unknown>;

		const _first = (await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Groom Lake',
			source: 'doc-1',
		})) as Record<string, unknown>;

		// Same alias+entityId again
		const second = (await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Groom Lake',
			source: 'doc-2',
		})) as Record<string, unknown>;

		// Should return an alias (either existing or the new one), no error
		expect(second).toBeDefined();
		expect(second.alias).toBe('Groom Lake');
		expect(second.entityId).toBe(entity.id);

		// Verify no duplicate
		const dbResult = await pool.query('SELECT COUNT(*) FROM entity_aliases WHERE entity_id = $1 AND alias = $2', [
			entity.id,
			'Groom Lake',
		]);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(1);
	});

	// ─── QA-12: Find aliases by entity ───

	it('QA-12: findAliasesByEntityId returns 3 aliases sorted by alias', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'Nevada Test Site',
			type: 'location',
		})) as Record<string, unknown>;

		// Create 3 aliases in non-alphabetical order
		await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'NTS',
			source: 'doc-1',
		});
		await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Area 51 Adjacent',
			source: 'doc-2',
		});
		await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Mercury',
			source: 'doc-3',
		});

		const aliases = (await findAliasesByEntityId(pool, entity.id)) as Array<Record<string, unknown>>;

		expect(aliases).toHaveLength(3);
		// Should be sorted by alias alphabetically
		expect(aliases[0].alias).toBe('Area 51 Adjacent');
		expect(aliases[1].alias).toBe('Mercury');
		expect(aliases[2].alias).toBe('NTS');
	});

	// ─── QA-13: Find entity by alias ───

	it('QA-13: findEntityByAlias returns the linked entity', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'Roswell Crash Site',
			type: 'location',
		})) as Record<string, unknown>;

		await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Roswell',
		});

		const found = (await findEntityByAlias(pool, 'Roswell')) as Record<string, unknown> | null;

		expect(found).not.toBeNull();
		expect((found as Record<string, unknown>).id).toBe(entity.id);
		expect((found as Record<string, unknown>).name).toBe('Roswell Crash Site');
		expect((found as Record<string, unknown>).type).toBe('location');
	});

	// ─── QA-14: Story-entity link ───

	it('QA-14: linkStoryEntity creates junction row', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'Close Encounter',
			type: 'event',
		})) as Record<string, unknown>;

		await linkStoryEntity(pool, {
			storyId: storyIds[0],
			entityId: entity.id,
			confidence: 0.9,
			mentionCount: 3,
		});

		// Verify junction row exists in DB
		const dbResult = await pool.query('SELECT * FROM story_entities WHERE story_id = $1 AND entity_id = $2', [
			storyIds[0],
			entity.id,
		]);
		expect(dbResult.rows).toHaveLength(1);
		expect(Number.parseFloat(dbResult.rows[0].confidence)).toBeCloseTo(0.9);
		expect(dbResult.rows[0].mention_count).toBe(3);
	});

	// ─── QA-15: Story-entity idempotent upsert ───

	it('QA-15: linkStoryEntity updates confidence and mentionCount on re-link, no duplicate', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'Alien Contact',
			type: 'event',
		})) as Record<string, unknown>;

		// First link
		await linkStoryEntity(pool, {
			storyId: storyIds[0],
			entityId: entity.id,
			confidence: 0.9,
			mentionCount: 3,
		});

		// Re-link with updated values
		await linkStoryEntity(pool, {
			storyId: storyIds[0],
			entityId: entity.id,
			confidence: 0.95,
			mentionCount: 5,
		});

		// Verify no duplicate and values updated
		const dbResult = await pool.query('SELECT * FROM story_entities WHERE story_id = $1 AND entity_id = $2', [
			storyIds[0],
			entity.id,
		]);
		expect(dbResult.rows).toHaveLength(1);
		expect(Number.parseFloat(dbResult.rows[0].confidence)).toBeCloseTo(0.95);
		expect(dbResult.rows[0].mention_count).toBe(5);
	});

	// ─── QA-16: Find entities by story ───

	it('QA-16: findEntitiesByStoryId returns 3 entities with confidence and mentionCount', async () => {
		if (!pgAvailable) return;

		// Create 3 entities and link them to the same story
		const entities: Record<string, unknown>[] = [];
		for (let i = 0; i < 3; i++) {
			const entity = (await createEntity(pool, {
				name: `Entity ${i}`,
				type: 'person',
			})) as Record<string, unknown>;
			entities.push(entity);
			await linkStoryEntity(pool, {
				storyId: storyIds[0],
				entityId: entity.id,
				confidence: 0.7 + i * 0.1,
				mentionCount: i + 1,
			});
		}

		const found = (await findEntitiesByStoryId(pool, storyIds[0])) as Array<Record<string, unknown>>;

		expect(found).toHaveLength(3);

		// Each result should have entity fields + junction metadata
		for (const item of found) {
			expect(item).toHaveProperty('id');
			expect(item).toHaveProperty('name');
			expect(item).toHaveProperty('type');
			expect(item).toHaveProperty('confidence');
			expect(item).toHaveProperty('mentionCount');
		}
	});

	// ─── QA-17: Find stories by entity ───

	it('QA-17: findStoriesByEntityId returns 2 stories with junction data', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'Shared Entity',
			type: 'organization',
		})) as Record<string, unknown>;

		// Link entity to 2 different stories
		await linkStoryEntity(pool, {
			storyId: storyIds[0],
			entityId: entity.id,
			confidence: 0.85,
			mentionCount: 2,
		});
		await linkStoryEntity(pool, {
			storyId: storyIds[1],
			entityId: entity.id,
			confidence: 0.72,
			mentionCount: 1,
		});

		const found = (await findStoriesByEntityId(pool, entity.id)) as Array<Record<string, unknown>>;

		expect(found).toHaveLength(2);

		// Each result should have story fields + junction metadata
		for (const item of found) {
			expect(item).toHaveProperty('id');
			expect(item).toHaveProperty('title');
			expect(item).toHaveProperty('confidence');
			expect(item).toHaveProperty('mentionCount');
		}
	});

	// ─── QA-18: Delete story entities by story ───

	it('QA-18: deleteStoryEntitiesByStoryId deletes all 3 junction rows, entities still exist', async () => {
		if (!pgAvailable) return;

		// Create 3 entities and link them to the same story
		const entityIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const entity = (await createEntity(pool, {
				name: `Cleanup Entity ${i}`,
				type: 'event',
			})) as Record<string, unknown>;
			entityIds.push(entity.id as string);
			await linkStoryEntity(pool, {
				storyId: storyIds[0],
				entityId: entity.id,
				confidence: 0.5,
				mentionCount: 1,
			});
		}

		// Verify 3 junction rows exist
		const beforeResult = await pool.query('SELECT COUNT(*) FROM story_entities WHERE story_id = $1', [storyIds[0]]);
		expect(Number.parseInt(beforeResult.rows[0].count, 10)).toBe(3);

		// Delete all junction rows for this story
		await deleteStoryEntitiesByStoryId(pool, storyIds[0]);

		// Verify junction rows are gone
		const afterResult = await pool.query('SELECT COUNT(*) FROM story_entities WHERE story_id = $1', [storyIds[0]]);
		expect(Number.parseInt(afterResult.rows[0].count, 10)).toBe(0);

		// Verify entities still exist
		for (const entityId of entityIds) {
			const entity = await findEntityById(pool, entityId);
			expect(entity).not.toBeNull();
		}
	});

	// ─── QA-19: Cascade: delete entity removes aliases ───

	it('QA-19: deleteEntity cascades to remove all aliases (ON DELETE CASCADE)', async () => {
		if (!pgAvailable) return;

		const entity = (await createEntity(pool, {
			name: 'Cascade Test Entity',
			type: 'person',
		})) as Record<string, unknown>;

		// Add aliases
		await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Alias A',
		});
		await createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Alias B',
		});

		// Verify aliases exist
		const aliasesBefore = await pool.query('SELECT COUNT(*) FROM entity_aliases WHERE entity_id = $1', [entity.id]);
		expect(Number.parseInt(aliasesBefore.rows[0].count, 10)).toBe(2);

		// Delete entity
		const deleted = await deleteEntity(pool, entity.id);
		expect(deleted).toBe(true);

		// Verify entity is gone
		const entityGone = await findEntityById(pool, entity.id as string);
		expect(entityGone).toBeNull();

		// Verify aliases are gone (cascade)
		const aliasesAfter = await pool.query('SELECT COUNT(*) FROM entity_aliases WHERE entity_id = $1', [entity.id]);
		expect(Number.parseInt(aliasesAfter.rows[0].count, 10)).toBe(0);
	});

	// ─── QA-20: Cascade: delete story removes junction ───

	it('QA-20: deleting a story cascades to remove story_entities junction rows (ON DELETE CASCADE)', async () => {
		if (!pgAvailable) return;

		// Create a dedicated story for this test (so we can delete it without affecting other tests)
		const story = (await createStory(pool, {
			sourceId,
			title: 'Cascade Delete Story',
			gcsMarkdownUri: 'gs://bucket/cascade-test.md',
			gcsMetadataUri: 'gs://bucket/cascade-test.meta.json',
		})) as Record<string, unknown>;

		const entity = (await createEntity(pool, {
			name: 'Cascade Junction Entity',
			type: 'event',
		})) as Record<string, unknown>;

		// Link entity to story
		await linkStoryEntity(pool, {
			storyId: story.id,
			entityId: entity.id,
			confidence: 0.9,
			mentionCount: 2,
		});

		// Verify junction row exists
		const junctionBefore = await pool.query(
			'SELECT COUNT(*) FROM story_entities WHERE story_id = $1 AND entity_id = $2',
			[story.id, entity.id],
		);
		expect(Number.parseInt(junctionBefore.rows[0].count, 10)).toBe(1);

		// Delete story via story repo
		const deleted = await deleteStory(pool, story.id);
		expect(deleted).toBe(true);

		// Verify junction row is gone (cascade from story deletion)
		const junctionAfter = await pool.query('SELECT COUNT(*) FROM story_entities WHERE story_id = $1', [story.id]);
		expect(Number.parseInt(junctionAfter.rows[0].count, 10)).toBe(0);

		// Entity should still exist (cascade is only on story_id FK)
		const entityStill = await findEntityById(pool, entity.id as string);
		expect(entityStill).not.toBeNull();
	});
});
