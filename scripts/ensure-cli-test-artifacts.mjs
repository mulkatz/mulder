import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc');
const CLI_PROJECT = resolve(ROOT, 'apps/cli/tsconfig.json');

function runTsc(args) {
	return execFileSync(process.execPath, [TSC, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: process.env,
	});
}

export function ensureCliTestArtifacts() {
	runTsc(['--build', '--force', CLI_PROJECT, '--pretty', 'false']);
	return { refreshed: true };
}

export default async function globalSetup() {
	ensureCliTestArtifacts();
}

if (process.argv[1] === SCRIPT_PATH) {
	ensureCliTestArtifacts();
	process.stdout.write('rebuilt\n');
}
