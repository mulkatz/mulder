/**
 * Database module barrel export.
 *
 * Public API: connection pools, migration runner, repositories, types.
 *
 * @see docs/specs/07_database_client_migration_runner.spec.md §4.7
 * @see docs/specs/14_source_repository.spec.md §4.4
 */

export { closeAllPools, getQueryPool, getWorkerPool } from './client.js';
export type { MigrationResult, MigrationStatus } from './migrate.js';
export { getMigrationStatus, runMigrations } from './migrate.js';
export * from './repositories/index.js';
