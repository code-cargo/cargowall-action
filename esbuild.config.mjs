import * as esbuild from 'esbuild'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [major, minor] = pkg.version.split('.').map(Number)

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  define: {
    'CARGOWALL_ACTION_MAJOR': JSON.stringify(major),
    'CARGOWALL_ACTION_MINOR': JSON.stringify(minor),
  },
  // No --external: GitHub Actions requires self-contained dist/ (no npm install at runtime)
  // No --minify: keeps stack traces readable in Actions logs
  // No --sourcemap: not needed, adds significant size
}

await Promise.all([
  esbuild.build({ ...shared, entryPoints: ['src/main.ts'], outfile: 'dist/main/index.js' }),
  esbuild.build({ ...shared, entryPoints: ['src/post.ts'], outfile: 'dist/post/index.js' }),
  esbuild.build({ ...shared, entryPoints: ['src/watcher.ts'], outfile: 'dist/watcher/index.js' }),
])
