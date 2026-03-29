import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const DEMO_DIR = resolve(import.meta.dirname, '../../demo');
const SRC_DIR = resolve(DEMO_DIR, 'src');

/**
 * Black-box QA tests for Spec 01: Demo App — Evidence Analysis UI
 *
 * These tests validate observable artifacts (files, compilation, build output,
 * exported data structures) without importing or reading implementation logic.
 * Each `it()` block maps to one QA condition from Section 5 of the spec.
 */
describe('Spec 01: Demo App — Evidence Analysis UI', () => {
	// Pre-check: ensure demo app compiles and builds
	let tscSuccess: boolean;
	let tscOutput: string;
	let buildSuccess: boolean;
	let buildOutput: string;

	beforeAll(() => {
		// TypeScript compilation check
		try {
			tscOutput = execFileSync('npx', ['tsc', '-b', '--dry'], { cwd: DEMO_DIR, encoding: 'utf-8', timeout: 60_000 });
			tscSuccess = true;
		} catch (e: unknown) {
			const error = e as { stdout?: string; stderr?: string };
			tscOutput = (error.stdout ?? '') + (error.stderr ?? '');
			tscSuccess = false;
		}

		// Vite build check
		try {
			buildOutput = execFileSync('npx', ['vite', 'build'], { cwd: DEMO_DIR, encoding: 'utf-8', timeout: 120_000 });
			buildSuccess = true;
		} catch (e: unknown) {
			const error = e as { stdout?: string; stderr?: string };
			buildOutput = (error.stdout ?? '') + (error.stderr ?? '');
			buildSuccess = false;
		}
	}, 180_000);

	// ---------- QA-01: Evidence page renders with three tabs ----------
	it('QA-01: Evidence page file exists and app compiles with it', () => {
		// Verify the Evidence page file exists
		const evidencePage = resolve(SRC_DIR, 'pages/Evidence.tsx');
		expect(existsSync(evidencePage), 'Evidence.tsx must exist at demo/src/pages/Evidence.tsx').toBe(true);

		// Verify TypeScript compilation succeeds (page integrates without errors)
		expect(tscSuccess, `TypeScript compilation must succeed. Errors:\n${tscOutput}`).toBe(true);

		// Verify the build succeeds (page is bundled correctly)
		expect(buildSuccess, `Vite build must succeed. Output:\n${buildOutput}`).toBe(true);

		// Verify the Evidence page references the three tab labels
		const content = readFileSync(evidencePage, 'utf-8');
		expect(content).toContain('Contradictions');
		expect(content).toContain('Corroboration');
		expect(content).toContain('Spatio-Temporal');
	});

	// ---------- QA-02: Contradictions tab shows mock data ----------
	it('QA-02: Mock data includes contradictions with required fields', () => {
		const mockFile = resolve(SRC_DIR, 'data/mock.ts');
		expect(existsSync(mockFile), 'mock.ts must exist at demo/src/data/mock.ts').toBe(true);

		const content = readFileSync(mockFile, 'utf-8');

		// Must export a Contradiction interface/type
		expect(
			content.match(/(?:interface|type)\s+Contradiction\b/),
			'mock.ts must define a Contradiction interface or type',
		).not.toBeNull();

		// Must export a contradictions array
		expect(
			content.match(/export\s+(?:const|let)\s+contradictions\b/),
			'mock.ts must export a contradictions array',
		).not.toBeNull();

		// Contradictions must include status values (POTENTIAL, CONFIRMED, DISMISSED)
		expect(content).toContain('POTENTIAL');
		expect(content).toContain('CONFIRMED');
		expect(content).toContain('DISMISSED');

		// Must have at least 5 contradiction entries (spec says 6-8 items, QA says "at least 5")
		const contradictionMatches = content.match(/status:\s*['"`](?:POTENTIAL|CONFIRMED|DISMISSED)['"`]/g);
		expect(
			contradictionMatches && contradictionMatches.length >= 5,
			`Must have at least 5 contradiction entries, found ${contradictionMatches?.length ?? 0}`,
		).toBe(true);
	});

	// ---------- QA-03: Contradiction status filtering works ----------
	it('QA-03: Evidence page implements status filtering UI', () => {
		const evidencePage = resolve(SRC_DIR, 'pages/Evidence.tsx');
		const content = readFileSync(evidencePage, 'utf-8');

		// The page must reference filter-related concepts for contradiction statuses
		// Black-box: we verify the page contains filtering logic by checking for
		// status values used in filter context
		expect(content).toContain('POTENTIAL');
		expect(content).toContain('CONFIRMED');
		expect(content).toContain('DISMISSED');

		// Must have some form of filter state or filter handler
		expect(
			content.match(/filter|Filter/),
			'Evidence page must contain filter-related code for status filtering',
		).not.toBeNull();
	});

	// ---------- QA-04: Corroboration tab shows scored entries ----------
	it('QA-04: Mock data includes corroboration entries with required fields', () => {
		const mockFile = resolve(SRC_DIR, 'data/mock.ts');
		const content = readFileSync(mockFile, 'utf-8');

		// Must export a CorroborationEntry interface/type
		expect(
			content.match(/(?:interface|type)\s+CorroborationEntry\b/),
			'mock.ts must define a CorroborationEntry interface or type',
		).not.toBeNull();

		// Must export a corroborationEntries array
		expect(
			content.match(/export\s+(?:const|let)\s+corroborationEntries\b/),
			'mock.ts must export a corroborationEntries array',
		).not.toBeNull();

		// Must have fields for source count, corroboration score, and reliability
		// These are the key data fields per the spec
		expect(
			content.match(/sourceCount|source_count|independentSources/i),
			'CorroborationEntry must include a source count field',
		).not.toBeNull();

		expect(
			content.match(/corroborationScore|corroboration_score|score/i),
			'CorroborationEntry must include a corroboration score field',
		).not.toBeNull();

		expect(
			content.match(/sourceReliability|source_reliability|reliability/i),
			'CorroborationEntry must include a source reliability field',
		).not.toBeNull();
	});

	// ---------- QA-05: Spatio-Temporal tab shows events and visualization ----------
	it('QA-05: Mock data includes spatio-temporal events with coordinates and timestamps', () => {
		const mockFile = resolve(SRC_DIR, 'data/mock.ts');
		const content = readFileSync(mockFile, 'utf-8');

		// Must export a SpatioTemporalEvent interface/type
		expect(
			content.match(/(?:interface|type)\s+SpatioTemporalEvent\b/),
			'mock.ts must define a SpatioTemporalEvent interface or type',
		).not.toBeNull();

		// Must export a spatioTemporalEvents array
		expect(
			content.match(/export\s+(?:const|let)\s+spatioTemporalEvents\b/),
			'mock.ts must export a spatioTemporalEvents array',
		).not.toBeNull();

		// Must include coordinate fields (lat/lng)
		expect(content.match(/lat\b/), 'SpatioTemporalEvent must include latitude field').not.toBeNull();

		expect(content.match(/lng\b/), 'SpatioTemporalEvent must include longitude field').not.toBeNull();

		// Must include timestamp field
		expect(content.match(/timestamp|date/i), 'SpatioTemporalEvent must include timestamp or date field').not.toBeNull();

		// Must include location name
		expect(
			content.match(/location|locationName|location_name/),
			'SpatioTemporalEvent must include location name field',
		).not.toBeNull();

		// Must export TemporalCluster interface and array
		expect(
			content.match(/(?:interface|type)\s+TemporalCluster\b/),
			'mock.ts must define a TemporalCluster interface or type',
		).not.toBeNull();

		expect(
			content.match(/export\s+(?:const|let)\s+temporalClusters\b/),
			'mock.ts must export a temporalClusters array',
		).not.toBeNull();

		// Evidence page must contain SVG visualization elements
		const evidencePage = resolve(SRC_DIR, 'pages/Evidence.tsx');
		const evidenceContent = readFileSync(evidencePage, 'utf-8');
		expect(
			evidenceContent.match(/<svg|<circle|SVG|viewBox/i),
			'Evidence page must include SVG-based visualization for spatio-temporal tab',
		).not.toBeNull();
	});

	// ---------- QA-06: Navigation includes Evidence link ----------
	it('QA-06: Layout includes Evidence navigation item with correct route', () => {
		const layoutFile = resolve(SRC_DIR, 'components/Layout.tsx');
		expect(existsSync(layoutFile), 'Layout.tsx must exist').toBe(true);

		const content = readFileSync(layoutFile, 'utf-8');

		// Must contain "Evidence" as a navigation label
		expect(content).toContain('Evidence');

		// Must reference the /evidence route
		expect(content).toContain('/evidence');

		// Must use Shield icon from lucide-react (per spec)
		expect(content.match(/Shield/), 'Layout must reference Shield icon for Evidence nav item').not.toBeNull();
	});

	// ---------- QA-06 (cont): Route registration in App.tsx ----------
	it('QA-06b: App.tsx registers /evidence route pointing to Evidence component', () => {
		const appFile = resolve(SRC_DIR, 'App.tsx');
		expect(existsSync(appFile), 'App.tsx must exist').toBe(true);

		const content = readFileSync(appFile, 'utf-8');

		// Must import Evidence page
		expect(content.match(/import.*Evidence.*from/), 'App.tsx must import the Evidence page component').not.toBeNull();

		// Must register /evidence route
		expect(content.match(/['"\/]evidence['"]/), 'App.tsx must register the /evidence route').not.toBeNull();
	});

	// ---------- QA-07: Dark mode support ----------
	it('QA-07: Evidence page uses CSS variables / Tailwind classes for dark mode (no hardcoded colors)', () => {
		const evidencePage = resolve(SRC_DIR, 'pages/Evidence.tsx');
		const content = readFileSync(evidencePage, 'utf-8');

		// Must NOT contain hardcoded light-only color values like #ffffff, rgb(255,255,255), white background
		// We check for common hardcoded color patterns that would break dark mode
		const hardcodedWhiteBg = content.match(/(?:background(?:-color)?:\s*(?:#fff|#ffffff|white|rgb\(255))/i);
		expect(
			hardcodedWhiteBg,
			'Evidence page must not contain hardcoded white backgrounds (breaks dark mode)',
		).toBeNull();

		const hardcodedBlackText = content.match(/(?:(?:^|\s)color:\s*(?:#000|#000000|black|rgb\(0,\s*0,\s*0\)))/i);
		expect(
			hardcodedBlackText,
			'Evidence page must not contain hardcoded black text colors (breaks dark mode)',
		).toBeNull();

		// Should use Tailwind's dark-mode-aware classes or CSS variables
		// Check for var(-- pattern (CSS variables) or Tailwind utility classes
		expect(
			content.match(/var\(--|bg-|text-|border-|dark:/),
			'Evidence page should use CSS variables or Tailwind utility classes for theming',
		).not.toBeNull();
	});

	// ---------- QA-08: Existing pages unaffected ----------
	it('QA-08: Existing pages still exist and build succeeds (no regressions)', () => {
		// Verify all existing page files still exist
		const existingPages = ['Dashboard.tsx', 'SourceLibrary.tsx', 'Stories.tsx', 'Graph.tsx', 'Board.tsx'];
		for (const page of existingPages) {
			const pagePath = resolve(SRC_DIR, 'pages', page);
			expect(existsSync(pagePath), `Existing page ${page} must still exist`).toBe(true);
		}

		// Verify existing component files still exist
		const existingComponents = ['Layout.tsx', 'EntityBadge.tsx', 'ConfidenceBadge.tsx', 'StatusBadge.tsx'];
		for (const comp of existingComponents) {
			const compPath = resolve(SRC_DIR, 'components', comp);
			expect(existsSync(compPath), `Existing component ${comp} must still exist`).toBe(true);
		}

		// The build succeeded in beforeAll — this confirms no regressions broke the build
		expect(buildSuccess, `Build must succeed — existing pages must not be broken. Output:\n${buildOutput}`).toBe(true);

		// Verify App.tsx still contains routes for existing pages
		const appFile = resolve(SRC_DIR, 'App.tsx');
		const appContent = readFileSync(appFile, 'utf-8');
		const existingRoutes = ['/', '/sources', '/stories', '/graph'];
		for (const route of existingRoutes) {
			// Check route is present — use a pattern that matches route path strings
			const routePattern = route === '/' ? /path=["']\/["']/ : new RegExp(`["']${route.replace('/', '\\/')}["']`);
			expect(appContent.match(routePattern), `App.tsx must still contain route for ${route}`).not.toBeNull();
		}
	});

	// ---------- QA-06 (navigation order): Evidence between Graph and Boards ----------
	it('QA-06c: Evidence nav item is positioned between Graph and Boards in navigation', () => {
		const layoutFile = resolve(SRC_DIR, 'components/Layout.tsx');
		const content = readFileSync(layoutFile, 'utf-8');

		// Find the positions of Graph, Evidence, and Boards in the file
		const graphPos = content.indexOf('Graph');
		const evidencePos = content.indexOf('Evidence');
		const boardsPos = content.indexOf('Board');

		expect(graphPos, 'Graph must be found in Layout.tsx').toBeGreaterThan(-1);
		expect(evidencePos, 'Evidence must be found in Layout.tsx').toBeGreaterThan(-1);
		expect(boardsPos, 'Boards must be found in Layout.tsx').toBeGreaterThan(-1);

		// Evidence should appear between Graph and Boards in the file
		// (nav items are defined in order in the file)
		expect(
			evidencePos > graphPos,
			`Evidence (pos ${evidencePos}) must appear after Graph (pos ${graphPos}) in Layout.tsx`,
		).toBe(true);
		expect(
			evidencePos < boardsPos,
			`Evidence (pos ${evidencePos}) must appear before Boards (pos ${boardsPos}) in Layout.tsx`,
		).toBe(true);
	});
});
