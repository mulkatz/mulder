import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EntityRecord, TranslatedStoryRecord } from '../lib/api-types';
import { getSafeTranslatedMentions, TranslatedAnnotatedMarkdown } from './TranslatedAnnotatedMarkdown';

const entity: EntityRecord = {
	attributes: {},
	canonical_id: null,
	corroboration_score: null,
	corroboration_status: 'not_scored',
	created_at: '2026-05-14T00:00:00.000Z',
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Adamski',
	source_count: 1,
	taxonomy_id: null,
	taxonomy_status: 'auto',
	type: 'person',
	updated_at: '2026-05-14T00:00:00.000Z',
};

function mention(
	markdown: string,
	surface: string,
	overrides: Partial<TranslatedStoryRecord['mentions'][number]> = {},
) {
	const start = markdown.indexOf(surface);
	if (start < 0) throw new Error(`Missing fixture surface: ${surface}`);
	return {
		confidence: 0.9,
		end_offset: start + surface.length,
		entity,
		entity_id: entity.id,
		id: `22222222-2222-4222-8222-${String(start).padStart(12, '0')}`,
		method: 'llm_structured_verified' as const,
		start_offset: start,
		surface_text: surface,
		translated_story_id: '33333333-3333-4333-8333-333333333333',
		...overrides,
	};
}

describe('TranslatedAnnotatedMarkdown', () => {
	it('keeps markdown structure while rendering verified offset highlights', () => {
		const markdown = '# Begegnung\n\n- Adamski berichtet\n- Danach folgt Kontext';
		const html = renderToStaticMarkup(
			createElement(TranslatedAnnotatedMarkdown, {
				markdown,
				mentions: [mention(markdown, 'Adamski')],
				onSelectEntity: () => {},
			}),
		);

		expect(html).toContain('<h1');
		expect(html).toContain('<ul');
		expect(html).toContain('<li');
		expect(html).toContain('<button');
		expect(html).toContain('Adamski');
	});

	it('rejects invalid, overlapping, and code-only mentions before rendering', () => {
		const markdown = 'Adamski trifft Adamski.\n\n`Adamski im Code`';
		const first = mention(markdown, 'Adamski');
		const overlapping = mention(markdown, 'Adamski trifft', {
			id: '22222222-2222-4222-8222-999999999999',
		});
		const wrongSurface = mention(markdown, 'Adamski', {
			id: '22222222-2222-4222-8222-888888888888',
			surface_text: 'Venus',
		});
		const codeStart = markdown.indexOf('Adamski im Code');
		const codeMention = {
			...mention(markdown, 'Adamski'),
			end_offset: codeStart + 'Adamski'.length,
			id: '22222222-2222-4222-8222-777777777777',
			start_offset: codeStart,
		};

		expect(getSafeTranslatedMentions(markdown, [first, overlapping, wrongSurface, codeMention])).toHaveLength(2);

		const html = renderToStaticMarkup(
			createElement(TranslatedAnnotatedMarkdown, {
				markdown,
				mentions: [first, overlapping, wrongSurface, codeMention],
				onSelectEntity: () => {},
			}),
		);
		expect(html.match(/<button/g) ?? []).toHaveLength(1);
		expect(html).toContain('<code');
	});
});
