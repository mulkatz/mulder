import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { MulderError } from './errors.js';
import type { UrlEntityHint, UrlExtractionResult, UrlExtractorService } from './services.js';

const PARSER_ENGINE = 'mozilla-readability-jsdom-turndown';
const MIN_READABLE_TEXT_LENGTH = 80;

function stringField(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function metaContent(document: Document, selectors: string[]): string | null {
	for (const selector of selectors) {
		const value = document.querySelector(selector)?.getAttribute('content')?.trim();
		if (value) {
			return value;
		}
	}
	return null;
}

function canonicalUrl(document: Document, finalUrl: string | null): string | null {
	const href = document.querySelector('link[rel~="canonical" i]')?.getAttribute('href')?.trim();
	if (!href) {
		return null;
	}
	try {
		return new URL(href, finalUrl ?? undefined).toString();
	} catch {
		return href;
	}
}

function normalizeDate(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function buildHints(input: {
	originalUrl: string | null;
	finalUrl: string | null;
	canonicalUrl: string | null;
	title: string;
	byline: string | null;
	siteName: string | null;
	publishedTime: string | null;
	modifiedTime: string | null;
}): UrlEntityHint[] {
	const hints: UrlEntityHint[] = [];
	const push = (hint: UrlEntityHint | null): void => {
		if (hint && hint.value.trim().length > 0) {
			hints.push(hint);
		}
	};
	push(
		input.originalUrl
			? { hint_type: 'url', field_name: 'original_url', value: input.originalUrl, confidence: 1, source: 'url' }
			: null,
	);
	push(
		input.finalUrl
			? { hint_type: 'url', field_name: 'final_url', value: input.finalUrl, confidence: 1, source: 'fetch_metadata' }
			: null,
	);
	push(
		input.canonicalUrl
			? {
					hint_type: 'canonical_url',
					field_name: 'canonical_url',
					value: input.canonicalUrl,
					confidence: 0.95,
					source: 'html_meta',
				}
			: null,
	);
	if (input.finalUrl) {
		try {
			const host = new URL(input.finalUrl).hostname;
			push({ hint_type: 'host', field_name: 'host', value: host, confidence: 1, source: 'fetch_metadata' });
		} catch {
			// Ignore malformed stored URL metadata.
		}
	}
	push({ hint_type: 'title', field_name: 'title', value: input.title, confidence: 0.9, source: 'html_meta' });
	push(
		input.siteName
			? { hint_type: 'host', field_name: 'site_name', value: input.siteName, confidence: 0.85, source: 'html_meta' }
			: null,
	);
	push(
		input.byline
			? { hint_type: 'byline', field_name: 'byline', value: input.byline, confidence: 0.85, source: 'html_meta' }
			: null,
	);
	push(
		input.publishedTime
			? {
					hint_type: 'published_date',
					field_name: 'published_time',
					value: input.publishedTime,
					confidence: 0.85,
					source: 'html_meta',
				}
			: null,
	);
	push(
		input.modifiedTime
			? {
					hint_type: 'modified_date',
					field_name: 'modified_time',
					value: input.modifiedTime,
					confidence: 0.8,
					source: 'html_meta',
				}
			: null,
	);
	return hints;
}

function markdownFromHtml(html: string): string {
	const turndown = new TurndownService({
		headingStyle: 'atx',
		codeBlockStyle: 'fenced',
		bulletListMarker: '-',
	});
	return turndown
		.turndown(html)
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

class LocalUrlExtractorService implements UrlExtractorService {
	async extractUrl(
		html: Buffer,
		sourceId: string,
		fetchMetadata: Record<string, unknown>,
	): Promise<UrlExtractionResult> {
		const finalUrl = stringField(fetchMetadata, 'final_url') ?? stringField(fetchMetadata, 'normalized_url');
		let dom: JSDOM;
		try {
			dom = new JSDOM(html.toString('utf-8'), { url: finalUrl ?? undefined });
		} catch (cause: unknown) {
			throw new MulderError(`URL HTML snapshot could not be parsed for source ${sourceId}`, 'URL_EXTRACTION_INVALID', {
				cause,
				context: { sourceId },
			});
		}

		const document = dom.window.document;
		const canonical = canonicalUrl(document, finalUrl);
		const siteName = metaContent(document, [
			'meta[property="og:site_name"]',
			'meta[name="application-name"]',
			'meta[name="twitter:site"]',
		]);
		const publishedTime = normalizeDate(
			metaContent(document, [
				'meta[property="article:published_time"]',
				'meta[name="article:published_time"]',
				'meta[name="pubdate"]',
				'meta[name="date"]',
				'meta[name="dc.date"]',
				'meta[name="dcterms.created"]',
			]),
		);
		const modifiedTime = normalizeDate(
			metaContent(document, [
				'meta[property="article:modified_time"]',
				'meta[name="last-modified"]',
				'meta[name="dcterms.modified"]',
			]),
		);

		const reader = new Readability(document);
		const article = reader.parse();
		const markdown = article?.content ? markdownFromHtml(article.content) : '';
		const textLength = markdown.replace(/[#*_`>|-]/g, '').trim().length;
		if (!article || markdown.length === 0 || textLength < MIN_READABLE_TEXT_LENGTH) {
			throw new MulderError(
				`URL snapshot did not contain meaningful readable content for source ${sourceId}`,
				'URL_UNREADABLE',
				{
					context: { sourceId, textLength },
				},
			);
		}

		const title = article.title?.trim() || document.title?.trim() || 'Untitled URL source';
		const byline = article.byline?.trim() || metaContent(document, ['meta[name="author"]']);
		const excerpt = article.excerpt?.trim() || metaContent(document, ['meta[name="description"]']);
		const originalUrl = stringField(fetchMetadata, 'original_url');
		const hints = buildHints({
			originalUrl,
			finalUrl,
			canonicalUrl: canonical,
			title,
			byline,
			siteName,
			publishedTime,
			modifiedTime,
		});

		return {
			title,
			byline,
			excerpt,
			siteName,
			canonicalUrl: canonical,
			publishedTime,
			modifiedTime,
			markdown,
			textLength,
			parserEngine: PARSER_ENGINE,
			warnings: [],
			entityHints: hints,
		};
	}
}

export function createUrlExtractorService(): UrlExtractorService {
	return new LocalUrlExtractorService();
}
