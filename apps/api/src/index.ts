#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { type ApiConfig, CONFIG_DEFAULTS, createLogger, loadConfig } from '@mulder/core';
import { createApp } from './app.js';

export const DEFAULT_API_PORT = 8080;

export function resolveApiPort(config?: ApiConfig): number {
	const rawPort = process.env.MULDER_API_PORT ?? process.env.PORT ?? '';
	const parsedPort = Number.parseInt(rawPort, 10);

	if (Number.isInteger(parsedPort) && parsedPort > 0) {
		return parsedPort;
	}

	const fromConfig = config?.port;
	if (typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0) {
		return fromConfig;
	}

	return DEFAULT_API_PORT;
}

function resolveRuntimeApiConfig(): ApiConfig {
	const configPath = process.env.MULDER_CONFIG ?? 'mulder.config.yaml';

	if (existsSync(configPath)) {
		return loadConfig(configPath).api;
	}

	return CONFIG_DEFAULTS.api;
}

export function startApiServer(): ReturnType<typeof serve> {
	const logger = createLogger();
	const apiConfig = resolveRuntimeApiConfig();
	const app = createApp({ logger, config: apiConfig });
	const port = resolveApiPort(apiConfig);
	const server = serve({ fetch: app.fetch, port });
	let shuttingDown = false;

	logger.info({ port }, 'API server started');

	function shutdown(signal: NodeJS.Signals) {
		if (shuttingDown) {
			return;
		}

		shuttingDown = true;
		logger.info({ signal }, 'API server shutting down');
		server.close(() => {
			process.exit(0);
		});
		setTimeout(() => process.exit(0), 3000).unref();
	}

	process.once('SIGTERM', shutdown);
	process.once('SIGINT', shutdown);

	return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	startApiServer();
}

export { createApp } from './app.js';
