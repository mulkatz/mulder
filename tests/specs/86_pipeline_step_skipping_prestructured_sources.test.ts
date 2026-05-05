import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PIPELINE_ERROR_CODES } from '@mulder/core';
import type { WorkerRuntimeContext } from '@mulder/worker';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const API_DIR = resolve(ROOT, 'apps/api');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const PIPELINE_DIST = resolve(PIPELINE_DIR, 'dist/index.js');
const WORKER_DIST = resolve(WORKER_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const CORE_MIGRATIONS_DIR = resolve(ROOT, 'packages/core/src/database/migrations');
const SPEC_STORAGE_DIR = testStoragePath('segments', 'spec-86');

type SourceTypeValue = 'pdf' | 'image' | 'text' | 'docx' | 'spreadsheet' | 'email' | 'url';
type PipelineStepValue = 'ingest' | 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';
type PlanPipelineSteps = (input: {
	sourceType: SourceTypeValue;
	from?: PipelineStepValue;
	upTo?: PipelineStepValue;
}) => {
	executableSteps: PipelineStepValue[];
	skippedSteps: PipelineStepValue[];
};

interface AcceptedResponse {
	data: {
		job_id: string;
		run_id: string;
		status: 'pending';
	};
}

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_LOG_LEVEL: 'silent',
		},
	});

	if ((result.status ?? 1) !== 0) {
		throw new Error(
			`Build failed in ${packageDir}:\n${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`,
		);
	}
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function cleanState(): void {
	db.runSql(
		[
			'DELETE FROM monthly_budget_reservations',
			'DELETE FROM jobs',
			'DELETE FROM pipeline_run_sources',
			'DELETE FROM pipeline_runs',
			'DELETE FROM source_steps',
			'DELETE FROM chunks',
			'DELETE FROM story_entities',
			'DELETE FROM entity_edges',
			'DELETE FROM entity_aliases',
			'DELETE FROM entities',
			'DELETE FROM stories',
			'DELETE FROM sources',
		].join('; '),
	);
}

function cleanSpecStorage(): void {
	if (existsSync(SPEC_STORAGE_DIR)) {
		rmSync(SPEC_STORAGE_DIR, { recursive: true, force: true });
	}
}

function insertTextSource(sourceId: string, status = 'extracted'): void {
	const fileHash = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
	db.runSql(
		[
			'INSERT INTO sources',
			'(id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata, source_type, format_metadata)',
			`VALUES (${sqlLiteral(sourceId)}, 'prestructured.txt', 'raw/prestructured.txt', ${sqlLiteral(fileHash)}, 1, true, 1, ${sqlLiteral(status)}, NULL, ARRAY[]::text[], '{}'::jsonb, 'text', '{}'::jsonb);`,
		].join(' '),
	);
}

function insertStory(sourceId: string, status = 'segmented'): string {
	const storyId = randomUUID();
	const markdownUri = `segments/spec-86/${sourceId}/${storyId}.md`;
	const metadataUri = `segments/spec-86/${sourceId}/${storyId}.meta.json`;
	db.runSql(
		[
			'INSERT INTO stories',
			'(id, source_id, title, language, gcs_markdown_uri, gcs_metadata_uri, status)',
			`VALUES (${sqlLiteral(storyId)}, ${sqlLiteral(sourceId)}, 'Prestructured story', 'en', ${sqlLiteral(markdownUri)}, ${sqlLiteral(metadataUri)}, ${sqlLiteral(status)});`,
		].join(' '),
	);
	return storyId;
}

function writeStoryMarkdown(sourceId: string, storyId: string): void {
	const dir = join(SPEC_STORAGE_DIR, sourceId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${storyId}.md`),
		'# Prestructured story\n\nDev Test Person visited Dev Test Location for a pipeline skip validation.',
	);
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
			PGPASSWORD: db.TEST_PG_PASSWORD,
		},
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

async function loadApiApp(): Promise<{ request: (input: string | Request, init?: RequestInit) => Promise<Response> }> {
	const module = await import(pathToFileURL(API_APP_DIST).href);
	return module.createApp({
		config: {
			port: 8080,
			auth: {
				api_keys: [{ name: 'cli', key: 'test-api-key' }],
				browser: {
					enabled: true,
					cookie_name: 'mulder_session',
					session_secret: 'test-session-secret',
					session_ttl_hours: 168,
					invitation_ttl_hours: 168,
					cookie_secure: false,
					same_site: 'Lax',
				},
			},
			rate_limiting: {
				enabled: true,
			},
		},
	});
}

async function apiPost(app: Awaited<ReturnType<typeof loadApiApp>>, body: unknown): Promise<Response> {
	return await app.request('http://localhost/api/pipeline/run', {
		method: 'POST',
		headers: {
			Authorization: 'Bearer test-api-key',
			'Content-Type': 'application/json',
			'X-Forwarded-For': '203.0.113.86',
		},
		body: JSON.stringify(body),
	});
}

describe('Spec 86 — Pipeline Step Skipping for Pre-Structured Sources', () => {
	let app: Awaited<ReturnType<typeof loadApiApp>>;
	let coreModule: typeof import('@mulder/core');
	let workerModule: typeof import('@mulder/worker');
	let workerContext: WorkerRuntimeContext;
	let planPipelineSteps: PlanPipelineSteps;

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);
		buildPackage(CLI_DIR);

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		const pipelineModule = (await import(pathToFileURL(PIPELINE_DIST).href)) as {
			planPipelineSteps: PlanPipelineSteps;
		};
		planPipelineSteps = pipelineModule.planPipelineSteps;
		workerModule = await import(pathToFileURL(WORKER_DIST).href);
		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		const cloudSql = config.gcp?.cloud_sql;
		if (!cloudSql) {
			throw new Error('Expected example config to include gcp.cloud_sql');
		}

		workerContext = {
			config,
			services: {} as never,
			pool: coreModule.getWorkerPool(cloudSql),
			logger: coreModule.createLogger({ level: 'silent' }),
			dispatch: async () => ({ ok: true }),
		};

		await coreModule.runMigrations(workerContext.pool, CORE_MIGRATIONS_DIR);
		app = await loadApiApp();
		cleanState();
		cleanSpecStorage();
	}, 600_000);

	beforeEach(() => {
		cleanState();
		cleanSpecStorage();
	});

	afterAll(() => {
		try {
			cleanState();
			cleanSpecStorage();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01/02/07: planner preserves layout sources and skips segment for pre-structured sources', () => {
		expect(planPipelineSteps({ sourceType: 'pdf' })).toMatchObject({
			executableSteps: ['ingest', 'extract', 'segment', 'enrich', 'embed', 'graph'],
			skippedSteps: [],
		});

		for (const sourceType of ['text', 'docx', 'spreadsheet', 'email', 'url'] as const) {
			expect(planPipelineSteps({ sourceType })).toMatchObject({
				executableSteps: ['ingest', 'extract', 'enrich', 'embed', 'graph'],
				skippedSteps: ['segment'],
			});
		}

		try {
			planPipelineSteps({ sourceType: 'text', from: 'segment', upTo: 'segment' });
			expect.fail('Expected segment-only text planning to fail');
		} catch (error) {
			expect(error).toMatchObject({
				code: PIPELINE_ERROR_CODES.PIPELINE_INVALID_STEP_RANGE,
			});
		}
	});

	it('QA-03/07: CLI dry-run shows skipped segment and rejects segment-only text runs', () => {
		const sourceId = randomUUID();
		insertTextSource(sourceId);
		insertStory(sourceId);

		const dryRun = runCli(['pipeline', 'run', '--from', 'segment', '--up-to', 'enrich', '--dry-run']);
		expect(dryRun.exitCode).toBe(0);
		const dryRunOutput = `${dryRun.stdout}\n${dryRun.stderr}`;
		expect(dryRunOutput).toContain('executable enrich');
		expect(dryRunOutput).toContain('skipped segment');

		const segmentOnly = runCli(['pipeline', 'run', '--from', 'segment', '--up-to', 'segment']);
		expect(segmentOnly.exitCode).toBe(1);
		expect(`${segmentOnly.stdout}\n${segmentOnly.stderr}`).toContain(PIPELINE_ERROR_CODES.PIPELINE_INVALID_STEP_RANGE);
		expect(db.runSql(`SELECT COUNT(*) FROM jobs WHERE payload->>'sourceId' = ${sqlLiteral(sourceId)};`)).toBe('0');
	});

	it('QA-04: synchronous pipeline executes enrich after skipped segment', () => {
		const sourceId = randomUUID();
		insertTextSource(sourceId);
		const storyId = insertStory(sourceId);
		writeStoryMarkdown(sourceId, storyId);

		const result = runCli(['pipeline', 'run', '--from', 'segment', '--up-to', 'enrich']);
		expect(result.exitCode).toBe(0);
		expect(db.runSql(`SELECT status FROM stories WHERE id = ${sqlLiteral(storyId)};`)).toBe('enriched');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'segment';`),
		).toBe('skipped');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'enrich';`),
		).toBe('completed');
		expect(
			db.runSql(
				`SELECT current_step || '|' || status FROM pipeline_run_sources WHERE source_id = ${sqlLiteral(sourceId)} ORDER BY updated_at DESC LIMIT 1;`,
			),
		).toBe('enrich|completed');
	});

	it('QA-05: API acceptance enqueues enrich instead of segment for pre-structured sources', async () => {
		const sourceId = randomUUID();
		insertTextSource(sourceId);
		insertStory(sourceId);

		const response = await apiPost(app, {
			source_id: sourceId,
			from: 'segment',
			up_to: 'enrich',
			tag: 'spec-86-api',
		});

		expect(response.status).toBe(202);
		const body = (await response.json()) as AcceptedResponse;
		expect(db.runSql(`SELECT type FROM jobs WHERE id = ${sqlLiteral(body.data.job_id)};`)).toBe('enrich');
		expect(
			db.runSql(
				`SELECT COUNT(*) FROM jobs WHERE payload->>'runId' = ${sqlLiteral(body.data.run_id)} AND type = 'segment';`,
			),
		).toBe('0');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'segment';`),
		).toBe('skipped');
	});

	it('QA-06: worker chaining skips segment after extract for pre-structured sources', async () => {
		const sourceId = randomUUID();
		const runId = randomUUID();
		const jobId = randomUUID();
		insertTextSource(sourceId);
		insertStory(sourceId);
		db.runSql(
			[
				`INSERT INTO pipeline_runs (id, tag, options, status, created_at) VALUES (${sqlLiteral(runId)}, 'spec-86-worker', '{}'::jsonb, 'running', now())`,
				`INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, updated_at) VALUES (${sqlLiteral(runId)}, ${sqlLiteral(sourceId)}, 'ingest', 'pending', now())`,
				`INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, created_at) VALUES (${sqlLiteral(jobId)}, 'extract', ${sqlLiteral(JSON.stringify({ sourceId, runId, upTo: 'graph', force: false }))}::jsonb, 'pending', 0, 3, now())`,
			].join('; '),
		);

		const result = await workerModule.processNextJob(workerContext, 'spec-86-worker');
		expect(result.state).toBe('completed');
		expect(result.job?.id).toBe(jobId);
		expect(
			db.runSql(
				`SELECT type FROM jobs WHERE payload->>'runId' = ${sqlLiteral(runId)} AND status = 'pending' ORDER BY created_at DESC LIMIT 1;`,
			),
		).toBe('enrich');
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(sourceId)} AND step_name = 'segment';`),
		).toBe('skipped');
	});
});
