#!/usr/bin/env node
/**
 * Post-MVP Fix Sprint — Phase D re-verification script.
 *
 * Re-runs the three fixture-based eval runners (extraction, segmentation,
 * entity) against the existing golden sets and diffs each summary metric
 * against the checked-in baseline at `eval/metrics/baseline.json`.
 *
 * Exits 0 when every metric is bit-identical to baseline. Exits 1 on any
 * delta — the sprint must produce zero regressions on fixture-based evals.
 *
 * Usage:
 *   node scripts/re-verify-eval.mjs
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const { runEntityEval, runExtractionEval, runSegmentationEval } = await import(
	resolve(ROOT, 'packages/eval/dist/index.js')
);
const GOLDEN_DIR = resolve(ROOT, 'eval/golden');
const FIXTURES_DIR = resolve(ROOT, 'fixtures');
const BASELINE_PATH = resolve(ROOT, 'eval/metrics/baseline.json');

function loadBaseline() {
	return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
}

function fmt(n) {
	if (typeof n !== 'number') return String(n);
	if (Number.isInteger(n)) return String(n);
	return n.toFixed(6);
}

function diff(current, baseline, label) {
	const c = current ?? 0;
	const b = baseline ?? 0;
	const d = c - b;
	const status = Math.abs(d) < 1e-9 ? 'OK' : 'DIFF';
	console.log(`  ${label.padEnd(28)} cur=${fmt(c).padEnd(12)} base=${fmt(b).padEnd(12)} delta=${fmt(d)} [${status}]`);
	return Math.abs(d) < 1e-9;
}

let allOk = true;

// ─── Extraction ───
console.log('=== Extraction eval ===');
const ext = await runExtractionEval(resolve(GOLDEN_DIR, 'extraction'), resolve(FIXTURES_DIR, 'extracted'));
const baseline = loadBaseline();
allOk = diff(ext.summary.totalPages, baseline.extraction.summary.totalPages, 'totalPages') && allOk;
allOk = diff(ext.summary.avgCer, baseline.extraction.summary.avgCer, 'avgCer') && allOk;
allOk = diff(ext.summary.avgWer, baseline.extraction.summary.avgWer, 'avgWer') && allOk;
allOk = diff(ext.summary.maxCer, baseline.extraction.summary.maxCer, 'maxCer') && allOk;
allOk = diff(ext.summary.maxWer, baseline.extraction.summary.maxWer, 'maxWer') && allOk;

// ─── Segmentation ───
console.log('\n=== Segmentation eval ===');
const seg = await runSegmentationEval(resolve(GOLDEN_DIR, 'segmentation'), resolve(FIXTURES_DIR, 'segments'));
allOk = diff(seg.summary.totalDocuments, baseline.segmentation.summary.totalDocuments, 'totalDocuments') && allOk;
allOk =
	diff(seg.summary.avgBoundaryAccuracy, baseline.segmentation.summary.avgBoundaryAccuracy, 'avgBoundaryAccuracy') &&
	allOk;
allOk =
	diff(
		seg.summary.segmentCountExactRatio,
		baseline.segmentation.summary.segmentCountExactRatio,
		'segmentCountExactRatio',
	) && allOk;

// ─── Entities ───
console.log('\n=== Entity eval ===');
const ent = await runEntityEval(resolve(GOLDEN_DIR, 'entities'), resolve(FIXTURES_DIR, 'entities'));
allOk = diff(ent.summary.totalSegments, baseline.entities.summary.totalSegments, 'totalSegments') && allOk;
allOk =
	diff(ent.summary.overall.avgPrecision, baseline.entities.summary.overall.avgPrecision, 'overall.avgPrecision') &&
	allOk;
allOk = diff(ent.summary.overall.avgRecall, baseline.entities.summary.overall.avgRecall, 'overall.avgRecall') && allOk;
allOk = diff(ent.summary.overall.avgF1, baseline.entities.summary.overall.avgF1, 'overall.avgF1') && allOk;
allOk =
	diff(ent.summary.relationships.avgF1, baseline.entities.summary.relationships.avgF1, 'relationships.avgF1') && allOk;

console.log();
if (allOk) {
	console.log('✅ ALL METRICS BIT-IDENTICAL TO BASELINE');
	process.exit(0);
} else {
	console.log('❌ AT LEAST ONE METRIC DRIFTED FROM BASELINE');
	process.exit(1);
}
