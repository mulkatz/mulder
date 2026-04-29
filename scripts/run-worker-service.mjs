#!/usr/bin/env node

import { createServer } from 'node:http';
import { closeAllPools, createLogger, createServiceRegistry, getWorkerPool, loadConfig } from '@mulder/core';
import { createWorkerId, startWorker } from '@mulder/worker';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const concurrency = Number.parseInt(process.env.MULDER_WORKER_CONCURRENCY ?? '1', 10);
const pollIntervalMs = Number.parseInt(process.env.MULDER_WORKER_POLL_INTERVAL_MS ?? '5000', 10);
const logger = createLogger();
const controller = new AbortController();

let ready = false;
let workerError = null;

const server = createServer((request, response) => {
	if (request.url === '/health') {
		const healthy = ready && !workerError;
		response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
		response.end(
			JSON.stringify({
				status: healthy ? 'ok' : 'starting',
				worker_error: workerError instanceof Error ? workerError.message : null,
			}),
		);
		return;
	}

	response.writeHead(404, { 'Content-Type': 'application/json' });
	response.end(JSON.stringify({ error: 'not_found' }));
});

function shutdown(signal) {
	logger.info({ signal }, 'worker service shutting down');
	controller.abort();
	server.close(() => {
		closeAllPools()
			.catch((error) => logger.warn({ error }, 'failed to close pools cleanly'))
			.finally(() => process.exit(0));
	});
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

server.listen(port, () => {
	logger.info({ port }, 'worker health server started');
});

try {
	const config = loadConfig();
	if (!config.gcp) {
		throw new Error('GCP configuration with cloud_sql is required for the worker service');
	}

	const services = createServiceRegistry(config, logger);
	const pool = getWorkerPool(config.gcp.cloud_sql);
	const workerId = createWorkerId();
	ready = true;

	const result = await startWorker(
		{
			config,
			services,
			pool,
			logger,
		},
		{
			workerId,
			concurrency,
			pollIntervalMs,
			abortSignal: controller.signal,
		},
	);

	logger.info(result, 'worker stopped cleanly');
} catch (error) {
	workerError = error;
	logger.error({ error }, 'worker service failed');
	process.exitCode = 1;
	controller.abort();
}
