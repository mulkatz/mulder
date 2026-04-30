import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8080';

	return {
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: {
				'@': path.resolve(__dirname, './src'),
			},
		},
		server: {
			port: 5174,
			proxy: {
				'/api': {
					target: apiTarget,
					changeOrigin: true,
					cookieDomainRewrite: 'localhost',
				},
			},
		},
	};
});
