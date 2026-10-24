import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        waiter: resolve(__dirname, 'waiter.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
        admin: resolve(__dirname, 'admin.html'),
        diner: resolve(__dirname, 'diner.html'),
        station: resolve(__dirname, 'station.html'),
        owner: resolve(__dirname, 'owner.html'),
        reserve: resolve(__dirname, 'reserve.html'),
        ops: resolve(__dirname, 'ops.html'),
      },
    },
  },
  server: {
    port: 3000,
    host: true,
    allowedHosts: true,
    // The booking page and the operator console talk to the operator service, which serves them in production; in development it is somewhere else.
    proxy: {
      '/public/booking': process.env.OPERATOR_DEV_URL || 'http://localhost:4500',
      '/ops/api': process.env.OPERATOR_DEV_URL || 'http://localhost:4500'
    }
  }
});

