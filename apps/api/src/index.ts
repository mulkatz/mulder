#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createLogger } from '@mulder/core';
import { createApp } from './app.js';

export const DEFAULT_API_PORT = 8080;

export function resolveApiPort(): number {
	const rawPort = process.env.MULDER_API_PORT ?? process.env.PORT ?? '';
	const parsedPort = Number.parseInt(rawPort, 10);

	if (Number.isInteger(parsedPort) && parsedPort > 0) {
		return parsedPort;
	}

	return DEFAULT_API_PORT;
}

export function startApiServer(): ReturnType<typeof serve> {
	const logger = createLogger();
	const app = createApp({ logger });
	const port = resolveApiPort();
	const server = serve({ fetch: app.fetch, port });

	logger.info({ port }, 'API server started');

	process.once('SIGTERM', () => {
		server.close();
	});

	process.once('SIGINT', () => {
		server.close();
	});

	return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	startApiServer();
}

export { createApp } from './app.js';
