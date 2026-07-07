import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
	plugins: [
		sveltekit(),
		VitePWA({
			strategies: 'injectManifest',
			srcDir: 'src',
			filename: 'sw.js',
			registerType: 'autoUpdate',
			// SvelteKit has no static index.html for vite-plugin-pwa to transform, so its
			// auto-injected registration never runs. Register manually in client code:
			//   if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
			injectRegister: false,
			injectManifest: {
				globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}']
			},
			manifest: {
				id: '/',
				name: 'ShareNote',
				short_name: 'ShareNote',
				description: 'Notes you write together — share, comment, contribute.',
				start_url: '/',
				scope: '/',
				display: 'standalone',
				orientation: 'portrait',
				background_color: '#0b1120',
				theme_color: '#0f766e',
				icons: [
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
					{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
					{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
				]
			}
		})
	]
});
