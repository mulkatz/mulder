import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const DEVLOG_DIR = resolve(ROOT, 'devlog');
const DEVLOG_README = resolve(DEVLOG_DIR, 'README.md');
const MAX_DEVLOG_SENTENCES = 15;
const ALLOWED_TYPES = new Set([
	'architecture',
	'implementation',
	'breakthrough',
	'decision',
	'refactor',
	'integration',
	'milestone',
]);

interface DevlogEntry {
	date: string;
	type: string;
	title: string;
	tags: string[];
	body: string;
}

function parseFrontmatter(markdown: string): DevlogEntry {
	const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		throw new Error('Missing YAML frontmatter');
	}

	const frontmatter = match[1];
	const body = match[2].trim();
	const fields = new Map<string, string>();

	for (const line of frontmatter.split('\n')) {
		const separator = line.indexOf(':');
		if (separator === -1) {
			continue;
		}

		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		fields.set(key, value);
	}

	const date = fields.get('date');
	const type = fields.get('type');
	const title = fields.get('title');
	const tags = fields.get('tags');

	if (!date || !type || !title || !tags) {
		throw new Error('Missing required frontmatter keys');
	}

	const tagMatch = tags.match(/^\[(.*)\]$/);
	if (!tagMatch) {
		throw new Error('Tags must use inline array syntax');
	}

	const parsedTags = tagMatch[1]
		.split(',')
		.map((tag) => tag.trim().replace(/^['"]|['"]$/g, ''))
		.filter(Boolean);

	return {
		date,
		type,
		title: title.replace(/^['"]|['"]$/g, ''),
		tags: parsedTags,
		body,
	};
}

function countSentences(body: string): number {
	const normalized = body
		.replace(/^```[\s\S]*?```$/gm, '')
		.replace(/^#+\s+.*$/gm, '')
		.trim();

	if (normalized.length === 0) {
		return 0;
	}

	if (typeof Intl.Segmenter === 'function') {
		const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
		return [...segmenter.segment(normalized)].filter((segment) => segment.segment.trim().length > 0).length;
	}

	const segments = normalized
		.split(/(?<=[.!?])(?:["')\]]+)?\s+/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	return segments.length > 0 ? segments.length : 1;
}

function listDevlogEntries(): string[] {
	return readdirSync(DEVLOG_DIR)
		.filter((name) => name.endsWith('.md') && name !== 'README.md')
		.sort();
}

describe('Spec 78 — Devlog System', () => {
	it('QA-01: the repository exposes contributor-facing devlog conventions', () => {
		expect(existsSync(DEVLOG_DIR)).toBe(true);
		expect(existsSync(DEVLOG_README)).toBe(true);

		const readme = readFileSync(DEVLOG_README, 'utf-8');
		expect(readme).toContain('public build log');
		expect(readme).toContain('YYYY-MM-DD-slug.md');
		expect(readme).toContain('Frontmatter');
		expect(readme).toContain('Allowed `type` values');
		expect(readme).toContain('Write a devlog entry when');
		expect(readme).toContain('Skip a devlog entry when');
	});

	it('QA-02: CLAUDE.md matches the devlog contract', () => {
		const claude = readFileSync(resolve(ROOT, 'CLAUDE.md'), 'utf-8');
		const sectionStart = claude.indexOf('## Devlog');
		expect(sectionStart).toBeGreaterThanOrEqual(0);

		const section = claude.slice(sectionStart, claude.indexOf('## Testing', sectionStart));
		expect(section).toContain('devlog/');
		expect(section).toContain('files: `YYYY-MM-DD-slug.md`');
		expect(section).toContain('Public build log');
		expect(section).toContain('Frontmatter: `date`, `type`, `title`, `tags`');
		expect(section).toContain(
			'Types: `architecture`, `implementation`, `breakthrough`, `decision`, `refactor`, `integration`, `milestone`',
		);
		expect(section).toContain('Write entry when');
		expect(section).toContain('Skip entry when');
		expect(section).toContain('2-15 sentences');
	});

	it('QA-03: checked-in devlog entries follow the repository contract', () => {
		const entries = listDevlogEntries();
		expect(entries.length).toBeGreaterThan(0);

		for (const filename of entries) {
			expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);

			const filePath = resolve(DEVLOG_DIR, filename);
			const entry = parseFrontmatter(readFileSync(filePath, 'utf-8'));
			const dateFromFilename = filename.slice(0, 10);

			expect(entry.date).toBe(dateFromFilename);
			expect(entry.type).toBeDefined();
			expect(ALLOWED_TYPES.has(entry.type)).toBe(true);
			expect(entry.title.length).toBeGreaterThan(0);
			expect(entry.tags.length).toBeGreaterThan(0);
			expect(entry.body.length).toBeGreaterThan(0);
			expect(countSentences(entry.body)).toBeLessThanOrEqual(MAX_DEVLOG_SENTENCES);
		}
	});

	it('QA-04: the step stays documentation-only', () => {
		expect(existsSync(resolve(ROOT, 'apps/cli/src/commands/devlog.ts'))).toBe(false);
		expect(existsSync(resolve(ROOT, 'packages/devlog'))).toBe(false);
		expect(existsSync(resolve(ROOT, 'terraform/modules/devlog'))).toBe(false);
	});
});
