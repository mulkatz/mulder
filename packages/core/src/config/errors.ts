/**
 * Config validation error with structured issue reporting.
 * Wraps Zod validation errors and custom cross-reference checks
 * into a unified format with dot-separated paths.
 */

export interface ConfigIssue {
	/** Dot-separated path like "ontology.entity_types[0].name" */
	path: string;
	/** Human-readable error description */
	message: string;
	/** Zod error code or custom code like "invalid_reference" */
	code: string;
}

export class ConfigValidationError extends Error {
	public readonly issues: readonly ConfigIssue[];

	constructor(issues: readonly ConfigIssue[]) {
		super(ConfigValidationError.formatMessage(issues));
		this.name = 'ConfigValidationError';
		this.issues = issues;
	}

	private static formatMessage(issues: readonly ConfigIssue[]): string {
		const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
		return `Config validation failed:\n${lines.join('\n')}`;
	}
}
