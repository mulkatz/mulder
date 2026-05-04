import { isPreStructuredType, shouldRun } from '@mulder/pipeline';
import { describe, expect, it } from 'vitest';

/**
 * Black-box QA tests for Spec 86: Pipeline Step Skipping — Pre-Structured Format Support
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests interact through system boundaries only: imports from `@mulder/pipeline` (public API).
 * Never imports from packages/ or src/ or apps/ internal paths.
 *
 * No database or GCP infrastructure is required — these are pure function tests.
 */

describe('Spec 86 — Pipeline Step Skipping', () => {
	// ─── QA-01: isPreStructuredType classifies correctly ───

	it('QA-01: isPreStructuredType returns true for pre-structured types and false for normal types', () => {
		// Pre-structured types → true
		expect(isPreStructuredType('text')).toBe(true);
		expect(isPreStructuredType('docx')).toBe(true);
		expect(isPreStructuredType('spreadsheet')).toBe(true);
		expect(isPreStructuredType('email')).toBe(true);
		expect(isPreStructuredType('url')).toBe(true);

		// Normal-pipeline types → false
		expect(isPreStructuredType('pdf')).toBe(false);
		expect(isPreStructuredType('image')).toBe(false);
	});

	// ─── QA-02: shouldRun skips segment for pre-structured types ───

	it('QA-02: shouldRun("segment") returns false for pre-structured types, true for pdf', () => {
		expect(shouldRun('segment', 'extracted', [], {}, 'text')).toBe(false);
		expect(shouldRun('segment', 'extracted', [], {}, 'docx')).toBe(false);
		expect(shouldRun('segment', 'extracted', [], {}, 'email')).toBe(false);

		// PDF at extracted should still run segment (normal pipeline)
		expect(shouldRun('segment', 'extracted', [], {}, 'pdf')).toBe(true);
	});

	// ─── QA-03: shouldRun skips segment even with force=true ───

	it('QA-03: shouldRun("segment") returns false for pre-structured types even when force=true', () => {
		expect(shouldRun('segment', 'extracted', [], { force: true }, 'text')).toBe(false);

		// force=true on PDF still runs segment
		expect(shouldRun('segment', 'extracted', [], { force: true }, 'pdf')).toBe(true);
	});

	// ─── QA-04: shouldRun allows enrich from extracted for pre-structured types ───

	it('QA-04: shouldRun("enrich") returns true for pre-structured types at extracted status', () => {
		expect(shouldRun('enrich', 'extracted', [], {}, 'text')).toBe(true);
		expect(shouldRun('enrich', 'extracted', [], {}, 'docx')).toBe(true);

		// PDF at extracted must NOT enrich (still needs segment first)
		expect(shouldRun('enrich', 'extracted', [], {}, 'pdf')).toBe(false);
	});

	// ─── QA-05: shouldRun allows enrich from segmented (unchanged PDF path) ───

	it('QA-05: shouldRun("enrich") returns true for segmented status regardless of sourceType', () => {
		expect(shouldRun('enrich', 'segmented', [], {}, 'pdf')).toBe(true);
		expect(shouldRun('enrich', 'segmented', [], {}, undefined)).toBe(true);
	});

	// ─── QA-06: shouldRun with no sourceType is backward-compatible ───

	it('QA-06: shouldRun without 5th argument preserves pre-J2 behaviour', () => {
		// No sourceType → segment still runs from extracted (original behaviour)
		expect(shouldRun('segment', 'extracted', [], {})).toBe(true);

		// No sourceType → enrich does NOT run from extracted (original behaviour)
		expect(shouldRun('enrich', 'extracted', [], {})).toBe(false);
	});

	// ─── QA-07: isPreStructuredType is exported from the pipeline package ───

	it('QA-07: isPreStructuredType is importable from @mulder/pipeline and callable', () => {
		// Import resolved at the top of this file. If it were missing, vitest would
		// fail to load the module and none of these tests would execute. Additionally,
		// verify the function is callable and returns a boolean.
		expect(typeof isPreStructuredType).toBe('function');
		const result = isPreStructuredType('pdf');
		expect(typeof result).toBe('boolean');
	});
});
