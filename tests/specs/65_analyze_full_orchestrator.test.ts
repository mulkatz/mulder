import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as db from '../lib/db.js';
import { ensureSchema, truncateMulderTables } from '../lib/schema.js';
import { testStoragePath } from '../lib/storage.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const EXTRACTED_DIR = testStoragePath('extracted');
const SEGMENTS_DIR = testStoragePath('segments');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');

let tmpDir: string;
let pgAvailable = false;
let analyzeEnabledConfigPath: string;

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 120_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: {
			...process.env,
			PGPASSWORD: db.TEST_PG_PASSWORD,
			MULDER_LOG_LEVEL: 'silent',
			...opts?.env,
		},
	});

	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

function writeAnalyzeEnabledConfig(): string {
	const base = readFileSync(EXAMPLE_CONFIG, 'utf-8');
	const devModeEnabled = base.replace(/^dev_mode:\s*false$/m, 'dev_mode: true');
	const replacement = [
		'analysis:',
		'  enabled: true',
		'  contradictions: true',
		'  reliability: true',
		'  evidence_chains: true',
		'  evidence_theses: []',
		'  cluster_window_days: 30',
		'  spatio_temporal: true',
		'',
		'# --- Sparse Graph Thresholds ---',
	].join('\n');

	const updated = devModeEnabled.replace(/analysis:\n[\s\S]*?\n# --- Sparse Graph Thresholds ---/, replacement);
	const configPath = join(tmpDir, `analyze-enabled-${Date.now()}-${Math.random().toString(16).slice(2)}.yaml`);
	writeFileSync(configPath, updated, 'utf-8');
	return configPath;
}

function cleanStorageFixtures(): void {
	for (const dir of [SEGMENTS_DIR, EXTRACTED_DIR]) {
		if (!existsSync(dir)) {
			continue;
		}

		for (const entry of readdirSync(dir)) {
			if (entry === '_schema.json') continue;
			rmSync(join(dir, entry), { recursive: true, force: true });
		}
	}
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

	const layout = JSON.parse(readFileSync(layoutPath, 'utf-8')) as { pageCount: number };
	mkdirSync(pagesDir, { recursive: true });
	const minimalPng = Buffer.from(
		'89504e470d0a1a0a0000000d49484452000000010000000108020000009001be' +
			'0000000c4944415478da6360f80f00000101000518d84e0000000049454e44ae426082',
		'hex',
	);

	for (let i = 1; i <= layout.pageCount; i++) {
		const padded = String(i).padStart(3, '0');
		writeFileSync(join(pagesDir, `page-${padded}.png`), minimalPng);
	}
}

function makeWorkDir(name: string): string {
	const dir = resolve(tmpDir, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'native-text-sample.pdf'), readFileSync(NATIVE_TEXT_PDF));
	return dir;
}

describe.sequential('Spec 65 — Analyze Full Orchestrator', () => {
	beforeAll(() => {
		pgAvailable = db.isPgAvailable();
		if (!pgAvailable) {
			console.warn('SKIP: PostgreSQL container not available. Start with:\n  docker compose up -d');
			return;
		}

		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-spec65-'));
		ensureSchema();
		analyzeEnabledConfigPath = writeAnalyzeEnabledConfig();
	});

	beforeEach(() => {
		if (!pgAvailable) return;
		truncateMulderTables();
		cleanStorageFixtures();
	});

	afterAll(() => {
		if (!pgAvailable) return;
		truncateMulderTables();
		cleanStorageFixtures();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it('QA-06: pipeline run appends one global analyze phase after graph when analysis is enabled', () => {
		if (!pgAvailable) return;

		const workDir = makeWorkDir('qa06');
		const stage1 = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], {
			env: { MULDER_CONFIG: analyzeEnabledConfigPath },
			timeout: 240_000,
		});
		expect(stage1.exitCode).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		expect(sourceId).toMatch(/^[0-9a-f-]+$/);
		ensurePageImages(sourceId);

		const stage2 = runCli(['pipeline', 'run', workDir, '--from', 'segment'], {
			env: { MULDER_CONFIG: analyzeEnabledConfigPath },
			timeout: 600_000,
		});
		expect(stage2.exitCode).toBe(0);
		expect(stage2.stdout).toContain('Global analyze: success');

		const runStatus = db.runSql('SELECT status FROM pipeline_runs ORDER BY created_at DESC LIMIT 1;');
		expect(runStatus).toBe('completed');

		const sourceStep = db.runSql(
			'SELECT current_step FROM pipeline_run_sources WHERE run_id = (SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 1) ' +
				`AND source_id = '${sourceId}';`,
		);
		expect(sourceStep).toBe('graph');
	}, 900_000);

	it('QA-07: --up-to graph intentionally skips the global analyze phase', () => {
		if (!pgAvailable) return;

		const workDir = makeWorkDir('qa07');
		const stage1 = runCli(['pipeline', 'run', workDir, '--up-to', 'extract'], {
			env: { MULDER_CONFIG: analyzeEnabledConfigPath },
			timeout: 240_000,
		});
		expect(stage1.exitCode).toBe(0);

		const sourceId = db.runSql(
			"SELECT id FROM sources WHERE filename = 'native-text-sample.pdf' ORDER BY created_at DESC LIMIT 1;",
		);
		ensurePageImages(sourceId);

		const stage2 = runCli(['pipeline', 'run', workDir, '--from', 'segment', '--up-to', 'graph'], {
			env: { MULDER_CONFIG: analyzeEnabledConfigPath },
			timeout: 600_000,
		});
		expect(stage2.exitCode).toBe(0);
		expect(stage2.stdout).toContain('Global analyze: skipped');
		expect(stage2.stdout).toContain('pipeline stopped before global analyze');
	}, 900_000);
});
