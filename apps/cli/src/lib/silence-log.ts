/**
 * Side-effect-only module that conditionally silences the pino logger
 * BEFORE any `@mulder/core` import runs.
 *
 * Some CLI commands (e.g. `mulder show`) have a contract of byte-clean
 * stdout output — users pipe their result into grep / less / files, or
 * assert on it in tests. The default `MULDER_LOG_LEVEL=info` causes pino
 * to emit JSON log lines to stdout during service-registry init and pool
 * cleanup, polluting the output.
 *
 * This module must be the **first** import in `apps/cli/src/index.ts`.
 * ES module imports are evaluated in declaration order, so mutating
 * `process.env` here runs before any downstream module creates a
 * module-scoped logger (notably `packages/core/src/database/client.ts`,
 * which calls `createLogger()` at import time).
 *
 * Doing the mutation as a top-level statement in `index.ts` itself does
 * NOT work: ESM hoists all `import` declarations above top-level
 * statements, so by the time the statement executes, the database
 * client's logger has already been captured with the previous level.
 */

const SILENT_OUTPUT_COMMANDS = ['show'];

if (!process.env.MULDER_LOG_LEVEL && SILENT_OUTPUT_COMMANDS.some((cmd) => process.argv.includes(cmd))) {
	process.env.MULDER_LOG_LEVEL = 'silent';
}
