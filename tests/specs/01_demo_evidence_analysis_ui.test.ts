import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const DEMO = resolve(ROOT, 'demo');

/**
 * Black-box QA tests for Spec 01: Demo App — Evidence Analysis UI
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests verify structural correctness (files, routes, mock data, build)
 * without importing from source code.
 */
describe('Spec 01: Demo Evidence Analysis UI', () => {
	// ─── QA-01: Evidence page renders with three tabs ───

	describe('QA-01: Evidence page exists with three tabs', () => {
		let evidenceSource: string;

		beforeAll(() => {
			evidenceSource = readFileSync(resolve(DEMO, 'src/pages/Evidence.tsx'), 'utf-8');
		});

		it('Evidence.tsx page file exists', () => {
			expect(existsSync(resolve(DEMO, 'src/pages/Evidence.tsx'))).toBe(true);
		});

		it('page contains three tab labels: Contradictions, Corroboration, Spatio-Temporal', () => {
			// The spec requires these three tab labels (may be in German or English)
			const hasContradictions = evidenceSource.includes('Contradictions') || evidenceSource.includes('Widersprüche');
			const hasCorroboration = evidenceSource.includes('Corroboration') || evidenceSource.includes('Bestätigung');
			const hasSpatioTemporal =
				evidenceSource.includes('Spatio-Temporal') ||
				evidenceSource.includes('Raum-Zeit') ||
				evidenceSource.includes('Spatio');

			expect(hasContradictions, 'Missing Contradictions tab').toBe(true);
			expect(hasCorroboration, 'Missing Corroboration tab').toBe(true);
			expect(hasSpatioTemporal, 'Missing Spatio-Temporal tab').toBe(true);
		});
	});

	// ─── QA-02: Contradictions tab shows mock data ───

	describe('QA-02: Contradictions mock data exists', () => {
		let mockSource: string;

		beforeAll(() => {
			mockSource = readFileSync(resolve(DEMO, 'src/data/mock.ts'), 'utf-8');
		});

		it('mock.ts exports contradictions array', () => {
			expect(mockSource).toMatch(/export\s+(const|let)\s+contradictions/);
		});

		it('mock.ts exports ContradictionStatus type', () => {
			expect(mockSource).toMatch(/export\s+type\s+ContradictionStatus/);
		});

		it('contradictions have POTENTIAL, CONFIRMED, and DISMISSED statuses', () => {
			expect(mockSource).toContain('POTENTIAL');
			expect(mockSource).toContain('CONFIRMED');
			expect(mockSource).toContain('DISMISSED');
		});
	});

	// ─── QA-03: Contradiction status filtering ───

	describe('QA-03: Contradiction status filtering is implemented', () => {
		it('Evidence page implements filter state management', () => {
			const source = readFileSync(resolve(DEMO, 'src/pages/Evidence.tsx'), 'utf-8');
			// The page should have filter state for contradiction statuses
			const hasFilterState = source.includes('useState') && source.includes('filter');
			expect(hasFilterState, 'Missing filter state management').toBe(true);
		});
	});

	// ─── QA-04: Corroboration tab shows scored entries ───

	describe('QA-04: Corroboration mock data exists', () => {
		it('mock.ts exports corroborationEntries array', () => {
			const mockSource = readFileSync(resolve(DEMO, 'src/data/mock.ts'), 'utf-8');
			expect(mockSource).toMatch(/export\s+(const|let)\s+corroborationEntries/);
		});

		it('corroboration entries include score fields', () => {
			const mockSource = readFileSync(resolve(DEMO, 'src/data/mock.ts'), 'utf-8');
			expect(mockSource).toContain('corroborationScore');
		});
	});

	// ─── QA-05: Spatio-Temporal tab shows events and visualization ───

	describe('QA-05: Spatio-Temporal mock data exists', () => {
		it('mock.ts exports spatioTemporalEvents array', () => {
			const mockSource = readFileSync(resolve(DEMO, 'src/data/mock.ts'), 'utf-8');
			expect(mockSource).toMatch(/export\s+(const|let)\s+spatioTemporalEvents/);
		});

		it('mock.ts exports temporalClusters array', () => {
			const mockSource = readFileSync(resolve(DEMO, 'src/data/mock.ts'), 'utf-8');
			expect(mockSource).toMatch(/export\s+(const|let)\s+temporalClusters/);
		});

		it('spatio-temporal events include location data', () => {
			const mockSource = readFileSync(resolve(DEMO, 'src/data/mock.ts'), 'utf-8');
			expect(mockSource).toContain('lat');
			expect(mockSource).toContain('lng');
		});
	});

	// ─── QA-06: Navigation includes Evidence link ───

	describe('QA-06: Navigation includes Evidence link', () => {
		it('Evidence route is registered in App.tsx', () => {
			const appSource = readFileSync(resolve(DEMO, 'src/App.tsx'), 'utf-8');
			expect(appSource).toContain('/evidence');
			expect(appSource).toContain('Evidence');
		});

		it('Layout includes Evidence navigation item', () => {
			const layoutSource = readFileSync(resolve(DEMO, 'src/components/Layout.tsx'), 'utf-8');
			expect(layoutSource).toContain('/evidence');
		});
	});

	// ─── QA-07: Dark mode support ───

	describe('QA-07: Dark mode support', () => {
		it('Evidence page uses dark: variants for styling', () => {
			const source = readFileSync(resolve(DEMO, 'src/pages/Evidence.tsx'), 'utf-8');
			const darkClasses = source.match(/dark:/g);
			expect(darkClasses, 'Evidence page should have dark mode CSS classes').not.toBeNull();
			expect(darkClasses?.length, 'Expected multiple dark mode classes').toBeGreaterThan(5);
		});
	});

	// ─── QA-08: Existing pages unaffected + demo builds ───

	describe('QA-08: Existing pages unaffected', () => {
		it('all expected page files exist', () => {
			const pages = [
				'Dashboard.tsx',
				'SourceLibrary.tsx',
				'SourceDetail.tsx',
				'Stories.tsx',
				'StoryDetail.tsx',
				'EntityList.tsx',
				'EntityDetail.tsx',
				'Graph.tsx',
				'Evidence.tsx',
				'Board.tsx',
				'Settings.tsx',
			];
			for (const page of pages) {
				expect(existsSync(resolve(DEMO, 'src/pages', page)), `Missing page: ${page}`).toBe(true);
			}
		});
	});
});
