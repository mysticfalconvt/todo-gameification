import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'

// Source-map upload to Bugsink is opt-in: only wired when a build-time auth
// token + project slug are present (set them in the Coolify build env, not in
// the committed .env). Without them, builds are byte-for-byte what they were
// before — no source maps emitted, no plugin, no upload. Bugsink matches
// frames to sources by the debug ID the plugin injects into both the bundle
// and its map, so no release/version coordination is needed.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN
const sentryProject = process.env.SENTRY_PROJECT
const uploadSourcemaps = Boolean(sentryAuthToken && sentryProject)

export default defineConfig({
  server: {
    port: 3000,
  },
  build: {
    // 'hidden' generates maps but omits the //# sourceMappingURL comment, so
    // the deployed JS doesn't advertise them. The plugin uploads them, then
    // deletes them from the output so nothing ships publicly.
    sourcemap: uploadSourcemaps ? 'hidden' : false,
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
    // Must come last so it sees the final emitted chunks. No-op unless the
    // upload env vars are set.
    ...(uploadSourcemaps
      ? [
          sentryVitePlugin({
            url: process.env.SENTRY_URL || 'https://bugsink.rboskind.com/',
            org: process.env.SENTRY_ORG || 'bugsink',
            project: sentryProject,
            authToken: sentryAuthToken,
            telemetry: false,
            sourcemaps: {
              filesToDeleteAfterUpload: ['./.output/**/*.map'],
            },
          }),
        ]
      : []),
  ],
})
