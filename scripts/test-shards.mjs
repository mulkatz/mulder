import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const TEST_LANES = resolve(ROOT, 'scripts/test-lanes.mjs');

const [command, ...args] = process.argv.slice(2);
const translated = ['node', TEST_LANES];

if (command === 'verify') {
	translated.push('verify', 'db', ...(args[0] ? [args[0]] : []));
} else if (command === 'summary' || command === 'list' || command === 'run') {
	if (command === 'run') {
		const [shardIndex, shardTotal, ...extraArgs] = args;
		if (!shardIndex || !shardTotal) {
			process.stderr.write(
				'Usage: node scripts/test-shards.mjs <verify N | summary I N | list I N | run I N [vitest args...]>\n',
			);
			process.exit(1);
		}
		translated.push(command, 'db', shardIndex, shardTotal);
		if (extraArgs.length > 0) {
			translated.push(...(extraArgs[0] === '--' ? extraArgs : ['--', ...extraArgs]));
		}
	} else {
		translated.push(command, 'db', ...args);
	}
} else {
	process.stderr.write(
		'Usage: node scripts/test-shards.mjs <verify N | summary I N | list I N | run I N [vitest args...]>\n',
	);
	process.exit(1);
}

process.stderr.write('test-shards.mjs is a compatibility wrapper; use scripts/test-lanes.mjs for new CI lanes.\n');

const result = spawnSync(process.execPath, translated.slice(1), {
	cwd: ROOT,
	stdio: 'inherit',
	env: process.env,
});

process.exit(result.status ?? 1);
