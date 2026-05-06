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

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

const pgAvailable = db.isPgAvailable();
let pool: pg.Pool;
let tempDir: string | null = null;
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

function writeMinimalConfigWithoutContradictionManagement(): string {
	if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec108-'));
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec108"',
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
			'',
		].join('\n'),
		'utf-8',
	);
	return configPath;
}

function cleanTables(): void {
	truncateExistingTables(['conflict_resolutions', 'conflict_assertions', 'conflict_nodes', ...MULDER_TEST_TABLES]);
}

async function createTextSource(label = 'spec108') {
	return coreModule.createSource(pool, {
		filename: `${label}-${randomUUID()}.md`,
		storagePath: `raw/${label}-${randomUUID()}.md`,
		fileHash: `${label}-${randomUUID()}`,
		sourceType: 'text',
		formatMetadata: { media_type: 'text/markdown' },
		pageCount: 1,
		hasNativeText: true,
		nativeTextRatio: 1,
	});
}

async function createSegmentedStory(label = 'spec108') {
	const source = await createTextSource(label);
	await coreModule.updateSourceStatus(pool, source.id, 'segmented');
	const story = await coreModule.createStory(pool, {
		sourceId: source.id,
		title: `Spec 108 Story ${label}`,
		gcsMarkdownUri: `segments/${source.id}/story.md`,
		gcsMetadataUri: `segments/${source.id}/story.meta.json`,
		extractionConfidence: 0.94,
	});
	const storageRoot = process.env.MULDER_TEST_STORAGE_ROOT
		? resolve(process.env.MULDER_TEST_STORAGE_ROOT)
		: resolve(ROOT, '.local/storage');
	const localMarkdownPath = resolve(storageRoot, story.gcsMarkdownUri);
	mkdirSync(dirname(localMarkdownPath), { recursive: true });
	writeFileSync(localMarkdownPath, '# Spec 108 Story\n\nA witness observed a silent object.', 'utf-8');
	await coreModule.updateStoryStatus(pool, story.id, 'segmented');
	return { source, story };
}

async function createSharedEntity(name = `Spec 108 Entity ${randomUUID()}`) {
	return coreModule.upsertEntityByNameType(pool, {
		name,
		type: 'person',
		attributes: {},
		provenance: { sourceDocumentIds: [] },
	});
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

async function createAssertionFixture(label: string, claim: string, entityId: string, sensitivityLevel = 'internal') {
	const { source, story } = await createSegmentedStory(label);
	const assertion = await coreModule.upsertKnowledgeAssertion(pool, {
		sourceId: source.id,
		storyId: story.id,
		assertionType: 'observation',
		content: claim,
		confidenceMetadata: confidenceMetadata(),
		extractedEntityIds: [entityId],
		provenance: { sourceDocumentIds: [source.id] },
		sensitivityLevel: sensitivityLevel as import('@mulder/core').SensitivityLevel,
		sensitivityMetadata: {
			level: sensitivityLevel,
			reason: 'fixture',
			assignedBy: 'llm_auto',
			assignedAt: '2026-05-06T00:00:00.000Z',
			piiTypes: [],
			declassifyDate: null,
		},
	});
	return { source, story, assertion };
}

function extractionResponse(entityName: string, claim: string): import('@mulder/pipeline').ExtractionResponse {
	return {
		entities: [
			{
				name: entityName,
				type: 'person',
				confidence: 0.91,
				attributes: {},
				mentions: [entityName],
				sensitivity: {
					level: 'restricted',
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
				content: claim,
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
				entity_names: [entityName],
				sensitivity: {
					level: 'restricted',
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

function conflictResponse(confidence = 0.91) {
	return {
		is_conflict: true,
		conflict_type: 'factual',
		severity: 'significant',
		severity_rationale: 'The claims disagree on an essential observed property.',
		confidence,
		claim_a: 'A witness observed a loud object.',
		claim_b: 'A witness observed a silent object.',
	};
}

function resolveResponse(verdict: 'confirmed' | 'dismissed' = 'confirmed') {
	return {
		verdict,
		winning_claim: 'neither',
		confidence: 0.86,
		explanation: 'The two story assertions describe incompatible sound attributes.',
		conflict_type: 'attributive',
		severity: 'significant',
		severity_rationale: 'The disputed sound attribute changes interpretation of the event.',
		resolution_type: verdict === 'confirmed' ? 'genuinely_contradictory' : 'duplicate_misidentification',
		evidence_refs: ['fixture:edge'],
	};
}

function fakeServices(
	storyUri: string,
	structuredResponses: unknown[],
	options?: { markdown?: string },
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
				if (storyUri && path !== storyUri) throw new Error(`unexpected storage download: ${path}`);
				return Buffer.from(options?.markdown ?? '# Spec 108 Story\n\nA witness observed a loud object.', 'utf-8');
			},
			getMetadata: async () => ({ sizeBytes: 42, contentType: 'text/markdown' }),
			exists: async () => true,
			list: async () => ({ paths: [] }),
			delete: async () => undefined,
		},
		firestore: { setDocument: async () => undefined, getDocument: async () => null },
		documentAi: {
			processDocument: async () => {
				throw new Error('documentAi should not be called');
			},
		},
		officeDocuments: {
			extractDocx: async () => {
				throw new Error('docx should not be called');
			},
		},
		spreadsheets: {
			extractSpreadsheet: async () => {
				throw new Error('spreadsheet should not be called');
			},
		},
		emails: {
			extractEmail: async () => {
				throw new Error('email should not be called');
			},
		},
		urls: {
			fetchUrl: async () => {
				throw new Error('url fetch should not be called');
			},
		},
		urlRenderers: {
			renderUrl: async () => {
				throw new Error('url render should not be called');
			},
		},
		urlExtractors: {
			extractUrl: async () => {
				throw new Error('url extraction should not be called');
			},
		},
		llm: {
			countTokens: async () => 32,
			generateText: async () => {
				throw new Error('generateText should not be called');
			},
			groundedGenerate: async () => {
				throw new Error('groundedGenerate should not be called');
			},
			generateStructured: async (llmOptions: import('@mulder/core').StructuredGenerateOptions) => {
				if (structuredCalls >= structuredResponses.length) throw new Error('unexpected structured LLM call');
				const response = structuredResponses[structuredCalls];
				structuredCalls++;
				return llmOptions.responseValidator ? llmOptions.responseValidator(response) : response;
			},
		},
		embedding: {
			embed: async () => {
				throw new Error('embedding should not be called');
			},
		},
		structuredCallCount: () => structuredCalls,
	};
	return services as unknown as import('@mulder/core').Services & { structuredCallCount: () => number };
}

function enrichConfig(overrides?: Partial<import('@mulder/core').MulderConfig>): import('@mulder/core').MulderConfig {
	return {
		...config,
		...overrides,
		credibility: { ...config.credibility, enabled: false },
		entity_resolution: {
			...config.entity_resolution,
			strategies: config.entity_resolution.strategies.map((strategy) => ({ ...strategy, enabled: false })),
		},
		contradiction_management: {
			...config.contradiction_management,
			...(overrides?.contradiction_management ?? {}),
			detection: {
				...config.contradiction_management.detection,
				...(overrides?.contradiction_management?.detection ?? {}),
			},
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
	if (pgAvailable) cleanTables();
	await pool?.end();
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('Spec 108: conflict node management', () => {
	it.skipIf(!pgAvailable)('QA-01: conflict schema is constrained and reset-safe', async () => {
		const tables = db.runSql(
			[
				'SELECT table_name',
				'FROM information_schema.tables',
				"WHERE table_schema = 'public'",
				"  AND table_name IN ('conflict_nodes', 'conflict_assertions', 'conflict_resolutions')",
				'ORDER BY table_name;',
			].join('\n'),
		);
		expect(tables).toContain('conflict_nodes');
		expect(tables).toContain('conflict_assertions');
		expect(tables).toContain('conflict_resolutions');

		const checks = db.runSql(
			[
				"SELECT string_agg(pg_get_constraintdef(oid), E'\\n' ORDER BY conname)",
				'FROM pg_constraint',
				"WHERE conrelid IN ('conflict_nodes'::regclass, 'conflict_resolutions'::regclass)",
				"  AND contype IN ('c', 'u');",
			].join('\n'),
		);
		for (const value of ['factual', 'interpretive', 'taxonomic', 'temporal', 'spatial', 'attributive']) {
			expect(checks).toContain(value);
		}
		for (const value of ['minor', 'significant', 'fundamental', 'genuinely_contradictory', 'different_time']) {
			expect(checks).toContain(value);
		}

		const indexes = db.runSql(
			[
				'SELECT indexname',
				'FROM pg_indexes',
				"WHERE schemaname = 'public'",
				"  AND indexname IN ('idx_conflict_nodes_open', 'idx_conflict_nodes_active_pair_type', 'idx_conflict_assertions_assertion_id')",
				'ORDER BY indexname;',
			].join('\n'),
		);
		expect(indexes).toContain('idx_conflict_nodes_open');
		expect(indexes).toContain('idx_conflict_nodes_active_pair_type');
		expect(indexes).toContain('idx_conflict_assertions_assertion_id');

		const entity = await createSharedEntity();
		const left = await createAssertionFixture('qa01-a', 'A witness observed a silent object.', entity.id);
		const right = await createAssertionFixture('qa01-b', 'A witness observed a loud object.', entity.id);
		await coreModule.createConflictNode(pool, {
			conflictType: 'factual',
			detectionMethod: 'llm_auto',
			detectedBy: 'test',
			severity: 'significant',
			severityRationale: 'fixture',
			confidence: 0.9,
			assertions: [{ assertionId: left.assertion.id }, { assertionId: right.assertion.id }],
		});
		await coreModule.resetPipelineStep(pool, left.source.id, 'enrich');
		expect(Number(db.runSql('SELECT COUNT(*) FROM conflict_nodes;'))).toBe(0);
	});

	it('QA-02: config exposes A9 defaults', () => {
		const minimalConfig = coreModule.loadConfig(
			writeMinimalConfigWithoutContradictionManagement(),
		) as import('@mulder/core').MulderConfig;
		expect(minimalConfig.contradiction_management.enabled).toBe(true);
		expect(minimalConfig.contradiction_management.conflict_types).toEqual([
			'factual',
			'interpretive',
			'taxonomic',
			'temporal',
			'spatial',
			'attributive',
		]);
		expect(minimalConfig.contradiction_management.severity_levels).toEqual(['minor', 'significant', 'fundamental']);
		expect(minimalConfig.contradiction_management.detection.pipeline).toBe(true);
		expect(minimalConfig.contradiction_management.detection.agent).toBe(false);
		expect(minimalConfig.contradiction_management.detection.human_reported).toBe(false);
		expect(minimalConfig.contradiction_management.detection.embedding_similarity_band).toEqual([0.3, 0.8]);
		expect(minimalConfig.contradiction_management.detection.require_shared_entity).toBe(true);
		expect(minimalConfig.contradiction_management.detection.llm_confirmation).toBe(true);
		expect(minimalConfig.contradiction_management.detection.min_confidence).toBe(0.7);
		expect(minimalConfig.contradiction_management.detection.max_candidates_per_story).toBe(25);
		expect(minimalConfig.contradiction_management.review).toEqual({
			conflict_detection: 'single_review',
			resolution: 'single_review',
		});
		expect(minimalConfig.contradiction_management.metrics.feed_credibility_profiles).toBe(true);
	});

	it.skipIf(!pgAvailable)('QA-03: repository creates idempotent conflict nodes', async () => {
		const entity = await createSharedEntity();
		const left = await createAssertionFixture('qa03-a', 'A witness observed a silent object.', entity.id);
		const right = await createAssertionFixture('qa03-b', 'A witness observed a loud object.', entity.id, 'restricted');
		const input = {
			conflictType: 'factual' as const,
			detectionMethod: 'llm_auto' as const,
			detectedBy: 'test',
			severity: 'significant' as const,
			severityRationale: 'The claims disagree on sound.',
			confidence: 0.91,
			assertions: [
				{ assertionId: left.assertion.id, participantRole: 'claim_a' as const, claim: left.assertion.content },
				{ assertionId: right.assertion.id, participantRole: 'claim_b' as const, claim: right.assertion.content },
			],
		};
		const first = await coreModule.createConflictNode(pool, input);
		const second = await coreModule.createConflictNode(pool, input);

		expect(second.id).toBe(first.id);
		expect(second.assertions).toHaveLength(2);
		expect(second.assertions.map((assertion) => assertion.claim).sort()).toEqual(
			[left.assertion.content, right.assertion.content].sort(),
		);
		expect(second.severity).toBe('significant');
		expect(second.detectionMethod).toBe('llm_auto');
		expect(second.sensitivityLevel).toBe('restricted');
		expect(Number(db.runSql('SELECT COUNT(*) FROM conflict_nodes;'))).toBe(1);
	});

	it.skipIf(!pgAvailable)('QA-04: repository stores typed resolutions', async () => {
		const entity = await createSharedEntity();
		const left = await createAssertionFixture('qa04-a', 'A witness observed a silent object.', entity.id);
		const right = await createAssertionFixture('qa04-b', 'A witness observed a loud object.', entity.id);
		const conflict = await coreModule.createConflictNode(pool, {
			conflictType: 'factual',
			detectionMethod: 'llm_auto',
			detectedBy: 'test',
			severity: 'significant',
			severityRationale: 'fixture',
			confidence: 0.9,
			assertions: [{ assertionId: left.assertion.id }, { assertionId: right.assertion.id }],
		});
		const resolved = await coreModule.resolveConflictNode(pool, {
			conflictId: conflict.id,
			resolutionType: 'different_time',
			explanation: 'The reports refer to different points in time.',
			resolvedBy: 'reviewer',
			evidenceRefs: ['story:a', 'story:b'],
			reviewStatus: 'pending',
		});

		expect(resolved.resolutionStatus).toBe('explained');
		expect(resolved.latestResolution?.resolutionType).toBe('different_time');
		expect(resolved.latestResolution?.explanation).toContain('different points');
		expect(resolved.latestResolution?.resolvedBy).toBe('reviewer');
		expect(resolved.latestResolution?.evidenceRefs).toEqual(['story:a', 'story:b']);
		expect(resolved.latestResolution?.reviewStatus).toBe('pending');
	});

	it.skipIf(!pgAvailable)('QA-05: Enrich creates open conflict nodes from contradictory assertions', async () => {
		const entityName = `Spec 108 Shared ${randomUUID()}`;
		const entity = await createSharedEntity(entityName);
		await createAssertionFixture('qa05-existing', 'A witness observed a silent object.', entity.id);
		const { story } = await createSegmentedStory('qa05-new');

		const result = await pipelineModule.executeEnrich(
			{ storyId: story.id },
			enrichConfig(),
			fakeServices(story.gcsMarkdownUri, [
				extractionResponse(entityName, 'A witness observed a loud object.'),
				conflictResponse(0.91),
			]),
			pool,
			logger,
		);
		const conflicts = await coreModule.listOpenConflictNodes(pool);

		expect(result.status).toBe('success');
		expect(result.data?.conflictCandidatesExamined).toBe(1);
		expect(result.data?.conflictsCreated).toBe(1);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].assertions).toHaveLength(2);
		expect(conflicts[0].severity).toBe('significant');
		expect(conflicts[0].severityRationale).toContain('essential observed property');
		expect(conflicts[0].sensitivityLevel).toBe('restricted');
	});

	it.skipIf(!pgAvailable)('QA-06: Enrich skips disabled or low-confidence detection', async () => {
		const entityName = `Spec 108 Shared ${randomUUID()}`;
		const entity = await createSharedEntity(entityName);
		await createAssertionFixture('qa06-existing', 'A witness observed a silent object.', entity.id);
		const disabled = await createSegmentedStory('qa06-disabled');
		const disabledResult = await pipelineModule.executeEnrich(
			{ storyId: disabled.story.id },
			enrichConfig({ contradiction_management: { ...config.contradiction_management, enabled: false } }),
			fakeServices(disabled.story.gcsMarkdownUri, [
				extractionResponse(entityName, 'A witness observed a loud object.'),
			]),
			pool,
			logger,
		);
		expect(disabledResult.data?.conflictsCreated).toBe(0);
		expect(disabledResult.data?.conflictDetectionsSkipped).toBe(1);

		cleanTables();
		const entityAgain = await createSharedEntity(entityName);
		await createAssertionFixture('qa06-existing-low', 'A witness observed a silent object.', entityAgain.id);
		const low = await createSegmentedStory('qa06-low');
		const lowResult = await pipelineModule.executeEnrich(
			{ storyId: low.story.id },
			enrichConfig(),
			fakeServices(low.story.gcsMarkdownUri, [
				extractionResponse(entityName, 'A witness observed a loud object.'),
				conflictResponse(0.4),
			]),
			pool,
			logger,
		);
		expect(lowResult.data?.conflictCandidatesExamined).toBe(1);
		expect(lowResult.data?.conflictsCreated).toBe(0);
		expect(Number(db.runSql('SELECT COUNT(*) FROM conflict_nodes;'))).toBe(0);
	});

	it.skipIf(!pgAvailable)('QA-07: Analyze promotes legacy contradiction resolutions', async () => {
		const entity = await createSharedEntity();
		const left = await createAssertionFixture('qa07-a', 'The object was silent.', entity.id);
		const right = await createAssertionFixture('qa07-b', 'The object produced a loud hum.', entity.id);
		const edge = await coreModule.createEdge(pool, {
			sourceEntityId: entity.id,
			targetEntityId: entity.id,
			relationship: 'contradicts',
			edgeType: 'POTENTIAL_CONTRADICTION',
			storyId: left.story.id,
			confidence: 0.5,
			attributes: {
				attribute: 'sound',
				valueA: 'silent',
				valueB: 'loud hum',
				storyIdA: left.story.id,
				storyIdB: right.story.id,
			},
		});
		const result = await pipelineModule.executeAnalyze(
			{ contradictions: true },
			{ ...config, analysis: { ...config.analysis, enabled: true, contradictions: true } },
			fakeServices('', [resolveResponse('confirmed')]),
			pool,
			logger,
		);
		const promoted = await coreModule.findConflictNodeByLegacyEdgeId(pool, edge.id);
		const updatedEdge = await coreModule.findEdgeById(pool, edge.id);

		expect(result.status).toBe('success');
		expect(result.data.mode).toBe('contradictions');
		if (result.data.mode === 'contradictions') {
			expect(result.data.conflictNodesLinked).toBe(1);
			expect(result.data.conflictResolutionsWritten).toBe(1);
		}
		expect(updatedEdge?.edgeType).toBe('CONFIRMED_CONTRADICTION');
		expect(updatedEdge?.analysis?.explanation).toContain('incompatible sound');
		expect(promoted?.resolutionStatus).toBe('confirmed_contradictory');
		expect(promoted?.latestResolution?.resolutionType).toBe('genuinely_contradictory');
	});

	it.skipIf(!pgAvailable)('QA-08: conflict involvement is observable for credibility consumers', async () => {
		const entity = await createSharedEntity();
		const left = await createAssertionFixture('qa08-a', 'A witness observed a silent object.', entity.id);
		const right = await createAssertionFixture('qa08-b', 'A witness observed a loud object.', entity.id);
		const conflict = await coreModule.createConflictNode(pool, {
			conflictType: 'factual',
			detectionMethod: 'llm_auto',
			detectedBy: 'test',
			severity: 'significant',
			severityRationale: 'fixture',
			confidence: 0.9,
			assertions: [{ assertionId: left.assertion.id }, { assertionId: right.assertion.id }],
		});
		let involvement = await coreModule.listConflictInvolvementBySource(pool);
		expect(involvement.find((entry) => entry.sourceDocumentId === left.source.id)).toMatchObject({
			totalCount: 1,
			openCount: 1,
			resolvedCount: 0,
		});

		await coreModule.resolveConflictNode(pool, {
			conflictId: conflict.id,
			resolutionType: 'source_unreliable',
			explanation: 'One source was unreliable.',
			resolvedBy: 'reviewer',
		});
		involvement = await coreModule.listConflictInvolvementBySource(pool);
		expect(involvement.find((entry) => entry.sourceDocumentId === right.source.id)).toMatchObject({
			totalCount: 1,
			openCount: 0,
			resolvedCount: 1,
		});
	});
});
