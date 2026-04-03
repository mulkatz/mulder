import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_MODULE = resolve(ROOT, 'packages/core/dist/index.js');
const DB_MODULE = resolve(ROOT, 'packages/core/dist/database/index.js');

/**
 * Black-box QA tests for Spec 25: Edge Repository
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: SQL via pg, and
 * TypeScript imports from the database barrel (dist).
 *
 * Requires a running PostgreSQL instance (Docker container `mulder-pg-test`)
 * with migrations applied through 016.
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
const entityIds: string[] = [];

// Dynamically imported repository functions
let createEdge: (...args: unknown[]) => Promise<unknown>;
let upsertEdge: (...args: unknown[]) => Promise<unknown>;
let findEdgeById: (...args: unknown[]) => Promise<unknown>;
let findEdgesBySourceEntityId: (...args: unknown[]) => Promise<unknown>;
let findEdgesByTargetEntityId: (...args: unknown[]) => Promise<unknown>;
let findEdgesByEntityId: (...args: unknown[]) => Promise<unknown>;
let findEdgesByStoryId: (...args: unknown[]) => Promise<unknown>;
let findEdgesByType: (...args: unknown[]) => Promise<unknown>;
let findEdgesBetweenEntities: (...args: unknown[]) => Promise<unknown>;
let _findAllEdges: (...args: unknown[]) => Promise<unknown>;
let countEdges: (...args: unknown[]) => Promise<unknown>;
let updateEdge: (...args: unknown[]) => Promise<unknown>;
let deleteEdge: (...args: unknown[]) => Promise<unknown>;
let deleteEdgesByStoryId: (...args: unknown[]) => Promise<unknown>;
let deleteEdgesBySourceId: (...args: unknown[]) => Promise<unknown>;
let createEntity: (...args: unknown[]) => Promise<unknown>;
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

describe('Spec 25: Edge Repository', () => {
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

		// Dynamically import repository functions from the built database barrel
		const dbMod = await import(DB_MODULE);
		const coreMod = await import(CORE_MODULE);
		createEdge = dbMod.createEdge;
		upsertEdge = dbMod.upsertEdge;
		findEdgeById = dbMod.findEdgeById;
		findEdgesBySourceEntityId = dbMod.findEdgesBySourceEntityId;
		findEdgesByTargetEntityId = dbMod.findEdgesByTargetEntityId;
		findEdgesByEntityId = dbMod.findEdgesByEntityId;
		findEdgesByStoryId = dbMod.findEdgesByStoryId;
		findEdgesByType = dbMod.findEdgesByType;
		findEdgesBetweenEntities = dbMod.findEdgesBetweenEntities;
		_findAllEdges = dbMod.findAllEdges;
		countEdges = dbMod.countEdges;
		updateEdge = dbMod.updateEdge;
		deleteEdge = dbMod.deleteEdge;
		deleteEdgesByStoryId = dbMod.deleteEdgesByStoryId;
		deleteEdgesBySourceId = dbMod.deleteEdgesBySourceId;
		createEntity = dbMod.createEntity;
		createSource = dbMod.createSource;
		createStory = dbMod.createStory;
		deleteStory = dbMod.deleteStory;
		DatabaseError = coreMod.DatabaseError;

		// Clean up test data and create parent source + stories + entities for FK references
		await pool.query('DELETE FROM entity_edges');
		await pool.query('DELETE FROM story_entities');
		await pool.query('DELETE FROM entity_aliases');
		await pool.query('DELETE FROM entities');
		await pool.query('DELETE FROM stories');
		await pool.query('DELETE FROM source_steps');
		await pool.query('DELETE FROM sources');

		const source = (await createSource(pool, {
			filename: 'edge-test-parent.pdf',
			storagePath: 'raw/edge-test-parent.pdf',
			fileHash: `hash_spec25_parent_${Date.now()}`,
			pageCount: 100,
		})) as { id: string };
		sourceId = source.id;

		// Create 3 stories for edge tests
		for (let i = 0; i < 3; i++) {
			const story = (await createStory(pool, {
				sourceId,
				title: `Edge Test Story ${i}`,
				gcsMarkdownUri: `gs://bucket/edge-test/story${i}.md`,
				gcsMetadataUri: `gs://bucket/edge-test/story${i}.meta.json`,
			})) as { id: string };
			storyIds.push(story.id);
		}

		// Create 4 entities for edge tests (A, B, C, D)
		for (let i = 0; i < 4; i++) {
			const entity = (await createEntity(pool, {
				name: `Edge Test Entity ${String.fromCharCode(65 + i)}`,
				type: 'person',
			})) as { id: string };
			entityIds.push(entity.id);
		}
	});

	beforeEach(async () => {
		if (!pgAvailable) return;
		// Clean edges before each test for isolation
		await pool.query('DELETE FROM entity_edges');
	});

	afterAll(async () => {
		if (!pgAvailable) return;
		try {
			await pool.query('DELETE FROM entity_edges');
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

	// ─── QA-01: Edge creation ───

	it('QA-01: createEdge returns EntityEdge with generated UUID and defaults (edgeType=RELATIONSHIP, attributes={})', async () => {
		if (!pgAvailable) return;

		const edge = (await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'works_with',
			storyId: storyIds[0],
			confidence: 0.9,
		})) as Record<string, unknown>;

		// UUID format check
		expect(edge.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(edge.sourceEntityId).toBe(entityIds[0]);
		expect(edge.targetEntityId).toBe(entityIds[1]);
		expect(edge.relationship).toBe('works_with');
		expect(edge.storyId).toBe(storyIds[0]);
		expect(edge.confidence).toBe(0.9);
		expect(edge.edgeType).toBe('RELATIONSHIP');
		expect(edge.attributes).toEqual({});
		expect(edge.analysis).toBeNull();
		expect(edge.createdAt).toBeInstanceOf(Date);

		// Verify in DB via raw SQL
		const dbResult = await pool.query('SELECT COUNT(*) FROM entity_edges WHERE id = $1', [edge.id]);
		expect(Number.parseInt(dbResult.rows[0].count, 10)).toBe(1);
	});

	// ─── QA-02: Edge upsert idempotent ───

	it('QA-02: upsertEdge with same key updates confidence, no duplicate created', async () => {
		if (!pgAvailable) return;

		// Create initial edge
		const initial = (await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'located_at',
			storyId: storyIds[0],
			confidence: 0.8,
		})) as Record<string, unknown>;

		// Upsert with same composite key but different confidence
		const upserted = (await upsertEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'located_at',
			storyId: storyIds[0],
			confidence: 0.95,
		})) as Record<string, unknown>;

		// Should return same edge with updated confidence
		expect(upserted.id).toBe(initial.id);
		expect(upserted.confidence).toBe(0.95);

		// No duplicate
		const countResult = await pool.query(
			'SELECT COUNT(*) FROM entity_edges WHERE source_entity_id = $1 AND target_entity_id = $2 AND relationship = $3',
			[entityIds[0], entityIds[1], 'located_at'],
		);
		expect(Number.parseInt(countResult.rows[0].count, 10)).toBe(1);
	});

	// ─── QA-03: Edge upsert creates new ───

	it('QA-03: upsertEdge with no existing edge creates new edge', async () => {
		if (!pgAvailable) return;

		const edge = (await upsertEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'sighted_at',
			storyId: storyIds[0],
		})) as Record<string, unknown>;

		expect(edge.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(edge.sourceEntityId).toBe(entityIds[0]);
		expect(edge.targetEntityId).toBe(entityIds[1]);
		expect(edge.relationship).toBe('sighted_at');
		expect(edge.storyId).toBe(storyIds[0]);
	});

	// ─── QA-04: Find edge by ID ───

	it('QA-04: findEdgeById returns edge with all fields mapped to camelCase', async () => {
		if (!pgAvailable) return;

		const created = (await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'works_with',
			storyId: storyIds[0],
			confidence: 0.85,
			attributes: { detail: 'test' },
		})) as Record<string, unknown>;

		const found = (await findEdgeById(pool, created.id)) as Record<string, unknown>;

		expect(found).not.toBeNull();
		// Verify camelCase mapping
		expect(found.id).toBe(created.id);
		expect(found.sourceEntityId).toBe(entityIds[0]);
		expect(found.targetEntityId).toBe(entityIds[1]);
		expect(found.relationship).toBe('works_with');
		expect(found.storyId).toBe(storyIds[0]);
		expect(found.confidence).toBe(0.85);
		expect(found.edgeType).toBe('RELATIONSHIP');
		expect(found.attributes).toEqual({ detail: 'test' });
		expect(found.createdAt).toBeInstanceOf(Date);
	});

	// ─── QA-05: Find edge by ID not found ───

	it('QA-05: findEdgeById with non-existent UUID returns null', async () => {
		if (!pgAvailable) return;

		const found = await findEdgeById(pool, '00000000-0000-0000-0000-000000000000');
		expect(found).toBeNull();
	});

	// ─── QA-06: Find edges by source entity ───

	it('QA-06: findEdgesBySourceEntityId returns 3 outgoing edges', async () => {
		if (!pgAvailable) return;

		// Create 3 outgoing edges from entity A
		for (let i = 0; i < 3; i++) {
			await createEdge(pool, {
				sourceEntityId: entityIds[0],
				targetEntityId: entityIds[i + 1],
				relationship: `rel_${i}`,
				storyId: storyIds[0],
			});
		}

		const edges = (await findEdgesBySourceEntityId(pool, entityIds[0])) as unknown[];
		expect(edges).toHaveLength(3);
	});

	// ─── QA-07: Find edges by target entity ───

	it('QA-07: findEdgesByTargetEntityId returns 2 incoming edges', async () => {
		if (!pgAvailable) return;

		// Create 2 edges targeting entity B
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'points_to',
			storyId: storyIds[0],
		});
		await createEdge(pool, {
			sourceEntityId: entityIds[2],
			targetEntityId: entityIds[1],
			relationship: 'also_points_to',
			storyId: storyIds[0],
		});

		const edges = (await findEdgesByTargetEntityId(pool, entityIds[1])) as unknown[];
		expect(edges).toHaveLength(2);
	});

	// ─── QA-08: Find edges by entity (both directions) ───

	it('QA-08: findEdgesByEntityId returns 3 edges total (2 outgoing + 1 incoming)', async () => {
		if (!pgAvailable) return;

		// 2 outgoing from entity A
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'outgoing_1',
			storyId: storyIds[0],
		});
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[2],
			relationship: 'outgoing_2',
			storyId: storyIds[0],
		});
		// 1 incoming to entity A
		await createEdge(pool, {
			sourceEntityId: entityIds[3],
			targetEntityId: entityIds[0],
			relationship: 'incoming_1',
			storyId: storyIds[0],
		});

		const edges = (await findEdgesByEntityId(pool, entityIds[0])) as unknown[];
		expect(edges).toHaveLength(3);
	});

	// ─── QA-09: Find edges by story ───

	it('QA-09: findEdgesByStoryId returns 4 edges for a story', async () => {
		if (!pgAvailable) return;

		// Create 4 edges in story 0
		for (let i = 0; i < 4; i++) {
			await createEdge(pool, {
				sourceEntityId: entityIds[i % 4],
				targetEntityId: entityIds[(i + 1) % 4],
				relationship: `story_rel_${i}`,
				storyId: storyIds[0],
			});
		}

		const edges = (await findEdgesByStoryId(pool, storyIds[0])) as unknown[];
		expect(edges).toHaveLength(4);
	});

	// ─── QA-10: Find edges by type ───

	it('QA-10: findEdgesByType returns 2 POTENTIAL_CONTRADICTION edges', async () => {
		if (!pgAvailable) return;

		// Create 2 POTENTIAL_CONTRADICTION edges
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'contradicts',
			storyId: storyIds[0],
			edgeType: 'POTENTIAL_CONTRADICTION',
		});
		await createEdge(pool, {
			sourceEntityId: entityIds[2],
			targetEntityId: entityIds[3],
			relationship: 'contradicts',
			storyId: storyIds[1],
			edgeType: 'POTENTIAL_CONTRADICTION',
		});
		// Create a RELATIONSHIP edge (should NOT be returned)
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[2],
			relationship: 'works_with',
			storyId: storyIds[0],
		});

		const edges = (await findEdgesByType(pool, 'POTENTIAL_CONTRADICTION')) as unknown[];
		expect(edges).toHaveLength(2);
	});

	// ─── QA-11: Find edges between entities ───

	it('QA-11: findEdgesBetweenEntities returns all edges between A and B regardless of direction', async () => {
		if (!pgAvailable) return;

		// A -> B
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'a_to_b',
			storyId: storyIds[0],
		});
		// B -> A
		await createEdge(pool, {
			sourceEntityId: entityIds[1],
			targetEntityId: entityIds[0],
			relationship: 'b_to_a',
			storyId: storyIds[0],
		});
		// A -> C (should NOT be returned)
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[2],
			relationship: 'a_to_c',
			storyId: storyIds[0],
		});

		const edges = (await findEdgesBetweenEntities(pool, entityIds[0], entityIds[1])) as unknown[];
		expect(edges).toHaveLength(2);
	});

	// ─── QA-12: Update edge ───

	it('QA-12: updateEdge returns updated edge with new values', async () => {
		if (!pgAvailable) return;

		const created = (await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'works_with',
			storyId: storyIds[0],
			confidence: 0.9,
		})) as Record<string, unknown>;

		const updated = (await updateEdge(pool, created.id, {
			confidence: 0.5,
			analysis: { resolution: 'dismissed' },
		})) as Record<string, unknown>;

		expect(updated.id).toBe(created.id);
		expect(updated.confidence).toBe(0.5);
		expect(updated.analysis).toEqual({ resolution: 'dismissed' });
		// Unchanged fields persist
		expect(updated.relationship).toBe('works_with');
		expect(updated.sourceEntityId).toBe(entityIds[0]);
	});

	// ─── QA-13: Update edge not found ───

	it('QA-13: updateEdge with non-existent ID throws DatabaseError with DB_NOT_FOUND', async () => {
		if (!pgAvailable) return;

		try {
			await updateEdge(pool, '00000000-0000-0000-0000-000000000000', {
				confidence: 0.5,
			});
			expect.fail('Should have thrown DatabaseError');
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(DatabaseError);
			expect((err as Record<string, unknown>).code).toBe('DB_NOT_FOUND');
		}
	});

	// ─── QA-14: Delete edge ───

	it('QA-14: deleteEdge returns true and edge is gone', async () => {
		if (!pgAvailable) return;

		const created = (await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'to_delete',
			storyId: storyIds[0],
		})) as Record<string, unknown>;

		const result = await deleteEdge(pool, created.id);
		expect(result).toBe(true);

		const found = await findEdgeById(pool, created.id);
		expect(found).toBeNull();
	});

	// ─── QA-15: Delete edges by story ───

	it('QA-15: deleteEdgesByStoryId returns 3 and all edges for that story are deleted', async () => {
		if (!pgAvailable) return;

		// Create 3 edges in story 1
		for (let i = 0; i < 3; i++) {
			await createEdge(pool, {
				sourceEntityId: entityIds[i % 3],
				targetEntityId: entityIds[(i + 1) % 3],
				relationship: `story_del_${i}`,
				storyId: storyIds[1],
			});
		}
		// Create 1 edge in story 0 (should NOT be deleted)
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'other_story',
			storyId: storyIds[0],
		});

		const count = await deleteEdgesByStoryId(pool, storyIds[1]);
		expect(count).toBe(3);

		// Verify story 1 edges are gone
		const remaining = (await findEdgesByStoryId(pool, storyIds[1])) as unknown[];
		expect(remaining).toHaveLength(0);

		// Verify story 0 edge survives
		const otherEdges = (await findEdgesByStoryId(pool, storyIds[0])) as unknown[];
		expect(otherEdges).toHaveLength(1);
	});

	// ─── QA-16: Delete edges by source ───

	it("QA-16: deleteEdgesBySourceId returns 5 and all edges for that source's stories are deleted", async () => {
		if (!pgAvailable) return;

		// Create edges across multiple stories from sourceId
		// Story 0: 3 edges
		for (let i = 0; i < 3; i++) {
			await createEdge(pool, {
				sourceEntityId: entityIds[i % 3],
				targetEntityId: entityIds[(i + 1) % 3],
				relationship: `src_del_s0_${i}`,
				storyId: storyIds[0],
			});
		}
		// Story 1: 2 edges
		for (let i = 0; i < 2; i++) {
			await createEdge(pool, {
				sourceEntityId: entityIds[i],
				targetEntityId: entityIds[i + 1],
				relationship: `src_del_s1_${i}`,
				storyId: storyIds[1],
			});
		}

		const count = await deleteEdgesBySourceId(pool, sourceId);
		expect(count).toBe(5);

		// Verify all edges are gone
		const totalResult = await pool.query('SELECT COUNT(*) FROM entity_edges');
		expect(Number.parseInt(totalResult.rows[0].count, 10)).toBe(0);
	});

	// ─── QA-17: Count edges with filter ───

	it('QA-17: countEdges with edgeType filter returns correct count', async () => {
		if (!pgAvailable) return;

		// Create 3 RELATIONSHIP edges
		for (let i = 0; i < 3; i++) {
			await createEdge(pool, {
				sourceEntityId: entityIds[i % 3],
				targetEntityId: entityIds[(i + 1) % 3],
				relationship: `count_rel_${i}`,
				storyId: storyIds[0],
			});
		}
		// Create 2 POTENTIAL_CONTRADICTION edges
		for (let i = 0; i < 2; i++) {
			await createEdge(pool, {
				sourceEntityId: entityIds[i],
				targetEntityId: entityIds[i + 2],
				relationship: `count_contra_${i}`,
				storyId: storyIds[0],
				edgeType: 'POTENTIAL_CONTRADICTION',
			});
		}

		const relCount = await countEdges(pool, {
			edgeType: 'RELATIONSHIP',
		});
		expect(relCount).toBe(3);

		const contraCount = await countEdges(pool, {
			edgeType: 'POTENTIAL_CONTRADICTION',
		});
		expect(contraCount).toBe(2);
	});

	// ─── QA-18: Cascade: delete story removes edges ───

	it('QA-18: deleting a story cascades and removes its edges (ON DELETE CASCADE)', async () => {
		if (!pgAvailable) return;

		// Create edges in story 2
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'cascade_test_1',
			storyId: storyIds[2],
		});
		await createEdge(pool, {
			sourceEntityId: entityIds[2],
			targetEntityId: entityIds[3],
			relationship: 'cascade_test_2',
			storyId: storyIds[2],
		});

		// Create an edge in another story (should survive)
		await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[2],
			relationship: 'survivor',
			storyId: storyIds[0],
		});

		// Delete story 2 via the story repository
		await deleteStory(pool, storyIds[2]);

		// Verify edges for story 2 are gone
		const storyEdges = (await findEdgesByStoryId(pool, storyIds[2])) as unknown[];
		expect(storyEdges).toHaveLength(0);

		// Verify edge in story 0 survives
		const survivorEdges = (await findEdgesByStoryId(pool, storyIds[0])) as unknown[];
		expect(survivorEdges).toHaveLength(1);

		// Recreate story 2 for subsequent tests
		const newStory = (await createStory(pool, {
			sourceId,
			title: 'Edge Test Story 2 (recreated)',
			gcsMarkdownUri: 'gs://bucket/edge-test/story2-recreated.md',
			gcsMetadataUri: 'gs://bucket/edge-test/story2-recreated.meta.json',
		})) as { id: string };
		storyIds[2] = newStory.id;
	});

	// ─── QA-19: Edge with null story_id ───

	it('QA-19: createEdge with no storyId creates edge with null storyId', async () => {
		if (!pgAvailable) return;

		const edge = (await createEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'analysis_link',
			edgeType: 'CONFIRMED_CONTRADICTION',
		})) as Record<string, unknown>;

		expect(edge.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(edge.storyId).toBeNull();
		expect(edge.edgeType).toBe('CONFIRMED_CONTRADICTION');
		expect(edge.relationship).toBe('analysis_link');

		// Verify via raw SQL
		const dbResult = await pool.query('SELECT story_id FROM entity_edges WHERE id = $1', [edge.id]);
		expect(dbResult.rows[0].story_id).toBeNull();
	});

	// ─── QA-20: Different edge_types coexist ───

	it('QA-20: upsertEdge with different edge_type creates second edge, both coexist', async () => {
		if (!pgAvailable) return;

		// Create a RELATIONSHIP edge between A-B
		const rel = (await upsertEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'located_at',
			storyId: storyIds[0],
			edgeType: 'RELATIONSHIP',
		})) as Record<string, unknown>;

		// Upsert a POTENTIAL_CONTRADICTION edge with same entities + relationship + story
		const contra = (await upsertEdge(pool, {
			sourceEntityId: entityIds[0],
			targetEntityId: entityIds[1],
			relationship: 'located_at',
			storyId: storyIds[0],
			edgeType: 'POTENTIAL_CONTRADICTION',
		})) as Record<string, unknown>;

		// Should be different edges
		expect(rel.id).not.toBe(contra.id);
		expect(rel.edgeType).toBe('RELATIONSHIP');
		expect(contra.edgeType).toBe('POTENTIAL_CONTRADICTION');

		// Both should exist
		const between = (await findEdgesBetweenEntities(pool, entityIds[0], entityIds[1])) as unknown[];
		expect(between).toHaveLength(2);
	});
});
