import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDiffStat } from './diffStat.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

describe('computeDiffStat', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-diffstat-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a directory that is not a git repository', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'shepherd-diffstat-nonrepo-'));
    try {
      expect(await computeDiffStat(notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('returns {added: 0, removed: 0} for a clean tree with commits', async () => {
    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');

    expect(await computeDiffStat(dir)).toEqual({ added: 0, removed: 0 });
  });

  it('counts a modification to a tracked file', async () => {
    writeFileSync(join(dir, 'tracked.ts'), 'line one\nline two\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');

    writeFileSync(join(dir, 'tracked.ts'), 'line one changed\nline two\nline three\n');

    expect(await computeDiffStat(dir)).toEqual({ added: 2, removed: 1 });
  });

  it('counts an untracked file entirely as additions', async () => {
    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');

    writeFileSync(join(dir, 'new.ts'), 'line one\nline two\nline three\n');

    expect(await computeDiffStat(dir)).toEqual({ added: 3, removed: 0 });
  });

  it('sums tracked modifications and untracked files together', async () => {
    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');

    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 2;\n');
    writeFileSync(join(dir, 'new.ts'), 'a\nb\n');

    expect(await computeDiffStat(dir)).toEqual({ added: 3, removed: 1 });
  });

  it('excludes gitignored untracked files', async () => {
    writeFileSync(join(dir, '.gitignore'), 'ignored.log\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'initial');

    writeFileSync(join(dir, 'ignored.log'), 'noise\nmore noise\n');

    expect(await computeDiffStat(dir)).toEqual({ added: 0, removed: 0 });
  });

  it('treats every file as new when there are no commits yet', async () => {
    writeFileSync(join(dir, 'brand-new.ts'), 'a\nb\nc\n');

    expect(await computeDiffStat(dir)).toEqual({ added: 3, removed: 0 });
  });
});
