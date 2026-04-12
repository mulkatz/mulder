/**
 * Evidence chain repository -- CRUD helpers for the `evidence_chains` table.
 *
 * Used by the Analyze step to replace thesis snapshots idempotently and to
 * inspect persisted evidence rows later.
 *
 * @see docs/specs/63_evidence_chains.spec.md §4.1
 * @see docs/functional-spec.md §4.3
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';
import { createChildLogger, createLogger } from '../../shared/logger.js';

const logger = createLogger();
const repoLogger = createChildLogger(logger, { module: 'evidence-chain-repository' });

type Queryable = Pick<pg.Pool, 'query'>;

export interface EvidenceChain {
	id: string;
	thesis: string;
	path: string[];
	strength: number;
	supports: boolean;
	computedAt: Date;
}

export interface CreateEvidenceChainInput {
	thesis: string;
	path: string[];
	strength: number;
	supports: boolean;
	computedAt?: Date;
}

interface EvidenceChainRow {
	id: string;
	thesis: string;
	path: string[];
	strength: number;
	supports: boolean;
	computed_at: Date;
}

function mapEvidenceChainRow(row: EvidenceChainRow): EvidenceChain {
	return {
		id: row.id,
		thesis: row.thesis,
		path: row.path ?? [],
		strength: Number(row.strength),
		supports: row.supports,
		computedAt: row.computed_at,
	};
}

function createEvidenceChainValueSql(rowCount: number): string {
	const values: string[] = [];
	for (let index = 0; index < rowCount; index++) {
		const base = index * 5;
		values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
	}
	return values.join(', ');
}

export async function findEvidenceChainsByThesis(pool: Queryable, thesis: string): Promise<EvidenceChain[]> {
	const sql = `
    SELECT *
    FROM evidence_chains
    WHERE thesis = $1
    ORDER BY supports DESC, strength DESC, computed_at DESC, id ASC
  `;

	try {
		const result = await pool.query<EvidenceChainRow>(sql, [thesis]);
		return result.rows.map(mapEvidenceChainRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find evidence chains by thesis', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { thesis },
		});
	}
}

export async function deleteEvidenceChainsByThesis(pool: Queryable, thesis: string): Promise<number> {
	const sql = 'DELETE FROM evidence_chains WHERE thesis = $1';

	try {
		const result = await pool.query(sql, [thesis]);
		const deletedCount = result.rowCount ?? 0;
		if (deletedCount > 0) {
			repoLogger.debug({ thesis, deletedCount }, 'Evidence chains deleted');
		}
		return deletedCount;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to delete evidence chains by thesis', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { thesis },
		});
	}
}

export async function createEvidenceChains(
	pool: Queryable,
	inputs: CreateEvidenceChainInput[],
): Promise<EvidenceChain[]> {
	if (inputs.length === 0) {
		return [];
	}

	const sql = `
    INSERT INTO evidence_chains (thesis, path, strength, supports, computed_at)
    VALUES ${createEvidenceChainValueSql(inputs.length)}
    RETURNING *
  `;

	const params: unknown[] = [];
	for (const input of inputs) {
		params.push(input.thesis, input.path, input.strength, input.supports, input.computedAt ?? new Date());
	}

	try {
		const result = await pool.query<EvidenceChainRow>(sql, params);
		repoLogger.debug({ insertedCount: result.rows.length }, 'Evidence chains inserted');
		return result.rows.map(mapEvidenceChainRow);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to insert evidence chains', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: {
				rowCount: inputs.length,
				thesis: inputs[0]?.thesis,
			},
		});
	}
}
