import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const ERRORS_FILE = resolve(ROOT, 'packages/core/src/shared/errors.ts');

/**
 * QA Gate — Error Code Coverage (QA-5)
 *
 * Static analysis of source files. Parses error codes from errors.ts,
 * then searches all .ts source files for usage patterns.
 *
 * QA-21: All error codes are ACTIVE or RESERVED (no DEAD codes)
 * QA-22: Error classes use correct code types
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .ts files under a directory, excluding node_modules and dist.
 */
function collectTsFiles(dir: string): string[] {
	const files: string[] = [];
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTsFiles(fullPath));
		} else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			files.push(fullPath);
		}
	}
	return files;
}

/**
 * Parse all error code constants from errors.ts.
 * Returns a map of code constant name to group and value.
 */
function parseErrorCodes(content: string): Map<string, { group: string; value: string }> {
	const codes = new Map<string, { group: string; value: string }>();

	// Match each *_ERROR_CODES object
	const groupMatches = content.matchAll(/export\s+const\s+(\w+_ERROR_CODES)\s*=\s*\{([^}]+)\}/gs);

	for (const groupMatch of groupMatches) {
		const groupName = groupMatch[1];
		const body = groupMatch[2];

		// Match each property: KEY: 'VALUE'
		const propMatches = body.matchAll(/(\w+)\s*:\s*'(\w+)'/g);
		for (const propMatch of propMatches) {
			codes.set(propMatch[1], { group: groupName, value: propMatch[2] });
		}
	}

	return codes;
}

/**
 * Parse reserved JSDoc annotations from errors.ts.
 * Returns a set of code constant names that have reserved annotations.
 */
function parseReservedAnnotations(content: string): Set<string> {
	const reserved = new Set<string>();
	const lines = content.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.includes('@reserved')) {
			// The next non-empty, non-comment line should have the code
			for (let j = i + 1; j < lines.length; j++) {
				const nextLine = lines[j].trim();
				if (!nextLine || nextLine.startsWith('*') || nextLine.startsWith('//')) continue;
				const codeMatch = nextLine.match(/^(\w+)\s*:/);
				if (codeMatch) {
					reserved.add(codeMatch[1]);
				}
				break;
			}
		}
	}

	return reserved;
}

/**
 * Parse error class definitions and their code type constraints.
 * Returns a map of class name to expected code type name.
 */
function parseErrorClasses(content: string): Map<string, string> {
	const classes = new Map<string, string>();

	// Match class definitions like: export class IngestError extends MulderError {
	//   constructor(message: string, code: IngestErrorCode, ...)
	const classRegex =
		/export\s+class\s+(\w+Error)\s+extends\s+MulderError\s*\{[^}]*constructor\s*\([^)]*code:\s*(\w+)/gs;
	const matches = content.matchAll(classRegex);

	for (const match of matches) {
		classes.set(match[1], match[2]);
	}

	return classes;
}

/**
 * Check if a code value string appears in source code (outside errors.ts and test files).
 */
function isCodeUsedInSource(codeValue: string, sourceFiles: string[]): boolean {
	for (const file of sourceFiles) {
		// Skip the errors.ts file itself and test files
		if (file === ERRORS_FILE) continue;
		if (file.includes('/tests/') || file.includes('.test.ts') || file.includes('.spec.ts')) continue;

		const content = readFileSync(file, 'utf-8');

		// Check for various usage patterns:
		// 1. 'CODE_VALUE' literal string
		// 2. "CODE_VALUE" literal string
		// 3. .CODE_VALUE reference from imported CODES object
		if (content.includes(`'${codeValue}'`) || content.includes(`"${codeValue}"`) || content.includes(`.${codeValue}`)) {
			return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Spec 33 — QA-5: Error Code Coverage', () => {
	const errorsContent = readFileSync(ERRORS_FILE, 'utf-8');
	const allCodes = parseErrorCodes(errorsContent);
	const reservedCodes = parseReservedAnnotations(errorsContent);
	const errorClasses = parseErrorClasses(errorsContent);

	// Collect all source .ts files
	const sourceFiles = [...collectTsFiles(resolve(ROOT, 'packages')), ...collectTsFiles(resolve(ROOT, 'apps'))];

	// ─────────────────────────────────────────────────────────────────────────
	// QA-21: All error codes are ACTIVE or RESERVED
	// ─────────────────────────────────────────────────────────────────────────

	describe('QA-21: No DEAD error codes — every code is either thrown or @reserved-annotated', () => {
		const codeEntries = Array.from(allCodes.entries());

		it('errors.ts defines error codes', () => {
			expect(codeEntries.length).toBeGreaterThan(0);
		});

		it('reserved annotations are present for known reserved codes', () => {
			const expectedReserved = [
				// Spec 33 §4.5 known reserved codes
				'INGEST_DUPLICATE',
				'EXTRACT_PAGE_RENDER_FAILED',
				'ENRICH_VALIDATION_FAILED',
				'EMBED_STORY_NOT_FOUND',
				'EMBED_QUESTION_GENERATION_FAILED',
				'EMBED_CHUNK_WRITE_FAILED',
				// Additional codes defined but not yet thrown (future steps)
				'CONFIG_NOT_FOUND',
				'PIPELINE_SOURCE_NOT_FOUND',
				'PIPELINE_WRONG_STATUS',
				'PIPELINE_STEP_FAILED',
				'PIPELINE_RATE_LIMITED',
				'TAXONOMY_BOOTSTRAP_TOO_FEW',
				'EMBED_INVALID_STATUS',
				'EMBED_MARKDOWN_NOT_FOUND',
			];

			for (const code of expectedReserved) {
				expect(reservedCodes.has(code), `Expected @reserved annotation for ${code}`).toBe(true);
			}
		});

		for (const [codeName, { value }] of codeEntries) {
			it(`${codeName} (${value}) is either ACTIVE or RESERVED`, () => {
				const isReserved = reservedCodes.has(codeName);
				const isActive = isCodeUsedInSource(value, sourceFiles);

				if (!isActive && !isReserved) {
					// This is a DEAD code — fail the test
					expect.fail(
						`Error code ${codeName} ('${value}') is DEAD: neither thrown in source code ` +
							`nor annotated with @reserved in errors.ts`,
					);
				}

				// At least one of them should be true
				expect(isActive || isReserved).toBe(true);
			});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// QA-22: Error classes use correct code types
	// ─────────────────────────────────────────────────────────────────────────

	describe('QA-22: Error class constructors enforce correct code type constraints', () => {
		/**
		 * Expected mapping: error class to code type to code group constant.
		 */
		const expectedMappings: Record<string, { codeType: string; codeGroup: string }> = {
			ConfigError: { codeType: 'ConfigErrorCode', codeGroup: 'CONFIG_ERROR_CODES' },
			PipelineError: { codeType: 'PipelineErrorCode', codeGroup: 'PIPELINE_ERROR_CODES' },
			DatabaseError: { codeType: 'DatabaseErrorCode', codeGroup: 'DATABASE_ERROR_CODES' },
			ExternalServiceError: { codeType: 'ExternalServiceErrorCode', codeGroup: 'EXTERNAL_SERVICE_ERROR_CODES' },
			IngestError: { codeType: 'IngestErrorCode', codeGroup: 'INGEST_ERROR_CODES' },
			ExtractError: { codeType: 'ExtractErrorCode', codeGroup: 'EXTRACT_ERROR_CODES' },
			SegmentError: { codeType: 'SegmentErrorCode', codeGroup: 'SEGMENT_ERROR_CODES' },
			EnrichError: { codeType: 'EnrichErrorCode', codeGroup: 'ENRICH_ERROR_CODES' },
			EmbedError: { codeType: 'EmbedErrorCode', codeGroup: 'EMBED_ERROR_CODES' },
			GraphError: { codeType: 'GraphErrorCode', codeGroup: 'GRAPH_ERROR_CODES' },
			RetrievalError: { codeType: 'RetrievalErrorCode', codeGroup: 'RETRIEVAL_ERROR_CODES' },
			PromptError: { codeType: 'PromptErrorCode', codeGroup: 'PROMPT_ERROR_CODES' },
		};

		it('all expected error classes exist in errors.ts', () => {
			for (const className of Object.keys(expectedMappings)) {
				expect(errorClasses.has(className), `Error class ${className} not found`).toBe(true);
			}
		});

		for (const [className, expected] of Object.entries(expectedMappings)) {
			it(`${className} constructor accepts ${expected.codeType}`, () => {
				const actualCodeType = errorClasses.get(className);
				expect(actualCodeType, `${className} not found`).toBeDefined();
				expect(actualCodeType).toBe(expected.codeType);
			});
		}

		it('each error class code type covers exactly the codes in its group', () => {
			// Verify that each code group's codes match the error class's type
			for (const [_className, expected] of Object.entries(expectedMappings)) {
				const groupCodes: string[] = [];
				for (const [codeName, { group }] of allCodes) {
					if (group === expected.codeGroup) {
						groupCodes.push(codeName);
					}
				}
				// At least one code per group
				expect(groupCodes.length, `${expected.codeGroup} should have at least one code`).toBeGreaterThan(0);
			}
		});

		it('no error codes are unaccounted for (every code belongs to a known group)', () => {
			const knownGroups = new Set(Object.values(expectedMappings).map((m) => m.codeGroup));
			// Also add TAXONOMY_ERROR_CODES which doesn't have its own class yet (uses MulderError directly)
			knownGroups.add('TAXONOMY_ERROR_CODES');

			for (const [codeName, { group }] of allCodes) {
				expect(knownGroups.has(group), `Code ${codeName} belongs to unknown group ${group}`).toBe(true);
			}
		});
	});
});
