import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Services, Source } from '@mulder/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const API_DIR = resolve(ROOT, 'apps/api');
const CLI_DIR = resolve(ROOT, 'apps/cli');

const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const WORKER_DIST = resolve(WORKER_DIR, 'dist/index.js');
const API_APP_DIST = resolve(API_DIR, 'dist/app.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_LOG_LEVEL: 'silent',
		},
	});

	expect(result.status ?? 1).toBe(0);
	if ((result.status ?? 1) !== 0) {
		throw new Error(
			`Build failed in ${packageDir}:\n${result.stdout?.toString() ?? ''}\n${result.stderr?.toString() ?? ''}`,
		);
	}
}

function runCli(args: string[], opts?: { timeout?: number }): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI_DIST, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 120_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			PGPASSWORD: db.TEST_PG_PASSWORD,
			MULDER_LOG_LEVEL: 'silent',
		},
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function cleanState(): void {
	db.runSql(
		[
			'DELETE FROM monthly_budget_reservations',
			'DELETE FROM jobs',
			'DELETE FROM pipeline_run_sources',
			'DELETE FROM pipeline_runs',
			'DELETE FROM source_steps',
			'DELETE FROM sources',
		].join('; '),
	);
}

function insertSourceRow(
	sourceId: string,
	opts?: {
		pageCount?: number;
		hasNativeText?: boolean;
		nativeTextRatio?: number;
		status?: string;
		sourceType?: Source['sourceType'];
		filename?: string;
		storagePath?: string;
		formatMetadata?: Record<string, unknown>;
	},
): void {
	const fileHash = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
	const pageCount = opts?.pageCount ?? 10;
	const hasNativeText = opts?.hasNativeText ?? false;
	const nativeTextRatio = opts?.nativeTextRatio ?? 0;
	const status = opts?.status ?? 'ingested';
	const sourceType = opts?.sourceType ?? 'pdf';
	const filename = opts?.filename ?? 'budget-test.pdf';
	const storagePath = opts?.storagePath ?? '/tmp/budget-test.pdf';
	const formatMetadata = JSON.stringify(opts?.formatMetadata ?? {});

	db.runSql(
		[
			'INSERT INTO sources (id, filename, storage_path, file_hash, page_count, has_native_text, native_text_ratio, status, reliability_score, tags, metadata, source_type, format_metadata)',
			`VALUES ('${sourceId}', '${filename}', '${storagePath}', '${fileHash}', ${pageCount}, ${hasNativeText}, ${nativeTextRatio}, '${status}', NULL, ARRAY[]::text[], '{}'::jsonb, '${sourceType}', '${formatMetadata}'::jsonb)`,
			'ON CONFLICT (id) DO UPDATE SET updated_at = now();',
		].join(' '),
	);
}

function insertJob(input: {
	id: string;
	type: string;
	status: 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';
	payload?: Record<string, unknown>;
	createdAt?: string;
}): void {
	db.runSql(
		[
			'INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, created_at)',
			`VALUES ('${input.id}', '${input.type}', '${JSON.stringify(input.payload ?? {})}'::jsonb, '${input.status}', 0, 3, TIMESTAMPTZ '${input.createdAt ?? '2026-04-15T12:00:00.000Z'}')`,
			'ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload;',
		].join(' '),
	);
}

function insertRun(runId: string, status = 'running'): void {
	db.runSql(
		[
			'INSERT INTO pipeline_runs (id, tag, options, status, created_at, finished_at)',
			`VALUES ('${runId}', 'budget-test', '{}'::jsonb, '${status}', TIMESTAMPTZ '2026-04-15T12:00:00.000Z', NULL)`,
			'ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;',
		].join(' '),
	);
}

function insertReservation(input: {
	id?: string;
	budgetMonth: string;
	sourceId: string;
	runId: string;
	jobId: string;
	status: 'reserved' | 'committed' | 'released' | 'reconciled';
	plannedSteps?: string[];
	reservedUsd: number;
	committedUsd?: number;
	releasedUsd?: number;
	retryOfReservationId?: string | null;
}): string {
	const id = input.id ?? randomUUID();
	const plannedSteps = input.plannedSteps ?? ['extract', 'segment', 'enrich', 'embed', 'graph'];
	db.runSql(
		[
			'INSERT INTO monthly_budget_reservations (id, budget_month, source_id, run_id, job_id, retry_of_reservation_id, status, planned_steps, reserved_estimated_usd, committed_usd, released_usd, metadata, created_at, finalized_at)',
			`VALUES ('${id}', DATE '${input.budgetMonth}', '${input.sourceId}', '${input.runId}', '${input.jobId}', ${input.retryOfReservationId ? `'${input.retryOfReservationId}'` : 'NULL'}, '${input.status}', '${JSON.stringify(plannedSteps)}'::jsonb, ${input.reservedUsd}, ${input.committedUsd ?? 0}, ${input.releasedUsd ?? 0}, '{}'::jsonb, now(), ${input.status === 'reserved' ? 'NULL' : 'now()'})`,
		].join(' '),
	);
	return id;
}

function insertFailedPipelineStep(sourceId: string, step: string): string {
	const runId = randomUUID();
	db.runSql(
		[
			`INSERT INTO pipeline_runs (id, tag, options, status, created_at, finished_at) VALUES ('${runId}', 'retry-seed', '{}'::jsonb, 'failed', now(), now())`,
			`INSERT INTO pipeline_run_sources (run_id, source_id, current_step, status, error_message, updated_at) VALUES ('${runId}', '${sourceId}', '${step}', 'failed', 'seeded failure', now())`,
		].join('; '),
	);
	return runId;
}

function readJsonCell(sql: string): Record<string, unknown> {
	return JSON.parse(db.runSql(sql)) as Record<string, unknown>;
}

async function loadApiApp(): Promise<{ request: (input: string | Request, init?: RequestInit) => Promise<Response> }> {
	const module = await import(pathToFileURL(API_APP_DIST).href);
	if (typeof module.createApp !== 'function') {
		throw new Error('API app module did not export createApp');
	}

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
			budget: {
				enabled: true,
				monthly_limit_usd: 50,
				extract_per_page_usd: 0.006,
				segment_per_page_usd: 0.002,
				enrich_per_source_usd: 0.015,
				embed_per_source_usd: 0.004,
				graph_per_source_usd: 0.001,
			},
		},
	});
}

type ApiApp = Awaited<ReturnType<typeof loadApiApp>>;

function authorizedHeaders(): Record<string, string> {
	return {
		Authorization: 'Bearer test-api-key',
		'Content-Type': 'application/json',
		'X-Forwarded-For': '203.0.113.10',
	};
}

async function apiPost(app: ApiApp, path: string, body: unknown): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'POST',
		headers: authorizedHeaders(),
		body: JSON.stringify(body),
	});
}

async function apiGet(app: ApiApp, path: string): Promise<Response> {
	return await app.request(`http://localhost${path}`, {
		method: 'GET',
		headers: {
			Authorization: 'Bearer test-api-key',
			'X-Forwarded-For': '203.0.113.10',
		},
	});
}

describe('Spec 77 — Budget reservation status gate', () => {
	let app: ApiApp;
	let coreModule: typeof import('@mulder/core');
	let workerModule: typeof import('@mulder/worker');
	let currentBudgetMonth: string;

	beforeAll(async () => {
		db.requirePg();
		process.env.MULDER_CONFIG = EXAMPLE_CONFIG;
		process.env.MULDER_LOG_LEVEL = 'silent';

		buildPackage(CORE_DIR);
		buildPackage(PIPELINE_DIR);
		buildPackage(WORKER_DIR);
		buildPackage(API_DIR);
		buildPackage(CLI_DIR);

		const migrate = runCli(['db', 'migrate', EXAMPLE_CONFIG], { timeout: 300_000 });
		expect(migrate.exitCode).toBe(0);

		coreModule = await import(pathToFileURL(CORE_DIST).href);
		workerModule = await import(pathToFileURL(WORKER_DIST).href);
		app = await loadApiApp();
		currentBudgetMonth = coreModule.budgetMonthStart(new Date());
	}, 600000);

	beforeEach(() => {
		cleanState();
	});

	afterAll(() => {
		try {
			cleanState();
		} catch {
			// Ignore cleanup failures.
		}
	});

	it('QA-01: accepted run reserves budget and returns 202', async () => {
		const sourceId = randomUUID();
		insertSourceRow(sourceId, { pageCount: 10, hasNativeText: false, status: 'ingested' });

		const response = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'extract',
			up_to: 'graph',
			tag: 'budget-accept',
		});

		expect(response.status).toBe(202);
		const body = (await response.json()) as {
			data: { run_id: string; job_id: string };
		};
		const reservation = readJsonCell(
			`SELECT row_to_json(r)::text FROM (
				SELECT status, reserved_estimated_usd, planned_steps, metadata
				FROM monthly_budget_reservations
				WHERE run_id = '${body.data.run_id}'
			) r`,
		);

		expect(reservation.status).toBe('reserved');
		expect(Number(reservation.reserved_estimated_usd)).toBeCloseTo(0.1, 5);
		expect(reservation.planned_steps).toEqual(['extract', 'segment', 'enrich', 'embed', 'graph']);
		expect((reservation.metadata as { kind: string }).kind).toBe('run');
	});

	it('QA-02: gate rejects over-budget acceptance deterministically', async () => {
		const sourceId = randomUUID();
		const occupiedSourceId = randomUUID();
		const occupiedRunId = randomUUID();
		const occupiedJobId = randomUUID();

		insertSourceRow(sourceId, { pageCount: 10, hasNativeText: false, status: 'ingested' });
		insertSourceRow(occupiedSourceId, { pageCount: 1, hasNativeText: false, status: 'ingested' });
		insertRun(occupiedRunId, 'running');
		insertJob({
			id: occupiedJobId,
			type: 'pipeline_run',
			status: 'pending',
			payload: { sourceId: occupiedSourceId, runId: occupiedRunId },
		});
		insertReservation({
			budgetMonth: currentBudgetMonth,
			sourceId: occupiedSourceId,
			runId: occupiedRunId,
			jobId: occupiedJobId,
			status: 'reserved',
			reservedUsd: 49.95,
			plannedSteps: ['extract'],
		});

		const beforeRuns = Number(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'));
		const response = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'extract',
			up_to: 'graph',
		});

		expect(response.status).toBe(429);
		const body = (await response.json()) as {
			error: { code: string; details: Record<string, unknown> };
		};
		expect(body.error.code).toBe('PIPELINE_BUDGET_EXCEEDED');
		expect(Number(body.error.details.remaining_usd)).toBeCloseTo(0.05, 5);
		expect(Number(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'))).toBe(beforeRuns);
		expect(Number(db.runSql('SELECT COUNT(*) FROM monthly_budget_reservations;'))).toBe(1);
	});

	it('QA-03: failed run reconciles consumed vs released spend', async () => {
		const sourceId = randomUUID();
		insertSourceRow(sourceId, { pageCount: 10, hasNativeText: false, status: 'ingested' });

		const accepted = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'extract',
			up_to: 'graph',
			tag: 'budget-fail',
		});
		expect(accepted.status).toBe(202);
		const acceptedBody = (await accepted.json()) as {
			data: { run_id: string; job_id: string };
		};
		db.runSql(`UPDATE jobs SET max_attempts = 1 WHERE id = '${acceptedBody.data.job_id}';`);

		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		const cloudSqlConfig = config.gcp?.cloud_sql;
		if (!cloudSqlConfig) {
			throw new Error('Expected example config to include gcp.cloud_sql');
		}
		const pool = coreModule.getWorkerPool(cloudSqlConfig);

		await workerModule.processNextJob(
			{
				config,
				services: {} as Services,
				pool,
				logger: coreModule.createLogger(),
				dispatch: async (job) => {
					if (job.type !== 'extract') {
						throw new Error('Expected extract step job');
					}
					throw new Error('simulated failure');
				},
			},
			'test-worker-budget',
		);

		const reservation = readJsonCell(
			`SELECT row_to_json(r)::text FROM (
				SELECT status, committed_usd, released_usd
				FROM monthly_budget_reservations
				WHERE run_id = '${acceptedBody.data.run_id}'
			) r`,
		);

		expect(reservation.status).toBe('reconciled');
		expect(Number(reservation.committed_usd)).toBeCloseTo(0.06, 5);
		expect(Number(reservation.released_usd)).toBeCloseTo(0.04, 5);
	});

	it('QA-04: partial run helper returns a reconciled split', () => {
		const source: Source = {
			id: randomUUID(),
			filename: 'partial.pdf',
			storagePath: '/tmp/partial.pdf',
			fileHash: 'hash',
			sourceType: 'pdf',
			formatMetadata: {},
			pageCount: 10,
			hasNativeText: false,
			nativeTextRatio: 0,
			status: 'ingested',
			reliabilityScore: null,
			tags: [],
			metadata: {},
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const finalization = coreModule.finalizeBudgetReservation({
			source,
			plannedSteps: ['extract', 'segment', 'enrich', 'embed', 'graph'],
			completedSteps: ['extract', 'segment'],
			budget: {
				enabled: true,
				monthly_limit_usd: 50,
				extract_per_page_usd: 0.006,
				segment_per_page_usd: 0.002,
				enrich_per_source_usd: 0.015,
				embed_per_source_usd: 0.004,
				graph_per_source_usd: 0.001,
			},
			extraction: {
				native_text_threshold: 0.9,
				confidence_threshold: 0.85,
				max_vision_pages: 20,
				segmentation: { model: 'gemini-2.5-flash' },
			},
		});

		expect(finalization.status).toBe('reconciled');
		expect(finalization.committedUsd).toBeCloseTo(0.08, 5);
		expect(finalization.releasedUsd).toBeCloseTo(0.02, 5);
	});

	it('QA-05: retry creates a new reservation only for the retried step', async () => {
		const sourceId = randomUUID();
		const priorJobId = randomUUID();
		insertSourceRow(sourceId, { pageCount: 10, hasNativeText: false, status: 'embedded' });
		const priorRunId = insertFailedPipelineStep(sourceId, 'graph');
		insertJob({ id: priorJobId, type: 'pipeline_run', status: 'failed', payload: { sourceId, runId: priorRunId } });
		const priorReservationId = insertReservation({
			budgetMonth: currentBudgetMonth,
			sourceId,
			runId: priorRunId,
			jobId: priorJobId,
			status: 'reconciled',
			reservedUsd: 0.1,
			committedUsd: 0.099,
			releasedUsd: 0.001,
		});

		const response = await apiPost(app, '/api/pipeline/retry', {
			source_id: sourceId,
		});

		expect(response.status).toBe(202);
		const body = (await response.json()) as {
			data: { run_id: string };
		};
		const reservation = readJsonCell(
			`SELECT row_to_json(r)::text FROM (
				SELECT retry_of_reservation_id, reserved_estimated_usd, planned_steps, metadata
				FROM monthly_budget_reservations
				WHERE run_id = '${body.data.run_id}'
			) r`,
		);

		expect(reservation.retry_of_reservation_id).toBe(priorReservationId);
		expect(Number(reservation.reserved_estimated_usd)).toBeCloseTo(0.001, 5);
		expect(reservation.planned_steps).toEqual(['graph']);
		expect((reservation.metadata as { kind: string }).kind).toBe('retry');
	});

	it('QA-06: GET /api/status reports reserved, committed, released, and remaining from persisted rows', async () => {
		const sourceA = randomUUID();
		const sourceB = randomUUID();
		const sourceC = randomUUID();
		const sourceD = randomUUID();
		const runA = randomUUID();
		const runB = randomUUID();
		const runC = randomUUID();
		const runD = randomUUID();
		const jobA = randomUUID();
		const jobB = randomUUID();
		const jobC = randomUUID();
		const jobD = randomUUID();

		insertSourceRow(sourceA);
		insertSourceRow(sourceB);
		insertSourceRow(sourceC);
		insertSourceRow(sourceD);
		insertRun(runA);
		insertRun(runB, 'completed');
		insertRun(runC, 'failed');
		insertRun(runD, 'partial');
		insertJob({ id: jobA, type: 'pipeline_run', status: 'pending' });
		insertJob({ id: jobB, type: 'pipeline_run', status: 'running' });
		insertJob({ id: jobC, type: 'pipeline_run', status: 'completed' });
		insertJob({ id: jobD, type: 'manual_review', status: 'failed' });
		insertJob({ id: randomUUID(), type: 'manual_review', status: 'dead_letter' });
		insertReservation({
			budgetMonth: currentBudgetMonth,
			sourceId: sourceA,
			runId: runA,
			jobId: jobA,
			status: 'reserved',
			reservedUsd: 5,
		});
		insertReservation({
			budgetMonth: currentBudgetMonth,
			sourceId: sourceB,
			runId: runB,
			jobId: jobB,
			status: 'committed',
			reservedUsd: 7,
			committedUsd: 7,
			releasedUsd: 0,
		});
		insertReservation({
			budgetMonth: currentBudgetMonth,
			sourceId: sourceC,
			runId: runC,
			jobId: jobC,
			status: 'released',
			reservedUsd: 3,
			committedUsd: 0,
			releasedUsd: 3,
		});
		insertReservation({
			budgetMonth: currentBudgetMonth,
			sourceId: sourceD,
			runId: runD,
			jobId: jobD,
			status: 'reconciled',
			reservedUsd: 4,
			committedUsd: 2.5,
			releasedUsd: 1.5,
		});

		const response = await apiGet(app, '/api/status');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: {
				budget: {
					month: currentBudgetMonth,
					limit_usd: 50,
					reserved_usd: 5,
					committed_usd: 9.5,
					released_usd: 4.5,
					remaining_usd: 35.5,
				},
				jobs: {
					pending: 1,
					running: 1,
					completed: 1,
					failed: 1,
					dead_letter: 1,
				},
			},
		});
	});

	it('QA-07: DOCX budget estimates omit extract and segment layout charges but keep downstream work', () => {
		const source: Source = {
			id: randomUUID(),
			filename: 'budget-test.docx',
			storagePath: 'raw/budget-test/original.docx',
			fileHash: 'hash',
			sourceType: 'docx',
			formatMetadata: {
				media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				office_format: 'docx',
				extraction_engine: 'mammoth',
			},
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
			status: 'ingested',
			reliabilityScore: null,
			tags: [],
			metadata: {},
			createdAt: new Date(),
			updatedAt: new Date(),
		};

		const estimate = coreModule.estimateBudgetForSourceRun({
			source,
			plannedSteps: ['extract', 'segment', 'enrich', 'embed', 'graph'],
			budget: {
				enabled: true,
				monthly_limit_usd: 50,
				extract_per_page_usd: 0.006,
				segment_per_page_usd: 0.002,
				enrich_per_source_usd: 0.015,
				embed_per_source_usd: 0.004,
				graph_per_source_usd: 0.001,
			},
			extraction: {
				native_text_threshold: 0.9,
				confidence_threshold: 0.85,
				max_vision_pages: 20,
				segmentation: { model: 'gemini-2.5-flash' },
			},
		});

		expect(estimate.byStep).toEqual({
			extract: 0,
			segment: 0,
			enrich: 0.015,
			embed: 0.004,
			graph: 0.001,
		});
		expect(estimate.totalUsd).toBeCloseTo(0.02, 5);
	});

	it('QA-08: DOCX API run is accepted when remaining budget covers only downstream work', async () => {
		const sourceId = randomUUID();
		const occupiedSourceId = randomUUID();
		const occupiedRunId = randomUUID();
		const occupiedJobId = randomUUID();

		insertSourceRow(sourceId, {
			pageCount: 0,
			hasNativeText: false,
			nativeTextRatio: 0,
			sourceType: 'docx',
			filename: 'budget-test.docx',
			storagePath: `raw/${sourceId}/original.docx`,
			formatMetadata: {
				media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				original_extension: 'docx',
				byte_size: 1024,
				office_format: 'docx',
				container: 'office_open_xml',
				extraction_engine: 'mammoth',
			},
		});
		insertSourceRow(occupiedSourceId, { pageCount: 1, hasNativeText: false, status: 'ingested' });
		insertRun(occupiedRunId, 'running');
		insertJob({
			id: occupiedJobId,
			type: 'pipeline_run',
			status: 'pending',
			payload: { sourceId: occupiedSourceId, runId: occupiedRunId },
		});
		insertReservation({
			budgetMonth: currentBudgetMonth,
			sourceId: occupiedSourceId,
			runId: occupiedRunId,
			jobId: occupiedJobId,
			status: 'reserved',
			reservedUsd: 49.98,
			plannedSteps: ['extract'],
		});

		const response = await apiPost(app, '/api/pipeline/run', {
			source_id: sourceId,
			from: 'extract',
			up_to: 'graph',
			tag: 'docx-budget-accept',
		});

		expect(response.status).toBe(202);
		const body = (await response.json()) as {
			data: { run_id: string; job_id: string };
		};
		const reservation = readJsonCell(
			`SELECT row_to_json(r)::text FROM (
				SELECT status, reserved_estimated_usd, planned_steps, metadata
				FROM monthly_budget_reservations
				WHERE run_id = '${body.data.run_id}'
			) r`,
		);

		expect(reservation.status).toBe('reserved');
		expect(Number(reservation.reserved_estimated_usd)).toBeCloseTo(0.02, 5);
		expect(reservation.planned_steps).toEqual(['extract', 'enrich', 'embed', 'graph']);
		expect((reservation.metadata as { breakdown: Record<string, number> }).breakdown).toEqual({
			extract: 0,
			segment: 0,
			enrich: 0.015,
			embed: 0.004,
			graph: 0.001,
		});
		expect(
			db.runSql(`SELECT status FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'segment';`),
		).toBe('skipped');
	});
});
