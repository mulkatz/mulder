import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = resolve(ROOT, 'scripts/test-scope.mjs');

function listM7Scope(): string {
	const result = spawnSync(process.execPath, [SCRIPT, 'list', 'milestone', 'M7'], {
		cwd: ROOT,
		encoding: 'utf8',
	});

	expect(result.status).toBe(0);
	return result.stdout;
}

describe('Spec 83: M7 verification lane repair', () => {
	it('QA-01: milestone M7 scope excludes unrelated duplicate-numbered tests', () => {
		const output = listM7Scope();

		expect(output).toContain('tests/specs/77_document_observability_route.test.ts');
		expect(output).toContain('tests/specs/77_large_pdf_browser_upload_flow.test.ts');
		expect(output).not.toContain('tests/specs/77_cost_estimator.test.ts');
		expect(output).not.toContain('tests/specs/77_eval_cli_reporter.test.ts');
		expect(output).not.toContain('tests/specs/77_terraform_budget_alerts.test.ts');
	});

	it('QA-02: milestone M7 scope does not print duplicate files', () => {
		const files = listM7Scope()
			.split('\n')
			.filter((line) => line.startsWith(' - '))
			.map((line) => line.slice(3));

		expect(files).toHaveLength(new Set(files).size);
	});
});
