import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const REFRESH_SCRIPT = resolve(ROOT, 'scripts/ensure-cli-test-artifacts.mjs');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const CLI_SOURCE = resolve(ROOT, 'apps/cli/src/index.ts');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');
const CORE_SOURCE = resolve(ROOT, 'packages/core/src/index.ts');

function runRefresh(): string {
	return execFileSync(process.execPath, [REFRESH_SCRIPT], {
		cwd: ROOT,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function runCli(args: string[]): string {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function withTemporarySourceMarker<T>(path: string, marker: string, run: () => T): T {
	const original = readFileSync(path, 'utf-8');
	writeFileSync(path, `${original}\n${marker}\n`, 'utf-8');

	try {
		return run();
	} finally {
		writeFileSync(path, original, 'utf-8');
		runRefresh();
	}
}

describe('Spec 58: current CLI artifacts before black-box tests', () => {
	beforeAll(() => {
		runRefresh();
	});

	afterAll(() => {
		runRefresh();
	});

	it('QA-01: stale CLI source triggers a refresh before black-box execution', () => {
		const marker = '// spec-58-cli-refresh-marker';

		withTemporarySourceMarker(CLI_SOURCE, marker, () => {
			const status = runRefresh();
			expect(status).toBe('rebuilt');

			const cliDist = readFileSync(CLI, 'utf-8');
			expect(cliDist).toContain(marker);

			const help = runCli(['--help']);
			expect(help).toContain('Usage:');
		});
	});

	it('QA-02: already-fresh trees still execute through current built artifacts', () => {
		const status = runRefresh();
		expect(status).toBe('rebuilt');

		const exportHelp = runCli(['export', 'graph', '--help']);
		expect(exportHelp).toContain('--format');
	});

	it('QA-03: referenced workspace packages refresh through the CLI build graph', () => {
		const marker = '// spec-58-core-refresh-marker';

		withTemporarySourceMarker(CORE_SOURCE, marker, () => {
			const status = runRefresh();
			expect(status).toBe('rebuilt');

			const coreDist = readFileSync(CORE_DIST, 'utf-8');
			expect(coreDist).toContain(marker);

			const version = runCli(['--version']);
			expect(version.trim()).toMatch(/^\d+\.\d+\.\d+/);
		});
	});
});
