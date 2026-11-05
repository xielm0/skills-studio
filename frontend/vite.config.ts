import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 渲染层产物由 backend 打包嵌入（tec.md §4）；Electron 以 file:// 加载，需要相对 base
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: {
    port: 5173,
    strictPort: true,
    // IPC 契约与主进程共用 backend/src/shared/ipc.ts（渲染层仅引用类型与常量）
    fs: { allow: ['..'] },
  },
});
