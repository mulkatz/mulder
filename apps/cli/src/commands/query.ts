/**
 * CLI command: `mulder query <question>`.
 *
 * Thin wrapper that parses arguments, loads config, creates the service
 * registry, calls `hybridRetrieve`, and formats the output. No business
 * logic lives here.
 *
 * @see docs/specs/42_hybrid_retrieval_orchestrator.spec.md §4.6
 * @see docs/functional-spec.md §1 (query cmd), §5
 */

import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import { type HybridRetrievalResult, hybridRetrieve, type RetrievalStrategyMode } from '@mulder/retrieval';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError, printSuccess } from '../lib/output.js';

interface QueryOptions {
	strategy?: string;
	topK?: string;
	rerank?: boolean;
	explain?: boolean;
	json?: boolean;
}

/** Allow-list for `--strategy`. Mirrors `RetrievalStrategyMode`. */
const VALID_STRATEGIES: readonly RetrievalStrategyMode[] = ['vector', 'fulltext', 'graph', 'hybrid'] as const;

/** Type guard: narrows an unknown string to {@link RetrievalStrategyMode}. */
function isRetrievalStrategyMode(value: string): value is RetrievalStrategyMode {
	return (VALID_STRATEGIES as readonly string[]).includes(value);
}

/** Truncates text to `max` characters, appending an ellipsis if needed. */
function truncateContent(content: string, max: number): string {
	if (content.length <= max) {
		return content;
	}
	return `${content.slice(0, max)}\u2026`;
}

/**
 * Renders the human-readable text mode for `mulder query`.
 *
 * Header → numbered results → confidence summary. When `--explain` is set,
 * each result is followed by indented per-strategy contributions.
 */
function renderTextOutput(result: HybridRetrievalResult, explain: boolean): void {
	const lines: string[] = [];

	lines.push(`Query: "${result.query}"`);
	lines.push(`Strategy: ${result.strategy}`);
	lines.push(`Top K: ${result.topK}`);
	lines.push('');
	lines.push('Results:');

	if (result.results.length === 0) {
		lines.push('  (no results)');
	} else {
		for (const entry of result.results) {
			const score = entry.rerankScore.toFixed(2);
			const content = truncateContent(entry.content, 80);
			lines.push(`  ${entry.rank}. [${score}] ${entry.storyId} — ${content}`);

			if (explain && result.explain.contributions) {
				const contribution = result.explain.contributions.find((c) => c.chunkId === entry.chunkId);
				if (contribution) {
					for (const strategy of contribution.strategies) {
						lines.push(`       ${strategy.strategy} rank=${strategy.rank} score=${strategy.score.toFixed(2)}`);
					}
				}
			}
		}
	}

	lines.push('');
	lines.push('Confidence:');
	lines.push(`  corpus_size: ${result.confidence.corpus_size}`);
	lines.push(`  taxonomy_status: ${result.confidence.taxonomy_status}`);
	lines.push(`  corroboration_reliability: ${result.confidence.corroboration_reliability}`);
	lines.push(`  graph_density: ${result.confidence.graph_density.toFixed(3)}`);
	lines.push(`  degraded: ${result.confidence.degraded}`);

	process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Registers the `query` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder query "<question>"
 *   --strategy <s>       vector | fulltext | graph | hybrid (default: hybrid)
 *   --top-k <n>          Number of results to return
 *   --no-rerank          Skip LLM re-ranking
 *   --explain            Show retrieval strategy breakdown per result
 *   --json               Emit JSON output
 * ```
 */
export function registerQueryCommands(program: Command): void {
	program
		.command('query')
		.description('Hybrid retrieval query against the indexed corpus')
		.argument('<question>', 'Natural-language question')
		.option('--strategy <s>', 'vector | fulltext | graph | hybrid (default: hybrid)')
		.option('--top-k <n>', 'Number of results to return')
		.option('--no-rerank', 'Skip LLM re-ranking')
		.option('--explain', 'Show retrieval strategy breakdown per result')
		.option('--json', 'Emit JSON output')
		.action(
			withErrorHandler(async (question: string, options: QueryOptions) => {
				// 1. Question must be a non-empty string after trimming.
				const trimmedQuestion = typeof question === 'string' ? question.trim() : '';
				if (trimmedQuestion.length === 0) {
					printError('question must not be empty');
					process.exit(1);
					return;
				}

				// 2. Validate --strategy.
				let strategy: RetrievalStrategyMode | undefined;
				if (options.strategy !== undefined) {
					if (!isRetrievalStrategyMode(options.strategy)) {
						printError(
							`invalid --strategy value "${options.strategy}" — must be one of ${VALID_STRATEGIES.join(' | ')}`,
						);
						process.exit(1);
						return;
					}
					strategy = options.strategy;
				}

				// 3. Validate --top-k.
				let topK: number | undefined;
				if (options.topK !== undefined) {
					const parsed = Number.parseInt(options.topK, 10);
					if (Number.isNaN(parsed) || parsed <= 0) {
						printError(`--top-k must be a positive integer, got "${options.topK}"`);
						process.exit(1);
						return;
					}
					topK = parsed;
				}

				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				// 4. Config gate (matches embed.ts pattern).
				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for query (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for query');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				// Commander's `--no-rerank` flips the boolean: when present,
				// `options.rerank === false`. Map it to the noRerank option.
				const noRerank = options.rerank === false;
				const explain = options.explain === true;

				try {
					const result = await hybridRetrieve(pool, services.embedding, services.llm, config, trimmedQuestion, {
						strategy,
						topK,
						noRerank,
						explain,
					});

					if (options.json) {
						process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
						return;
					}

					if (result.results.length === 0) {
						printSuccess('No results.');
						renderTextOutput(result, explain);
						return;
					}

					renderTextOutput(result, explain);
				} finally {
					await closeAllPools();
				}
			}),
		);
}
