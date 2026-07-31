import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchWorkingTree, type WorkingTreeWatcher } from './watch.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// Regression coverage for a leak confirmed live: chokidar 4 dropped glob
// support (its string matcher is a plain `===` check — see watch.ts's own
// comment), so the ORIGINAL `ignored: ['**/.git/**', '**/node_modules/**']`
// silently excluded nothing. A repo with a `.worktrees/`-style convention
// (a gitignored directory holding full nested checkouts, each with its own
// node_modules) sent the watcher's native handle count into the hundreds
// of thousands. These tests assert the OBSERVABLE behavior the fix must
// produce — changes inside a gitignored directory never fire onChange —
// rather than reaching into chokidar's internals, so they'd fail the same
// way production did if the exclusion regresses to a no-op again.
describe('watchWorkingTree', () => {
  let dir: string;
  let watcher: WorkingTreeWatcher | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-watch-test-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('fires onChange for an edit to a normal tracked file', async () => {
    const changes: string[] = [];
    watcher = await watchWorkingTree(dir, () => changes.push('changed'), 50);
    // chokidar's initial recursive scan runs in the background after
    // watch() returns — give it time to actually register tracked.ts's
    // watch before editing it, or the write can race the scan and be missed.
    await new Promise((r) => setTimeout(r, 1000));

    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 2;\n');
    await new Promise((r) => setTimeout(r, 1500));

    expect(changes.length).toBeGreaterThan(0);
  });

  it('never fires onChange for edits inside a git-ignored directory (the .worktrees case)', async () => {
    writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'add gitignore');

    const nested = join(dir, '.worktrees', 'issue-1');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'file.ts'), 'export const y = 1;\n');

    const changes: string[] = [];
    watcher = await watchWorkingTree(dir, () => changes.push('changed'), 50);
    await new Promise((r) => setTimeout(r, 1000));

    // Edit a file already inside the ignored tree, and add a brand new one —
    // covers both "already present at watch setup" and "created after".
    writeFileSync(join(nested, 'file.ts'), 'export const y = 2;\n');
    writeFileSync(join(nested, 'new-file.ts'), 'export const z = 1;\n');
    await new Promise((r) => setTimeout(r, 1500));

    expect(changes).toEqual([]);
  });

  it('still fires onChange for a real tracked-file edit alongside a large ignored sibling directory', async () => {
    // Mirrors production scale loosely: a gitignored directory with many
    // files sitting next to the tracked content actually being watched.
    writeFileSync(join(dir, '.gitignore'), 'heavy/\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'add gitignore');

    const heavy = join(dir, 'heavy');
    mkdirSync(heavy, { recursive: true });
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(heavy, `f${i}.txt`), `content ${i}\n`);
    }

    const changes: string[] = [];
    watcher = await watchWorkingTree(dir, () => changes.push('changed'), 50);
    await new Promise((r) => setTimeout(r, 1000));

    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 3;\n');
    await new Promise((r) => setTimeout(r, 1500));

    expect(changes.length).toBeGreaterThan(0);
  });
});
