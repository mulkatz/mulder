import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Black-box QA tests for Spec 18: Prompt Template Engine
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests import from `@mulder/core` barrel — the public API surface.
 * No imports from packages/core/src/ internals.
 *
 * Requires:
 * - Built core package at packages/core/dist/index.js
 */

describe('Spec 18: Prompt Template Engine', () => {
	let renderPrompt: (templateName: string, variables: Record<string, unknown>) => string;
	let listTemplates: () => string[];
	let clearPromptCaches: () => void;
	let PromptError: any;
	let PROMPT_ERROR_CODES: Record<string, string>;

	beforeAll(async () => {
		const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
		renderPrompt = core.renderPrompt;
		listTemplates = core.listTemplates;
		clearPromptCaches = core.clearPromptCaches;
		PromptError = core.PromptError;
		PROMPT_ERROR_CODES = core.PROMPT_ERROR_CODES;
	});

	afterEach(() => {
		// Clear caches between tests so each test starts fresh
		clearPromptCaches();
	});

	// -------------------------------------------------------------------------
	// QA-01: Basic variable interpolation
	// -------------------------------------------------------------------------
	it('QA-01: basic variable interpolation replaces {{ name }} with value', () => {
		// The segment template contains {{ page_count }} and {{ has_native_text }}
		// among other variables. We use the segment template with locale to satisfy
		// all i18n references, then check that page_count and has_native_text are
		// substituted.
		const result = renderPrompt('segment', {
			locale: 'en',
			page_count: 42,
			has_native_text: true,
		});

		expect(result).toContain('42');
		expect(result).toContain('true');
		// Should not contain unresolved placeholders for the variables we provided
		expect(result).not.toContain('{{ page_count }}');
		expect(result).not.toContain('{{ has_native_text }}');
	});

	// -------------------------------------------------------------------------
	// QA-02: Dot-notation variable access
	// -------------------------------------------------------------------------
	it('QA-02: dot-notation variable access resolves {{ i18n.common.json_instruction }}', () => {
		// When locale is set to 'en', i18n.common.json_instruction should be loaded
		// from en.json and substituted into the template
		const result = renderPrompt('segment', {
			locale: 'en',
			page_count: 5,
			has_native_text: true,
		});

		// The English json_instruction fragment:
		expect(result).toContain('Return valid JSON only');
		// No unresolved i18n placeholders
		expect(result).not.toContain('{{ i18n.common.json_instruction }}');
	});

	// -------------------------------------------------------------------------
	// QA-03: Missing variable throws
	// -------------------------------------------------------------------------
	it('QA-03: missing variable throws PromptError with TEMPLATE_VARIABLE_MISSING', () => {
		// segment.jinja2 requires page_count and has_native_text — omit them
		try {
			renderPrompt('segment', { locale: 'en' });
			expect.fail('Expected PromptError to be thrown');
		} catch (err: any) {
			expect(err).toBeInstanceOf(PromptError);
			expect(err.code).toBe(PROMPT_ERROR_CODES.TEMPLATE_VARIABLE_MISSING);
		}
	});

	// -------------------------------------------------------------------------
	// QA-04: Missing template throws
	// -------------------------------------------------------------------------
	it('QA-04: missing template throws PromptError with TEMPLATE_NOT_FOUND', () => {
		try {
			renderPrompt('nonexistent-template-that-does-not-exist', {});
			expect.fail('Expected PromptError to be thrown');
		} catch (err: any) {
			expect(err).toBeInstanceOf(PromptError);
			expect(err.code).toBe(PROMPT_ERROR_CODES.TEMPLATE_NOT_FOUND);
		}
	});

	// -------------------------------------------------------------------------
	// QA-05: Locale loading — German
	// -------------------------------------------------------------------------
	it('QA-05: locale loading substitutes German fragment for locale de', () => {
		const result = renderPrompt('segment', {
			locale: 'de',
			page_count: 10,
			has_native_text: false,
		});

		// The German segment.system_role begins with "Du bist ein Dokumentenanalyst"
		expect(result).toContain('Du bist ein Dokumentenanalyst');
		// German json_instruction
		expect(result).toContain('Gib ausschliesslich valides JSON zurueck');
	});

	// -------------------------------------------------------------------------
	// QA-06: Missing locale throws
	// -------------------------------------------------------------------------
	it('QA-06: missing locale throws PromptError with LOCALE_FILE_NOT_FOUND', () => {
		try {
			renderPrompt('segment', {
				locale: 'fr',
				page_count: 1,
				has_native_text: true,
			});
			expect.fail('Expected PromptError to be thrown');
		} catch (err: any) {
			expect(err).toBeInstanceOf(PromptError);
			expect(err.code).toBe(PROMPT_ERROR_CODES.LOCALE_FILE_NOT_FOUND);
		}
	});

	// -------------------------------------------------------------------------
	// QA-07: All starter templates loadable
	// -------------------------------------------------------------------------
	it('QA-07: listTemplates() returns all 6 template names', () => {
		const templates = listTemplates();

		expect(templates).toBeInstanceOf(Array);
		expect(templates.length).toBeGreaterThanOrEqual(6);

		const expected = [
			'segment',
			'extract-entities',
			'ground-entity',
			'resolve-contradiction',
			'generate-questions',
			'rerank',
		];

		for (const name of expected) {
			expect(templates).toContain(name);
		}
	});

	// -------------------------------------------------------------------------
	// QA-08: Template caching
	// -------------------------------------------------------------------------
	it('QA-08: template caching — second call uses cached template', () => {
		// Clear caches to start clean
		clearPromptCaches();

		const vars = {
			locale: 'en',
			page_count: 3,
			has_native_text: false,
		};

		// First call loads template from disk
		const result1 = renderPrompt('segment', vars);

		// Second call should use cached template — result should be identical
		const result2 = renderPrompt('segment', vars);

		expect(result1).toBe(result2);

		// Both should be non-empty valid renders
		expect(result1.length).toBeGreaterThan(0);
		expect(result1).not.toContain('{{ ');
	});

	// -------------------------------------------------------------------------
	// QA-09: Segment template renders cleanly
	// -------------------------------------------------------------------------
	it('QA-09: segment template renders without unresolved {{ }} placeholders', () => {
		const result = renderPrompt('segment', {
			locale: 'en',
			page_count: 5,
			has_native_text: true,
		});

		expect(result.length).toBeGreaterThan(0);
		// No unresolved {{ variable }} placeholders
		expect(result).not.toMatch(/\{\{.*?\}\}/);
		// Should contain actual content from the template
		expect(result).toContain('Document Context');
		expect(result).toContain('5');
	});

	// -------------------------------------------------------------------------
	// QA-10: Extract-entities template renders cleanly
	// -------------------------------------------------------------------------
	it('QA-10: extract-entities template renders without unresolved {{ }} placeholders', () => {
		const result = renderPrompt('extract-entities', {
			locale: 'en',
			ontology: '{"entity_types": [{"name": "person", "attributes": ["name", "role"]}]}',
			story_text: 'John Smith was the lead investigator on the case in 1975.',
		});

		expect(result.length).toBeGreaterThan(0);
		// No unresolved {{ variable }} placeholders
		expect(result).not.toMatch(/\{\{.*?\}\}/);
		// Should contain the ontology and story text we passed in
		expect(result).toContain('person');
		expect(result).toContain('John Smith');
	});
});
