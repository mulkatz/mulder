import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SPECS_DIR = resolve(ROOT, 'docs/specs');
const TESTS_DIR = resolve(ROOT, 'tests/specs');
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');

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
	const testsBySpec = new Map();

	for (const filePath of testFiles) {
		const relativePath = filePath.slice(ROOT.length + 1);
		const match = relativePath.match(/^tests\/specs\/(\d+)_.*\.test\.ts$/);
		if (!match) {
			continue;
		}

		const spec = String(Number.parseInt(match[1], 10)).padStart(2, '0');
		const tests = testsBySpec.get(spec) ?? [];
		tests.push(relativePath);
		testsBySpec.set(spec, tests);
	}

	return testsBySpec;
}

function resolveScope(scopeType, scopeValue) {
	const specIndex = loadSpecIndex();
	const testsBySpec = loadTestsBySpec();

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

	const files = matchingSpecs.flatMap((entry) => testsBySpec.get(entry.spec) ?? []);

	if (files.length === 0) {
		throw new Error(`No tests found for ${scopeType} ${scopeValue}.`);
	}

	return {
		scopeType,
		scopeValue,
		specs: matchingSpecs.map((entry) => `${entry.spec} (${entry.roadmapStep})`),
		files: files.sort((a, b) => a.localeCompare(b)),
	};
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
	const result = spawnSync(process.execPath, [VITEST, 'run', ...extraArgs, ...selection.files], {
		cwd: ROOT,
		stdio: 'inherit',
		env: process.env,
	});

	process.exit(result.status ?? 1);
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
