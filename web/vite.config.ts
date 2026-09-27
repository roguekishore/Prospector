import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * One config, two apps. `--mode lead` or `--mode prospect` picks the app:
 *
 *   root      web/<app>/            (its index.html is the entry)
 *   outDir    web/dist/<app>/       (what src/server and src/control serve)
 *   proxy     /api and /shots → the matching Fastify server, so `vite dev`
 *             runs against the real routes with no CORS and no mock layer.
 *
 * Assets land under /assets/ with a content hash in the name, which is what
 * lets the servers mark them immutable (src/server/static.js).
 */
const APPS = {
  lead:     { port: 5177, upstream: 'http://127.0.0.1:7777', proxy: ['/api', '/shots'] },
  prospect: { port: 5178, upstream: 'http://127.0.0.1:7778', proxy: ['/api'] },
} as const;

type AppName = keyof typeof APPS;

export default defineConfig(({ mode }) => {
  if (!(mode in APPS)) {
    throw new Error(`unknown app "${mode}": use --mode lead or --mode prospect`);
  }
  const app = mode as AppName;
  const cfg = APPS[app];
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

  const proxy: Record<string, { target: string; changeOrigin: boolean }> = {};
  for (const prefix of cfg.proxy) proxy[prefix] = { target: cfg.upstream, changeOrigin: false };

  return {
    root: here(`./${app}`),
    // `mode` is only the app selector here; every build is a production build.
    mode: 'production',
    envDir: here('.'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@ui': here('./ui') },
    },
    server: {
      port: cfg.port,
      strictPort: true,
      host: '127.0.0.1',
      proxy,
    },
    preview: { port: cfg.port, strictPort: true, host: '127.0.0.1', proxy },
    build: {
      outDir: here(`./dist/${app}`),
      emptyOutDir: true,
      sourcemap: false,
      target: 'es2022',
      assetsDir: 'assets',
      modulePreload: { polyfill: false },
    },
  };
});
