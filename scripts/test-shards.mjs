import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SEARCH_ROOTS = ['tests/specs', 'packages', 'apps'].map((path) => resolve(ROOT, path));
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');
const VITEST_SHARD_ARGS = ['--no-file-parallelism', '--maxWorkers=1'];

function walkTests(root) {
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
			if (entry.isFile() && entry.name.endsWith('.test.ts')) {
				files.push(fullPath);
			}
		}
	}

	return files;
}

function listTestFiles() {
	return SEARCH_ROOTS.flatMap((root) => (existsSync(root) ? walkTests(root) : []))
		.map((fullPath) => ({
			fullPath,
			relativePath: fullPath.slice(ROOT.length + 1),
			weight: readFileSync(fullPath, 'utf8').split('\n').length,
		}))
		.sort((a, b) => b.weight - a.weight || a.relativePath.localeCompare(b.relativePath));
}

function partitionFiles(shardTotal) {
	if (!Number.isInteger(shardTotal) || shardTotal <= 0) {
		throw new Error(`Shard total must be a positive integer, got: ${shardTotal}`);
	}

	const shards = Array.from({ length: shardTotal }, (_, index) => ({
		index: index + 1,
		totalWeight: 0,
		files: [],
	}));

	for (const file of listTestFiles()) {
		shards.sort((a, b) => a.totalWeight - b.totalWeight || a.index - b.index);
		shards[0].files.push(file);
		shards[0].totalWeight += file.weight;
	}

	return shards.sort((a, b) => a.index - b.index);
}

function getShard(shardIndex, shardTotal) {
	if (!Number.isInteger(shardIndex) || shardIndex <= 0 || shardIndex > shardTotal) {
		throw new Error(`Shard index must be between 1 and ${shardTotal}, got: ${shardIndex}`);
	}

	return partitionFiles(shardTotal)[shardIndex - 1];
}

function printSummary(shardIndex, shardTotal) {
	const shard = getShard(shardIndex, shardTotal);
	process.stdout.write(
		[
			`Shard ${shard.index}/${shardTotal}`,
			`Files: ${shard.files.length}`,
			`Weight: ${shard.totalWeight}`,
			...shard.files.map((file) => ` - ${file.relativePath} (${file.weight})`),
			'',
		].join('\n'),
	);
}

function printList(shardIndex, shardTotal) {
	const shard = getShard(shardIndex, shardTotal);
	process.stdout.write(`${shard.files.map((file) => file.relativePath).join('\n')}\n`);
}

function verify(shardTotal) {
	const shards = partitionFiles(shardTotal);
	const allFiles = shards.flatMap((shard) => shard.files.map((file) => file.relativePath));
	const uniqueFiles = new Set(allFiles);
	const discoveredFiles = listTestFiles().map((file) => file.relativePath);

	if (allFiles.length !== uniqueFiles.size) {
		throw new Error('Shard partition contains duplicate files.');
	}

	if (uniqueFiles.size !== discoveredFiles.length) {
		throw new Error(`Shard partition missing files: expected ${discoveredFiles.length}, got ${uniqueFiles.size}`);
	}

	process.stdout.write(
		[
			`Verified ${shardTotal} shards`,
			...shards.map((shard) => ` - shard ${shard.index}: ${shard.files.length} files, weight ${shard.totalWeight}`),
			'',
		].join('\n'),
	);
}

function runVitest(shardIndex, shardTotal, extraArgs) {
	const shard = getShard(shardIndex, shardTotal);
	if (shard.files.length === 0) {
		throw new Error(`Shard ${shardIndex}/${shardTotal} has no test files.`);
	}

	const result = spawnSync(
		process.execPath,
		[VITEST, 'run', ...VITEST_SHARD_ARGS, ...extraArgs, ...shard.files.map((file) => file.relativePath)],
		{
			cwd: ROOT,
			stdio: 'inherit',
			env: process.env,
		},
	);

	process.exit(result.status ?? 1);
}

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];
const commandArgs = rawArgs[1] === '--' ? rawArgs.slice(2) : rawArgs.slice(1);
const [firstArg, secondArg, ...extraArgs] = commandArgs;

try {
	if (command === 'verify') {
		verify(Number.parseInt(firstArg ?? '', 10));
	} else if (command === 'summary') {
		printSummary(Number.parseInt(firstArg ?? '', 10), Number.parseInt(secondArg ?? '', 10));
	} else if (command === 'list') {
		printList(Number.parseInt(firstArg ?? '', 10), Number.parseInt(secondArg ?? '', 10));
	} else if (command === 'run') {
		runVitest(Number.parseInt(firstArg ?? '', 10), Number.parseInt(secondArg ?? '', 10), extraArgs);
	} else {
		throw new Error(
			'Usage: node scripts/test-shards.mjs <verify N | summary I N | list I N | run I N [vitest args...]>',
		);
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
