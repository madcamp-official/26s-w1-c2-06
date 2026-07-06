import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // 배포 시엔 Django가 STATIC_URL(/static/) 아래로 서빙하므로 빌드 산출물의
  // 에셋 경로도 그에 맞춰야 한다. dev 서버(Vite)는 그대로 루트에서 서빙.
  base: command === 'build' ? '/static/' : '/',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
}))
