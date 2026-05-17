import { describe, expect, it } from 'vitest';
import { chunkStory } from './semantic-chunker.js';

describe('semantic chunker', () => {
	it('keeps making progress when overlap would otherwise repeat a single block forever', () => {
		const markdown = [
			'This first paragraph is deliberately long enough to become its own chunk. It has several sentences. It should not be repeated endlessly by overlap handling.',
			'This second paragraph is also deliberately long enough to become its own chunk. It is here to prove the chunker moves forward.',
			'This third paragraph closes the regression case. It should be reachable without exhausting memory.',
		].join('\n\n');

		const chunks = chunkStory(markdown, 9, 11, {
			chunkSizeTokens: 20,
			chunkOverlapTokens: 50,
		});

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.length).toBeLessThanOrEqual(10);
		expect(chunks.map((chunk) => chunk.content).join('\n')).toContain(
			'This third paragraph closes the regression case.',
		);
	});
});
