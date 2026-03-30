/**
 * Service registry — the dependency injector for the Mulder platform.
 *
 * Selects dev or production service implementations based on config and environment.
 * Pipeline steps call `createServiceRegistry()` once and receive a `Services` bundle.
 * They never check `dev_mode` themselves.
 *
 * @see docs/specs/11_service_abstraction.spec.md §4.3
 * @see docs/functional-spec.md §4.5, §4.6
 */

import type { MulderConfig } from '../config/types.js';
import { ConfigError } from './errors.js';
import type { Logger } from './logger.js';
import { createDevServices } from './services.dev.js';
import type { ServiceMode, Services } from './services.js';

// ────────────────────────────────────────────────────────────
// Mode detection
// ────────────────────────────────────────────────────────────

/**
 * Determines the active service mode based on config and environment.
 */
function resolveServiceMode(config: MulderConfig): ServiceMode {
	if (config.dev_mode || process.env.NODE_ENV === 'development') {
		return 'dev';
	}
	if (process.env.NODE_ENV === 'test') {
		return 'dev';
	}
	return 'gcp';
}

// ────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────

/**
 * Creates the service registry — the single place that decides which
 * implementation to use.
 *
 * - `dev_mode: true` or `NODE_ENV=development` → fixture-based dev services
 * - `NODE_ENV=test` → fixture-based dev services (tests always use fixtures)
 * - Otherwise → throws `ConfigError` (GCP implementations not yet available, M2-B1)
 *
 * @param config - The validated Mulder configuration.
 * @param logger - Logger instance for service initialization logging.
 * @returns A `Services` bundle with all service implementations.
 * @throws {ConfigError} When GCP mode is requested but not yet implemented.
 */
export function createServiceRegistry(config: MulderConfig, logger: Logger): Services {
	const mode = resolveServiceMode(config);

	logger.info({ mode }, 'Initializing service registry');

	if (mode === 'dev') {
		return createDevServices(config, logger);
	}

	// GCP implementations are not yet available (M2-B1)
	throw new ConfigError(
		'GCP service implementations are not yet available. Set dev_mode: true in config or NODE_ENV=development to use fixture-based dev services.',
		'CONFIG_INVALID',
		{
			context: {
				requestedMode: mode,
				hint: 'GCP services will be implemented in M2-B1',
			},
		},
	);
}
