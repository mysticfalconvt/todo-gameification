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
    //
    // This only covers the CLIENT build — nitro's server build is configured
    // separately below. Getting one without the other is what left every
    // uploaded artifact as "no sourcemap found".
    sourcemap: uploadSourcemaps ? 'hidden' : false,
  },
  // Register the startup plugin that boots pg-boss on process start so the
  // cron schedulers (weekly summary, plant risk, github poll, cleanup) are
  // always live — not lazily booted by the first job-scheduling request.
  // See src/server/nitro/bootJobs.ts.
  nitro: {
    // Server-side source maps. The key is `sourcemap` (lowercase m) — nitro
    // silently ignores `sourceMap`, which is an easy hour to lose. Without
    // this the server bundles ship with no maps at all, so @sentry/node stack
    // traces in Bugsink stay minified.
    //
    // `true` rather than 'hidden' because nitro types this as boolean (the
    // beta's types lag its runtime, which does accept 'hidden'). The
    // difference is only whether a //# sourceMappingURL comment is emitted,
    // and these .mjs files are never served to a browser — nothing to leak.
    // The maps are deleted after upload either way.
    sourcemap: uploadSourcemaps,
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
              // Be explicit about what to scan. Left to auto-detect, the
              // plugin only saw the server pass it runs in and uploaded 212
              // server bundles with zero maps, while the 54 client maps —
              // the ones that symbolicate browser stack traces — were never
              // uploaded at all.
              assets: ['./.output/public/**/*.js', './.output/server/**/*.mjs'],
              filesToDeleteAfterUpload: ['./.output/**/*.map'],
            },
          }),
        ]
      : []),
  ],
})
