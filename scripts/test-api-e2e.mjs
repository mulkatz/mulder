import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SPECS_DIR = resolve(ROOT, 'docs/specs');
const TESTS_DIR = resolve(ROOT, 'tests/specs');
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');
const API_STEP_PATTERN = /^M7-H([3-9]|10)$/;

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
	return match ? match[1] : '';
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

function collectApiSpecNumbers() {
	if (!existsSync(SPECS_DIR)) {
		throw new Error(`Specs directory not found: ${SPECS_DIR}`);
	}

	return walkFiles(SPECS_DIR, (name) => name.endsWith('.spec.md'))
		.map((filePath) => {
			const frontmatter = readFrontmatter(filePath);
			const spec = extractField(frontmatter, 'spec');
			const roadmapStep = extractField(frontmatter, 'roadmap_step');
			if (!spec || !roadmapStep || !API_STEP_PATTERN.test(roadmapStep)) {
				return null;
			}

			return String(Number.parseInt(spec, 10)).padStart(2, '0');
		})
		.filter(Boolean);
}

function collectApiTestFiles() {
	if (!existsSync(TESTS_DIR)) {
		throw new Error(`Tests directory not found: ${TESTS_DIR}`);
	}

	const apiSpecs = new Set(collectApiSpecNumbers());
	const files = walkFiles(TESTS_DIR, (name) => name.endsWith('.test.ts'))
		.map((filePath) => filePath.slice(ROOT.length + 1))
		.filter((relativePath) => {
			const match = relativePath.match(/^tests\/specs\/(\d+)_.*\.test\.ts$/);
			if (!match) {
				return false;
			}

			const spec = String(Number.parseInt(match[1], 10)).padStart(2, '0');
			return apiSpecs.has(spec);
		});

	if (files.length === 0) {
		throw new Error('No API end-to-end test files found for M7-H3..H10.');
	}

	return files;
}

function printSelection(files) {
	process.stdout.write(['api_e2e', `Files: ${files.length}`, ...files.map((file) => ` - ${file}`), ''].join('\n'));
}

const rawArgs = process.argv.slice(2);
const normalizedArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const command = normalizedArgs[0] ?? 'run';
const splitIndex = normalizedArgs.indexOf('--');
const extraArgs = splitIndex === -1 ? [] : normalizedArgs.slice(splitIndex + 1);

try {
	const files = collectApiTestFiles();

	if (command === 'list') {
		printSelection(files);
	} else if (command === 'run') {
		const result = spawnSync(process.execPath, [VITEST, 'run', ...extraArgs, ...files], {
			cwd: ROOT,
			stdio: 'inherit',
			env: process.env,
		});
		process.exit(result.status ?? 1);
	} else {
		throw new Error('Usage: node scripts/test-api-e2e.mjs <list|run> [-- <vitest args...>]');
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
