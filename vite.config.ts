import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';

/** When this build was made (local time), e.g. "2026-11-04 10:45": shown in the connection details and sent with every report. */
const pad = (n: number) => String(n).padStart(2, '0');
const now = new Date();
const BUILD = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

export default defineConfig({
  plugins: [
    svelte(),
    tailwindcss(),
    cloudflare(),
    // Installable, and repeat visits load instantly from the cache (even on a weak network).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      manifest: {
        name: 'Dline',
        short_name: 'Dline',
        description: 'Peer-to-peer video calls and full-quality photo and video sharing.',
        theme_color: '#1B1B3A',
        background_color: '#1B1B3A',
        display: 'standalone',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}', '**/overpass-latin-wght-*.woff2'],
        // The signaling socket must always reach the Worker, never the cache.
        navigateFallbackDenylist: [/^\/ws\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: { target: 'es2022' },
  define: { 'import.meta.env.VITE_BUILD': JSON.stringify(BUILD) },
});
