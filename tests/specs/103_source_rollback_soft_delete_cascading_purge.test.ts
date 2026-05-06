import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateExistingTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

const ROLLBACK_TABLES = [
	'audit_log',
	'source_deletions',
	'knowledge_assertions',
	'chunks',
	'story_entities',
	'entity_edges',
	'entity_aliases',
	'entities',
	'stories',
	'pipeline_run_sources',
	'pipeline_runs',
	'document_quality_assessments',
	'source_steps',
	'url_lifecycle',
	'url_host_lifecycle',
	'document_blobs',
	'sources',
] as const;

const pgAvailable = db.isPgAvailable();
let pool: pg.Pool;
let coreModule: typeof import('@mulder/core');
let tempDir: string | null = null;

type SourceRecord = Awaited<ReturnType<typeof coreModule.createSource>>;
type StoryRecord = Awaited<ReturnType<typeof coreModule.createStory>>;

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		encoding: 'utf-8',
		timeout: 180_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, MULDER_LOG_LEVEL: 'silent' },
	});
	if ((result.status ?? 1) !== 0) {
		throw new Error(`Build failed in ${packageDir}:\n${result.stdout}\n${result.stderr}`);
	}
}

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI_DIST, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 120_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_CONFIG: EXAMPLE_CONFIG,
			MULDER_LOG_LEVEL: 'silent',
			PGHOST: db.TEST_PG_HOST,
			PGPORT: String(db.TEST_PG_PORT),
			PGUSER: db.TEST_PG_USER,
			PGPASSWORD: db.TEST_PG_PASSWORD,
			PGDATABASE: db.TEST_PG_DATABASE,
		},
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function combinedOutput(result: { stdout: string; stderr: string }): string {
	return `${result.stdout}\n${result.stderr}`;
}

function writeMinimalConfigWithoutRollback(): string {
	tempDir ??= mkdtempSync(join(tmpdir(), 'mulder-spec103-'));
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec103"',
			'  description: "Spec 103 minimal config"',
			'  supported_locales: ["en"]',
			'gcp:',
			'  project_id: "test-project"',
			'  region: "europe-west1"',
			'  cloud_sql:',
			'    instance_name: "mulder-db"',
			'    database: "mulder"',
			'    tier: "db-custom-2-8192"',
			'  storage:',
			'    bucket: "mulder-test"',
			'  document_ai:',
			'    processor_id: "processor"',
			'    location: "eu"',
			'ontology:',
			'  entity_types:',
			'    - name: "person"',
			'      description: "Person"',
			'      attributes: []',
			'    - name: "event"',
			'      description: "Event"',
			'      attributes: []',
			'  relationships:',
			'    - name: "PARTICIPATED_IN"',
			'      source: "person"',
			'      target: "event"',
			'',
		].join('\n'),
		'utf-8',
	);
	return configPath;
}

function parseJsonOutput(result: { stdout: string; stderr: string }): unknown {
	const output = result.stdout.trim() || result.stderr.trim();
	try {
		return JSON.parse(output);
	} catch {
		const match = output.match(/\{[\s\S]*\}/);
		if (!match) {
			throw new Error(`Expected JSON output, got:\n${combinedOutput(result)}`);
		}
		return JSON.parse(match[0]);
	}
}

function expectSuccessJson(result: { stdout: string; stderr: string; exitCode: number }): void {
	expect(result.exitCode, combinedOutput(result)).toBe(0);
	expect(() => parseJsonOutput(result)).not.toThrow();
}

function expectNonZero(result: { stdout: string; stderr: string; exitCode: number }): void {
	expect(result.exitCode, combinedOutput(result)).not.toBe(0);
}

function expectAuditEvent(events: Array<{ eventType: string }>, pattern: RegExp): void {
	expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
}

function qualityDimensions(): import('@mulder/core').DocumentQualityDimensions {
	return {
		textReadability: { score: 0.8, method: 'ocr_confidence', details: 'spec103 fixture' },
		imageQuality: { score: 0.9, issues: [] },
		languageDetection: { primaryLanguage: 'en', confidence: 0.95, mixedLanguages: false },
		documentStructure: {
			type: 'printed_text',
			hasAnnotations: false,
			hasMarginalia: false,
			multiColumn: false,
		},
		contentCompleteness: {
			pagesTotal: 1,
			pagesReadable: 1,
			missingPagesSuspected: false,
			truncated: false,
		},
	};
}

async function createSourceFixture(label = 'spec103'): Promise<SourceRecord> {
	return await coreModule.createSource(pool, {
		filename: `${label}-${randomUUID()}.txt`,
		storagePath: `raw/${label}-${randomUUID()}.txt`,
		fileHash: `${label}-${randomUUID()}`,
		sourceType: 'text',
		formatMetadata: { media_type: 'text/plain' },
		pageCount: 1,
		hasNativeText: true,
		nativeTextRatio: 1,
	});
}

async function createStoryFixture(sourceId: string, label = 'spec103'): Promise<StoryRecord> {
	return await coreModule.createStory(pool, {
		sourceId,
		title: `Spec 103 ${label}`,
		gcsMarkdownUri: `segments/${sourceId}/${label}.md`,
		gcsMetadataUri: `segments/${sourceId}/${label}.json`,
		extractionConfidence: 0.9,
	});
}

async function createSourceWithCascadeArtifacts(label = 'spec103'): Promise<{
	source: SourceRecord;
	story: StoryRecord;
	assertionId: string;
}> {
	const source = await createSourceFixture(label);
	await coreModule.updateSourceStatus(pool, source.id, 'analyzed');
	const story = await createStoryFixture(source.id, label);
	await coreModule.updateStoryStatus(pool, story.id, 'graphed');
	const entityA = await coreModule.createEntity(pool, {
		name: `${label} Person ${randomUUID()}`,
		type: 'person',
		provenance: { sourceDocumentIds: [source.id] },
	});
	const entityB = await coreModule.createEntity(pool, {
		name: `${label} Event ${randomUUID()}`,
		type: 'event',
		provenance: { sourceDocumentIds: [source.id] },
	});
	await coreModule.createEntityAlias(pool, {
		entityId: entityA.id,
		alias: `${label} Alias ${randomUUID()}`,
		source: 'spec103',
		provenance: { sourceDocumentIds: [source.id] },
	});
	await coreModule.linkStoryEntity(pool, {
		storyId: story.id,
		entityId: entityA.id,
		confidence: 0.9,
		mentionCount: 1,
		provenance: { sourceDocumentIds: [source.id] },
	});
	await coreModule.createEdge(pool, {
		sourceEntityId: entityA.id,
		targetEntityId: entityB.id,
		relationship: 'PARTICIPATED_IN',
		storyId: story.id,
		confidence: 0.8,
		provenance: { sourceDocumentIds: [source.id] },
	});
	await coreModule.createChunk(pool, {
		storyId: story.id,
		content: 'Spec 103 rollback chunk',
		chunkIndex: 0,
		provenance: { sourceDocumentIds: [source.id] },
	});
	const assertion = await coreModule.upsertKnowledgeAssertion(pool, {
		sourceId: source.id,
		storyId: story.id,
		assertionType: 'observation',
		content: `Spec 103 assertion ${randomUUID()}`,
		confidenceMetadata: {
			witnessCount: 1,
			measurementBased: false,
			contemporaneous: true,
			corroborated: false,
			peerReviewed: false,
			authorIsInterpreter: false,
		},
		provenance: { sourceDocumentIds: [source.id] },
	});
	const run = await coreModule.createPipelineRun(pool, { tag: 'spec103', options: { dryRun: false } });
	await coreModule.upsertPipelineRunSource(pool, {
		runId: run.id,
		sourceId: source.id,
		currentStep: 'graph',
		status: 'completed',
	});
	await coreModule.upsertSourceStep(pool, {
		sourceId: source.id,
		stepName: 'graph',
		status: 'completed',
		configHash: `spec103-${randomUUID()}`,
	});
	await coreModule.createDocumentQualityAssessment(pool, {
		sourceId: source.id,
		assessmentMethod: 'automated',
		overallQuality: 'high',
		processable: true,
		recommendedPath: 'standard',
		dimensions: qualityDimensions(),
		signals: { fixture: 'spec103' },
	});
	await coreModule.recordUrlLifecycleFetch(pool, {
		sourceId: source.id,
		originalUrl: `https://example.test/${source.id}`,
		normalizedUrl: `https://example.test/${source.id}`,
		finalUrl: `https://example.test/${source.id}`,
		host: 'example.test',
		lastFetchedAt: new Date('2026-05-01T00:00:00.000Z'),
		lastCheckedAt: new Date('2026-05-01T00:00:00.000Z'),
		robotsAllowed: true,
		lastContentHash: `spec103-url-${randomUUID()}`,
		lastSnapshotStoragePath: `snapshots/${source.id}.html`,
		changeKind: 'initial',
	});
	return { source, story, assertionId: assertion.id };
}

async function softDeleteFixture(sourceId: string): Promise<void> {
	await coreModule.softDeleteSource(pool, {
		sourceId,
		actor: 'spec103-test',
		reason: 'duplicate ingest',
	});
}

beforeAll(async () => {
	buildPackage(CORE_DIR);
	buildPackage(CLI_DIR);
	coreModule = await import(pathToFileURL(CORE_DIST).href);

	if (!pgAvailable) {
		console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
		return;
	}

	pool = new pg.Pool(PG_CONFIG);
	ensureSchema();
});

beforeEach(() => {
	if (!pgAvailable) {
		return;
	}
	truncateExistingTables(ROLLBACK_TABLES);
});

afterAll(async () => {
	if (pool) {
		await pool.end();
	}
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe('Spec 103: Source rollback soft delete and cascading purge', () => {
	it.skipIf(!pgAvailable)('QA-01: migration creates rollback state and audit tables', async () => {
		const { rows: columns } = await pool.query<{ column_name: string }>(
			`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND table_name = 'sources'
			  AND column_name IN ('deleted_at', 'deletion_status')
			ORDER BY column_name
			`,
		);
		expect(columns.map((row) => row.column_name)).toEqual(['deleted_at', 'deletion_status']);

		const { rows: tables } = await pool.query<{ table_name: string }>(
			`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = 'public'
			  AND table_name IN ('source_deletions', 'audit_log')
			ORDER BY table_name
			`,
		);
		expect(tables.map((row) => row.table_name)).toEqual(['audit_log', 'source_deletions']);

		const { rows: checks } = await pool.query<{ conname: string; definition: string }>(
			`
			SELECT conname, pg_get_constraintdef(oid) AS definition
			FROM pg_constraint
			WHERE conrelid IN ('sources'::regclass, 'source_deletions'::regclass)
			  AND contype = 'c'
			ORDER BY conname
			`,
		);
		const checkText = checks.map((row) => row.definition).join('\n');
		expect(checkText).toContain('soft_deleted');
		expect(checkText).toContain('purged');
		expect(checkText).toContain('restored');

		const { rows: indexes } = await pool.query<{ indexname: string }>(
			`
			SELECT indexname
			FROM pg_indexes
			WHERE schemaname = 'public'
			  AND tablename IN ('sources', 'source_deletions', 'audit_log')
			ORDER BY indexname
			`,
		);
		const indexText = indexes.map((row) => row.indexname).join('\n');
		expect(indexText).toMatch(/deleted|deletion|audit|source/i);
	});

	it('QA-02: config exposes A6 rollback defaults', () => {
		const config = coreModule.loadConfig(writeMinimalConfigWithoutRollback());
		expect(config.source_rollback).toMatchObject({
			undo_window_hours: 72,
			require_reason: true,
			require_confirmation: true,
			auto_purge_after_undo_window: true,
			orphan_handling: 'mark',
			journal_annotation: true,
			notify_on_purge: true,
		});
	});

	it.skipIf(!pgAvailable)('QA-03: soft-delete hides sources from normal reads', async () => {
		const { source, story } = await createSourceWithCascadeArtifacts('qa03');
		const deletion = await coreModule.softDeleteSource(pool, {
			sourceId: source.id,
			actor: 'spec103-test',
			reason: 'duplicate ingest',
			deletedAt: new Date('2026-05-01T00:00:00.000Z'),
		});

		expect(deletion.status).toBe('soft_deleted');
		expect(deletion.undoDeadline.toISOString()).toBe('2026-05-04T00:00:00.000Z');
		await expect(coreModule.findSourceById(pool, source.id)).resolves.toBeNull();
		await expect(coreModule.findSourceById(pool, source.id, { includeDeleted: true })).resolves.toMatchObject({
			id: source.id,
			deletionStatus: 'soft_deleted',
		});
		await expect(coreModule.findAllSources(pool)).resolves.not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: source.id })]),
		);
		await expect(coreModule.findStoriesBySourceId(pool, source.id)).resolves.toEqual([]);
		await expect(coreModule.findStoriesBySourceId(pool, source.id, { includeDeleted: true })).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: story.id })]),
		);
		await expect(coreModule.findChunksBySourceId(pool, source.id)).resolves.toEqual([]);
		await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toMatchObject({
			sourceId: source.id,
			status: 'soft_deleted',
			reason: 'duplicate ingest',
		});
		expectAuditEvent(await coreModule.listAuditEventsForSource(pool, source.id), /rollback|delete/i);
	});

	it.skipIf(!pgAvailable)('QA-04: restore reactivates a soft-deleted source', async () => {
		const { source } = await createSourceWithCascadeArtifacts('qa04');
		await softDeleteFixture(source.id);

		const restored = await coreModule.restoreSource(pool, {
			sourceId: source.id,
			actor: 'spec103-test',
			reason: 'undo requested',
			restoredAt: new Date('2026-05-02T00:00:00.000Z'),
		});

		expect(restored.status).toBe('restored');
		await expect(coreModule.findSourceById(pool, source.id)).resolves.toMatchObject({
			id: source.id,
		});
		const visibleSource = await coreModule.findSourceById(pool, source.id);
		expect(['active', 'restored']).toContain(visibleSource?.deletionStatus);
		expectAuditEvent(await coreModule.listAuditEventsForSource(pool, source.id), /restore/i);
	});

	it.skipIf(!pgAvailable)('QA-05: purge dry-run reports planned cascade without deleting rows', async () => {
		const { source, story, assertionId } = await createSourceWithCascadeArtifacts('qa05');
		await softDeleteFixture(source.id);

		const plan = await coreModule.planSourcePurge(pool, source.id);

		expect(plan.canPurge).toBe(true);
		expect(plan.totalExclusive).toBeGreaterThan(0);
		expect(plan.counts.filter((count) => count.total > 0).length).toBeGreaterThanOrEqual(5);
		expect(plan.counts.every((count) => count.subsystem.length > 0)).toBe(true);
		await expect(coreModule.findStoryById(pool, story.id, { includeDeleted: true })).resolves.toMatchObject({
			id: story.id,
		});
		await expect(coreModule.findSourceSteps(pool, source.id)).resolves.not.toHaveLength(0);
		await expect(coreModule.findUrlLifecycleBySourceId(pool, source.id)).resolves.toMatchObject({
			sourceId: source.id,
		});
		const { rows: assertions } = await pool.query('SELECT id FROM knowledge_assertions WHERE id = $1', [assertionId]);
		expect(assertions).toHaveLength(1);
	});

	it.skipIf(!pgAvailable)('QA-06: purge deletes exclusive artifacts and keeps audit', async () => {
		const { source } = await createSourceWithCascadeArtifacts('qa06');
		await softDeleteFixture(source.id);

		const report = await coreModule.purgeSource(pool, {
			sourceId: source.id,
			actor: 'spec103-test',
			reason: 'requested removal',
			confirmed: true,
		});

		expect(report.status).toBe('purged');
		expect(report.effects.storiesDeleted).toBeGreaterThan(0);
		expect(report.effects.chunksDeleted).toBeGreaterThan(0);
		expect(report.effects.knowledgeAssertionsSoftDeleted).toBeGreaterThan(0);
		await expect(coreModule.findSourceById(pool, source.id)).resolves.toBeNull();
		await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toMatchObject({ status: 'purged' });
		expectAuditEvent(await coreModule.listAuditEventsForSource(pool, source.id), /purge/i);
	});

	it.skipIf(!pgAvailable)('QA-07: purge subtracts shared provenance', async () => {
		const sourceA = await createSourceFixture('qa07-a');
		const sourceB = await createSourceFixture('qa07-b');
		const storyA = await createStoryFixture(sourceA.id, 'qa07-a');
		const assertion = await coreModule.upsertKnowledgeAssertion(pool, {
			sourceId: sourceA.id,
			storyId: storyA.id,
			assertionType: 'observation',
			content: `Shared provenance assertion ${randomUUID()}`,
			confidenceMetadata: {
				witnessCount: 2,
				measurementBased: false,
				contemporaneous: true,
				corroborated: true,
				peerReviewed: false,
				authorIsInterpreter: false,
			},
			provenance: { sourceDocumentIds: [sourceA.id, sourceB.id] },
		});
		await softDeleteFixture(sourceA.id);

		await coreModule.purgeSource(pool, {
			sourceId: sourceA.id,
			actor: 'spec103-test',
			reason: 'requested removal',
			confirmed: true,
		});

		const { rows } = await pool.query<{
			deleted_at: Date | null;
			provenance: { source_document_ids?: string[] };
		}>('SELECT deleted_at, provenance FROM knowledge_assertions WHERE id = $1', [assertion.id]);
		expect(rows).toHaveLength(1);
		expect(rows[0].deleted_at).toBeNull();
		expect(rows[0].provenance.source_document_ids).toEqual([sourceB.id]);
	});

	it.skipIf(!pgAvailable)('QA-08: CLI safety gates enforce reason and confirmation', async () => {
		const active = await createSourceFixture('qa08-active');
		const missingReason = runCli(['source', 'rollback', active.id, '--actor', 'spec103-test', '--json']);
		expectNonZero(missingReason);
		await expect(coreModule.findSourceDeletionForSource(pool, active.id)).resolves.toBeNull();
		await expect(coreModule.findSourceById(pool, active.id)).resolves.toMatchObject({ id: active.id });

		const deleted = await createSourceFixture('qa08-deleted');
		await softDeleteFixture(deleted.id);
		const missingConfirm = runCli([
			'source',
			'purge',
			deleted.id,
			'--reason',
			'requested removal',
			'--actor',
			'spec103-test',
			'--json',
		]);
		expectNonZero(missingConfirm);
		await expect(coreModule.findSourceDeletionForSource(pool, deleted.id)).resolves.toMatchObject({
			status: 'soft_deleted',
		});
	});

	it.skipIf(!pgAvailable)('QA-09: CLI rollback, restore, dry-run, and purge work with JSON output', async () => {
		const source = await createSourceFixture('qa09');
		expectSuccessJson(
			runCli(['source', 'rollback', source.id, '--reason', 'duplicate ingest', '--actor', 'spec103-test', '--json']),
		);
		await expect(coreModule.findSourceById(pool, source.id)).resolves.toBeNull();

		expectSuccessJson(runCli(['source', 'restore', source.id, '--actor', 'spec103-test', '--json']));
		await expect(coreModule.findSourceById(pool, source.id)).resolves.toMatchObject({ id: source.id });

		expectSuccessJson(
			runCli(['source', 'rollback', source.id, '--reason', 'duplicate ingest', '--actor', 'spec103-test', '--json']),
		);
		expectSuccessJson(runCli(['source', 'purge', source.id, '--dry-run', '--json']));
		await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toMatchObject({
			status: 'soft_deleted',
		});

		expectSuccessJson(
			runCli([
				'source',
				'purge',
				source.id,
				'--confirm',
				'--reason',
				'requested removal',
				'--actor',
				'spec103-test',
				'--json',
			]),
		);
		await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toMatchObject({ status: 'purged' });
	});
});

describe('Spec 103: CLI Test Matrix', () => {
	it.skipIf(!pgAvailable)(
		'CLI-01: `mulder source rollback <source-id> --reason "duplicate ingest" --actor test --json`',
		async () => {
			const source = await createSourceFixture('cli01');
			expectSuccessJson(
				runCli(['source', 'rollback', source.id, '--reason', 'duplicate ingest', '--actor', 'test', '--json']),
			);
			await expect(coreModule.findSourceById(pool, source.id)).resolves.toBeNull();
			await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toMatchObject({
				status: 'soft_deleted',
			});
		},
	);

	it.skipIf(!pgAvailable)('CLI-02: `mulder source rollback <source-id> --json` requires reason', async () => {
		const source = await createSourceFixture('cli02');
		expectNonZero(runCli(['source', 'rollback', source.id, '--json']));
		await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toBeNull();
	});

	it.skipIf(!pgAvailable)(
		'CLI-03: `mulder source restore <source-id> --actor test --json` restores a soft-deleted source',
		async () => {
			const source = await createSourceFixture('cli03');
			await softDeleteFixture(source.id);
			expectSuccessJson(runCli(['source', 'restore', source.id, '--actor', 'test', '--json']));
			await expect(coreModule.findSourceById(pool, source.id)).resolves.toMatchObject({ id: source.id });
		},
	);

	it.skipIf(!pgAvailable)('CLI-04: `mulder source purge <source-id> --dry-run --json` reports only', async () => {
		const source = await createSourceFixture('cli04');
		await softDeleteFixture(source.id);
		expectSuccessJson(runCli(['source', 'purge', source.id, '--dry-run', '--json']));
		await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toMatchObject({
			status: 'soft_deleted',
		});
	});

	it.skipIf(!pgAvailable)(
		'CLI-05: `mulder source purge <source-id> --confirm --reason "requested removal" --actor test --json` purges',
		async () => {
			const source = await createSourceFixture('cli05');
			await softDeleteFixture(source.id);
			expectSuccessJson(
				runCli([
					'source',
					'purge',
					source.id,
					'--confirm',
					'--reason',
					'requested removal',
					'--actor',
					'test',
					'--json',
				]),
			);
			await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toMatchObject({
				status: 'purged',
			});
		},
	);

	it.skipIf(!pgAvailable)(
		'CLI-06: `mulder source purge <source-id> --reason "requested removal"` requires confirmation',
		async () => {
			const source = await createSourceFixture('cli06');
			await softDeleteFixture(source.id);
			expectNonZero(runCli(['source', 'purge', source.id, '--reason', 'requested removal']));
			await expect(coreModule.findSourceDeletionForSource(pool, source.id)).resolves.toMatchObject({
				status: 'soft_deleted',
			});
		},
	);
});

describe('Spec 103: CLI Smoke Coverage', () => {
	it('SMOKE-01: source help exposes rollback commands', () => {
		const result = runCli(['source', '--help']);
		expect(result.exitCode, combinedOutput(result)).toBe(0);
		expect(combinedOutput(result)).toMatch(/rollback/);
		expect(combinedOutput(result)).toMatch(/restore/);
		expect(combinedOutput(result)).toMatch(/purge/);
	});

	it('SMOKE-02: rollback help exposes reason, actor, and JSON flags', () => {
		const result = runCli(['source', 'rollback', '--help']);
		expect(result.exitCode, combinedOutput(result)).toBe(0);
		expect(combinedOutput(result)).toMatch(/--reason/);
		expect(combinedOutput(result)).toMatch(/--actor/);
		expect(combinedOutput(result)).toMatch(/--json/);
	});

	it('SMOKE-03: purge help exposes dry-run, confirm, reason, actor, and JSON flags', () => {
		const result = runCli(['source', 'purge', '--help']);
		expect(result.exitCode, combinedOutput(result)).toBe(0);
		expect(combinedOutput(result)).toMatch(/--dry-run/);
		expect(combinedOutput(result)).toMatch(/--confirm/);
		expect(combinedOutput(result)).toMatch(/--reason/);
		expect(combinedOutput(result)).toMatch(/--actor/);
		expect(combinedOutput(result)).toMatch(/--json/);
	});
});
