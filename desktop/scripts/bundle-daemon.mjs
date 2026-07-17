// Bundle the daemon (server/src/index.ts) into a single CJS file the packaged
// app runs with Electron's own Node runtime, and stage its native terminal
// backend (node-pty, aliased to the prebuilt N-API @lydell/node-pty) as real
// files so it loads at runtime with no compilation.
import { build } from 'esbuild';
import { cp, rm, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repoRoot = path.resolve(here, '..', '..');

// 1. Bundle the daemon. node-pty is native → external, resolved from the staged
//    node_modules below at runtime.
await build({
  entryPoints: [path.join(repoRoot, 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(desktop, 'build', 'daemon.cjs'),
  external: ['node-pty'],
  logLevel: 'info',
});
console.log('bundled daemon → desktop/build/daemon.cjs');

// 1b. Bundle the raw-transcript-parse worker (#71) as its own entry point —
//     worker_threads spawns it as a real file at runtime (rawParsePool.ts's
//     resolveWorkerPath), so it can't just live inside daemon.cjs's own
//     bundle. Staged as a sibling of daemon.cjs (extraResources in
//     package.json) so resolveWorkerPath's `path.join(__dirname,
//     'parseWorker.cjs')` finds it.
await build({
  entryPoints: [path.join(repoRoot, 'server', 'src', 'parseWorker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(desktop, 'build', 'parseWorker.cjs'),
  logLevel: 'info',
});
console.log('bundled parse worker → desktop/build/parseWorker.cjs');

// 2. Stage node-pty + its installed platform prebuilt into build/daemon-modules,
//    which electron-builder ships as the daemon's node_modules (extraResources).
const modsDir = path.join(desktop, 'build', 'daemon-modules');
await rm(modsDir, { recursive: true, force: true });

/** Copy a package's own files (excluding its nested node_modules) to dest. The
 *  filter checks the path RELATIVE to the package root — the pnpm store path
 *  itself contains `node_modules`, so an absolute check would exclude everything. */
async function copyPkg(pkgJsonPath, destDir) {
  const srcRoot = path.dirname(pkgJsonPath);
  await cp(srcRoot, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => !path.relative(srcRoot, src).split(path.sep).includes('node_modules'),
  });
}

// node-pty is aliased to @lydell/node-pty; resolve the real store dir (past the
// pnpm symlink) and stage it under the folder name the daemon requires ('node-pty').
const realNodePty = await realpath(path.join(desktop, 'node_modules', 'node-pty'));
const meta = JSON.parse(await readFile(path.join(realNodePty, 'package.json'), 'utf8'));
await copyPkg(path.join(realNodePty, 'package.json'), path.join(modsDir, 'node-pty'));
console.log('staged node-pty (→ @lydell/node-pty)');

// The prebuilt binary lives in a per-platform optional dep; pnpm places it as a
// sibling of node-pty in the same store scope. Only the current platform's is
// installed — stage whichever exist.
const scopeDir = path.dirname(realNodePty); // .../node_modules/@lydell
for (const dep of Object.keys(meta.optionalDependencies ?? {})) {
  const parts = dep.split('/');
  const depDir = path.join(scopeDir, parts[parts.length - 1]);
  if (!existsSync(path.join(depDir, 'package.json'))) continue; // not this platform
  await copyPkg(path.join(depDir, 'package.json'), path.join(modsDir, ...parts));
  console.log('staged prebuilt binary:', dep);
}
console.log('staged daemon node_modules → desktop/build/daemon-modules');
