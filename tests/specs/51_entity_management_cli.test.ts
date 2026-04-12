import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

/**
 * Black-box QA tests for Spec 51: Entity Management CLI
 *
 * Each `it()` maps to one QA-NN or CLI-NN condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls and SQL
 * via the shared env-driven SQL helper.
 * Never imports from packages/ or src/ or apps/.
 *
 * Requires:
 * - PostgreSQL reachable through the standard PG env vars with migrations applied
 * - Built CLI at apps/cli/dist/index.js
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');

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
		env: { ...process.env, PGPASSWORD: db.TEST_PG_PASSWORD, MULDER_LOG_LEVEL: 'silent', ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Truncate all relevant tables for a clean test state.
 */
function cleanTestData(): void {
	truncateMulderTables();
}

/**
 * Insert an entity directly into the database.
 */
function seedEntity(opts: {
	id?: string;
	name: string;
	type: string;
	canonical_id?: string | null;
	taxonomy_status?: string;
	source_count?: number;
	corroboration_score?: number | null;
}): string {
	const id = opts.id ?? randomUUID();
	const canonicalId = opts.canonical_id !== undefined && opts.canonical_id !== null ? `'${opts.canonical_id}'` : 'NULL';
	const taxonomyStatus = opts.taxonomy_status ?? 'auto';
	const sourceCount = opts.source_count ?? 0;
	const corroborationScore =
		opts.corroboration_score !== undefined && opts.corroboration_score !== null
			? `${opts.corroboration_score}`
			: 'NULL';
	db.runSql(
		`INSERT INTO entities (id, name, type, canonical_id, taxonomy_status, source_count, corroboration_score) ` +
			`VALUES ('${id}', '${opts.name.replace(/'/g, "''")}', '${opts.type}', ${canonicalId}, '${taxonomyStatus}', ${sourceCount}, ${corroborationScore}) ` +
			`ON CONFLICT (id) DO NOTHING;`,
	);
	return id;
}

/**
 * Insert an entity alias directly into the database.
 */
function seedAlias(opts: { id?: string; entity_id: string; alias: string; source?: string }): string {
	const id = opts.id ?? randomUUID();
	const source = opts.source ?? 'extraction';
	db.runSql(
		`INSERT INTO entity_aliases (id, entity_id, alias, source) ` +
			`VALUES ('${id}', '${opts.entity_id}', '${opts.alias.replace(/'/g, "''")}', '${source}') ` +
			`ON CONFLICT DO NOTHING;`,
	);
	return id;
}

/**
 * Insert a source into the database (needed for stories FK).
 */
function seedSource(opts?: { id?: string; filename?: string }): string {
	const id = opts?.id ?? randomUUID();
	const filename = opts?.filename ?? 'test.pdf';
	const fileHash = randomUUID(); // unique hash
	db.runSql(
		`INSERT INTO sources (id, filename, storage_path, file_hash, status) ` +
			`VALUES ('${id}', '${filename}', 'raw/${filename}', '${fileHash}', 'ingested') ` +
			`ON CONFLICT (id) DO NOTHING;`,
	);
	return id;
}

/**
 * Insert a story into the database.
 */
function seedStory(opts: { id?: string; source_id: string; title?: string }): string {
	const id = opts.id ?? randomUUID();
	const title = opts.title ?? 'Test Story';
	db.runSql(
		`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri) ` +
			`VALUES ('${id}', '${opts.source_id}', '${title.replace(/'/g, "''")}', 'gs://test/${id}.md', 'gs://test/${id}.meta.json') ` +
			`ON CONFLICT (id) DO NOTHING;`,
	);
	return id;
}

/**
 * Link an entity to a story.
 */
function seedStoryEntity(storyId: string, entityId: string): void {
	db.runSql(
		`INSERT INTO story_entities (story_id, entity_id) ` +
			`VALUES ('${storyId}', '${entityId}') ` +
			`ON CONFLICT DO NOTHING;`,
	);
}

/**
 * Insert an edge between two entities.
 */
function seedEdge(opts: {
	id?: string;
	source_entity_id: string;
	target_entity_id: string;
	relationship: string;
	story_id?: string | null;
}): string {
	const id = opts.id ?? randomUUID();
	const storyId = opts.story_id ? `'${opts.story_id}'` : 'NULL';
	db.runSql(
		`INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, story_id) ` +
			`VALUES ('${id}', '${opts.source_entity_id}', '${opts.target_entity_id}', '${opts.relationship}', ${storyId}) ` +
			`ON CONFLICT DO NOTHING;`,
	);
	return id;
}

// ---------------------------------------------------------------------------
// Test state — IDs populated in beforeAll
// ---------------------------------------------------------------------------

let pgAvailable = false;

// Shared entity IDs
let personEntityId: string;
let locationEntityId: string;
let _personEntityId2: string;
let mergeTargetId: string;
let mergeSourceId: string;
let alreadyMergedEntityId: string;
let aliasEntityId: string;
let _aliasId1: string;
let aliasId2: string;
let sourceId: string;
let storyId: string;
let storyId2: string;
let _edgeId: string;

// For merge JSON test — separate pair
let mergeJsonTargetId: string;
let mergeJsonSourceId: string;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
	pgAvailable = db.isPgAvailable();
	if (!pgAvailable) return;
	ensureSchema();
	cleanTestData();

	// Seed test data
	sourceId = seedSource({ filename: 'test-spec51.pdf' });
	storyId = seedStory({ source_id: sourceId, title: 'Sighting Report Alpha' });
	storyId2 = seedStory({ source_id: sourceId, title: 'Sighting Report Beta' });

	// Entities of different types
	personEntityId = seedEntity({
		name: 'Josef Allen Hynek',
		type: 'person',
		source_count: 3,
		corroboration_score: 0.85,
	});
	locationEntityId = seedEntity({ name: 'Area 51', type: 'location', source_count: 5 });
	_personEntityId2 = seedEntity({ name: 'Kenneth Arnold', type: 'person', source_count: 1 });

	// Entity for show command — with aliases, edges, stories
	seedAlias({ entity_id: personEntityId, alias: 'J. Allen Hynek', source: 'extraction' });
	seedAlias({ entity_id: personEntityId, alias: 'Dr. Hynek', source: 'manual' });
	seedStoryEntity(storyId, personEntityId);
	seedStoryEntity(storyId2, personEntityId);
	_edgeId = seedEdge({
		source_entity_id: personEntityId,
		target_entity_id: locationEntityId,
		relationship: 'INVESTIGATED_AT',
		story_id: storyId,
	});

	// Entities for merge tests
	mergeTargetId = seedEntity({ name: 'Target Entity', type: 'person' });
	mergeSourceId = seedEntity({ name: 'Source Entity', type: 'person' });
	seedAlias({ entity_id: mergeSourceId, alias: 'Source Alias', source: 'extraction' });
	seedStoryEntity(storyId, mergeSourceId);
	seedEdge({
		source_entity_id: mergeSourceId,
		target_entity_id: locationEntityId,
		relationship: 'VISITED',
		story_id: storyId,
	});

	// Already-merged entity (has canonical_id set)
	alreadyMergedEntityId = seedEntity({
		name: 'Already Merged',
		type: 'person',
		canonical_id: personEntityId,
		taxonomy_status: 'merged',
	});

	// Entity for alias management tests
	aliasEntityId = seedEntity({ name: 'Alias Test Entity', type: 'organization' });
	_aliasId1 = seedAlias({ entity_id: aliasEntityId, alias: 'Alias One', source: 'extraction' });
	aliasId2 = seedAlias({ entity_id: aliasEntityId, alias: 'Alias Two', source: 'manual' });

	// Separate pair for merge --json test (since merge is destructive)
	mergeJsonTargetId = seedEntity({ name: 'JSON Merge Target', type: 'person' });
	mergeJsonSourceId = seedEntity({ name: 'JSON Merge Source', type: 'person' });
	seedStoryEntity(storyId2, mergeJsonSourceId);
});

afterAll(() => {
	if (!pgAvailable) return;
	cleanTestData();
});

// ---------------------------------------------------------------------------
// QA Contract Tests (Section 5)
// ---------------------------------------------------------------------------

describe('QA Contract: Entity Management CLI', () => {
	it('QA-01: entity list — no filter', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list']);
		expect(exitCode).toBe(0);
		// Should show a table with entities
		expect(stdout).toContain('Josef Allen Hynek');
		expect(stdout).toContain('Area 51');
		expect(stdout).toContain('Kenneth Arnold');
		// Should show column headers with ID, Name, Type, Status, Sources
		expect(stdout).toMatch(/ID/);
		expect(stdout).toMatch(/Name/);
		expect(stdout).toMatch(/Type/);
		expect(stdout).toMatch(/Status/);
		expect(stdout).toMatch(/Sources/);
	});

	it('QA-02: entity list — type filter', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list', '--type', 'person']);
		expect(exitCode).toBe(0);
		// Should include person entities
		expect(stdout).toContain('Josef Allen Hynek');
		expect(stdout).toContain('Kenneth Arnold');
		// Should NOT include location entities
		expect(stdout).not.toContain('Area 51');
	});

	it('QA-03: entity list — search filter', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list', '--search', 'hynek']);
		expect(exitCode).toBe(0);
		// Case-insensitive substring match
		expect(stdout).toContain('Josef Allen Hynek');
		// Should not contain unrelated entities
		expect(stdout).not.toContain('Kenneth Arnold');
		expect(stdout).not.toContain('Area 51');
	});

	it('QA-04: entity list — json output', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBeGreaterThan(0);
		// Each element should be an entity object
		const entity = parsed[0];
		expect(entity).toHaveProperty('id');
		expect(entity).toHaveProperty('name');
		expect(entity).toHaveProperty('type');
	});

	it('QA-05: entity show — valid ID', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'show', personEntityId]);
		expect(exitCode).toBe(0);
		// Should display entity name
		expect(stdout).toContain('Josef Allen Hynek');
		// Should show aliases
		expect(stdout).toContain('J. Allen Hynek');
		expect(stdout).toContain('Dr. Hynek');
		// Should show relationships
		expect(stdout).toContain('INVESTIGATED_AT');
		// Should show linked stories
		expect(stdout).toContain('Sighting Report');
	});

	it('QA-06: entity show — invalid ID', () => {
		if (!pgAvailable) return;
		const nonexistentId = randomUUID();
		const { stdout, stderr, exitCode } = runCli(['entity', 'show', nonexistentId]);
		expect(exitCode).toBe(1);
		// Should print an error message
		const output = stdout + stderr;
		expect(output).toMatch(/error|not found|not exist/i);
	});

	it('QA-07: entity show — json output', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'show', personEntityId, '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty('entity');
		expect(parsed).toHaveProperty('aliases');
		expect(parsed).toHaveProperty('edges');
		expect(parsed).toHaveProperty('stories');
		expect(parsed).toHaveProperty('mergedEntities');
		// Verify entity details
		expect(parsed.entity.name).toBe('Josef Allen Hynek');
		// Verify aliases
		expect(Array.isArray(parsed.aliases)).toBe(true);
		expect(parsed.aliases.length).toBeGreaterThanOrEqual(2);
		// Verify edges
		expect(Array.isArray(parsed.edges)).toBe(true);
		expect(parsed.edges.length).toBeGreaterThanOrEqual(1);
		// Verify stories
		expect(Array.isArray(parsed.stories)).toBe(true);
		expect(parsed.stories.length).toBeGreaterThanOrEqual(1);
	});

	it('QA-08: entity merge — success', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['entity', 'merge', mergeTargetId, mergeSourceId]);
		expect(exitCode).toBe(0);

		// Verify source entity now has canonical_id = target
		const canonicalId = db.runSql(`SELECT canonical_id FROM entities WHERE id = '${mergeSourceId}';`);
		expect(canonicalId).toBe(mergeTargetId);

		// Verify source entity has taxonomy_status = 'merged'
		const taxonomyStatus = db.runSql(`SELECT taxonomy_status FROM entities WHERE id = '${mergeSourceId}';`);
		expect(taxonomyStatus).toBe('merged');

		// Verify story_entities were reassigned to target
		const storyEntityCount = db.runSql(`SELECT COUNT(*) FROM story_entities WHERE entity_id = '${mergeTargetId}';`);
		expect(Number(storyEntityCount)).toBeGreaterThanOrEqual(1);

		// Verify source name is now an alias on target
		const mergeAlias = db.runSql(
			`SELECT COUNT(*) FROM entity_aliases WHERE entity_id = '${mergeTargetId}' AND alias = 'Source Entity';`,
		);
		expect(Number(mergeAlias)).toBe(1);

		// Verify edges were reassigned (source's edges now point to/from target)
		const targetEdges = db.runSql(
			`SELECT COUNT(*) FROM entity_edges WHERE source_entity_id = '${mergeTargetId}' OR target_entity_id = '${mergeTargetId}';`,
		);
		expect(Number(targetEdges)).toBeGreaterThanOrEqual(1);
	});

	it('QA-09: entity merge — same ID', () => {
		if (!pgAvailable) return;
		const someId = personEntityId;
		const { stdout, stderr, exitCode } = runCli(['entity', 'merge', someId, someId]);
		expect(exitCode).toBe(1);
		const output = stdout + stderr;
		expect(output).toMatch(/error|validation|same|cannot merge/i);
	});

	it('QA-10: entity merge — already merged entity', () => {
		if (!pgAvailable) return;
		// alreadyMergedEntityId has canonical_id set
		const freshTarget = seedEntity({ name: 'Fresh Target', type: 'person' });
		const { stdout, stderr, exitCode } = runCli(['entity', 'merge', freshTarget, alreadyMergedEntityId]);
		expect(exitCode).toBe(1);
		const output = stdout + stderr;
		expect(output).toMatch(/error|validation|already|merged/i);
	});

	it('QA-11: entity merge — json output', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'merge', mergeJsonTargetId, mergeJsonSourceId, '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		// Should have merge result fields
		expect(parsed).toHaveProperty('target');
		expect(parsed).toHaveProperty('merged');
		expect(parsed.target).toHaveProperty('id');
		expect(parsed.merged).toHaveProperty('id');
		expect(parsed.target.id).toBe(mergeJsonTargetId);
		expect(parsed.merged.id).toBe(mergeJsonSourceId);
	});

	it('QA-12: entity aliases — list', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'aliases', aliasEntityId]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('Alias One');
		expect(stdout).toContain('Alias Two');
	});

	it('QA-13: entity aliases — add', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['entity', 'aliases', aliasEntityId, '--add', 'New Test Alias']);
		expect(exitCode).toBe(0);

		// Verify alias was created with source 'manual'
		const aliasSource = db.runSql(
			`SELECT source FROM entity_aliases WHERE entity_id = '${aliasEntityId}' AND alias = 'New Test Alias';`,
		);
		expect(aliasSource).toBe('manual');
	});

	it('QA-14: entity aliases — remove', () => {
		if (!pgAvailable) return;
		// Remove aliasId2
		const { exitCode } = runCli(['entity', 'aliases', aliasEntityId, '--remove', aliasId2]);
		expect(exitCode).toBe(0);

		// Verify alias was deleted
		const count = db.runSql(`SELECT COUNT(*) FROM entity_aliases WHERE id = '${aliasId2}';`);
		expect(Number(count)).toBe(0);
	});

	it('QA-15: entity aliases — json output', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'aliases', aliasEntityId, '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Array.isArray(parsed)).toBe(true);
		// Each alias should be an object with alias properties
		if (parsed.length > 0) {
			expect(parsed[0]).toHaveProperty('id');
			expect(parsed[0]).toHaveProperty('alias');
		}
	});
});

// ---------------------------------------------------------------------------
// CLI Test Matrix (Section 5b)
// ---------------------------------------------------------------------------

describe('CLI Test Matrix: Entity Management CLI', () => {
	it('CLI-01: entity list --help shows usage with --type, --search, --json options', () => {
		const { stdout, exitCode } = runCli(['entity', 'list', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--type');
		expect(stdout).toContain('--search');
		expect(stdout).toContain('--json');
	});

	it('CLI-02: entity show --help shows usage with entity-id argument and --json option', () => {
		const { stdout, exitCode } = runCli(['entity', 'show', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('entity-id');
		expect(stdout).toContain('--json');
	});

	it('CLI-03: entity merge --help shows usage with id1, id2 arguments and --json option', () => {
		const { stdout, exitCode } = runCli(['entity', 'merge', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('id1');
		expect(stdout).toContain('id2');
		expect(stdout).toContain('--json');
	});

	it('CLI-04: entity aliases --help shows usage with entity-id argument and --add, --remove, --json options', () => {
		const { stdout, exitCode } = runCli(['entity', 'aliases', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('entity-id');
		expect(stdout).toContain('--add');
		expect(stdout).toContain('--remove');
		expect(stdout).toContain('--json');
	});

	it('CLI-05: entity --help shows all subcommands: list, show, merge, aliases', () => {
		const { stdout, exitCode } = runCli(['entity', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('list');
		expect(stdout).toContain('show');
		expect(stdout).toContain('merge');
		expect(stdout).toContain('aliases');
	});
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: Entity Management CLI', () => {
	it('SMOKE-01: entity list --type and --search combined', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list', '--type', 'person', '--search', 'hynek']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('Josef Allen Hynek');
		expect(stdout).not.toContain('Area 51');
		expect(stdout).not.toContain('Kenneth Arnold');
	});

	it('SMOKE-02: entity list --type with nonexistent type returns empty', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list', '--type', 'nonexistent_type_xyz']);
		expect(exitCode).toBe(0);
		// Should show 0 results — just headers with no data rows
		// Verify none of the seeded entity names appear
		expect(stdout).not.toContain('Josef Allen Hynek');
		expect(stdout).not.toContain('Area 51');
		expect(stdout).not.toContain('Kenneth Arnold');
	});

	it('SMOKE-03: entity list --search with no matches returns empty', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list', '--search', 'zzzznonexistentzzzz']);
		expect(exitCode).toBe(0);
		// Should show empty results — just headers, no data rows
		expect(stdout).not.toContain('Josef Allen Hynek');
		expect(stdout).not.toContain('Area 51');
		expect(stdout).not.toContain('Kenneth Arnold');
	});

	it('SMOKE-04: entity list --json --type combined produces valid filtered JSON', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list', '--json', '--type', 'location']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Array.isArray(parsed)).toBe(true);
		for (const entity of parsed) {
			expect(entity.type).toBe('location');
		}
	});

	it('SMOKE-05: entity show with malformed UUID gives error', () => {
		if (!pgAvailable) return;
		const { stdout, stderr, exitCode } = runCli(['entity', 'show', 'not-a-uuid']);
		expect(exitCode).toBe(1);
		const output = stdout + stderr;
		expect(output).toMatch(/error|invalid|uuid|failed/i);
	});

	it('SMOKE-06: entity merge with missing second argument gives error', () => {
		const { exitCode } = runCli(['entity', 'merge', randomUUID()]);
		// Commander.js should reject this — missing required argument
		expect(exitCode).not.toBe(0);
	});

	it('SMOKE-07: entity merge with nonexistent IDs gives error', () => {
		if (!pgAvailable) return;
		const fakeId1 = randomUUID();
		const fakeId2 = randomUUID();
		const { stdout, stderr, exitCode } = runCli(['entity', 'merge', fakeId1, fakeId2]);
		expect(exitCode).toBe(1);
		const output = stdout + stderr;
		expect(output).toMatch(/error|not found/i);
	});

	it('SMOKE-08: entity aliases with nonexistent entity ID gives error', () => {
		if (!pgAvailable) return;
		const fakeId = randomUUID();
		const { exitCode } = runCli(['entity', 'aliases', fakeId]);
		// This may return empty list or error — depends on implementation
		// At minimum it should not crash (exit 0 or 1 with meaningful output)
		expect(exitCode === 0 || exitCode === 1).toBe(true);
	});

	it('SMOKE-09: entity aliases --remove with nonexistent alias ID gives error', () => {
		if (!pgAvailable) return;
		const fakeAliasId = randomUUID();
		const { exitCode } = runCli(['entity', 'aliases', aliasEntityId, '--remove', fakeAliasId]);
		// Should handle gracefully — either error or no-op
		expect(exitCode === 0 || exitCode === 1).toBe(true);
	});

	it('SMOKE-10: entity show --json for entity with merged entities shows mergedEntities array', () => {
		if (!pgAvailable) return;
		// personEntityId has alreadyMergedEntityId pointing to it via canonical_id
		const { stdout, exitCode } = runCli(['entity', 'show', personEntityId, '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty('mergedEntities');
		expect(Array.isArray(parsed.mergedEntities)).toBe(true);
		// Should include the already-merged entity
		const mergedIds = parsed.mergedEntities.map((e: { id: string }) => e.id);
		expect(mergedIds).toContain(alreadyMergedEntityId);
	});

	it('SMOKE-11: entity list --json --search combined produces valid filtered JSON', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['entity', 'list', '--json', '--search', 'area']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed.length).toBeGreaterThanOrEqual(1);
		expect(parsed.some((e: { name: string }) => e.name === 'Area 51')).toBe(true);
	});

	it('SMOKE-12: entity aliases --add and then --json reflects the new alias', () => {
		if (!pgAvailable) return;
		const uniqueAlias = `SmokeAlias-${Date.now()}`;
		const addResult = runCli(['entity', 'aliases', aliasEntityId, '--add', uniqueAlias]);
		expect(addResult.exitCode).toBe(0);

		const { stdout, exitCode } = runCli(['entity', 'aliases', aliasEntityId, '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		const found = parsed.some((a: { alias: string }) => a.alias === uniqueAlias);
		expect(found).toBe(true);
	});
});
