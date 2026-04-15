import { performance } from 'node:perf_hooks';
import {
	countSources,
	createChildLogger,
	createLogger,
	createServiceRegistry,
	DATABASE_ERROR_CODES,
	DatabaseError,
	findAllSources,
	findSourceById,
	getQueryPool,
	type Logger,
	loadConfig,
	type MulderConfig,
	MulderError,
	type Services,
	type Source,
	type SourceFilter,
} from '@mulder/core';
import type pg from 'pg';
import type {
	DocumentArtifact,
	DocumentListItem,
	DocumentListQuery,
	DocumentListResponse,
	DocumentPageItem,
	DocumentPagesResponse,
} from '../routes/documents.schemas.js';

interface DocumentContext {
	config: MulderConfig;
	pool: pg.Pool;
}

const DOCUMENT_NOT_FOUND_CODE = 'DOCUMENT_NOT_FOUND';
const PDF_CONTENT_TYPE = 'application/pdf';
const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
const PNG_CONTENT_TYPE = 'image/png';

let cachedContext: DocumentContext | null = null;
let cachedConfigPath: string | null = null;

function resolveConfigPath(): string {
	return process.env.MULDER_CONFIG ?? 'mulder.config.yaml';
}

function createRouteLogger(rootLogger: Logger, metadata: Record<string, string | number | boolean | null | undefined>) {
	return createChildLogger(rootLogger, {
		module: 'api',
		route: 'documents',
		...metadata,
	});
}

function resolveContext(): DocumentContext {
	const configPath = resolveConfigPath();
	if (cachedContext && cachedConfigPath === configPath) {
		return cachedContext;
	}

	const config = loadConfig(configPath);
	if (!config.gcp?.cloud_sql) {
		throw new DatabaseError(
			'GCP cloud_sql configuration is required for document routes',
			DATABASE_ERROR_CODES.DB_CONNECTION_FAILED,
			{
				context: {
					configPath,
				},
			},
		);
	}

	cachedContext = {
		config,
		pool: getQueryPool(config.gcp.cloud_sql),
	};
	cachedConfigPath = configPath;

	return cachedContext;
}

function toIsoString(value: Date): string {
	return value.toISOString();
}

function buildDocumentLinks(id: string): { pdf: string; layout: string; pages: string } {
	return {
		pdf: `/api/documents/${id}/pdf`,
		layout: `/api/documents/${id}/layout`,
		pages: `/api/documents/${id}/pages`,
	};
}

function mapSourceToDocument(source: Source, layoutAvailable: boolean, pageImageCount: number): DocumentListItem {
	return {
		id: source.id,
		filename: source.filename,
		status: source.status,
		page_count: source.pageCount,
		has_native_text: source.hasNativeText,
		layout_available: layoutAvailable,
		page_image_count: pageImageCount,
		created_at: toIsoString(source.createdAt),
		updated_at: toIsoString(source.updatedAt),
		links: buildDocumentLinks(source.id),
	};
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildStoragePath(prefix: string, sourceId: string, suffix: string): string {
	return `${prefix}/${sourceId}/${suffix}`;
}

function buildLayoutPath(sourceId: string): string {
	return buildStoragePath('extracted', sourceId, 'layout.md');
}

function buildPagePrefix(sourceId: string): string {
	return `${buildStoragePath('extracted', sourceId, 'pages')}/`;
}

function buildPagePath(sourceId: string, pageNumber: number): string {
	return `${buildPagePrefix(sourceId)}page-${String(pageNumber).padStart(3, '0')}.png`;
}

function sanitizeContentDispositionFilename(filename: string): string {
	let sanitized = '';
	for (const char of filename) {
		const code = char.charCodeAt(0);
		if (code < 32 || code === 127 || char === '\\') {
			sanitized += '_';
			continue;
		}

		if (char === '"') {
			sanitized += '\\"';
			continue;
		}

		sanitized += char;
	}

	sanitized = sanitized.trim();
	return sanitized.length > 0 ? sanitized : 'document.pdf';
}

function buildInlineContentDisposition(filename: string): string {
	return `inline; filename="${sanitizeContentDispositionFilename(filename)}"`;
}

function buildPdfArtifact(source: Source): DocumentArtifact {
	return {
		kind: 'pdf',
		source_id: source.id,
		storage_path: source.storagePath,
		content_type: PDF_CONTENT_TYPE,
		filename: source.filename,
	};
}

function buildLayoutArtifact(source: Source): DocumentArtifact {
	return {
		kind: 'layout',
		source_id: source.id,
		storage_path: buildLayoutPath(source.id),
		content_type: MARKDOWN_CONTENT_TYPE,
		filename: 'layout.md',
	};
}

function buildPageArtifact(sourceId: string, pageNumber: number): DocumentArtifact {
	return {
		kind: 'page_image',
		source_id: sourceId,
		storage_path: buildPagePath(sourceId, pageNumber),
		content_type: PNG_CONTENT_TYPE,
		filename: `page-${String(pageNumber).padStart(3, '0')}.png`,
		page_number: pageNumber,
	};
}

function notFoundError(message: string, context: Record<string, unknown>): MulderError {
	return new MulderError(message, DOCUMENT_NOT_FOUND_CODE, { context });
}

async function requireSource(pool: pg.Pool, id: string): Promise<Source> {
	const source = await findSourceById(pool, id);
	if (!source) {
		throw notFoundError(`Document not found: ${id}`, { id });
	}

	return source;
}

function parsePageNumberFromPath(path: string, sourceId: string): number | null {
	const pattern = new RegExp(`(?:^|/)${escapeRegExp(buildPagePrefix(sourceId))}page-(\\d+)\\.png$`);
	const match = pattern.exec(path);
	if (!match) {
		return null;
	}

	const pageNumber = Number.parseInt(match[1], 10);
	return Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : null;
}

async function listPageArtifacts(
	services: Services,
	sourceId: string,
): Promise<Array<Pick<DocumentPageItem, 'page_number' | 'image_url'>>> {
	const { paths } = await services.storage.list(buildPagePrefix(sourceId));
	return paths
		.map((path) => {
			const pageNumber = parsePageNumberFromPath(path, sourceId);
			if (!pageNumber) {
				return null;
			}

			return {
				page_number: pageNumber,
				image_url: `/api/documents/${sourceId}/pages/${pageNumber}`,
			};
		})
		.filter((page): page is Pick<DocumentPageItem, 'page_number' | 'image_url'> => page !== null)
		.sort((left, right) => left.page_number - right.page_number);
}

async function countPageArtifacts(services: Services, sourceId: string): Promise<number> {
	const pages = await listPageArtifacts(services, sourceId);
	return pages.length;
}

async function loadArtifactBytes(
	services: Services,
	artifact: DocumentArtifact,
	sourceId: string,
	artifactLabel: string,
): Promise<Buffer> {
	const exists = await services.storage.exists(artifact.storage_path);
	if (!exists) {
		throw notFoundError(`${artifactLabel} not found for document ${sourceId}`, {
			source_id: sourceId,
			artifact_kind: artifact.kind,
			storage_path: artifact.storage_path,
		});
	}

	return await services.storage.download(artifact.storage_path);
}

async function buildDocumentListResponse(input: DocumentListQuery, logger: Logger): Promise<DocumentListResponse> {
	const requestLogger = createRouteLogger(logger, {
		action: 'list',
		status: input.status ?? null,
		search: input.search ?? null,
		limit: input.limit,
		offset: input.offset,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const filter: SourceFilter = {
		status: input.status,
		search: input.search,
		limit: input.limit,
		offset: input.offset,
	};
	const startedAt = performance.now();

	const [count, sources] = await Promise.all([countSources(pool, filter), findAllSources(pool, filter)]);
	const documents = await Promise.all(
		sources.map(async (source) => {
			const [layoutAvailable, pageImageCount] = await Promise.all([
				services.storage.exists(buildLayoutPath(source.id)),
				countPageArtifacts(services, source.id),
			]);

			return mapSourceToDocument(source, layoutAvailable, pageImageCount);
		}),
	);

	const response: DocumentListResponse = {
		data: documents,
		meta: {
			count,
			limit: input.limit,
			offset: input.offset,
		},
	};

	requestLogger.info(
		{
			count,
			result_count: response.data.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document list request completed',
	);

	return response;
}

export async function listDocuments(input: DocumentListQuery, logger?: Logger): Promise<DocumentListResponse> {
	const rootLogger = logger ?? createLogger();
	return await buildDocumentListResponse(input, rootLogger);
}

export async function streamDocumentPdf(id: string, logger?: Logger): Promise<Response> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'stream',
		artifact_kind: 'pdf',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const source = await requireSource(pool, id);
	const artifact = buildPdfArtifact(source);
	const buffer = await loadArtifactBytes(services, artifact, id, 'PDF');

	requestLogger.info(
		{
			filename: source.filename,
			byte_length: buffer.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document pdf request completed',
	);

	return new Response(buffer, {
		status: 200,
		headers: {
			'Content-Type': artifact.content_type,
			'Content-Disposition': buildInlineContentDisposition(source.filename),
		},
	});
}

export async function streamDocumentLayout(id: string, logger?: Logger): Promise<Response> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'stream',
		artifact_kind: 'layout',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const source = await requireSource(pool, id);
	const artifact = buildLayoutArtifact(source);
	const buffer = await loadArtifactBytes(services, artifact, id, 'layout.md');

	requestLogger.info(
		{
			filename: source.filename,
			byte_length: buffer.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document layout request completed',
	);

	return new Response(buffer, {
		status: 200,
		headers: {
			'Content-Type': artifact.content_type,
		},
	});
}

export async function listDocumentPages(id: string, logger?: Logger): Promise<DocumentPagesResponse> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'pages',
		artifact_kind: 'page_image',
		source_id: id,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	await requireSource(pool, id);
	const pages = await listPageArtifacts(services, id);

	const response: DocumentPagesResponse = {
		data: {
			source_id: id,
			pages,
		},
		meta: {
			count: pages.length,
		},
	};

	requestLogger.info(
		{
			result_count: response.data.pages.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document page list request completed',
	);

	return response;
}

export async function streamDocumentPage(id: string, pageNumber: number, logger?: Logger): Promise<Response> {
	const rootLogger = logger ?? createLogger();
	const requestLogger = createRouteLogger(rootLogger, {
		action: 'stream',
		artifact_kind: 'page_image',
		source_id: id,
		page_number: pageNumber,
	});
	const { config, pool } = resolveContext();
	const services = createServiceRegistry(config, requestLogger);
	const startedAt = performance.now();
	const source = await requireSource(pool, id);
	const artifact = buildPageArtifact(source.id, pageNumber);
	const buffer = await loadArtifactBytes(services, artifact, id, `page ${pageNumber}`);

	requestLogger.info(
		{
			filename: source.filename,
			page_number: pageNumber,
			byte_length: buffer.length,
			duration_ms: Math.round(performance.now() - startedAt),
		},
		'document page request completed',
	);

	return new Response(buffer, {
		status: 200,
		headers: {
			'Content-Type': artifact.content_type,
		},
	});
}

export function resetDocumentContextForTests(): void {
	cachedContext = null;
	cachedConfigPath = null;
}
