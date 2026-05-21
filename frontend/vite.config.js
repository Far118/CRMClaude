import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        login:        resolve(__dirname, 'login.html'),
        index:        resolve(__dirname, 'index.html'),
        companies:    resolve(__dirname, 'companies.html'),
        company:      resolve(__dirname, 'company.html'),
        request:      resolve(__dirname, 'request.html'),
        requests:     resolve(__dirname, 'requests.html'),
        activities:   resolve(__dirname, 'activities.html'),
        plans:        resolve(__dirname, 'plans.html'),
        reports:      resolve(__dirname, 'reports.html'),
        ai_reports:   resolve(__dirname, 'ai-reports.html'),
        team:         resolve(__dirname, 'team.html'),
        admin_users:  resolve(__dirname, 'admin/users.html'),
        settings:     resolve(__dirname, 'settings/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
