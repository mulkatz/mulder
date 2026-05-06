import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateExistingTables } from '../lib/schema.js';
import { cleanStorageDirSince, type StorageSnapshot, snapshotStorageDir, testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIR = resolve(ROOT, 'packages/core');
const PIPELINE_DIR = resolve(ROOT, 'packages/pipeline');
const CLI_DIR = resolve(ROOT, 'apps/cli');
const CORE_DIST = resolve(CORE_DIR, 'dist/index.js');
const CLI_DIST = resolve(CLI_DIR, 'dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const RAW_STORAGE_DIR = testStoragePath('raw');
const BLOBS_STORAGE_DIR = testStoragePath('blobs');

const PG_CONFIG = {
	host: db.TEST_PG_HOST,
	port: db.TEST_PG_PORT,
	database: db.TEST_PG_DATABASE,
	user: db.TEST_PG_USER,
	password: db.TEST_PG_PASSWORD,
};

const PROVENANCE_TABLES = [
	'custody_steps',
	'original_sources',
	'archive_locations',
	'acquisition_contexts',
	'archives',
	'audit_log',
	'source_deletions',
	'source_steps',
	'url_lifecycle',
	'url_host_lifecycle',
	'document_blobs',
	'sources',
] as const;

const pgAvailable = db.isPgAvailable();
let pool: pg.Pool;
let coreModule: typeof import('@mulder/core');
let tempDir = '';
let rawSnapshot: StorageSnapshot;
let blobsSnapshot: StorageSnapshot;

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

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sha256(content: Buffer | string): string {
	return createHash('sha256').update(content).digest('hex');
}

function writeFixture(relativePath: string, content: string): string {
	const path = join(tempDir, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, 'utf-8');
	return path;
}

async function createBlobAndSource(label: string): Promise<{ contentHash: string; sourceId: string }> {
	const contentHash = `spec104-${label}-${randomUUID()}`;
	await coreModule.upsertDocumentBlob(pool, {
		contentHash,
		storagePath: `blobs/${contentHash}.txt`,
		storageUri: `gs://spec104/${contentHash}.txt`,
		mimeType: 'text/plain',
		fileSizeBytes: 42,
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
	tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec104-'));
	rawSnapshot = snapshotStorageDir(RAW_STORAGE_DIR);
	blobsSnapshot = snapshotStorageDir(BLOBS_STORAGE_DIR);

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
	truncateExistingTables(PROVENANCE_TABLES);
	cleanStorageDirSince(rawSnapshot);
	cleanStorageDirSince(blobsSnapshot);
});

afterAll(async () => {
	if (pool) {
		await pool.end();
	}
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
	}
	cleanStorageDirSince(rawSnapshot);
	cleanStorageDirSince(blobsSnapshot);
});

describe('Spec 104: Ingest provenance data model', () => {
	it.skipIf(!pgAvailable)(
		'QA-01: migration creates provenance tables with lookup constraints and indexes',
		async () => {
			const { rows: tables } = await pool.query<{ table_name: string }>(
				`
				SELECT table_name
				FROM information_schema.tables
				WHERE table_schema = 'public'
					AND table_name IN ('archives', 'acquisition_contexts', 'original_sources', 'custody_steps', 'archive_locations')
				ORDER BY table_name
			`,
			);
			expect(tables.map((row) => row.table_name)).toEqual([
				'acquisition_contexts',
				'archive_locations',
				'archives',
				'custody_steps',
				'original_sources',
			]);

			const { rows: constraints } = await pool.query<{ conname: string; definition: string }>(
				`
				SELECT conname, pg_get_constraintdef(oid) AS definition
				FROM pg_constraint
				WHERE conrelid IN (
					'archives'::regclass,
					'acquisition_contexts'::regclass,
					'original_sources'::regclass,
					'custody_steps'::regclass,
					'archive_locations'::regclass
				)
				ORDER BY conname
			`,
			);
			const constraintText = constraints.map((row) => row.definition).join('\n');
			expect(constraintText).toContain('document_blobs');
			expect(constraintText).toContain('sources');
			expect(constraintText).toContain('manual_upload');
			expect(constraintText).toContain('archive_import');
			expect(constraintText).toContain('jsonb_typeof');

			const { rows: indexes } = await pool.query<{ indexname: string }>(
				`
				SELECT indexname
				FROM pg_indexes
				WHERE schemaname = 'public'
					AND tablename IN ('archives', 'acquisition_contexts', 'original_sources', 'custody_steps', 'archive_locations')
				ORDER BY indexname
			`,
			);
			const indexText = indexes.map((row) => row.indexname).join('\n');
			expect(indexText).toMatch(/blob|source|archive|context|path/i);
		},
	);

	it.skipIf(!pgAvailable)(
		'QA-02/03: repository records complete bundles and duplicate contexts for one blob',
		async () => {
			const { contentHash, sourceId } = await createBlobAndSource('bundle');

			const bundle = await coreModule.recordIngestProvenance(pool, {
				blobContentHash: contentHash,
				sourceId,
				context: {
					channel: 'archive_import',
					submittedBy: { userId: 'archivist-1', type: 'human', role: 'archivist' },
					submissionNotes: 'Box transfer',
					submissionMetadata: { batch: 'K7' },
					authenticityStatus: 'verified',
				},
				archive: {
					name: 'Spec 104 Archive',
					description: 'Archive for provenance tests',
					type: 'institutional',
					languages: ['en', 'de'],
					ingestStatus: { totalDocumentsIngested: 1, completeness: 'partial' },
				},
				archiveLocation: {
					originalPath: '/fonds/a/box-1',
					originalFilename: 'bundle.txt',
					pathSegments: [{ depth: 0, name: 'fonds', segmentType: 'collection' }],
					physicalLocation: { building: 'Main', container: 'Box 1' },
					sourceStatus: 'current',
				},
				originalSource: {
					sourceType: 'government_document',
					sourceDescription: 'Original public document',
					sourceDate: '2026-05-01',
					sourceLanguage: 'en',
					sourceInstitution: 'Spec Institution',
				},
				custodyChain: [
					{ stepOrder: 1, holder: 'Spec Institution', holderType: 'institution', actions: ['archived'] },
					{ stepOrder: 2, holder: 'Mulder Import', holderType: 'institution', actions: ['digitized'] },
				],
			});

			expect(bundle.context).toMatchObject({
				blobContentHash: contentHash,
				sourceId,
				channel: 'archive_import',
				submittedBy: { userId: 'archivist-1', type: 'human', role: 'archivist' },
				authenticityStatus: 'verified',
			});
			expect(bundle.archive?.name).toBe('Spec 104 Archive');
			expect(bundle.archiveLocation).toMatchObject({ originalPath: '/fonds/a/box-1', originalFilename: 'bundle.txt' });
			expect(bundle.originalSource).toMatchObject({ sourceType: 'government_document', sourceLanguage: 'en' });
			expect(bundle.custodyChain.map((step) => step.stepOrder)).toEqual([1, 2]);

			await coreModule.recordIngestProvenance(pool, {
				blobContentHash: contentHash,
				sourceId,
				context: {
					channel: 'partner_exchange',
					submittedBy: { userId: 'partner-1', type: 'human' },
					submissionMetadata: { envelope: 'duplicate-path' },
				},
			});

			const contexts = await coreModule.listAcquisitionContextsForBlob(pool, contentHash);
			expect(contexts).toHaveLength(2);
			expect(new Set(contexts.map((context) => context.contextId)).size).toBe(2);
			expect(contexts.map((context) => context.channel)).toEqual(['archive_import', 'partner_exchange']);
			expect(db.runSql(`SELECT COUNT(*) FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)};`)).toBe(
				'1',
			);
		},
	);

	it.skipIf(!pgAvailable)('QA-04/05: CLI writes minimal and explicit provenance metadata', () => {
		const minimalContent = `Spec 104 minimal ${randomUUID()}`;
		const minimalPath = writeFixture('minimal.txt', minimalContent);
		const minimal = runCli(['ingest', minimalPath]);
		expect(minimal.exitCode, `${minimal.stdout}\n${minimal.stderr}`).toBe(0);
		const minimalHash = sha256(minimalContent);
		const minimalContext = db
			.runSql(
				`SELECT channel, submitted_by_user_id, submitted_by_type, status FROM acquisition_contexts WHERE blob_content_hash = ${sqlLiteral(minimalHash)};`,
			)
			.split('|');
		expect(minimalContext).toEqual(['manual_upload', 'mulder-cli', 'system', 'active']);

		const explicitContent = `Spec 104 explicit ${randomUUID()}`;
		const explicitPath = writeFixture('explicit.txt', explicitContent);
		const provenancePath = writeFixture(
			'provenance.json',
			JSON.stringify({
				context: {
					channel: 'archive_import',
					submittedBy: { userId: 'cli-user', type: 'human', role: 'researcher' },
					submissionMetadata: { import_id: 'cli-k7' },
				},
				archive: { name: 'CLI Archive', description: 'CLI archive metadata', type: 'digital' },
				archiveLocation: {
					originalPath: '/cli/path',
					originalFilename: 'explicit.txt',
					pathSegments: [{ depth: 0, name: 'cli', segmentType: 'collection' }],
				},
				originalSource: {
					sourceType: 'news_article',
					sourceDescription: 'CLI supplied original source',
					sourceLanguage: 'en',
				},
				custodyChain: [{ stepOrder: 1, holder: 'CLI Holder', holderType: 'person', actions: ['received'] }],
			}),
		);
		const explicit = runCli(['ingest', explicitPath, '--provenance', provenancePath]);
		expect(explicit.exitCode, `${explicit.stdout}\n${explicit.stderr}`).toBe(0);
		const explicitHash = sha256(explicitContent);
		const persisted = db
			.runSql(
				`
				SELECT ac.channel, ac.submitted_by_user_id, a.name, al.original_path, os.source_type, cs.holder
				FROM acquisition_contexts ac
				JOIN archive_locations al ON al.blob_content_hash = ac.blob_content_hash
				JOIN archives a ON a.archive_id = al.archive_id
				JOIN original_sources os ON os.context_id = ac.context_id
				JOIN custody_steps cs ON cs.context_id = ac.context_id
				WHERE ac.blob_content_hash = ${sqlLiteral(explicitHash)}
				`,
			)
			.split('|');
		expect(persisted).toEqual(['archive_import', 'cli-user', 'CLI Archive', '/cli/path', 'news_article', 'CLI Holder']);
	});

	it.skipIf(!pgAvailable)('QA-06/07: rollback marks contexts and config defaults validate', async () => {
		const { contentHash, sourceId } = await createBlobAndSource('rollback');
		await coreModule.recordIngestProvenance(pool, {
			blobContentHash: contentHash,
			sourceId,
			context: {
				channel: 'manual_upload',
				submittedBy: { userId: 'rollback-user', type: 'human' },
			},
			archive: { name: 'Rollback Archive', description: 'Archive retained during rollback' },
			archiveLocation: { originalPath: '/rollback', originalFilename: 'rollback.txt' },
		});

		await coreModule.softDeleteSource(pool, {
			sourceId,
			actor: 'spec104',
			reason: 'rollback compatibility',
			deletedAt: new Date('2026-05-06T00:00:00.000Z'),
		});
		await expect(coreModule.listAcquisitionContextsForSource(pool, sourceId)).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ status: 'deleted' })]),
		);

		const plan = await coreModule.planSourcePurge(pool, sourceId);
		const countsBySubsystem = new Map(plan.counts.map((count) => [count.subsystem, count]));
		expect(countsBySubsystem.get('acquisition_contexts')?.total).toBe(1);
		expect(countsBySubsystem.get('archive_locations')?.total).toBe(1);

		await coreModule.restoreSource(pool, {
			sourceId,
			actor: 'spec104',
			reason: 'undo',
			restoredAt: new Date('2026-05-06T01:00:00.000Z'),
		});
		await expect(coreModule.listAcquisitionContextsForSource(pool, sourceId)).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ status: 'restored' })]),
		);
		expect(db.runSql(`SELECT COUNT(*) FROM document_blobs WHERE content_hash = ${sqlLiteral(contentHash)};`)).toBe('1');
		expect(db.runSql("SELECT COUNT(*) FROM archives WHERE name = 'Rollback Archive';")).toBe('1');

		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		expect(config.ingest_provenance).toMatchObject({
			required_metadata: {
				channel: true,
				submitted_by: true,
				collection_id: false,
				original_source: false,
				custody_chain: false,
			},
			archives: { auto_register: true },
		});
	});
});
