import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Black-box smoke test for the `mulder config` CLI command group.
 *
 * Closes finding P1-COVERAGE-CLI-01 from the Post-MVP QA Gate Phase 1
 * coverage audit: the `config` command had no dedicated end-to-end test
 * despite being the very first thing users run when onboarding.
 *
 * System boundary: `node apps/cli/dist/index.js` subprocess.
 * No internal source imports.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

function runCli(
	args: string[],
	opts?: { timeout?: number },
): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	const result = spawnSync('node', [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: opts?.timeout ?? 30000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, MULDER_LOG_LEVEL: 'silent' },
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		exitCode: result.status ?? 1,
	};
}

describe('Spec 45 — CLI `mulder config` smoke (QA-Gate Phase 3, CLI gap closure)', () => {
	it('QA-01: `config --help` exits 0 and lists all three subcommands', () => {
		const { exitCode, stdout } = runCli(['config', '--help']);
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/validate/);
		expect(stdout).toMatch(/show/);
		expect(stdout).toMatch(/schema/);
	});

	it('QA-02: `config validate <example>` exits 0 on the shipped example config', () => {
		const { exitCode, stdout, stderr } = runCli(['config', 'validate', EXAMPLE_CONFIG]);
		expect(exitCode, `stderr: ${stderr}`).toBe(0);
		// Per output.ts: success messages go to stderr (stdout is reserved for
		// pipeable data). This also pins down that convention as a black-box
		// contract of the CLI.
		expect((stdout + stderr).toLowerCase()).toContain('valid');
	});

	it('QA-03: `config validate --json` produces parseable JSON with {valid: true}', () => {
		const { exitCode, stdout } = runCli(['config', 'validate', EXAMPLE_CONFIG, '--json']);
		expect(exitCode).toBe(0);
		// The CLI may print log lines before the JSON — grab the first JSON object.
		const firstBrace = stdout.indexOf('{');
		const lastBrace = stdout.lastIndexOf('}');
		expect(firstBrace).toBeGreaterThanOrEqual(0);
		expect(lastBrace).toBeGreaterThan(firstBrace);
		const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
		expect(parsed.valid).toBe(true);
		expect(typeof parsed.project).toBe('string');
		expect(parsed.project.length).toBeGreaterThan(0);
	});

	it('QA-04: `config validate` on missing file exits non-zero', () => {
		const { exitCode, stderr, stdout } = runCli(['config', 'validate', '/nonexistent/path/to/config.yaml']);
		expect(exitCode).not.toBe(0);
		// Error message should surface the path or "not found" wording to the user.
		const combined = (stdout + stderr).toLowerCase();
		expect(combined).toMatch(/not found|no such|does not exist|missing|cannot/);
	});

	it('QA-05: `config show <example>` exits 0 and emits the project name', () => {
		const { exitCode, stdout } = runCli(['config', 'show', EXAMPLE_CONFIG]);
		expect(exitCode).toBe(0);
		// The shipped example config sets project.name to "my-document-collection".
		// We assert on that specific string — if it ever changes, this test will
		// flag the shipped config as the source of drift.
		expect(stdout).toContain('my-document-collection');
	});

	it('QA-06: `config schema <example>` exits 0 and emits a JSON Schema', () => {
		const { exitCode, stdout } = runCli(['config', 'schema', EXAMPLE_CONFIG]);
		expect(exitCode).toBe(0);
		const firstBrace = stdout.indexOf('{');
		expect(firstBrace).toBeGreaterThanOrEqual(0);
		const lastBrace = stdout.lastIndexOf('}');
		const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
		// JSON Schema for entity extraction: top-level should have either
		// `type: object` + `properties` (raw schema) or `$defs` (wrapped).
		expect(typeof parsed).toBe('object');
		expect(parsed).not.toBeNull();
		const hasProperties =
			'properties' in parsed ||
			'$defs' in parsed ||
			// Gemini response schemas often wrap in `responseSchema` — accept any
			// of the three conventions so this test remains stable if the output
			// format is refined.
			'responseSchema' in parsed;
		expect(hasProperties).toBe(true);
	});
});
