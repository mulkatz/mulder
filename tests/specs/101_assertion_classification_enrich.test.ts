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

function runCli(
	args: string[],
	opts?: { configPath?: string; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI_DIST, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 120_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			MULDER_CONFIG: opts?.configPath ?? EXAMPLE_CONFIG,
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

function writeMinimalConfigWithoutAssertions(): string {
	if (!tempDir) {
		tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec101-'));
	}
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec101"',
			'  description: "Spec 101 minimal config"',
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

function cleanTables(): void {
	truncateExistingTables(['knowledge_assertions', ...MULDER_TEST_TABLES]);
}

async function createSegmentedStory(label = 'spec101') {
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
	await coreModule.updateSourceStatus(pool, source.id, 'segmented');
	const story = await coreModule.createStory(pool, {
		sourceId: source.id,
		title: 'Spec 101 Story',
		gcsMarkdownUri: `segments/${source.id}/story.md`,
		gcsMetadataUri: `segments/${source.id}/story.meta.json`,
		extractionConfidence: 0.91,
	});
	const storageRoot = process.env.MULDER_TEST_STORAGE_ROOT
		? resolve(process.env.MULDER_TEST_STORAGE_ROOT)
		: resolve(ROOT, '.local/storage');
	const localMarkdownPath = resolve(storageRoot, story.gcsMarkdownUri);
	mkdirSync(dirname(localMarkdownPath), { recursive: true });
	writeFileSync(localMarkdownPath, '# Spec 101 Story\n\nThree witnesses observed a bright object.', 'utf-8');
	await coreModule.updateStoryStatus(pool, story.id, 'segmented');
	return { source, story };
}

function confidenceMetadata(): import('@mulder/core').ConfidenceMetadata {
	return {
		witnessCount: 3,
		measurementBased: true,
		contemporaneous: true,
		corroborated: false,
		peerReviewed: false,
		authorIsInterpreter: false,
	};
}

function fakeServices(
	storyUri: string,
	response: import('@mulder/pipeline').ExtractionResponse,
): import('@mulder/core').Services {
	return {
		storage: {
			upload: async () => 'gs://test/spec101',
			download: async (path: string) => {
				if (path !== storyUri) {
					throw new Error(`unexpected storage download: ${path}`);
				}
				return Buffer.from('# Spec 101 Story\n\nThree witnesses observed a bright object.', 'utf-8');
			},
			delete: async () => undefined,
			exists: async () => true,
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
				throw new Error('documentAi should not be called by Spec 101 enrich tests');
			},
		},
		llm: {
			countTokens: async () => 32,
			generateText: async () => {
				throw new Error('generateText should not be called by Spec 101 enrich tests');
			},
			generateGrounded: async () => {
				throw new Error('generateGrounded should not be called by Spec 101 enrich tests');
			},
			generateStructured: async () => response,
		},
		embeddings: {
			embed: async () => {
				throw new Error('embeddings should not be called by Spec 101 enrich tests');
			},
			embedBatch: async () => {
				throw new Error('embeddings should not be called by Spec 101 enrich tests');
			},
		},
		officeDocuments: {
			extractDocx: async () => {
				throw new Error('office extraction should not be called by Spec 101 enrich tests');
			},
		},
		spreadsheets: {
			extractSpreadsheet: async () => {
				throw new Error('spreadsheet extraction should not be called by Spec 101 enrich tests');
			},
		},
		emailExtractors: {
			extractEmail: async () => {
				throw new Error('email extraction should not be called by Spec 101 enrich tests');
			},
		},
		urlFetchers: {
			fetchUrl: async () => {
				throw new Error('url fetch should not be called by Spec 101 enrich tests');
			},
		},
		urlRenderers: {
			renderUrl: async () => {
				throw new Error('url render should not be called by Spec 101 enrich tests');
			},
		},
		urlExtractors: {
			extractUrl: async () => {
				throw new Error('url extraction should not be called by Spec 101 enrich tests');
			},
		},
	} as unknown as import('@mulder/core').Services;
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
	await pool?.end();
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

describe('Spec 101: assertion classification in Enrich', () => {
	it.skipIf(!pgAvailable)('QA-01: migration creates a constrained assertion store', () => {
		const table = db.runSql(
			"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'knowledge_assertions';",
		);
		expect(table).toBe('knowledge_assertions');

		const columns = db.runSql(
			[
				"SELECT column_name || ':' || data_type || ':' || is_nullable",
				'FROM information_schema.columns',
				"WHERE table_schema = 'public' AND table_name = 'knowledge_assertions'",
				'ORDER BY ordinal_position;',
			].join('\n'),
		);
		expect(columns).toContain('source_id:uuid:NO');
		expect(columns).toContain('story_id:uuid:NO');
		expect(columns).toContain('assertion_type:text:NO');
		expect(columns).toContain('content:text:NO');
		expect(columns).toContain('confidence_metadata:jsonb:NO');
		expect(columns).toContain('classification_provenance:text:NO');
		expect(columns).toContain('extracted_entity_ids:ARRAY:NO');
		expect(columns).toContain('provenance:jsonb:NO');
		expect(columns).toContain('quality_metadata:jsonb:YES');
		expect(columns).toContain('deleted_at:timestamp with time zone:YES');

		const foreignKeys = db.runSql(
			[
				'SELECT confrelid::regclass::text',
				'FROM pg_constraint',
				"WHERE conrelid = 'knowledge_assertions'::regclass AND contype = 'f'",
				'ORDER BY confrelid::regclass::text;',
			].join('\n'),
		);
		expect(foreignKeys).toContain('sources');
		expect(foreignKeys).toContain('stories');

		const checks = db.runSql(
			[
				'SELECT pg_get_constraintdef(oid)',
				'FROM pg_constraint',
				"WHERE conrelid = 'knowledge_assertions'::regclass AND contype = 'c'",
				'ORDER BY conname;',
			].join('\n'),
		);
		expect(checks).toContain('observation');
		expect(checks).toContain('interpretation');
		expect(checks).toContain('hypothesis');
		expect(checks).toContain('llm_auto');
		expect(checks).toContain('human_reviewed');
		expect(checks).toContain('author_explicit');
		expect(checks).toContain('jsonb_typeof(confidence_metadata)');
		expect(checks).toContain('jsonb_typeof(provenance)');

		const activeIdempotencyIndex = db.runSql(
			[
				'SELECT indexdef',
				'FROM pg_indexes',
				"WHERE schemaname = 'public' AND tablename = 'knowledge_assertions'",
				"  AND indexdef ILIKE '%source_id%'",
				"  AND indexdef ILIKE '%story_id%'",
				"  AND indexdef ILIKE '%content%'",
				"  AND indexdef ILIKE '%assertion_type%'",
				"  AND indexdef ILIKE '%deleted_at IS NULL%'",
				'LIMIT 1;',
			].join('\n'),
		);
		expect(activeIdempotencyIndex).toContain('UNIQUE');
	});

	it('QA-02: config exposes A3 defaults', () => {
		const minimalConfig = coreModule.loadConfig(
			writeMinimalConfigWithoutAssertions(),
		) as import('@mulder/core').MulderConfig;
		expect(minimalConfig.enrichment.assertion_classification).toEqual({
			enabled: true,
			conservative_labeling: true,
			require_confidence_metadata: true,
			default_provenance: 'llm_auto',
			reviewable: true,
			review_depth: 'spot_check',
			spot_check_percentage: 20,
		});
	});

	it('QA-03: structured schema changes with the feature flag', () => {
		const enabledSchema = pipelineModule.generateExtractionSchema(config.ontology, {
			assertionClassificationEnabled: true,
		});
		const enabledProperties = enabledSchema.properties as Record<string, Record<string, unknown>>;
		expect(enabledProperties.assertions).toBeDefined();
		const assertionItems = enabledProperties.assertions.items as Record<string, unknown>;
		const assertionProperties = assertionItems.properties as Record<string, Record<string, unknown>>;
		expect(assertionProperties.assertion_type.enum).toEqual(['observation', 'interpretation', 'hypothesis']);
		expect((assertionProperties.confidence_metadata.required as string[]).sort()).toEqual(
			[
				'author_is_interpreter',
				'contemporaneous',
				'corroborated',
				'measurement_based',
				'peer_reviewed',
				'witness_count',
			].sort(),
		);

		const enabledRuntime = pipelineModule.getExtractionResponseSchema(config.ontology, {
			assertionClassificationEnabled: true,
		});
		const classifiedResponse = {
			entities: [],
			relationships: [],
			assertions: [
				{
					content: 'Three witnesses observed a bright object.',
					assertion_type: 'observation',
					confidence_metadata: {
						witness_count: 3,
						measurement_based: false,
						contemporaneous: true,
						corroborated: false,
						peer_reviewed: false,
						author_is_interpreter: false,
					},
					classification_provenance: 'llm_auto',
					entity_names: [],
				},
			],
		};
		expect(enabledRuntime.safeParse(classifiedResponse).success).toBe(true);

		const disabledSchema = pipelineModule.generateExtractionSchema(config.ontology, {
			assertionClassificationEnabled: false,
		});
		const disabledProperties = disabledSchema.properties as Record<string, Record<string, unknown>>;
		expect(disabledProperties.assertions).toBeUndefined();
		const disabledRuntime = pipelineModule.getExtractionResponseSchema(config.ontology, {
			assertionClassificationEnabled: false,
		});
		expect(disabledRuntime.safeParse({ entities: [], relationships: [] }).success).toBe(true);
	});

	it.skipIf(!pgAvailable)('QA-04: repository writes round-trip classified assertions', async () => {
		const { source, story } = await createSegmentedStory('spec101-qa04');
		const entity = await coreModule.createEntity(pool, {
			name: 'Spec Observer',
			type: 'person',
			provenance: { sourceDocumentIds: [source.id], extractionPipelineRun: 'spec101-run' },
		});

		const persisted = await coreModule.upsertKnowledgeAssertion(pool, {
			sourceId: source.id,
			storyId: story.id,
			assertionType: 'observation',
			content: 'Three witnesses observed a bright object.',
			confidenceMetadata: confidenceMetadata(),
			classificationProvenance: 'author_explicit',
			extractedEntityIds: [entity.id],
			provenance: { sourceDocumentIds: [source.id], extractionPipelineRun: 'spec101-run' },
			qualityMetadata: { source_document_quality: 'high' },
		});
		const [roundTripped] = await coreModule.listKnowledgeAssertionsForStory(pool, story.id);

		expect(roundTripped.id).toBe(persisted.id);
		expect(roundTripped.assertionType).toBe('observation');
		expect(roundTripped.classificationProvenance).toBe('author_explicit');
		expect(roundTripped.confidenceMetadata).toEqual(confidenceMetadata());
		expect(roundTripped.extractedEntityIds).toEqual([entity.id]);
		expect(roundTripped.provenance.sourceDocumentIds).toEqual([source.id]);
		expect(roundTripped.qualityMetadata).toEqual({ source_document_quality: 'high' });
	});

	it.skipIf(!pgAvailable)('QA-05: upserts are idempotent and merge provenance', async () => {
		const { source, story } = await createSegmentedStory('spec101-qa05');
		const content = 'The author interprets the pattern as environmental.';
		await coreModule.upsertKnowledgeAssertion(pool, {
			sourceId: source.id,
			storyId: story.id,
			assertionType: 'interpretation',
			content,
			confidenceMetadata: confidenceMetadata(),
			provenance: { sourceDocumentIds: [source.id, '11111111-1111-1111-1111-111111111111'] },
		});
		await coreModule.upsertKnowledgeAssertion(pool, {
			sourceId: source.id,
			storyId: story.id,
			assertionType: 'interpretation',
			content,
			confidenceMetadata: { ...confidenceMetadata(), measurementBased: false },
			provenance: { sourceDocumentIds: [source.id, '22222222-2222-2222-2222-222222222222'] },
		});

		const assertions = await coreModule.listKnowledgeAssertionsForStory(pool, story.id);
		expect(assertions).toHaveLength(1);
		expect(assertions[0].provenance.sourceDocumentIds.sort()).toEqual(
			['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', source.id].sort(),
		);
		expect(
			Number(
				db.runSql(
					[
						'SELECT COUNT(*)',
						'FROM knowledge_assertions',
						`WHERE source_id = ${sqlLiteral(source.id)}`,
						`  AND story_id = ${sqlLiteral(story.id)}`,
						`  AND content = ${sqlLiteral(content)}`,
						"  AND assertion_type = 'interpretation'",
						'  AND deleted_at IS NULL;',
					].join('\n'),
				),
			),
		).toBe(1);
	});

	it.skipIf(!pgAvailable)('QA-06: Enrich persists assertions only when enabled', async () => {
		const { story } = await createSegmentedStory('spec101-qa06-enabled');
		const response: import('@mulder/pipeline').ExtractionResponse = {
			entities: [
				{
					name: 'Spec Observer',
					type: 'person',
					confidence: 0.9,
					attributes: {},
					mentions: ['Spec Observer'],
				},
			],
			relationships: [],
			assertions: [
				{
					content: 'Three witnesses observed a bright object.',
					assertion_type: 'observation',
					confidence_metadata: {
						witness_count: 3,
						measurement_based: false,
						contemporaneous: true,
						corroborated: false,
						peer_reviewed: false,
						author_is_interpreter: false,
					},
					classification_provenance: 'llm_auto',
					entity_names: ['Spec Observer'],
				},
			],
		};
		const enrichConfig: import('@mulder/core').MulderConfig = {
			...config,
			enrichment: {
				...config.enrichment,
				assertion_classification: {
					...config.enrichment.assertion_classification,
					enabled: true,
				},
			},
			entity_resolution: {
				...config.entity_resolution,
				strategies: config.entity_resolution.strategies.map((strategy) => ({ ...strategy, enabled: false })),
			},
		};
		const enabledResult = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: false },
			enrichConfig,
			fakeServices(story.gcsMarkdownUri, response),
			pool,
			logger,
		);

		expect(enabledResult.status).toBe('success');
		expect(enabledResult.data?.assertionsPersisted).toBe(1);
		expect(
			Number(db.runSql(`SELECT COUNT(*) FROM knowledge_assertions WHERE story_id = ${sqlLiteral(story.id)};`)),
		).toBe(1);

		const disabled = await createSegmentedStory('spec101-qa06-disabled');
		const disabledConfig: import('@mulder/core').MulderConfig = {
			...enrichConfig,
			enrichment: {
				...enrichConfig.enrichment,
				assertion_classification: {
					...enrichConfig.enrichment.assertion_classification,
					enabled: false,
				},
			},
		};
		const disabledResult = await pipelineModule.executeEnrich(
			{ storyId: disabled.story.id, force: false },
			disabledConfig,
			fakeServices(disabled.story.gcsMarkdownUri, response),
			pool,
			logger,
		);

		expect(disabledResult.status).toBe('success');
		expect(disabledResult.data?.entitiesExtracted).toBeGreaterThanOrEqual(1);
		expect(disabledResult.data?.assertionsPersisted).toBe(0);
		expect(
			Number(db.runSql(`SELECT COUNT(*) FROM knowledge_assertions WHERE story_id = ${sqlLiteral(disabled.story.id)};`)),
		).toBe(0);
	});

	it.skipIf(!pgAvailable)('QA-07: force reruns do not duplicate assertions', async () => {
		const { story } = await createSegmentedStory('spec101-qa07');
		const response: import('@mulder/pipeline').ExtractionResponse = {
			entities: [
				{
					name: 'Spec Observer',
					type: 'person',
					confidence: 0.9,
					attributes: {},
					mentions: ['Spec Observer'],
				},
			],
			relationships: [],
			assertions: [
				{
					content: 'A formal hypothesis predicts more reports after storms.',
					assertion_type: 'hypothesis',
					confidence_metadata: {
						witness_count: null,
						measurement_based: false,
						contemporaneous: false,
						corroborated: false,
						peer_reviewed: true,
						author_is_interpreter: true,
					},
					classification_provenance: 'llm_auto',
					entity_names: ['Spec Observer'],
				},
			],
		};
		const enrichConfig: import('@mulder/core').MulderConfig = {
			...config,
			enrichment: {
				...config.enrichment,
				assertion_classification: {
					...config.enrichment.assertion_classification,
					enabled: true,
				},
			},
			entity_resolution: {
				...config.entity_resolution,
				strategies: config.entity_resolution.strategies.map((strategy) => ({ ...strategy, enabled: false })),
			},
		};

		const first = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: false },
			enrichConfig,
			fakeServices(story.gcsMarkdownUri, response),
			pool,
			logger,
		);
		expect(first.status).toBe('success');
		const second = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: true },
			enrichConfig,
			fakeServices(story.gcsMarkdownUri, response),
			pool,
			logger,
		);
		expect(second.status).toBe('success');
		expect(second.data?.assertionsPersisted).toBe(1);
		expect(
			Number(
				db.runSql(
					[
						'SELECT COUNT(*)',
						'FROM knowledge_assertions',
						`WHERE story_id = ${sqlLiteral(story.id)}`,
						"  AND content = 'A formal hypothesis predicts more reports after storms.'",
						"  AND assertion_type = 'hypothesis'",
						'  AND deleted_at IS NULL;',
					].join('\n'),
				),
			),
		).toBe(1);
	});

	it.skipIf(!pgAvailable)('CLI-01: mulder enrich <source-id> writes entities and knowledge assertions', async () => {
		const { source } = await createSegmentedStory('spec101-cli01');
		const result = runCli(['enrich', source.id], { timeout: 120_000 });
		expect(result.exitCode, combinedOutput(result)).toBe(0);
		expect(
			Number(
				db.runSql(
					`SELECT COUNT(*) FROM story_entities se JOIN stories s ON s.id = se.story_id WHERE s.source_id = ${sqlLiteral(source.id)};`,
				),
			),
		).toBeGreaterThanOrEqual(1);
		expect(
			Number(db.runSql(`SELECT COUNT(*) FROM knowledge_assertions WHERE source_id = ${sqlLiteral(source.id)};`)),
		).toBeGreaterThanOrEqual(1);
	});

	it.skipIf(!pgAvailable)('CLI-02: mulder enrich --force <source-id> remains assertion-idempotent', async () => {
		const { source } = await createSegmentedStory('spec101-cli02');
		const first = runCli(['enrich', source.id], { timeout: 120_000 });
		expect(first.exitCode, combinedOutput(first)).toBe(0);
		const second = runCli(['enrich', '--force', source.id], { timeout: 120_000 });
		expect(second.exitCode, combinedOutput(second)).toBe(0);
		const duplicateGroups = Number(
			db.runSql(
				[
					'SELECT COUNT(*)',
					'FROM (',
					'  SELECT source_id, story_id, content, assertion_type',
					'  FROM knowledge_assertions',
					`  WHERE source_id = ${sqlLiteral(source.id)} AND deleted_at IS NULL`,
					'  GROUP BY source_id, story_id, content, assertion_type',
					'  HAVING COUNT(*) > 1',
					') duplicates;',
				].join('\n'),
			),
		);
		expect(duplicateGroups).toBe(0);
	});

	it('CLI-03: mulder config validate accepts minimal config without assertion block', () => {
		const result = runCli(['config', 'validate', '--config', writeMinimalConfigWithoutAssertions()]);
		expect(result.exitCode, combinedOutput(result)).toBe(0);
	});
});
