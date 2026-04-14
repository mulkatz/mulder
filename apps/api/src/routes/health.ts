import type { Hono } from 'hono';

export const API_VERSION = '0.0.0';

export type HealthResponse = {
	status: 'ok';
	version: string;
};

export function getHealthResponse(): HealthResponse {
	return {
		status: 'ok',
		version: API_VERSION,
	};
}

export function registerHealthRoute(app: Hono): void {
	app.get('/api/health', (c) => c.json(getHealthResponse(), 200));
}
