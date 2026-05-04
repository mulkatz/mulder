/**
 * Repository functions for durable URL lifecycle and host politeness state.
 *
 * PostgreSQL remains the source of truth for URL freshness metadata. The
 * pipeline records one row per URL source and one row per normalized host.
 *
 * @see docs/specs/94_url_lifecycle_refetch.spec.md
 */

import type pg from 'pg';
import { DATABASE_ERROR_CODES, DatabaseError } from '../../shared/errors.js';

type Queryable = pg.Pool | pg.PoolClient;

export type UrlLifecycleChangeKind = 'initial' | 'changed' | 'unchanged';

export interface UrlLifecycle {
	sourceId: string;
	originalUrl: string;
	normalizedUrl: string;
	finalUrl: string;
	host: string;
	etag: string | null;
	lastModified: string | null;
	lastFetchedAt: Date;
	lastCheckedAt: Date;
	nextFetchAfter: Date | null;
	lastHttpStatus: number | null;
	robotsAllowed: boolean;
	robotsUrl: string | null;
	robotsCheckedAt: Date | null;
	robotsMatchedUserAgent: string | null;
	robotsMatchedRule: string | null;
	redirectCount: number;
	contentType: string | null;
	renderingMethod: string | null;
	snapshotEncoding: string | null;
	lastContentHash: string;
	lastSnapshotStoragePath: string;
	fetchCount: number;
	unchangedCount: number;
	changedCount: number;
	lastChangeAt: Date | null;
	lastErrorCode: string | null;
	lastErrorMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface UrlHostLifecycle {
	host: string;
	minimumDelayMs: number;
	lastRequestAt: Date | null;
	nextAllowedAt: Date | null;
	lastRobotsCheckedAt: Date | null;
	lastErrorCode: string | null;
	lastErrorMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface RecordUrlHostLifecycleInput {
	host: string;
	minimumDelayMs: number;
	requestedAt: Date;
	lastRobotsCheckedAt?: Date | null;
	lastErrorCode?: string | null;
	lastErrorMessage?: string | null;
}

export interface RecordUrlLifecycleFetchInput {
	sourceId: string;
	originalUrl: string;
	normalizedUrl: string;
	finalUrl: string;
	host: string;
	etag?: string | null;
	lastModified?: string | null;
	lastFetchedAt: Date;
	lastCheckedAt: Date;
	nextFetchAfter?: Date | null;
	lastHttpStatus?: number | null;
	robotsAllowed: boolean;
	robotsUrl?: string | null;
	robotsCheckedAt?: Date | null;
	robotsMatchedUserAgent?: string | null;
	robotsMatchedRule?: string | null;
	redirectCount?: number;
	contentType?: string | null;
	renderingMethod?: string | null;
	snapshotEncoding?: string | null;
	lastContentHash: string;
	lastSnapshotStoragePath: string;
	changeKind: UrlLifecycleChangeKind;
}

interface UrlLifecycleRow {
	source_id: string;
	original_url: string;
	normalized_url: string;
	final_url: string;
	host: string;
	etag: string | null;
	last_modified: string | null;
	last_fetched_at: Date;
	last_checked_at: Date;
	next_fetch_after: Date | null;
	last_http_status: number | null;
	robots_allowed: boolean;
	robots_url: string | null;
	robots_checked_at: Date | null;
	robots_matched_user_agent: string | null;
	robots_matched_rule: string | null;
	redirect_count: number;
	content_type: string | null;
	rendering_method: string | null;
	snapshot_encoding: string | null;
	last_content_hash: string;
	last_snapshot_storage_path: string;
	fetch_count: number;
	unchanged_count: number;
	changed_count: number;
	last_change_at: Date | null;
	last_error_code: string | null;
	last_error_message: string | null;
	created_at: Date;
	updated_at: Date;
}

interface UrlHostLifecycleRow {
	host: string;
	minimum_delay_ms: number;
	last_request_at: Date | null;
	next_allowed_at: Date | null;
	last_robots_checked_at: Date | null;
	last_error_code: string | null;
	last_error_message: string | null;
	created_at: Date;
	updated_at: Date;
}

function mapUrlLifecycleRow(row: UrlLifecycleRow): UrlLifecycle {
	return {
		sourceId: row.source_id,
		originalUrl: row.original_url,
		normalizedUrl: row.normalized_url,
		finalUrl: row.final_url,
		host: row.host,
		etag: row.etag,
		lastModified: row.last_modified,
		lastFetchedAt: row.last_fetched_at,
		lastCheckedAt: row.last_checked_at,
		nextFetchAfter: row.next_fetch_after,
		lastHttpStatus: row.last_http_status,
		robotsAllowed: row.robots_allowed,
		robotsUrl: row.robots_url,
		robotsCheckedAt: row.robots_checked_at,
		robotsMatchedUserAgent: row.robots_matched_user_agent,
		robotsMatchedRule: row.robots_matched_rule,
		redirectCount: row.redirect_count,
		contentType: row.content_type,
		renderingMethod: row.rendering_method,
		snapshotEncoding: row.snapshot_encoding,
		lastContentHash: row.last_content_hash,
		lastSnapshotStoragePath: row.last_snapshot_storage_path,
		fetchCount: row.fetch_count,
		unchangedCount: row.unchanged_count,
		changedCount: row.changed_count,
		lastChangeAt: row.last_change_at,
		lastErrorCode: row.last_error_code,
		lastErrorMessage: row.last_error_message,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapUrlHostLifecycleRow(row: UrlHostLifecycleRow): UrlHostLifecycle {
	return {
		host: row.host,
		minimumDelayMs: row.minimum_delay_ms,
		lastRequestAt: row.last_request_at,
		nextAllowedAt: row.next_allowed_at,
		lastRobotsCheckedAt: row.last_robots_checked_at,
		lastErrorCode: row.last_error_code,
		lastErrorMessage: row.last_error_message,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export async function findUrlLifecycleBySourceId(pool: Queryable, sourceId: string): Promise<UrlLifecycle | null> {
	const sql = 'SELECT * FROM url_lifecycle WHERE source_id = $1';

	try {
		const result = await pool.query<UrlLifecycleRow>(sql, [sourceId]);
		const row = result.rows[0];
		return row ? mapUrlLifecycleRow(row) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find URL lifecycle row', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId },
		});
	}
}

export async function findUrlHostLifecycleByHost(pool: Queryable, host: string): Promise<UrlHostLifecycle | null> {
	const sql = 'SELECT * FROM url_host_lifecycle WHERE host = $1';

	try {
		const result = await pool.query<UrlHostLifecycleRow>(sql, [host]);
		const row = result.rows[0];
		return row ? mapUrlHostLifecycleRow(row) : null;
	} catch (error: unknown) {
		throw new DatabaseError('Failed to find URL host lifecycle row', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { host },
		});
	}
}

export async function recordUrlHostLifecycle(
	pool: Queryable,
	input: RecordUrlHostLifecycleInput,
): Promise<UrlHostLifecycle> {
	const nextAllowedAt = new Date(input.requestedAt.getTime() + input.minimumDelayMs);
	const sql = `
    INSERT INTO url_host_lifecycle (
      host,
      minimum_delay_ms,
      last_request_at,
      next_allowed_at,
      last_robots_checked_at,
      last_error_code,
      last_error_message
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (host) DO UPDATE SET
      minimum_delay_ms = EXCLUDED.minimum_delay_ms,
      last_request_at = EXCLUDED.last_request_at,
      next_allowed_at = EXCLUDED.next_allowed_at,
      last_robots_checked_at = EXCLUDED.last_robots_checked_at,
      last_error_code = EXCLUDED.last_error_code,
      last_error_message = EXCLUDED.last_error_message,
      updated_at = now()
    RETURNING *
  `;

	try {
		const result = await pool.query<UrlHostLifecycleRow>(sql, [
			input.host,
			input.minimumDelayMs,
			input.requestedAt,
			nextAllowedAt,
			input.lastRobotsCheckedAt ?? null,
			input.lastErrorCode ?? null,
			input.lastErrorMessage ?? null,
		]);
		return mapUrlHostLifecycleRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to record URL host lifecycle row', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { host: input.host },
		});
	}
}

export async function recordUrlLifecycleFetch(
	pool: Queryable,
	input: RecordUrlLifecycleFetchInput,
): Promise<UrlLifecycle> {
	const unchangedIncrement = input.changeKind === 'unchanged' ? 1 : 0;
	const changedIncrement = input.changeKind === 'changed' ? 1 : 0;
	const lastChangeAt = input.changeKind === 'unchanged' ? null : input.lastFetchedAt;
	const sql = `
    INSERT INTO url_lifecycle (
      source_id,
      original_url,
      normalized_url,
      final_url,
      host,
      etag,
      last_modified,
      last_fetched_at,
      last_checked_at,
      next_fetch_after,
      last_http_status,
      robots_allowed,
      robots_url,
      robots_checked_at,
      robots_matched_user_agent,
      robots_matched_rule,
      redirect_count,
      content_type,
      rendering_method,
      snapshot_encoding,
      last_content_hash,
      last_snapshot_storage_path,
      fetch_count,
      unchanged_count,
      changed_count,
      last_change_at,
      last_error_code,
      last_error_message
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, 1, $23, $24, $25, NULL, NULL
    )
    ON CONFLICT (source_id) DO UPDATE SET
      original_url = EXCLUDED.original_url,
      normalized_url = EXCLUDED.normalized_url,
      final_url = EXCLUDED.final_url,
      host = EXCLUDED.host,
      etag = EXCLUDED.etag,
      last_modified = EXCLUDED.last_modified,
      last_fetched_at = EXCLUDED.last_fetched_at,
      last_checked_at = EXCLUDED.last_checked_at,
      next_fetch_after = EXCLUDED.next_fetch_after,
      last_http_status = EXCLUDED.last_http_status,
      robots_allowed = EXCLUDED.robots_allowed,
      robots_url = EXCLUDED.robots_url,
      robots_checked_at = EXCLUDED.robots_checked_at,
      robots_matched_user_agent = EXCLUDED.robots_matched_user_agent,
      robots_matched_rule = EXCLUDED.robots_matched_rule,
      redirect_count = EXCLUDED.redirect_count,
      content_type = EXCLUDED.content_type,
      rendering_method = EXCLUDED.rendering_method,
      snapshot_encoding = EXCLUDED.snapshot_encoding,
      last_content_hash = EXCLUDED.last_content_hash,
      last_snapshot_storage_path = EXCLUDED.last_snapshot_storage_path,
      fetch_count = url_lifecycle.fetch_count + 1,
      unchanged_count = url_lifecycle.unchanged_count + EXCLUDED.unchanged_count,
      changed_count = url_lifecycle.changed_count + EXCLUDED.changed_count,
      last_change_at = COALESCE(EXCLUDED.last_change_at, url_lifecycle.last_change_at),
      last_error_code = NULL,
      last_error_message = NULL,
      updated_at = now()
    RETURNING *
  `;

	try {
		const result = await pool.query<UrlLifecycleRow>(sql, [
			input.sourceId,
			input.originalUrl,
			input.normalizedUrl,
			input.finalUrl,
			input.host,
			input.etag ?? null,
			input.lastModified ?? null,
			input.lastFetchedAt,
			input.lastCheckedAt,
			input.nextFetchAfter ?? null,
			input.lastHttpStatus ?? null,
			input.robotsAllowed,
			input.robotsUrl ?? null,
			input.robotsCheckedAt ?? null,
			input.robotsMatchedUserAgent ?? null,
			input.robotsMatchedRule ?? null,
			input.redirectCount ?? 0,
			input.contentType ?? null,
			input.renderingMethod ?? null,
			input.snapshotEncoding ?? null,
			input.lastContentHash,
			input.lastSnapshotStoragePath,
			unchangedIncrement,
			changedIncrement,
			lastChangeAt,
		]);
		return mapUrlLifecycleRow(result.rows[0]);
	} catch (error: unknown) {
		throw new DatabaseError('Failed to record URL lifecycle fetch', DATABASE_ERROR_CODES.DB_QUERY_FAILED, {
			cause: error,
			context: { sourceId: input.sourceId, changeKind: input.changeKind },
		});
	}
}
