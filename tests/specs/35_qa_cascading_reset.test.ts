import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

/**
 * QA Gate — Cascading Reset (QA-3)
 *
 * Seeds the database with a complete data chain via SQL INSERTs, then tests
 * each reset path by calling `SELECT reset_pipeline_step()` directly.
 *
 * QA-12: Extract reset cascades correctly
 * QA-13: Segment reset cascades correctly
 * QA-14: Enrich reset cascades correctly
 * QA-15: Embed reset cascades correctly
 * QA-16: Graph reset cascades correctly
 * QA-17: GC removes orphaned entities
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = '00000000-0000-0000-0000-000000000099';
const STORY_ID_1 = '00000000-0000-0000-0000-000000000101';
const STORY_ID_2 = '00000000-0000-0000-0000-000000000102';
const ENTITY_ID_1 = '00000000-0000-0000-0000-000000000201';
const ENTITY_ID_2 = '00000000-0000-0000-0000-000000000202';
const ENTITY_ID_3 = '00000000-0000-0000-0000-000000000203'; // will become orphan
const ALIAS_ID_1 = '00000000-0000-0000-0000-000000000301';
const EDGE_ID_1 = '00000000-0000-0000-0000-000000000401';
const CHUNK_ID_1 = '00000000-0000-0000-0000-000000000501';
const CHUNK_ID_2 = '00000000-0000-0000-0000-000000000502';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function runSql(sql: string): string {
	try {
		const result = execFileSync(
			'docker',
			['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-t', '-A', '-c', sql],
			{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		return (result ?? '').trim();
	} catch (error: unknown) {
		const err = error as { stderr?: string; status?: number };
		throw new Error(`psql failed (exit ${err.status}): ${err.stderr}`);
	}
}

function isPgAvailable(): boolean {
	try {
		execFileSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', PG_USER], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return true;
	} catch {
		return false;
	}
}

function cleanTestData(): void {
	runSql(
		'DELETE FROM story_entities; DELETE FROM entity_edges; DELETE FROM entity_aliases; ' +
			'DELETE FROM entities; DELETE FROM chunks; DELETE FROM stories; ' +
			'DELETE FROM source_steps; DELETE FROM sources;',
	);
}

function countRows(table: string, where?: string): number {
	const sql = where ? `SELECT COUNT(*) FROM ${table} WHERE ${where};` : `SELECT COUNT(*) FROM ${table};`;
	return Number.parseInt(runSql(sql), 10);
}

/**
 * Seed a complete data chain: source → stories → entities → aliases → story_entities → edges → chunks → source_steps.
 * This represents a fully processed source through graph step.
 */
function seedFullDataChain(): void {
	// Source
	runSql(
		`INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, status)
		 VALUES ('${SOURCE_ID}', 'qa-test.pdf', 'raw/${SOURCE_ID}/original.pdf', 'hash_qa_test', 10, true, 'segmented');`,
	);

	// Stories
	runSql(
		`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${STORY_ID_1}', '${SOURCE_ID}', 'Story One', 'gs://b/s/${STORY_ID_1}.md', 'gs://b/s/${STORY_ID_1}.meta.json', 'enriched');`,
	);
	runSql(
		`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status)
		 VALUES ('${STORY_ID_2}', '${SOURCE_ID}', 'Story Two', 'gs://b/s/${STORY_ID_2}.md', 'gs://b/s/${STORY_ID_2}.meta.json', 'enriched');`,
	);

	// Entities
	runSql(
		`INSERT INTO entities (id, name, type) VALUES
		 ('${ENTITY_ID_1}', 'Entity One', 'person'),
		 ('${ENTITY_ID_2}', 'Entity Two', 'location'),
		 ('${ENTITY_ID_3}', 'Orphan Entity', 'organization');`,
	);

	// Entity aliases
	runSql(`INSERT INTO entity_aliases (id, entity_id, alias) VALUES ('${ALIAS_ID_1}', '${ENTITY_ID_1}', 'E1 Alias');`);

	// Story-entity links
	runSql(
		`INSERT INTO story_entities (story_id, entity_id, confidence) VALUES
		 ('${STORY_ID_1}', '${ENTITY_ID_1}', 0.9),
		 ('${STORY_ID_1}', '${ENTITY_ID_2}', 0.8),
		 ('${STORY_ID_2}', '${ENTITY_ID_2}', 0.85);`,
	);
	// Note: ENTITY_ID_3 has NO story_entities links → will become orphan

	// Entity edges
	runSql(
		`INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, story_id)
		 VALUES ('${EDGE_ID_1}', '${ENTITY_ID_1}', '${ENTITY_ID_2}', 'mentioned_with', '${STORY_ID_1}');`,
	);

	// Chunks (with mock embeddings)
	runSql(
		`INSERT INTO chunks (id, story_id, content, chunk_index) VALUES
		 ('${CHUNK_ID_1}', '${STORY_ID_1}', 'Chunk one content for testing', 0),
		 ('${CHUNK_ID_2}', '${STORY_ID_2}', 'Chunk two content for testing', 0);`,
	);

	// Source steps
	runSql(
		`INSERT INTO source_steps (source_id, step_name, status) VALUES
		 ('${SOURCE_ID}', 'ingest', 'completed'),
		 ('${SOURCE_ID}', 'extract', 'completed'),
		 ('${SOURCE_ID}', 'segment', 'completed'),
		 ('${SOURCE_ID}', 'enrich', 'completed'),
		 ('${SOURCE_ID}', 'embed', 'completed'),
		 ('${SOURCE_ID}', 'graph', 'completed');`,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 33 — QA-3: Cascading Reset', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = isPgAvailable();
		if (!pgAvailable) {
			console.warn(
				'SKIP: PostgreSQL container not available. Start with:\n' +
					'  docker run -d --name mulder-pg-test -e POSTGRES_USER=mulder ' +
					'-e POSTGRES_PASSWORD=mulder -e POSTGRES_DB=mulder -p 5432:5432 pgvector/pgvector:pg17',
			);
			return;
		}

		// Run migrations
		const { exitCode, stdout, stderr } = runCli(['db', 'migrate', EXAMPLE_CONFIG]);
		if (exitCode !== 0) {
			throw new Error(`Migration failed: ${stdout} ${stderr}`);
		}
	}, 60000);

	beforeEach(() => {
		if (!pgAvailable) return;
		cleanTestData();
		seedFullDataChain();
	});

	afterAll(() => {
		if (!pgAvailable) return;
		try {
			cleanTestData();
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-12: Extract reset cascades correctly
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-12: reset_pipeline_step(extract) — stories+chunks+edges deleted, source→ingested, ALL source_steps deleted', () => {
		if (!pgAvailable) return;

		// Pre-conditions
		expect(countRows('stories', `source_id = '${SOURCE_ID}'`)).toBe(2);
		expect(countRows('chunks')).toBeGreaterThanOrEqual(2);
		expect(countRows('story_entities')).toBeGreaterThanOrEqual(3);
		expect(countRows('entity_edges')).toBeGreaterThanOrEqual(1);
		expect(countRows('source_steps', `source_id = '${SOURCE_ID}'`)).toBe(6);

		// Act
		runSql(`SELECT reset_pipeline_step('${SOURCE_ID}', 'extract');`);

		// Assert: stories deleted (cascades to chunks, story_entities, entity_edges via FK CASCADE)
		expect(countRows('stories', `source_id = '${SOURCE_ID}'`)).toBe(0);
		expect(countRows('chunks')).toBe(0);
		expect(countRows('story_entities')).toBe(0);
		// entity_edges with story_id should be deleted by CASCADE
		expect(countRows('entity_edges', `story_id = '${STORY_ID_1}'`)).toBe(0);

		// Source status reset to 'ingested'
		const status = runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID}';`);
		expect(status).toBe('ingested');

		// ALL source_steps deleted
		expect(countRows('source_steps', `source_id = '${SOURCE_ID}'`)).toBe(0);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-13: Segment reset cascades correctly
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-13: reset_pipeline_step(segment) — stories deleted, source→extracted, segment/enrich/embed/graph steps deleted', () => {
		if (!pgAvailable) return;

		// Act
		runSql(`SELECT reset_pipeline_step('${SOURCE_ID}', 'segment');`);

		// Stories deleted (cascades to chunks, story_entities, edges)
		expect(countRows('stories', `source_id = '${SOURCE_ID}'`)).toBe(0);
		expect(countRows('chunks')).toBe(0);
		expect(countRows('story_entities')).toBe(0);

		// Source status reset to 'extracted'
		const status = runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID}';`);
		expect(status).toBe('extracted');

		// Only ingest and extract steps remain
		const remainingSteps = runSql(
			`SELECT step_name FROM source_steps WHERE source_id = '${SOURCE_ID}' ORDER BY step_name;`,
		);
		const steps = remainingSteps.split('\n').filter(Boolean);
		expect(steps).toContain('ingest');
		expect(steps).toContain('extract');
		expect(steps).not.toContain('segment');
		expect(steps).not.toContain('enrich');
		expect(steps).not.toContain('embed');
		expect(steps).not.toContain('graph');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-14: Enrich reset cascades correctly
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-14: reset_pipeline_step(enrich) — story_entities+edges deleted, stories→segmented, source→segmented, enrich/embed/graph steps deleted', () => {
		if (!pgAvailable) return;

		// Act
		runSql(`SELECT reset_pipeline_step('${SOURCE_ID}', 'enrich');`);

		// story_entities deleted
		expect(countRows('story_entities')).toBe(0);

		// entity_edges for these stories deleted
		expect(countRows('entity_edges', `story_id IN ('${STORY_ID_1}', '${STORY_ID_2}')`)).toBe(0);

		// Stories still exist but status reset to 'segmented'
		expect(countRows('stories', `source_id = '${SOURCE_ID}'`)).toBe(2);
		const storyStatuses = runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${SOURCE_ID}';`);
		expect(storyStatuses).toBe('segmented');

		// Source status reset to 'segmented'
		const sourceStatus = runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID}';`);
		expect(sourceStatus).toBe('segmented');

		// Chunks still exist (enrich reset doesn't touch chunks)
		expect(countRows('chunks')).toBeGreaterThanOrEqual(2);

		// Only ingest, extract, segment steps remain
		const remainingSteps = runSql(
			`SELECT step_name FROM source_steps WHERE source_id = '${SOURCE_ID}' ORDER BY step_name;`,
		);
		const steps = remainingSteps.split('\n').filter(Boolean);
		expect(steps).toContain('ingest');
		expect(steps).toContain('extract');
		expect(steps).toContain('segment');
		expect(steps).not.toContain('enrich');
		expect(steps).not.toContain('embed');
		expect(steps).not.toContain('graph');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-15: Embed reset cascades correctly
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-15: reset_pipeline_step(embed) — chunks deleted, stories→enriched, source status UNCHANGED, embed/graph steps deleted', () => {
		if (!pgAvailable) return;

		// Record initial source status
		const initialSourceStatus = runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID}';`);

		// Act
		runSql(`SELECT reset_pipeline_step('${SOURCE_ID}', 'embed');`);

		// Chunks deleted
		expect(countRows('chunks')).toBe(0);

		// Stories status reset to 'enriched'
		const storyStatuses = runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${SOURCE_ID}';`);
		expect(storyStatuses).toBe('enriched');

		// Source status UNCHANGED (embed reset does NOT update sources.status per §4.3.1)
		const sourceStatus = runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID}';`);
		expect(sourceStatus).toBe(initialSourceStatus);

		// story_entities and entity_edges still exist
		expect(countRows('story_entities')).toBeGreaterThanOrEqual(3);
		expect(countRows('entity_edges')).toBeGreaterThanOrEqual(1);

		// Only ingest, extract, segment, enrich steps remain
		const remainingSteps = runSql(
			`SELECT step_name FROM source_steps WHERE source_id = '${SOURCE_ID}' ORDER BY step_name;`,
		);
		const steps = remainingSteps.split('\n').filter(Boolean);
		expect(steps).toContain('ingest');
		expect(steps).toContain('extract');
		expect(steps).toContain('segment');
		expect(steps).toContain('enrich');
		expect(steps).not.toContain('embed');
		expect(steps).not.toContain('graph');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-16: Graph reset cascades correctly
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-16: reset_pipeline_step(graph) — entity_edges deleted, stories→embedded, source status UNCHANGED, graph step deleted', () => {
		if (!pgAvailable) return;

		// Record initial source status
		const initialSourceStatus = runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID}';`);

		// Act
		runSql(`SELECT reset_pipeline_step('${SOURCE_ID}', 'graph');`);

		// Entity edges for these stories deleted
		expect(countRows('entity_edges', `story_id IN ('${STORY_ID_1}', '${STORY_ID_2}')`)).toBe(0);

		// Stories status reset to 'embedded'
		const storyStatuses = runSql(`SELECT DISTINCT status FROM stories WHERE source_id = '${SOURCE_ID}';`);
		expect(storyStatuses).toBe('embedded');

		// Source status UNCHANGED (graph reset does NOT update sources.status per §4.3.1)
		const sourceStatus = runSql(`SELECT status FROM sources WHERE id = '${SOURCE_ID}';`);
		expect(sourceStatus).toBe(initialSourceStatus);

		// Chunks still exist
		expect(countRows('chunks')).toBeGreaterThanOrEqual(2);

		// story_entities still exist
		expect(countRows('story_entities')).toBeGreaterThanOrEqual(3);

		// Only graph step deleted
		const remainingSteps = runSql(
			`SELECT step_name FROM source_steps WHERE source_id = '${SOURCE_ID}' ORDER BY step_name;`,
		);
		const steps = remainingSteps.split('\n').filter(Boolean);
		expect(steps).toContain('ingest');
		expect(steps).toContain('extract');
		expect(steps).toContain('segment');
		expect(steps).toContain('enrich');
		expect(steps).toContain('embed');
		expect(steps).not.toContain('graph');
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-17: GC removes orphaned entities
	// ─────────────────────────────────────────────────────────────────────────

	it('QA-17: gc_orphaned_entities() removes entities with zero story_entities links after enrich reset', () => {
		if (!pgAvailable) return;

		// ENTITY_ID_3 was seeded with no story_entities links — it's already an orphan.
		// After enrich reset, ENTITY_ID_1 and ENTITY_ID_2 also become orphans
		// (since their story_entities links are deleted).

		// First verify ENTITY_ID_3 exists and has no links
		expect(countRows('story_entities', `entity_id = '${ENTITY_ID_3}'`)).toBe(0);

		// Run enrich reset — this deletes story_entities (making Entity 1 and 2 orphans too)
		runSql(`SELECT reset_pipeline_step('${SOURCE_ID}', 'enrich');`);

		// Verify story_entities are gone
		expect(countRows('story_entities')).toBe(0);

		// All 3 entities still exist (GC hasn't run yet)
		expect(countRows('entities')).toBe(3);

		// Run GC
		const deletedCount = Number.parseInt(runSql(`SELECT gc_orphaned_entities();`), 10);

		// Should have deleted all 3 orphaned entities
		expect(deletedCount).toBe(3);

		// Verify entities are gone
		expect(countRows('entities')).toBe(0);

		// Entity alias should also be gone (CASCADE from entities)
		expect(countRows('entity_aliases', `entity_id = '${ENTITY_ID_1}'`)).toBe(0);
	});
});
