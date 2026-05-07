import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
let storageRoot: string | null = null;
let previousStorageRoot: string | undefined;
let coreModule: typeof import('@mulder/core');
let pipelineModule: typeof import('@mulder/pipeline');

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

function writeMinimalConfigWithoutTranslation(): string {
	if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec110-'));
	const configPath = join(tempDir, `minimal-${randomUUID()}.yaml`);
	writeFileSync(
		configPath,
		[
			'project:',
			'  name: "spec110"',
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
	truncateExistingTables(['translated_documents', ...MULDER_TEST_TABLES]);
}

function stripKnownNodeWarnings(stderr: string): string {
	return stderr
		.split(/\r?\n/)
		.filter((line) => !line.includes('[DEP0040] DeprecationWarning: The `punycode` module is deprecated.'))
		.filter((line) => !line.includes('Use `node --trace-deprecation ...` to show where the warning was created'))
		.join('\n')
		.trim();
}

async function createTextSource(label = 'spec110') {
	return coreModule.createSource(pool, {
		filename: `${label}-${randomUUID()}.md`,
		storagePath: `raw/${label}-${randomUUID()}.md`,
		fileHash: `${label}-${randomUUID()}`,
		sourceType: 'text',
		formatMetadata: { media_type: 'text/markdown', language: 'de' },
		pageCount: 1,
		hasNativeText: true,
		nativeTextRatio: 1,
		sensitivityLevel: 'restricted',
		sensitivityMetadata: {
			level: 'restricted',
			reason: 'spec110_fixture',
			piiTypes: [],
			declassifyDate: null,
		},
	});
}

async function createStoryBackedSource(services: import('@mulder/core').Services, label = 'spec110') {
	const source = await createTextSource(label);
	const markdownUri = `segments/${source.id}/story.md`;
	await services.storage.upload(markdownUri, '# Quelle\n\nDies ist ein Testdokument.', 'text/markdown');
	const story = await coreModule.createStory(pool, {
		sourceId: source.id,
		title: `Spec 110 Story ${label}`,
		language: 'de',
		gcsMarkdownUri: markdownUri,
		gcsMetadataUri: `segments/${source.id}/story.meta.json`,
		extractionConfidence: 0.95,
	});
	return { source, story };
}

function createCountingServices(config: import('@mulder/core').MulderConfig) {
	const services = coreModule.createServiceRegistry(config, coreModule.createLogger());
	const originalGenerateText = services.llm.generateText.bind(services.llm);
	const originalCountTokens = services.llm.countTokens.bind(services.llm);
	let generateTextCalls = 0;
	let countTokensCalls = 0;
	services.llm.generateText = async (options) => {
		generateTextCalls++;
		return originalGenerateText(options);
	};
	services.llm.countTokens = async (text) => {
		countTokensCalls++;
		return originalCountTokens(text);
	};
	return { services, generateTextCalls: () => generateTextCalls, countTokensCalls: () => countTokensCalls };
}

beforeAll(async () => {
	if (!pgAvailable) return;
	tempDir = mkdtempSync(join(tmpdir(), 'mulder-spec110-'));
	storageRoot = join(tempDir, 'storage');
	previousStorageRoot = process.env.MULDER_TEST_STORAGE_ROOT;
	process.env.MULDER_TEST_STORAGE_ROOT = storageRoot;
	buildPackage(CORE_DIR);
	buildPackage(PIPELINE_DIR);
	buildPackage(CLI_DIR);
	coreModule = await import(pathToFileURL(CORE_DIST).href);
	pipelineModule = await import(pathToFileURL(PIPELINE_DIST).href);
	ensureSchema();
	pool = new pg.Pool(PG_CONFIG);
});

beforeEach(() => {
	if (!pgAvailable) return;
	cleanTables();
});

afterAll(async () => {
	await pool?.end();
	if (previousStorageRoot === undefined) {
		delete process.env.MULDER_TEST_STORAGE_ROOT;
	} else {
		process.env.MULDER_TEST_STORAGE_ROOT = previousStorageRoot;
	}
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('Spec 110: translation service', () => {
	it('QA-01: translation schema is constrained and cache-safe', () => {
		if (!pgAvailable) return;

		expect(db.runSql("SELECT to_regclass('public.translated_documents');")).toBe('translated_documents');
		const constraints = db.runSql(
			`
				SELECT conname
				FROM pg_constraint
				WHERE conrelid = 'translated_documents'::regclass
				ORDER BY conname;
			`,
		);
		expect(constraints).toContain('translated_documents_status_check');
		expect(constraints).toContain('translated_documents_pipeline_path_check');
		expect(constraints).toContain('translated_documents_output_format_check');
		expect(constraints).toContain('translated_documents_sensitivity_level_check');

		const currentIndex = db.runSql(
			`
				SELECT indexdef
				FROM pg_indexes
				WHERE tablename = 'translated_documents'
					AND indexname = 'idx_translated_documents_current_source_target';
			`,
		);
		expect(currentIndex).toContain('UNIQUE INDEX');
		expect(currentIndex).toContain("WHERE (status = 'current'::text)");
	});

	it('QA-02: config exposes A7 defaults', () => {
		if (!pgAvailable) return;

		const config = coreModule.loadConfig(writeMinimalConfigWithoutTranslation());
		expect(config.translation.enabled).toBe(true);
		expect(config.translation.default_target_language).toBe('en');
		expect(config.translation.supported_languages).toEqual([
			'de',
			'en',
			'fr',
			'es',
			'pt',
			'ru',
			'zh',
			'ja',
			'pl',
			'cs',
		]);
		expect(config.translation.engine).toBe('gemini-2.5-flash');
		expect(config.translation.output_format).toBe('markdown');
		expect(config.translation.cache_enabled).toBe(true);
		expect(config.translation.max_document_length_tokens).toBe(500000);
	});

	it('QA-03/05: translation-only persists current translation and cache hits skip the LLM', async () => {
		if (!pgAvailable) return;

		const config = coreModule.loadConfig(writeMinimalConfigWithoutTranslation());
		const source = await createTextSource('translation-only');
		const { services, countTokensCalls, generateTextCalls } = createCountingServices(config);
		const logger = coreModule.createLogger();

		const first = await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				pipelinePath: 'translation_only',
				content: '# Quelle\n\nEine Akte.',
			},
			config,
			services,
			pool,
			logger,
		);
		expect(first.data.outcome).toBe('translated');
		expect(first.data.document.status).toBe('current');
		expect(first.data.document.pipelinePath).toBe('translation_only');
		expect(first.data.document.sensitivityLevel).toBe('restricted');
		expect(generateTextCalls()).toBe(1);
		expect(countTokensCalls()).toBe(1);

		const second = await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				pipelinePath: 'translation_only',
				content: '# Quelle\n\nEine Akte.',
			},
			config,
			services,
			pool,
			logger,
		);
		expect(second.data.outcome).toBe('cached');
		expect(second.data.translationId).toBe(first.data.translationId);
		expect(generateTextCalls()).toBe(1);
		expect(countTokensCalls()).toBe(1);
	});

	it('QA-04: full-pipeline path is recorded without changing cache semantics', async () => {
		if (!pgAvailable) return;

		const config = coreModule.loadConfig(writeMinimalConfigWithoutTranslation());
		const source = await createTextSource('full-path');
		const { services, generateTextCalls } = createCountingServices(config);
		const logger = coreModule.createLogger();

		const full = await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				pipelinePath: 'full',
				content: '# Voll\n\nText.',
			},
			config,
			services,
			pool,
			logger,
		);
		expect(full.data.document.pipelinePath).toBe('full');

		const translationOnly = await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				pipelinePath: 'translation_only',
				content: '# Voll\n\nText.',
			},
			config,
			services,
			pool,
			logger,
		);
		expect(translationOnly.data.outcome).toBe('cached');
		expect(translationOnly.data.translationId).toBe(full.data.translationId);
		expect(translationOnly.data.document.pipelinePath).toBe('full');
		expect(generateTextCalls()).toBe(1);
	});

	it('QA-05b: cache validity respects requested output format', async () => {
		if (!pgAvailable) return;

		const config = coreModule.loadConfig(writeMinimalConfigWithoutTranslation());
		const source = await createTextSource('format-cache');
		const { services, generateTextCalls } = createCountingServices(config);
		const logger = coreModule.createLogger();

		const markdown = await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				outputFormat: 'markdown',
				content: '# Format\n\nText.',
			},
			config,
			services,
			pool,
			logger,
		);
		const html = await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				outputFormat: 'html',
				content: '# Format\n\nText.',
			},
			config,
			services,
			pool,
			logger,
		);

		expect(markdown.data.outcome).toBe('translated');
		expect(html.data.outcome).toBe('translated');
		expect(html.data.translationId).not.toBe(markdown.data.translationId);
		expect(html.data.document.outputFormat).toBe('html');
		expect(generateTextCalls()).toBe(2);
		const history = await coreModule.listTranslatedDocumentsForSource(pool, source.id, { includeDeletedSources: true });
		expect(history.find((row) => row.id === markdown.data.translationId)?.status).toBe('stale');
		expect(history.find((row) => row.id === html.data.translationId)?.status).toBe('current');
	});

	it('QA-06: refresh or source material changes produce stale history', async () => {
		if (!pgAvailable) return;

		const config = coreModule.loadConfig(writeMinimalConfigWithoutTranslation());
		const source = await createTextSource('refresh');
		const { services } = createCountingServices(config);
		const logger = coreModule.createLogger();

		const first = await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				content: '# Alt\n\nText.',
			},
			config,
			services,
			pool,
			logger,
		);
		const refreshed = await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				content: '# Neu\n\nText.',
				refresh: true,
			},
			config,
			services,
			pool,
			logger,
		);

		expect(refreshed.data.translationId).not.toBe(first.data.translationId);
		const history = await coreModule.listTranslatedDocumentsForSource(pool, source.id, { includeDeletedSources: true });
		expect(history.map((row) => row.status).sort()).toEqual(['current', 'stale']);
		expect(history.find((row) => row.id === first.data.translationId)?.status).toBe('stale');
	});

	it('QA-07: source update, reset, and purge integration is safe', async () => {
		if (!pgAvailable) return;

		const config = coreModule.loadConfig(writeMinimalConfigWithoutTranslation());
		const { services } = createCountingServices(config);
		const logger = coreModule.createLogger();
		const { source } = await createStoryBackedSource(services, 'lifecycle');

		await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				targetLanguage: 'en',
			},
			config,
			services,
			pool,
			logger,
		);
		expect(await coreModule.findCurrentTranslatedDocument(pool, source.id, 'en')).not.toBeNull();

		await coreModule.updateSource(pool, source.id, { fileHash: `changed-${randomUUID()}` });
		expect(await coreModule.findCurrentTranslatedDocument(pool, source.id, 'en')).toBeNull();

		await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				content: '# Reset\n\nText.',
			},
			config,
			services,
			pool,
			logger,
		);
		expect(await coreModule.findCurrentTranslatedDocument(pool, source.id, 'en')).not.toBeNull();
		await coreModule.resetPipelineStep(pool, source.id, 'segment');
		expect(await coreModule.findCurrentTranslatedDocument(pool, source.id, 'en')).toBeNull();

		await pipelineModule.executeTranslate(
			{
				sourceId: source.id,
				sourceLanguage: 'de',
				targetLanguage: 'en',
				content: '# Purge\n\nText.',
			},
			config,
			services,
			pool,
			logger,
		);
		await coreModule.softDeleteSource(pool, {
			sourceId: source.id,
			actor: 'spec110-test',
			reason: 'translation lifecycle test',
		});
		const report = await coreModule.purgeSource(pool, {
			sourceId: source.id,
			actor: 'spec110-test',
			reason: 'translation lifecycle test',
			confirmed: true,
		});
		expect(report.effects.translatedDocumentsDeleted).toBeGreaterThan(0);
		expect(await coreModule.listTranslatedDocumentsForSource(pool, source.id, { includeDeletedSources: true })).toEqual(
			[],
		);
	});

	it('QA-08: CLI exposes translation without production calls in dev mode', async () => {
		if (!pgAvailable) return;
		if (!storageRoot) throw new Error('storage root not initialized');

		const configPath = writeMinimalConfigWithoutTranslation();
		const config = coreModule.loadConfig(configPath);
		const services = coreModule.createServiceRegistry(config, coreModule.createLogger());
		const { source } = await createStoryBackedSource(services, 'cli');

		const result = spawnSync('node', [CLI_DIST, 'translate', source.id, '--json'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 60_000,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				...db.TEST_PG_ENV,
				MULDER_CONFIG: configPath,
				MULDER_TEST_STORAGE_ROOT: storageRoot,
				MULDER_LOG_LEVEL: 'silent',
			},
		});
		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.source_id).toBe(source.id);
		expect(parsed.outcome).toBe('translated');
		expect(parsed.target_language).toBe('en');
		expect(parsed.content).toContain('Dev Translation');
		expect(stripKnownNodeWarnings(result.stderr)).toBe('');
	});
});
