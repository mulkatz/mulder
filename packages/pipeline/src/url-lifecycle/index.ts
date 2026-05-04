import { createHash } from 'node:crypto';
import type {
	Logger,
	MulderConfig,
	Services,
	Source,
	SourceFormatMetadata,
	UrlHostLifecycle,
	UrlLifecycle,
} from '@mulder/core';
import {
	computeUrlLifecycleNextAllowedAt,
	createChildLogger,
	findSourceByHash,
	findSourceById,
	findUrlHostLifecycleByHost,
	findUrlLifecycleBySourceId,
	MulderError,
	normalizeUrlLifecycleHost,
	recordUrlHostLifecycle,
	recordUrlLifecycleFetch,
	resetPipelineStep,
	resolveUrlPolitenessDelayMs,
	sleepForUrlPoliteness,
	updateSource,
	upsertSourceStep,
	urlLifecycleHeaderValue,
} from '@mulder/core';
import type pg from 'pg';
import { URL_SNAPSHOT_MEDIA_TYPE } from '../ingest/source-type.js';
import { filenameForUrlSnapshot, prepareUrlSnapshot } from '../ingest/url-snapshot.js';

const STEP_NAME = 'url-lifecycle';

export interface UrlLifecycleStatusResult {
	source: Source;
	lifecycle: UrlLifecycle;
	host: UrlHostLifecycle | null;
}

export interface UrlRefetchInput {
	sourceId: string;
	dryRun?: boolean;
	force?: boolean;
}

export interface UrlRefetchResult {
	sourceId: string;
	status: 'changed' | 'unchanged';
	dryRun: boolean;
	notModified: boolean;
	httpStatus: number;
	originalUrl: string;
	finalUrl: string;
	previousHash: string;
	currentHash: string;
	storagePath: string;
	renderingMethod: string | null;
	checkedAt: string;
}

function computeHash(buffer: Buffer): string {
	return createHash('sha256').update(buffer).digest('hex');
}

function stringMetadataValue(metadata: SourceFormatMetadata, key: string): string | null {
	const value = metadata[key];
	return typeof value === 'string' ? value : null;
}

function lifecycleError(
	message: string,
	code: string,
	context?: Record<string, unknown>,
	cause?: unknown,
): MulderError {
	return new MulderError(message, code, { context, cause });
}

async function loadUrlSource(pool: pg.Pool, sourceId: string): Promise<{ source: Source; lifecycle: UrlLifecycle }> {
	const source = await findSourceById(pool, sourceId);
	if (!source) {
		throw lifecycleError(`Source not found: ${sourceId}`, 'URL_SOURCE_NOT_FOUND', { sourceId });
	}
	if (source.sourceType !== 'url') {
		throw lifecycleError(`Source is not a URL source: ${sourceId}`, 'URL_SOURCE_REQUIRED', {
			sourceId,
			sourceType: source.sourceType,
		});
	}

	const lifecycle = await findUrlLifecycleBySourceId(pool, sourceId);
	if (!lifecycle) {
		throw lifecycleError(`URL lifecycle metadata not found for source: ${sourceId}`, 'URL_LIFECYCLE_NOT_FOUND', {
			sourceId,
		});
	}

	return { source, lifecycle };
}

async function waitForHostPoliteness(pool: pg.Pool, host: string): Promise<void> {
	const state = await findUrlHostLifecycleByHost(pool, host);
	if (!state?.nextAllowedAt) {
		return;
	}
	const waitMs = state.nextAllowedAt.getTime() - Date.now();
	if (waitMs > 0) {
		await sleepForUrlPoliteness(waitMs);
	}
}

async function recordSuccessfulLifecycle(input: {
	pool: pg.Pool;
	source: Source;
	lifecycle: UrlLifecycle;
	fetchResult: Awaited<ReturnType<Services['urls']['fetchUrl']>>;
	formatMetadata: SourceFormatMetadata;
	fileHash: string;
	storagePath: string;
	changeKind: 'changed' | 'unchanged';
}): Promise<void> {
	const fetchedAt = new Date(input.fetchResult.fetchedAt);
	const minimumDelayMs = resolveUrlPolitenessDelayMs();
	const finalUrl = stringMetadataValue(input.formatMetadata, 'final_url') ?? input.fetchResult.finalUrl;
	const host = normalizeUrlLifecycleHost(finalUrl);
	const initialHost = normalizeUrlLifecycleHost(input.fetchResult.normalizedUrl);
	const nextFetchAfter = computeUrlLifecycleNextAllowedAt(fetchedAt, minimumDelayMs);

	for (const hostToRecord of new Set([initialHost, host])) {
		await recordUrlHostLifecycle(input.pool, {
			host: hostToRecord,
			minimumDelayMs,
			requestedAt: fetchedAt,
			lastRobotsCheckedAt: fetchedAt,
		});
	}

	await recordUrlLifecycleFetch(input.pool, {
		sourceId: input.source.id,
		originalUrl: input.fetchResult.originalUrl,
		normalizedUrl: input.fetchResult.normalizedUrl,
		finalUrl,
		host,
		etag: urlLifecycleHeaderValue(input.fetchResult.headers, 'etag') ?? input.lifecycle.etag,
		lastModified: urlLifecycleHeaderValue(input.fetchResult.headers, 'last-modified') ?? input.lifecycle.lastModified,
		lastFetchedAt: fetchedAt,
		lastCheckedAt: fetchedAt,
		nextFetchAfter,
		lastHttpStatus: input.fetchResult.httpStatus,
		robotsAllowed: input.fetchResult.robots.allowed,
		robotsUrl: input.fetchResult.robots.robotsUrl,
		robotsCheckedAt: fetchedAt,
		robotsMatchedUserAgent: input.fetchResult.robots.matchedUserAgent,
		robotsMatchedRule: input.fetchResult.robots.matchedRule,
		redirectCount: input.fetchResult.redirectCount,
		contentType: input.fetchResult.contentType || input.lifecycle.contentType,
		renderingMethod: stringMetadataValue(input.formatMetadata, 'rendering_method') ?? input.lifecycle.renderingMethod,
		snapshotEncoding:
			input.fetchResult.snapshotEncoding ??
			stringMetadataValue(input.formatMetadata, 'snapshot_encoding') ??
			input.lifecycle.snapshotEncoding,
		lastContentHash: input.fileHash,
		lastSnapshotStoragePath: input.storagePath,
		changeKind: input.changeKind,
	});
}

export async function getUrlLifecycleStatus(pool: pg.Pool, sourceId: string): Promise<UrlLifecycleStatusResult> {
	const { source, lifecycle } = await loadUrlSource(pool, sourceId);
	const host = await findUrlHostLifecycleByHost(pool, lifecycle.host);
	return { source, lifecycle, host };
}

export async function refetchUrlSource(
	input: UrlRefetchInput,
	config: MulderConfig,
	services: Services,
	pool: pg.Pool,
	logger: Logger,
): Promise<UrlRefetchResult> {
	const { source, lifecycle } = await loadUrlSource(pool, input.sourceId);
	const dryRun = input.dryRun ?? false;
	const force = input.force ?? false;
	const log = createChildLogger(logger, { step: STEP_NAME, sourceId: source.id });
	const refetchUrl =
		lifecycle.normalizedUrl || stringMetadataValue(source.formatMetadata, 'normalized_url') || lifecycle.originalUrl;
	const initialHost = normalizeUrlLifecycleHost(refetchUrl);

	await waitForHostPoliteness(pool, initialHost);

	let fetchResult: Awaited<ReturnType<Services['urls']['fetchUrl']>>;
	try {
		fetchResult = await services.urls.fetchUrl(refetchUrl, {
			maxBytes: config.ingestion.max_file_size_mb * 1024 * 1024,
			ifNoneMatch: force ? null : lifecycle.etag,
			ifModifiedSince: force ? null : lifecycle.lastModified,
		});
	} catch (cause: unknown) {
		const detail = cause instanceof Error ? `: ${cause.message}` : '';
		throw lifecycleError(
			`URL re-fetch failed for source ${source.id}${detail}`,
			'URL_REFETCH_FAILED',
			{
				sourceId: source.id,
				url: refetchUrl,
			},
			cause,
		);
	}

	if (fetchResult.notModified) {
		if (!dryRun) {
			await recordSuccessfulLifecycle({
				pool,
				source,
				lifecycle,
				fetchResult,
				formatMetadata: source.formatMetadata,
				fileHash: source.fileHash,
				storagePath: source.storagePath,
				changeKind: 'unchanged',
			});
		}
		return {
			sourceId: source.id,
			status: 'unchanged',
			dryRun,
			notModified: true,
			httpStatus: fetchResult.httpStatus,
			originalUrl: fetchResult.originalUrl,
			finalUrl: fetchResult.finalUrl,
			previousHash: source.fileHash,
			currentHash: source.fileHash,
			storagePath: source.storagePath,
			renderingMethod: lifecycle.renderingMethod,
			checkedAt: fetchResult.fetchedAt,
		};
	}

	const prepared = await prepareUrlSnapshot(fetchResult, {
		config,
		services,
		displayUrl: refetchUrl,
		logger: log,
	});
	const fileHash = computeHash(prepared.html);
	const unchanged = fileHash === source.fileHash;

	if (unchanged) {
		if (!dryRun) {
			await recordSuccessfulLifecycle({
				pool,
				source,
				lifecycle,
				fetchResult,
				formatMetadata: prepared.formatMetadata,
				fileHash: source.fileHash,
				storagePath: source.storagePath,
				changeKind: 'unchanged',
			});
		}
		return {
			sourceId: source.id,
			status: 'unchanged',
			dryRun,
			notModified: false,
			httpStatus: fetchResult.httpStatus,
			originalUrl: fetchResult.originalUrl,
			finalUrl: prepared.finalUrl,
			previousHash: source.fileHash,
			currentHash: source.fileHash,
			storagePath: source.storagePath,
			renderingMethod: prepared.renderingMethod,
			checkedAt: fetchResult.fetchedAt,
		};
	}

	const filename = filenameForUrlSnapshot(prepared.html, prepared.finalUrl, prepared.title ?? undefined);
	if (!dryRun) {
		const duplicate = await findSourceByHash(pool, fileHash);
		if (duplicate && duplicate.id !== source.id) {
			throw lifecycleError(
				'URL re-fetch produced content that already belongs to another source',
				'URL_REFETCH_DUPLICATE_HASH',
				{
					sourceId: source.id,
					duplicateSourceId: duplicate.id,
					fileHash,
				},
			);
		}
		await services.storage.upload(source.storagePath, prepared.html, URL_SNAPSHOT_MEDIA_TYPE);
		await updateSource(pool, source.id, {
			filename,
			fileHash,
			formatMetadata: prepared.formatMetadata,
			metadata: prepared.formatMetadata,
			status: 'ingested',
		});
		await resetPipelineStep(pool, source.id, 'extract');
		await upsertSourceStep(pool, {
			sourceId: source.id,
			stepName: 'ingest',
			status: 'completed',
		});
		await recordSuccessfulLifecycle({
			pool,
			source,
			lifecycle,
			fetchResult,
			formatMetadata: prepared.formatMetadata,
			fileHash,
			storagePath: source.storagePath,
			changeKind: 'changed',
		});
	}

	return {
		sourceId: source.id,
		status: 'changed',
		dryRun,
		notModified: false,
		httpStatus: fetchResult.httpStatus,
		originalUrl: fetchResult.originalUrl,
		finalUrl: prepared.finalUrl,
		previousHash: source.fileHash,
		currentHash: fileHash,
		storagePath: source.storagePath,
		renderingMethod: prepared.renderingMethod,
		checkedAt: fetchResult.fetchedAt,
	};
}
