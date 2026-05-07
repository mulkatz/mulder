/**
 * CLI command: `mulder translate <source-id>`.
 *
 * Thin wrapper around the translation pipeline service. Business logic lives
 * in `@mulder/pipeline`.
 *
 * @see docs/specs/110_translation_service.spec.md
 * @see docs/functional-spec-addendum.md §A7
 */

import type { TranslationOutputFormat, TranslationPipelinePath } from '@mulder/core';
import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import { executeTranslate } from '@mulder/pipeline';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printJson, printSuccess } from '../lib/output.js';

interface TranslateCliOptions {
	target?: string;
	sourceLanguage?: string;
	path?: string;
	format?: string;
	refresh?: boolean;
	json?: boolean;
}

function normalizePipelinePath(value: string | undefined): TranslationPipelinePath {
	if (value === undefined || value === 'translation-only' || value === 'translation_only') {
		return 'translation_only';
	}
	if (value === 'full') {
		return 'full';
	}
	printError(`Unknown --path "${value}". Valid paths: full, translation-only`);
	process.exit(1);
	return 'translation_only';
}

function normalizeOutputFormat(value: string | undefined): TranslationOutputFormat | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === 'markdown' || value === 'html') {
		return value;
	}
	printError(`Unknown --format "${value}". Valid formats: markdown, html`);
	process.exit(1);
	return undefined;
}

export function registerTranslateCommands(program: Command): void {
	program
		.command('translate')
		.description('Translate a source document and cache the result')
		.argument('<source-id>', 'UUID of the source document to translate')
		.option('--target <lang>', 'target language ISO code')
		.option('--source-language <lang>', 'source language ISO code')
		.option('--path <path>', 'translation path: full or translation-only')
		.option('--format <format>', 'output format: markdown or html')
		.option('--refresh', 'ignore current cache row and translate again')
		.option('--json', 'print metadata and content as JSON')
		.action(
			withErrorHandler(async (sourceId: string, options: TranslateCliOptions) => {
				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for translate (or enable dev_mode)');
					process.exit(1);
					return;
				}
				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for translate');
					process.exit(1);
					return;
				}

				const pipelinePath = normalizePipelinePath(options.path);
				const outputFormat = normalizeOutputFormat(options.format);
				const pool = getWorkerPool(config.gcp.cloud_sql);
				try {
					const result = await executeTranslate(
						{
							sourceId,
							targetLanguage: options.target,
							sourceLanguage: options.sourceLanguage,
							pipelinePath,
							outputFormat,
							refresh: options.refresh,
						},
						config,
						services,
						pool,
						logger,
					);

					if (options.json) {
						printJson({
							source_id: result.data.sourceId,
							translation_id: result.data.translationId,
							outcome: result.data.outcome,
							source_language: result.data.sourceLanguage,
							target_language: result.data.targetLanguage,
							pipeline_path: result.data.pipelinePath,
							output_format: result.data.outputFormat,
							content_hash: result.data.contentHash,
							content: result.data.content,
						});
						return;
					}

					process.stdout.write(result.data.content);
					if (!result.data.content.endsWith('\n')) {
						process.stdout.write('\n');
					}
					printSuccess(`Translation ${result.data.outcome}: ${result.data.translationId}`);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
