import type {
	Logger,
	MulderConfig,
	Services,
	SourceFormatMetadata,
	UrlExtractionResult,
	UrlFetchResult,
	UrlRenderResult,
} from '@mulder/core';
import { INGEST_ERROR_CODES, IngestError, MulderError } from '@mulder/core';
import { buildUrlFormatMetadata } from './source-type.js';

export interface PreparedUrlSnapshot {
	html: Buffer;
	finalUrl: string;
	title: string | null;
	formatMetadata: SourceFormatMetadata;
	renderingMethod: 'static' | 'playwright';
}

export interface PrepareUrlSnapshotContext {
	config: MulderConfig;
	services: Services;
	displayUrl: string;
	logger: Logger;
}

function htmlTitle(html: Buffer): string | null {
	const match = html.toString('utf-8').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = match?.[1]
		?.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return title && title.length > 0 ? title : null;
}

function slugifyFilenamePart(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 80) || 'page'
	);
}

export function filenameForUrlSnapshot(html: Buffer, finalUrl: string, extractedTitle?: string): string {
	const title = extractedTitle ?? htmlTitle(html);
	const final = new URL(finalUrl);
	const pathPart = final.pathname === '/' ? final.hostname : `${final.hostname}${final.pathname}`;
	const basis = title ? `${title}-${final.hostname}` : pathPart;
	return `${slugifyFilenamePart(basis)}.html`;
}

function errorCode(error: unknown): string {
	return error instanceof MulderError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function probeUrlSnapshot(input: {
	services: Services;
	html: Buffer;
	sourceId: string;
	fetchMetadata: SourceFormatMetadata;
}): Promise<UrlExtractionResult> {
	return await input.services.urlExtractors.extractUrl(input.html, input.sourceId, input.fetchMetadata);
}

export async function prepareUrlSnapshot(
	fetchResult: UrlFetchResult,
	ctx: PrepareUrlSnapshotContext,
): Promise<PreparedUrlSnapshot> {
	const staticTitle = htmlTitle(fetchResult.html);
	const staticMetadata = buildUrlFormatMetadata(fetchResult, staticTitle ?? undefined);
	try {
		const staticProbe = await probeUrlSnapshot({
			services: ctx.services,
			html: fetchResult.html,
			sourceId: 'url-static-readability-probe',
			fetchMetadata: staticMetadata,
		});
		return {
			html: fetchResult.html,
			finalUrl: fetchResult.finalUrl,
			title: staticProbe.title || staticTitle,
			formatMetadata: buildUrlFormatMetadata(fetchResult, staticProbe.title || staticTitle || undefined),
			renderingMethod: 'static',
		};
	} catch (staticError: unknown) {
		const staticReadabilityError = errorCode(staticError);
		ctx.logger.info({ staticReadabilityError }, 'Static URL snapshot unreadable, attempting render fallback');
		let renderResult: UrlRenderResult;
		try {
			renderResult = await ctx.services.urlRenderers.renderUrl(fetchResult.finalUrl, {
				maxBytes: ctx.config.ingestion.max_file_size_mb * 1024 * 1024,
			});
		} catch (cause: unknown) {
			throw new IngestError(
				`URL render fallback failed for ${ctx.displayUrl}`,
				INGEST_ERROR_CODES.INGEST_URL_RENDER_FAILED,
				{
					cause,
					context: { url: ctx.displayUrl, staticReadabilityError },
				},
			);
		}
		const renderingMetadata = {
			result: renderResult,
			fallbackReason: 'static_unreadable',
			staticReadabilityError,
			renderedFromUrl: fetchResult.finalUrl,
		};
		const renderedTitle = htmlTitle(renderResult.html);
		const renderedMetadata = buildUrlFormatMetadata(fetchResult, renderedTitle ?? undefined, renderingMetadata);
		let renderedProbe: UrlExtractionResult;
		try {
			renderedProbe = await probeUrlSnapshot({
				services: ctx.services,
				html: renderResult.html,
				sourceId: 'url-rendered-readability-probe',
				fetchMetadata: renderedMetadata,
			});
		} catch (cause: unknown) {
			throw new IngestError(
				`Rendered URL snapshot was not readable for ${ctx.displayUrl}`,
				INGEST_ERROR_CODES.INGEST_URL_RENDER_FAILED,
				{
					cause,
					context: {
						url: ctx.displayUrl,
						staticReadabilityError,
						renderedReadabilityError: errorCode(cause),
						renderedErrorMessage: errorMessage(cause),
					},
				},
			);
		}
		return {
			html: renderResult.html,
			finalUrl: renderResult.finalUrl,
			title: renderedProbe.title || renderedTitle,
			formatMetadata: buildUrlFormatMetadata(
				fetchResult,
				renderedProbe.title || renderedTitle || undefined,
				renderingMetadata,
			),
			renderingMethod: 'playwright',
		};
	}
}
