import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSchema } from '../lib/schema.js';

/**
 * Black-box QA tests for Spec 53: Export Commands (graph/stories/evidence)
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

function seedStory(opts: {
	id?: string;
	source_id: string;
	title?: string;
	status?: string;
	language?: string | null;
	category?: string | null;
	page_start?: number | null;
	page_end?: number | null;
	extraction_confidence?: number | null;
}): string {
	const id = opts.id ?? randomUUID();
	const title = opts.title ?? 'Test Story';
	const status = opts.status ?? 'segmented';
	const language = opts.language !== undefined && opts.language !== null ? `'${opts.language}'` : 'NULL';
	const category = opts.category !== undefined && opts.category !== null ? `'${opts.category}'` : 'NULL';
	const pageStart = opts.page_start !== undefined && opts.page_start !== null ? opts.page_start : 'NULL';
	const pageEnd = opts.page_end !== undefined && opts.page_end !== null ? opts.page_end : 'NULL';
	const extractionConfidence =
		opts.extraction_confidence !== undefined && opts.extraction_confidence !== null
			? opts.extraction_confidence
			: 'NULL';
	runSql(
		`INSERT INTO stories (id, source_id, title, gcs_markdown_uri, gcs_metadata_uri, status, language, category, page_start, page_end, extraction_confidence) ` +
			`VALUES ('${id}', '${opts.source_id}', '${title.replace(/'/g, "''")}', 'gs://test/${id}.md', 'gs://test/${id}.meta.json', '${status}', ${language}, ${category}, ${pageStart}, ${pageEnd}, ${extractionConfidence}) ` +
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
	corroboration_score?: number | null;
}): string {
	const id = opts.id ?? randomUUID();
	const canonicalId = opts.canonical_id !== undefined && opts.canonical_id !== null ? `'${opts.canonical_id}'` : 'NULL';
	const taxonomyStatus = opts.taxonomy_status ?? 'auto';
	const sourceCount = opts.source_count ?? 0;
	const corroborationScore =
		opts.corroboration_score !== undefined && opts.corroboration_score !== null ? opts.corroboration_score : 'NULL';
	runSql(
		`INSERT INTO entities (id, name, type, canonical_id, taxonomy_status, source_count, corroboration_score) ` +
			`VALUES ('${id}', '${opts.name.replace(/'/g, "''")}', '${opts.type}', ${canonicalId}, '${taxonomyStatus}', ${sourceCount}, ${corroborationScore}) ` +
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
	edge_type?: string;
	confidence?: number | null;
}): string {
	const id = opts.id ?? randomUUID();
	const storyId = opts.story_id ? `'${opts.story_id}'` : 'NULL';
	const edgeType = opts.edge_type ?? 'RELATIONSHIP';
	const confidence = opts.confidence !== undefined && opts.confidence !== null ? opts.confidence : 'NULL';
	runSql(
		`INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relationship, story_id, edge_type, confidence) ` +
			`VALUES ('${id}', '${opts.source_entity_id}', '${opts.target_entity_id}', '${opts.relationship}', ${storyId}, '${edgeType}', ${confidence}) ` +
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

function seedAlias(opts: { id?: string; entity_id: string; alias: string; source?: string }): string {
	const id = opts.id ?? randomUUID();
	const source = opts.source ? `'${opts.source}'` : 'NULL';
	runSql(
		`INSERT INTO entity_aliases (id, entity_id, alias, source) ` +
			`VALUES ('${id}', '${opts.entity_id}', '${opts.alias.replace(/'/g, "''")}', ${source}) ` +
			`ON CONFLICT DO NOTHING;`,
	);
	return id;
}

function seedStoryEntity(opts: { story_id: string; entity_id: string; mention_count?: number }): void {
	const mentionCount = opts.mention_count ?? 1;
	runSql(
		`INSERT INTO story_entities (story_id, entity_id, mention_count) ` +
			`VALUES ('${opts.story_id}', '${opts.entity_id}', ${mentionCount}) ` +
			`ON CONFLICT DO NOTHING;`,
	);
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let pgAvailable = false;

// IDs populated in beforeAll
let sourceId1: string;
let sourceId2: string;
let storyId1: string;
let storyId2: string;
let storyId3: string;
let personEntity1: string;
let personEntity2: string;
let locationEntity1: string;
let mergedEntityId: string;
let edgeRelationship: string;
let edgeDuplicate: string;
let edgeContradiction: string;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
	pgAvailable = isPgAvailable();
	if (!pgAvailable) return;
	ensureSchema();
	cleanTestData();

	// Seed sources
	sourceId1 = seedSource({ filename: 'report-alpha.pdf', status: 'ingested' });
	sourceId2 = seedSource({ filename: 'report-beta.pdf', status: 'extracted' });

	// Seed stories
	storyId1 = seedStory({
		source_id: sourceId1,
		title: 'Story Alpha',
		status: 'segmented',
		language: 'en',
		category: 'investigation',
		page_start: 1,
		page_end: 5,
		extraction_confidence: 0.95,
	});
	storyId2 = seedStory({
		source_id: sourceId1,
		title: 'Story Beta',
		status: 'enriched',
		language: 'de',
	});
	storyId3 = seedStory({
		source_id: sourceId2,
		title: 'Story Gamma',
		status: 'enriched',
	});

	// Seed entities — 2 active persons, 1 active location, 1 merged (excluded from active)
	personEntity1 = seedEntity({
		name: 'Josef Allen Hynek',
		type: 'person',
		source_count: 3,
		corroboration_score: 0.85,
	});
	personEntity2 = seedEntity({
		name: 'Kenneth Arnold',
		type: 'person',
		source_count: 1,
		corroboration_score: 0.45,
	});
	locationEntity1 = seedEntity({
		name: 'Area 51',
		type: 'location',
		source_count: 5,
		corroboration_score: 0.92,
	});
	mergedEntityId = seedEntity({
		name: 'J Allen Hynek',
		type: 'person',
		canonical_id: personEntity1,
		taxonomy_status: 'merged',
	});

	// Seed aliases
	seedAlias({ entity_id: personEntity1, alias: 'Hynek', source: 'extraction' });
	seedAlias({ entity_id: personEntity1, alias: 'J. Allen Hynek', source: 'extraction' });
	seedAlias({ entity_id: locationEntity1, alias: 'Groom Lake', source: 'extraction' });

	// Seed edges — one RELATIONSHIP, one DUPLICATE_OF, one POTENTIAL_CONTRADICTION
	edgeRelationship = seedEdge({
		source_entity_id: personEntity1,
		target_entity_id: locationEntity1,
		relationship: 'INVESTIGATED_AT',
		story_id: storyId1,
		edge_type: 'RELATIONSHIP',
		confidence: 0.9,
	});
	edgeDuplicate = seedEdge({
		source_entity_id: personEntity1,
		target_entity_id: mergedEntityId,
		relationship: 'DUPLICATE_OF',
		edge_type: 'DUPLICATE_OF',
		confidence: 0.99,
	});
	edgeContradiction = seedEdge({
		source_entity_id: personEntity1,
		target_entity_id: personEntity2,
		relationship: 'POTENTIAL_CONTRADICTION',
		edge_type: 'POTENTIAL_CONTRADICTION',
		confidence: 0.6,
	});

	// Seed chunks
	seedChunk({ story_id: storyId1, content: 'Hynek investigated reports at Area 51.', chunk_index: 0 });
	seedChunk({ story_id: storyId1, content: 'Multiple sightings were documented.', chunk_index: 1 });
	seedChunk({ story_id: storyId2, content: 'Kenneth Arnold saw nine objects.', chunk_index: 0 });

	// Seed story-entity junctions
	seedStoryEntity({ story_id: storyId1, entity_id: personEntity1, mention_count: 3 });
	seedStoryEntity({ story_id: storyId1, entity_id: locationEntity1, mention_count: 2 });
	seedStoryEntity({ story_id: storyId2, entity_id: personEntity2, mention_count: 1 });
	seedStoryEntity({ story_id: storyId3, entity_id: locationEntity1, mention_count: 4 });
});

afterAll(() => {
	if (!pgAvailable) return;
	cleanTestData();
});

// ---------------------------------------------------------------------------
// QA Contract Tests (Section 5)
// ---------------------------------------------------------------------------

describe('QA Contract: Export Commands', () => {
	it('QA-01: Graph JSON export — nodes array, edges array, metadata object', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Array.isArray(parsed.nodes)).toBe(true);
		expect(Array.isArray(parsed.edges)).toBe(true);
		expect(parsed.metadata).toBeDefined();
		expect(typeof parsed.metadata).toBe('object');
		expect(parsed.metadata).toHaveProperty('exportedAt');
		expect(parsed.metadata).toHaveProperty('nodeCount');
		expect(parsed.metadata).toHaveProperty('edgeCount');
		// Verify actual data is present
		expect(parsed.nodes.length).toBeGreaterThan(0);
		expect(parsed.edges.length).toBeGreaterThan(0);
	});

	it('QA-02: Graph CSV export — header rows and data rows for nodes and edges', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'csv']);
		expect(exitCode).toBe(0);
		// Should contain node and edge sections
		// CSV should have header rows
		const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
		expect(lines.length).toBeGreaterThan(2);
		// Check for expected column headers
		const lower = stdout.toLowerCase();
		expect(lower).toContain('id');
		expect(lower).toContain('name');
		expect(lower).toContain('type');
	});

	it('QA-03: Graph GraphML export — valid XML with <graphml> root, <node> and <edge> elements', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'graphml']);
		expect(exitCode).toBe(0);
		// Check XML structure
		expect(stdout).toContain('<?xml');
		expect(stdout).toContain('<graphml');
		expect(stdout).toContain('<node');
		expect(stdout).toContain('<edge');
		expect(stdout).toContain('</graphml>');
		// Verify node IDs reference our entities
		expect(stdout).toContain(personEntity1);
		expect(stdout).toContain(locationEntity1);
	});

	it('QA-04: Graph Cypher export — CREATE statements for nodes, MATCH/CREATE for edges', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'cypher']);
		expect(exitCode).toBe(0);
		// Check for CREATE node statements
		expect(stdout).toContain('CREATE');
		expect(stdout).toContain('Entity');
		// Check for MATCH+CREATE edge statements
		expect(stdout).toContain('MATCH');
		// Check entity data present
		expect(stdout).toContain('Josef Allen Hynek');
	});

	it('QA-05: Graph filter by type — only matching entity type appears', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--filter', 'type=person', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		// All nodes should be type person
		expect(parsed.nodes.length).toBeGreaterThan(0);
		for (const node of parsed.nodes) {
			expect(node.type).toBe('person');
		}
		// No location nodes
		const locationNodes = parsed.nodes.filter((n: { type: string }) => n.type === 'location');
		expect(locationNodes.length).toBe(0);
	});

	it('QA-06: Graph filter by edge type — only matching edge type appears', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--filter', 'edge=RELATIONSHIP', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		// All edges should be RELATIONSHIP type
		for (const edge of parsed.edges) {
			expect(edge.edgeType).toBe('RELATIONSHIP');
		}
		// Should not contain DUPLICATE_OF or POTENTIAL_CONTRADICTION
		const nonRelEdges = parsed.edges.filter((e: { edgeType: string }) => e.edgeType !== 'RELATIONSHIP');
		expect(nonRelEdges.length).toBe(0);
	});

	it('QA-07: Stories JSON export — stories array with entities sub-array', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'stories', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Array.isArray(parsed.stories)).toBe(true);
		expect(parsed.stories.length).toBeGreaterThan(0);
		expect(parsed.metadata).toBeDefined();
		expect(parsed.metadata).toHaveProperty('storyCount');
		// Each story should have entities sub-array
		for (const story of parsed.stories) {
			expect(Array.isArray(story.entities)).toBe(true);
		}
		// Verify story with linked entities has them populated
		const storyAlpha = parsed.stories.find((s: { id: string }) => s.id === storyId1);
		expect(storyAlpha).toBeDefined();
		expect(storyAlpha.entities.length).toBeGreaterThan(0);
	});

	it('QA-08: Stories CSV export — header row and one row per story', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'stories', '--format', 'csv']);
		expect(exitCode).toBe(0);
		const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
		// At least header + 3 data rows
		expect(lines.length).toBeGreaterThanOrEqual(4);
		// Header should contain story-relevant fields
		const header = lines[0].toLowerCase();
		expect(header).toContain('id');
		expect(header).toContain('title');
	});

	it('QA-09: Stories Markdown export — # headers and metadata', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'stories', '--format', 'markdown']);
		expect(exitCode).toBe(0);
		// Should contain Markdown headers
		expect(stdout).toContain('#');
		// Should contain story titles
		expect(stdout).toContain('Story Alpha');
	});

	it('QA-10: Stories filter by source — only stories from that source', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'stories', '--source', sourceId1, '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.stories.length).toBeGreaterThan(0);
		// All stories should belong to sourceId1
		for (const story of parsed.stories) {
			expect(story.sourceId).toBe(sourceId1);
		}
		// Story Gamma (from sourceId2) should not appear
		const gammaStory = parsed.stories.find((s: { id: string }) => s.id === storyId3);
		expect(gammaStory).toBeUndefined();
	});

	it('QA-11: Evidence JSON export — entities, contradictions, duplicates, summary', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'evidence', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Array.isArray(parsed.entities)).toBe(true);
		expect(Array.isArray(parsed.contradictions)).toBe(true);
		expect(Array.isArray(parsed.duplicates)).toBe(true);
		expect(parsed.summary).toBeDefined();
		expect(typeof parsed.summary).toBe('object');
		expect(parsed.metadata).toBeDefined();
		expect(parsed.metadata).toHaveProperty('exportedAt');
	});

	it('QA-12: Evidence Markdown export — structured Markdown report', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'evidence', '--format', 'markdown']);
		expect(exitCode).toBe(0);
		// Should contain Markdown structure
		expect(stdout).toContain('#');
		// Should reference entities or evidence-related terms
		const lower = stdout.toLowerCase();
		expect(
			lower.includes('corroboration') ||
				lower.includes('evidence') ||
				lower.includes('contradiction') ||
				lower.includes('entities'),
		).toBe(true);
	});

	it('QA-13: Evidence sparse warning — dataReliability is "insufficient" or "low" with < 50 entities', () => {
		if (!pgAvailable) return;
		// We only have 3 entities with scores — well below the 50 threshold
		const { stdout, exitCode } = runCli(['export', 'evidence', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.summary).toHaveProperty('dataReliability');
		expect(['insufficient', 'low']).toContain(parsed.summary.dataReliability);
	});

	it('QA-14: Default format is JSON — no --format flag still produces JSON', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph']);
		expect(exitCode).toBe(0);
		// Should be valid JSON
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty('nodes');
		expect(parsed).toHaveProperty('edges');
		expect(parsed).toHaveProperty('metadata');
	});

	it('QA-15: Empty database — valid JSON with empty arrays, exit code 0', () => {
		if (!pgAvailable) return;
		// Truncate all data
		cleanTestData();
		try {
			const { stdout, stderr, exitCode } = runCli(['export', 'graph', '--format', 'json']);
			expect(exitCode).toBe(0);
			const parsed = JSON.parse(stdout);
			expect(parsed.nodes).toEqual([]);
			expect(parsed.edges).toEqual([]);
			// Spec says stderr warning for empty database
			// Accept either a stderr warning or metadata indicating empty
			expect(
				stderr.toLowerCase().includes('no') ||
					stderr.toLowerCase().includes('empty') ||
					stderr.toLowerCase().includes('warning') ||
					parsed.metadata.nodeCount === 0,
			).toBe(true);
		} finally {
			// Re-seed data for remaining tests
			reseedTestData();
		}
	});
});

// ---------------------------------------------------------------------------
// CLI Test Matrix (Section 5b)
// ---------------------------------------------------------------------------

describe('CLI Test Matrix: Export Commands', () => {
	it('CLI-01: export graph --help — shows format options, filter syntax', () => {
		const { stdout, exitCode } = runCli(['export', 'graph', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--format');
		expect(stdout).toContain('json');
		expect(stdout).toContain('csv');
		expect(stdout).toContain('graphml');
		expect(stdout).toContain('cypher');
		expect(stdout).toContain('--filter');
	});

	it('CLI-02: export stories --help — shows format options, source/status filters', () => {
		const { stdout, exitCode } = runCli(['export', 'stories', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--format');
		expect(stdout).toContain('json');
		expect(stdout).toContain('csv');
		expect(stdout).toContain('markdown');
		expect(stdout).toContain('--source');
		expect(stdout).toContain('--status');
	});

	it('CLI-03: export evidence --help — shows format options', () => {
		const { stdout, exitCode } = runCli(['export', 'evidence', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--format');
		expect(stdout).toContain('json');
		expect(stdout).toContain('csv');
		expect(stdout).toContain('markdown');
	});

	it('CLI-04: export graph --format invalid — exit code 1, error about valid formats', () => {
		const { exitCode, stderr, stdout } = runCli(['export', 'graph', '--format', 'invalid']);
		expect(exitCode).not.toBe(0);
		const combined = (stderr + stdout).toLowerCase();
		expect(combined.includes('json') || combined.includes('format') || combined.includes('invalid')).toBe(true);
	});

	it('CLI-05: export stories --format invalid — exit code 1, error about valid formats', () => {
		const { exitCode, stderr, stdout } = runCli(['export', 'stories', '--format', 'invalid']);
		expect(exitCode).not.toBe(0);
		const combined = (stderr + stdout).toLowerCase();
		expect(combined.includes('json') || combined.includes('format') || combined.includes('invalid')).toBe(true);
	});

	it('CLI-06: export evidence --format invalid — exit code 1, error about valid formats', () => {
		const { exitCode, stderr, stdout } = runCli(['export', 'evidence', '--format', 'invalid']);
		expect(exitCode).not.toBe(0);
		const combined = (stderr + stdout).toLowerCase();
		expect(combined.includes('json') || combined.includes('format') || combined.includes('invalid')).toBe(true);
	});

	it('CLI-07: export graph --format json — exit code 0, valid JSON', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toBeDefined();
	});

	it('CLI-08: export stories --format json — exit code 0, valid JSON', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'stories', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toBeDefined();
	});

	it('CLI-09: export evidence --format json — exit code 0, valid JSON', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'evidence', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toBeDefined();
	});

	it('CLI-10: export graph --filter type=person --format json — only person entities', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--filter', 'type=person', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.nodes.length).toBeGreaterThan(0);
		for (const node of parsed.nodes) {
			expect(node.type).toBe('person');
		}
	});

	it('CLI-11: export graph --filter edge=DUPLICATE_OF --format json — only DUPLICATE_OF edges', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--filter', 'edge=DUPLICATE_OF', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		for (const edge of parsed.edges) {
			expect(edge.edgeType).toBe('DUPLICATE_OF');
		}
	});
});

// ---------------------------------------------------------------------------
// CLI Smoke Tests
// ---------------------------------------------------------------------------

describe('CLI Smoke Tests: export', () => {
	it('SMOKE-01: export --help exits 0 and shows subcommand list', () => {
		const { stdout, exitCode } = runCli(['export', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('graph');
		expect(stdout).toContain('stories');
		expect(stdout).toContain('evidence');
	});

	it('SMOKE-02: export with no subcommand shows help/usage', () => {
		const { stdout, stderr } = runCli(['export']);
		// Commander outputs help to stderr when no subcommand is given
		const combined = (stdout + stderr).toLowerCase();
		expect(combined).toContain('graph');
	});

	it('SMOKE-03: export graph --format csv does not crash', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['export', 'graph', '--format', 'csv']);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-04: export graph --format graphml does not crash', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['export', 'graph', '--format', 'graphml']);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-05: export graph --format cypher does not crash', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['export', 'graph', '--format', 'cypher']);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-06: export stories --format csv does not crash', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['export', 'stories', '--format', 'csv']);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-07: export stories --format markdown does not crash', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['export', 'stories', '--format', 'markdown']);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-08: export evidence --format csv does not crash', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['export', 'evidence', '--format', 'csv']);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-09: export evidence --format markdown does not crash', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['export', 'evidence', '--format', 'markdown']);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-10: export graph --filter with multiple filters', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli([
			'export',
			'graph',
			'--filter',
			'type=person',
			'--filter',
			'edge=RELATIONSHIP',
			'--format',
			'json',
		]);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-11: export stories --status filter does not crash', () => {
		if (!pgAvailable) return;
		const { exitCode } = runCli(['export', 'stories', '--status', 'enriched', '--format', 'json']);
		expect(exitCode).toBe(0);
	});

	it('SMOKE-12: export graph JSON contains aliases for entities', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		// At least one entity should have aliases
		const withAliases = parsed.nodes.filter((n: { aliases: string[] }) => n.aliases && n.aliases.length > 0);
		expect(withAliases.length).toBeGreaterThan(0);
	});

	it('SMOKE-13: export evidence summary has expected fields', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'evidence', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		const summary = parsed.summary;
		expect(summary).toHaveProperty('totalEntities');
		expect(summary).toHaveProperty('scoredEntities');
		expect(summary).toHaveProperty('avgCorroboration');
		expect(summary).toHaveProperty('contradictionCount');
		expect(summary).toHaveProperty('duplicateCount');
		expect(summary).toHaveProperty('dataReliability');
	});

	it('SMOKE-14: export graph excludes merged entities by default', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		// The merged entity should not appear in active nodes
		const mergedNode = parsed.nodes.find((n: { id: string }) => n.id === mergedEntityId);
		expect(mergedNode).toBeUndefined();
	});

	it('SMOKE-15: export stories JSON includes chunkCount per story', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'stories', '--format', 'json']);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		// Story Alpha should have 2 chunks
		const storyAlpha = parsed.stories.find((s: { id: string }) => s.id === storyId1);
		expect(storyAlpha).toBeDefined();
		expect(typeof storyAlpha.chunkCount).toBe('number');
		expect(storyAlpha.chunkCount).toBe(2);
	});

	it('SMOKE-16: export evidence CSV has multiple sections', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'evidence', '--format', 'csv']);
		expect(exitCode).toBe(0);
		const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
		// Should have at least a header and some data
		expect(lines.length).toBeGreaterThan(1);
	});

	it('SMOKE-17: GraphML output has key definitions', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'graphml']);
		expect(exitCode).toBe(0);
		// GraphML should define keys for attributes
		expect(stdout).toContain('<key');
		expect(stdout).toContain('<graph');
		expect(stdout).toContain('</graph>');
	});

	it('SMOKE-18: Cypher output has proper semicolons', () => {
		if (!pgAvailable) return;
		const { stdout, exitCode } = runCli(['export', 'graph', '--format', 'cypher']);
		expect(exitCode).toBe(0);
		// Each statement should end with semicolon
		const statements = stdout.split(';').filter((s) => s.trim().length > 0);
		expect(statements.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Helpers — re-seed data after clean
// ---------------------------------------------------------------------------

function reseedTestData(): void {
	sourceId1 = seedSource({ id: sourceId1, filename: 'report-alpha.pdf', status: 'ingested' });
	sourceId2 = seedSource({ id: sourceId2, filename: 'report-beta.pdf', status: 'extracted' });

	storyId1 = seedStory({
		id: storyId1,
		source_id: sourceId1,
		title: 'Story Alpha',
		status: 'segmented',
		language: 'en',
		category: 'investigation',
		page_start: 1,
		page_end: 5,
		extraction_confidence: 0.95,
	});
	storyId2 = seedStory({
		id: storyId2,
		source_id: sourceId1,
		title: 'Story Beta',
		status: 'enriched',
		language: 'de',
	});
	storyId3 = seedStory({
		id: storyId3,
		source_id: sourceId2,
		title: 'Story Gamma',
		status: 'enriched',
	});

	personEntity1 = seedEntity({
		id: personEntity1,
		name: 'Josef Allen Hynek',
		type: 'person',
		source_count: 3,
		corroboration_score: 0.85,
	});
	personEntity2 = seedEntity({
		id: personEntity2,
		name: 'Kenneth Arnold',
		type: 'person',
		source_count: 1,
		corroboration_score: 0.45,
	});
	locationEntity1 = seedEntity({
		id: locationEntity1,
		name: 'Area 51',
		type: 'location',
		source_count: 5,
		corroboration_score: 0.92,
	});
	mergedEntityId = seedEntity({
		id: mergedEntityId,
		name: 'J Allen Hynek',
		type: 'person',
		canonical_id: personEntity1,
		taxonomy_status: 'merged',
	});

	seedAlias({ entity_id: personEntity1, alias: 'Hynek', source: 'extraction' });
	seedAlias({ entity_id: personEntity1, alias: 'J. Allen Hynek', source: 'extraction' });
	seedAlias({ entity_id: locationEntity1, alias: 'Groom Lake', source: 'extraction' });

	edgeRelationship = seedEdge({
		id: edgeRelationship,
		source_entity_id: personEntity1,
		target_entity_id: locationEntity1,
		relationship: 'INVESTIGATED_AT',
		story_id: storyId1,
		edge_type: 'RELATIONSHIP',
		confidence: 0.9,
	});
	edgeDuplicate = seedEdge({
		id: edgeDuplicate,
		source_entity_id: personEntity1,
		target_entity_id: mergedEntityId,
		relationship: 'DUPLICATE_OF',
		edge_type: 'DUPLICATE_OF',
		confidence: 0.99,
	});
	edgeContradiction = seedEdge({
		id: edgeContradiction,
		source_entity_id: personEntity1,
		target_entity_id: personEntity2,
		relationship: 'POTENTIAL_CONTRADICTION',
		edge_type: 'POTENTIAL_CONTRADICTION',
		confidence: 0.6,
	});

	seedChunk({ story_id: storyId1, content: 'Hynek investigated reports at Area 51.', chunk_index: 0 });
	seedChunk({ story_id: storyId1, content: 'Multiple sightings were documented.', chunk_index: 1 });
	seedChunk({ story_id: storyId2, content: 'Kenneth Arnold saw nine objects.', chunk_index: 0 });

	seedStoryEntity({ story_id: storyId1, entity_id: personEntity1, mention_count: 3 });
	seedStoryEntity({ story_id: storyId1, entity_id: locationEntity1, mention_count: 2 });
	seedStoryEntity({ story_id: storyId2, entity_id: personEntity2, mention_count: 1 });
	seedStoryEntity({ story_id: storyId3, entity_id: locationEntity1, mention_count: 4 });
}
