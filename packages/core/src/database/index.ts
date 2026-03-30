/**
 * Database module barrel export.
 *
 * Public API: connection pools, migration runner, types.
 *
 * @see docs/specs/07_database_client_migration_runner.spec.md §4.7
 */

export { closeAllPools, getQueryPool, getWorkerPool } from './client.js';
export type { MigrationResult, MigrationStatus } from './migrate.js';
export { getMigrationStatus, runMigrations } from './migrate.js';
