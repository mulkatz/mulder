import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const EXTRACTED_DIR = resolve(ROOT, '.local/storage/extracted');
const SEGMENTS_DIR = resolve(ROOT, '.local/storage/segments');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number; input?: string },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		input: opts?.input,
		timeout: opts?.timeout ?? 60_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			NODE_ENV: 'test',
			MULDER_CONFIG: EXAMPLE_CONFIG,
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

function cleanTestData(): void {
	truncateMulderTables();
}

function cleanStorageFixtures(): void {
	for (const dir of [SEGMENTS_DIR, EXTRACTED_DIR]) {
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				if (entry === '_schema.json') continue;
				rmSync(join(dir, entry), { recursive: true, force: true });
			}
		}
	}
}

function makeWorkDir(name: string, files: string[]): string {
	const dir = resolve(ROOT, '.local', 'tmp-tests', name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const file of files) {
		const basename = file.split('/').pop() ?? file;
		writeFileSync(join(dir, basename), readFileSync(file));
	}
	return dir;
}

function ensurePageImages(sourceId: string): void {
	const pagesDir = join(EXTRACTED_DIR, sourceId, 'pages');
	if (existsSync(pagesDir)) {
		return;
	}

	const layoutPath = join(EXTRACTED_DIR, sourceId, 'layout.json');
	if (!existsSync(layoutPath)) {
		return;
	}

	const layout = JSON.parse(readFileSync(layoutPath, 'utf-8'));
	mkdirSync(pagesDir, { recursive: true });
	const minimalPng = Buffer.from(
		'89504e470d0a1a0a0000000d49484452000000010000000108020000009001be' +
			'0000000c4944415478da6360f80f00000101000518d84e0000000049454e44ae426082',
		'hex',
	);

	for (let i = 1; i <= layout.pageCount; i++) {
		writeFileSync(join(pagesDir, `page-${String(i).padStart(3, '0')}.png`), minimalPng);
	}
}

function writeTempConfig(name: string, replacer: (input: string) => string): string {
	const dir = resolve(ROOT, '.local', 'tmp-tests', 'configs');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.yaml`);
	writeFileSync(path, replacer(readFileSync(EXAMPLE_CONFIG, 'utf-8')));
	return path;
}

function prepareCompletedSource(name: string): string {
	ensureSchema();
	cleanTestData();
	cleanStorageFixtures();

	const workDir = makeWorkDir(name, [NATIVE_TEXT_PDF]);
	const pdfPath = join(workDir, 'native-text-sample.pdf');
	const ingest = runCli(['ingest', pdfPath], { timeout: 240_000 });
	expect(ingest.exitCode, `${ingest.stdout}\n${ingest.stderr}`).toBe(0);

	const sourceId = db.runSql(
		"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
	);
	const extract = runCli(['extract', sourceId], { timeout: 240_000 });
	expect(extract.exitCode, `${extract.stdout}\n${extract.stderr}`).toBe(0);
	ensurePageImages(sourceId);

	const segment = runCli(['segment', sourceId], { timeout: 240_000 });
	expect(segment.exitCode, `${segment.stdout}\n${segment.stderr}`).toBe(0);

	const storyId = db.runSql(`SELECT id FROM stories WHERE source_id = '${sourceId}' ORDER BY created_at ASC LIMIT 1;`);

	const enrich = runCli(['enrich', storyId], { timeout: 240_000 });
	expect(enrich.exitCode, `${enrich.stdout}\n${enrich.stderr}`).toBe(0);

	const embed = runCli(['embed', storyId], { timeout: 240_000 });
	expect(embed.exitCode, `${embed.stdout}\n${embed.stderr}`).toBe(0);

	const graph = runCli(['graph', storyId], { timeout: 240_000 });
	expect(graph.exitCode, `${graph.stdout}\n${graph.stderr}`).toBe(0);

	return sourceId;
}

describe('Spec 77 — Cost Estimator', () => {
	let pgAvailable: boolean;

	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL container not available. Start with:\n  docker compose up -d');
			return;
		}

		ensureSchema();
		cleanTestData();
		cleanStorageFixtures();
	}, 600_000);

	afterAll(() => {
		if (!pgAvailable) return;
		cleanTestData();
		cleanStorageFixtures();
		rmSync(resolve(ROOT, '.local', 'tmp-tests'), { recursive: true, force: true });
	});

	it('QA-01: ingest --dry-run --cost-estimate prints an estimate and makes no writes', () => {
		if (!pgAvailable) return;

		ensureSchema();
		cleanTestData();

		const result = runCli(['ingest', NATIVE_TEXT_PDF, '--dry-run', '--cost-estimate']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Cost estimate for ingest-triggered pipeline');
		expect(result.stdout).toContain('Total estimated:');
		expect(db.runSql('SELECT count(*) FROM sources;')).toBe('0');
	});

	it('QA-02: explicit cost-estimate prompts before live ingest execution', () => {
		if (!pgAvailable) return;

		ensureSchema();
		cleanTestData();

		const result = runCli(['ingest', NATIVE_TEXT_PDF, '--cost-estimate'], { input: 'n\n' });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('Cost estimate for ingest-triggered pipeline');
		expect(result.stderr).toContain('Proceed? [y/N]');
		expect(result.stderr).toContain('Operation cancelled');
		expect(db.runSql('SELECT count(*) FROM sources;')).toBe('0');
	});

	it('QA-03: pipeline run --dry-run --cost-estimate respects the planned step slice', () => {
		if (!pgAvailable) return;

		ensureSchema();
		cleanTestData();

		const workDir = makeWorkDir('spec77-qa03', [NATIVE_TEXT_PDF]);
		const result = runCli([
			'pipeline',
			'run',
			workDir,
			'--from',
			'segment',
			'--up-to',
			'enrich',
			'--dry-run',
			'--cost-estimate',
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Cost estimate for pipeline run');
		expect(result.stdout).toContain('- segment:');
		expect(result.stdout).toContain('- enrich:');
		expect(result.stdout).not.toContain('- extract:');
		expect(db.runSql('SELECT count(*) FROM pipeline_runs;')).toBe('0');
	});

	it('QA-04: successful pipeline execution persists non-null config hashes for completed steps', () => {
		if (!pgAvailable) return;

		const sourceId = prepareCompletedSource('spec77-qa04');

		const rows = db
			.runSql(
				`SELECT step_name || ':' || COALESCE(config_hash, '') FROM source_steps WHERE source_id = '${sourceId}' ORDER BY step_name;`,
			)
			.split('\n')
			.filter(Boolean);

		expect(rows).toContainEqual(expect.stringMatching(/^embed:[0-9a-f]{64}$/));
		expect(rows).toContainEqual(expect.stringMatching(/^enrich:[0-9a-f]{64}$/));
		expect(rows).toContainEqual(expect.stringMatching(/^extract:[0-9a-f]{64}$/));
		expect(rows).toContainEqual(expect.stringMatching(/^graph:[0-9a-f]{64}$/));
		expect(rows).toContainEqual(expect.stringMatching(/^segment:[0-9a-f]{64}$/));
	});

	it('QA-05: reprocess --dry-run --cost-estimate reports no-op when hashes match', () => {
		if (!pgAvailable) return;

		prepareCompletedSource('spec77-qa05');

		const result = runCli(['reprocess', '--dry-run', '--cost-estimate']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('No sources require reprocessing.');
		expect(result.stdout).toContain('Total estimated: ~$0.00');
	});

	it('QA-06: reprocess --dry-run --cost-estimate detects changed config and estimates only affected steps', () => {
		if (!pgAvailable) return;

		prepareCompletedSource('spec77-qa06');

		const configPath = writeTempConfig('spec77-extract-change', (input) =>
			input.replace('native_text_threshold: 0.9', 'native_text_threshold: 0.8'),
		);

		const result = runCli(['reprocess', '--dry-run', '--cost-estimate'], {
			env: { MULDER_CONFIG: configPath },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('Cost estimate for reprocess plan');
		expect(result.stdout).toContain('- extract:');
		expect(result.stdout).toContain('native-text-sample.pdf');
		expect(result.stdout).toContain('extract -> segment -> enrich -> embed -> graph');
		expect(result.stdout).toMatch(/Total estimated: ~\$0\.0\d{3,}/);
	});
});
