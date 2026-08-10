// Points git at .githooks so the pre-push gate is live for developers.
//
// Runs from the `prepare` script, which pnpm executes on EVERY install —
// including the Coolify/Nixpacks build container, which copies the source
// without a .git directory. `git config` exits 128 there, and because
// `prepare` failing fails the whole install, that took the deploy down.
//
// So: never fail. A missing git dir, or no git binary at all, is a normal
// state for a build image, not an error worth stopping an install over.
import { execFileSync } from 'node:child_process'

function run(args) {
  return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
}

try {
  // rev-parse is the cheap, reliable "am I in a working tree?" probe. It
  // throws both when git is absent and when there's no repo here.
  if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    process.exit(0)
  }
  run(['config', 'core.hooksPath', '.githooks'])
  console.log('[hooks] pre-push gate enabled (core.hooksPath=.githooks)')
} catch {
  // No repo / no git — a build container. Nothing to install, nothing wrong.
  console.log('[hooks] no git work tree; skipping hook setup')
}
