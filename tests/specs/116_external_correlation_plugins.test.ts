import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const CORE_DIST = resolve(ROOT, 'packages/core/dist/index.js');
const PIPELINE_DIST = resolve(ROOT, 'packages/pipeline/dist/index.js');
const EXAMPLE_CONFIG = resolve(ROOT, 'mulder.config.example.yaml');
const TEST_LANES = resolve(ROOT, 'scripts/test-lanes.mjs');

let coreModule: typeof import('@mulder/core');
let pipelineModule: typeof import('@mulder/pipeline');

beforeAll(async () => {
	coreModule = await import(CORE_DIST);
	pipelineModule = await import(PIPELINE_DIST);
});

describe('Spec 116: External Correlation Plugins', () => {
	it('QA-01: default/example config exposes safe external correlation defaults', () => {
		const config = coreModule.loadConfig(EXAMPLE_CONFIG);
		expect(config.temporal_pattern_detection.external_correlation).toEqual({
			enabled: true,
			series: [],
			methods: ['spearman', 'cross_correlation'],
			min_data_points: 30,
			max_lag_days: 90,
			always_include_caveat: true,
		});
	});

	it('QA-03: static external plugins register and fetch by generic plugin id', async () => {
		const registry = new pipelineModule.ExternalDataSourceRegistry();
		registry.register(
			pipelineModule.createStaticExternalDataSourcePlugin({
				id: 'spec116-static',
				series: {
					observations: [
						{ date: '2026-01-01', value: 1 },
						{ date: '2026-01-02', value: 2 },
					],
				},
			}),
		);

		const plugin = registry.get('spec116-static');
		expect(plugin?.kind).toBe('time_series');
		const fetched = await plugin?.fetch({
			sourceId: 'configured-source',
			seriesId: 'observations',
			series: {
				source_id: 'configured-source',
				series_id: 'observations',
				plugin_id: 'spec116-static',
				enabled: true,
				filters: {},
			},
		});
		expect(fetched?.points.map((point) => point.value)).toEqual([1, 2]);
	});

	it('QA-07: affected-test mapping stays scoped for N4 files', () => {
		const result = spawnSync(
			process.execPath,
			[
				TEST_LANES,
				'affected-plan',
				'--changed-file',
				'packages/core/src/database/migrations/047_external_correlations.sql',
				'--changed-file',
				'packages/pipeline/src/analyze/external-correlation.ts',
				'--json',
			],
			{ cwd: ROOT, encoding: 'utf-8', timeout: 30_000 },
		);
		expect(result.status).toBe(0);
		const plan = JSON.parse(result.stdout) as { files: { relativePath: string }[] };
		const selectedFiles = plan.files.map((file) => file.relativePath);
		expect(selectedFiles).toContain('tests/specs/116_external_correlation_plugins.test.ts');
		expect(selectedFiles).not.toContain('tests/specs/44_e2e_pipeline_integration.test.ts');
	});
});
