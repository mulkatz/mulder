import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');
const PIPELINE_DIST = resolve(ROOT, 'packages/pipeline/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const EXTRACTED_DIR = resolve(ROOT, '.local/storage/extracted');

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 120_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_CONFIG: EXAMPLE_CONFIG,
			MULDER_LOG_LEVEL: 'silent',
			PGPASSWORD: db.TEST_PG_PASSWORD,
			...opts?.env,
		},
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function buildCli(): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: CLI_DIR,
		encoding: 'utf-8',
		timeout: 600_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_LOG_LEVEL: 'silent',
		},
	});

	if ((result.status ?? 1) !== 0) {
		throw new Error(`CLI build failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
	}
}

function cleanStorage(): void {
	if (!existsSync(EXTRACTED_DIR)) {
		return;
	}

	for (const entry of readdirSync(EXTRACTED_DIR)) {
		if (entry === '_schema.json') continue;
		rmSync(join(EXTRACTED_DIR, entry), { recursive: true, force: true });
	}
}

async function materializePageImages(sourceId: string): Promise<void> {
	const pagesDir = join(EXTRACTED_DIR, sourceId, 'pages');
	if (existsSync(pagesDir)) {
		return;
	}

	const layoutPath = join(EXTRACTED_DIR, sourceId, 'layout.json');
	const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
	mkdirSync(pagesDir, { recursive: true });
	const minimalPng = Buffer.from(
		'89504e470d0a1a0a0000000d49484452000000010000000108020000009001be' +
			'0000000c4944415478da6360f80f00000101000518d84e0000000049454e44ae426082',
		'hex',
	);
	for (let i = 1; i <= layout.pageCount; i++) {
		const padded = String(i).padStart(3, '0');
		writeFileSync(join(pagesDir, `page-${padded}.png`), minimalPng);
	}
}

function writeConfigVariant(pathname: string, threshold: string): void {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	const updated = base.replace('native_text_threshold: 0.9', `native_text_threshold: ${threshold}`);
	writeFileSync(pathname, updated, 'utf-8');
}

describe('Spec 78 — Selective Reprocessing', () => {
	let pgAvailable = false;
	let core: typeof import('@mulder/core');
	let pipeline: typeof import('@mulder/pipeline');
	let pool: import('pg').Pool;
	let config: import('@mulder/core').MulderConfig;
	let logger: import('@mulder/core').Logger;
	let services: import('@mulder/core').Services;

	beforeAll(async () => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
			return;
		}

		buildCli();
		ensureSchema();

		core = await import(pathToFileURL(CORE_DIST).href);
		pipeline = await import(pathToFileURL(PIPELINE_DIST).href);
		config = core.loadConfig(EXAMPLE_CONFIG);
		logger = core.createLogger({ level: 'silent' });
		services = core.createServiceRegistry(config, logger);
		const gcp = config.gcp;
		if (!gcp) {
			throw new Error('Example config must include GCP settings for spec 78');
		}
		pool = core.getWorkerPool(gcp.cloud_sql);
	}, 900_000);

	beforeEach(() => {
		if (!pgAvailable) return;
		truncateMulderTables();
		cleanStorage();
	});

	afterAll(async () => {
		if (!pgAvailable) return;
		try {
			truncateMulderTables();
			cleanStorage();
		} finally {
			await core.closeAllPools();
		}
	});

	async function seedProcessedSource(name: string): Promise<string> {
		const source = await core.createSource(pool, {
			filename: 'native-text-sample.pdf',
			storagePath: `raw/${name}/${randomUUID()}/native-text-sample.pdf`,
			fileHash: randomUUID().replace(/-/g, ''),
			pageCount: 12,
			hasNativeText: true,
			nativeTextRatio: 0.94,
		});

		await services.storage.upload(source.storagePath, readFileSync(NATIVE_TEXT_PDF));

		const extractResult = await pipeline.executeExtract(
			{ sourceId: source.id, force: false },
			config,
			services,
			pool,
			logger,
		);
		expect(extractResult.status).not.toBe('failed');

		await materializePageImages(source.id);

		const segmentResult = await pipeline.executeSegment(
			{ sourceId: source.id, force: false },
			config,
			services,
			pool,
			logger,
		);
		expect(segmentResult.status).not.toBe('failed');

		const storiesAfterSegment = await core.findStoriesBySourceId(pool, source.id);
		expect(storiesAfterSegment.length).toBeGreaterThan(0);

		for (const story of storiesAfterSegment) {
			const enrichResult = await pipeline.executeEnrich(
				{ storyId: story.id, force: false },
				config,
				services,
				pool,
				logger,
			);
			expect(enrichResult.status).not.toBe('failed');
		}

		const storiesAfterEnrich = await core.findStoriesBySourceId(pool, source.id);
		for (const story of storiesAfterEnrich) {
			const embedResult = await pipeline.executeEmbed(
				{ storyId: story.id, force: false },
				config,
				services,
				pool,
				logger,
			);
			expect(embedResult.status).not.toBe('failed');
		}

		const storiesAfterEmbed = await core.findStoriesBySourceId(pool, source.id);
		for (const story of storiesAfterEmbed) {
			const graphResult = await pipeline.executeGraph(
				{ storyId: story.id, force: false },
				config,
				services,
				pool,
				logger,
			);
			expect(graphResult.status).not.toBe('failed');
		}

		return source.id;
	}

	async function seedSegmentedSource(name: string): Promise<string> {
		const source = await core.createSource(pool, {
			filename: 'native-text-sample.pdf',
			storagePath: `raw/${name}/${randomUUID()}/native-text-sample.pdf`,
			fileHash: randomUUID().replace(/-/g, ''),
			pageCount: 12,
			hasNativeText: true,
			nativeTextRatio: 0.94,
		});

		await services.storage.upload(source.storagePath, readFileSync(NATIVE_TEXT_PDF));

		const extractResult = await pipeline.executeExtract(
			{ sourceId: source.id, force: false },
			config,
			services,
			pool,
			logger,
		);
		expect(extractResult.status).not.toBe('failed');

		await materializePageImages(source.id);

		const segmentResult = await pipeline.executeSegment(
			{ sourceId: source.id, force: false },
			config,
			services,
			pool,
			logger,
		);
		expect(segmentResult.status).not.toBe('failed');

		return source.id;
	}

	it('QA-01: planReprocess reports no-op when hashes match', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa01');

		const result = await pipeline.planReprocess({}, config, pool);
		expect(result.sourcesConsidered).toBe(1);
		expect(result.plannedSourceCount).toBe(0);
		expect(result.skippedSourceCount).toBe(1);
		expect(result.sources[0]?.planned).toBe(false);
		expect(result.sources[0]?.skipReason).toBe('up to date');
	});

	it('QA-02: reprocess --dry-run reports downstream extract rerun without writes', async () => {
		if (!pgAvailable) return;

		const sourceId = await seedProcessedSource('spec78-qa02');
		const beforeRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');
		const beforeHash = db.runSql(
			`SELECT config_hash FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'extract';`,
		);

		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa02-config.yaml');
		mkdirSync(resolve(tempConfig, '..'), { recursive: true });
		writeConfigVariant(tempConfig, '0.8');

		const result = runCli(['reprocess', '--dry-run'], {
			env: { MULDER_CONFIG: tempConfig },
			timeout: 120_000,
		});
		expect(result.exitCode).toBe(0);

		const parsed = JSON.parse(result.stdout.trim()) as {
			plan: {
				plannedSourceCount: number;
				plannedStepCount: number;
				sources: Array<{ steps: Array<{ stepName: string }> }>;
			};
		};
		expect(parsed.plan.plannedSourceCount).toBe(1);
		expect(parsed.plan.plannedStepCount).toBe(5);
		expect(parsed.plan.sources[0].steps.map((step) => step.stepName)).toEqual([
			'extract',
			'segment',
			'enrich',
			'embed',
			'graph',
		]);

		const afterRuns = db.runSql('SELECT COUNT(*) FROM pipeline_runs;');
		const afterHash = db.runSql(
			`SELECT config_hash FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'extract';`,
		);
		expect(afterRuns).toBe(beforeRuns);
		expect(afterHash).toBe(beforeHash);
	});

	it('QA-03: reprocess executes only affected sources and updates step hashes', async () => {
		if (!pgAvailable) return;

		const sourceId = await seedProcessedSource('spec78-qa03');
		const beforeRuns = Number.parseInt(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'), 10);
		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa03-config.yaml');
		mkdirSync(resolve(tempConfig, '..'), { recursive: true });
		writeConfigVariant(tempConfig, '0.8');
		const changedConfig = core.loadConfig(tempConfig);

		const expectedHashes = {
			extract: core.getStepConfigHash(changedConfig, 'extract'),
			segment: core.getStepConfigHash(changedConfig, 'segment'),
			enrich: core.getStepConfigHash(changedConfig, 'enrich'),
			embed: core.getStepConfigHash(changedConfig, 'embed'),
			graph: core.getStepConfigHash(changedConfig, 'graph'),
		};

		const result = runCli(['reprocess'], {
			env: { MULDER_CONFIG: tempConfig },
			timeout: 900_000,
		});
		expect(result.exitCode).toBe(0);

		const afterRuns = Number.parseInt(db.runSql('SELECT COUNT(*) FROM pipeline_runs;'), 10);
		expect(afterRuns).toBe(beforeRuns + 1);

		const runState = db.runSql(
			"SELECT current_step || '|' || status FROM pipeline_run_sources " +
				'WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1) ' +
				`AND source_id = '${sourceId}';`,
		);
		expect(runState).toBe('graph|completed');

		for (const [stepName, hash] of Object.entries(expectedHashes)) {
			const storedHash = db.runSql(
				`SELECT config_hash FROM source_steps WHERE source_id = '${sourceId}' AND step_name = '${stepName}';`,
			);
			expect(storedHash).toBe(hash);
		}
	});

	it('QA-04: reprocess --step enrich preserves embed and only plans the minimal closure', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa04');

		const result = runCli(['reprocess', '--step', 'enrich', '--dry-run'], { timeout: 120_000 });
		expect(result.exitCode).toBe(0);

		const parsed = JSON.parse(result.stdout.trim()) as {
			plan: { plannedSourceCount: number; sources: Array<{ steps: Array<{ stepName: string; force: boolean }> }> };
		};
		expect(parsed.plan.plannedSourceCount).toBe(1);
		expect(parsed.plan.sources[0].steps.map((step) => step.stepName)).toEqual(['enrich', 'graph']);
		expect(parsed.plan.sources[0].steps[0].force).toBe(true);
		expect(parsed.plan.sources[0].steps[1].force).toBe(true);
	});

	it('QA-05: reprocess --step embed and --step graph ignore segmented-only sources', async () => {
		if (!pgAvailable) return;

		await seedSegmentedSource('spec78-qa05');

		const embedPlan = await pipeline.planReprocess({ step: 'embed' }, config, pool);
		expect(embedPlan.sourcesConsidered).toBe(0);
		expect(embedPlan.plannedSourceCount).toBe(0);
		expect(embedPlan.skippedSourceCount).toBe(0);

		const graphPlan = await pipeline.planReprocess({ step: 'graph' }, config, pool);
		expect(graphPlan.sourcesConsidered).toBe(0);
		expect(graphPlan.plannedSourceCount).toBe(0);
		expect(graphPlan.skippedSourceCount).toBe(0);
	});

	it('QA-06: analysis-only config changes plan a global analyze pass without source reruns', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa06');

		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa06-config.yaml');
		mkdirSync(resolve(tempConfig, '..'), { recursive: true });
		const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
		const updated = base
			.replace(
				'analysis:\n  enabled: false                      # Enable for v2.0',
				'analysis:\n  enabled: true                       # Enable for v2.0',
			)
			.replace('cluster_window_days: 30', 'cluster_window_days: 14');
		writeFileSync(tempConfig, updated, 'utf-8');

		const analysisConfig = core.loadConfig(tempConfig);
		const plan = await pipeline.planReprocess({}, analysisConfig, pool);
		expect(plan.plannedSourceCount).toBe(0);
		expect(plan.globalAnalyzePlanned).toBe(true);
	});

	it('QA-07: failed source-step rewrites clear stale config hashes', async () => {
		if (!pgAvailable) return;

		const source = await core.createSource(pool, {
			filename: 'spec78-failure.pdf',
			storagePath: `raw/spec78-failure/${randomUUID()}.pdf`,
			fileHash: randomUUID().replace(/-/g, ''),
			pageCount: 1,
			hasNativeText: true,
			nativeTextRatio: 1,
		});

		await core.upsertSourceStep(pool, {
			sourceId: source.id,
			stepName: 'embed',
			status: 'completed',
			configHash: 'old-hash',
		});
		await core.upsertSourceStep(pool, {
			sourceId: source.id,
			stepName: 'embed',
			status: 'failed',
			errorMessage: 'boom',
		});

		const stored = await core.findSourceStep(pool, source.id, 'embed');
		expect(stored?.status).toBe('failed');
		expect(stored?.configHash).toBeNull();
	});
});
