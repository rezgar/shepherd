// Bundle the daemon (server/src/index.ts) into a single CJS file the packaged
// app runs with Electron's own Node runtime. node-pty is native, so it's left
// external and shipped alongside as a real node_modules (see extraResources).
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

await build({
  entryPoints: [path.join(repoRoot, 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(here, '..', 'build', 'daemon.cjs'),
  external: ['node-pty'],
  logLevel: 'info',
});
console.log('bundled daemon → desktop/build/daemon.cjs');
