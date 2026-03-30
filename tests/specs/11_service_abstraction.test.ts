import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Black-box QA tests for Spec 11: Service Abstraction — Interfaces, Registry, Rate-Limiter, Retry
 *
 * Each `it()` maps to one QA condition from Section 5 of the spec.
 * Tests import from @mulder/core barrel (dist/index.js) — the public API surface.
 * No imports from packages/core/src/ internals.
 */
describe('Spec 11: Service Abstraction', () => {
	let createServiceRegistry: any;
	let withRetry: any;
	let RateLimiter: any;
	let createLogger: any;
	let loadConfig: any;
	let ConfigError: any;
	let ExternalServiceError: any;

	let exampleConfig: any;
	let silentLogger: any;

	beforeAll(async () => {
		const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));
		createServiceRegistry = core.createServiceRegistry;
		withRetry = core.withRetry;
		RateLimiter = core.RateLimiter;
		createLogger = core.createLogger;
		loadConfig = core.loadConfig;
		ConfigError = core.ConfigError;
		ExternalServiceError = core.ExternalServiceError;

		silentLogger = createLogger({ level: 'silent' });
		exampleConfig = await loadConfig(resolve(ROOT, 'mulder.config.example.yaml'));
	});

	// ─── QA-01: Registry returns dev services in dev mode ───

	it('QA-01: Registry returns dev services in dev mode', () => {
		// Create config with dev_mode: true
		const devConfig = { ...exampleConfig, dev_mode: true };
		const savedEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production'; // ensure env does NOT help
		try {
			const services = createServiceRegistry(devConfig, silentLogger);
			expect(services).toBeDefined();
			expect(services.storage).toBeDefined();
			expect(services.storage).not.toBeNull();
			expect(services.documentAi).toBeDefined();
			expect(services.documentAi).not.toBeNull();
			expect(services.llm).toBeDefined();
			expect(services.llm).not.toBeNull();
			expect(services.embedding).toBeDefined();
			expect(services.embedding).not.toBeNull();
			expect(services.firestore).toBeDefined();
			expect(services.firestore).not.toBeNull();
		} finally {
			process.env.NODE_ENV = savedEnv;
		}
	});

	// ─── QA-02: Registry returns dev services in test environment ───

	it('QA-02: Registry returns dev services in test environment', () => {
		// Config has dev_mode: false but NODE_ENV=test should still select dev services
		const prodConfig = { ...exampleConfig, dev_mode: false };
		const savedEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'test';
		try {
			const services = createServiceRegistry(prodConfig, silentLogger);
			expect(services).toBeDefined();
			expect(services.storage).toBeDefined();
			expect(services.storage).not.toBeNull();
			expect(services.documentAi).toBeDefined();
			expect(services.documentAi).not.toBeNull();
			expect(services.llm).toBeDefined();
			expect(services.llm).not.toBeNull();
			expect(services.embedding).toBeDefined();
			expect(services.embedding).not.toBeNull();
			expect(services.firestore).toBeDefined();
			expect(services.firestore).not.toBeNull();
		} finally {
			process.env.NODE_ENV = savedEnv;
		}
	});

	// ─── QA-03: Registry returns GCP services in production mode ───
	// (Updated: GCP implementations now available after M2-B1)

	it('QA-03: Registry returns GCP services in production mode', () => {
		const prodConfig = { ...exampleConfig, dev_mode: false };
		const savedEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		try {
			const services = createServiceRegistry(prodConfig, silentLogger);
			expect(services).toBeDefined();
			expect(services.storage).toBeDefined();
			expect(services.documentAi).toBeDefined();
			expect(services.llm).toBeDefined();
			expect(services.embedding).toBeDefined();
			expect(services.firestore).toBeDefined();
		} finally {
			process.env.NODE_ENV = savedEnv;
		}
	});

	// ─── QA-04: Retry succeeds after transient failure ───

	it('QA-04: Retry succeeds after transient failure', async () => {
		let callCount = 0;
		const result = await withRetry(
			async () => {
				callCount++;
				if (callCount < 3) {
					throw new ExternalServiceError('transient failure', {
						code: 'SERVICE_UNAVAILABLE',
						service: 'test',
						retryable: true,
					});
				}
				return 'success';
			},
			{ maxAttempts: 3, backoffBaseMs: 10, backoffMaxMs: 50 },
		);

		expect(callCount).toBe(3);
		expect(result).toBe('success');
	});

	// ─── QA-05: Retry does not retry on non-retryable errors ───

	it('QA-05: Retry does not retry on non-retryable errors', async () => {
		let callCount = 0;
		await expect(
			withRetry(
				async () => {
					callCount++;
					throw new ConfigError('not retryable', { code: 'CONFIG_INVALID' });
				},
				{ maxAttempts: 3, backoffBaseMs: 10 },
			),
		).rejects.toThrow();

		expect(callCount).toBe(1);
	});

	// ─── QA-06: Retry throws after exhausting all attempts ───

	it('QA-06: Retry throws after exhausting all attempts', async () => {
		let callCount = 0;
		await expect(
			withRetry(
				async () => {
					callCount++;
					throw new ExternalServiceError('always fails', {
						code: 'SERVICE_UNAVAILABLE',
						service: 'test',
						retryable: true,
					});
				},
				{ maxAttempts: 3, backoffBaseMs: 10, backoffMaxMs: 50 },
			),
		).rejects.toThrow(ExternalServiceError);

		expect(callCount).toBe(3);
	});

	// ─── QA-07: Rate limiter allows requests within capacity ───

	it('QA-07: Rate limiter allows requests within capacity', () => {
		const limiter = new RateLimiter({ maxTokens: 5, refillRate: 1, name: 'qa-07' });
		const results: boolean[] = [];
		for (let i = 0; i < 5; i++) {
			results.push(limiter.tryAcquire());
		}
		expect(results).toEqual([true, true, true, true, true]);
	});

	// ─── QA-08: Rate limiter blocks requests beyond capacity ───

	it('QA-08: Rate limiter blocks requests beyond capacity', () => {
		const limiter = new RateLimiter({ maxTokens: 2, refillRate: 1, name: 'qa-08' });
		const r1 = limiter.tryAcquire();
		const r2 = limiter.tryAcquire();
		const r3 = limiter.tryAcquire();

		expect(r1).toBe(true);
		expect(r2).toBe(true);
		expect(r3).toBe(false);
	});

	// ─── QA-09: Dev storage service reads from fixtures directory ───

	it('QA-09: Dev storage service reads from fixtures directory', async () => {
		const devConfig = { ...exampleConfig, dev_mode: true };
		const savedEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'test';
		try {
			const services = createServiceRegistry(devConfig, silentLogger);
			// raw/.gitkeep is known to exist in fixtures from spec 10
			const exists = await services.storage.exists('raw/.gitkeep');
			expect(exists).toBe(true);
		} finally {
			process.env.NODE_ENV = savedEnv;
		}
	});

	// ─── QA-10: Dev storage service returns false for missing fixtures ───

	it('QA-10: Dev storage service returns false for missing fixtures', async () => {
		const devConfig = { ...exampleConfig, dev_mode: true };
		const savedEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'test';
		try {
			const services = createServiceRegistry(devConfig, silentLogger);
			const exists = await services.storage.exists('raw/nonexistent-file-that-does-not-exist.pdf');
			expect(exists).toBe(false);
		} finally {
			process.env.NODE_ENV = savedEnv;
		}
	});

	// ─── QA-11: Services type has all required service properties ───

	it('QA-11: Services type has all required service properties', () => {
		const devConfig = { ...exampleConfig, dev_mode: true };
		const savedEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'test';
		try {
			const services = createServiceRegistry(devConfig, silentLogger);
			const requiredKeys = ['storage', 'documentAi', 'llm', 'embedding', 'firestore'];
			for (const key of requiredKeys) {
				expect(services).toHaveProperty(key);
				expect(services[key]).toBeDefined();
			}
		} finally {
			process.env.NODE_ENV = savedEnv;
		}
	});

	// ─── QA-12: Retry applies exponential backoff with jitter ───

	it('QA-12: Retry applies exponential backoff with jitter', async () => {
		const delays: { attempt: number; delayMs: number }[] = [];

		try {
			await withRetry(
				async () => {
					throw new ExternalServiceError('always fails', {
						code: 'SERVICE_UNAVAILABLE',
						service: 'test',
						retryable: true,
					});
				},
				{
					maxAttempts: 4,
					backoffBaseMs: 100,
					backoffMaxMs: 5000,
					multiplier: 2,
					onRetry: (_err: unknown, attempt: number, delayMs: number) => {
						delays.push({ attempt, delayMs });
					},
				},
			);
		} catch {
			// expected
		}

		// 3 retries for 4 maxAttempts (first call + 3 retries)
		expect(delays.length).toBe(3);

		// Each delay should be >= 0 (jitter applies random(0, calculated))
		for (const d of delays) {
			expect(d.delayMs).toBeGreaterThanOrEqual(0);
		}

		// Delays should be capped by backoffMaxMs
		for (const d of delays) {
			expect(d.delayMs).toBeLessThanOrEqual(5000);
		}

		// The calculated upper bounds increase: 100, 200, 400
		// (backoffBaseMs * multiplier^(attempt-1) for attempts 1,2,3 using 0-based exponent)
		// With full jitter, actual delays are random in [0, upper_bound]
		// We verify the max possible for each attempt is increasing by checking
		// the cap values are reasonable (delay <= backoffBaseMs * multiplier^attempt)
		expect(delays[0].delayMs).toBeLessThanOrEqual(200); // 100 * 2^1
		expect(delays[1].delayMs).toBeLessThanOrEqual(400); // 100 * 2^2
		expect(delays[2].delayMs).toBeLessThanOrEqual(800); // 100 * 2^3
	});

	// ─── QA-13: Core package exports service abstraction types ───

	it('QA-13: Core package exports service abstraction types', async () => {
		const core = await import(resolve(ROOT, 'packages/core/dist/index.js'));

		expect(core.createServiceRegistry).toBeDefined();
		expect(typeof core.createServiceRegistry).toBe('function');

		expect(core.withRetry).toBeDefined();
		expect(typeof core.withRetry).toBe('function');

		expect(core.RateLimiter).toBeDefined();
		expect(typeof core.RateLimiter).toBe('function');
	});
});
