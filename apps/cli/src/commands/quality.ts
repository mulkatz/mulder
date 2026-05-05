import {
	closeAllPools,
	createLogger,
	createServiceRegistry,
	findAllSources,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import type { QualityResult } from '@mulder/pipeline';
import { executeQuality } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface QualityOptions {
	all?: boolean;
	force?: boolean;
}

function assessmentLabel(result: QualityResult): string {
	if (!result.data) {
		return result.status;
	}
	const assessment = result.data.assessment;
	const cached = result.data.reusedExisting ? 'cached' : 'new';
	return `${assessment.overallQuality}/${assessment.recommendedPath}/${cached}`;
}

export function registerQualityCommands(program: Command): void {
	program
		.command('quality')
		.description('Assess document quality for ingested sources')
		.argument('[source-id]', 'UUID of the source to assess')
		.option('--all', 'assess all sources with status=ingested')
		.option('--force', 'write a new assessment version even if one already exists')
		.action(
			withErrorHandler(async (sourceId: string | undefined, options: QualityOptions) => {
				if (!sourceId && !options.all) {
					printError('Provide a <source-id> or use --all');
					process.exit(1);
					return;
				}

				if (sourceId && options.all) {
					printError('<source-id> and --all are mutually exclusive');
					process.exit(1);
					return;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for quality (or enable dev_mode)');
					process.exit(1);
					return;
				}
				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for quality');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const results: Array<{ sourceId: string; result: QualityResult }> = [];
					if (options.all) {
						const sources = await findAllSources(pool, { status: 'ingested', limit: 1000 });
						for (const source of sources) {
							const result = await executeQuality(
								{ sourceId: source.id, force: options.force },
								config,
								services,
								pool,
								logger,
							);
							results.push({ sourceId: source.id, result });
						}
					} else if (sourceId) {
						const result = await executeQuality({ sourceId, force: options.force }, config, services, pool, logger);
						results.push({ sourceId, result });
					}

					if (results.length === 0) {
						printSuccess('No ingested sources found to assess');
						return;
					}

					const header = `${'Source ID'.padEnd(36)}  ${'Result'.padEnd(28)}  Status`;
					const separator = '-'.repeat(header.length);
					process.stdout.write(`${header}\n`);
					process.stdout.write(`${separator}\n`);
					for (const row of results) {
						process.stdout.write(
							`${row.sourceId.padEnd(36)}  ${assessmentLabel(row.result).padEnd(28)}  ${row.result.status}\n`,
						);
					}

					const failed = results.filter((row) => row.result.status === 'failed').length;
					const assessed = results.length - failed;
					if (failed > 0) {
						printError(`Quality partial: ${assessed} assessed, ${failed} failed`);
						process.exit(1);
						return;
					}
					printSuccess(`Quality complete: ${assessed} assessed`);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
