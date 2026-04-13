import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc');
const CLI_PROJECT = resolve(ROOT, 'apps/cli/tsconfig.json');
const DB_RUNNER = resolve(ROOT, 'tests/lib/db-runner.mjs');
const TEST_DB_ENV = {
	PGHOST: process.env.PGHOST ?? 'localhost',
	PGPORT: process.env.PGPORT ?? '5432',
	PGUSER: process.env.PGUSER ?? 'mulder',
	PGPASSWORD: process.env.PGPASSWORD ?? 'mulder',
	PGDATABASE: process.env.PGDATABASE ?? 'mulder',
	MULDER_LOG_LEVEL: process.env.MULDER_LOG_LEVEL ?? 'silent',
};
const TRUNCATE_SQL = [
	'TRUNCATE TABLE',
	'chunks,',
	'story_entities,',
	'entity_edges,',
	'entity_aliases,',
	'taxonomy,',
	'entities,',
	'stories,',
	'entity_grounding,',
	'evidence_chains,',
	'spatio_temporal_clusters,',
	'pipeline_run_sources,',
	'pipeline_runs,',
	'jobs,',
	'source_steps,',
	'sources',
	'CASCADE;',
].join(' ');

function runTsc(args) {
	return execFileSync(process.execPath, [TSC, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: process.env,
	});
}

function runNodeScript(scriptPath, args, env = process.env) {
	return execFileSync(process.execPath, [scriptPath, ...args], {
		cwd: ROOT,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env,
	});
}

function isPgReady() {
	try {
		runNodeScript(DB_RUNNER, ['ready'], { ...process.env, ...TEST_DB_ENV });
		return true;
	} catch {
		return false;
	}
}

function ensureTestDatabaseBaseline() {
	if (!isPgReady()) {
		return { databaseReset: false };
	}

	runNodeScript(
		resolve(ROOT, 'apps/cli/dist/index.js'),
		['db', 'migrate', resolve(ROOT, 'mulder.config.example.yaml')],
		{ ...process.env, ...TEST_DB_ENV },
	);

	runNodeScript(DB_RUNNER, ['query', Buffer.from(TRUNCATE_SQL, 'utf8').toString('base64')], {
		...process.env,
		...TEST_DB_ENV,
	});

	return { databaseReset: true };
}

export function ensureCliTestArtifacts() {
	runTsc(['--build', '--force', CLI_PROJECT, '--pretty', 'false']);
	const { databaseReset } = ensureTestDatabaseBaseline();
	return { refreshed: true, databaseReset };
}

export default async function globalSetup() {
	ensureCliTestArtifacts();
}

if (process.argv[1] === SCRIPT_PATH) {
	ensureCliTestArtifacts();
	process.stdout.write('rebuilt\n');
}
