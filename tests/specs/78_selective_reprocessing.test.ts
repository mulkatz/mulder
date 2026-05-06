import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';
import { testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');
const PIPELINE_DIST = resolve(ROOT, 'packages/pipeline/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const EXTRACTED_DIR = testStoragePath('extracted');

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

function writeConfigWithReplacements(pathname: string, replacer: (input: string) => string): void {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	writeFileSync(pathname, replacer(base), 'utf-8');
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

		const qualityResult = await pipeline.executeQuality(
			{ sourceId: source.id, force: false },
			config,
			services,
			pool,
			logger,
		);
		expect(qualityResult.status).not.toBe('failed');

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

		const qualityResult = await pipeline.executeQuality(
			{ sourceId: source.id, force: false },
			config,
			services,
			pool,
			logger,
		);
		expect(qualityResult.status).not.toBe('failed');

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

	it('QA-05: embedding changes are detected from source_steps even when source status is segmented', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa05');

		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa05-config.yaml');
		mkdirSync(resolve(tempConfig, '..'), { recursive: true });
		writeConfigWithReplacements(tempConfig, (base) => base.replace('chunk_size_tokens: 512', 'chunk_size_tokens: 384'));

		const changedConfig = core.loadConfig(tempConfig);
		const plan = await pipeline.planReprocess({}, changedConfig, pool);
		expect(plan.plannedSourceCount).toBe(1);
		expect(plan.sources[0]?.steps.map((step) => step.stepName)).toEqual(['embed', 'graph']);
		expect(plan.sources[0]?.steps.map((step) => step.force)).toEqual([true, true]);
	});

	it('QA-06: taxonomy changes plan enrich and graph while preserving embed', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa06');

		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa06-config.yaml');
		mkdirSync(resolve(tempConfig, '..'), { recursive: true });
		writeConfigWithReplacements(tempConfig, (base) => `${base}\ntaxonomy:\n  normalization_threshold: 0.55\n`);

		const changedConfig = core.loadConfig(tempConfig);
		const plan = await pipeline.planReprocess({}, changedConfig, pool);
		expect(plan.plannedSourceCount).toBe(1);
		expect(plan.sources[0]?.steps.map((step) => step.stepName)).toEqual(['enrich', 'graph']);
		expect(plan.sources[0]?.steps.map((step) => step.force)).toEqual([true, true]);
	});

	it('QA-07: project locale changes do not trigger reprocessing', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa07');

		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa07-config.yaml');
		mkdirSync(resolve(tempConfig, '..'), { recursive: true });
		writeConfigWithReplacements(tempConfig, (base) =>
			base.replace('supported_locales: ["en"]', 'supported_locales: ["en", "de"]'),
		);

		const changedConfig = core.loadConfig(tempConfig);
		const plan = await pipeline.planReprocess({}, changedConfig, pool);
		expect(plan.plannedSourceCount).toBe(0);
		expect(plan.skippedSourceCount).toBe(1);
	});

	it('QA-08: simultaneous taxonomy and embed changes plan the union of impacted steps', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa08');

		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa08-config.yaml');
		mkdirSync(resolve(tempConfig, '..'), { recursive: true });
		writeConfigWithReplacements(
			tempConfig,
			(base) =>
				`${base.replace('chunk_size_tokens: 512', 'chunk_size_tokens: 384')}\ntaxonomy:\n  normalization_threshold: 0.55\n`,
		);

		const changedConfig = core.loadConfig(tempConfig);
		const plan = await pipeline.planReprocess({}, changedConfig, pool);
		expect(plan.plannedSourceCount).toBe(1);
		expect(plan.sources[0]?.steps.map((step) => step.stepName)).toEqual(['enrich', 'embed', 'graph']);
		expect(plan.sources[0]?.steps.map((step) => step.force)).toEqual([true, true, true]);
	});

	it('QA-08b: document quality config changes plan quality and downstream extract rerun', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa08b');

		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa08b-config.yaml');
		mkdirSync(resolve(tempConfig, '..'), { recursive: true });
		writeConfigWithReplacements(tempConfig, (base) =>
			base.replace('native_text_ratio_threshold: 0.5', 'native_text_ratio_threshold: 0.6'),
		);

		const changedConfig = core.loadConfig(tempConfig);
		const plan = await pipeline.planReprocess({}, changedConfig, pool);
		expect(plan.plannedSourceCount).toBe(1);
		expect(plan.sources[0]?.steps.map((step) => step.stepName)).toEqual([
			'quality',
			'extract',
			'segment',
			'enrich',
			'embed',
			'graph',
		]);
		expect(plan.sources[0]?.steps.map((step) => step.force)).toEqual([true, true, false, false, false, false]);
	});

	it('QA-09: graph-derived cleanup removes cross-source story references only', async () => {
		if (!pgAvailable) return;

		const sourceA = await core.createSource(pool, {
			filename: 'spec78-cross-source-a.pdf',
			storagePath: `raw/spec78-cross-source-a/${randomUUID()}.pdf`,
			fileHash: randomUUID().replace(/-/g, ''),
			pageCount: 1,
			hasNativeText: true,
			nativeTextRatio: 1,
		});
		const sourceB = await core.createSource(pool, {
			filename: 'spec78-cross-source-b.pdf',
			storagePath: `raw/spec78-cross-source-b/${randomUUID()}.pdf`,
			fileHash: randomUUID().replace(/-/g, ''),
			pageCount: 1,
			hasNativeText: true,
			nativeTextRatio: 1,
		});
		const storyA = await core.createStory(pool, {
			sourceId: sourceA.id,
			title: 'Spec 78 story A',
			gcsMarkdownUri: `segments/${sourceA.id}/a.md`,
			gcsMetadataUri: `segments/${sourceA.id}/a.meta.json`,
		});
		const storyB = await core.createStory(pool, {
			sourceId: sourceB.id,
			title: 'Spec 78 story B',
			gcsMarkdownUri: `segments/${sourceB.id}/b.md`,
			gcsMetadataUri: `segments/${sourceB.id}/b.meta.json`,
		});
		const sourceEntity = await core.createEntity(pool, {
			name: `Spec 78 Source Entity ${randomUUID()}`,
			type: 'person',
		});
		const targetEntity = await core.createEntity(pool, {
			name: `Spec 78 Target Entity ${randomUUID()}`,
			type: 'event',
		});

		await core.createEdge(pool, {
			sourceEntityId: sourceEntity.id,
			targetEntityId: targetEntity.id,
			relationship: 'duplicate_near',
			storyId: storyB.id,
			edgeType: 'DUPLICATE_OF',
			attributes: { storyIdA: storyA.id, storyIdB: storyB.id },
		});
		await core.createEdge(pool, {
			sourceEntityId: targetEntity.id,
			targetEntityId: sourceEntity.id,
			relationship: 'co_occurs_with',
			storyId: storyB.id,
			edgeType: 'RELATIONSHIP',
			attributes: { generatedBy: 'graph.cooccurrence_fallback', storyIdA: storyA.id, storyIdB: storyB.id },
		});
		await core.createEdge(pool, {
			sourceEntityId: sourceEntity.id,
			targetEntityId: targetEntity.id,
			relationship: 'co_occurs_with',
			storyId: storyB.id,
			edgeType: 'RELATIONSHIP',
			attributes: { storyIdA: storyA.id, storyIdB: storyB.id },
		});
		await core.createEdge(pool, {
			sourceEntityId: sourceEntity.id,
			targetEntityId: targetEntity.id,
			relationship: 'kept_relationship',
			storyId: storyB.id,
			edgeType: 'RELATIONSHIP',
			attributes: { storyIdA: storyA.id, storyIdB: storyB.id },
		});

		const deleted = await core.deleteGraphDerivedEdgesBySourceId(pool, sourceA.id);
		expect(deleted).toBe(2);

		const duplicateCount = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM entity_edges WHERE story_id = '${storyB.id}' AND edge_type = 'DUPLICATE_OF';`),
			10,
		);
		expect(duplicateCount).toBe(0);

		const markedFallbackCount = Number.parseInt(
			db.runSql(
				`SELECT COUNT(*) FROM entity_edges WHERE story_id = '${storyB.id}' AND relationship = 'co_occurs_with' AND attributes->>'generatedBy' = 'graph.cooccurrence_fallback';`,
			),
			10,
		);
		expect(markedFallbackCount).toBe(0);

		const domainCooccurrenceCount = Number.parseInt(
			db.runSql(
				`SELECT COUNT(*) FROM entity_edges WHERE story_id = '${storyB.id}' AND relationship = 'co_occurs_with' AND attributes->>'generatedBy' IS NULL;`,
			),
			10,
		);
		expect(domainCooccurrenceCount).toBe(1);

		const relationshipCount = Number.parseInt(
			db.runSql(`SELECT COUNT(*) FROM entity_edges WHERE story_id = '${storyB.id}' AND edge_type = 'RELATIONSHIP';`),
			10,
		);
		expect(relationshipCount).toBe(2);
	});

	it('QA-10: live enrich reprocess preserves embed step state', async () => {
		if (!pgAvailable) return;

		const sourceId = await seedProcessedSource('spec78-qa10');
		const embedHashBefore = db.runSql(
			`SELECT config_hash FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'embed';`,
		);

		const result = runCli(['reprocess', '--step', 'enrich'], { timeout: 900_000 });
		expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

		const embedHashAfter = db.runSql(
			`SELECT config_hash FROM source_steps WHERE source_id = '${sourceId}' AND step_name = 'embed';`,
		);
		expect(embedHashAfter).toBe(embedHashBefore);

		const sourceStatus = db.runSql(`SELECT status FROM sources WHERE id = '${sourceId}';`);
		expect(sourceStatus).toBe('graphed');

		const followupPlan = await pipeline.planReprocess({}, config, pool);
		expect(followupPlan.plannedSourceCount).toBe(0);
	});

	it('QA-11: reprocess --step embed and --step graph ignore segmented-only sources', async () => {
		if (!pgAvailable) return;

		await seedSegmentedSource('spec78-qa11');

		const embedPlan = await pipeline.planReprocess({ step: 'embed' }, config, pool);
		expect(embedPlan.sourcesConsidered).toBe(1);
		expect(embedPlan.plannedSourceCount).toBe(0);
		expect(embedPlan.skippedSourceCount).toBe(1);
		expect(embedPlan.sources[0]?.skipReason).toBe('has not reached embed');

		const graphPlan = await pipeline.planReprocess({ step: 'graph' }, config, pool);
		expect(graphPlan.sourcesConsidered).toBe(1);
		expect(graphPlan.plannedSourceCount).toBe(0);
		expect(graphPlan.skippedSourceCount).toBe(1);
		expect(graphPlan.sources[0]?.skipReason).toBe('has not reached graph');
	});

	it('QA-12: analysis-only config changes plan a global analyze pass without source reruns', async () => {
		if (!pgAvailable) return;

		await seedProcessedSource('spec78-qa12');

		const tempConfig = resolve(ROOT, '.local', 'tmp-tests', 'spec78-qa12-config.yaml');
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

	it('QA-13: failed source-step rewrites clear stale config hashes', async () => {
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
