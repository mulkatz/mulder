import { describe, expect, it } from 'vitest';
import {
	buildPreviousWindowContext,
	clampStoryToDocument,
	createSegmentWindows,
	mergeWindowStories,
} from './windowing.js';

describe('segment windowing helpers', () => {
	it('splits long documents into overlapping bounded windows', () => {
		const pages = Array.from({ length: 119 }, (_, index) => ({
			pageNumber: index + 1,
			text: `Page ${index + 1}`,
		}));

		const windows = createSegmentWindows(pages, { windowPages: 8, overlapPages: 1 });

		expect(windows[0]).toMatchObject({ pageStart: 1, pageEnd: 8 });
		expect(windows[1]).toMatchObject({ pageStart: 8, pageEnd: 15 });
		expect(windows.at(-1)?.pageEnd).toBe(119);
		expect(windows.every((window) => window.pages.length <= 8)).toBe(true);
	});

	it('merges same-title stories across overlapping or touching windows without losing markdown', () => {
		const stories = mergeWindowStories([
			{
				title: 'Sighting Report',
				subtitle: null,
				language: 'en',
				category: 'sighting_report',
				page_start: 7,
				page_end: 8,
				date_references: ['1980-01-01'],
				geographic_references: ['London'],
				confidence: 0.72,
				content_markdown: 'First part.',
			},
			{
				title: 'Sighting Report',
				subtitle: null,
				language: 'en',
				category: 'sighting_report',
				page_start: 8,
				page_end: 10,
				date_references: ['1980-01-01'],
				geographic_references: ['Kent'],
				confidence: 0.9,
				content_markdown: 'Second part.',
			},
		]);

		expect(stories).toHaveLength(1);
		expect(stories[0]).toMatchObject({
			title: 'Sighting Report',
			page_start: 7,
			page_end: 10,
			confidence: 0.9,
			geographic_references: ['London', 'Kent'],
		});
		expect(stories[0]?.content_markdown).toContain('First part.');
		expect(stories[0]?.content_markdown).toContain('Second part.');
	});

	it('keeps distinct same-title stories separate when page ranges are distant', () => {
		const stories = mergeWindowStories([
			{
				title: 'Letters',
				subtitle: null,
				language: 'en',
				category: 'letters',
				page_start: 2,
				page_end: 3,
				date_references: [],
				geographic_references: [],
				confidence: 0.8,
				content_markdown: 'Early letters.',
			},
			{
				title: 'Letters',
				subtitle: null,
				language: 'en',
				category: 'letters',
				page_start: 40,
				page_end: 41,
				date_references: [],
				geographic_references: [],
				confidence: 0.8,
				content_markdown: 'Later letters.',
			},
		]);

		expect(stories).toHaveLength(2);
	});

	it('merges same-title stories that touch at a page boundary to preserve continuity', () => {
		const stories = mergeWindowStories([
			{
				title: 'Continued Investigation',
				subtitle: null,
				language: 'en',
				category: 'article',
				page_start: 1,
				page_end: 7,
				date_references: [],
				geographic_references: [],
				confidence: 0.7,
				content_markdown: 'Opening pages.',
			},
			{
				title: 'Continued Investigation',
				subtitle: null,
				language: 'en',
				category: 'article',
				page_start: 8,
				page_end: 14,
				date_references: [],
				geographic_references: [],
				confidence: 0.72,
				content_markdown: 'Continuation pages.',
			},
		]);

		expect(stories).toHaveLength(1);
		expect(stories[0]).toMatchObject({ page_start: 1, page_end: 14 });
	});

	it('builds previous-window context for boundary continuation', () => {
		const context = buildPreviousWindowContext(
			[
				{
					title: 'Long Article',
					subtitle: null,
					language: 'en',
					category: 'article',
					page_start: 6,
					page_end: 8,
					date_references: [],
					geographic_references: [],
					confidence: 0.82,
					content_markdown: 'Earlier pages.',
				},
			],
			{ pageStart: 8 },
		);

		expect(context).toContain('Long Article');
		expect(context).toContain('pages 6-8');
		expect(context).toContain('avoid duplicate stories');
	});

	it('clamps page ranges and rejects unusable story payloads', () => {
		expect(
			clampStoryToDocument(
				{
					title: '  Article  ',
					subtitle: null,
					language: 'en',
					category: 'article',
					page_start: -5,
					page_end: 200,
					date_references: [' 1980-01-01 ', '1980-01-01'],
					geographic_references: [],
					confidence: 4,
					content_markdown: ' Body ',
				},
				119,
			),
		).toMatchObject({
			title: 'Article',
			page_start: 1,
			page_end: 119,
			confidence: 1,
			date_references: ['1980-01-01'],
			content_markdown: 'Body',
		});

		expect(
			clampStoryToDocument(
				{
					title: '',
					subtitle: null,
					language: 'en',
					category: 'article',
					page_start: 1,
					page_end: 1,
					date_references: [],
					geographic_references: [],
					confidence: 0.5,
					content_markdown: 'Body',
				},
				1,
			),
		).toBeNull();
	});
});
