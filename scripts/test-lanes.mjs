import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SEARCH_ROOTS = ['tests/specs', 'packages', 'apps'].map((path) => resolve(ROOT, path));
const MANIFEST_PATH = resolve(ROOT, 'tests/test-runtime-manifest.json');
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');
const TEST_RUNNER = resolve(ROOT, 'scripts/test-runner.mjs');

const SERIAL_VITEST_ARGS = ['--no-file-parallelism', '--maxWorkers=1'];
const PARALLEL_VITEST_ARGS = ['--fileParallelism=true'];

function usage() {
	return [
		'Usage:',
		'  node scripts/test-lanes.mjs verify [lane] [shardTotal]',
		'  node scripts/test-lanes.mjs summary <lane> [shardIndex shardTotal]',
		'  node scripts/test-lanes.mjs list <lane> [shardIndex shardTotal]',
		'  node scripts/test-lanes.mjs run <lane> [shardIndex shardTotal] [-- vitest args...]',
		'  node scripts/test-lanes.mjs affected [baseRef] [-- vitest args...]',
		'',
		'Lanes: unit, schema, db, heavy, external',
	].join('\n');
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

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

function listDiscoveredFiles() {
	return SEARCH_ROOTS.flatMap((root) => (existsSync(root) ? walkTests(root) : []))
		.map((fullPath) => ({
			fullPath,
			relativePath: fullPath.slice(ROOT.length + 1).replaceAll('\\', '/'),
			lineCount: readFileSync(fullPath, 'utf8').split('\n').length,
		}))
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function loadManifest() {
	if (!existsSync(MANIFEST_PATH)) {
		throw new Error(`Runtime manifest not found: ${MANIFEST_PATH}`);
	}
	return readJson(MANIFEST_PATH);
}

function fileWeight(file, manifest, explicitWeight) {
	if (Number.isFinite(explicitWeight)) {
		return explicitWeight;
	}
	const manifestWeight = manifest.fileWeights?.[file.relativePath];
	if (Number.isFinite(manifestWeight)) {
		return manifestWeight;
	}
	return Math.max(Number(manifest.defaultWeight ?? 600), file.lineCount);
}

function asWeightedFiles(paths, discoveredByPath, manifest, explicitWeights = {}) {
	return [...paths]
		.sort((a, b) => a.localeCompare(b))
		.map((relativePath) => {
			const discovered = discoveredByPath.get(relativePath);
			if (!discovered) {
				throw new Error(`Lane file is not present in the repository: ${relativePath}`);
			}
			return {
				...discovered,
				weight: fileWeight(discovered, manifest, explicitWeights[relativePath]),
			};
		});
}

function classifyFiles() {
	const manifest = loadManifest();
	const discovered = listDiscoveredFiles();
	const discoveredByPath = new Map(discovered.map((file) => [file.relativePath, file]));
	const schemaPaths = new Set(Object.keys(manifest.schemaFiles ?? {}));
	const heavyPaths = new Set(Object.keys(manifest.heavyFiles ?? {}));
	const externalPaths = new Set(Object.keys(manifest.externalFiles ?? {}));

	for (const [firstName, firstSet, secondName, secondSet] of [
		['schema', schemaPaths, 'heavy', heavyPaths],
		['schema', schemaPaths, 'external', externalPaths],
		['heavy', heavyPaths, 'external', externalPaths],
	]) {
		for (const path of firstSet) {
			if (secondSet.has(path)) {
				throw new Error(`Test file appears in both ${firstName} and ${secondName} lanes: ${path}`);
			}
		}
	}

	const unitPaths = discovered
		.filter((file) => file.relativePath.startsWith('packages/') || file.relativePath.startsWith('apps/'))
		.map((file) => file.relativePath);

	const dbPaths = discovered
		.filter((file) => file.relativePath.startsWith('tests/specs/'))
		.map((file) => file.relativePath)
		.filter((path) => !schemaPaths.has(path) && !heavyPaths.has(path) && !externalPaths.has(path));

	return {
		manifest,
		discovered,
		discoveredByPath,
		lanes: {
			unit: {
				serial: false,
				files: asWeightedFiles(unitPaths, discoveredByPath, manifest),
			},
			schema: {
				serial: true,
				files: asWeightedFiles(schemaPaths, discoveredByPath, manifest, manifest.schemaFiles ?? {}),
			},
			db: {
				serial: true,
				files: asWeightedFiles(dbPaths, discoveredByPath, manifest),
			},
			heavy: {
				serial: true,
				files: asWeightedFiles(heavyPaths, discoveredByPath, manifest, manifest.heavyFiles ?? {}),
			},
			external: {
				serial: true,
				files: asWeightedFiles(externalPaths, discoveredByPath, manifest, manifest.externalFiles ?? {}),
			},
		},
	};
}

function getLane(laneName) {
	const { lanes } = classifyFiles();
	const lane = lanes[laneName];
	if (!lane) {
		throw new Error(`Unknown lane: ${laneName}\n${usage()}`);
	}
	return lane;
}

function partitionFiles(files, shardTotal) {
	if (!Number.isInteger(shardTotal) || shardTotal <= 0) {
		throw new Error(`Shard total must be a positive integer, got: ${shardTotal}`);
	}

	const shards = Array.from({ length: shardTotal }, (_, index) => ({
		index: index + 1,
		totalWeight: 0,
		files: [],
	}));

	for (const file of [...files].sort((a, b) => b.weight - a.weight || a.relativePath.localeCompare(b.relativePath))) {
		shards.sort((a, b) => a.totalWeight - b.totalWeight || a.index - b.index);
		shards[0].files.push(file);
		shards[0].totalWeight += file.weight;
	}

	return shards.sort((a, b) => a.index - b.index);
}

function selectFiles(laneName, shardIndex, shardTotal) {
	const lane = getLane(laneName);
	if (shardIndex === null || shardTotal === null) {
		return {
			lane,
			shard: { index: 1, totalWeight: lane.files.reduce((sum, file) => sum + file.weight, 0), files: lane.files },
		};
	}

	if (!Number.isInteger(shardIndex) || shardIndex <= 0 || shardIndex > shardTotal) {
		throw new Error(`Shard index must be between 1 and ${shardTotal}, got: ${shardIndex}`);
	}

	return { lane, shard: partitionFiles(lane.files, shardTotal)[shardIndex - 1] };
}

function formatPlan(label, files, totalWeight) {
	return [
		label,
		`Files: ${files.length}`,
		`Estimated weight: ${totalWeight}`,
		...files.map((file) => ` - ${file.relativePath} (${file.weight})`),
		'',
	].join('\n');
}

function printSummary(laneName, shardIndex, shardTotal) {
	const { shard } = selectFiles(laneName, shardIndex, shardTotal);
	const label = shardTotal === null ? `Lane ${laneName}` : `Lane ${laneName} shard ${shard.index}/${shardTotal}`;
	process.stdout.write(formatPlan(label, shard.files, shard.totalWeight));
}

function printList(laneName, shardIndex, shardTotal) {
	const { shard } = selectFiles(laneName, shardIndex, shardTotal);
	process.stdout.write(`${shard.files.map((file) => file.relativePath).join('\n')}\n`);
}

function verify(laneName = null, shardTotal = null) {
	const { discovered, lanes } = classifyFiles();
	const laneNames = laneName ? [laneName] : Object.keys(lanes);
	const assigned = [];

	for (const name of laneNames) {
		const lane = lanes[name];
		if (!lane) {
			throw new Error(`Unknown lane: ${name}`);
		}
		assigned.push(...lane.files.map((file) => file.relativePath));
		if (shardTotal !== null) {
			const shards = partitionFiles(lane.files, shardTotal);
			const shardFiles = shards.flatMap((shard) => shard.files.map((file) => file.relativePath));
			if (new Set(shardFiles).size !== lane.files.length) {
				throw new Error(`Lane ${name} shard partition contains duplicates.`);
			}
		}
	}

	if (!laneName) {
		const uniqueAssigned = new Set(assigned);
		const discoveredPaths = discovered.map((file) => file.relativePath);
		if (assigned.length !== uniqueAssigned.size) {
			throw new Error('A test file is assigned to more than one lane.');
		}
		if (uniqueAssigned.size !== discoveredPaths.length) {
			const missing = discoveredPaths.filter((path) => !uniqueAssigned.has(path));
			throw new Error(`Lane assignment missing files:\n${missing.join('\n')}`);
		}
	}

	process.stdout.write(
		[
			laneName ? `Verified lane ${laneName}` : 'Verified all test lanes',
			...laneNames.map((name) => {
				const lane = lanes[name];
				const weight = lane.files.reduce((sum, file) => sum + file.weight, 0);
				return ` - ${name}: ${lane.files.length} files, estimated weight ${weight}`;
			}),
			'',
		].join('\n'),
	);
}

function splitCommandArgs(args) {
	const splitIndex = args.indexOf('--');
	if (splitIndex === -1) {
		return { commandArgs: args, extraArgs: [] };
	}
	return { commandArgs: args.slice(0, splitIndex), extraArgs: args.slice(splitIndex + 1) };
}

function runVitest(label, files, serial, extraArgs) {
	if (files.length === 0) {
		process.stdout.write(`No tests selected for ${label}; passing.\n`);
		return 0;
	}

	const vitestArgs = [
		'run',
		...(serial ? SERIAL_VITEST_ARGS : PARALLEL_VITEST_ARGS),
		...extraArgs,
		...files.map((file) => file.relativePath),
	];
	const result = spawnSync(
		process.execPath,
		[TEST_RUNNER, 'run', label, '--', process.execPath, VITEST, ...vitestArgs],
		{
			cwd: ROOT,
			stdio: 'inherit',
			env: process.env,
		},
	);

	return result.status ?? 1;
}

function runLane(laneName, shardIndex, shardTotal, extraArgs) {
	const { lane, shard } = selectFiles(laneName, shardIndex, shardTotal);
	const label = shardTotal === null ? laneName : `${laneName}-${shard.index}-of-${shardTotal}`;
	process.stdout.write(formatPlan(`Running ${label}`, shard.files, shard.totalWeight));
	process.exit(runVitest(label, shard.files, lane.serial, extraArgs));
}

function gitChangedFiles(baseRef) {
	const args = baseRef ? ['diff', '--name-only', `${baseRef}...HEAD`] : ['diff', '--name-only', 'HEAD'];
	let result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	if (result.status !== 0 && baseRef) {
		result = spawnSync('git', ['diff', '--name-only', baseRef], {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	}
	if (result.status !== 0) {
		throw new Error(`Unable to compute changed files: ${result.stderr.trim()}`);
	}
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

function testsForSpecNumber(specNumber, discoveredByPath) {
	const padded = String(Number.parseInt(specNumber, 10)).padStart(2, '0');
	return [...discoveredByPath.keys()].filter((path) => path.startsWith(`tests/specs/${padded}_`));
}

function addSpecTests(selected, discoveredByPath, specNumbers) {
	for (const specNumber of specNumbers) {
		for (const testPath of testsForSpecNumber(specNumber, discoveredByPath)) {
			selected.add(testPath);
		}
	}
}

function addLaneFiles(selected, lanes, laneNames) {
	for (const laneName of laneNames) {
		for (const testFile of lanes[laneName].files) {
			selected.add(testFile.relativePath);
		}
	}
}

function removeHealthSmokeTests(selected) {
	selected.delete('tests/specs/44_e2e_pipeline_integration.test.ts');
}

function selectAffectedFiles(baseRef) {
	const { discoveredByPath, lanes } = classifyFiles();
	const weightedByPath = new Map(
		Object.values(lanes).flatMap((lane) => lane.files.map((file) => [file.relativePath, file])),
	);
	const changed = gitChangedFiles(baseRef);
	const selected = new Set();

	for (const file of changed) {
		if (discoveredByPath.has(file)) {
			selected.add(file);
			continue;
		}

		const specMatch = file.match(/^docs\/specs\/(\d+)_.*\.spec\.md$/);
		if (specMatch) {
			addSpecTests(selected, discoveredByPath, [specMatch[1]]);
			continue;
		}

		if (
			/^(package\.json|pnpm-lock\.yaml|vitest\.config\.ts|scripts\/test-|tests\/test-runtime-manifest\.json|\.github\/workflows\/ci\.yml)$/.test(
				file,
			)
		) {
			addLaneFiles(selected, lanes, ['schema', 'db', 'heavy']);
			continue;
		}

		if (file.startsWith('packages/core/src/database/')) {
			addSpecTests(selected, discoveredByPath, [
				'07',
				'08',
				'09',
				'14',
				'22',
				'24',
				'25',
				'32',
				'38',
				'39',
				'54',
				'67',
			]);
			continue;
		}

		if (file.startsWith('packages/worker/')) {
			addSpecTests(selected, discoveredByPath, ['68', '77', '78', '79', '80', '81']);
			continue;
		}

		if (file.startsWith('apps/api/')) {
			addSpecTests(selected, discoveredByPath, [
				'69',
				'70',
				'71',
				'72',
				'73',
				'74',
				'75',
				'76',
				'77',
				'80',
				'89',
				'90',
				'98',
			]);
			continue;
		}

		if (file.startsWith('apps/cli/')) {
			addSpecTests(selected, discoveredByPath, [
				'06',
				'16',
				'20',
				'45',
				'46',
				'49',
				'51',
				'53',
				'88',
				'89',
				'90',
				'91',
				'92',
				'96',
				'98',
			]);
			continue;
		}

		if (file.startsWith('packages/pipeline/') || file.startsWith('packages/core/src/shared/')) {
			addSpecTests(selected, discoveredByPath, [
				'16',
				'19',
				'23',
				'29',
				'34',
				'35',
				'36',
				'44',
				'77',
				'86',
				'87',
				'88',
				'89',
				'90',
				'91',
				'92',
				'93',
				'94',
				'95',
				'96',
				'97',
				'98',
			]);
			continue;
		}

		if (file.startsWith('apps/') || file.startsWith('packages/') || file.startsWith('tests/lib/')) {
			addLaneFiles(selected, lanes, ['schema', 'db', 'heavy']);
		}
	}

	if (process.env.MULDER_TEST_SKIP_HEALTH_SPEC_IN_AFFECTED === 'true') {
		removeHealthSmokeTests(selected);
	}

	return [...selected]
		.sort((a, b) => a.localeCompare(b))
		.map((path) => weightedByPath.get(path))
		.filter(Boolean);
}

function laneNameForFile(relativePath, lanes) {
	for (const [laneName, lane] of Object.entries(lanes)) {
		if (lane.files.some((file) => file.relativePath === relativePath)) {
			return laneName;
		}
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

function runAffected(baseRef, extraArgs) {
	const { lanes } = classifyFiles();
	const files = selectAffectedFiles(baseRef);
	const weight = files.reduce((sum, file) => sum + file.weight, 0);
	process.stdout.write(formatPlan(`Affected tests${baseRef ? ` against ${baseRef}` : ''}`, files, weight));

	const laneOrder = ['unit', 'schema', 'db', 'heavy', 'external'];
	const filesByLane = new Map(laneOrder.map((laneName) => [laneName, []]));
	for (const file of files) {
		filesByLane.get(laneNameForFile(file.relativePath, lanes)).push(file);
	}

	let exitCode = 0;
	const selectedLaneCount = [...filesByLane.values()].filter((laneFiles) => laneFiles.length > 0).length;
	for (const laneName of laneOrder) {
		const laneFiles = filesByLane.get(laneName);
		if (laneFiles.length === 0) {
			continue;
		}
		const lane = lanes[laneName];
		const groupWeight = laneFiles.reduce((sum, file) => sum + file.weight, 0);
		process.stdout.write(formatPlan(`Affected ${laneName}`, laneFiles, groupWeight));
		const groupExtraArgs = selectedLaneCount > 1 ? rewriteJUnitOutputArgs(extraArgs, laneName) : extraArgs;
		const groupExitCode = runVitest(`affected-${laneName}`, laneFiles, lane.serial, groupExtraArgs);
		if (groupExitCode !== 0) {
			exitCode = groupExitCode;
		}
	}

	process.exit(exitCode);
}

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];
const argsAfterCommand = rawArgs[1] === '--' ? rawArgs.slice(2) : rawArgs.slice(1);
const { commandArgs, extraArgs } = splitCommandArgs(argsAfterCommand);

try {
	if (command === 'verify') {
		const [laneName, shardTotalRaw] = commandArgs;
		verify(laneName ?? null, shardTotalRaw ? Number.parseInt(shardTotalRaw, 10) : null);
	} else if (command === 'summary') {
		const [laneName, shardIndexRaw, shardTotalRaw] = commandArgs;
		if (!laneName) throw new Error(usage());
		printSummary(
			laneName,
			shardIndexRaw ? Number.parseInt(shardIndexRaw, 10) : null,
			shardTotalRaw ? Number.parseInt(shardTotalRaw, 10) : null,
		);
	} else if (command === 'list') {
		const [laneName, shardIndexRaw, shardTotalRaw] = commandArgs;
		if (!laneName) throw new Error(usage());
		printList(
			laneName,
			shardIndexRaw ? Number.parseInt(shardIndexRaw, 10) : null,
			shardTotalRaw ? Number.parseInt(shardTotalRaw, 10) : null,
		);
	} else if (command === 'run') {
		const [laneName, maybeShardIndex, maybeShardTotal] = commandArgs;
		if (!laneName) throw new Error(usage());
		runLane(
			laneName,
			maybeShardIndex ? Number.parseInt(maybeShardIndex, 10) : null,
			maybeShardTotal ? Number.parseInt(maybeShardTotal, 10) : null,
			extraArgs,
		);
	} else if (command === 'affected') {
		const [baseRef] = commandArgs;
		runAffected(baseRef, extraArgs);
	} else {
		throw new Error(usage());
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
