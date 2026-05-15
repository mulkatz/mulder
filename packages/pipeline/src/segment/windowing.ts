/**
 * Pure helpers for page-windowed story segmentation.
 *
 * The LLM sees bounded page windows, while deterministic overlap handling keeps
 * multi-page stories connected across window boundaries.
 */

export interface SegmentWindowPage {
	pageNumber: number;
	text: string;
}

export interface SegmentWindow<TPage extends SegmentWindowPage = SegmentWindowPage> {
	index: number;
	pageStart: number;
	pageEnd: number;
	pages: TPage[];
}

export interface SegmentWindowOptions {
	windowPages: number;
	overlapPages: number;
}

export interface WindowedSegmentStory {
	title: string;
	subtitle: string | null;
	language: string;
	category: string;
	page_start: number;
	page_end: number;
	date_references: string[];
	geographic_references: string[];
	confidence: number;
	content_markdown: string;
}

export function createSegmentWindows<TPage extends SegmentWindowPage>(
	pages: TPage[],
	options: SegmentWindowOptions,
): Array<SegmentWindow<TPage>> {
	if (pages.length === 0) return [];

	const windowPages = Math.max(1, Math.floor(options.windowPages));
	const overlapPages = Math.min(Math.max(0, Math.floor(options.overlapPages)), Math.max(0, windowPages - 1));
	const stride = Math.max(1, windowPages - overlapPages);
	const windows: Array<SegmentWindow<TPage>> = [];

	for (let startIndex = 0; startIndex < pages.length; startIndex += stride) {
		const windowPagesSlice = pages.slice(startIndex, startIndex + windowPages);
		if (windowPagesSlice.length === 0) break;

		windows.push({
			index: windows.length,
			pageStart: windowPagesSlice[0]?.pageNumber ?? startIndex + 1,
			pageEnd: windowPagesSlice[windowPagesSlice.length - 1]?.pageNumber ?? startIndex + windowPagesSlice.length,
			pages: windowPagesSlice,
		});

		if (startIndex + windowPages >= pages.length) break;
	}

	return windows;
}

export function normalizeStoryTitle(title: string): string {
	return title
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function pageOverlap(
	left: Pick<WindowedSegmentStory, 'page_start' | 'page_end'>,
	right: Pick<WindowedSegmentStory, 'page_start' | 'page_end'>,
): number {
	return Math.max(0, Math.min(left.page_end, right.page_end) - Math.max(left.page_start, right.page_start) + 1);
}

function rangesTouchOrOverlap(left: WindowedSegmentStory, right: WindowedSegmentStory): boolean {
	if (pageOverlap(left, right) > 0) return true;
	return Math.abs(left.page_end - right.page_start) <= 1 || Math.abs(right.page_end - left.page_start) <= 1;
}

export function shouldMergeWindowStories(left: WindowedSegmentStory, right: WindowedSegmentStory): boolean {
	const leftTitle = normalizeStoryTitle(left.title);
	const rightTitle = normalizeStoryTitle(right.title);
	if (leftTitle.length === 0 || leftTitle !== rightTitle) return false;
	return rangesTouchOrOverlap(left, right);
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (normalized.length === 0 || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

function mergeMarkdown(left: string, right: string): string {
	const leftTrimmed = left.trim();
	const rightTrimmed = right.trim();
	if (leftTrimmed.length === 0) return rightTrimmed;
	if (rightTrimmed.length === 0) return leftTrimmed;
	if (leftTrimmed.includes(rightTrimmed)) return leftTrimmed;
	if (rightTrimmed.includes(leftTrimmed)) return rightTrimmed;
	return `${leftTrimmed}\n\n${rightTrimmed}`;
}

function mergeTwoStories(left: WindowedSegmentStory, right: WindowedSegmentStory): WindowedSegmentStory {
	const preferred = right.confidence > left.confidence ? right : left;
	return {
		title: preferred.title,
		subtitle: preferred.subtitle ?? left.subtitle ?? right.subtitle,
		language: preferred.language,
		category: preferred.category,
		page_start: Math.min(left.page_start, right.page_start),
		page_end: Math.max(left.page_end, right.page_end),
		date_references: uniqueStrings([...left.date_references, ...right.date_references]),
		geographic_references: uniqueStrings([...left.geographic_references, ...right.geographic_references]),
		confidence: Math.max(left.confidence, right.confidence),
		content_markdown:
			left.page_start <= right.page_start
				? mergeMarkdown(left.content_markdown, right.content_markdown)
				: mergeMarkdown(right.content_markdown, left.content_markdown),
	};
}

export function mergeWindowStories(stories: WindowedSegmentStory[]): WindowedSegmentStory[] {
	const merged: WindowedSegmentStory[] = [];
	const sorted = [...stories].sort(
		(left, right) => left.page_start - right.page_start || left.page_end - right.page_end,
	);

	for (const story of sorted) {
		const existingIndex = merged.findIndex((candidate) => shouldMergeWindowStories(candidate, story));
		if (existingIndex === -1) {
			merged.push({ ...story });
			continue;
		}
		merged[existingIndex] = mergeTwoStories(merged[existingIndex], story);
	}

	return merged.sort((left, right) => left.page_start - right.page_start || left.title.localeCompare(right.title));
}

export function buildPreviousWindowContext(
	stories: WindowedSegmentStory[],
	window: Pick<SegmentWindow, 'pageStart'>,
	limit = 6,
): string {
	const nearby = stories
		.filter((story) => story.page_end >= window.pageStart - 2)
		.sort((left, right) => left.page_start - right.page_start || left.page_end - right.page_end)
		.slice(-limit);

	if (nearby.length === 0) return '';

	const lines = [
		'## Previous Window Context',
		'These candidate stories were detected in earlier overlapping windows. Use this only to continue stories across page boundaries and to avoid duplicate stories; do not invent text that is not visible in the current pages. If a story continues, keep the same title and write only the continuation visible in the current pages.',
	];
	for (const story of nearby) {
		const excerpt = story.content_markdown.replace(/\s+/g, ' ').trim().slice(-500).trim();
		lines.push(
			`- "${story.title}" pages ${story.page_start}-${story.page_end}, confidence ${story.confidence.toFixed(2)}`,
		);
		if (excerpt.length > 0) {
			lines.push(`  Recent excerpt: ${excerpt}`);
		}
	}
	return lines.join('\n');
}

export function clampStoryToDocument(story: WindowedSegmentStory, pageCount: number): WindowedSegmentStory | null {
	const pageStart = Math.max(1, Math.min(pageCount, Math.floor(story.page_start)));
	const pageEnd = Math.max(pageStart, Math.min(pageCount, Math.floor(story.page_end)));
	const title = story.title.trim();
	if (title.length === 0 || story.content_markdown.trim().length === 0) return null;

	return {
		...story,
		title,
		page_start: pageStart,
		page_end: pageEnd,
		confidence: Math.max(0, Math.min(1, story.confidence)),
		content_markdown: story.content_markdown.trim(),
		date_references: uniqueStrings(story.date_references),
		geographic_references: uniqueStrings(story.geographic_references),
	};
}
