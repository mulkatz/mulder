import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateExistingTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

const COLLECTION_TABLES = [
	'custody_steps',
	'original_sources',
	'archive_locations',
	'acquisition_contexts',
	'collections',
	'archives',
	'audit_log',
	'source_deletions',
	'source_steps',
	'url_lifecycle',
	'url_host_lifecycle',
	'document_blobs',
	'sources',
] as const;

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
			NODE_ENV: 'test',
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

async function createBlobAndSource(
	label: string,
	fileSizeBytes = 100,
): Promise<{ contentHash: string; sourceId: string }> {
	const contentHash = `spec105-${label}-${randomUUID()}`;
	await coreModule.upsertDocumentBlob(pool, {
		contentHash,
		storagePath: `blobs/${contentHash}.txt`,
		storageUri: `gs://spec105/${contentHash}.txt`,
		mimeType: 'text/plain',
		fileSizeBytes,
		originalFilenames: [`${label}.txt`],
	});
	const source = await coreModule.createSource(pool, {
		filename: `${label}.txt`,
		storagePath: `raw/${label}.txt`,
		fileHash: contentHash,
		sourceType: 'text',
		formatMetadata: { media_type: 'text/plain' },
		pageCount: 0,
		hasNativeText: false,
		nativeTextRatio: 0,
	});
	return { contentHash, sourceId: source.id };
}

beforeAll(async () => {
	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);
	coreModule = await import(pathToFileURL(CORE_DIST).href);

	if (!pgAvailable) {
		console.warn('SKIP: PostgreSQL not reachable at PGHOST/PGPORT.');
		return;
	}

	pool = new pg.Pool(PG_CONFIG);
	ensureSchema();
});

beforeEach(() => {
	if (!pgAvailable) {
		return;
	}
	truncateExistingTables(COLLECTION_TABLES);
});

afterAll(async () => {
	if (pool) {
		await pool.end();
	}
});

describe('Spec 105: Collection management', () => {
	it.skipIf(!pgAvailable)('QA-01: migration creates collection storage with constraints and indexes', async () => {
		const { rows: tables } = await pool.query<{ table_name: string }>(
			`
				SELECT table_name
				FROM information_schema.tables
				WHERE table_schema = 'public'
					AND table_name = 'collections'
			`,
		);
		expect(tables.map((row) => row.table_name)).toEqual(['collections']);

		const { rows: constraints } = await pool.query<{ conname: string; definition: string }>(
			`
				SELECT conname, pg_get_constraintdef(oid) AS definition
				FROM pg_constraint
				WHERE conrelid IN ('collections'::regclass, 'acquisition_contexts'::regclass)
				ORDER BY conname
			`,
		);
		const constraintText = constraints.map((row) => `${row.conname}: ${row.definition}`).join('\n');
		expect(constraintText).toContain('archive_mirror');
		expect(constraintText).toContain('private');
		expect(constraintText).toContain('collections');
		expect(constraintText).toContain('ON DELETE SET NULL');

		const { rows: indexes } = await pool.query<{ indexname: string }>(
			`
				SELECT indexname
				FROM pg_indexes
				WHERE schemaname = 'public'
					AND tablename = 'collections'
				ORDER BY indexname
			`,
		);
		const indexText = indexes.map((row) => row.indexname).join('\n');
		expect(indexText).toMatch(/archive_mirror_unique|tags|type_visibility|name_search|created_at/);
	});

	it.skipIf(!pgAvailable)('QA-02: repository manages collections and deterministic tags', async () => {
		const archive = await coreModule.createArchive(pool, {
			name: 'Spec 105 Repository Archive',
			description: 'Repository archive',
		});
		const collection = await coreModule.createCollection(pool, {
			name: 'Repository Collection',
			description: 'Initial description',
			type: 'curated',
			archiveId: archive.archiveId,
			createdBy: 'spec105',
			visibility: 'team',
			tags: ['beta', ' alpha ', 'beta'],
			defaults: { sensitivityLevel: 'restricted', defaultLanguage: 'de' },
		});

		expect(collection.tags).toEqual(['alpha', 'beta']);
		expect(collection.defaults).toMatchObject({
			sensitivityLevel: 'restricted',
			defaultLanguage: 'de',
			credibilityProfileId: null,
		});
		await expect(coreModule.findCollectionByName(pool, 'Repository Collection')).resolves.toMatchObject({
			collectionId: collection.collectionId,
		});
		await expect(coreModule.listCollections(pool, { visibility: 'team', tag: 'alpha' })).resolves.toEqual([
			expect.objectContaining({ collectionId: collection.collectionId }),
		]);

		const tagged = await coreModule.addCollectionTags(pool, collection.collectionId, ['gamma', 'alpha']);
		expect(tagged.tags).toEqual(['alpha', 'beta', 'gamma']);
		const pruned = await coreModule.removeCollectionTags(pool, collection.collectionId, ['beta']);
		expect(pruned.tags).toEqual(['alpha', 'gamma']);
		const updated = await coreModule.updateCollection(pool, collection.collectionId, {
			description: 'Updated description',
			visibility: 'public',
			defaults: { defaultLanguage: 'en' },
		});
		expect(updated).toMatchObject({
			description: 'Updated description',
			visibility: 'public',
			defaults: expect.objectContaining({ defaultLanguage: 'en', sensitivityLevel: 'restricted' }),
		});
	});

	it.skipIf(!pgAvailable)('QA-03: summary derives active collection statistics', async () => {
		const collection = await coreModule.createCollection(pool, { name: 'Summary Collection', createdBy: 'spec105' });
		const other = await coreModule.createCollection(pool, { name: 'Other Collection', createdBy: 'spec105' });
		const first = await createBlobAndSource('summary-a', 111);
		const second = await createBlobAndSource('summary-b', 222);
		const deleted = await createBlobAndSource('summary-deleted', 333);

		await coreModule.recordIngestProvenance(pool, {
			blobContentHash: first.contentHash,
			sourceId: first.sourceId,
			context: {
				channel: 'manual_upload',
				submittedBy: { userId: 'summary', type: 'human' },
				submittedAt: '2026-05-01T00:00:00.000Z',
				collectionId: collection.collectionId,
			},
			originalSource: { sourceType: 'other', sourceDescription: 'English source', sourceLanguage: 'en' },
		});
		await coreModule.recordIngestProvenance(pool, {
			blobContentHash: second.contentHash,
			sourceId: second.sourceId,
			context: {
				channel: 'manual_upload',
				submittedBy: { userId: 'summary', type: 'human' },
				submittedAt: '2026-05-03T00:00:00.000Z',
				collectionId: collection.collectionId,
			},
			originalSource: { sourceType: 'other', sourceDescription: 'German source', sourceLanguage: 'de' },
		});
		await coreModule.recordIngestProvenance(pool, {
			blobContentHash: deleted.contentHash,
			sourceId: deleted.sourceId,
			context: {
				channel: 'manual_upload',
				submittedBy: { userId: 'summary', type: 'human' },
				submittedAt: '2026-05-04T00:00:00.000Z',
				collectionId: other.collectionId,
			},
		});
		await coreModule.markAcquisitionContextsForSourceDeleted(
			pool,
			deleted.sourceId,
			new Date('2026-05-05T00:00:00.000Z'),
		);

		const summary = await coreModule.summarizeCollection(pool, collection.collectionId);
		expect(summary).toMatchObject({
			documentCount: 2,
			totalSizeBytes: 333,
			languages: ['de', 'en'],
		});
		expect(summary?.dateRange.earliest?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
		expect(summary?.dateRange.latest?.toISOString()).toBe('2026-05-03T00:00:00.000Z');
		await expect(coreModule.summarizeCollection(pool, other.collectionId)).resolves.toMatchObject({
			documentCount: 0,
			totalSizeBytes: 0,
		});
	});

	it.skipIf(!pgAvailable)(
		'QA-04/05/06: ingest collection resolution enforces ids and auto-creates archive mirrors with path tags',
		async () => {
			const explicit = await coreModule.createCollection(pool, { name: 'Explicit Collection', createdBy: 'spec105' });
			const explicitBlob = await createBlobAndSource('explicit');
			const explicitBundle = await coreModule.recordIngestProvenance(pool, {
				blobContentHash: explicitBlob.contentHash,
				sourceId: explicitBlob.sourceId,
				context: {
					channel: 'manual_upload',
					submittedBy: { userId: 'explicit', type: 'human' },
					collectionId: explicit.collectionId,
				},
			});
			expect(explicitBundle.context.collectionId).toBe(explicit.collectionId);

			const unknownBlob = await createBlobAndSource('unknown');
			await expect(
				coreModule.recordIngestProvenance(pool, {
					blobContentHash: unknownBlob.contentHash,
					sourceId: unknownBlob.sourceId,
					context: {
						channel: 'manual_upload',
						submittedBy: { userId: 'unknown', type: 'human' },
						collectionId: randomUUID(),
					},
				}),
			).rejects.toMatchObject({ code: 'DB_NOT_FOUND' });

			const archiveBlob = await createBlobAndSource('archive');
			const archiveBundle = await coreModule.recordIngestProvenance(pool, {
				blobContentHash: archiveBlob.contentHash,
				sourceId: archiveBlob.sourceId,
				context: {
					channel: 'archive_import',
					submittedBy: { userId: 'archivist', type: 'human' },
				},
				archive: {
					name: 'Archive Mirror Source',
					description: 'Archive mirror source',
					type: 'institutional',
				},
				archiveLocation: {
					originalPath: '/Region A/Box 1',
					originalFilename: 'archive.txt',
					pathSegments: [
						{ depth: 0, name: 'Region A', segmentType: 'region' },
						{ depth: 1, name: '1989-1990', segmentType: 'time_period' },
					],
				},
			});
			expect(archiveBundle.collection).toMatchObject({
				type: 'archive_mirror',
				archiveId: archiveBundle.archive?.archiveId,
				tags: ['region:region-a', 'time_period:1989-1990'],
			});

			const reusedBundle = await coreModule.recordIngestProvenance(pool, {
				blobContentHash: archiveBlob.contentHash,
				sourceId: archiveBlob.sourceId,
				context: {
					channel: 'archive_import',
					submittedBy: { userId: 'archivist', type: 'human' },
				},
				archive: {
					archiveId: archiveBundle.archive?.archiveId,
					name: 'Archive Mirror Source',
					description: 'Archive mirror source',
					type: 'institutional',
				},
			});
			expect(reusedBundle.collection?.collectionId).toBe(archiveBundle.collection?.collectionId);

			const registeredArchive = await coreModule.createArchive(pool, {
				name: 'Registered Archive Only',
				description: 'Archive supplied through archiveLocation.archiveId',
				type: 'institutional',
			});
			const registeredBlob = await createBlobAndSource('registered-archive');
			const registeredBundle = await coreModule.recordIngestProvenance(pool, {
				blobContentHash: registeredBlob.contentHash,
				sourceId: registeredBlob.sourceId,
				context: {
					channel: 'archive_import',
					submittedBy: { userId: 'archivist', type: 'human' },
				},
				archiveLocation: {
					archiveId: registeredArchive.archiveId,
					originalPath: '/Existing Archive/Folder',
					originalFilename: 'registered.txt',
					pathSegments: [{ depth: 0, name: 'Existing Archive', segmentType: 'collection' }],
				},
			});
			expect(registeredBundle.archive?.archiveId).toBe(registeredArchive.archiveId);
			expect(registeredBundle.collection).toMatchObject({
				type: 'archive_mirror',
				archiveId: registeredArchive.archiveId,
				tags: ['collection:existing-archive'],
			});
			expect(registeredBundle.context.collectionId).toBe(registeredBundle.collection?.collectionId);
		},
	);

	it.skipIf(!pgAvailable)('QA-07/08: config defaults and CLI collection management work with JSON output', async () => {
		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		expect(config.ingest_provenance.collections).toMatchObject({
			auto_create_from_archive: true,
			auto_tag_from_path_segments: true,
			default_collection: null,
			default_sensitivity_level: 'internal',
			default_language: 'und',
			default_credibility_profile_id: null,
		});
		const minimal = coreModule.mulderConfigSchema.parse({
			project: { name: 'minimal' },
			dev_mode: true,
			ontology: { entity_types: [{ name: 'document', description: 'Document' }] },
		});
		expect(minimal.ingest_provenance.collections.auto_create_from_archive).toBe(true);

		const archive = await coreModule.createArchive(pool, {
			name: 'CLI Collection Archive',
			description: 'CLI archive',
		});
		const create = runCli([
			'collection',
			'create',
			'--name',
			'CLI Collection',
			'--type',
			'archive_mirror',
			'--archive',
			archive.archiveId,
			'--tag',
			'fonds',
			'--json',
		]);
		expect(create.exitCode, `${create.stdout}\n${create.stderr}`).toBe(0);
		const created = JSON.parse(create.stdout) as import('@mulder/core').Collection;
		expect(created).toMatchObject({ name: 'CLI Collection', archiveId: archive.archiveId, tags: ['fonds'] });

		const list = runCli(['collection', 'list', '--tag', 'fonds', '--json']);
		expect(list.exitCode, `${list.stdout}\n${list.stderr}`).toBe(0);
		const listed = JSON.parse(list.stdout) as import('@mulder/core').CollectionSummary[];
		expect(listed).toEqual([expect.objectContaining({ collectionId: created.collectionId, documentCount: 0 })]);

		const tag = runCli(['collection', 'tag', created.collectionId, '--add', 'region:a', '--remove', 'fonds', '--json']);
		expect(tag.exitCode, `${tag.stdout}\n${tag.stderr}`).toBe(0);
		expect((JSON.parse(tag.stdout) as import('@mulder/core').Collection).tags).toEqual(['region:a']);

		const defaults = runCli([
			'collection',
			'defaults',
			created.collectionId,
			'--sensitivity',
			'internal',
			'--language',
			'de',
			'--json',
		]);
		expect(defaults.exitCode, `${defaults.stdout}\n${defaults.stderr}`).toBe(0);
		expect(JSON.parse(defaults.stdout)).toMatchObject({ sensitivityLevel: 'internal', defaultLanguage: 'de' });

		const show = runCli(['collection', 'show', created.collectionId, '--json']);
		expect(show.exitCode, `${show.stdout}\n${show.stderr}`).toBe(0);
		expect(JSON.parse(show.stdout)).toMatchObject({
			collectionId: created.collectionId,
			defaults: expect.objectContaining({ defaultLanguage: 'de' }),
			tags: ['region:a'],
		});

		const missing = runCli(['collection', 'show', randomUUID(), '--json']);
		expect(missing.exitCode).not.toBe(0);
	});
});
