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
import { registerCacheCommands } from './commands/cache.js';
import { registerConfigCommands } from './commands/config.js';
import { registerDbCommands } from './commands/db.js';
import { registerEmbedCommands } from './commands/embed.js';
import { registerEnrichCommands } from './commands/enrich.js';
import { registerExtractCommands } from './commands/extract.js';
import { registerFixtureCommands } from './commands/fixtures.js';
import { registerGraphCommands } from './commands/graph.js';
import { registerIngestCommands } from './commands/ingest.js';
import { registerPipelineCommands } from './commands/pipeline.js';
import { registerSegmentCommands } from './commands/segment.js';

const program = new Command()
	.name('mulder')
	.description('Config-driven Document Intelligence Platform')
	.version('0.0.0');

registerCacheCommands(program);
registerConfigCommands(program);
registerDbCommands(program);
registerEmbedCommands(program);
registerEnrichCommands(program);
registerExtractCommands(program);
registerFixtureCommands(program);
registerGraphCommands(program);
registerIngestCommands(program);
registerPipelineCommands(program);
registerSegmentCommands(program);

program.parse();
