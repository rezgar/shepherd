import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchWorkingTree } from '../vendor/askdiff/server/util/watch.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// Regression coverage for #89: this repo's own dev worktrees live nested
// inside it (`.worktrees/`, `.claude/worktrees/`) and are gitignored —
// each one a full copy of the source tree. The vendored working-tree
// watcher only excluded literal `.git`/`node_modules` (and, on chokidar
// v4, those glob strings never matched anything at all — v4 dropped glob
// support from `ignored` in favor of RegExp/function/`{path,recursive}`
// matchers), so it recursively watched every nested worktree too. On a
// real repo that inflated a single watch to ~19,000 native directory-watch
// handles that persisted even after `close()` — confirmed live, and the
// proximate cause of the daemon crash this issue fixes. A watcher that
// still descends into gitignored subtrees would reintroduce that blowup
// on any repo shaped this way, so this asserts the exclusion holds
// behaviorally: changes inside a gitignored directory are never reported.
describe('watchWorkingTree — gitignored subtrees', () => {
  let dir: string;
  let watcher: { close: () => Promise<void> } | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-watch-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, '.gitignore'), 'ignored-dir/\n');
    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;\n');
    git(dir, 'add', '.gitignore', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');
    mkdirSync(join(dir, 'ignored-dir'));
    writeFileSync(join(dir, 'ignored-dir', 'seed.txt'), 'seed\n');
  });

  afterEach(async () => {
    await watcher?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never reports changes inside a gitignored directory', async () => {
    const changes: number[] = [];
    watcher = watchWorkingTree(dir, () => changes.push(Date.now()), 50);
    // Let chokidar's initial recursive scan settle before triggering a
    // change — writes made before it's ready can be missed regardless of
    // ignore filtering, which would make this assertion pass for the
    // wrong reason. The companion test below proves the watcher really is
    // live by this point (a real, non-ignored change IS detected).
    await new Promise((r) => setTimeout(r, 500));

    writeFileSync(join(dir, 'ignored-dir', 'new-file.txt'), 'new content\n');
    await new Promise((r) => setTimeout(r, 500));

    expect(changes).toHaveLength(0);
  });

  it('still reports changes to real (non-ignored) files', async () => {
    const changes: number[] = [];
    watcher = watchWorkingTree(dir, () => changes.push(Date.now()), 50);
    await new Promise((r) => setTimeout(r, 500));

    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 2;\n');
    await new Promise((r) => setTimeout(r, 500));

    expect(changes.length).toBeGreaterThan(0);
  });
});
