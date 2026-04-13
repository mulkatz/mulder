import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const DOC_PATHS = [
	resolve(ROOT, 'CLAUDE.md'),
	resolve(ROOT, 'docs/functional-spec.md'),
	resolve(ROOT, 'docs/specs/02_monorepo_setup.spec.md'),
];

function runNodeImport(script: string): string {
	return execFileSync('node', ['--input-type=module', '--eval', script], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 120_000,
	});
}

describe('Spec 66: Evidence package boundary', () => {
	beforeAll(() => {
		execFileSync('pnpm', ['--filter', '@mulder/evidence', 'build'], {
			cwd: ROOT,
			encoding: 'utf-8',
			timeout: 120_000,
		});
	});

	it('QA-01 and QA-02: @mulder/evidence exposes analyze runtime and type exports from its public entry point', () => {
		const evidencePackage = JSON.parse(readFileSync(resolve(ROOT, 'packages/evidence/package.json'), 'utf-8')) as {
			exports: { '.': string };
		};
		const publicEntry = resolve(ROOT, 'packages/evidence', evidencePackage.exports['.']);
		const output = runNodeImport(`
			const evidence = await import(${JSON.stringify(publicEntry)});
			const payload = {
				executeAnalyzeType: typeof evidence.executeAnalyze,
			};
			console.log(JSON.stringify(payload));
		`);
		const parsed = JSON.parse(output) as {
			executeAnalyzeType: string;
		};
		const declarationsPath = resolve(ROOT, 'packages/evidence/dist/index.d.ts');
		const declarations = readFileSync(declarationsPath, 'utf-8');

		expect(parsed.executeAnalyzeType).toBe('function');
		expect(declarations).toContain('AnalyzeInput');
		expect(declarations).toContain('AnalyzeResult');
		expect(declarations).toContain('AnalyzePassName');
	});

	it('QA-03: evidence facade rebuilds and typechecks cleanly on repeat runs', () => {
		expect(() =>
			execFileSync('pnpm', ['--filter', '@mulder/evidence', 'build'], {
				cwd: ROOT,
				encoding: 'utf-8',
				timeout: 120_000,
			}),
		).not.toThrow();

		expect(() =>
			execFileSync('pnpm', ['--filter', '@mulder/evidence', 'typecheck'], {
				cwd: ROOT,
				encoding: 'utf-8',
				timeout: 120_000,
			}),
		).not.toThrow();
	});

	it('QA-04: docs describe packages/evidence as the analyze facade over packages/pipeline', () => {
		for (const docPath of DOC_PATHS) {
			const content = readFileSync(docPath, 'utf-8');
			expect(content, `${docPath} should mention packages/evidence`).toContain('packages/evidence');
			expect(content, `${docPath} should describe the pipeline dependency`).toContain('packages/pipeline');
		}
	});

	it('QA-05: the evidence package graph matches the implemented facade dependency', () => {
		const evidencePackage = JSON.parse(readFileSync(resolve(ROOT, 'packages/evidence/package.json'), 'utf-8')) as {
			dependencies?: Record<string, string>;
		};

		expect(evidencePackage.dependencies).toMatchObject({
			'@mulder/pipeline': 'workspace:*',
		});
		expect(Object.keys(evidencePackage.dependencies ?? {}).filter((name) => name.startsWith('@mulder/'))).toEqual([
			'@mulder/pipeline',
		]);
		expect(existsSync(resolve(ROOT, 'packages/evidence/dist/index.js'))).toBe(true);
		expect(existsSync(resolve(ROOT, 'packages/evidence/dist/index.d.ts'))).toBe(true);
	});
});
