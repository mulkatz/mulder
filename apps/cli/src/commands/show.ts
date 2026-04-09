/**
 * CLI command: `mulder show <source-id>`.
 *
 * Reads the `layout.md` artifact that spec 48 writes alongside `layout.json`
 * during the Extract step and prints it to stdout with lightweight ANSI
 * formatting. Stop-gap demoability command while the real document viewer
 * waits for M7-H11.
 *
 * @see docs/roadmap.md M7 (H10/H11 — API + viewer that will supersede this)
 */

import { spawn } from 'node:child_process';
import {
	closeAllPools,
	createLogger,
	createServiceRegistry,
	ExternalServiceError,
	findSourceById,
	getWorkerPool,
	loadConfig,
} from '@mulder/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import { withErrorHandler } from '../lib/errors.js';
import { printError } from '../lib/output.js';

interface ShowOptions {
	raw?: boolean;
	pager?: boolean;
}

/**
 * Registers the `show` command on the given Commander program.
 *
 * Usage:
 * ```
 * mulder show <source-id>
 *   --raw     Print plain Markdown with no ANSI colors
 *   --pager   Pipe output through $PAGER (or `less -R`)
 * ```
 */
export function registerShowCommands(program: Command): void {
	program
		.command('show')
		.description('Print the extracted layout.md for a source with terminal formatting')
		.argument('<source-id>', 'UUID of the source to show')
		.option('--raw', 'print plain Markdown (no ANSI colors)')
		.option('--pager', 'pipe formatted output through $PAGER (or `less -R`)')
		.action(
			withErrorHandler(async (sourceId: string, options: ShowOptions) => {
				const config = loadConfig();
				const logger = createLogger();
				const services = createServiceRegistry(config, logger);

				if (!config.gcp && !config.dev_mode) {
					printError('GCP configuration is required for show (or enable dev_mode)');
					process.exit(1);
					return;
				}

				if (!config.gcp) {
					printError('GCP configuration with cloud_sql is required for show');
					process.exit(1);
					return;
				}

				const pool = getWorkerPool(config.gcp.cloud_sql);

				try {
					const source = await findSourceById(pool, sourceId);
					if (!source) {
						printError(`Source not found: ${sourceId}`);
						process.exit(1);
						return;
					}

					const markdownUri = `extracted/${sourceId}/layout.md`;
					let markdown: string;
					try {
						const buffer = await services.storage.download(markdownUri);
						markdown = buffer.toString('utf-8');
					} catch (cause: unknown) {
						if (cause instanceof ExternalServiceError || cause instanceof Error) {
							printError(`layout.md not found for source ${sourceId}. Run \`mulder extract ${sourceId}\` first.`);
							process.exit(1);
							return;
						}
						throw cause;
					}

					const output = options.raw ? markdown : formatMarkdown(markdown);

					if (options.pager) {
						await writeToPager(output);
					} else {
						writeDirectly(output);
					}
				} finally {
					await closeAllPools();
				}
			}),
		);
}

// ────────────────────────────────────────────────────────────
// ANSI formatter — line-by-line Markdown → chalk
// ────────────────────────────────────────────────────────────

/**
 * Applies lightweight ANSI formatting to a Markdown document. Not a full
 * Markdown parser — just recognizes headings, horizontal rules, table rows,
 * fenced code blocks, and list markers. Everything else passes through.
 *
 * The goal is a readable terminal view, not pixel-perfect rendering. For
 * production-quality rendering, wait for the M7-H11 viewer.
 */
function formatMarkdown(text: string): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let inCodeBlock = false;

	for (const line of lines) {
		// Fenced code blocks — toggle state and dim the fence itself
		if (line.startsWith('```')) {
			inCodeBlock = !inCodeBlock;
			out.push(chalk.dim(line));
			continue;
		}
		if (inCodeBlock) {
			out.push(chalk.dim(line));
			continue;
		}

		// Horizontal rule — page separator in layout.md
		if (line === '---') {
			out.push(chalk.dim('─'.repeat(60)));
			continue;
		}

		// Headings — # / ## / ### / ####
		const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
		if (headingMatch) {
			const level = headingMatch[1]?.length ?? 1;
			const content = headingMatch[2] ?? '';
			if (level === 1) {
				out.push(chalk.bold.cyan.underline(content));
			} else if (level === 2) {
				out.push(chalk.bold.cyan(content));
			} else {
				out.push(chalk.bold(content));
			}
			continue;
		}

		// GFM table rows — pipe-delimited. Dim the separator row, leave
		// data rows plain (monospace terminals render them fine as-is).
		if (/^\|.*\|$/.test(line)) {
			if (/^\|[\s-|]+\|$/.test(line)) {
				out.push(chalk.dim(line));
			} else {
				out.push(line);
			}
			continue;
		}

		// Unordered list markers
		const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
		if (bulletMatch) {
			const indent = bulletMatch[1] ?? '';
			const content = bulletMatch[2] ?? '';
			out.push(`${indent}${chalk.cyan('•')} ${content}`);
			continue;
		}

		// Everything else — pass through
		out.push(line);
	}

	return out.join('\n');
}

// ────────────────────────────────────────────────────────────
// Pager integration
// ────────────────────────────────────────────────────────────

/**
 * Writes the given text to a pager child process. Uses `$PAGER` if set,
 * otherwise falls back to `less -R` (the `-R` flag preserves ANSI colors).
 * Resolves when the pager exits.
 *
 * If the pager cannot be spawned (binary missing, permission denied) the
 * text is written directly to stdout instead — a failed pager is never
 * fatal to the command itself.
 */
async function writeToPager(text: string): Promise<void> {
	const pagerEnv = process.env.PAGER;
	const [cmd, ...args] = pagerEnv ? pagerEnv.split(/\s+/) : ['less', '-R'];

	if (!cmd) {
		writeDirectly(text);
		return;
	}

	return new Promise((resolve) => {
		const child = spawn(cmd, args, {
			stdio: ['pipe', 'inherit', 'inherit'],
		});

		// Spawn failure (binary missing, ENOENT) → fall back to stdout,
		// never fatal.
		child.on('error', () => {
			writeDirectly(text);
			resolve();
		});

		// User quit the pager early → stdin gets EPIPE on write.end().
		// Swallow the error so it doesn't crash the command.
		child.stdin.on('error', () => undefined);

		child.on('exit', () => resolve());

		child.stdin.write(text);
		if (!text.endsWith('\n')) {
			child.stdin.write('\n');
		}
		child.stdin.end();
	});
}

function writeDirectly(text: string): void {
	process.stdout.write(text);
	if (!text.endsWith('\n')) {
		process.stdout.write('\n');
	}
}
