import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Black-box QA tests for Spec 06: CLI Scaffold
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: CLI subprocess calls.
 * Never import from packages/ or src/ or apps/.
 *
 * Uses execFileSync (no shell injection) wrapped via spawnSync to
 * reliably capture both stdout and stderr on success AND failure.
 */

/**
 * Helper: run the CLI binary via node as a subprocess.
 * Returns stdout, stderr, and exitCode.
 * Uses spawnSync with execFileSync-equivalent safety (no shell, array args).
 */
function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 15000,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

describe('Spec 06: CLI Scaffold', () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'mulder-qa-06-'));
	});

	afterAll(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	// ─── QA-01: Help output ───

	describe('QA-01: Help output', () => {
		it('exits 0, stdout contains "mulder" and "config"', () => {
			const { stdout, exitCode } = runCli(['--help']);

			expect(exitCode).toBe(0);
			expect(stdout.toLowerCase()).toContain('mulder');
			expect(stdout.toLowerCase()).toContain('config');
		});
	});

	// ─── QA-02: Version output ───

	describe('QA-02: Version output', () => {
		it('exits 0, stdout contains version string', () => {
			const { stdout, exitCode } = runCli(['--version']);

			expect(exitCode).toBe(0);
			// Version should be a semver-like string (e.g., "0.0.0")
			expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
		});
	});

	// ─── QA-03: Config validate — valid ───

	describe('QA-03: Config validate — valid', () => {
		it('exits 0, output contains "valid" (case-insensitive)', () => {
			const { stdout, stderr, exitCode } = runCli(['config', 'validate', EXAMPLE_CONFIG]);

			expect(exitCode).toBe(0);
			// The success message may go to stdout or stderr
			const combined = stdout + stderr;
			expect(combined.toLowerCase()).toContain('valid');
		});
	});

	// ─── QA-04: Config validate — missing file ───

	describe('QA-04: Config validate — missing file', () => {
		it('exits non-zero, stderr contains error about file', () => {
			const { stderr, exitCode } = runCli(['config', 'validate', '/nonexistent.yaml']);

			expect(exitCode).not.toBe(0);
			// stderr should mention something about the missing file
			expect(stderr.toLowerCase()).toMatch(/no such file|enoent|not found|cannot read/);
		});
	});

	// ─── QA-05: Config validate — invalid YAML ───

	describe('QA-05: Config validate — invalid YAML', () => {
		it('exits non-zero, stderr contains error', () => {
			const invalidYamlPath = join(tmpDir, 'invalid.yaml');
			writeFileSync(invalidYamlPath, '{{{invalid', 'utf-8');

			const { stderr, exitCode } = runCli(['config', 'validate', invalidYamlPath]);

			expect(exitCode).not.toBe(0);
			expect(stderr.length).toBeGreaterThan(0);
		});
	});

	// ─── QA-06: Config validate — schema error ───

	describe('QA-06: Config validate — schema error', () => {
		it('exits non-zero, stderr contains validation error', () => {
			const schemaErrorPath = join(tmpDir, 'schema-error.yaml');
			writeFileSync(schemaErrorPath, 'project: 123\n', 'utf-8');

			const { stderr, exitCode } = runCli(['config', 'validate', schemaErrorPath]);

			expect(exitCode).not.toBe(0);
			expect(stderr.length).toBeGreaterThan(0);
		});
	});

	// ─── QA-07: Config show — JSON default ───

	describe('QA-07: Config show — JSON default', () => {
		it('exits 0, stdout is valid JSON, contains project.name', () => {
			const { stdout, exitCode } = runCli(['config', 'show', EXAMPLE_CONFIG]);

			expect(exitCode).toBe(0);

			// stdout should be valid JSON with project.name
			const parsed = JSON.parse(stdout) as { project?: { name?: string } };
			expect(parsed.project?.name).toBeDefined();
		});
	});

	// ─── QA-08: Config show — YAML format ───

	describe('QA-08: Config show — YAML format', () => {
		it('exits 0, stdout is valid YAML, contains "project:"', () => {
			const { stdout, exitCode } = runCli(['config', 'show', EXAMPLE_CONFIG, '--format', 'yaml']);

			expect(exitCode).toBe(0);
			expect(stdout).toContain('project:');

			// It should NOT be valid JSON (it's YAML)
			let isJson = true;
			try {
				JSON.parse(stdout);
			} catch {
				isJson = false;
			}
			expect(isJson).toBe(false);
		});
	});

	// ─── QA-09: Config validate — JSON output ───

	describe('QA-09: Config validate — JSON output', () => {
		it('exits 0, stdout is valid JSON with valid: true', () => {
			const { stdout, exitCode } = runCli(['config', 'validate', EXAMPLE_CONFIG, '--json']);

			expect(exitCode).toBe(0);

			// stdout should be valid JSON with valid: true
			const parsed = JSON.parse(stdout) as { valid?: boolean };
			expect(parsed.valid).toBe(true);
		});
	});

	// ─── QA-10: Config subcommand help ───

	describe('QA-10: Config subcommand help', () => {
		it('exits 0, stdout lists "validate" and "show"', () => {
			const { stdout, exitCode } = runCli(['config', '--help']);

			expect(exitCode).toBe(0);
			expect(stdout).toContain('validate');
			expect(stdout).toContain('show');
		});
	});
});
