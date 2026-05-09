import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8080';

	return {
		plugins: [react(), tailwindcss()],
		build: {
			rollupOptions: {
				output: {
					manualChunks(id) {
						const normalizedId = id.replaceAll('\\', '/');

						if (!normalizedId.includes('/node_modules/')) {
							return undefined;
						}

						if (normalizedId.includes('/pdfjs-dist/') || normalizedId.includes('/react-pdf/')) {
							return 'pdf-viewer';
						}

						if (
							normalizedId.includes('/react-markdown/') ||
							normalizedId.includes('/remark-') ||
							normalizedId.includes('/rehype-') ||
							normalizedId.includes('/micromark') ||
							normalizedId.includes('/unified/') ||
							normalizedId.includes('/mdast-util-') ||
							normalizedId.includes('/hast-util-') ||
							normalizedId.includes('/unist-util-')
						) {
							return 'markdown';
						}

						if (normalizedId.includes('/@tanstack/react-query/')) {
							return 'query';
						}

						if (normalizedId.includes('/framer-motion/')) {
							return 'motion';
						}

						if (normalizedId.includes('/lucide-react/')) {
							return 'icons';
						}

						if (
							normalizedId.includes('/react/') ||
							normalizedId.includes('/react-dom/') ||
							normalizedId.includes('/react-router-dom/') ||
							normalizedId.includes('/@remix-run/router/') ||
							normalizedId.includes('/scheduler/')
						) {
							return 'react';
						}

						return 'vendor';
					},
				},
			},
		},
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
