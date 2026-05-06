import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SEARCH_ROOTS = ['tests/specs', 'packages', 'apps'].map((path) => resolve(ROOT, path));
const MANIFEST_PATH = resolve(ROOT, 'tests/test-runtime-manifest.json');
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');
const TEST_RUNNER = resolve(ROOT, 'scripts/test-runner.mjs');

const SERIAL_VITEST_ARGS = ['--no-file-parallelism', '--maxWorkers=1'];
const PARALLEL_VITEST_ARGS = ['--fileParallelism=true'];
const LANE_ORDER = ['unit', 'schema', 'db', 'heavy', 'external'];
const HEALTH_SMOKE_TEST = 'tests/specs/44_e2e_pipeline_integration.test.ts';
const HEAD_DOCS_ONLY_OPTIMIZATION_ENV = 'MULDER_TEST_AFFECTED_PR_HEAD_DOCS_ONLY';
const HEAD_CHANGED_FILES_OVERRIDE_ENV = 'MULDER_TEST_AFFECTED_HEAD_CHANGED_FILES';
const SPEC_DOC_TEST_OVERRIDES = new Map([
	['77_document_observability_aggregation', ['tests/specs/77_document_observability_route.test.ts']],
]);

function usage() {
	return [
		'Usage:',
		'  node scripts/test-lanes.mjs verify [lane] [shardTotal]',
		'  node scripts/test-lanes.mjs summary <lane> [shardIndex shardTotal]',
		'  node scripts/test-lanes.mjs list <lane> [shardIndex shardTotal]',
		'  node scripts/test-lanes.mjs run <lane> [shardIndex shardTotal] [-- vitest args...]',
		'  node scripts/test-lanes.mjs affected [baseRef] [-- vitest args...]',
		'  node scripts/test-lanes.mjs affected-plan [baseRef] [--json] [--changed-file <path> ...]',
		'  node scripts/test-lanes.mjs affected-lane <lane> [shardIndex shardTotal] [baseRef|--changed-file <path> ...] [-- vitest args...]',
		'',
		'Lanes: unit, schema, db, heavy, external',
	].join('\n');
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function walkTests(root) {
	const files = [];
	const queue = [root];

	while (queue.length > 0) {
		const current = queue.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = resolve(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith('.test.ts')) {
				files.push(fullPath);
			}
		}
	}

	return files;
}

function listDiscoveredFiles() {
	return SEARCH_ROOTS.flatMap((root) => (existsSync(root) ? walkTests(root) : []))
		.map((fullPath) => ({
			fullPath,
			relativePath: fullPath.slice(ROOT.length + 1).replaceAll('\\', '/'),
			lineCount: readFileSync(fullPath, 'utf8').split('\n').length,
		}))
		.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function loadManifest() {
	if (!existsSync(MANIFEST_PATH)) {
		throw new Error(`Runtime manifest not found: ${MANIFEST_PATH}`);
	}
	return readJson(MANIFEST_PATH);
}

function fileWeight(file, manifest, explicitWeight) {
	if (Number.isFinite(explicitWeight)) {
		return explicitWeight;
	}
	const manifestWeight = manifest.fileWeights?.[file.relativePath];
	if (Number.isFinite(manifestWeight)) {
		return manifestWeight;
	}
	return Math.max(Number(manifest.defaultWeight ?? 600), file.lineCount);
}

function asWeightedFiles(paths, discoveredByPath, manifest, explicitWeights = {}) {
	return [...paths]
		.sort((a, b) => a.localeCompare(b))
		.map((relativePath) => {
			const discovered = discoveredByPath.get(relativePath);
			if (!discovered) {
				throw new Error(`Lane file is not present in the repository: ${relativePath}`);
			}
			return {
				...discovered,
				weight: fileWeight(discovered, manifest, explicitWeights[relativePath]),
			};
		});
}

function classifyFiles() {
	const manifest = loadManifest();
	const discovered = listDiscoveredFiles();
	const discoveredByPath = new Map(discovered.map((file) => [file.relativePath, file]));
	const schemaPaths = new Set(Object.keys(manifest.schemaFiles ?? {}));
	const heavyPaths = new Set(Object.keys(manifest.heavyFiles ?? {}));
	const externalPaths = new Set(Object.keys(manifest.externalFiles ?? {}));

	for (const [firstName, firstSet, secondName, secondSet] of [
		['schema', schemaPaths, 'heavy', heavyPaths],
		['schema', schemaPaths, 'external', externalPaths],
		['heavy', heavyPaths, 'external', externalPaths],
	]) {
		for (const path of firstSet) {
			if (secondSet.has(path)) {
				throw new Error(`Test file appears in both ${firstName} and ${secondName} lanes: ${path}`);
			}
		}
	}

	const unitPaths = discovered
		.filter((file) => file.relativePath.startsWith('packages/') || file.relativePath.startsWith('apps/'))
		.map((file) => file.relativePath);

	const dbPaths = discovered
		.filter((file) => file.relativePath.startsWith('tests/specs/'))
		.map((file) => file.relativePath)
		.filter((path) => !schemaPaths.has(path) && !heavyPaths.has(path) && !externalPaths.has(path));

	return {
		manifest,
		discovered,
		discoveredByPath,
		lanes: {
			unit: {
				serial: false,
				files: asWeightedFiles(unitPaths, discoveredByPath, manifest),
			},
			schema: {
				serial: true,
				files: asWeightedFiles(schemaPaths, discoveredByPath, manifest, manifest.schemaFiles ?? {}),
			},
			db: {
				serial: true,
				files: asWeightedFiles(dbPaths, discoveredByPath, manifest),
			},
			heavy: {
				serial: true,
				files: asWeightedFiles(heavyPaths, discoveredByPath, manifest, manifest.heavyFiles ?? {}),
			},
			external: {
				serial: true,
				files: asWeightedFiles(externalPaths, discoveredByPath, manifest, manifest.externalFiles ?? {}),
			},
		},
	};
}

function getLane(laneName) {
	const { lanes } = classifyFiles();
	const lane = lanes[laneName];
	if (!lane) {
		throw new Error(`Unknown lane: ${laneName}\n${usage()}`);
	}
	return lane;
}

function partitionFiles(files, shardTotal) {
	if (!Number.isInteger(shardTotal) || shardTotal <= 0) {
		throw new Error(`Shard total must be a positive integer, got: ${shardTotal}`);
	}

	const shards = Array.from({ length: shardTotal }, (_, index) => ({
		index: index + 1,
		totalWeight: 0,
		files: [],
	}));

	for (const file of [...files].sort((a, b) => b.weight - a.weight || a.relativePath.localeCompare(b.relativePath))) {
		shards.sort((a, b) => a.totalWeight - b.totalWeight || a.index - b.index);
		shards[0].files.push(file);
		shards[0].totalWeight += file.weight;
	}

	return shards.sort((a, b) => a.index - b.index);
}

function selectFiles(laneName, shardIndex, shardTotal) {
	const lane = getLane(laneName);
	if (shardIndex === null || shardTotal === null) {
		return {
			lane,
			shard: { index: 1, totalWeight: lane.files.reduce((sum, file) => sum + file.weight, 0), files: lane.files },
		};
	}

	if (!Number.isInteger(shardIndex) || shardIndex <= 0 || shardIndex > shardTotal) {
		throw new Error(`Shard index must be between 1 and ${shardTotal}, got: ${shardIndex}`);
	}

	return { lane, shard: partitionFiles(lane.files, shardTotal)[shardIndex - 1] };
}

function formatPlan(label, files, totalWeight) {
	return [
		label,
		`Files: ${files.length}`,
		`Estimated weight: ${totalWeight}`,
		...files.map((file) => ` - ${file.relativePath} (${file.weight})`),
		'',
	].join('\n');
}

function printSummary(laneName, shardIndex, shardTotal) {
	const { shard } = selectFiles(laneName, shardIndex, shardTotal);
	const label = shardTotal === null ? `Lane ${laneName}` : `Lane ${laneName} shard ${shard.index}/${shardTotal}`;
	process.stdout.write(formatPlan(label, shard.files, shard.totalWeight));
}

function printList(laneName, shardIndex, shardTotal) {
	const { shard } = selectFiles(laneName, shardIndex, shardTotal);
	process.stdout.write(`${shard.files.map((file) => file.relativePath).join('\n')}\n`);
}

function verify(laneName = null, shardTotal = null) {
	const { discovered, lanes } = classifyFiles();
	const laneNames = laneName ? [laneName] : Object.keys(lanes);
	const assigned = [];

	for (const name of laneNames) {
		const lane = lanes[name];
		if (!lane) {
			throw new Error(`Unknown lane: ${name}`);
		}
		assigned.push(...lane.files.map((file) => file.relativePath));
		if (shardTotal !== null) {
			const shards = partitionFiles(lane.files, shardTotal);
			const shardFiles = shards.flatMap((shard) => shard.files.map((file) => file.relativePath));
			if (new Set(shardFiles).size !== lane.files.length) {
				throw new Error(`Lane ${name} shard partition contains duplicates.`);
			}
		}
	}

	if (!laneName) {
		const uniqueAssigned = new Set(assigned);
		const discoveredPaths = discovered.map((file) => file.relativePath);
		if (assigned.length !== uniqueAssigned.size) {
			throw new Error('A test file is assigned to more than one lane.');
		}
		if (uniqueAssigned.size !== discoveredPaths.length) {
			const missing = discoveredPaths.filter((path) => !uniqueAssigned.has(path));
			throw new Error(`Lane assignment missing files:\n${missing.join('\n')}`);
		}
	}

	process.stdout.write(
		[
			laneName ? `Verified lane ${laneName}` : 'Verified all test lanes',
			...laneNames.map((name) => {
				const lane = lanes[name];
				const weight = lane.files.reduce((sum, file) => sum + file.weight, 0);
				return ` - ${name}: ${lane.files.length} files, estimated weight ${weight}`;
			}),
			'',
		].join('\n'),
	);
}

function splitCommandArgs(args) {
	const splitIndex = args.indexOf('--');
	if (splitIndex === -1) {
		return { commandArgs: args, extraArgs: [] };
	}
	return { commandArgs: args.slice(0, splitIndex), extraArgs: args.slice(splitIndex + 1) };
}

function runVitest(label, files, serial, extraArgs) {
	if (files.length === 0) {
		process.stdout.write(`No tests selected for ${label}; passing.\n`);
		return 0;
	}

	const vitestArgs = [
		'run',
		...(serial ? SERIAL_VITEST_ARGS : PARALLEL_VITEST_ARGS),
		...extraArgs,
		...files.map((file) => file.relativePath),
	];
	const result = spawnSync(
		process.execPath,
		[TEST_RUNNER, 'run', label, '--', process.execPath, VITEST, ...vitestArgs],
		{
			cwd: ROOT,
			stdio: 'inherit',
			env: process.env,
		},
	);

	return result.status ?? 1;
}

function runLane(laneName, shardIndex, shardTotal, extraArgs) {
	const { lane, shard } = selectFiles(laneName, shardIndex, shardTotal);
	const label = shardTotal === null ? laneName : `${laneName}-${shard.index}-of-${shardTotal}`;
	process.stdout.write(formatPlan(`Running ${label}`, shard.files, shard.totalWeight));
	process.exit(runVitest(label, shard.files, lane.serial, extraArgs));
}

function gitChangedFiles(baseRef) {
	const args = baseRef ? ['diff', '--name-only', `${baseRef}...HEAD`] : ['diff', '--name-only', 'HEAD'];
	let result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	if (result.status !== 0 && baseRef) {
		result = spawnSync('git', ['diff', '--name-only', baseRef], {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	}
	if (result.status !== 0) {
		throw new Error(`Unable to compute changed files: ${result.stderr.trim()}`);
	}
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
}

function splitChangedFiles(value) {
	return value
		.split(/\r?\n|,/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function gitHeadChangedFiles() {
	const override = process.env[HEAD_CHANGED_FILES_OVERRIDE_ENV];
	if (override) {
		return splitChangedFiles(override);
	}

	const status = spawnSync('git', ['status', '--porcelain'], {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (status.status !== 0 || status.stdout.trim().length > 0) {
		return [];
	}

	const result = spawnSync('git', ['diff', '--name-only', 'HEAD~1..HEAD'], {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.status !== 0) {
		return [];
	}
	return splitChangedFiles(result.stdout);
}

function isDocsOnlyHeadFile(file) {
	if (file === 'README.md' || file === 'CLAUDE.md') {
		return true;
	}
	if (/^[^/]+\.md$/.test(file)) {
		return true;
	}
	return (file.startsWith('docs/') || file.startsWith('.codex/')) && file.endsWith('.md');
}

function affectedChangedFiles(baseRef) {
	if (baseRef && process.env[HEAD_DOCS_ONLY_OPTIMIZATION_ENV] === 'true') {
		const headChangedFiles = gitHeadChangedFiles();
		if (headChangedFiles.length > 0 && headChangedFiles.every(isDocsOnlyHeadFile)) {
			return {
				changeScope: 'head-docs-only',
				changedFiles: headChangedFiles,
			};
		}
	}

	return {
		changeScope: 'base',
		changedFiles: gitChangedFiles(baseRef),
	};
}

function testsForSpecNumber(specNumber, discoveredByPath) {
	const padded = String(Number.parseInt(specNumber, 10)).padStart(2, '0');
	return [...discoveredByPath.keys()].filter((path) => path.startsWith(`tests/specs/${padded}_`));
}

function addSpecTestsToSet(selected, discoveredByPath, specNumbers) {
	for (const specNumber of specNumbers) {
		for (const testPath of testsForSpecNumber(specNumber, discoveredByPath)) {
			selected.add(testPath);
		}
	}
}

function addExactTestsToSet(selected, discoveredByPath, testPaths) {
	for (const testPath of testPaths) {
		if (!discoveredByPath.has(testPath)) {
			throw new Error(`Affected test mapping points to a missing test file: ${testPath}`);
		}
		selected.add(testPath);
	}
}

function addDocSpecTestsToSet(selected, discoveredByPath, specFile) {
	const key = specFile.replace(/^docs\/specs\//, '').replace(/\.spec\.md$/, '');
	const override = SPEC_DOC_TEST_OVERRIDES.get(key);
	if (override) {
		addExactTestsToSet(selected, discoveredByPath, override);
		return;
	}

	const exactTest = `tests/specs/${key}.test.ts`;
	if (discoveredByPath.has(exactTest)) {
		selected.add(exactTest);
		return;
	}

	const specMatch = key.match(/^(\d+)_/);
	if (specMatch) {
		addSpecTestsToSet(selected, discoveredByPath, [specMatch[1]]);
	}
}

function addLaneFilesToSet(selected, lanes, laneNames) {
	for (const laneName of laneNames) {
		for (const testFile of lanes[laneName].files) {
			selected.add(testFile.relativePath);
		}
	}
}

function removeHealthSmokeTests(selected) {
	selected.delete(HEALTH_SMOKE_TEST);
}

const TEST_GROUPS = {
	testinfra: ['tests/specs/02_monorepo_setup.test.ts', 'tests/specs/59_hermetic_test_infrastructure.test.ts'],
	reprocessConfig: [
		'tests/specs/03_config_loader.test.ts',
		'tests/specs/30_cascading_reset_function.test.ts',
		'tests/specs/35_qa_cascading_reset.test.ts',
		'tests/specs/77_cost_estimator.test.ts',
		'tests/specs/78_selective_reprocessing.test.ts',
		'tests/specs/100_document_quality_assessment_step.test.ts',
	],
	coreConfig: [
		'tests/specs/03_config_loader.test.ts',
		'tests/specs/77_cost_estimator.test.ts',
		'tests/specs/78_selective_reprocessing.test.ts',
		'tests/specs/100_document_quality_assessment_step.test.ts',
	],
	coreDatabase: [
		'tests/specs/07_database_client_migration_runner.test.ts',
		'tests/specs/08_core_schema_migrations.test.ts',
		'tests/specs/09_job_queue_pipeline_tracking_migrations.test.ts',
		'tests/specs/14_source_repository.test.ts',
		'tests/specs/22_pdf_metadata_extraction.test.ts',
		'tests/specs/22_story_repository.test.ts',
		'tests/specs/24_entity_alias_repositories.test.ts',
		'tests/specs/25_edge_repository.test.ts',
		'tests/specs/32_embedding_wrapper_semantic_chunker_chunk_repository.test.ts',
		'tests/specs/38_fulltext_search_retrieval.test.ts',
		'tests/specs/39_graph_traversal_retrieval.test.ts',
		'tests/specs/54_v2_schema_migrations.test.ts',
		'tests/specs/67_job_queue_repository.test.ts',
	],
	corePdf: [
		'tests/specs/15_native_text_detection.test.ts',
		'tests/specs/16_ingest_step.test.ts',
		'tests/specs/22_pdf_metadata_extraction.test.ts',
	],
	coreServices: [
		'tests/specs/11_service_abstraction.test.ts',
		'tests/specs/13_gcp_service_implementations.test.ts',
		'tests/specs/17_vertex_ai_wrapper_dev_cache.test.ts',
	],
	quality: [
		'tests/specs/77_cost_estimator.test.ts',
		'tests/specs/78_selective_reprocessing.test.ts',
		'tests/specs/86_pipeline_step_skipping.test.ts',
		'tests/specs/100_document_quality_assessment_step.test.ts',
	],
	pipelineFormat: [
		'tests/specs/85_source_type_discriminator_format_metadata.test.ts',
		'tests/specs/86_pipeline_step_skipping.test.ts',
		'tests/specs/86_pipeline_step_skipping_prestructured_sources.test.ts',
		'tests/specs/87_image_ingestion_layout_path.test.ts',
		'tests/specs/88_plain_text_ingestion_prestructured_path.test.ts',
		'tests/specs/89_docx_ingestion_prestructured_path.test.ts',
		'tests/specs/90_spreadsheet_ingestion_prestructured_path.test.ts',
		'tests/specs/91_email_ingestion_prestructured_path.test.ts',
		'tests/specs/92_url_ingestion_prestructured_path.test.ts',
		'tests/specs/95_format_aware_extract_routing.test.ts',
		'tests/specs/96_cross_format_ingest_dedup.test.ts',
		'tests/specs/98_content_addressed_storage.test.ts',
	],
	pipelineGeneric: [
		'tests/specs/16_ingest_duplicate_race.test.ts',
		'tests/specs/16_ingest_step.test.ts',
		'tests/specs/19_extract_step.test.ts',
		'tests/specs/23_segment_step.test.ts',
		'tests/specs/29_enrich_step.test.ts',
		'tests/specs/34_embed_step.test.ts',
		'tests/specs/35_graph_step.test.ts',
		'tests/specs/35_qa_cascading_reset.test.ts',
		'tests/specs/36_pipeline_orchestrator.test.ts',
		'tests/specs/36_qa_pipeline_integration.test.ts',
		'tests/specs/77_cost_estimator.test.ts',
		'tests/specs/78_selective_reprocessing.test.ts',
		'tests/specs/86_pipeline_step_skipping.test.ts',
		'tests/specs/86_pipeline_step_skipping_prestructured_sources.test.ts',
		'tests/specs/100_document_quality_assessment_step.test.ts',
	],
	worker: [
		'tests/specs/68_worker_loop.test.ts',
		'tests/specs/77_budget_reservation_status_gate.test.ts',
		'tests/specs/77_document_observability_route.test.ts',
		'tests/specs/78_dead_letter_queue_retry.test.ts',
		'tests/specs/78_selective_reprocessing.test.ts',
		'tests/specs/79_step_scoped_worker_job_contract.test.ts',
		'tests/specs/80_step_chained_pipeline_api_jobs.test.ts',
		'tests/specs/81_queue_retry_before_dead_letter.test.ts',
		'tests/specs/88_plain_text_ingestion_prestructured_path.test.ts',
		'tests/specs/89_docx_ingestion_prestructured_path.test.ts',
		'tests/specs/90_spreadsheet_ingestion_prestructured_path.test.ts',
		'tests/specs/91_email_ingestion_prestructured_path.test.ts',
		'tests/specs/92_url_ingestion_prestructured_path.test.ts',
		'tests/specs/96_cross_format_ingest_dedup.test.ts',
		'tests/specs/98_content_addressed_storage.test.ts',
		'tests/specs/100_document_quality_assessment_step.test.ts',
	],
	api: [
		'tests/specs/69_hono_server_scaffold.test.ts',
		'tests/specs/70_api_middleware_stack.test.ts',
		'tests/specs/71_pipeline_api_routes.test.ts',
		'tests/specs/72_job_status_api.test.ts',
		'tests/specs/73_search_api_routes.test.ts',
		'tests/specs/74_entity_api_routes.test.ts',
		'tests/specs/75_evidence_api_routes.test.ts',
		'tests/specs/76_document_retrieval_routes.test.ts',
		'tests/specs/77_browser_safe_email_password_auth.test.ts',
		'tests/specs/77_document_observability_route.test.ts',
		'tests/specs/80_step_chained_pipeline_api_jobs.test.ts',
		'tests/specs/89_docx_ingestion_prestructured_path.test.ts',
		'tests/specs/90_spreadsheet_ingestion_prestructured_path.test.ts',
		'tests/specs/98_content_addressed_storage.test.ts',
	],
	cli: [
		'tests/specs/06_cli_scaffold.test.ts',
		'tests/specs/16_ingest_step.test.ts',
		'tests/specs/45_cli_config_smoke.test.ts',
		'tests/specs/46_taxonomy_bootstrap.test.ts',
		'tests/specs/49_mulder_show_command.test.ts',
		'tests/specs/51_entity_management_cli.test.ts',
		'tests/specs/53_export_commands.test.ts',
		'tests/specs/77_cost_estimator.test.ts',
		'tests/specs/78_selective_reprocessing.test.ts',
		'tests/specs/88_plain_text_ingestion_prestructured_path.test.ts',
		'tests/specs/89_docx_ingestion_prestructured_path.test.ts',
		'tests/specs/90_spreadsheet_ingestion_prestructured_path.test.ts',
		'tests/specs/91_email_ingestion_prestructured_path.test.ts',
		'tests/specs/92_url_ingestion_prestructured_path.test.ts',
		'tests/specs/96_cross_format_ingest_dedup.test.ts',
		'tests/specs/98_content_addressed_storage.test.ts',
		'tests/specs/100_document_quality_assessment_step.test.ts',
	],
	retrieval: [
		'tests/specs/37_vector_search_retrieval.test.ts',
		'tests/specs/38_fulltext_search_retrieval.test.ts',
		'tests/specs/39_graph_traversal_retrieval.test.ts',
		'tests/specs/40_rrf_fusion.test.ts',
		'tests/specs/41_llm_reranking.test.ts',
		'tests/specs/42_hybrid_retrieval_orchestrator.test.ts',
		'tests/specs/43_retrieval_metrics.test.ts',
	],
	taxonomy: [
		'tests/specs/27_taxonomy_normalization.test.ts',
		'tests/specs/46_taxonomy_bootstrap.test.ts',
		'tests/specs/50_taxonomy_export_curate_merge.test.ts',
		'tests/specs/51_entity_management_cli.test.ts',
	],
	eval: ['tests/specs/43_retrieval_metrics.test.ts', 'tests/specs/77_eval_cli_reporter.test.ts'],
	evidence: [
		'tests/specs/63_evidence_chains.test.ts',
		'tests/specs/66_evidence_package_boundary.test.ts',
		'tests/specs/75_evidence_api_routes.test.ts',
	],
};

function selectTestGroup(selected, discoveredByPath, groupName) {
	addExactTestsToSet(selected, discoveredByPath, TEST_GROUPS[groupName]);
}

function resolveAffectedRule(file, discoveredByPath, lanes) {
	const selected = new Set();
	const selectGroup = (groupName) => selectTestGroup(selected, discoveredByPath, groupName);
	const selectExact = (testPaths) => addExactTestsToSet(selected, discoveredByPath, testPaths);
	const selectLanes = (laneNames) => addLaneFilesToSet(selected, lanes, laneNames);

	if (discoveredByPath.has(file)) {
		selected.add(file);
		return { rule: 'changed test file', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	const specMatch = file.match(/^docs\/specs\/(\d+)_.*\.spec\.md$/);
	if (specMatch) {
		addDocSpecTestsToSet(selected, discoveredByPath, file);
		return { rule: `docs spec ${specMatch[1]}`, selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file === 'README.md' || file === 'docs/testing-strategy.md' || file === 'package.json') {
		selectGroup('testinfra');
		return {
			rule: 'testinfra documentation/scripts smoke',
			selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)),
		};
	}

	if (/^(scripts\/test-.*|tests\/test-runtime-manifest\.json|\.github\/workflows\/ci\.yml)$/.test(file)) {
		selectGroup('testinfra');
		return { rule: 'testinfra runner/ci smoke', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (/^(pnpm-lock\.yaml|vitest\.config\.ts)$/.test(file)) {
		selectLanes(['schema', 'db', 'heavy']);
		return {
			rule: 'global dependency/test-runtime change',
			selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)),
		};
	}

	if (file === 'packages/core/src/config/reprocess-hash.ts') {
		selectGroup('reprocessConfig');
		return { rule: 'reprocess config hash', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/config/')) {
		selectGroup('coreConfig');
		return { rule: 'core config', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (/^packages\/core\/src\/database\/migrations\/02[6-8]_/.test(file)) {
		selectExact([
			'tests/specs/08_core_schema_migrations.test.ts',
			'tests/specs/30_cascading_reset_function.test.ts',
			'tests/specs/35_qa_cascading_reset.test.ts',
			'tests/specs/100_document_quality_assessment_step.test.ts',
		]);
		return {
			rule: 'document quality/reset migration',
			selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)),
		};
	}

	if (file.startsWith('packages/core/src/database/migrations/')) {
		selectLanes(['schema', 'db', 'heavy']);
		return { rule: 'unknown migration', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/database/repositories/document-quality')) {
		selectExact(['tests/specs/100_document_quality_assessment_step.test.ts']);
		return { rule: 'document quality repository', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/database/repositories/pipeline-reset')) {
		selectExact([
			'tests/specs/30_cascading_reset_function.test.ts',
			'tests/specs/35_qa_cascading_reset.test.ts',
			'tests/specs/100_document_quality_assessment_step.test.ts',
		]);
		return { rule: 'pipeline reset repository', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/database/')) {
		selectGroup('coreDatabase');
		return { rule: 'core database/repository', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/pipeline/')) {
		selectGroup('corePdf');
		return { rule: 'core pdf pipeline helpers', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/prompts/templates/')) {
		selectGroup('pipelineGeneric');
		return { rule: 'pipeline prompt template', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/prompts/')) {
		selectExact(['tests/specs/18_prompt_template_engine.test.ts']);
		return { rule: 'prompt template engine', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (
		file === 'packages/core/src/llm-cache.ts' ||
		file === 'packages/core/src/vertex.ts' ||
		file === 'packages/core/src/shared/gcp.ts' ||
		file.startsWith('packages/core/src/shared/services') ||
		file.startsWith('packages/core/src/shared/rate-limiter') ||
		file.startsWith('packages/core/src/shared/retry')
	) {
		selectGroup('coreServices');
		return { rule: 'core service/gcp wrappers', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/shared/cost-estimator')) {
		selectExact(['tests/specs/77_cost_estimator.test.ts', 'tests/specs/78_selective_reprocessing.test.ts']);
		return { rule: 'cost estimator', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/core/src/shared/')) {
		selectExact([
			'tests/specs/04_custom_error_classes.test.ts',
			'tests/specs/05_logger_setup.test.ts',
			'tests/specs/11_service_abstraction.test.ts',
			'tests/specs/16_ingest_step.test.ts',
			'tests/specs/68_worker_loop.test.ts',
			...TEST_GROUPS.pipelineFormat,
		]);
		return {
			rule: 'core shared services/storage/utilities',
			selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)),
		};
	}

	if (file === 'packages/core/src/index.ts') {
		selectExact([
			'tests/specs/02_monorepo_setup.test.ts',
			'tests/specs/03_config_loader.test.ts',
			'tests/specs/11_service_abstraction.test.ts',
			'tests/specs/14_source_repository.test.ts',
			'tests/specs/16_ingest_step.test.ts',
			'tests/specs/100_document_quality_assessment_step.test.ts',
		]);
		return { rule: 'core public exports', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/pipeline/src/quality/')) {
		selectGroup('quality');
		return { rule: 'quality assessment pipeline', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/pipeline/src/reprocess/')) {
		selectGroup('reprocessConfig');
		return { rule: 'selective reprocessing pipeline', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/pipeline/src/ingest/') || file.startsWith('packages/pipeline/src/extract/')) {
		selectGroup('pipelineFormat');
		return {
			rule: 'format-aware ingest/extract pipeline',
			selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)),
		};
	}

	if (file.startsWith('packages/pipeline/')) {
		selectGroup('pipelineGeneric');
		return { rule: 'pipeline step/orchestration', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/worker/')) {
		selectGroup('worker');
		return { rule: 'worker dispatch/queue', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/retrieval/')) {
		selectGroup('retrieval');
		return { rule: 'retrieval package', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/taxonomy/')) {
		selectGroup('taxonomy');
		return { rule: 'taxonomy package', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/eval/')) {
		selectGroup('eval');
		return { rule: 'eval package', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('packages/evidence/')) {
		selectGroup('evidence');
		return { rule: 'evidence package', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('apps/api/')) {
		selectGroup('api');
		return { rule: 'api routes/runtime', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('apps/cli/')) {
		selectGroup('cli');
		return { rule: 'cli commands/runtime', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('tests/lib/')) {
		selectLanes(['schema', 'db', 'heavy']);
		return { rule: 'shared test helper change', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	if (file.startsWith('apps/') || file.startsWith('packages/')) {
		selectGroup('testinfra');
		return { rule: 'unknown app/package smoke', selectedFiles: [...selected].sort((a, b) => a.localeCompare(b)) };
	}

	return { rule: 'no affected tests mapped', selectedFiles: [] };
}

function laneNameForFile(relativePath, lanes) {
	for (const [laneName, lane] of Object.entries(lanes)) {
		if (lane.files.some((file) => file.relativePath === relativePath)) {
			return laneName;
		}
	}
	return 'db';
}

function buildAffectedPlan(baseRef, explicitChangedFiles = null) {
	const { discoveredByPath, lanes } = classifyFiles();
	const weightedByPath = new Map(
		Object.values(lanes).flatMap((lane) => lane.files.map((file) => [file.relativePath, file])),
	);
	const changeSelection = explicitChangedFiles
		? { changeScope: 'explicit', changedFiles: explicitChangedFiles }
		: affectedChangedFiles(baseRef);
	const changed = changeSelection.changedFiles;
	const selected = new Set();
	const rules = [];

	for (const file of changed) {
		const result = resolveAffectedRule(file, discoveredByPath, lanes);
		for (const selectedFile of result.selectedFiles) selected.add(selectedFile);
		rules.push({ changedFile: file, rule: result.rule, selectedFiles: result.selectedFiles });
	}

	if (process.env.MULDER_TEST_SKIP_HEALTH_SPEC_IN_AFFECTED === 'true') {
		removeHealthSmokeTests(selected);
		for (const rule of rules) {
			rule.selectedFiles = rule.selectedFiles.filter((file) => file !== HEALTH_SMOKE_TEST);
		}
	}

	const files = [...selected]
		.sort((a, b) => a.localeCompare(b))
		.map((path) => weightedByPath.get(path))
		.filter(Boolean)
		.map((file) => ({
			...file,
			lane: laneNameForFile(file.relativePath, lanes),
		}));
	const totalWeight = files.reduce((sum, file) => sum + file.weight, 0);
	const laneSummaries = Object.fromEntries(
		LANE_ORDER.map((laneName) => {
			const laneFiles = files.filter((file) => file.lane === laneName);
			return [
				laneName,
				{
					count: laneFiles.length,
					totalWeight: laneFiles.reduce((sum, file) => sum + file.weight, 0),
					files: laneFiles.map((file) => file.relativePath),
				},
			];
		}),
	);

	return {
		baseRef: baseRef ?? null,
		changeScope: changeSelection.changeScope,
		changedFiles: changed,
		totalFiles: files.length,
		totalWeight,
		lanes: laneSummaries,
		rules,
		files: files.map((file) => ({
			relativePath: file.relativePath,
			lane: file.lane,
			weight: file.weight,
		})),
		weightedFiles: files,
	};
}

function rewriteJUnitOutputArgs(extraArgs, suffix) {
	return extraArgs.map((arg) => {
		const prefix = '--outputFile.junit=';
		if (!arg.startsWith(prefix)) {
			return arg;
		}
		const path = arg.slice(prefix.length);
		const extensionIndex = path.lastIndexOf('.');
		const suffixed =
			extensionIndex === -1
				? `${path}-${suffix}`
				: `${path.slice(0, extensionIndex)}-${suffix}${path.slice(extensionIndex)}`;
		return `${prefix}${suffixed}`;
	});
}

function formatAffectedPlan(plan) {
	const lines = [
		`Affected tests${plan.baseRef ? ` against ${plan.baseRef}` : ''}`,
		`Change scope: ${plan.changeScope}`,
		`Changed files: ${plan.changedFiles.length}`,
		...plan.changedFiles.map((file) => ` - ${file}`),
		'Rules:',
		...plan.rules.map(
			(rule) => ` - ${rule.changedFile}: ${rule.rule} (${rule.selectedFiles.length} selected before merge/dedupe)`,
		),
		'Lane summary:',
		...LANE_ORDER.map((laneName) => {
			const lane = plan.lanes[laneName];
			return ` - ${laneName}: ${lane.count} files, estimated weight ${lane.totalWeight}`;
		}),
		`Files: ${plan.totalFiles}`,
		`Estimated weight: ${plan.totalWeight}`,
		...plan.files.map((file) => ` - ${file.relativePath} [${file.lane}] (${file.weight})`),
		'',
	];
	return lines.join('\n');
}

function parseAffectedPlanArgs(commandArgs) {
	let baseRef = null;
	let json = false;
	const changedFiles = [];

	for (let index = 0; index < commandArgs.length; index += 1) {
		const arg = commandArgs[index];
		if (arg === '--json') {
			json = true;
			continue;
		}
		if (arg === '--changed-file') {
			const changedFile = commandArgs[index + 1];
			if (!changedFile) {
				throw new Error('affected-plan --changed-file requires a path.');
			}
			changedFiles.push(changedFile);
			index += 1;
			continue;
		}
		if (arg.startsWith('--')) {
			throw new Error(`Unknown affected-plan option: ${arg}`);
		}
		if (baseRef) {
			throw new Error(`Unexpected affected-plan argument: ${arg}`);
		}
		baseRef = arg;
	}

	return {
		baseRef,
		json,
		changedFiles: changedFiles.length > 0 ? changedFiles : null,
	};
}

function printAffectedPlan(commandArgs) {
	const { baseRef, json, changedFiles } = parseAffectedPlanArgs(commandArgs);
	const plan = buildAffectedPlan(baseRef, changedFiles);
	if (json) {
		const jsonPlan = { ...plan };
		delete jsonPlan.weightedFiles;
		process.stdout.write(`${JSON.stringify(jsonPlan, null, 2)}\n`);
		return;
	}
	process.stdout.write(formatAffectedPlan(plan));
}

function runAffected(baseRef, extraArgs) {
	const { lanes } = classifyFiles();
	const plan = buildAffectedPlan(baseRef);
	const files = plan.weightedFiles;
	process.stdout.write(formatAffectedPlan(plan));

	const filesByLane = new Map(LANE_ORDER.map((laneName) => [laneName, []]));
	for (const file of files) {
		filesByLane.get(file.lane).push(file);
	}

	let exitCode = 0;
	const selectedLaneCount = [...filesByLane.values()].filter((laneFiles) => laneFiles.length > 0).length;
	for (const laneName of LANE_ORDER) {
		const laneFiles = filesByLane.get(laneName);
		if (laneFiles.length === 0) {
			continue;
		}
		const lane = lanes[laneName];
		const groupWeight = laneFiles.reduce((sum, file) => sum + file.weight, 0);
		process.stdout.write(formatPlan(`Affected ${laneName}`, laneFiles, groupWeight));
		const groupExtraArgs = selectedLaneCount > 1 ? rewriteJUnitOutputArgs(extraArgs, laneName) : extraArgs;
		const groupExitCode = runVitest(`affected-${laneName}`, laneFiles, lane.serial, groupExtraArgs);
		if (groupExitCode !== 0) {
			exitCode = groupExitCode;
		}
	}

	process.exit(exitCode);
}

function parseAffectedLaneArgs(commandArgs) {
	const [laneName, ...rest] = commandArgs;
	if (!laneName) {
		throw new Error(usage());
	}

	let shardIndex = null;
	let shardTotal = null;
	let remaining = rest;
	if (/^\d+$/.test(remaining[0] ?? '') && /^\d+$/.test(remaining[1] ?? '')) {
		shardIndex = Number.parseInt(remaining[0], 10);
		shardTotal = Number.parseInt(remaining[1], 10);
		remaining = remaining.slice(2);
	}

	let baseRef = null;
	const changedFiles = [];
	for (let index = 0; index < remaining.length; index += 1) {
		const arg = remaining[index];
		if (arg === '--changed-file') {
			const changedFile = remaining[index + 1];
			if (!changedFile) {
				throw new Error('affected-lane --changed-file requires a path.');
			}
			changedFiles.push(changedFile);
			index += 1;
			continue;
		}
		if (arg.startsWith('--')) {
			throw new Error(`Unknown affected-lane option: ${arg}`);
		}
		if (baseRef) {
			throw new Error(`Unexpected affected-lane argument: ${arg}`);
		}
		baseRef = arg;
	}

	return { laneName, shardIndex, shardTotal, baseRef, changedFiles: changedFiles.length > 0 ? changedFiles : null };
}

function runAffectedLane(commandArgs, extraArgs) {
	const { laneName, shardIndex, shardTotal, baseRef, changedFiles } = parseAffectedLaneArgs(commandArgs);
	const { lanes } = classifyFiles();
	const lane = lanes[laneName];
	if (!lane) {
		throw new Error(`Unknown lane: ${laneName}\n${usage()}`);
	}

	const plan = buildAffectedPlan(baseRef, changedFiles);
	const laneFiles = plan.weightedFiles.filter((file) => file.lane === laneName);
	let selected = {
		index: 1,
		totalWeight: laneFiles.reduce((sum, file) => sum + file.weight, 0),
		files: laneFiles,
	};
	if (shardIndex !== null || shardTotal !== null) {
		if (shardIndex === null || shardTotal === null) {
			throw new Error('affected-lane sharding requires both shardIndex and shardTotal.');
		}
		if (!Number.isInteger(shardIndex) || shardIndex <= 0 || shardIndex > shardTotal) {
			throw new Error(`Shard index must be between 1 and ${shardTotal}, got: ${shardIndex}`);
		}
		selected = partitionFiles(laneFiles, shardTotal)[shardIndex - 1];
	}

	const label =
		shardTotal === null ? `affected-${laneName}` : `affected-${laneName}-${selected.index}-of-${shardTotal}`;
	process.stdout.write(
		formatPlan(`Running ${label}${baseRef ? ` against ${baseRef}` : ''}`, selected.files, selected.totalWeight),
	);
	process.exit(runVitest(label, selected.files, lane.serial, extraArgs));
}

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];
const argsAfterCommand = rawArgs[1] === '--' ? rawArgs.slice(2) : rawArgs.slice(1);
const { commandArgs, extraArgs } = splitCommandArgs(argsAfterCommand);

try {
	if (command === 'verify') {
		const [laneName, shardTotalRaw] = commandArgs;
		verify(laneName ?? null, shardTotalRaw ? Number.parseInt(shardTotalRaw, 10) : null);
	} else if (command === 'summary') {
		const [laneName, shardIndexRaw, shardTotalRaw] = commandArgs;
		if (!laneName) throw new Error(usage());
		printSummary(
			laneName,
			shardIndexRaw ? Number.parseInt(shardIndexRaw, 10) : null,
			shardTotalRaw ? Number.parseInt(shardTotalRaw, 10) : null,
		);
	} else if (command === 'list') {
		const [laneName, shardIndexRaw, shardTotalRaw] = commandArgs;
		if (!laneName) throw new Error(usage());
		printList(
			laneName,
			shardIndexRaw ? Number.parseInt(shardIndexRaw, 10) : null,
			shardTotalRaw ? Number.parseInt(shardTotalRaw, 10) : null,
		);
	} else if (command === 'run') {
		const [laneName, maybeShardIndex, maybeShardTotal] = commandArgs;
		if (!laneName) throw new Error(usage());
		runLane(
			laneName,
			maybeShardIndex ? Number.parseInt(maybeShardIndex, 10) : null,
			maybeShardTotal ? Number.parseInt(maybeShardTotal, 10) : null,
			extraArgs,
		);
	} else if (command === 'affected') {
		const [baseRef] = commandArgs;
		if (baseRef?.startsWith('--')) {
			runAffected(null, [...commandArgs, ...extraArgs]);
		} else {
			runAffected(baseRef, extraArgs);
		}
	} else if (command === 'affected-plan') {
		printAffectedPlan(commandArgs);
	} else if (command === 'affected-lane') {
		runAffectedLane(commandArgs, extraArgs);
	} else {
		throw new Error(usage());
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
