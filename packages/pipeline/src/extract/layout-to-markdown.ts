/**
 * Layout-to-Markdown converter.
 *
 * Pure function that transforms a normalized `LayoutDocument` (produced by
 * the Extract step) into a single human-readable, GitHub-Flavored Markdown
 * document representing the whole source.
 *
 * Deterministic and side-effect-free: same input always produces byte-
 * identical output, input is not mutated, no I/O, no logging, no services.
 * Safe to call in hot paths, safe to cache on content hash.
 *
 * @see docs/specs/48_layout_to_markdown.spec.md §4.3
 */

import type { LayoutBlock, LayoutDocument, LayoutPage } from './types.js';

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Converts a `LayoutDocument` into a GitHub-Flavored Markdown string.
 *
 * Walks pages in document order, emits each block according to its `type`,
 * filters out `header` and `footer` blocks, and separates consecutive pages
 * with a `---` horizontal rule. Output ends with exactly one trailing newline.
 */
export function layoutToMarkdown(layout: LayoutDocument): string {
	const pageChunks: string[] = [];

	for (const page of layout.pages) {
		const pageMarkdown = renderPage(page);
		if (pageMarkdown.length > 0) {
			pageChunks.push(pageMarkdown);
		}
	}

	const joined = pageChunks.join('\n\n---\n\n');
	return `${joined.replace(/\s+$/, '')}\n`;
}

// ────────────────────────────────────────────────────────────
// Page / block rendering
// ────────────────────────────────────────────────────────────

/**
 * Renders a single page's blocks into Markdown. Pages without block metadata
 * (native-text path without layout breakdown) fall back to the page's raw
 * `text` field as a single paragraph.
 */
function renderPage(page: LayoutPage): string {
	const blocks = page.blocks;
	if (!blocks || blocks.length === 0) {
		const text = page.text?.trim() ?? '';
		return text.length > 0 ? text : '';
	}

	const rendered: string[] = [];
	for (const block of blocks) {
		const chunk = renderBlock(block);
		if (chunk.length > 0) {
			rendered.push(chunk);
		}
	}
	return rendered.join('\n\n');
}

/**
 * Renders a single block according to its `type`. Unknown or missing types
 * are treated as `paragraph`. Empty or whitespace-only text is skipped
 * regardless of type.
 */
function renderBlock(block: LayoutBlock): string {
	const text = block.text?.trim() ?? '';
	if (text.length === 0) return '';

	switch (block.type) {
		case 'heading':
			return `# ${text}`;
		case 'header':
		case 'footer':
			return '';
		case 'caption':
			return `_${text}_`;
		case 'table':
			return renderTable(text);
		default:
			// paragraph, list, unknown — rendered as paragraph(s).
			// Preserves internal blank-line breaks as paragraph separators.
			return text
				.split(/\n\s*\n/)
				.map((p) => p.trim())
				.filter((p) => p.length > 0)
				.join('\n\n');
	}
}

// ────────────────────────────────────────────────────────────
// Table rendering
// ────────────────────────────────────────────────────────────

/**
 * Renders pipe-delimited tabular text as a GitHub-Flavored Markdown table.
 *
 * Expects input like:
 *
 *     Header1 | Header2 | Header3
 *     Row1Col1 | Row1Col2 | Row1Col3
 *     Row2Col1 | Row2Col2 | Row2Col3
 *
 * Falls back to a fenced code block if the input cannot be parsed as a
 * well-formed table (< 2 rows, inconsistent column counts, < 2 columns,
 * or entirely empty header row).
 */
function renderTable(text: string): string {
	const lines = text
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	if (lines.length < 2) {
		return toCodeBlock(text);
	}

	const rows = lines.map((line) => line.split('|').map((cell) => cell.trim()));

	const headerCols = rows[0]?.length ?? 0;
	if (headerCols < 2) {
		return toCodeBlock(text);
	}
	for (const row of rows) {
		if (row.length !== headerCols) {
			return toCodeBlock(text);
		}
	}
	if (rows[0]?.every((c) => c.length === 0)) {
		return toCodeBlock(text);
	}

	const headerRow = rows[0];
	if (!headerRow) return toCodeBlock(text);

	const md: string[] = [];
	md.push(`| ${headerRow.join(' | ')} |`);
	md.push(`| ${headerRow.map(() => '---').join(' | ')} |`);
	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		if (row) md.push(`| ${row.join(' | ')} |`);
	}
	return md.join('\n');
}

function toCodeBlock(text: string): string {
	return `\`\`\`\n${text}\n\`\`\``;
}
