import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
		globalSetup: ['./scripts/ensure-cli-test-artifacts.mjs'],
		fileParallelism: false,
		testTimeout: 180_000,
		hookTimeout: 120_000,
		env: {
			NODE_ENV: 'test',
			PGHOST: process.env.PGHOST ?? 'localhost',
			PGPORT: process.env.PGPORT ?? '5432',
			PGUSER: process.env.PGUSER ?? 'mulder',
			PGPASSWORD: process.env.PGPASSWORD ?? 'mulder',
			PGDATABASE: process.env.PGDATABASE ?? 'mulder',
			FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST ?? 'localhost:8080',
		},
	},
});
