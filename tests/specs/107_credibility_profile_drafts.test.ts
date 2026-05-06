import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, MULDER_TEST_TABLES, truncateExistingTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const PIPELINE_DIST = resolve(PIPELINE_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const DEFAULT_DIMENSIONS = [
	'institutional_authority',
	'domain_track_record',
	'conflict_of_interest',
	'transparency',
	'consistency',
] as const;

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

const pgAvailable = db.isPgAvailable();
let tempDir: string | null = null;
let pool: pg.Pool;
let coreModule: typeof import('@mulder/core');
let pipelineModule: typeof import('@mulder/pipeline');
let config: import('@mulder/core').MulderConfig;
let logger: import('@mulder/core').Logger;

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

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function writeMinimalConfigWithoutCredibility(): string {
	if (!tempDir) {
		tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec107-'));
	}
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec107"',
			'  description: "Spec 107 minimal config"',
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
			'  relationships: []',
			'',
		].join('\n'),
		'utf-8',
	);
	return configPath;
}

function writeMinimalConfigWithDuplicateCredibilityDimensionIds(): string {
	if (!tempDir) {
		tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec107-'));
	}
	const configPath = join(tempDir, `duplicate-credibility-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec107"',
			'  supported_locales: ["en"]',
			'gcp:',
			'  project_id: "test-project"',
			'  region: "europe-west1"',
			'  cloud_sql:',
			'    instance_name: "mulder-db"',
			'    database: "mulder"',
			'  storage:',
			'    bucket: "mulder-test"',
			'  document_ai:',
			'    processor_id: "processor"',
			'ontology:',
			'  entity_types:',
			'    - name: "person"',
			'      description: "Person"',
			'  relationships: []',
			'credibility:',
			'  dimensions:',
			'    - id: "transparency"',
			'      label: "Transparency"',
			'    - id: " transparency "',
			'      label: "Duplicate transparency"',
			'',
		].join('\n'),
		'utf-8',
	);
	return configPath;
}

function cleanTables(): void {
	truncateExistingTables(['credibility_dimensions', 'source_credibility_profiles', ...MULDER_TEST_TABLES]);
}

async function createTextSource(label = 'spec107') {
	const source = await coreModule.createSource(pool, {
		filename: `${label}-${randomUUID()}.md`,
		storagePath: `raw/${label}-${randomUUID()}.md`,
		fileHash: `${label}-${randomUUID()}`,
		sourceType: 'text',
		formatMetadata: { media_type: 'text/markdown' },
		pageCount: 1,
		hasNativeText: true,
		nativeTextRatio: 1,
	});
	return source;
}

async function createSegmentedStory(label = 'spec107') {
	const source = await createTextSource(label);
	await coreModule.updateSourceStatus(pool, source.id, 'segmented');
	const story = await coreModule.createStory(pool, {
		sourceId: source.id,
		title: 'Spec 107 Story',
		gcsMarkdownUri: `segments/${source.id}/story.md`,
		gcsMetadataUri: `segments/${source.id}/story.meta.json`,
		extractionConfidence: 0.94,
	});
	const storageRoot = process.env.MULDER_TEST_STORAGE_ROOT
		? resolve(process.env.MULDER_TEST_STORAGE_ROOT)
		: resolve(ROOT, '.local/storage');
	const localMarkdownPath = resolve(storageRoot, story.gcsMarkdownUri);
	mkdirSync(dirname(localMarkdownPath), { recursive: true });
	writeFileSync(localMarkdownPath, '# Spec 107 Story\n\nA witness observed a light.', 'utf-8');
	await coreModule.updateStoryStatus(pool, story.id, 'segmented');
	return { source, story };
}

function dimensionInputs(score = 0.6): import('@mulder/core').UpsertCredibilityDimensionInput[] {
	return config.credibility.dimensions.map((dimension, index) => ({
		dimensionId: dimension.id,
		label: dimension.label,
		score: Math.min(1, score + index * 0.03),
		rationale: `Rationale for ${dimension.id}`,
		evidenceRefs: [`evidence-${index}`],
		knownFactors: index === 0 ? ['fixture'] : [],
	}));
}

function credibilityResponse(score = 0.55) {
	return {
		source_type: 'other',
		dimensions: config.credibility.dimensions.map((dimension, index) => ({
			id: dimension.id,
			score: Math.min(1, score + index * 0.04),
			rationale: `Generated rationale for ${dimension.id}`,
			evidence_refs: [`generated-${index}`],
			known_factors: [],
		})),
	};
}

function extractionResponse(): import('@mulder/pipeline').ExtractionResponse {
	return {
		entities: [
			{
				name: 'Spec 107 Witness',
				type: 'person',
				confidence: 0.91,
				attributes: {},
				mentions: ['Spec 107 Witness'],
				sensitivity: {
					level: 'internal',
					reason: 'fixture',
					assigned_by: 'llm_auto',
					assigned_at: '2026-05-06T00:00:00.000Z',
					pii_types: [],
					declassify_date: null,
				},
			},
		],
		relationships: [],
		assertions: [
			{
				content: 'A witness observed a light.',
				assertion_type: 'observation',
				confidence_metadata: {
					witness_count: 1,
					measurement_based: false,
					contemporaneous: true,
					corroborated: false,
					peer_reviewed: false,
					author_is_interpreter: false,
				},
				classification_provenance: 'llm_auto',
				entity_names: ['Spec 107 Witness'],
				sensitivity: {
					level: 'internal',
					reason: 'fixture',
					assigned_by: 'llm_auto',
					assigned_at: '2026-05-06T00:00:00.000Z',
					pii_types: [],
					declassify_date: null,
				},
			},
		],
	};
}

function fakeServices(
	storyUri: string,
	structuredResponses: unknown[],
	options?: { markdown?: string; tokenCount?: number },
): import('@mulder/core').Services & { structuredCallCount: () => number } {
	let structuredCalls = 0;
	const services = {
		storage: {
			upload: async () => undefined,
			buildUri: (path: string) => `dev://storage/${path}`,
			createUploadSession: async () => ({
				url: '/dev-upload',
				method: 'PUT' as const,
				headers: {},
				transport: 'dev_proxy' as const,
				expiresAt: null,
			}),
			download: async (path: string) => {
				if (path !== storyUri) {
					throw new Error(`unexpected storage download: ${path}`);
				}
				return Buffer.from(options?.markdown ?? '# Spec 107 Story\n\nA witness observed a light.', 'utf-8');
			},
			getMetadata: async () => ({ sizeBytes: 42, contentType: 'text/markdown' }),
			exists: async () => true,
			list: async () => ({ paths: [] }),
			delete: async () => undefined,
		},
		firestore: {
			setDocument: async () => undefined,
			getDocument: async () => null,
		},
		documentAi: {
			processDocument: async () => {
				throw new Error('documentAi should not be called by Spec 107 tests');
			},
		},
		officeDocuments: {
			extractDocx: async () => {
				throw new Error('office extraction should not be called by Spec 107 tests');
			},
		},
		spreadsheets: {
			extractSpreadsheet: async () => {
				throw new Error('spreadsheet extraction should not be called by Spec 107 tests');
			},
		},
		emails: {
			extractEmail: async () => {
				throw new Error('email extraction should not be called by Spec 107 tests');
			},
		},
		urls: {
			fetchUrl: async () => {
				throw new Error('url fetch should not be called by Spec 107 tests');
			},
		},
		urlRenderers: {
			renderUrl: async () => {
				throw new Error('url render should not be called by Spec 107 tests');
			},
		},
		urlExtractors: {
			extractUrl: async () => {
				throw new Error('url extraction should not be called by Spec 107 tests');
			},
		},
		llm: {
			countTokens: async () => options?.tokenCount ?? 32,
			generateText: async () => {
				throw new Error('generateText should not be called by Spec 107 tests');
			},
			groundedGenerate: async () => {
				throw new Error('groundedGenerate should not be called by Spec 107 tests');
			},
			generateStructured: async (llmOptions: import('@mulder/core').StructuredGenerateOptions) => {
				if (structuredCalls >= structuredResponses.length) {
					throw new Error('unexpected structured LLM call');
				}
				const response = structuredResponses[structuredCalls];
				structuredCalls++;
				return llmOptions.responseValidator ? llmOptions.responseValidator(response) : response;
			},
		},
		embedding: {
			embed: async () => {
				throw new Error('embedding should not be called by Spec 107 tests');
			},
		},
		structuredCallCount: () => structuredCalls,
	};
	return services as unknown as import('@mulder/core').Services & { structuredCallCount: () => number };
}

function enrichConfig(): import('@mulder/core').MulderConfig {
	return {
		...config,
		entity_resolution: {
			...config.entity_resolution,
			strategies: config.entity_resolution.strategies.map((strategy) => ({ ...strategy, enabled: false })),
		},
		credibility: {
			...config.credibility,
			enabled: true,
			auto_profile_on_ingest: true,
		},
	};
}

beforeAll(async () => {
	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);

	coreModule = await import(pathToFileURL(CORE_DIST).href);
	pipelineModule = await import(pathToFileURL(PIPELINE_DIST).href);
	config = coreModule.loadConfig(EXAMPLE_CONFIG) as import('@mulder/core').MulderConfig;
	logger = coreModule.createLogger({ level: 'silent' });

	if (!pgAvailable) return;
	ensureSchema();
	pool = new pg.Pool(PG_CONFIG);
});

beforeEach(() => {
	if (!pgAvailable) return;
	cleanTables();
});

afterAll(async () => {
	if (pgAvailable) {
		cleanTables();
	}
	await pool?.end();
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe('Spec 107: credibility profile drafts', () => {
	it.skipIf(!pgAvailable)('QA-01: credibility tables are constrained', async () => {
		const tables = db.runSql(
			[
				'SELECT table_name',
				'FROM information_schema.tables',
				"WHERE table_schema = 'public'",
				"  AND table_name IN ('source_credibility_profiles', 'credibility_dimensions')",
				'ORDER BY table_name;',
			].join('\n'),
		);
		expect(tables).toContain('credibility_dimensions');
		expect(tables).toContain('source_credibility_profiles');

		const profileChecks = db.runSql(
			[
				"SELECT string_agg(pg_get_constraintdef(oid), E'\\n' ORDER BY conname)",
				'FROM pg_constraint',
				"WHERE conrelid = 'source_credibility_profiles'::regclass AND contype IN ('c', 'u');",
			].join('\n'),
		);
		for (const value of ['government', 'academic', 'journalist', 'witness', 'organization', 'anonymous', 'other']) {
			expect(profileChecks).toContain(value);
		}
		for (const value of ['llm_auto', 'human', 'hybrid', 'draft', 'reviewed', 'contested']) {
			expect(profileChecks).toContain(value);
		}

		const dimensionChecks = db.runSql(
			[
				"SELECT string_agg(pg_get_constraintdef(oid), E'\\n' ORDER BY conname)",
				'FROM pg_constraint',
				"WHERE conrelid = 'credibility_dimensions'::regclass AND contype IN ('c', 'u');",
			].join('\n'),
		);
		expect(dimensionChecks).toContain('score >=');
		expect(dimensionChecks).toContain('score <=');
		expect(dimensionChecks).toContain('profile_id, dimension_id');

		const indexes = db.runSql(
			[
				'SELECT indexname',
				'FROM pg_indexes',
				"WHERE schemaname = 'public'",
				"  AND indexname IN ('idx_source_credibility_profiles_review_status', 'idx_credibility_dimensions_dimension_id', 'idx_credibility_dimensions_low_score_review')",
				'ORDER BY indexname;',
			].join('\n'),
		);
		expect(indexes).toContain('idx_source_credibility_profiles_review_status');
		expect(indexes).toContain('idx_credibility_dimensions_dimension_id');
		expect(indexes).toContain('idx_credibility_dimensions_low_score_review');
	});

	it('QA-02: config exposes A8 defaults', () => {
		const minimalConfig = coreModule.loadConfig(
			writeMinimalConfigWithoutCredibility(),
		) as import('@mulder/core').MulderConfig;
		expect(minimalConfig.credibility.enabled).toBe(true);
		expect(minimalConfig.credibility.dimensions.map((dimension) => dimension.id)).toEqual([...DEFAULT_DIMENSIONS]);
		expect(minimalConfig.credibility.auto_profile_on_ingest).toBe(true);
		expect(minimalConfig.credibility.require_human_review).toBe(true);
		expect(minimalConfig.credibility.display_in_reports).toBe(true);
		expect(minimalConfig.credibility.agent_instruction).toBe('weight_but_never_exclude');
	});

	it('QA-02b: config rejects duplicate trimmed credibility dimension IDs', () => {
		expect(() => coreModule.loadConfig(writeMinimalConfigWithDuplicateCredibilityDimensionIds())).toThrow(
			/Duplicate credibility dimension id "transparency"/,
		);
	});

	it.skipIf(!pgAvailable)('QA-03: repository upserts a full dimension snapshot', async () => {
		const source = await createTextSource('spec107-qa03');
		const first = await coreModule.upsertSourceCredibilityProfile(pool, {
			sourceId: source.id,
			sourceName: source.filename,
			sourceType: 'academic',
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			dimensions: dimensionInputs(0.4),
		});
		const second = await coreModule.upsertSourceCredibilityProfile(pool, {
			sourceId: source.id,
			sourceName: source.filename,
			sourceType: 'academic',
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			dimensions: dimensionInputs(0.7),
		});

		expect(second.profileId).toBe(first.profileId);
		expect(second.dimensions).toHaveLength(config.credibility.dimensions.length);
		expect(second.dimensions[0].score).toBeGreaterThan(first.dimensions[0].score);
		expect(
			Number(
				db.runSql(`SELECT COUNT(*) FROM credibility_dimensions WHERE profile_id = ${sqlLiteral(second.profileId)};`),
			),
		).toBe(config.credibility.dimensions.length);
	});

	it.skipIf(!pgAvailable)('QA-04: draft generation creates reviewable profiles', async () => {
		const source = await createTextSource('spec107-qa04');
		const services = fakeServices('', [credibilityResponse(0.5)]);
		const result = await pipelineModule.generateSourceCredibilityProfileDraft({
			sourceId: source.id,
			config: config.credibility,
			services,
			pool,
			logger,
		});

		expect(result.status).toBe('created');
		expect(result.created).toBe(true);
		expect(result.profile?.profileAuthor).toBe('llm_auto');
		expect(result.profile?.reviewStatus).toBe('draft');
		expect(result.profile?.lastReviewed).toBeNull();
		expect(result.profile?.dimensions.map((dimension) => dimension.dimensionId).sort()).toEqual(
			[...DEFAULT_DIMENSIONS].sort(),
		);
	});

	it.skipIf(!pgAvailable)('QA-05: existing profiles are preserved', async () => {
		const source = await createTextSource('spec107-qa05');
		const existing = await coreModule.upsertSourceCredibilityProfile(pool, {
			sourceId: source.id,
			sourceName: source.filename,
			sourceType: 'witness',
			profileAuthor: 'human',
			lastReviewed: '2026-05-06T00:00:00.000Z',
			reviewStatus: 'reviewed',
			dimensions: dimensionInputs(0.9),
		});
		const services = fakeServices('', []);
		const result = await pipelineModule.generateSourceCredibilityProfileDraft({
			sourceId: source.id,
			config: config.credibility,
			services,
			pool,
			logger,
		});
		const preserved = await coreModule.findSourceCredibilityProfileBySourceId(pool, source.id);

		expect(result.status).toBe('skipped');
		expect(result.reason).toBe('profile_exists');
		expect(services.structuredCallCount()).toBe(0);
		expect(preserved?.profileId).toBe(existing.profileId);
		expect(preserved?.profileAuthor).toBe('human');
		expect(preserved?.reviewStatus).toBe('reviewed');
		expect(preserved?.dimensions[0].score).toBe(existing.dimensions[0].score);
	});

	it.skipIf(!pgAvailable)('QA-06: Enrich exposes profile-generation status', async () => {
		const { source, story } = await createSegmentedStory('spec107-qa06');
		const result = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: false },
			enrichConfig(),
			fakeServices(story.gcsMarkdownUri, [extractionResponse(), credibilityResponse(0.52)]),
			pool,
			logger,
		);
		const profile = await coreModule.findSourceCredibilityProfileBySourceId(pool, source.id);

		expect(result.status).toBe('success');
		expect(result.data?.credibilityProfileCreated).toBe(true);
		expect(result.data?.credibilityProfileStatus).toBe('created');
		expect(profile?.reviewStatus).toBe('draft');
		expect(profile?.dimensions).toHaveLength(config.credibility.dimensions.length);
	});

	it.skipIf(!pgAvailable)('QA-06b: Enrich records draft-generation failures in source_steps', async () => {
		const { source, story } = await createSegmentedStory('spec107-qa06b');
		const result = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: false },
			enrichConfig(),
			fakeServices(story.gcsMarkdownUri, [extractionResponse()]),
			pool,
			logger,
		);
		const step = await pool.query<{ status: string; error_message: string | null }>(
			"SELECT status, error_message FROM source_steps WHERE source_id = $1 AND step_name = 'enrich'",
			[source.id],
		);

		expect(result.status).toBe('success');
		expect(result.data?.credibilityProfileCreated).toBe(false);
		expect(result.data?.credibilityProfileStatus).toBe('failed');
		expect(result.errors.map((error) => error.message).join('\n')).toContain(
			'Source credibility draft generation failed',
		);
		expect(step.rows[0]).toMatchObject({ status: 'partial' });
		expect(step.rows[0].error_message).toContain('Source credibility draft generation failed');
	});
});
