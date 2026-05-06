import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = resolve(ROOT, 'scripts/test-scope.mjs');
const TEST_LANES_SCRIPT = resolve(ROOT, 'scripts/test-lanes.mjs');

interface AffectedPlan {
	changeScope: string;
	changedFiles: string[];
	totalFiles: number;
	lanes: Record<string, { count: number }>;
	files: Array<{ relativePath: string }>;
}

function listM7Scope(): string {
	const result = spawnSync(process.execPath, [SCRIPT, 'list', 'milestone', 'M7'], {
		cwd: ROOT,
		encoding: 'utf8',
	});

	expect(result.status).toBe(0);
	return result.stdout;
}

function affectedPlanForHeadFiles(headFiles: string[]): AffectedPlan {
	const result = spawnSync(process.execPath, [TEST_LANES_SCRIPT, 'affected-plan', 'origin/main', '--json'], {
		cwd: ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			MULDER_TEST_AFFECTED_PR_HEAD_DOCS_ONLY: 'true',
			MULDER_TEST_AFFECTED_HEAD_CHANGED_FILES: headFiles.join('\n'),
		},
	});

	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout) as AffectedPlan;
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

	it('QA-03: docs-only head changes do not replay the whole PR affected suite', () => {
		const plan = affectedPlanForHeadFiles(['docs/roadmap.md']);

		expect(plan.changeScope).toBe('head-docs-only');
		expect(plan.changedFiles).toEqual(['docs/roadmap.md']);
		expect(plan.lanes.schema.count).toBe(0);
		expect(plan.lanes.db.count).toBe(0);
		expect(plan.lanes.heavy.count).toBe(0);
		expect(plan.totalFiles).toBe(0);
	});

	it('QA-04: docs spec head changes stay scoped to their matching spec test', () => {
		const plan = affectedPlanForHeadFiles(['docs/specs/83_m7_verification_lane_repair.spec.md']);

		expect(plan.changeScope).toBe('head-docs-only');
		expect(plan.changedFiles).toEqual(['docs/specs/83_m7_verification_lane_repair.spec.md']);
		expect(plan.files.map((file) => file.relativePath)).toEqual(['tests/specs/83_m7_verification_lane_repair.test.ts']);
		expect(plan.lanes.db.count).toBe(1);
		expect(plan.lanes.schema.count).toBe(0);
		expect(plan.lanes.heavy.count).toBe(0);
	});
});
