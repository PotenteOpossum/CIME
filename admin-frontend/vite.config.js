import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const config = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react()],
    base: config.VITE_BASE_PATH || '/',
    server: { host: '127.0.0.1', port: 5174, strictPort: true }
  };
});
