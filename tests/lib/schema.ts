/**
 * Shared test helper: ensure the Postgres schema exists before a spec runs.
 *
 * Spec 08's `afterAll` drops every table and every extension to verify the
 * migration runner can re-create a clean database. Tests that run afterwards
 * and need the schema must re-migrate in their own `beforeAll` — this helper
 * is the canonical way to do that.
 *
 * Usage:
 *
 *   import { ensureSchema } from '../lib/schema.js';
 *
 *   beforeAll(() => {
 *     if (!pgAvailable) return;
 *     ensureSchema();
 *     // ... rest of fixture setup
 *   });
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { TEST_PG_ENV } from './db.js';

const ROOT = resolve(import.meta.dirname, '../..');
const CLI = resolve(ROOT, 'apps/cli/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');

/**
 * Run `mulder db migrate` against the example config and throw if migrations
 * fail. Idempotent — safe to call multiple times per test suite.
 */
export function ensureSchema(): void {
	const result = spawnSync('node', [CLI, 'db', 'migrate', EXAMPLE_CONFIG], {
		cwd: ROOT,
		encoding: 'utf-8',
		timeout: 30_000,
		stdio: ['pipe', 'pipe', 'pipe'],
		env: { ...process.env, ...TEST_PG_ENV, MULDER_LOG_LEVEL: 'silent' },
	});
	if (result.status !== 0) {
		throw new Error(
			`ensureSchema: db migrate failed (exit ${result.status}):\n` +
				`stdout: ${result.stdout ?? ''}\n` +
				`stderr: ${result.stderr ?? ''}`,
		);
	}
}
