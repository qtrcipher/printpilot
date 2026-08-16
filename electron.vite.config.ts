import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: 'src/main/index.ts' },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts', // shell renderer bridge
          webview: 'src/preload/webview.ts', // guest nav-layer injection
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: 'src/renderer/index.html' },
    },
  },
});
