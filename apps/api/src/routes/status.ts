import type { Hono } from 'hono';
import { getApiStatus } from '../lib/status.js';
import { StatusResponseSchema } from './status.schemas.js';

export function registerStatusRoute(app: Hono): void {
	app.get('/api/status', async (c) => {
		const response = await getApiStatus();
		StatusResponseSchema.parse(response);
		return c.json(response, 200);
	});
}
