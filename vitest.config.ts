import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
		fileParallelism: false,
		testTimeout: 180_000,
		hookTimeout: 120_000,
		env: {
			NODE_ENV: 'test',
			PGHOST: 'localhost',
			PGPORT: '5432',
			PGUSER: 'mulder',
			PGPASSWORD: 'mulder',
			PGDATABASE: 'mulder',
			FIRESTORE_EMULATOR_HOST: 'localhost:8080',
		},
	},
});
