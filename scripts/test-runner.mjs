import { spawnSync } from 'node:child_process';
import { mkdirSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');

function usage() {
	return [
		'Usage:',
		'  node scripts/test-runner.mjs run <label> [--isolate-db] [--keep-db] -- <command> [args...]',
		'',
		'Environment:',
		'  MULDER_TEST_ISOLATED_DB=true  Create a fresh PGDATABASE for this run.',
		'  MULDER_TEST_DB_TEMPLATE=name  Clone the isolated database from an existing template database.',
		'  MULDER_TEST_STORAGE_ROOT=path  Use an explicit dev storage root instead of .local/test-storage/<run>/<label>.',
	].join('\n');
}

function sanitizeIdentifierPart(value) {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 32);
	return normalized || 'run';
}

function quoteIdentifier(value) {
	return `"${value.replace(/"/g, '""')}"`;
}

function adminPgConfig() {
	return {
		host: process.env.PGHOST ?? 'localhost',
		port: Number.parseInt(process.env.PGPORT ?? '5432', 10),
		user: process.env.PGUSER ?? 'mulder',
		password: process.env.PGPASSWORD ?? 'mulder',
		database: process.env.MULDER_TEST_ADMIN_DATABASE ?? 'postgres',
	};
}

async function withAdminClient(callback) {
	const client = new pg.Client(adminPgConfig());
	await client.connect();
	try {
		return await callback(client);
	} finally {
		await client.end().catch(() => {});
	}
}

async function ensureDatabaseExtensions(databaseName) {
	const client = new pg.Client({ ...adminPgConfig(), database: databaseName });
	await client.connect();
	try {
		for (const extension of ['vector', 'pg_trgm', 'postgis']) {
			await client.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)};`);
		}
	} finally {
		await client.end().catch(() => {});
	}
}

async function createIsolatedDatabase(label) {
	const runId = sanitizeIdentifierPart(process.env.MULDER_TEST_RUN_ID ?? `${Date.now()}_${process.pid}`);
	const dbName = `mulder_test_${runId}_${sanitizeIdentifierPart(label)}`.slice(0, 63);
	const template = process.env.MULDER_TEST_DB_TEMPLATE;

	await withAdminClient(async (client) => {
		await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE);`);
		if (template) {
			await client.query(`CREATE DATABASE ${quoteIdentifier(dbName)} TEMPLATE ${quoteIdentifier(template)};`);
		} else {
			await client.query(`CREATE DATABASE ${quoteIdentifier(dbName)};`);
		}
	});

	if (!template) {
		await ensureDatabaseExtensions(dbName);
	}

	return dbName;
}

async function dropIsolatedDatabase(dbName) {
	await withAdminClient(async (client) => {
		await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE);`);
	});
}

function parseArgs(rawArgs) {
	const [command, label, ...rest] = rawArgs;
	if (command !== 'run' || !label) {
		throw new Error(usage());
	}

	let isolateDb = process.env.MULDER_TEST_ISOLATED_DB === 'true';
	let keepDb = process.env.MULDER_TEST_KEEP_DB === 'true';
	const commandIndex = rest.indexOf('--');
	if (commandIndex === -1) {
		throw new Error(usage());
	}

	for (const option of rest.slice(0, commandIndex)) {
		if (option === '--isolate-db') {
			isolateDb = true;
		} else if (option === '--keep-db') {
			keepDb = true;
		} else {
			throw new Error(`Unknown test-runner option: ${option}\n${usage()}`);
		}
	}

	const childCommand = rest.slice(commandIndex + 1);
	if (childCommand.length === 0) {
		throw new Error(usage());
	}

	return { label, isolateDb, keepDb, childCommand };
}

async function main() {
	const { label, isolateDb, keepDb, childCommand } = parseArgs(process.argv.slice(2));
	const runId = sanitizeIdentifierPart(process.env.MULDER_TEST_RUN_ID ?? `${Date.now()}_${process.pid}`);
	const ownsStorageRoot = !process.env.MULDER_TEST_STORAGE_ROOT;
	const storageRoot = resolve(
		process.env.MULDER_TEST_STORAGE_ROOT ??
			resolve(ROOT, '.local', 'test-storage', runId, sanitizeIdentifierPart(label)),
	);
	mkdirSync(storageRoot, { recursive: true });

	let isolatedDb = null;
	const startedAt = Date.now();
	const env = {
		...process.env,
		MULDER_TEST_RUN_ID: runId,
		MULDER_TEST_STORAGE_ROOT: storageRoot,
		MULDER_LOG_LEVEL: process.env.MULDER_LOG_LEVEL ?? 'silent',
	};
	env.PGHOST = env.PGHOST ?? 'localhost';
	env.PGPORT = env.PGPORT ?? '5432';
	env.PGUSER = env.PGUSER ?? 'mulder';
	env.PGPASSWORD = env.PGPASSWORD ?? 'mulder';
	env.PGDATABASE = env.PGDATABASE ?? 'mulder';

	try {
		if (isolateDb) {
			isolatedDb = await createIsolatedDatabase(label);
			env.PGDATABASE = isolatedDb;
		}
		env.MULDER_TEST_CLOUD_SQL_HOST = env.PGHOST ?? 'localhost';
		env.MULDER_TEST_CLOUD_SQL_PORT = env.PGPORT ?? '5432';
		env.MULDER_TEST_CLOUD_SQL_DATABASE = env.PGDATABASE ?? 'mulder';
		env.MULDER_TEST_CLOUD_SQL_USER = env.PGUSER ?? 'mulder';
		if (env.PGPASSWORD) {
			env.MULDER_TEST_CLOUD_SQL_PASSWORD = env.PGPASSWORD;
		}

		process.stdout.write(
			[
				`test-runner: label=${label}`,
				`test-runner: storage=${storageRoot}`,
				isolatedDb
					? `test-runner: database=${isolatedDb}`
					: `test-runner: database=${env.PGDATABASE ?? 'mulder'} (shared)`,
				'',
			].join('\n'),
		);

		const result = spawnSync(childCommand[0], childCommand.slice(1), {
			cwd: ROOT,
			stdio: 'inherit',
			env,
		});
		const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
		process.stdout.write(`test-runner: duration=${durationSeconds}s\n`);
		process.exitCode = result.status ?? 1;
	} finally {
		if (isolatedDb && !keepDb) {
			await dropIsolatedDatabase(isolatedDb).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				process.stderr.write(`test-runner: failed to drop ${isolatedDb}: ${message}\n`);
			});
		}
		if (ownsStorageRoot && process.env.MULDER_TEST_KEEP_STORAGE !== 'true') {
			rmSync(storageRoot, { recursive: true, force: true });
			try {
				rmdirSync(dirname(storageRoot));
			} catch {
				// Another lane may still be using the same run directory.
			}
		}
	}
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
});
