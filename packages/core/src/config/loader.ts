/**
 * Config loader — reads mulder.config.yaml, validates, applies defaults, freezes.
 * Every CLI command and pipeline step calls loadConfig() as its first action.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ConfigValidationError } from './errors.js';
import { mulderConfigSchema } from './schema.js';
import type { MulderConfig } from './types.js';

const DEFAULT_CONFIG_FILENAME = 'mulder.config.yaml';

/**
 * Recursively freezes an object and all nested objects/arrays.
 * Prevents accidental mutation of shared config state.
 */
function deepFreeze<T extends object>(obj: T): Readonly<T> {
	Object.freeze(obj);

	for (const value of Object.values(obj)) {
		if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
			deepFreeze(value);
		}
	}

	return obj;
}

/**
 * Formats a Zod issue path to a dot-separated string.
 * Array indices are rendered as [n].
 */
function formatZodPath(path: readonly PropertyKey[]): string {
	return path
		.map((segment, i) => {
			if (typeof segment === 'number') {
				return `[${segment}]`;
			}
			return i === 0 ? String(segment) : `.${String(segment)}`;
		})
		.join('');
}

/**
 * Load, parse, validate, and freeze the Mulder config.
 *
 * Path resolution order:
 * 1. Explicit `path` argument
 * 2. `MULDER_CONFIG` environment variable
 * 3. `./mulder.config.yaml` (CWD)
 *
 * @throws {ConfigValidationError} on file not found, invalid YAML, or validation failure
 */
export function loadConfig(path?: string): Readonly<MulderConfig> {
	// 1. Resolve path
	const configPath = resolve(path ?? process.env.MULDER_CONFIG ?? DEFAULT_CONFIG_FILENAME);

	// 2. Read file
	let rawContent: string;
	try {
		rawContent = readFileSync(configPath, 'utf-8');
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ConfigValidationError([
			{
				path: configPath,
				message: `Cannot read config file: ${message}`,
				code: 'file_not_found',
			},
		]);
	}

	// 3. Parse YAML
	let parsed: unknown;
	try {
		parsed = parseYaml(rawContent);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ConfigValidationError([
			{
				path: configPath,
				message: `Invalid YAML: ${message}`,
				code: 'invalid_yaml',
			},
		]);
	}

	// 4. Validate against Zod schema (applies defaults via .default())
	let config: MulderConfig;
	try {
		config = mulderConfigSchema.parse(parsed);
	} catch (err: unknown) {
		if (err instanceof ZodError) {
			throw new ConfigValidationError(
				err.issues.map((issue) => ({
					path: formatZodPath(issue.path),
					message: issue.message,
					code:
						issue.code === 'custom' && issue.params && typeof issue.params.customCode === 'string'
							? issue.params.customCode
							: issue.code,
				})),
			);
		}
		throw err;
	}

	// 5. Deep freeze the result
	return deepFreeze(config);
}
