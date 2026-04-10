import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema } from '../lib/schema.js';

/**
 * Black-box QA tests for Spec 52: Status Overview CLI
 *
 * Each `it()` maps to one QA-NN or CLI-NN condition from Section 5/5b of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls and SQL
 * via `docker exec psql`.
 * Never imports from packages/ or src/ or apps/.
 *
 * Requires:
 * - Running PostgreSQL container `mulder-pg-test` with migrations applied
 * - Built CLI at apps/cli/dist/index.js
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

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
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, MULDER_LOG_LEVEL: 'silent', ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function runSql(sql: string): string {
	const result = spawnSync(
		'docker',
		['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', 'mulder', '-t', '-A', '-c', sql],
		{ encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
	);
	if (result.status !== 0) {
		throw new Error(`psql failed (exit ${result.status}): ${result.stderr}`);
	}
	return (result.stdout ?? '').trim();
}

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

/**
 * Truncate all relevant tables for a clean test state.
 */
function cleanTestData(): void {
	runSql(
		'TRUNCATE TABLE chunks, story_entities, entity_edges, entity_aliases, ' +
			'taxonomy, entities, stories, source_steps, ' +
			'pipeline_run_sources, pipeline_runs, sources CASCADE;',
	);
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedSource(opts?: { id?: string; filename?: string; status?: string }): string {
	const id = opts?.id ?? randomUUID();
	const filename = opts?.filename ?? 'test.pdf';
	const fileHash = randomUUID();
	const status = opts?.status ?? 'ingested';
	runSql(
		`INSERT INTO sources (id, filename, storage_path, file_hash, status) ` +
			`VALUES ('${id}', '${filename}', 'raw/${filename}', '${fileHash}', '${status}') ` +
			`ON CONFLICT (id) DO NOTHING;`,
	);
	return id;
}

function seedStory(opts: { id?: string; source_id: string; title?: string; status?: string }): string {
	const id = opts.id ?? randomUUID();
	const title = opts.title ?? 'Test Story';
	const status = opts.status ?? 'segmented';
	runSql(
		`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status) ` +
			`VALUES ('${id}', '${opts.source_id}', '${title.replace(/'/g, "''")}', 'gs://test/${id}.md', 'gs://test/${id}.meta.json', '${status}') ` +
			`ON CONFLICT (id) DO NOTHING;`,
	);
	return id;
}

function seedEntity(opts: {
	id?: string;
	name: string;
	type: string;
	canonical_id?: string | null;
	taxonomy_status?: string;
	source_count?: number;
}): string {
	const id = opts.id ?? randomUUID();
	const canonicalId = opts.canonical_id !== undefined && opts.canonical_id !== null ? `'${opts.canonical_id}'` : 'NULL';
	const taxonomyStatus = opts.taxonomy_status ?? 'auto';
	const sourceCount = opts.source_count ?? 0;
	runSql(
		`INSERT INTO entities (id, name, type, canonical_id, taxonomy_status, source_count) ` +
			`VALUES ('${id}', '${opts.name.replace(/'/g, "''")}', '${opts.type}', ${canonicalId}, '${taxonomyStatus}', ${sourceCount}) ` +
			`ON CONFLICT (id) DO NOTHING;`,
	);
	return id;
}

function seedEdge(opts: {
	id?: string;
	source_entity_id: string;
	target_entity_id: string;
	relationship: string;
	story_id?: string | null;
}): string {
	const id = opts.id ?? randomUUID();
	const storyId = opts.story_id ? `'${opts.story_id}'` : 'NULL';
	runSql(
		`INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, story_id) ` +
			`VALUES ('${id}', '${opts.source_entity_id}', '${opts.target_entity_id}', '${opts.relationship}', ${storyId}) ` +
			`ON CONFLICT DO NOTHING;`,
	);
	return id;
}

function seedChunk(opts: { id?: string; story_id: string; content: string; chunk_index: number }): string {
	const id = opts.id ?? randomUUID();
	runSql(
		`INSERT INTO chunks (id, story_id, content, chunk_index) ` +
			`VALUES ('${id}', '${opts.story_id}', '${opts.content.replace(/'/g, "''")}', ${opts.chunk_index}) ` +
			`ON CONFLICT DO NOTHING;`,
	);
	return id;
}

function seedTaxonomy(opts: { id?: string; canonical_name: string; entity_type: string; status?: string }): string {
	const id = opts.id ?? randomUUID();
	const status = opts.status ?? 'auto';
	runSql(
		`INSERT INTO taxonomy (id, canonical_name, entity_type, status) ` +
			`VALUES ('${id}', '${opts.canonical_name.replace(/'/g, "''")}', '${opts.entity_type}', '${status}') ` +
			`ON CONFLICT DO NOTHING;`,
	);
	return id;
}

function seedSourceStep(opts: {
	source_id: string;
	step_name: string;
	status: string;
	error_message?: string | null;
}): void {
	const errorMsg =
		opts.error_message !== undefined && opts.error_message !== null
			? `'${opts.error_message.replace(/'/g, "''")}'`
			: 'NULL';
	runSql(
		`INSERT INTO source_steps (source_id, step_name, status, error_message) ` +
			`VALUES ('${opts.source_id}', '${opts.step_name}', '${opts.status}', ${errorMsg}) ` +
			`ON CONFLICT (source_id, step_name) DO UPDATE SET status = '${opts.status}', error_message = ${errorMsg};`,
	);
}

function seedPipelineRun(opts?: { id?: string; status?: string; finished_at?: string | null }): string {
	const id = opts?.id ?? randomUUID();
	const status = opts?.status ?? 'completed';
	const finishedAt =
		opts?.finished_at !== undefined && opts?.finished_at !== null
			? `'${opts.finished_at}'`
			: status === 'completed'
				? 'now()'
				: 'NULL';
	runSql(
		`INSERT INTO pipeline_runs (id, status, finished_at) ` +
			`VALUES ('${id}', '${status}', ${finishedAt}) ` +
			`ON CONFLICT DO NOTHING;`,
	);
	return id;
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let pgAvailable = false;

// IDs populated in beforeAll
let sourceId1: string;
let sourceId2: string;
let sourceIdFailed: string;
let storyId1: string;
let storyId2: string;
let storyId3: string;
let personEntity1: string;
let personEntity2: string;
let locationEntity1: string;
let mergedEntityId: string;
let edgeId1: string;
let chunkId1: string;
let chunkId2: string;
let pipelineRunId: string;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
	pgAvailable = isPgAvailable();
	if (!pgAvailable) return;
	ensureSchema();
	cleanTestData();

	// Seed sources with different statuses
	sourceId1 = seedSource({ filename: 'report-alpha.pdf', status: 'ingested' });
	sourceId2 = seedSource({ filename: 'report-beta.pdf', status: 'extracted' });
	sourceIdFailed = seedSource({ filename: 'report-failed.pdf', status: 'ingested' });

	// Seed source_steps — one successful, one failed
	seedSourceStep({ source_id: sourceId1, step_name: 'ingest', status: 'completed' });
	seedSourceStep({
		source_id: sourceIdFailed,
		step_name: 'extract',
		status: 'failed',
		error_message: 'Document AI timeout',
	});

	// Seed stories with different statuses
	storyId1 = seedStory({ source_id: sourceId1, title: 'Story Alpha', status: 'segmented' });
	storyId2 = seedStory({ source_id: sourceId1, title: 'Story Beta', status: 'enriched' });
	storyId3 = seedStory({ source_id: sourceId2, title: 'Story Gamma', status: 'enriched' });

	// Seed entities — 2 active persons, 1 active location, 1 merged
	personEntity1 = seedEntity({ name: 'Josef Allen Hynek', type: 'person', source_count: 3 });
	personEntity2 = seedEntity({ name: 'Kenneth Arnold', type: 'person', source_count: 1 });
	locationEntity1 = seedEntity({ name: 'Area 51', type: 'location', source_count: 5 });
	mergedEntityId = seedEntity({
		name: 'J Allen Hynek',
		type: 'person',
		canonical_id: personEntity1,
		taxonomy_status: 'merged',
	});

	// Seed edges
	edgeId1 = seedEdge({
		source_entity_id: personEntity1,
		target_entity_id: locationEntity1,
		relationship: 'INVESTIGATED_AT',
		story_id: storyId1,
	});

	// Seed chunks
	chunkId1 = seedChunk({ story_id: storyId1, content: 'Test chunk content one', chunk_index: 0 });
	chunkId2 = seedChunk({ story_id: storyId2, content: 'Test chunk content two', chunk_index: 0 });

	// Seed taxonomy entries
	seedTaxonomy({ canonical_name: 'Josef Allen Hynek', entity_type: 'person', status: 'confirmed' });
	seedTaxonomy({ canonical_name: 'Area 51', entity_type: 'location', status: 'auto' });
	seedTaxonomy({ canonical_name: 'Kenneth Arnold', entity_type: 'person', status: 'auto' });

	// Seed a pipeline run
	pipelineRunId = seedPipelineRun({ status: 'completed' });
});

afterAll(() => {
	if (!pgAvailable) return;
	cleanTestData();
});

// ---------------------------------------------------------------------------
// QA Contract Tests (Section 5)
// ---------------------------------------------------------------------------

describe('QA Contract: Status Overview CLI', () => {
	it('QA-01: Default overview shows aggregate counts', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status']);
		expect(exitCode).toBe(0);
		// stdout must contain lines with Sources, Stories, Entities, Edges, Chunks and numeric counts
		expect(stdout).toContain('Sources');
		expect(stdout).toContain('Stories');
		expect(stdout).toContain('Entities');
		expect(stdout).toContain('Edges');
		expect(stdout).toContain('Chunks');
		// Verify numeric counts are present (at least one non-zero)
		expect(stdout).toMatch(/\d+/);
	});

	it('QA-02: --json flag produces valid JSON', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty('sources');
		expect(parsed).toHaveProperty('stories');
		expect(parsed).toHaveProperty('entities');
		expect(parsed).toHaveProperty('edges');
		expect(parsed).toHaveProperty('chunks');
		expect(parsed).toHaveProperty('taxonomy');
		expect(parsed).toHaveProperty('pipeline');
	});

	it('QA-03: --failed shows only failed sources', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--failed']);
		expect(exitCode).toBe(0);
		// stdout lists the failed source with step name and error message
		expect(stdout).toContain('report-failed.pdf');
		expect(stdout).toContain('extract');
		expect(stdout).toContain('Document AI timeout');
	});

	it('QA-04: --failed with --json', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--failed', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty('failedSources');
		expect(Array.isArray(parsed.failedSources)).toBe(true);
		// Should contain the failed source info
		const failedSource = parsed.failedSources.find((s: { filename: string }) => s.filename === 'report-failed.pdf');
		expect(failedSource).toBeDefined();
		expect(failedSource.stepName).toBe('extract');
		expect(failedSource.errorMessage).toBe('Document AI timeout');
	});

	it('QA-05: Empty database shows zero counts', () => {
		if (!pgAvailable) return;
		// Truncate all data first
		cleanTestData();
		try {
			const { stdout, exitCode } = runCli(['status']);
			expect(exitCode).toBe(0);
			// All counts should be 0 — verify no error is thrown
			expect(stdout).toContain('Sources');
			expect(stdout).toContain('0 total');
		} finally {
			// Re-seed data for remaining tests
			reseedTestData();
		}
	});

	it('QA-06: --failed with no failures', () => {
		if (!pgAvailable) return;
		// Remove failed source_steps
		runSql(`DELETE FROM source_steps WHERE status = 'failed';`);
		try {
			const { stdout, exitCode } = runCli(['status', '--failed']);
			expect(exitCode).toBe(0);
			// Should indicate no failures
			const combined = stdout.toLowerCase();
			expect(combined).toMatch(/no sources with failed steps|0/);
		} finally {
			// Restore the failed step
			seedSourceStep({
				source_id: sourceIdFailed,
				step_name: 'extract',
				status: 'failed',
				error_message: 'Document AI timeout',
			});
		}
	});

	it('QA-07: Entity counts exclude merged entities', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		// 3 active entities (personEntity1, personEntity2, locationEntity1) — mergedEntityId is excluded
		expect(parsed.entities.active).toBe(3);
		// 1 merged entity
		expect(parsed.entities.merged).toBe(1);
		// byType should only count active entities
		const totalByType = Object.values(parsed.entities.byType as Record<string, number>).reduce(
			(a: number, b: number) => a + b,
			0,
		);
		expect(totalByType).toBe(parsed.entities.active);
	});

	it('QA-08: --help shows command description', () => {
		const { stdout, exitCode } = runCli(['status', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('Overview');
		expect(stdout).toContain('--failed');
		expect(stdout).toContain('--json');
	});
});

// ---------------------------------------------------------------------------
// CLI Test Matrix (Section 5b)
// ---------------------------------------------------------------------------

describe('CLI Test Matrix: Status Overview CLI', () => {
	it('CLI-01: mulder status --help — exit 0, output contains "Overview"', () => {
		const { stdout, exitCode } = runCli(['status', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('Overview');
	});

	it('CLI-02: mulder status — exit 0, output contains "Sources" and "Stories"', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('Sources');
		expect(stdout).toContain('Stories');
	});

	it('CLI-03: mulder status --json — exit 0, valid JSON on stdout', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		// Should parse as valid JSON without throwing
		const parsed = JSON.parse(stdout);
		expect(parsed).toBeDefined();
		expect(typeof parsed).toBe('object');
	});

	it('CLI-04: mulder status --failed — exit 0, output contains "failed" context', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--failed']);
		expect(exitCode).toBe(0);
		const combined = stdout.toLowerCase();
		expect(combined).toContain('failed');
	});

	it('CLI-05: mulder status --failed --json — exit 0, valid JSON with failedSources', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--failed', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty('failedSources');
	});
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: Status Overview CLI', () => {
	it('SMOKE-01: --help exits 0 and shows usage line', () => {
		const { stdout, exitCode } = runCli(['status', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('Usage:');
	});

	it('SMOKE-02: --json produces object (not array) on stdout', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(typeof parsed).toBe('object');
		expect(Array.isArray(parsed)).toBe(false);
	});

	it('SMOKE-03: --json sources.total matches sum of byStatus values', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		const byStatusSum = Object.values(parsed.sources.byStatus as Record<string, number>).reduce(
			(a: number, b: number) => a + b,
			0,
		);
		expect(parsed.sources.total).toBe(byStatusSum);
	});

	it('SMOKE-04: --json stories.total matches sum of byStatus values', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		const byStatusSum = Object.values(parsed.stories.byStatus as Record<string, number>).reduce(
			(a: number, b: number) => a + b,
			0,
		);
		expect(parsed.stories.total).toBe(byStatusSum);
	});

	it('SMOKE-05: --json taxonomy has confirmed and auto fields', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.taxonomy).toHaveProperty('confirmed');
		expect(parsed.taxonomy).toHaveProperty('auto');
		expect(typeof parsed.taxonomy.confirmed).toBe('number');
		expect(typeof parsed.taxonomy.auto).toBe('number');
	});

	it('SMOKE-06: --json pipeline.lastRun is present (object or null)', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.pipeline).toHaveProperty('lastRun');
		// lastRun should be an object with id/status or null
		if (parsed.pipeline.lastRun !== null) {
			expect(parsed.pipeline.lastRun).toHaveProperty('id');
			expect(parsed.pipeline.lastRun).toHaveProperty('status');
		}
	});

	it('SMOKE-07: --json pipeline.failedSources is a number', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(typeof parsed.pipeline.failedSources).toBe('number');
	});

	it('SMOKE-08: --json edges is a number', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(typeof parsed.edges).toBe('number');
	});

	it('SMOKE-09: --json chunks is a number', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(typeof parsed.chunks).toBe('number');
	});

	it('SMOKE-10: --failed --json total field matches failedSources array length', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--failed', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.total).toBe(parsed.failedSources.length);
	});

	it('SMOKE-11: --failed --json each entry has sourceId, filename, stepName, errorMessage', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status', '--failed', '--json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		for (const entry of parsed.failedSources) {
			expect(entry).toHaveProperty('sourceId');
			expect(entry).toHaveProperty('filename');
			expect(entry).toHaveProperty('stepName');
			expect(entry).toHaveProperty('errorMessage');
		}
	});

	it('SMOKE-12: unknown flag --verbose gives error', () => {
		const { exitCode } = runCli(['status', '--verbose']);
		// Commander.js rejects unknown options
		expect(exitCode).not.toBe(0);
	});

	it('SMOKE-13: --failed and default output both mention "Sources"', () => {
		if (!pgAvailable) return;
		const defaultResult = runCli(['status']);
		const failedResult = runCli(['status', '--failed']);
		expect(defaultResult.exitCode).toBe(0);
		expect(failedResult.exitCode).toBe(0);
		expect(defaultResult.stdout).toContain('Sources');
		// --failed output should mention sources context
		const failedLower = failedResult.stdout.toLowerCase();
		expect(failedLower).toMatch(/source|failed/);
	});

	it('SMOKE-14: human-readable output contains "Pipeline" section', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('Pipeline');
	});

	it('SMOKE-15: human-readable output contains "Taxonomy" information', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['status']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('Taxonomy');
	});
});

// ---------------------------------------------------------------------------
// Helpers — re-seed data after clean
// ---------------------------------------------------------------------------

function reseedTestData(): void {
	// Sources
	sourceId1 = seedSource({ id: sourceId1, filename: 'report-alpha.pdf', status: 'ingested' });
	sourceId2 = seedSource({ id: sourceId2, filename: 'report-beta.pdf', status: 'extracted' });
	sourceIdFailed = seedSource({ id: sourceIdFailed, filename: 'report-failed.pdf', status: 'ingested' });

	// Source steps
	seedSourceStep({ source_id: sourceId1, step_name: 'ingest', status: 'completed' });
	seedSourceStep({
		source_id: sourceIdFailed,
		step_name: 'extract',
		status: 'failed',
		error_message: 'Document AI timeout',
	});

	// Stories
	storyId1 = seedStory({ id: storyId1, source_id: sourceId1, title: 'Story Alpha', status: 'segmented' });
	storyId2 = seedStory({ id: storyId2, source_id: sourceId1, title: 'Story Beta', status: 'enriched' });
	storyId3 = seedStory({ id: storyId3, source_id: sourceId2, title: 'Story Gamma', status: 'enriched' });

	// Entities
	personEntity1 = seedEntity({ id: personEntity1, name: 'Josef Allen Hynek', type: 'person', source_count: 3 });
	personEntity2 = seedEntity({ id: personEntity2, name: 'Kenneth Arnold', type: 'person', source_count: 1 });
	locationEntity1 = seedEntity({ id: locationEntity1, name: 'Area 51', type: 'location', source_count: 5 });
	mergedEntityId = seedEntity({
		id: mergedEntityId,
		name: 'J Allen Hynek',
		type: 'person',
		canonical_id: personEntity1,
		taxonomy_status: 'merged',
	});

	// Edges
	edgeId1 = seedEdge({
		id: edgeId1,
		source_entity_id: personEntity1,
		target_entity_id: locationEntity1,
		relationship: 'INVESTIGATED_AT',
		story_id: storyId1,
	});

	// Chunks
	chunkId1 = seedChunk({ id: chunkId1, story_id: storyId1, content: 'Test chunk content one', chunk_index: 0 });
	chunkId2 = seedChunk({ id: chunkId2, story_id: storyId2, content: 'Test chunk content two', chunk_index: 0 });

	// Taxonomy
	seedTaxonomy({ canonical_name: 'Josef Allen Hynek', entity_type: 'person', status: 'confirmed' });
	seedTaxonomy({ canonical_name: 'Area 51', entity_type: 'location', status: 'auto' });
	seedTaxonomy({ canonical_name: 'Kenneth Arnold', entity_type: 'person', status: 'auto' });

	// Pipeline run
	pipelineRunId = seedPipelineRun({ id: pipelineRunId, status: 'completed' });
}
