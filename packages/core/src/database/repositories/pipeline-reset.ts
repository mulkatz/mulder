/**
 * Repository functions for pipeline step cascading reset and orphaned entity GC.
 *
 * Wraps the PL/pgSQL functions from migration 014:
 * - `reset_pipeline_step(source_id, step)` — atomic cascading delete for --force re-runs
 * - `gc_orphaned_entities()` — garbage-collect entities with no story references
 *
 * @see docs/specs/30_cascading_reset_function.spec.md §4.1
 * @see docs/functional-spec.md §4.3.1
 */

import type pg from 'pg';

export type PipelineStep = 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

/**
 * Calls the reset_pipeline_step() PL/pgSQL function.
 * Atomically cascading-deletes all downstream data for a source at a given step.
 * GCS artifact cleanup must be handled by the caller AFTER this returns.
 */
export async function resetPipelineStep(pool: pg.Pool, sourceId: string, step: PipelineStep): Promise<void> {
	await pool.query('SELECT reset_pipeline_step($1, $2)', [sourceId, step]);
}

/**
 * Calls the gc_orphaned_entities() PL/pgSQL function.
 * Returns the number of orphaned entities deleted.
 */
export async function gcOrphanedEntities(pool: pg.Pool): Promise<number> {
	const result = await pool.query<{ gc_orphaned_entities: number }>('SELECT gc_orphaned_entities()');
	return result.rows[0].gc_orphaned_entities;
}
