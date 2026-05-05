/**
 * Jinja2-style prompt template engine.
 *
 * Loads `.jinja2` template files from the `templates/` directory, resolves
 * `{{ variable.path }}` placeholders using dot-notation access, and injects
 * i18n fragments from locale JSON files when `variables.locale` is set.
 *
 * Templates and i18n files are cached after first read — they are static
 * files that do not change at runtime.
 *
 * @see docs/specs/18_prompt_template_engine.spec.md
 * @see docs/functional-spec.md §4.7
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROMPT_ERROR_CODES, PromptError } from '../shared/errors.js';
import { PII_TYPES, SENSITIVITY_LEVELS } from '../shared/sensitivity.js';

// ────────────────────────────────────────────────────────────
// Path resolution
// ────────────────────────────────────────────────────────────

const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the prompts base directory.
 *
 * At runtime the compiled JS lives at `dist/prompts/engine.js` while the
 * template and i18n assets remain in `src/prompts/`. We walk up from the
 * engine directory and check both `src/prompts/` (dev/production) and the
 * current directory (tests that may set an override).
 *
 * An explicit override via `MULDER_PROMPTS_DIR` env var is honoured first
 * to support testing.
 */
function resolvePromptsDir(): string {
	if (process.env.MULDER_PROMPTS_DIR) {
		return resolve(process.env.MULDER_PROMPTS_DIR);
	}

	// When running from dist/prompts/engine.js → package root is ../../
	// When running from src/prompts/engine.ts (ts-node / vitest) → package root is ../../
	const packageRoot = resolve(ENGINE_DIR, '..', '..');
	const srcPrompts = join(packageRoot, 'src', 'prompts');
	return srcPrompts;
}

const PROMPTS_DIR = resolvePromptsDir();
const TEMPLATES_DIR = join(PROMPTS_DIR, 'templates');
const I18N_DIR = join(PROMPTS_DIR, 'i18n');

// ────────────────────────────────────────────────────────────
// Caches
// ────────────────────────────────────────────────────────────

/** Module-level template cache. Templates are static — no TTL needed. */
const templateCache = new Map<string, string>();

/** Module-level i18n cache. Locale files are static — no TTL needed. */
const i18nCache = new Map<string, Record<string, unknown>>();

// ────────────────────────────────────────────────────────────
// Template placeholder regex
// ────────────────────────────────────────────────────────────

/**
 * Matches Jinja2-style `{{ variable }}` and `{{ dotted.path }}` placeholders.
 * Captures the inner expression (trimmed of whitespace).
 * Also strips Jinja2 comments `{# ... #}` from the template before interpolation.
 */
const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const COMMENT_RE = /\{#[\s\S]*?#\}/g;

// ────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────

/**
 * Loads a template file from disk, or returns the cached version.
 * Throws `PromptError` with `TEMPLATE_NOT_FOUND` if the file does not exist.
 */
function loadTemplate(templateName: string): string {
	const cached = templateCache.get(templateName);
	if (cached !== undefined) {
		return cached;
	}

	const templatePath = join(TEMPLATES_DIR, `${templateName}.jinja2`);

	let content: string;
	try {
		content = readFileSync(templatePath, 'utf-8');
	} catch (cause: unknown) {
		throw new PromptError(`Template not found: ${templateName}`, PROMPT_ERROR_CODES.TEMPLATE_NOT_FOUND, {
			context: { templateName, templatePath },
			cause,
		});
	}

	templateCache.set(templateName, content);
	return content;
}

/**
 * Loads an i18n locale file, or returns the cached version.
 * Throws `PromptError` with `LOCALE_FILE_NOT_FOUND` if the file does not exist.
 * Throws `PromptError` with `TEMPLATE_PARSE_ERROR` if the JSON is invalid.
 */
function loadLocale(locale: string): Record<string, unknown> {
	const cached = i18nCache.get(locale);
	if (cached !== undefined) {
		return cached;
	}

	const localePath = join(I18N_DIR, `${locale}.json`);

	let raw: string;
	try {
		raw = readFileSync(localePath, 'utf-8');
	} catch (cause: unknown) {
		throw new PromptError(`Locale file not found: ${locale}`, PROMPT_ERROR_CODES.LOCALE_FILE_NOT_FOUND, {
			context: { locale, localePath },
			cause,
		});
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause: unknown) {
		throw new PromptError(`Failed to parse locale file: ${locale}`, PROMPT_ERROR_CODES.TEMPLATE_PARSE_ERROR, {
			context: { locale, localePath },
			cause,
		});
	}

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new PromptError(
			`Locale file must contain a JSON object: ${locale}`,
			PROMPT_ERROR_CODES.TEMPLATE_PARSE_ERROR,
			{ context: { locale, localePath } },
		);
	}

	const localeData: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
	i18nCache.set(locale, localeData);
	return localeData;
}

/**
 * Type guard: checks if a value is a non-null, non-array object (i.e. a record).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolves a dot-notation path on a nested object.
 * Returns the value at the path, or `undefined` if any segment is missing.
 */
function resolveDotPath(obj: Record<string, unknown>, path: string): unknown {
	const segments = path.split('.');
	let current: unknown = obj;

	for (const segment of segments) {
		if (!isRecord(current)) {
			return undefined;
		}
		current = current[segment];
	}

	return current;
}

/**
 * Converts a value to its string representation for template interpolation.
 * Objects and arrays become JSON strings; primitives use String().
 */
function valueToString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'object' && value !== null) {
		return JSON.stringify(value);
	}
	return String(value);
}

function templateDefaultVariables(templateName: string): Record<string, unknown> {
	if (templateName !== 'extract-entities') {
		return {};
	}

	return {
		sensitivity_auto_detection: 'false',
		sensitivity_levels: SENSITIVITY_LEVELS.join(', '),
		sensitivity_default_level: 'internal',
		sensitivity_pii_types: PII_TYPES.join(', '),
	};
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

/**
 * Renders a prompt template with the given variables.
 *
 * 1. Loads the template file from `templates/<templateName>.jinja2`
 * 2. If `variables.locale` is set, loads `i18n/<locale>.json` and merges as `variables.i18n`
 * 3. Strips Jinja2 comments (`{# ... #}`)
 * 4. Interpolates all `{{ variable.path }}` placeholders
 * 5. Throws `PromptError` for missing templates, variables, or locale files
 *
 * @param templateName - Name of the template (without `.jinja2` extension)
 * @param variables - Key/value pairs for placeholder interpolation
 * @returns The fully rendered prompt string
 *
 * @throws {PromptError} TEMPLATE_NOT_FOUND — template file does not exist
 * @throws {PromptError} TEMPLATE_VARIABLE_MISSING — placeholder references undefined variable
 * @throws {PromptError} LOCALE_FILE_NOT_FOUND — locale JSON file does not exist
 * @throws {PromptError} TEMPLATE_PARSE_ERROR — locale JSON is malformed
 */
export function renderPrompt(templateName: string, variables: Record<string, unknown>): string {
	// 1. Load template
	const template = loadTemplate(templateName);

	// 2. Resolve i18n if locale is provided
	const mergedVars: Record<string, unknown> = { ...templateDefaultVariables(templateName), ...variables };
	if (typeof variables.locale === 'string' && variables.locale.length > 0) {
		const localeData = loadLocale(variables.locale);
		mergedVars.i18n = localeData;
	}

	// 3. Strip Jinja2 comments
	const stripped = template.replace(COMMENT_RE, '');

	// 4. Interpolate placeholders
	const rendered = stripped.replace(PLACEHOLDER_RE, (_match, path: string) => {
		const value = resolveDotPath(mergedVars, path);

		if (value === undefined) {
			throw new PromptError(
				`Template variable missing: ${path} in template "${templateName}"`,
				PROMPT_ERROR_CODES.TEMPLATE_VARIABLE_MISSING,
				{
					context: {
						templateName,
						variablePath: path,
						availableKeys: Object.keys(mergedVars),
					},
				},
			);
		}

		return valueToString(value);
	});

	return rendered;
}

/**
 * Lists all available template names (without the `.jinja2` extension).
 *
 * @returns Sorted array of template names
 */
export function listTemplates(): string[] {
	try {
		const files = readdirSync(TEMPLATES_DIR);
		return files
			.filter((f) => f.endsWith('.jinja2'))
			.map((f) => f.replace(/\.jinja2$/, ''))
			.sort();
	} catch (cause: unknown) {
		throw new PromptError('Failed to list templates directory', PROMPT_ERROR_CODES.TEMPLATE_NOT_FOUND, {
			context: { templatesDir: TEMPLATES_DIR },
			cause,
		});
	}
}

/**
 * Clears the template and i18n caches.
 * Primarily useful for testing — in production, caches persist for the process lifetime.
 */
export function clearPromptCaches(): void {
	templateCache.clear();
	i18nCache.clear();
}
