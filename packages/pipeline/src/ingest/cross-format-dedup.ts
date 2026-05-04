import { createHash } from 'node:crypto';
import type { SourceFormatMetadata } from '@mulder/core';

export type CrossFormatDedupBasis = 'text_content' | 'tabular_rows' | 'email_body' | 'url_readability_content';

export interface CrossFormatDedupMetadataInput {
	content?: string | null;
	title?: string | null;
	basis: CrossFormatDedupBasis;
}

export interface CrossFormatTabularSheet {
	headers: readonly string[];
	rows: readonly (readonly string[])[];
}

const MIN_CONTENT_CHARACTERS = 32;
const MIN_CONTENT_WORDS = 6;
const HASH_PREFIX = 'sha256:';

function sha256Hex(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function decodeCommonHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");
}

function stripMarkdownSyntax(value: string): string {
	return value
		.replace(/```[\s\S]*?```/g, (match) => match.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s{0,3}>\s?/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*\d+[.)]\s+/gm, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[`*_~]/g, '');
}

export function normalizeCrossFormatText(value: string): string {
	return stripMarkdownSyntax(decodeCommonHtmlEntities(value))
		.normalize('NFKC')
		.toLowerCase()
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/[^\p{L}\p{N}\s.,:;!?'"()/+-]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function isStrongCrossFormatContentSignal(normalizedContent: string): boolean {
	const compactLength = normalizedContent.replace(/\s/g, '').length;
	const wordCount = normalizedContent.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
	return compactLength >= MIN_CONTENT_CHARACTERS && wordCount >= MIN_CONTENT_WORDS;
}

export function deriveCrossFormatContentKey(content: string): string | null {
	const normalized = normalizeCrossFormatText(content);
	if (!isStrongCrossFormatContentSignal(normalized)) {
		return null;
	}
	return `${HASH_PREFIX}${sha256Hex(normalized)}`;
}

export function deriveCrossFormatTitleKey(title: string | null | undefined): string | null {
	const normalized = title ? normalizeCrossFormatText(title) : '';
	if (normalized.length < 3) {
		return null;
	}
	return `${HASH_PREFIX}${sha256Hex(normalized)}`;
}

export function deriveMarkdownTitle(markdown: string): string | null {
	const heading = markdown.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
	const title = heading?.[1]?.trim();
	return title && title.length > 0 ? title : null;
}

export function buildTabularCrossFormatContent(sheets: readonly CrossFormatTabularSheet[]): string {
	return sheets
		.map((sheet) => {
			const headerLine = sheet.headers.map((cell) => cell.trim()).join('\t');
			const rowLines = sheet.rows.map((row) => row.map((cell) => cell.trim()).join('\t'));
			return [headerLine, ...rowLines].filter((line) => line.length > 0).join('\n');
		})
		.filter((sheetText) => sheetText.length > 0)
		.join('\n\n');
}

export function withCrossFormatDedupMetadata(
	metadata: SourceFormatMetadata,
	input: CrossFormatDedupMetadataInput,
): SourceFormatMetadata {
	const next: SourceFormatMetadata = { ...metadata };
	const contentKey = input.content ? deriveCrossFormatContentKey(input.content) : null;
	if (contentKey) {
		next.cross_format_dedup_key = contentKey;
		next.cross_format_dedup_basis = input.basis;
	}

	const titleKey = deriveCrossFormatTitleKey(input.title);
	if (titleKey) {
		next.cross_format_title_key = titleKey;
	}

	return next;
}

export function getCrossFormatDedupKey(metadata: SourceFormatMetadata): string | null {
	const value = metadata.cross_format_dedup_key;
	return typeof value === 'string' && value.length > 0 ? value : null;
}
