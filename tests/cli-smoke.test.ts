import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CLI Smoke Tests — mechanical "does it crash" tests for all CLI commands.
 *
 * Tests every command with --help, missing args, flag combinations, and
 * output format flags. Does NOT test business logic (that's in tests/specs/).
 *
 * These tests require the CLI to be built (apps/cli/dist/index.js).
 * DB-dependent tests are skipped when PostgreSQL is unavailable.
 */

const ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const FIXTURE_DIR = resolve(ROOT, 'fixtures/raw');
const NATIVE_TEXT_PDF = resolve(FIXTURE_DIR, 'native-text-sample.pdf');

const PG_CONTAINER = 'mulder-pg-test';
const PG_USER = 'mulder';
const PG_PASSWORD = 'mulder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runCli(
	args: string[],
	opts?: { env?: Record<string, string>; timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 15000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, PGPASSWORD: PG_PASSWORD, ...opts?.env },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

let cliAvailable = false;
try {
	const r = spawnSync('node', [CLI, '--version'], {
		encoding: 'utf-8',
		timeout: 10000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	cliAvailable = r.status === 0;
} catch {
	/* CLI not built */
}

function isPgAvailable(): boolean {
	try {
		const result = spawnSync('docker', ['exec', PG_CONTAINER, 'pg_isready', '-U', PG_USER], {
			encoding: 'utf-8',
			timeout: 5000,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

const pgAvailable = isPgAvailable();

// ===========================================================================
// 1. Top-Level CLI
// ===========================================================================

describe('CLI Smoke: top-level', () => {
	it.skipIf(!cliAvailable)('SMOKE-01: --version returns version string', () => {
		const { stdout, exitCode } = runCli(['--version']);
		expect(exitCode).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it.skipIf(!cliAvailable)('SMOKE-02: --help lists all command groups', () => {
		const { stdout, exitCode } = runCli(['--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('config');
		expect(stdout).toContain('ingest');
		expect(stdout).toContain('extract');
		expect(stdout).toContain('db');
		expect(stdout).toContain('cache');
		expect(stdout).toContain('fixtures');
	});

	it.skipIf(!cliAvailable)('SMOKE-03: unknown command exits with error', () => {
		const { exitCode } = runCli(['nonexistent-command']);
		expect(exitCode).not.toBe(0);
	});
});

// ===========================================================================
// 2. Config Commands
// ===========================================================================

describe('CLI Smoke: config', () => {
	it.skipIf(!cliAvailable)('SMOKE-04: config --help lists subcommands', () => {
		const { stdout, exitCode } = runCli(['config', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('validate');
		expect(stdout).toContain('show');
	});

	it.skipIf(!cliAvailable)('SMOKE-05: config validate --help shows usage', () => {
		const { stdout, exitCode } = runCli(['config', 'validate', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--json');
	});

	it.skipIf(!cliAvailable)('SMOKE-06: config show --help shows --format flag', () => {
		const { stdout, exitCode } = runCli(['config', 'show', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--format');
	});

	it.skipIf(!cliAvailable)('SMOKE-07: config validate --json produces valid JSON', () => {
		const { stdout, exitCode } = runCli(['config', 'validate', EXAMPLE_CONFIG, '--json']);
		expect(exitCode).toBe(0);
		expect(() => JSON.parse(stdout)).not.toThrow();
		const parsed = JSON.parse(stdout);
		expect(parsed).toHaveProperty('valid', true);
	});

	it.skipIf(!cliAvailable)('SMOKE-08: config show --format yaml produces YAML', () => {
		const { stdout, exitCode } = runCli(['config', 'show', EXAMPLE_CONFIG, '--format', 'yaml']);
		expect(exitCode).toBe(0);
		// YAML output should contain key: value patterns, not JSON braces
		expect(stdout).toContain('project:');
	});

	it.skipIf(!cliAvailable)('SMOKE-09: config show with no path uses default config', () => {
		// Should either succeed (config found) or fail gracefully (not crash)
		const { exitCode } = runCli(['config', 'show']);
		expect([0, 1]).toContain(exitCode);
	});
});

// ===========================================================================
// 3. Ingest Commands
// ===========================================================================

describe('CLI Smoke: ingest', () => {
	it.skipIf(!cliAvailable)('SMOKE-10: ingest --help shows usage', () => {
		const { stdout, exitCode } = runCli(['ingest', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--dry-run');
		expect(stdout).toContain('--tag');
		expect(stdout).toContain('--cost-estimate');
	});

	it.skipIf(!cliAvailable)('SMOKE-11: ingest with no args exits with error', () => {
		const { exitCode } = runCli(['ingest']);
		expect(exitCode).not.toBe(0);
	});

	it.skipIf(!cliAvailable)('SMOKE-12: ingest nonexistent path exits with error', () => {
		const { exitCode, stderr } = runCli(['ingest', '/tmp/nonexistent-file-12345.pdf']);
		expect(exitCode).not.toBe(0);
		expect(stderr.length).toBeGreaterThan(0);
	});

	it.skipIf(!cliAvailable)('SMOKE-13: ingest --dry-run does not crash', () => {
		const { exitCode } = runCli(['ingest', '--dry-run', NATIVE_TEXT_PDF]);
		expect(exitCode).toBe(0);
	});

	it.skipIf(!cliAvailable)('SMOKE-14: ingest --dry-run --tag combo works', () => {
		const { exitCode } = runCli(['ingest', '--dry-run', '--tag', 'smoke-test', NATIVE_TEXT_PDF]);
		expect(exitCode).toBe(0);
	});

	it.skipIf(!cliAvailable)('SMOKE-15: ingest --dry-run with multiple --tag values', () => {
		const { exitCode } = runCli([
			'ingest',
			'--dry-run',
			'--tag',
			'tag-a',
			'--tag',
			'tag-b',
			'--tag',
			'tag-c',
			NATIVE_TEXT_PDF,
		]);
		expect(exitCode).toBe(0);
	});

	it.skipIf(!cliAvailable)('SMOKE-16: ingest --cost-estimate does not crash', () => {
		const { exitCode } = runCli(['ingest', '--cost-estimate', NATIVE_TEXT_PDF]);
		// Stub: may print "not yet implemented" but should not crash
		expect([0, 1]).toContain(exitCode);
	});

	it.skipIf(!cliAvailable)('SMOKE-17: ingest --dry-run --cost-estimate combo', () => {
		const { exitCode } = runCli([
			'ingest',
			'--dry-run',
			'--cost-estimate',
			NATIVE_TEXT_PDF,
		]);
		expect([0, 1]).toContain(exitCode);
	});

	it.skipIf(!cliAvailable)('SMOKE-18: ingest non-PDF file exits with error', () => {
		const { exitCode } = runCli(['ingest', '--dry-run', EXAMPLE_CONFIG]);
		expect(exitCode).not.toBe(0);
	});
});

// ===========================================================================
// 4. Extract Commands
// ===========================================================================

describe('CLI Smoke: extract', () => {
	it.skipIf(!cliAvailable)('SMOKE-19: extract --help shows usage', () => {
		const { stdout, exitCode } = runCli(['extract', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--all');
		expect(stdout).toContain('--force');
		expect(stdout).toContain('--fallback-only');
	});

	it.skipIf(!cliAvailable)('SMOKE-20: extract with no args and no --all exits with error', () => {
		const { exitCode, stderr } = runCli(['extract']);
		expect(exitCode).not.toBe(0);
		// Should indicate that source-id or --all is required
		expect(stderr.toLowerCase()).toMatch(/source|--all|provide/);
	});

	it.skipIf(!cliAvailable)('SMOKE-21: extract with source-id AND --all exits with error (mutual exclusion)', () => {
		const { exitCode, stderr } = runCli(['extract', 'some-id', '--all']);
		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain('exclusive');
	});

	it.skipIf(!cliAvailable)('SMOKE-22: extract with invalid UUID exits with error', () => {
		// A non-existent source-id should fail gracefully, not crash
		const { exitCode } = runCli(['extract', '00000000-0000-0000-0000-000000000000']);
		expect(exitCode).not.toBe(0);
	});
});

// ===========================================================================
// 5. DB Commands
// ===========================================================================

describe('CLI Smoke: db', () => {
	it.skipIf(!cliAvailable)('SMOKE-23: db --help shows subcommands', () => {
		const { stdout, exitCode } = runCli(['db', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('migrate');
		expect(stdout).toContain('status');
	});

	it.skipIf(!cliAvailable)('SMOKE-24: db migrate --help shows usage', () => {
		const { stdout, exitCode } = runCli(['db', 'migrate', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/config|path|usage/i);
	});

	it.skipIf(!cliAvailable)('SMOKE-25: db status --help shows usage', () => {
		const { stdout, exitCode } = runCli(['db', 'status', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/config|path|usage/i);
	});
});

// ===========================================================================
// 6. Cache Commands
// ===========================================================================

describe('CLI Smoke: cache', () => {
	it.skipIf(!cliAvailable)('SMOKE-26: cache --help shows subcommands', () => {
		const { stdout, exitCode } = runCli(['cache', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('clear');
		expect(stdout).toContain('stats');
	});

	it.skipIf(!cliAvailable)('SMOKE-27: cache stats does not crash', () => {
		const { exitCode } = runCli(['cache', 'stats']);
		// Should succeed even if no cache exists
		expect(exitCode).toBe(0);
	});

	it.skipIf(!cliAvailable)('SMOKE-28: cache clear does not crash', () => {
		const { exitCode } = runCli(['cache', 'clear']);
		expect(exitCode).toBe(0);
	});
});

// ===========================================================================
// 7. Fixtures Commands
// ===========================================================================

describe('CLI Smoke: fixtures', () => {
	it.skipIf(!cliAvailable)('SMOKE-29: fixtures --help shows subcommands', () => {
		const { stdout, exitCode } = runCli(['fixtures', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('generate');
		expect(stdout).toContain('status');
	});

	it.skipIf(!cliAvailable)('SMOKE-30: fixtures generate --help shows all flags', () => {
		const { stdout, exitCode } = runCli(['fixtures', 'generate', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toContain('--input');
		expect(stdout).toContain('--output');
		expect(stdout).toContain('--force');
		expect(stdout).toContain('--step');
		expect(stdout).toContain('--verbose');
	});

	it.skipIf(!cliAvailable)('SMOKE-31: fixtures status does not crash', () => {
		const { exitCode } = runCli(['fixtures', 'status']);
		expect(exitCode).toBe(0);
	});

	it.skipIf(!cliAvailable)('SMOKE-32: fixtures generate with invalid --step exits with error', () => {
		const { exitCode } = runCli(['fixtures', 'generate', '--step', 'nonexistent-step']);
		// Should fail gracefully — invalid step name
		expect(exitCode).not.toBe(0);
	});
});
