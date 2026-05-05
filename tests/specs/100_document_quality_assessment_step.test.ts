import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const PIPELINE_DIST = resolve(PIPELINE_DIR, 'dist/index.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

const pgAvailable = db.isPgAvailable();
let pool: pg.Pool;
let coreModule: typeof import('@mulder/core');
let pipelineModule: typeof import('@mulder/pipeline');
let config: import('@mulder/core').MulderConfig;

function buildPackage(packageDir: string): void {
	const result = spawnSync('pnpm', ['build'], {
		cwd: packageDir,
		encoding: 'utf-8',
		timeout: 120_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, MULDER_LOG_LEVEL: 'silent' },
	});
	if ((result.status ?? 1) !== 0) {
		throw new Error(`Build failed in ${packageDir}:\n${result.stdout}\n${result.stderr}`);
	}
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
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

function testLogger() {
	return coreModule.createLogger({ level: 'silent' });
}

function fakeServices(
	downloads: Record<string, string | Buffer> = {},
	overrides: Record<string, unknown> = {},
): import('@mulder/core').Services {
	const uploaded = new Map<string, { content: string | Buffer; contentType?: string }>();
	const baseServices = {
		storage: {
			upload: async (path: string, content: string | Buffer, contentType?: string) => {
				uploaded.set(path, { content, contentType });
				return `gs://test/${path}`;
			},
			download: async (path: string) => {
				if (!Object.hasOwn(downloads, path)) {
					throw new Error(`unexpected storage download: ${path}`);
				}
				const value = downloads[path];
				return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf-8');
			},
			delete: async () => undefined,
			exists: async (path: string) => Object.hasOwn(downloads, path) || uploaded.has(path),
			getUri: (path: string) => `gs://test/${path}`,
			list: async () => ({ paths: [] }),
		},
		firestore: {
			setDocument: async () => undefined,
			getDocument: async () => null,
			updateDocument: async () => undefined,
			deleteDocument: async () => undefined,
			queryCollection: async () => [],
		},
		documentAi: {
			processDocument: async () => {
				throw new Error('documentAi should not be called by Spec 100 defaults');
			},
		},
		llm: {
			generateText: async () => {
				throw new Error('llm should not be called by Spec 100 defaults');
			},
			generateStructured: async () => {
				throw new Error('llm should not be called by Spec 100 defaults');
			},
			generateGrounded: async () => {
				throw new Error('llm should not be called by Spec 100 defaults');
			},
		},
		embeddings: {
			embed: async () => {
				throw new Error('embeddings should not be called by Spec 100 defaults');
			},
			embedBatch: async () => {
				throw new Error('embeddings should not be called by Spec 100 defaults');
			},
		},
		officeDocuments: {
			extractDocx: async () => {
				throw new Error('office extraction should not be called by Spec 100 defaults');
			},
		},
		spreadsheets: {
			extractSpreadsheet: async () => {
				throw new Error('spreadsheet extraction should not be called by Spec 100 defaults');
			},
		},
		emailExtractors: {
			extractEmail: async () => {
				throw new Error('email extraction should not be called by Spec 100 defaults');
			},
		},
		urlFetchers: {
			fetchUrl: async () => {
				throw new Error('url fetch should not be called by Spec 100 defaults');
			},
		},
		urlRenderers: {
			renderUrl: async () => {
				throw new Error('url render should not be called by Spec 100 defaults');
			},
		},
		urlExtractors: {
			extractUrl: async () => {
				throw new Error('url extraction should not be called by Spec 100 defaults');
			},
		},
	};
	return { ...baseServices, ...overrides } as unknown as import('@mulder/core').Services;
}

async function createTestSource(input?: {
	sourceType?: import('@mulder/core').SourceType;
	filename?: string;
	storagePath?: string;
	metadata?: Record<string, unknown>;
	formatMetadata?: Record<string, unknown>;
	nativeTextRatio?: number;
	hasNativeText?: boolean;
	pageCount?: number;
}) {
	return await coreModule.createSource(pool, {
		filename: input?.filename ?? `spec100-${randomUUID()}.txt`,
		storagePath: input?.storagePath ?? `raw/spec100-${randomUUID()}.txt`,
		fileHash: `spec100-${randomUUID()}`,
		sourceType: input?.sourceType ?? 'text',
		formatMetadata: input?.formatMetadata ?? { media_type: 'text/plain' },
		metadata: input?.metadata ?? {},
		nativeTextRatio: input?.nativeTextRatio ?? 1,
		hasNativeText: input?.hasNativeText ?? true,
		pageCount: input?.pageCount ?? 1,
	});
}

function qualityDimensions(input?: {
	score?: number;
	method?: 'ocr_confidence' | 'llm_visual' | 'n/a';
	pagesTotal?: number;
	pagesReadable?: number;
}) {
	return coreModule.normalizeDocumentQualityDimensions({
		text_readability: {
			score: input?.score ?? 0.8,
			method: input?.method ?? 'ocr_confidence',
			details: 'spec100',
		},
		image_quality: { score: 0.9, issues: [] },
		language_detection: { primary_language: 'en', confidence: 0.95, mixed_languages: false },
		document_structure: {
			type: 'printed_text',
			has_annotations: false,
			has_marginalia: false,
			multi_column: false,
		},
		content_completeness: {
			pages_total: input?.pagesTotal ?? 1,
			pages_readable: input?.pagesReadable ?? 1,
			missing_pages_suspected: false,
			truncated: false,
		},
	});
}

beforeAll(async () => {
	if (!pgAvailable) return;

	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(WORKER_DIR);
	buildPackage(CLI_DIR);
	ensureSchema();

	pool = new pg.Pool(PG_CONFIG);
	coreModule = await import(CORE_DIST);
	pipelineModule = await import(PIPELINE_DIST);
	config = coreModule.loadConfig(EXAMPLE_CONFIG) as import('@mulder/core').MulderConfig;
});

beforeEach(() => {
	if (!pgAvailable) return;
	truncateMulderTables();
});

afterAll(async () => {
	await pool?.end();
});

describe('Spec 100: document quality assessment step', () => {
	it.skipIf(!pgAvailable)('QA-01: migration creates constrained assessment table', () => {
		const table = db.runSql(
			"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'document_quality_assessments';",
		);
		expect(table).toBe('document_quality_assessments');

		const constraints = db.runSql(
			[
				'SELECT conname',
				'FROM pg_constraint',
				"WHERE conrelid = 'document_quality_assessments'::regclass",
				"  AND contype = 'c'",
				'ORDER BY conname;',
			].join('\n'),
		);
		expect(constraints).toContain('document_quality_assessments_method_check');
		expect(constraints).toContain('document_quality_assessments_quality_check');
		expect(constraints).toContain('document_quality_assessments_path_check');
		expect(constraints).toContain('document_quality_assessments_dimensions_object_check');
		expect(constraints).toContain('document_quality_assessments_signals_object_check');

		const indexes = db.runSql(
			"SELECT indexname FROM pg_indexes WHERE tablename = 'document_quality_assessments' ORDER BY indexname;",
		);
		expect(indexes).toContain('idx_document_quality_assessments_source_assessed_at');
		expect(indexes).toContain('idx_document_quality_assessments_overall_quality');
		expect(indexes).toContain('idx_document_quality_assessments_recommended_path');
		expect(indexes).toContain('idx_document_quality_assessments_processable');
	});

	it.skipIf(!pgAvailable)(
		'QA-02/03: repository round-trips full assessment payloads and latest lookup is version-aware',
		async () => {
			const source = await createTestSource();
			const dimensions = coreModule.normalizeDocumentQualityDimensions({
				text_readability: { score: 0.8, method: 'ocr_confidence', details: 'seed' },
				image_quality: { score: 0.9, issues: ['minor_skew'] },
				language_detection: { primary_language: 'en', confidence: 0.95, mixed_languages: false },
				document_structure: {
					type: 'printed_text',
					has_annotations: false,
					has_marginalia: false,
					multi_column: false,
				},
				content_completeness: { pages_total: 2, pages_readable: 2, missing_pages_suspected: false, truncated: false },
			});
			const first = await coreModule.createDocumentQualityAssessment(pool, {
				sourceId: source.id,
				assessedAt: new Date('2026-01-01T00:00:00.000Z'),
				assessmentMethod: 'automated',
				overallQuality: 'medium',
				processable: true,
				recommendedPath: 'enhanced_ocr',
				dimensions,
				signals: { ocr_confidence: 0.8 },
			});
			const second = await coreModule.createDocumentQualityAssessment(pool, {
				sourceId: source.id,
				assessedAt: new Date('2026-01-02T00:00:00.000Z'),
				assessmentMethod: 'human',
				overallQuality: 'low',
				processable: true,
				recommendedPath: 'visual_extraction',
				dimensions,
				signals: { reviewer: 'spec100' },
			});

			const found = await coreModule.findDocumentQualityAssessmentById(pool, first.id);
			expect(found?.dimensions.textReadability.score).toBe(0.8);
			expect(found?.signals.ocr_confidence).toBe(0.8);

			const latest = await coreModule.findLatestDocumentQualityAssessment(pool, source.id);
			expect(latest?.id).toBe(second.id);
			const all = await coreModule.listDocumentQualityAssessmentsForSource(pool, source.id);
			expect(all).toHaveLength(2);
		},
	);

	it.skipIf(!pgAvailable)(
		'QA-04/05: config defaults are local and pipeline plan includes quality before extract',
		() => {
			expect(config.document_quality.enabled).toBe(true);
			expect(config.document_quality.assessment.method).toBe('ocr_confidence');
			expect(config.document_quality.assessment.engine).toBeNull();
			expect(config.document_quality.routing.medium.path).toBe('enhanced_ocr');

			const pdfPlan = pipelineModule.planPipelineSteps({ sourceType: 'pdf' });
			expect(pdfPlan.requestedSteps.slice(0, 3)).toEqual(['ingest', 'quality', 'extract']);

			const textPlan = pipelineModule.planPipelineSteps({ sourceType: 'text' });
			expect(textPlan.requestedSteps).toContain('quality');
			expect(textPlan.skippedSteps).toEqual(['segment']);
			expect(textPlan.executableSteps).not.toContain('segment');
		},
	);

	it.skipIf(!pgAvailable)(
		'QA-06/07/08/12: quality persists, reuses without force, forces a new version, and stays local',
		async () => {
			const source = await createTestSource();
			const services = fakeServices();

			const first = await pipelineModule.executeQuality({ sourceId: source.id }, config, services, pool, testLogger());
			expect(first.status).toBe('success');
			expect(first.data?.assessment.overallQuality).toBe('high');

			const stepStatus = db.runSql(
				`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'quality';`,
			);
			expect(stepStatus).toBe('completed');

			const metadata = JSON.parse(
				db.runSql(`SELECT metadata::text FROM sources WHERE id = ${sqlLiteral(source.id)};`),
			) as Record<string, unknown>;
			expect(metadata.document_quality).toMatchObject({
				source_document_quality: 'high',
				extraction_path: 'standard',
				document_quality_assessment_id: first.data?.assessment.id,
			});

			const second = await pipelineModule.executeQuality({ sourceId: source.id }, config, services, pool, testLogger());
			expect(second.data?.reusedExisting).toBe(true);
			expect(second.data?.assessment.id).toBe(first.data?.assessment.id);
			expect(
				Number(
					db.runSql(`SELECT COUNT(*) FROM document_quality_assessments WHERE source_id = ${sqlLiteral(source.id)};`),
				),
			).toBe(1);

			const forced = await pipelineModule.executeQuality(
				{ sourceId: source.id, force: true },
				config,
				services,
				pool,
				testLogger(),
			);
			expect(forced.data?.reusedExisting).toBe(false);
			expect(forced.data?.assessment.id).not.toBe(first.data?.assessment.id);
			expect(
				Number(
					db.runSql(`SELECT COUNT(*) FROM document_quality_assessments WHERE source_id = ${sqlLiteral(source.id)};`),
				),
			).toBe(2);
		},
	);

	it.skipIf(!pgAvailable)('QA-09: unprocessable quality skips extract without creating stories', async () => {
		const source = await createTestSource({
			sourceType: 'pdf',
			filename: 'spec100-unusable.pdf',
			storagePath: 'raw/spec100-unusable.pdf',
			formatMetadata: {
				document_quality_override: {
					overall_quality: 'unusable',
					recommended_path: 'skip',
					processable: false,
				},
			},
			nativeTextRatio: 0,
			hasNativeText: false,
		});
		const services = fakeServices();
		await pipelineModule.executeQuality({ sourceId: source.id }, config, services, pool, testLogger());

		const extractResult = await pipelineModule.executeExtract(
			{ sourceId: source.id },
			config,
			services,
			pool,
			testLogger(),
		);
		expect(extractResult.status).toBe('skipped');
		expect(extractResult.data).toBeNull();
		expect(
			db.runSql(
				`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'extract';`,
			),
		).toBe('skipped');
		expect(Number(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(source.id)};`))).toBe(0);
	});

	it.skipIf(!pgAvailable)(
		'QA-09b: disabled quality config does not gate extract with a prior skip assessment',
		async () => {
			const source = await createTestSource({
				sourceType: 'text',
				filename: 'spec100-disabled.md',
				storagePath: 'raw/spec100-disabled.md',
				formatMetadata: { media_type: 'text/markdown' },
			});
			await coreModule.createDocumentQualityAssessment(pool, {
				sourceId: source.id,
				assessmentMethod: 'human',
				overallQuality: 'unusable',
				processable: false,
				recommendedPath: 'skip',
				dimensions: qualityDimensions({ score: 0, method: 'n/a' }),
				signals: { reviewer: 'spec100-disabled' },
			});
			const disabledConfig = {
				...config,
				document_quality: { ...config.document_quality, enabled: false },
			};
			const result = await pipelineModule.executeExtract(
				{ sourceId: source.id },
				disabledConfig,
				fakeServices({ 'raw/spec100-disabled.md': '# Disabled Quality\n\nExtract me.' }),
				pool,
				testLogger(),
			);

			expect(result.status).toBe('success');
			expect(Number(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(source.id)};`))).toBe(1);
			expect(
				db.runSql(
					`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'extract';`,
				),
			).toBe('completed');
		},
	);

	it.skipIf(!pgAvailable)('QA-09c: quality-skipped extract terminates the synchronous pipeline', async () => {
		const source = await createTestSource({
			sourceType: 'pdf',
			filename: 'spec100-terminal.pdf',
			storagePath: 'raw/spec100-terminal.pdf',
			formatMetadata: { media_type: 'application/pdf' },
			nativeTextRatio: 0,
			hasNativeText: false,
		});
		await coreModule.updateSourceStatus(pool, source.id, 'extracted');
		await coreModule.createDocumentQualityAssessment(pool, {
			sourceId: source.id,
			assessmentMethod: 'human',
			overallQuality: 'unusable',
			processable: false,
			recommendedPath: 'skip',
			dimensions: qualityDimensions({ score: 0, method: 'n/a' }),
			signals: { reviewer: 'spec100-terminal' },
		});

		const result = await pipelineModule.executePipelineRun(
			{ options: { sourceIds: [source.id], from: 'extract', upTo: 'segment', force: true } },
			config,
			fakeServices(),
			pool,
			testLogger(),
		);

		expect(result.status).toBe('success');
		expect(
			db.runSql(
				`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'extract';`,
			),
		).toBe('skipped');
		expect(
			db.runSql(
				`SELECT COALESCE((SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'segment'), 'missing');`,
			),
		).toBe('missing');
		expect(
			db.runSql(
				`SELECT current_step || '|' || status FROM pipeline_run_sources WHERE source_id = ${sqlLiteral(source.id)} ORDER BY updated_at DESC LIMIT 1;`,
			),
		).toBe('extract|completed');
	});

	it.skipIf(!pgAvailable)(
		'QA-09d: quality-skipped extract prevents global analyze in a graph-planned run',
		async () => {
			const source = await createTestSource({
				sourceType: 'pdf',
				filename: 'spec100-terminal-analyze.pdf',
				storagePath: 'raw/spec100-terminal-analyze.pdf',
				formatMetadata: { media_type: 'application/pdf' },
				nativeTextRatio: 0,
				hasNativeText: false,
			});
			await coreModule.createDocumentQualityAssessment(pool, {
				sourceId: source.id,
				assessmentMethod: 'human',
				overallQuality: 'unusable',
				processable: false,
				recommendedPath: 'skip',
				dimensions: qualityDimensions({ score: 0, method: 'n/a' }),
				signals: { reviewer: 'spec100-terminal-analyze' },
			});
			const analysisEnabledConfig: import('@mulder/core').MulderConfig = {
				...config,
				analysis: {
					...config.analysis,
					enabled: true,
					contradictions: false,
					reliability: false,
					evidence_chains: false,
					spatio_temporal: false,
				},
			};

			const result = await pipelineModule.executePipelineRun(
				{ options: { sourceIds: [source.id], from: 'quality' } },
				analysisEnabledConfig,
				fakeServices(),
				pool,
				testLogger(),
			);

			expect(result.status).toBe('success');
			expect(result.data.sources[0]?.finalStep).toBe('extract');
			expect(result.data.analysis.status).toBe('skipped');
			expect(result.data.analysis.summary).toBe('no sources reached graph successfully');
			expect(result.data.analysis.result).toBeNull();
			expect(
				db.runSql(
					`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'extract';`,
				),
			).toBe('skipped');
			expect(
				db.runSql(
					`SELECT COALESCE((SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'graph'), 'missing');`,
				),
			).toBe('missing');
		},
	);

	it.skipIf(!pgAvailable)('QA-10: processable quality propagates compact metadata to stories', async () => {
		const source = await createTestSource({
			sourceType: 'text',
			filename: 'spec100-medium.md',
			storagePath: 'raw/spec100-medium.md',
			formatMetadata: {
				media_type: 'text/markdown',
				document_quality_override: {
					overall_quality: 'medium',
					recommended_path: 'enhanced_ocr',
					processable: true,
				},
			},
		});
		const services = fakeServices({
			'raw/spec100-medium.md': '# Spec 100 Story\n\nText body.',
		});
		const qualityResult = await pipelineModule.executeQuality(
			{ sourceId: source.id },
			config,
			services,
			pool,
			testLogger(),
		);
		const extractResult = await pipelineModule.executeExtract(
			{ sourceId: source.id },
			config,
			services,
			pool,
			testLogger(),
		);
		expect(extractResult.status).toBe('success');

		const storyMetadata = JSON.parse(
			db.runSql(`SELECT metadata::text FROM stories WHERE source_id = ${sqlLiteral(source.id)} LIMIT 1;`),
		) as Record<string, unknown>;
		expect(storyMetadata).toMatchObject({
			source_document_quality: 'medium',
			extraction_path: 'enhanced_ocr',
			document_quality_assessment_id: qualityResult.data?.assessment.id,
		});
		expect(storyMetadata.extraction_confidence).toBe(0.7);
	});

	it.skipIf(!pgAvailable)('QA-10b: layout segmentation propagates compact quality metadata to stories', async () => {
		const source = await createTestSource({
			sourceType: 'pdf',
			filename: 'spec100-layout.pdf',
			storagePath: 'raw/spec100-layout.pdf',
			formatMetadata: { media_type: 'application/pdf' },
			nativeTextRatio: 1,
			hasNativeText: true,
		});
		await coreModule.updateSourceStatus(pool, source.id, 'extracted');
		const assessment = await coreModule.createDocumentQualityAssessment(pool, {
			sourceId: source.id,
			assessmentMethod: 'human',
			overallQuality: 'medium',
			processable: true,
			recommendedPath: 'enhanced_ocr',
			dimensions: qualityDimensions({ score: 0.7, method: 'ocr_confidence' }),
			signals: { reviewer: 'spec100-layout' },
		});
		const layout = {
			sourceId: source.id,
			pageCount: 1,
			primaryMethod: 'native',
			extractedAt: new Date().toISOString(),
			pages: [{ pageNumber: 1, method: 'native', confidence: 0.9, text: 'Layout story text.' }],
			metadata: { visionFallbackCount: 0, visionFallbackCapped: false },
		};
		const services = fakeServices(
			{
				[`extracted/${source.id}/layout.json`]: JSON.stringify(layout),
				[`extracted/${source.id}/pages/page-001.png`]: Buffer.from('png'),
			},
			{
				llm: {
					generateText: async () => {
						throw new Error('generateText should not be called by segment');
					},
					generateGrounded: async () => {
						throw new Error('generateGrounded should not be called by segment');
					},
					generateStructured: async () => ({
						stories: [
							{
								title: 'Layout Story',
								subtitle: null,
								language: 'en',
								category: 'news',
								page_start: 1,
								page_end: 1,
								date_references: [],
								geographic_references: [],
								confidence: 0.88,
								content_markdown: '# Layout Story\n\nLayout story text.',
							},
						],
					}),
				},
			},
		);

		const result = await pipelineModule.executeSegment({ sourceId: source.id }, config, services, pool, testLogger());
		expect(result.status).toBe('success');
		const storyMetadata = JSON.parse(
			db.runSql(`SELECT metadata::text FROM stories WHERE source_id = ${sqlLiteral(source.id)} LIMIT 1;`),
		) as Record<string, unknown>;
		expect(storyMetadata).toMatchObject({
			source_document_quality: 'medium',
			extraction_path: 'enhanced_ocr',
			document_quality_assessment_id: assessment.id,
		});
		expect(storyMetadata.extraction_confidence).toBe(0.7);
	});

	it.skipIf(!pgAvailable)('QA-10c: processable handwriting override is automatically extractable', async () => {
		const source = await createTestSource({
			sourceType: 'image',
			filename: 'spec100-handwriting.png',
			storagePath: 'raw/spec100-handwriting.png',
			formatMetadata: { media_type: 'image/png' },
		});
		const assessment = await coreModule.createDocumentQualityAssessment(pool, {
			sourceId: source.id,
			assessmentMethod: 'human',
			overallQuality: 'low',
			processable: true,
			recommendedPath: 'handwriting_recognition',
			dimensions: qualityDimensions({ score: 0.4, method: 'n/a' }),
			signals: { reviewer: 'spec100-handwriting' },
		});

		expect(pipelineModule.isAutomaticExtractionAllowed({ assessment, source })).toBe(true);
	});

	it.skipIf(!pgAvailable)(
		'QA-10d: non-text handwriting override without explicit processable is not automatically extractable',
		async () => {
			const source = await createTestSource({
				sourceType: 'image',
				filename: 'spec100-handwriting-omitted.png',
				storagePath: 'raw/spec100-handwriting-omitted.png',
				formatMetadata: {
					media_type: 'image/png',
					document_quality_override: {
						overall_quality: 'low',
						recommended_path: 'handwriting_recognition',
					},
				},
			});

			const qualityResult = await pipelineModule.executeQuality(
				{ sourceId: source.id },
				config,
				fakeServices(),
				pool,
				testLogger(),
			);
			expect(qualityResult.status).toBe('success');
			const assessment = qualityResult.data?.assessment;
			expect(assessment).toBeDefined();
			if (!assessment) {
				throw new Error('quality assessment missing');
			}
			expect(assessment.processable).toBe(false);
			expect(pipelineModule.isAutomaticExtractionAllowed({ assessment, source })).toBe(false);

			const extractResult = await pipelineModule.executeExtract(
				{ sourceId: source.id },
				config,
				fakeServices(),
				pool,
				testLogger(),
			);
			expect(extractResult.status).toBe('skipped');
		},
	);

	it.skipIf(!pgAvailable)(
		'QA-10e: quality-triggered reprocess preserves quality and stops after terminal extract skip',
		async () => {
			const source = await createTestSource({
				sourceType: 'pdf',
				filename: 'spec100-reprocess-skip.pdf',
				storagePath: 'raw/spec100-reprocess-skip.pdf',
				formatMetadata: { media_type: 'application/pdf' },
				nativeTextRatio: 0,
				hasNativeText: false,
			});
			await coreModule.updateSourceStatus(pool, source.id, 'graphed');
			await coreModule.createStory(pool, {
				sourceId: source.id,
				title: 'Stale Story',
				gcsMarkdownUri: `segments/${source.id}/stale.md`,
				gcsMetadataUri: `segments/${source.id}/stale.meta.json`,
			});
			const assessment = await coreModule.createDocumentQualityAssessment(pool, {
				sourceId: source.id,
				assessmentMethod: 'human',
				overallQuality: 'unusable',
				processable: false,
				recommendedPath: 'skip',
				dimensions: qualityDimensions({ score: 0, method: 'n/a' }),
				signals: { reviewer: 'spec100-reprocess-skip' },
			});
			await coreModule.upsertSourceStep(pool, {
				sourceId: source.id,
				stepName: 'quality',
				status: 'completed',
				configHash: coreModule.getStepConfigHash(config, 'quality'),
			});
			await coreModule.upsertSourceStep(pool, {
				sourceId: source.id,
				stepName: 'extract',
				status: 'completed',
				configHash: coreModule.getStepConfigHash(config, 'extract'),
			});
			await coreModule.upsertSourceStep(pool, {
				sourceId: source.id,
				stepName: 'segment',
				status: 'completed',
				configHash: coreModule.getStepConfigHash(config, 'segment'),
			});

			const result = await pipelineModule.executeReprocess(
				{ step: 'extract' },
				config,
				fakeServices(),
				pool,
				testLogger(),
			);

			expect(result.status).toBe('success');
			expect(Number(db.runSql(`SELECT COUNT(*) FROM stories WHERE source_id = ${sqlLiteral(source.id)};`))).toBe(0);
			expect(
				db.runSql(
					`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'quality';`,
				),
			).toBe('completed');
			expect(
				db.runSql(
					`SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'extract';`,
				),
			).toBe('skipped');
			expect(
				db.runSql(
					`SELECT COALESCE((SELECT status FROM source_steps WHERE source_id = ${sqlLiteral(source.id)} AND step_name = 'segment'), 'missing');`,
				),
			).toBe('missing');
			expect(db.runSql(`SELECT status FROM sources WHERE id = ${sqlLiteral(source.id)};`)).toBe('ingested');
			expect((await coreModule.findLatestDocumentQualityAssessment(pool, source.id))?.id).toBe(assessment.id);

			const followupPlan = await pipelineModule.planReprocess({}, config, pool);
			expect(followupPlan.plannedSourceCount).toBe(0);
		},
	);

	it.skipIf(!pgAvailable)('QA-11: CLI command runs one source and all eligible sources', async () => {
		const one = await createTestSource({ filename: 'spec100-cli-one.txt' });
		const first = runCli(['quality', one.id]);
		expect(first.exitCode, combinedOutput(first)).toBe(0);
		expect(first.stdout).toContain(one.id);
		expect(
			Number(db.runSql(`SELECT COUNT(*) FROM document_quality_assessments WHERE source_id = ${sqlLiteral(one.id)};`)),
		).toBe(1);

		truncateMulderTables();
		const allA = await createTestSource({ filename: 'spec100-cli-all-a.txt' });
		const allB = await createTestSource({ filename: 'spec100-cli-all-b.txt' });
		const all = runCli(['quality', '--all']);
		expect(all.exitCode, combinedOutput(all)).toBe(0);
		expect(all.stdout).toContain(allA.id);
		expect(all.stdout).toContain(allB.id);
		expect(Number(db.runSql('SELECT COUNT(*) FROM document_quality_assessments;'))).toBe(2);
	});
});
