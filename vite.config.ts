import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { velaManualDismissalPlugin } from './scripts/velaDismissalPatch.mjs';

const packageLock = JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url), 'utf8'));
const lockedPackages = packageLock.packages;

export default defineConfig({
  define: {
    __OMEGA_DEPENDENCY_VERSIONS__: JSON.stringify({
      pinets: lockedPackages['node_modules/pinets'].version,
      vela: lockedPackages['node_modules/@luxalgo/vela'].version,
      velaPinets: lockedPackages['node_modules/@luxalgo/vela-pinets'].version,
    }),
  },
  plugins: [velaManualDismissalPlugin()],
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        pineEditor: fileURLToPath(new URL('./pine-editor.html', import.meta.url)),
        visualBacktest: fileURLToPath(new URL('./visual-backtest.html', import.meta.url)),
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
        },
      },
    },
  },
});
