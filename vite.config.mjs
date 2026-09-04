import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/app.[ext]',
        inlineDynamicImports: true,
      },
    },
  },
});
