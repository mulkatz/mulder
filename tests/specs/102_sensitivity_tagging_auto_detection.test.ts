import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const SENSITIVITY_TABLES = [
	'sources',
	'stories',
	'entities',
	'entity_aliases',
	'story_entities',
	'chunks',
	'entity_edges',
	'knowledge_assertions',
] as const;

const EXPECTED_LEVELS = ['public', 'internal', 'restricted', 'confidential'];
const EXPECTED_PII_TYPES = [
	'person_name',
	'contact_info',
	'medical_data',
	'location_private',
	'location_sighting',
	'financial',
	'unpublished_research',
	'legal',
];

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

type SensitivityLevel = import('@mulder/core').SensitivityLevel;
type PIIType = import('@mulder/core').PIIType;
type ExtractionResponse = import('@mulder/pipeline').ExtractionResponse;

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

function writeMinimalConfigWithoutAccessControl(): string {
	if (!tempDir) {
		tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec102-'));
	}
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec102"',
			'  description: "Spec 102 minimal config"',
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

function cleanTables(): void {
	truncateExistingTables(['knowledge_assertions', ...MULDER_TEST_TABLES]);
}

function sensitivityMetadata(
	level: SensitivityLevel,
	options?: { reason?: string; assignedBy?: import('@mulder/core').SensitivityAssignmentSource; piiTypes?: PIIType[] },
) {
	return coreModule.defaultSensitivityMetadata(level, {
		reason: options?.reason ?? `${level}_fixture`,
		assignedBy: options?.assignedBy ?? 'human',
		assignedAt: '2026-05-05T00:00:00.000Z',
		piiTypes: options?.piiTypes ?? [],
		declassifyDate: null,
	});
}

async function createSegmentedStory(label = 'spec102') {
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
		title: 'Spec 102 Story',
		gcsMarkdownUri: `segments/${source.id}/story.md`,
		gcsMetadataUri: `segments/${source.id}/story.meta.json`,
		extractionConfidence: 0.93,
	});
	const storageRoot = process.env.MULDER_TEST_STORAGE_ROOT
		? resolve(process.env.MULDER_TEST_STORAGE_ROOT)
		: resolve(ROOT, '.local/storage');
	const localMarkdownPath = resolve(storageRoot, story.gcsMarkdownUri);
	mkdirSync(dirname(localMarkdownPath), { recursive: true });
	writeFileSync(localMarkdownPath, '# Spec 102 Story\n\nA named person attended a private event.', 'utf-8');
	await coreModule.updateStoryStatus(pool, story.id, 'segmented');
	return { source, story };
}

function confidenceMetadata(): import('@mulder/core').ConfidenceMetadata {
	return {
		witnessCount: 1,
		measurementBased: false,
		contemporaneous: true,
		corroborated: false,
		peerReviewed: false,
		authorIsInterpreter: false,
	};
}

function fakeServices(storyUri: string, response: ExtractionResponse): import('@mulder/core').Services {
	return {
		storage: {
			upload: async () => 'gs://test/spec102',
			download: async (path: string) => {
				if (path !== storyUri) {
					throw new Error(`unexpected storage download: ${path}`);
				}
				return Buffer.from('# Spec 102 Story\n\nA named person attended a private event.', 'utf-8');
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
				throw new Error('documentAi should not be called by Spec 102 enrich tests');
			},
		},
		llm: {
			countTokens: async () => 32,
			generateText: async () => {
				throw new Error('generateText should not be called by Spec 102 enrich tests');
			},
			generateGrounded: async () => {
				throw new Error('generateGrounded should not be called by Spec 102 enrich tests');
			},
			generateStructured: async () => response,
		},
		embeddings: {
			embed: async () => {
				throw new Error('embeddings should not be called by Spec 102 enrich tests');
			},
			embedBatch: async () => {
				throw new Error('embeddings should not be called by Spec 102 enrich tests');
			},
		},
		officeDocuments: {
			extractDocx: async () => {
				throw new Error('office extraction should not be called by Spec 102 enrich tests');
			},
		},
		spreadsheets: {
			extractSpreadsheet: async () => {
				throw new Error('spreadsheet extraction should not be called by Spec 102 enrich tests');
			},
		},
		emailExtractors: {
			extractEmail: async () => {
				throw new Error('email extraction should not be called by Spec 102 enrich tests');
			},
		},
		urlFetchers: {
			fetchUrl: async () => {
				throw new Error('url fetch should not be called by Spec 102 enrich tests');
			},
		},
		urlRenderers: {
			renderUrl: async () => {
				throw new Error('url render should not be called by Spec 102 enrich tests');
			},
		},
		urlExtractors: {
			extractUrl: async () => {
				throw new Error('url extraction should not be called by Spec 102 enrich tests');
			},
		},
	} as unknown as import('@mulder/core').Services;
}

function enrichConfig(autoDetection: boolean): import('@mulder/core').MulderConfig {
	return {
		...config,
		access_control: {
			...config.access_control,
			sensitivity: {
				...config.access_control.sensitivity,
				auto_detection: autoDetection,
				default_level: 'internal',
				propagation: 'upward',
			},
		},
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
}

function extractionResponse(levels: {
	entity: SensitivityLevel;
	relationship: SensitivityLevel;
	assertion: SensitivityLevel;
	entityName?: string;
	eventName?: string;
}): ExtractionResponse {
	const entityName = levels.entityName ?? 'Spec Sensitive Person';
	const eventName = levels.eventName ?? 'Spec Private Event';
	return {
		entities: [
			{
				name: entityName,
				type: 'person',
				confidence: 0.91,
				attributes: {},
				mentions: [entityName],
				sensitivity: {
					level: levels.entity,
					reason: `${levels.entity}_entity`,
					assigned_by: 'llm_auto',
					assigned_at: '2026-05-05T00:00:00.000Z',
					pii_types: levels.entity === 'internal' ? [] : ['person_name'],
					declassify_date: null,
				},
			},
			{
				name: eventName,
				type: 'event',
				confidence: 0.88,
				attributes: {},
				mentions: [eventName],
				sensitivity: {
					level: 'internal',
					reason: 'internal_event',
					assigned_by: 'llm_auto',
					assigned_at: '2026-05-05T00:00:00.000Z',
					pii_types: [],
					declassify_date: null,
				},
			},
		],
		relationships: [
			{
				source_entity: entityName,
				target_entity: eventName,
				relationship_type: 'PARTICIPATED_IN',
				confidence: 0.82,
				attributes: {},
				sensitivity: {
					level: levels.relationship,
					reason: `${levels.relationship}_relationship`,
					assigned_by: 'llm_auto',
					assigned_at: '2026-05-05T00:00:00.000Z',
					pii_types: [],
					declassify_date: null,
				},
			},
		],
		assertions: [
			{
				content: `${entityName} attended ${eventName}.`,
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
				entity_names: [entityName, eventName],
				sensitivity: {
					level: levels.assertion,
					reason: `${levels.assertion}_assertion`,
					assigned_by: 'llm_auto',
					assigned_at: '2026-05-05T00:00:00.000Z',
					pii_types: levels.assertion === 'internal' ? [] : ['medical_data'],
					declassify_date: null,
				},
			},
		],
	};
}

function extractionResponseWithoutSensitivity(): ExtractionResponse {
	return {
		entities: [
			{
				name: 'Spec Default Person',
				type: 'person',
				confidence: 0.91,
				attributes: {},
				mentions: ['Spec Default Person'],
			},
		],
		relationships: [],
		assertions: [
			{
				content: 'A person attended an event.',
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
				entity_names: ['Spec Default Person'],
			},
		],
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

afterEach(() => {
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

describe('Spec 102: sensitivity tagging and auto-detection', () => {
	it.skipIf(!pgAvailable)('QA-01: migration adds constrained sensitivity fields', async () => {
		for (const table of SENSITIVITY_TABLES) {
			const columns = db.runSql(
				[
					"SELECT column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, '')",
					'FROM information_schema.columns',
					`WHERE table_schema = 'public' AND table_name = ${sqlLiteral(table)}`,
					"  AND column_name IN ('sensitivity_level', 'sensitivity_metadata')",
					'ORDER BY column_name;',
				].join('\n'),
			);
			expect(columns, table).toContain("sensitivity_level:text:NO:'internal'::text");
			expect(columns, table).toContain('sensitivity_metadata:jsonb:NO:');

			const checks = db.runSql(
				[
					"SELECT string_agg(pg_get_constraintdef(oid), E'\\n' ORDER BY conname)",
					'FROM pg_constraint',
					`WHERE conrelid = ${sqlLiteral(table)}::regclass AND contype = 'c';`,
				].join('\n'),
			);
			for (const level of EXPECTED_LEVELS) {
				expect(checks, table).toContain(level);
			}
			for (const key of ['level', 'reason', 'assigned_by', 'assigned_at', 'pii_types', 'declassify_date']) {
				expect(checks, table).toContain(key);
			}
			expect(checks, table).toContain('jsonb_typeof');
		}

		const source = await coreModule.createSource(pool, {
			filename: `spec102-default-${randomUUID()}.txt`,
			storagePath: `raw/spec102-default-${randomUUID()}.txt`,
			fileHash: `spec102-default-${randomUUID()}`,
			sourceType: 'text',
			formatMetadata: { media_type: 'text/plain' },
		});
		expect(source.sensitivityLevel).toBe('internal');
		expect(source.sensitivityMetadata).toMatchObject({
			level: 'internal',
			reason: 'default_policy',
			assignedBy: 'policy_rule',
			piiTypes: [],
			declassifyDate: null,
		});
	});

	it('QA-02: config exposes A5 tagging defaults', () => {
		const minimalConfig = coreModule.loadConfig(
			writeMinimalConfigWithoutAccessControl(),
		) as import('@mulder/core').MulderConfig;
		expect(minimalConfig.access_control.enabled).toBe(true);
		expect(minimalConfig.access_control.sensitivity).toEqual({
			levels: EXPECTED_LEVELS,
			default_level: 'internal',
			auto_detection: true,
			propagation: 'upward',
			pii_types: EXPECTED_PII_TYPES,
		});
	});

	it('QA-03: shared helpers choose the most restrictive level', () => {
		expect(coreModule.mostRestrictiveSensitivityLevel(['public', 'internal', 'restricted', 'confidential'])).toBe(
			'confidential',
		);
		expect(coreModule.mostRestrictiveSensitivityLevel(['public', 'internal', 'restricted'])).toBe('restricted');
		expect(coreModule.mostRestrictiveSensitivityLevel(['public', 'internal'])).toBe('internal');
		expect(coreModule.mostRestrictiveSensitivityLevel(['public'])).toBe('public');

		const merged = coreModule.mergeSensitivityMetadata([
			sensitivityMetadata('internal', { piiTypes: ['person_name'] }),
			sensitivityMetadata('restricted', { piiTypes: ['person_name', 'medical_data'] }),
			sensitivityMetadata('confidential', { piiTypes: ['medical_data', 'financial'] }),
		]);
		expect(merged.level).toBe('confidential');
		expect(merged.piiTypes.sort()).toEqual(['financial', 'medical_data', 'person_name'].sort());
	});

	it.skipIf(!pgAvailable)('QA-04: repository reads and writes round-trip sensitivity', async () => {
		const sourceMetadata = sensitivityMetadata('restricted', { piiTypes: ['contact_info'] });
		const source = await coreModule.createSource(pool, {
			filename: `spec102-repo-${randomUUID()}.txt`,
			storagePath: `raw/spec102-repo-${randomUUID()}.txt`,
			fileHash: `spec102-repo-${randomUUID()}`,
			sourceType: 'text',
			formatMetadata: { media_type: 'text/plain' },
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sourceMetadata,
		});
		const story = await coreModule.createStory(pool, {
			sourceId: source.id,
			title: 'Spec 102 Repository Story',
			gcsMarkdownUri: `segments/${source.id}/repo.md`,
			gcsMetadataUri: `segments/${source.id}/repo.meta.json`,
			sensitivityLevel: 'confidential',
			sensitivityMetadata: sensitivityMetadata('confidential', { piiTypes: ['medical_data'] }),
		});
		const entity = await coreModule.createEntity(pool, {
			name: 'Repository Person',
			type: 'person',
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted', { piiTypes: ['person_name'] }),
		});
		const alias = await coreModule.createEntityAlias(pool, {
			entityId: entity.id,
			alias: 'Repo Alias',
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const storyEntity = await coreModule.linkStoryEntity(pool, {
			storyId: story.id,
			entityId: entity.id,
			confidence: 0.9,
			mentionCount: 1,
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted', { piiTypes: ['person_name'] }),
		});
		const target = await coreModule.createEntity(pool, {
			name: 'Repository Event',
			type: 'event',
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const edge = await coreModule.upsertEdge(pool, {
			sourceEntityId: entity.id,
			targetEntityId: target.id,
			relationship: 'PARTICIPATED_IN',
			storyId: story.id,
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted', { piiTypes: ['location_private'] }),
		});
		const chunk = await coreModule.createChunk(pool, {
			storyId: story.id,
			content: 'Repository chunk',
			chunkIndex: 0,
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const assertion = await coreModule.upsertKnowledgeAssertion(pool, {
			sourceId: source.id,
			storyId: story.id,
			assertionType: 'observation',
			content: 'Repository assertion',
			confidenceMetadata: confidenceMetadata(),
			sensitivityLevel: 'confidential',
			sensitivityMetadata: sensitivityMetadata('confidential', { piiTypes: ['medical_data'] }),
		});

		const foundSource = await coreModule.findSourceById(pool, source.id);
		const foundStory = await coreModule.findStoryById(pool, story.id);
		const foundEntity = await coreModule.findEntityById(pool, entity.id);
		const [foundAlias] = await coreModule.findAliasesByEntityId(pool, entity.id);
		const [foundEdge] = await coreModule.findEdgesByStoryId(pool, story.id);
		const foundChunk = await coreModule.findChunkById(pool, chunk.id);
		const [foundAssertion] = await coreModule.listKnowledgeAssertionsForStory(pool, story.id);

		expect(foundSource?.sensitivityLevel).toBe('restricted');
		expect(foundSource?.sensitivityMetadata.piiTypes).toEqual(['contact_info']);
		expect(foundStory?.sensitivityLevel).toBe('confidential');
		expect(foundEntity?.sensitivityLevel).toBe('restricted');
		expect(foundAlias.sensitivityLevel).toBe(alias.sensitivityLevel);
		expect(storyEntity.sensitivityLevel).toBe('restricted');
		expect(foundEdge.sensitivityLevel).toBe(edge.sensitivityLevel);
		expect(foundChunk?.sensitivityLevel).toBe('internal');
		expect(foundAssertion.id).toBe(assertion.id);
		expect(foundAssertion.sensitivityLevel).toBe('confidential');
	});

	it.skipIf(!pgAvailable)('QA-05: Enrich auto-detection writes child artifact sensitivity', async () => {
		const { story } = await createSegmentedStory('spec102-qa05');
		const result = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: false },
			enrichConfig(true),
			fakeServices(
				story.gcsMarkdownUri,
				extractionResponse({ entity: 'restricted', relationship: 'internal', assertion: 'confidential' }),
			),
			pool,
			logger,
		);

		expect(result.status).toBe('success');
		expect(
			db.runSql(
				['SELECT sensitivity_level', 'FROM entities', "WHERE name = 'Spec Sensitive Person'", 'LIMIT 1;'].join('\n'),
			),
		).toBe('restricted');
		expect(
			db.runSql(
				[
					'SELECT se.sensitivity_level',
					'FROM story_entities se',
					'JOIN entities e ON e.id = se.entity_id',
					`WHERE se.story_id = ${sqlLiteral(story.id)} AND e.name = 'Spec Sensitive Person'`,
					'LIMIT 1;',
				].join('\n'),
			),
		).toBe('restricted');
		expect(
			db.runSql(`SELECT sensitivity_level FROM entity_edges WHERE story_id = ${sqlLiteral(story.id)} LIMIT 1;`),
		).toBe('internal');
		expect(
			db.runSql(`SELECT sensitivity_level FROM knowledge_assertions WHERE story_id = ${sqlLiteral(story.id)} LIMIT 1;`),
		).toBe('confidential');
	});

	it.skipIf(!pgAvailable)('QA-06: upward propagation updates story and source', async () => {
		const { source, story } = await createSegmentedStory('spec102-qa06');
		const result = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: false },
			enrichConfig(true),
			fakeServices(
				story.gcsMarkdownUri,
				extractionResponse({ entity: 'restricted', relationship: 'internal', assertion: 'confidential' }),
			),
			pool,
			logger,
		);
		expect(result.status).toBe('success');

		const foundStory = await coreModule.findStoryById(pool, story.id);
		const foundSource = await coreModule.findSourceById(pool, source.id);
		expect(foundStory?.sensitivityLevel).toBe('confidential');
		expect(foundSource?.sensitivityLevel).toBe('confidential');
		expect(foundStory?.sensitivityMetadata.assignedBy).toBe('policy_rule');
		expect(foundSource?.sensitivityMetadata.assignedBy).toBe('policy_rule');
	});

	it.skipIf(!pgAvailable)('QA-07: disabled auto-detection preserves existing Enrich compatibility', async () => {
		const runtime = pipelineModule.getExtractionResponseSchema(config.ontology, {
			assertionClassificationEnabled: true,
			sensitivityAutoDetectionEnabled: false,
		});
		expect(runtime.safeParse(extractionResponseWithoutSensitivity()).success).toBe(true);

		const { story } = await createSegmentedStory('spec102-qa07');
		const result = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: false },
			enrichConfig(false),
			fakeServices(story.gcsMarkdownUri, extractionResponseWithoutSensitivity()),
			pool,
			logger,
		);
		expect(result.status).toBe('success');
		expect(
			db.runSql(
				['SELECT sensitivity_level', 'FROM entities', "WHERE name = 'Spec Default Person'", 'LIMIT 1;'].join('\n'),
			),
		).toBe('internal');
		expect(
			db.runSql(`SELECT sensitivity_level FROM knowledge_assertions WHERE story_id = ${sqlLiteral(story.id)} LIMIT 1;`),
		).toBe('internal');
	});

	it.skipIf(!pgAvailable)('QA-08: force reruns do not leave stale higher sensitivity', async () => {
		const { source, story } = await createSegmentedStory('spec102-qa08');
		const first = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: false },
			enrichConfig(true),
			fakeServices(
				story.gcsMarkdownUri,
				extractionResponse({ entity: 'restricted', relationship: 'internal', assertion: 'confidential' }),
			),
			pool,
			logger,
		);
		expect(first.status).toBe('success');

		const second = await pipelineModule.executeEnrich(
			{ storyId: story.id, force: true },
			enrichConfig(true),
			fakeServices(
				story.gcsMarkdownUri,
				extractionResponse({ entity: 'internal', relationship: 'internal', assertion: 'internal' }),
			),
			pool,
			logger,
		);
		expect(second.status).toBe('success');

		const staleActiveArtifacts = Number(
			db.runSql(
				[
					'SELECT COUNT(*)',
					'FROM (',
					`  SELECT se.sensitivity_level FROM story_entities se WHERE se.story_id = ${sqlLiteral(story.id)}`,
					'  UNION ALL',
					`  SELECT ee.sensitivity_level FROM entity_edges ee WHERE ee.story_id = ${sqlLiteral(story.id)}`,
					'  UNION ALL',
					`  SELECT ka.sensitivity_level FROM knowledge_assertions ka WHERE ka.story_id = ${sqlLiteral(story.id)}`,
					') artifacts',
					"WHERE sensitivity_level = 'confidential';",
				].join('\n'),
			),
		);
		expect(staleActiveArtifacts).toBe(0);
		expect((await coreModule.findStoryById(pool, story.id))?.sensitivityLevel).toBe('internal');
		expect((await coreModule.findSourceById(pool, source.id))?.sensitivityLevel).toBe('internal');
	});

	it('CLI-01: mulder config validate accepts minimal config without access_control', () => {
		const result = runCli(['config', 'validate', writeMinimalConfigWithoutAccessControl()]);
		expect(result.exitCode, combinedOutput(result)).toBe(0);
	});

	it('CLI-02: mulder config show includes resolved sensitivity defaults', () => {
		const result = runCli(['config', 'show', writeMinimalConfigWithoutAccessControl(), '--format', 'json']);
		expect(result.exitCode, combinedOutput(result)).toBe(0);
		const shown = JSON.parse(result.stdout) as import('@mulder/core').MulderConfig;
		expect(shown.access_control.sensitivity).toEqual({
			levels: EXPECTED_LEVELS,
			default_level: 'internal',
			auto_detection: true,
			propagation: 'upward',
			pii_types: EXPECTED_PII_TYPES,
		});
	});

	it.skipIf(!pgAvailable)('CLI-03: mulder enrich <source-id> writes sensitivity metadata', async () => {
		const { source } = await createSegmentedStory('spec102-cli03');
		const result = runCli(['enrich', source.id], { timeout: 120_000 });
		expect(result.exitCode, combinedOutput(result)).toBe(0);
		expect(
			Number(
				db.runSql(
					[
						'SELECT COUNT(*)',
						'FROM story_entities se',
						'JOIN stories s ON s.id = se.story_id',
						`WHERE s.source_id = ${sqlLiteral(source.id)}`,
						'  AND se.sensitivity_level IS NOT NULL',
						"  AND se.sensitivity_metadata ? 'level';",
					].join('\n'),
				),
			),
		).toBeGreaterThanOrEqual(1);
	});

	it.skipIf(!pgAvailable)('CLI-04: mulder enrich --force <source-id> refreshes propagated sensitivity', async () => {
		const { source } = await createSegmentedStory('spec102-cli04');
		const first = runCli(['enrich', source.id], { timeout: 120_000 });
		expect(first.exitCode, combinedOutput(first)).toBe(0);
		const second = runCli(['enrich', '--force', source.id], { timeout: 120_000 });
		expect(second.exitCode, combinedOutput(second)).toBe(0);
		const sourceSensitivity = db.runSql(
			`SELECT sensitivity_level FROM sources WHERE id = ${sqlLiteral(source.id)} AND sensitivity_metadata ? 'level';`,
		);
		expect(EXPECTED_LEVELS).toContain(sourceSensitivity);
	});
});
