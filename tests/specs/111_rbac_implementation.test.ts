import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, MULDER_TEST_TABLES, truncateExistingTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const API_DIR = resolve(ROOT, 'apps/api');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const API_DOCUMENTS_DIST = resolve(API_DIR, 'dist/lib/documents.js');
const API_ENTITIES_DIST = resolve(API_DIR, 'dist/lib/entities.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

type ApiDocumentsModule = {
	resetDocumentContextForTests(): void;
	listDocuments(
		input: { limit: number; offset: number },
		logger: import('@mulder/core').Logger,
		options: { authPrincipal: TestAuthPrincipal },
	): Promise<{ data: Array<{ id: string }> }>;
};

type TestAuthPrincipal =
	| { type: 'session'; userId: string; email: string; role: 'member' | 'admin' | 'owner' }
	| { type: 'api_key'; keyName: string };

type ApiEntitiesModule = {
	resetEntityContextForTests(): void;
	getEntityDetail(
		id: string,
		logger: import('@mulder/core').Logger,
		options: { authPrincipal: TestAuthPrincipal },
	): Promise<{ data: { aliases: Array<{ alias: string }> } }>;
};

const pgAvailable = db.isPgAvailable();
let pool: pg.Pool;
let tempDir: string | null = null;
let previousConfigPath: string | undefined;
let coreModule: typeof import('@mulder/core');
let apiDocumentsModule: ApiDocumentsModule;
let apiEntitiesModule: ApiEntitiesModule;

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

function writeMinimalConfig(label = 'spec111'): string {
	if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec111-'));
	const configPath = join(tempDir, `${label}-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			`  name: "${label}"`,
			'  supported_locales: ["en"]',
			'dev_mode: true',
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
	truncateExistingTables([
		'translated_documents',
		'review_events',
		'review_artifacts',
		'conflict_resolutions',
		'conflict_assertions',
		'conflict_nodes',
		'knowledge_assertions',
		...MULDER_TEST_TABLES,
	]);
}

function sensitivityMetadata(level: import('@mulder/core').SensitivityLevel) {
	return {
		level,
		reason: 'spec111_fixture',
		assignedBy: 'policy_rule' as const,
		assignedAt: '2026-05-07T00:00:00.000Z',
		piiTypes: [],
		declassifyDate: null,
	};
}

async function createSourceFixture(level: import('@mulder/core').SensitivityLevel, label: string = level) {
	const source = await coreModule.createSource(pool, {
		filename: `${label}-${randomUUID()}.md`,
		storagePath: `raw/${label}-${randomUUID()}.md`,
		fileHash: `${label}-${randomUUID()}`,
		sourceType: 'text',
		formatMetadata: { media_type: 'text/markdown' },
		pageCount: 1,
		hasNativeText: true,
		nativeTextRatio: 1,
		sensitivityLevel: level,
		sensitivityMetadata: sensitivityMetadata(level),
	});
	const story = await coreModule.createStory(pool, {
		sourceId: source.id,
		title: `Story ${label}`,
		gcsMarkdownUri: `segments/${source.id}/story.md`,
		gcsMetadataUri: `segments/${source.id}/story.meta.json`,
		extractionConfidence: 0.95,
		sensitivityLevel: level,
		sensitivityMetadata: sensitivityMetadata(level),
	});
	const entity = await coreModule.upsertEntityByNameType(pool, {
		name: `Entity ${label} ${randomUUID()}`,
		type: 'person',
		attributes: {},
		provenance: { sourceDocumentIds: [source.id] },
		sensitivityLevel: level,
		sensitivityMetadata: sensitivityMetadata(level),
	});
	await coreModule.linkStoryEntity(pool, {
		storyId: story.id,
		entityId: entity.id,
		mentionCount: 1,
		provenance: { sourceDocumentIds: [source.id] },
		sensitivityLevel: level,
		sensitivityMetadata: sensitivityMetadata(level),
	});
	return { source, story, entity };
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

async function createAssertion(sourceId: string, storyId: string, level: import('@mulder/core').SensitivityLevel) {
	return await coreModule.upsertKnowledgeAssertion(pool, {
		sourceId,
		storyId,
		assertionType: 'observation',
		content: `Assertion ${level} ${randomUUID()}`,
		confidenceMetadata: confidenceMetadata(),
		extractedEntityIds: [],
		provenance: { sourceDocumentIds: [sourceId] },
		sensitivityLevel: level,
		sensitivityMetadata: sensitivityMetadata(level),
	});
}

beforeAll(async () => {
	buildPackage(CORE_DIR);
	buildPackage(CLI_DIR);
	buildPackage(API_DIR);
	coreModule = await import(pathToFileURL(CORE_DIST).href);
	apiDocumentsModule = (await import(pathToFileURL(API_DOCUMENTS_DIST).href)) as ApiDocumentsModule;
	apiEntitiesModule = (await import(pathToFileURL(API_ENTITIES_DIST).href)) as ApiEntitiesModule;

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
	await pool?.end();
	await coreModule?.closeAllPools();
	if (previousConfigPath === undefined) {
		delete process.env.MULDER_CONFIG;
	} else {
		process.env.MULDER_CONFIG = previousConfigPath;
	}
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('Spec 111: RBAC implementation', () => {
	it('QA-01: role schema and defaults are self-contained', () => {
		const minimalConfig = coreModule.loadConfig(writeMinimalConfig('minimal'));
		const exampleConfig = coreModule.loadConfig(EXAMPLE_CONFIG);

		for (const config of [minimalConfig, exampleConfig]) {
			expect(config.access_control.rbac.roles.map((role) => role.id).sort()).toEqual(['admin', 'analyst', 'reviewer']);
			expect(config.access_control.rbac.roles.find((role) => role.id === 'analyst')).toMatchObject({
				max_sensitivity_level: 'internal',
				permissions: ['read'],
			});
			expect(config.access_control.rbac.roles.find((role) => role.id === 'admin')?.permissions).toContain('admin');
		}
	});

	it('QA-02: access helpers enforce the sensitivity lattice', () => {
		const config = coreModule.loadConfig(writeMinimalConfig('helpers'));
		const analyst = coreModule.resolveAccessPolicy(config, { kind: 'browser_session', browserRole: 'member' });
		const admin = coreModule.resolveAccessPolicy(config, { kind: 'browser_session', browserRole: 'admin' });
		const sensitivityLevels: import('@mulder/core').SensitivityLevel[] = [
			'public',
			'internal',
			'restricted',
			'confidential',
		];

		expect(coreModule.allowedSensitivityLevelsForMax('internal')).toEqual(['public', 'internal']);
		expect(sensitivityLevels.map((level) => coreModule.canReadSensitivityLevel(analyst, level))).toEqual([
			true,
			true,
			false,
			false,
		]);
		expect(sensitivityLevels.map((level) => coreModule.canReadSensitivityLevel(admin, level))).toEqual([
			true,
			true,
			true,
			true,
		]);
	});

	it.skipIf(!pgAvailable)('QA-03: roles persist and round-trip', async () => {
		await pool.query("DELETE FROM access_roles WHERE id NOT IN ('analyst', 'reviewer', 'admin')");
		const defaultRoles = await coreModule.listAccessRoles(pool);
		expect(defaultRoles.map((role) => role.id).sort()).toEqual(['admin', 'analyst', 'reviewer']);

		const custom = await coreModule.upsertAccessRole(pool, {
			id: 'field_reviewer',
			name: 'Field reviewer',
			maxSensitivityLevel: 'restricted',
			permissions: ['read', 'review'],
		});
		expect(await coreModule.findAccessRoleById(pool, custom.id)).toMatchObject({
			id: 'field_reviewer',
			name: 'Field reviewer',
			maxSensitivityLevel: 'restricted',
			permissions: ['read', 'review'],
		});
	});

	it.skipIf(!pgAvailable)('QA-04: repository filters hide over-sensitive artifacts', async () => {
		const publicFixture = await createSourceFixture('public');
		const internalFixture = await createSourceFixture('internal');
		const restrictedFixture = await createSourceFixture('restricted');
		const confidentialFixture = await createSourceFixture('confidential');
		const assertionA = await createAssertion(internalFixture.source.id, internalFixture.story.id, 'internal');
		const assertionB = await createAssertion(restrictedFixture.source.id, restrictedFixture.story.id, 'restricted');
		await coreModule.createConflictNode(pool, {
			conflictType: 'factual',
			detectionMethod: 'human_reported',
			detectedBy: 'spec111',
			severity: 'significant',
			severityRationale: 'Fixture conflict',
			confidence: 0.8,
			assertions: [
				{ assertionId: assertionA.id, participantRole: 'claim_a', claim: assertionA.content },
				{ assertionId: assertionB.id, participantRole: 'claim_b', claim: assertionB.content },
			],
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		await coreModule.upsertReviewableArtifact(pool, {
			artifactType: 'assertion_classification',
			subjectId: assertionA.id,
			subjectTable: 'knowledge_assertions',
			currentValue: { assertion_type: 'observation' },
			context: { sensitivity_level: 'internal' },
		});
		await coreModule.upsertReviewableArtifact(pool, {
			artifactType: 'assertion_classification',
			subjectId: assertionB.id,
			subjectTable: 'knowledge_assertions',
			currentValue: { assertion_type: 'observation' },
			context: { sensitivity_level: 'restricted' },
		});
		await coreModule.createCurrentTranslatedDocument(pool, {
			sourceDocumentId: internalFixture.source.id,
			sourceLanguage: 'de',
			targetLanguage: 'en',
			translationEngine: 'fixture',
			content: 'Internal translation',
			contentHash: randomUUID(),
			pipelinePath: 'translation_only',
			outputFormat: 'markdown',
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		await coreModule.createCurrentTranslatedDocument(pool, {
			sourceDocumentId: internalFixture.source.id,
			sourceLanguage: 'de',
			targetLanguage: 'fr',
			translationEngine: 'fixture',
			content: 'Restricted translation',
			contentHash: randomUUID(),
			pipelinePath: 'translation_only',
			outputFormat: 'markdown',
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		const restrictedEntityOnInternalStory = await coreModule.upsertEntityByNameType(pool, {
			name: `Restricted mixed entity ${randomUUID()}`,
			type: 'person',
			attributes: {},
			provenance: { sourceDocumentIds: [internalFixture.source.id] },
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		await coreModule.linkStoryEntity(pool, {
			storyId: internalFixture.story.id,
			entityId: restrictedEntityOnInternalStory.id,
			mentionCount: 1,
			provenance: { sourceDocumentIds: [internalFixture.source.id] },
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const restrictedStoryForInternalEntity = await coreModule.createStory(pool, {
			sourceId: internalFixture.source.id,
			title: `Restricted mixed story ${randomUUID()}`,
			gcsMarkdownUri: `segments/${internalFixture.source.id}/restricted-story.md`,
			gcsMetadataUri: `segments/${internalFixture.source.id}/restricted-story.meta.json`,
			extractionConfidence: 0.95,
			sensitivityLevel: 'restricted',
			sensitivityMetadata: sensitivityMetadata('restricted'),
		});
		await coreModule.linkStoryEntity(pool, {
			storyId: restrictedStoryForInternalEntity.id,
			entityId: internalFixture.entity.id,
			mentionCount: 1,
			provenance: { sourceDocumentIds: [internalFixture.source.id] },
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const hiddenEdgeChunk = await coreModule.createChunk(pool, {
			storyId: publicFixture.story.id,
			content: 'Hidden edge provenance graph chunk',
			chunkIndex: 0,
			sensitivityLevel: 'public',
			sensitivityMetadata: sensitivityMetadata('public'),
		});
		const hiddenLinkEntity = await coreModule.upsertEntityByNameType(pool, {
			name: `Hidden link entity ${randomUUID()}`,
			type: 'person',
			attributes: {},
			provenance: { sourceDocumentIds: [internalFixture.source.id] },
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const hiddenLinkStory = await coreModule.createStory(pool, {
			sourceId: internalFixture.source.id,
			title: `Hidden link story ${randomUUID()}`,
			gcsMarkdownUri: `segments/${internalFixture.source.id}/hidden-link-story.md`,
			gcsMetadataUri: `segments/${internalFixture.source.id}/hidden-link-story.meta.json`,
			extractionConfidence: 0.95,
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const hiddenLinkChunk = await coreModule.createChunk(pool, {
			storyId: hiddenLinkStory.id,
			content: 'Hidden story-entity provenance graph chunk',
			chunkIndex: 0,
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		await coreModule.linkStoryEntity(pool, {
			storyId: hiddenLinkStory.id,
			entityId: hiddenLinkEntity.id,
			mentionCount: 1,
			provenance: { sourceDocumentIds: [restrictedFixture.source.id] },
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		const visibleEdgeCountBeforeGraphFixtures = await coreModule.countEdges(pool, {
			maxSensitivityLevel: 'internal',
		});
		await coreModule.createEdge(pool, {
			sourceEntityId: internalFixture.entity.id,
			targetEntityId: restrictedFixture.entity.id,
			relationship: 'hidden_endpoint_fixture',
			provenance: { sourceDocumentIds: [internalFixture.source.id] },
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		await coreModule.createEdge(pool, {
			sourceEntityId: internalFixture.entity.id,
			targetEntityId: hiddenLinkEntity.id,
			relationship: 'hidden_story_entity_provenance_fixture',
			provenance: { sourceDocumentIds: [internalFixture.source.id] },
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});
		await coreModule.createEdge(pool, {
			sourceEntityId: internalFixture.entity.id,
			targetEntityId: publicFixture.entity.id,
			relationship: 'hidden_provenance_fixture',
			provenance: { sourceDocumentIds: [restrictedFixture.source.id] },
			sensitivityLevel: 'internal',
			sensitivityMetadata: sensitivityMetadata('internal'),
		});

		expect(
			(await coreModule.findAllSources(pool, { maxSensitivityLevel: 'internal' })).map((source) => source.id).sort(),
		).toEqual([publicFixture.source.id, internalFixture.source.id].sort());
		expect(
			(await coreModule.findAllEntities(pool, { maxSensitivityLevel: 'internal' })).map((entity) => entity.id),
		).toContain(internalFixture.entity.id);
		expect(
			(await coreModule.findAllEntities(pool, { maxSensitivityLevel: 'internal' })).map((entity) => entity.id),
		).not.toContain(restrictedFixture.entity.id);
		expect(
			await coreModule.findSourceById(pool, confidentialFixture.source.id, { maxSensitivityLevel: 'internal' }),
		).toBeNull();
		expect(
			await coreModule.findStoriesBySourceId(pool, confidentialFixture.source.id, { maxSensitivityLevel: 'internal' }),
		).toEqual([]);
		expect(await coreModule.listConflictNodes(pool, { maxSensitivityLevel: 'internal' })).toEqual([]);
		expect(await coreModule.listReviewableArtifacts(pool, { maxSensitivityLevel: 'internal' })).toHaveLength(1);
		expect(
			await coreModule.listTranslatedDocumentsForSource(pool, internalFixture.source.id, {
				maxSensitivityLevel: 'internal',
			}),
		).toHaveLength(1);
		expect(
			(await coreModule.findEntitiesByStoryId(pool, internalFixture.story.id, { maxSensitivityLevel: 'internal' })).map(
				(entity) => entity.id,
			),
		).not.toContain(restrictedEntityOnInternalStory.id);
		expect(
			(
				await coreModule.findStoriesByEntityId(pool, internalFixture.entity.id, { maxSensitivityLevel: 'internal' })
			).map((story) => story.id),
		).not.toContain(restrictedStoryForInternalEntity.id);
		expect(await coreModule.countEdges(pool, { maxSensitivityLevel: 'internal' })).toBe(
			visibleEdgeCountBeforeGraphFixtures + 1,
		);
		expect(await coreModule.countEdges(pool, { maxSensitivityLevel: 'confidential' })).toBeGreaterThan(
			visibleEdgeCountBeforeGraphFixtures + 1,
		);
		expect(
			(
				await coreModule.traverseGraph(pool, [internalFixture.entity.id], 1, 10, 100, {
					maxSensitivityLevel: 'internal',
				})
			).map((result) => result.chunk.id),
		).not.toEqual(expect.arrayContaining([hiddenEdgeChunk.id, hiddenLinkChunk.id]));
		expect(
			(
				await coreModule.traverseGraph(pool, [internalFixture.entity.id], 1, 10, 100, {
					maxSensitivityLevel: 'confidential',
				})
			).map((result) => result.chunk.id),
		).toEqual(expect.arrayContaining([hiddenEdgeChunk.id, hiddenLinkChunk.id]));
		const internalProfile = await coreModule.upsertSourceCredibilityProfile(pool, {
			sourceId: internalFixture.source.id,
			sourceName: 'Internal credibility source',
			sourceType: 'other',
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			dimensions: [
				{
					dimensionId: 'transparency',
					label: 'Transparency',
					score: 0.72,
					rationale: 'Fixture internal profile',
				},
			],
		});
		const restrictedProfile = await coreModule.upsertSourceCredibilityProfile(pool, {
			sourceId: restrictedFixture.source.id,
			sourceName: 'Restricted credibility source',
			sourceType: 'other',
			profileAuthor: 'llm_auto',
			reviewStatus: 'draft',
			dimensions: [
				{
					dimensionId: 'transparency',
					label: 'Transparency',
					score: 0.64,
					rationale: 'Fixture restricted profile',
				},
			],
		});
		expect(
			(await coreModule.listSourceCredibilityProfiles(pool, { maxSensitivityLevel: 'internal' })).map(
				(profile) => profile.profileId,
			),
		).toEqual([internalProfile.profileId]);
		expect(
			(await coreModule.listSourceCredibilityProfiles(pool, { maxSensitivityLevel: 'confidential' })).map(
				(profile) => profile.profileId,
			),
		).toEqual(expect.arrayContaining([internalProfile.profileId, restrictedProfile.profileId]));
		expect(await coreModule.findAllSources(pool, { maxSensitivityLevel: 'confidential' })).toHaveLength(4);
	});

	it.skipIf(!pgAvailable)(
		'QA-05/06: API document reads apply session filters and keep API keys compatible',
		async () => {
			const configPath = writeMinimalConfig('api');
			previousConfigPath = process.env.MULDER_CONFIG;
			process.env.MULDER_CONFIG = configPath;
			apiDocumentsModule.resetDocumentContextForTests();
			apiEntitiesModule.resetEntityContextForTests();

			const internalFixture = await createSourceFixture('internal', 'api-internal');
			const restrictedFixture = await createSourceFixture('restricted', 'api-restricted');
			await coreModule.createEntityAlias(pool, {
				entityId: internalFixture.entity.id,
				alias: 'Restricted API Alias',
				source: 'fixture',
				provenance: { sourceDocumentIds: [internalFixture.source.id] },
				sensitivityLevel: 'restricted',
				sensitivityMetadata: sensitivityMetadata('restricted'),
			});
			const memberPrincipal: TestAuthPrincipal = {
				type: 'session',
				userId: randomUUID(),
				email: 'member@example.test',
				role: 'member',
			};
			const adminPrincipal: TestAuthPrincipal = {
				type: 'session',
				userId: randomUUID(),
				email: 'admin@example.test',
				role: 'admin',
			};

			const member = await apiDocumentsModule.listDocuments({ limit: 100, offset: 0 }, coreModule.createLogger(), {
				authPrincipal: memberPrincipal,
			});
			const admin = await apiDocumentsModule.listDocuments({ limit: 100, offset: 0 }, coreModule.createLogger(), {
				authPrincipal: adminPrincipal,
			});
			const apiKey = await apiDocumentsModule.listDocuments({ limit: 100, offset: 0 }, coreModule.createLogger(), {
				authPrincipal: { type: 'api_key', keyName: 'automation' },
			});
			const memberEntity = await apiEntitiesModule.getEntityDetail(
				internalFixture.entity.id,
				coreModule.createLogger(),
				{
					authPrincipal: memberPrincipal,
				},
			);
			const adminEntity = await apiEntitiesModule.getEntityDetail(
				internalFixture.entity.id,
				coreModule.createLogger(),
				{
					authPrincipal: adminPrincipal,
				},
			);

			expect(member.data.map((document) => document.id)).toEqual([internalFixture.source.id]);
			expect(admin.data.map((document) => document.id).sort()).toEqual(
				[internalFixture.source.id, restrictedFixture.source.id].sort(),
			);
			expect(apiKey.data.map((document) => document.id).sort()).toEqual(
				[internalFixture.source.id, restrictedFixture.source.id].sort(),
			);
			expect(memberEntity.data.aliases.map((alias) => alias.alias)).not.toContain('Restricted API Alias');
			expect(adminEntity.data.aliases.map((alias) => alias.alias)).toContain('Restricted API Alias');
		},
	);
});
