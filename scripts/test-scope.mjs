import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SPECS_DIR = resolve(ROOT, 'docs/specs');
const TESTS_DIR = resolve(ROOT, 'tests/specs');
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');
const TEST_RUNNER = resolve(ROOT, 'scripts/test-runner.mjs');
const MANIFEST_PATH = resolve(ROOT, 'tests/test-runtime-manifest.json');

const SERIAL_VITEST_ARGS = ['--no-file-parallelism', '--maxWorkers=1'];
const PARALLEL_VITEST_ARGS = ['--fileParallelism=true'];
const LANE_ORDER = ['unit', 'schema', 'db', 'heavy', 'external'];

const SPEC_TEST_OVERRIDES = new Map([['77_document_observability_aggregation', ['77_document_observability_route']]]);

function walkFiles(root, predicate) {
	const files = [];
	const queue = [root];

	while (queue.length > 0) {
		const current = queue.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = resolve(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(fullPath);
				continue;
			}
			if (entry.isFile() && predicate(entry.name)) {
				files.push(fullPath);
			}
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

function readFrontmatter(filePath) {
	const content = readFileSync(filePath, 'utf8');
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) {
		return '';
	}
	return match[1];
}

function extractField(frontmatter, fieldName) {
	const match = frontmatter.match(new RegExp(`^${fieldName}:\\s*(.+)$`, 'm'));
	if (!match) {
		return null;
	}

	const rawValue = match[1].trim();
	if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
		return rawValue.slice(1, -1);
	}

	return rawValue;
}

function loadSpecIndex() {
	if (!existsSync(SPECS_DIR)) {
		throw new Error(`Specs directory not found: ${SPECS_DIR}`);
	}

	const specFiles = walkFiles(SPECS_DIR, (name) => name.endsWith('.spec.md'));
	return specFiles
		.map((filePath) => {
			const frontmatter = readFrontmatter(filePath);
			const spec = extractField(frontmatter, 'spec');
			const roadmapStep = extractField(frontmatter, 'roadmap_step');
			if (!spec || !roadmapStep) {
				return null;
			}

			return {
				spec: String(Number.parseInt(spec, 10)).padStart(2, '0'),
				key: filePath
					.slice(SPECS_DIR.length + 1)
					.replace(/\.spec\.md$/, '')
					.replaceAll('\\', '/'),
				roadmapStep,
				filePath,
			};
		})
		.filter(Boolean);
}

function loadTestsBySpec() {
	if (!existsSync(TESTS_DIR)) {
		throw new Error(`Tests directory not found: ${TESTS_DIR}`);
	}

	const testFiles = walkFiles(TESTS_DIR, (name) => name.endsWith('.test.ts'));
	const tests = [];

	for (const filePath of testFiles) {
		const relativePath = filePath.slice(ROOT.length + 1);
		const match = relativePath.match(/^tests\/specs\/(\d+)_.*\.test\.ts$/);
		if (!match) {
			continue;
		}

		const spec = String(Number.parseInt(match[1], 10)).padStart(2, '0');
		tests.push({
			spec,
			key: relativePath.replace(/^tests\/specs\//, '').replace(/\.test\.ts$/, ''),
			relativePath,
		});
	}

	return tests;
}

function resolveTestsForSpecs(matchingSpecs, specIndex, tests) {
	const specCounts = new Map();
	for (const entry of specIndex) {
		specCounts.set(entry.spec, (specCounts.get(entry.spec) ?? 0) + 1);
	}

	const files = new Set();
	for (const entry of matchingSpecs) {
		const overrideKeys = SPEC_TEST_OVERRIDES.get(entry.key);
		if (overrideKeys) {
			for (const key of overrideKeys) {
				for (const test of tests.filter((candidate) => candidate.key === key)) {
					files.add(test.relativePath);
				}
			}
			continue;
		}

		const exactMatches = tests.filter((test) => test.key === entry.key);
		if (exactMatches.length > 0) {
			for (const test of exactMatches) {
				files.add(test.relativePath);
			}
			continue;
		}

		if ((specCounts.get(entry.spec) ?? 0) === 1) {
			for (const test of tests.filter((candidate) => candidate.spec === entry.spec)) {
				files.add(test.relativePath);
			}
		}
	}

	return [...files].sort((a, b) => a.localeCompare(b));
}

function resolveScope(scopeType, scopeValue) {
	const specIndex = loadSpecIndex();
	const tests = loadTestsBySpec();

	const matchingSpecs = specIndex.filter((entry) => {
		if (scopeType === 'step') {
			return entry.roadmapStep === scopeValue;
		}
		if (scopeType === 'milestone') {
			return entry.roadmapStep.startsWith(`${scopeValue}-`);
		}
		throw new Error(`Unknown scope type: ${scopeType}`);
	});

	if (matchingSpecs.length === 0) {
		throw new Error(`No specs found for ${scopeType} ${scopeValue}.`);
	}

	const files = resolveTestsForSpecs(matchingSpecs, specIndex, tests);

	if (files.length === 0) {
		throw new Error(`No tests found for ${scopeType} ${scopeValue}.`);
	}

	return {
		scopeType,
		scopeValue,
		specs: matchingSpecs.map((entry) => `${entry.key} (${entry.roadmapStep})`),
		files,
	};
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function loadManifest() {
	if (!existsSync(MANIFEST_PATH)) {
		throw new Error(`Runtime manifest not found: ${MANIFEST_PATH}`);
	}
	return readJson(MANIFEST_PATH);
}

function laneNameForFile(relativePath, manifest) {
	if (relativePath.startsWith('packages/') || relativePath.startsWith('apps/')) {
		return 'unit';
	}
	if (Object.hasOwn(manifest.schemaFiles ?? {}, relativePath)) {
		return 'schema';
	}
	if (Object.hasOwn(manifest.heavyFiles ?? {}, relativePath)) {
		return 'heavy';
	}
	if (Object.hasOwn(manifest.externalFiles ?? {}, relativePath)) {
		return 'external';
	}
	return 'db';
}

function rewriteJUnitOutputArgs(extraArgs, suffix) {
	return extraArgs.map((arg) => {
		const prefix = '--outputFile.junit=';
		if (!arg.startsWith(prefix)) {
			return arg;
		}
		const path = arg.slice(prefix.length);
		const extensionIndex = path.lastIndexOf('.');
		const suffixed =
			extensionIndex === -1
				? `${path}-${suffix}`
				: `${path.slice(0, extensionIndex)}-${suffix}${path.slice(extensionIndex)}`;
		return `${prefix}${suffixed}`;
	});
}

function printSelection(selection) {
	process.stdout.write(
		[
			`${selection.scopeType}: ${selection.scopeValue}`,
			`Specs: ${selection.specs.join(', ')}`,
			`Files: ${selection.files.length}`,
			...selection.files.map((file) => ` - ${file}`),
			'',
		].join('\n'),
	);
}

function runVitest(selection, extraArgs) {
	const manifest = loadManifest();
	const filesByLane = new Map(LANE_ORDER.map((laneName) => [laneName, []]));
	for (const file of selection.files) {
		filesByLane.get(laneNameForFile(file, manifest)).push(file);
	}

	let exitCode = 0;
	const selectedLaneCount = [...filesByLane.values()].filter((files) => files.length > 0).length;
	for (const laneName of LANE_ORDER) {
		const laneFiles = filesByLane.get(laneName);
		if (laneFiles.length === 0) {
			continue;
		}

		const label = `scope-${selection.scopeType}-${selection.scopeValue}-${laneName}`;
		const groupExtraArgs = selectedLaneCount > 1 ? rewriteJUnitOutputArgs(extraArgs, laneName) : extraArgs;
		const vitestArgs = laneName === 'unit' ? PARALLEL_VITEST_ARGS : SERIAL_VITEST_ARGS;
		process.stdout.write(
			[`Scope lane ${laneName}`, `Files: ${laneFiles.length}`, ...laneFiles.map((file) => ` - ${file}`), ''].join('\n'),
		);

		const result = spawnSync(
			process.execPath,
			[
				TEST_RUNNER,
				'run',
				label,
				'--',
				process.execPath,
				VITEST,
				'run',
				...vitestArgs,
				...groupExtraArgs,
				...laneFiles,
			],
			{
				cwd: ROOT,
				stdio: 'inherit',
				env: process.env,
			},
		);
		if ((result.status ?? 1) !== 0) {
			exitCode = result.status ?? 1;
		}
	}

	process.exit(exitCode);
}

const rawArgs = process.argv.slice(2);
const normalizedArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const command = normalizedArgs[0];
const splitIndex = normalizedArgs.indexOf('--');
const commandArgs = splitIndex === -1 ? normalizedArgs.slice(1) : normalizedArgs.slice(1, splitIndex);
const extraArgs = splitIndex === -1 ? [] : normalizedArgs.slice(splitIndex + 1);
const [scopeType, scopeValue] = commandArgs;

try {
	if (!scopeType || !scopeValue) {
		throw new Error('Usage: node scripts/test-scope.mjs <list|run> <milestone|step> <value> [-- <vitest args...>]');
	}

	if (scopeType !== 'milestone' && scopeType !== 'step') {
		throw new Error(`Scope type must be "milestone" or "step", got: ${scopeType}`);
	}

	const selection = resolveScope(scopeType, scopeValue);

	if (command === 'list') {
		printSelection(selection);
	} else if (command === 'run') {
		runVitest(selection, extraArgs);
	} else {
		throw new Error('Usage: node scripts/test-scope.mjs <list|run> <milestone|step> <value> [-- <vitest args...>]');
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
