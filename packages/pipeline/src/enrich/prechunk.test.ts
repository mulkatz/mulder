import { describe, expect, it } from 'vitest';
import { preChunkMarkdown } from './index.js';

describe('enrich pre-chunking', () => {
	it('splits oversized OCR paragraphs instead of sending them as one prompt', () => {
		const paragraph = Array.from(
			{ length: 30 },
			(_, index) =>
				`Sentence ${index + 1} contains enough text to make the paragraph too large for one enrichment call.`,
		).join(' ');

		const chunks = preChunkMarkdown(paragraph, 80);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true);
		expect(chunks.join(' ')).toContain('Sentence 30');
	});
});
