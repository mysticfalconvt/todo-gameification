import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  server: {
    port: 3000,
  },
  // Register the startup plugin that boots pg-boss on process start so the
  // cron schedulers (weekly summary, plant risk, github poll, cleanup) are
  // always live — not lazily booted by the first job-scheduling request.
  // See src/server/nitro/bootJobs.ts.
  nitro: {
    plugins: [
      // Sentry/Bugsink first so error tracking is live before jobs boot.
      './src/server/nitro/sentry.ts',
      './src/server/nitro/bootJobs.ts',
    ],
  },
  plugins: [
    tailwindcss(),
    tanstackStart({ srcDirectory: 'src' }),
    viteReact(),
    nitro(),
  ],
})
