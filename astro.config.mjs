// @ts-check
import { defineConfig } from 'astro/config';
import { sessionDrivers } from 'astro/config';
import astroIcon from 'astro-icon';
import cloudflare from '@astrojs/cloudflare';
import { fileURLToPath } from 'node:url';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	build: {
		client: './',
		server: './_worker.js',
	},
	adapter: cloudflare(/** @type {any} */({
		imageService: 'compile',
		platformProxy: { enabled: true },
	})),
	session: {
		driver: sessionDrivers.lruCache(),
	},
	vite: {
		server: {
			allowedHosts: true,
			port: 4321,
			strictPort: true,
		},
		resolve: {
			alias: {
				debug: fileURLToPath(new URL('./src/lib/debug-shim.ts', import.meta.url)),
			},
		},
		ssr: {
			noExternal: ['debug'],
		},
	},
	integrations: [astroIcon()],
});
