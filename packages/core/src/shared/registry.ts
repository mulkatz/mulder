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
import type { Logger } from './logger.js';
import { createDevServices } from './services.dev.js';
import { createGcpServices } from './services.gcp.js';
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
 * - Otherwise → GCP services (real API calls via Application Default Credentials)
 *
 * @param config - The validated Mulder configuration.
 * @param logger - Logger instance for service initialization logging.
 * @returns A `Services` bundle with all service implementations.
 */
export function createServiceRegistry(config: MulderConfig, logger: Logger): Services {
	const mode = resolveServiceMode(config);

	logger.info({ mode }, 'Initializing service registry');

	if (mode === 'dev') {
		return createDevServices(config, logger);
	}

	return createGcpServices(config, logger);
}
