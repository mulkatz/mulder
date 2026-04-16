#!/usr/bin/env node

/**
 * Mulder CLI — entry point.
 *
 * Creates the Commander program and registers command groups.
 * Each command group lives in its own file under ./commands/.
 *
 * @see docs/specs/06_cli_scaffold.spec.md §4.4
 */

import { Command } from 'commander';
import { registerAnalyzeCommands } from './commands/analyze.js';
import { registerCacheCommands } from './commands/cache.js';
import { registerConfigCommands } from './commands/config.js';
import { registerDbCommands } from './commands/db.js';
import { registerEmbedCommands } from './commands/embed.js';
import { registerEnrichCommands } from './commands/enrich.js';
import { registerEntityCommands } from './commands/entity.js';
import { registerEvalCommands } from './commands/eval.js';
import { registerExportCommands } from './commands/export.js';
import { registerExtractCommands } from './commands/extract.js';
import { registerFixtureCommands } from './commands/fixtures.js';
import { registerGraphCommands } from './commands/graph.js';
import { registerGroundCommands } from './commands/ground.js';
import { registerIngestCommands } from './commands/ingest.js';
import { registerPipelineCommands } from './commands/pipeline.js';
import { registerQueryCommands } from './commands/query.js';
import { registerRetryCommand } from './commands/retry.js';
import { registerReprocessCommands } from './commands/reprocess.js';
import { registerSegmentCommands } from './commands/segment.js';
import { registerShowCommands } from './commands/show.js';
import { registerStatusCommand } from './commands/status.js';
import { registerTaxonomyCommands } from './commands/taxonomy.js';
import { registerWorkerCommands } from './commands/worker.js';

const program = new Command()
	.name('mulder')
	.description('Config-driven Document Intelligence Platform')
	.version('0.0.0');

registerCacheCommands(program);
registerAnalyzeCommands(program);
registerConfigCommands(program);
registerDbCommands(program);
registerEvalCommands(program);
registerEmbedCommands(program);
registerEntityCommands(program);
registerExportCommands(program);
registerEnrichCommands(program);
registerExtractCommands(program);
registerFixtureCommands(program);
registerGroundCommands(program);
registerGraphCommands(program);
registerIngestCommands(program);
registerPipelineCommands(program);
registerRetryCommand(program);
registerQueryCommands(program);
registerReprocessCommands(program);
registerSegmentCommands(program);
registerShowCommands(program);
registerStatusCommand(program);
registerWorkerCommands(program);
registerTaxonomyCommands(program);

program.parse();
