import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Black-box QA tests for Spec 02: Monorepo Setup — pnpm, Turborepo, TypeScript, Biome
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: CLI commands and filesystem checks.
 * No imports from packages/ or src/.
 */
describe('Spec 02: Monorepo Setup', () => {
	// All 8 workspace packages (6 packages + 2 apps)
	const PACKAGES = [
		'packages/core',
		'packages/pipeline',
		'packages/retrieval',
		'packages/taxonomy',
		'packages/worker',
		'packages/evidence',
		'apps/cli',
		'apps/api',
	];

	// §13 subdirectory structure expectations
	const EXPECTED_SUBDIRS: Record<string, string[]> = {
		'packages/core': ['src/config', 'src/database', 'src/shared', 'src/prompts'],
		'packages/pipeline': [
			'src/ingest',
			'src/extract',
			'src/segment',
			'src/enrich',
			'src/ground',
			'src/embed',
			'src/graph',
			'src/analyze',
		],
		'apps/cli': ['src/commands', 'src/lib'],
		'apps/api': ['src/routes', 'src/middleware'],
	};

	// Expected internal dependency graph (from spec §4.2)
	const EXPECTED_DEPS: Record<string, string[]> = {
		'packages/core': [],
		'packages/pipeline': ['@mulder/core'],
		'packages/retrieval': ['@mulder/core'],
		'packages/taxonomy': ['@mulder/core'],
		'packages/worker': ['@mulder/core', '@mulder/pipeline'],
		'packages/evidence': ['@mulder/core'],
		'apps/cli': [
			'@mulder/core',
			'@mulder/pipeline',
			'@mulder/retrieval',
			'@mulder/taxonomy',
			'@mulder/evidence',
			'@mulder/worker',
		],
		'apps/api': ['@mulder/core', '@mulder/retrieval', '@mulder/taxonomy', '@mulder/evidence', '@mulder/worker'],
	};

	// ─── Condition: build-succeeds ───

	describe('build-succeeds', () => {
		let buildExitCode: number;
		let buildOutput: string;

		beforeAll(() => {
			try {
				buildOutput = execFileSync('pnpm', ['turbo', 'run', 'build'], {
					cwd: ROOT,
					encoding: 'utf-8',
					timeout: 120_000,
				});
				buildExitCode = 0;
			} catch (e: unknown) {
				const error = e as { status?: number; stdout?: string; stderr?: string };
				buildExitCode = error.status ?? 1;
				buildOutput = (error.stdout ?? '') + (error.stderr ?? '');
			}
		});

		it('pnpm turbo run build exits 0', () => {
			expect(buildExitCode, `Build failed:\n${buildOutput}`).toBe(0);
		});

		it('every package produces dist/index.js and dist/index.d.ts', () => {
			for (const pkg of PACKAGES) {
				const distJs = resolve(ROOT, pkg, 'dist/index.js');
				const distDts = resolve(ROOT, pkg, 'dist/index.d.ts');
				expect(existsSync(distJs), `Missing dist/index.js in ${pkg}`).toBe(true);
				expect(existsSync(distDts), `Missing dist/index.d.ts in ${pkg}`).toBe(true);
			}
		});
	});

	// ─── Condition: typecheck-succeeds ───

	describe('typecheck-succeeds', () => {
		let typecheckExitCode: number;
		let typecheckOutput: string;

		beforeAll(() => {
			try {
				typecheckOutput = execFileSync('pnpm', ['turbo', 'run', 'typecheck'], {
					cwd: ROOT,
					encoding: 'utf-8',
					timeout: 120_000,
				});
				typecheckExitCode = 0;
			} catch (e: unknown) {
				const error = e as { status?: number; stdout?: string; stderr?: string };
				typecheckExitCode = error.status ?? 1;
				typecheckOutput = (error.stdout ?? '') + (error.stderr ?? '');
			}
		});

		it('pnpm turbo run typecheck exits 0', () => {
			expect(typecheckExitCode, `Typecheck failed:\n${typecheckOutput}`).toBe(0);
		});
	});

	// ─── Condition: lint-passes ───

	describe('lint-passes', () => {
		let lintExitCode: number;
		let lintOutput: string;

		beforeAll(() => {
			try {
				lintOutput = execFileSync('npx', ['biome', 'check', '.'], {
					cwd: ROOT,
					encoding: 'utf-8',
					timeout: 60_000,
				});
				lintExitCode = 0;
			} catch (e: unknown) {
				const error = e as { status?: number; stdout?: string; stderr?: string };
				lintExitCode = error.status ?? 1;
				lintOutput = (error.stdout ?? '') + (error.stderr ?? '');
			}
		});

		it('npx biome check . exits 0', () => {
			expect(lintExitCode, `Lint failed:\n${lintOutput}`).toBe(0);
		});
	});

	// ─── Condition: workspace-resolution ───

	describe('workspace-resolution', () => {
		let lsOutput: string;

		beforeAll(() => {
			lsOutput = execFileSync('pnpm', ['ls', '--depth', '0', '-r'], {
				cwd: ROOT,
				encoding: 'utf-8',
				timeout: 30_000,
			});
		});

		it('pnpm ls shows all 8 workspace packages', () => {
			const expectedNames = [
				'@mulder/core',
				'@mulder/pipeline',
				'@mulder/retrieval',
				'@mulder/taxonomy',
				'@mulder/worker',
				'@mulder/evidence',
				'@mulder/cli',
				'@mulder/api',
			];
			for (const name of expectedNames) {
				expect(lsOutput, `Missing workspace package: ${name}`).toContain(name);
			}
		});

		it('internal dependencies resolve to workspace:*', () => {
			for (const pkg of PACKAGES) {
				const pkgJsonPath = resolve(ROOT, pkg, 'package.json');
				const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
				const deps = pkgJson.dependencies ?? {};

				for (const [depName, depVersion] of Object.entries(deps)) {
					if (depName.startsWith('@mulder/')) {
						expect(depVersion, `${pkg} dep ${depName} should use workspace:* but got ${depVersion}`).toBe(
							'workspace:*',
						);
					}
				}
			}
		});
	});

	// ─── Condition: package-structure ───

	describe('package-structure', () => {
		it('each of 8 packages has package.json, tsconfig.json, src/index.ts', () => {
			for (const pkg of PACKAGES) {
				const pkgJson = resolve(ROOT, pkg, 'package.json');
				const tsconfig = resolve(ROOT, pkg, 'tsconfig.json');
				const srcIndex = resolve(ROOT, pkg, 'src/index.ts');

				expect(existsSync(pkgJson), `Missing package.json in ${pkg}`).toBe(true);
				expect(existsSync(tsconfig), `Missing tsconfig.json in ${pkg}`).toBe(true);
				expect(existsSync(srcIndex), `Missing src/index.ts in ${pkg}`).toBe(true);
			}
		});

		it('directory structure matches section 13 layout', () => {
			for (const [pkg, subdirs] of Object.entries(EXPECTED_SUBDIRS)) {
				for (const subdir of subdirs) {
					const dirPath = resolve(ROOT, pkg, subdir);
					expect(existsSync(dirPath), `Missing directory: ${pkg}/${subdir}`).toBe(true);
				}
			}
		});
	});

	// ─── Condition: esm-only ───

	describe('esm-only', () => {
		it('every package.json has "type": "module"', () => {
			// Root package.json
			const rootPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
			expect(rootPkg.type, 'Root package.json missing "type": "module"').toBe('module');

			// All workspace packages
			for (const pkg of PACKAGES) {
				const pkgJson = JSON.parse(readFileSync(resolve(ROOT, pkg, 'package.json'), 'utf-8'));
				expect(pkgJson.type, `${pkg}/package.json missing "type": "module"`).toBe('module');
			}
		});

		it('tsconfig.base.json uses "module": "Node16"', () => {
			const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.base.json'), 'utf-8'));
			expect(tsconfig.compilerOptions.module).toBe('Node16');
		});

		it('no require() anywhere in source files', () => {
			// Search for require() in all .ts files under packages/ and apps/
			let grepOutput = '';
			let grepExitCode: number;
			try {
				grepOutput = execFileSync('grep', ['-r', '--include=*.ts', '-l', 'require(', 'packages/', 'apps/'], {
					cwd: ROOT,
					encoding: 'utf-8',
					timeout: 15_000,
				});
				grepExitCode = 0;
			} catch (e: unknown) {
				const error = e as { status?: number; stdout?: string };
				grepExitCode = error.status ?? 1;
				grepOutput = error.stdout ?? '';
			}

			// grep exits 1 when no matches found (which is what we want)
			if (grepExitCode === 0 && grepOutput.trim().length > 0) {
				// Filter out node_modules and dist directories
				const realMatches = grepOutput
					.trim()
					.split('\n')
					.filter((f) => !f.includes('node_modules') && !f.includes('/dist/'));
				expect(realMatches, `Files containing require(): ${realMatches.join(', ')}`).toHaveLength(0);
			}
		});
	});

	// ─── Condition: strict-mode ───

	describe('strict-mode', () => {
		it('tsconfig.base.json has "strict": true', () => {
			const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.base.json'), 'utf-8'));
			expect(tsconfig.compilerOptions.strict).toBe(true);
		});

		it('no `any` types in scaffolding source files', () => {
			// Check all src/index.ts files for `any` type annotations
			const anyFound: string[] = [];
			for (const pkg of PACKAGES) {
				const srcDir = resolve(ROOT, pkg, 'src');
				if (!existsSync(srcDir)) continue;

				try {
					const output = execFileSync('grep', ['-r', '--include=*.ts', '-n', ': any', srcDir], {
						cwd: ROOT,
						encoding: 'utf-8',
						timeout: 15_000,
					});
					if (output.trim()) {
						anyFound.push(`${pkg}: ${output.trim()}`);
					}
				} catch {
					// grep exits 1 = no matches, which is good
				}
			}
			expect(anyFound, `Found \`any\` types in:\n${anyFound.join('\n')}`).toHaveLength(0);
		});

		it('no `as` type assertions in scaffolding source files', () => {
			const asFound: string[] = [];
			for (const pkg of PACKAGES) {
				const srcDir = resolve(ROOT, pkg, 'src');
				if (!existsSync(srcDir)) continue;

				try {
					// Look for " as " pattern that indicates type assertions
					// Exclude common false positives like "import ... as ..."
					const output = execFileSync('grep', ['-r', '--include=*.ts', '-n', ' as [A-Z]', srcDir], {
						cwd: ROOT,
						encoding: 'utf-8',
						timeout: 15_000,
					});
					if (output.trim()) {
						// Filter out import aliases ("import X as Y")
						const lines = output
							.trim()
							.split('\n')
							.filter((line) => !line.includes('import'));
						if (lines.length > 0) {
							asFound.push(`${pkg}: ${lines.join('\n')}`);
						}
					}
				} catch {
					// grep exits 1 = no matches, which is good
				}
			}
			expect(asFound, `Found \`as\` assertions in:\n${asFound.join('\n')}`).toHaveLength(0);
		});
	});

	// ─── Condition: no-circular-deps ───

	describe('no-circular-deps', () => {
		it('packages/core has zero internal (@mulder/*) dependencies', () => {
			const pkgJson = JSON.parse(readFileSync(resolve(ROOT, 'packages/core/package.json'), 'utf-8'));
			const deps = pkgJson.dependencies ?? {};
			const internalDeps = Object.keys(deps).filter((d) => d.startsWith('@mulder/'));
			expect(
				internalDeps,
				`packages/core should have no internal deps but has: ${internalDeps.join(', ')}`,
			).toHaveLength(0);
		});

		it('package dependency graph is a DAG (no cycles)', () => {
			// Build adjacency list from package.json files
			const graph: Record<string, string[]> = {};

			for (const pkg of PACKAGES) {
				const pkgJson = JSON.parse(readFileSync(resolve(ROOT, pkg, 'package.json'), 'utf-8'));
				const name: string = pkgJson.name;
				const deps = pkgJson.dependencies ?? {};
				graph[name] = Object.keys(deps).filter((d) => d.startsWith('@mulder/'));
			}

			// Topological sort via DFS to detect cycles
			const visited = new Set<string>();
			const inStack = new Set<string>();
			const cyclePath: string[] = [];

			function hasCycle(node: string): boolean {
				if (inStack.has(node)) {
					cyclePath.push(node);
					return true;
				}
				if (visited.has(node)) return false;

				visited.add(node);
				inStack.add(node);

				for (const neighbor of graph[node] ?? []) {
					if (hasCycle(neighbor)) {
						cyclePath.push(node);
						return true;
					}
				}

				inStack.delete(node);
				return false;
			}

			let cycleDetected = false;
			for (const node of Object.keys(graph)) {
				if (hasCycle(node)) {
					cycleDetected = true;
					break;
				}
			}

			expect(cycleDetected, `Circular dependency detected: ${cyclePath.reverse().join(' -> ')}`).toBe(false);
		});

		it('dependency graph matches expected structure from spec', () => {
			for (const pkg of PACKAGES) {
				const pkgJson = JSON.parse(readFileSync(resolve(ROOT, pkg, 'package.json'), 'utf-8'));
				const deps = pkgJson.dependencies ?? {};
				const internalDeps = Object.keys(deps)
					.filter((d) => d.startsWith('@mulder/'))
					.sort();
				const expected = (EXPECTED_DEPS[pkg] ?? []).sort();

				expect(
					internalDeps,
					`${pkg} internal deps mismatch. Expected: [${expected.join(', ')}], Got: [${internalDeps.join(', ')}]`,
				).toEqual(expected);
			}
		});
	});
});
