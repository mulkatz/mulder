/**
 * Stories export format converters.
 *
 * Pure functions: (data) => string. No side effects, no DB calls.
 *
 * @see docs/specs/53_export_commands.spec.md §4.2
 */

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface StoryExportEntity {
	id: string;
	name: string;
	type: string;
	mentionCount: number;
}

export interface StoryExport {
	id: string;
	sourceId: string;
	title: string;
	subtitle: string | null;
	language: string | null;
	category: string | null;
	pageStart: number | null;
	pageEnd: number | null;
	status: string;
	chunkCount: number;
	extractionConfidence: number | null;
	entities: StoryExportEntity[];
}

// ────────────────────────────────────────────────────────────
// JSON
// ────────────────────────────────────────────────────────────

export function formatStoriesJson(stories: StoryExport[]): string {
	const output = {
		stories,
		metadata: {
			exportedAt: new Date().toISOString(),
			storyCount: stories.length,
		},
	};
	return JSON.stringify(output, null, 2);
}

// ────────────────────────────────────────────────────────────
// CSV
// ────────────────────────────────────────────────────────────

/** Escapes a CSV field value. Wraps in quotes if it contains commas, quotes, or newlines. */
function escapeCsv(value: string): string {
	if (value.includes(',') || value.includes('"') || value.includes('\n')) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export function formatStoriesCsv(stories: StoryExport[]): string {
	const lines: string[] = [];

	lines.push(
		'id,sourceId,title,subtitle,language,category,pageStart,pageEnd,status,chunkCount,extractionConfidence,entities',
	);

	for (const story of stories) {
		const entityNames = story.entities.map((e) => e.name).join(';');
		lines.push(
			[
				escapeCsv(story.id),
				escapeCsv(story.sourceId),
				escapeCsv(story.title),
				escapeCsv(story.subtitle ?? ''),
				escapeCsv(story.language ?? ''),
				escapeCsv(story.category ?? ''),
				story.pageStart !== null ? String(story.pageStart) : '',
				story.pageEnd !== null ? String(story.pageEnd) : '',
				escapeCsv(story.status),
				String(story.chunkCount),
				story.extractionConfidence !== null ? String(story.extractionConfidence) : '',
				escapeCsv(entityNames),
			].join(','),
		);
	}

	return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
// Markdown
// ────────────────────────────────────────────────────────────

export function formatStoriesMarkdown(stories: StoryExport[]): string {
	const lines: string[] = [];

	lines.push(`# Stories Export`);
	lines.push('');
	lines.push(`Exported: ${new Date().toISOString()}`);
	lines.push(`Total stories: ${stories.length}`);
	lines.push('');

	for (const story of stories) {
		lines.push(`## ${story.title}`);
		lines.push('');

		// Metadata table
		lines.push('| Field | Value |');
		lines.push('|-------|-------|');
		lines.push(`| ID | ${story.id} |`);
		lines.push(`| Source | ${story.sourceId} |`);
		if (story.subtitle) {
			lines.push(`| Subtitle | ${story.subtitle} |`);
		}
		if (story.language) {
			lines.push(`| Language | ${story.language} |`);
		}
		if (story.category) {
			lines.push(`| Category | ${story.category} |`);
		}
		if (story.pageStart !== null || story.pageEnd !== null) {
			lines.push(`| Pages | ${story.pageStart ?? '?'}–${story.pageEnd ?? '?'} |`);
		}
		lines.push(`| Status | ${story.status} |`);
		lines.push(`| Chunks | ${story.chunkCount} |`);
		if (story.extractionConfidence !== null) {
			lines.push(`| Extraction Confidence | ${story.extractionConfidence} |`);
		}
		lines.push('');

		// Entities
		if (story.entities.length > 0) {
			lines.push('**Entities:**');
			for (const entity of story.entities) {
				lines.push(`- ${entity.name} (${entity.type}, ${entity.mentionCount} mentions)`);
			}
			lines.push('');
		}

		lines.push('---');
		lines.push('');
	}

	return lines.join('\n');
}
