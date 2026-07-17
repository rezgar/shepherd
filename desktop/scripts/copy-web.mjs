// Copy the built web UI (web/dist) into desktop/build/web so electron-builder
// can ship it under the packaged app's resources (loaded via file://).
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const src = path.join(repoRoot, 'web', 'dist');
const dest = path.join(here, '..', 'build', 'web');

await rm(dest, { recursive: true, force: true });
await cp(src, dest, { recursive: true });
console.log('copied web/dist → desktop/build/web');
