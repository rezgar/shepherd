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

  it('counts commits ahead of main, not just uncommitted changes', async () => {
    writeFileSync(join(dir, 'tracked.ts'), 'line one\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');

    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'tracked.ts'), 'line one\nline two\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'committed on branch');

    // A `HEAD`-only diff would see this as clean (0/0) — the whole point
    // of comparing against main is to still count the committed line.
    expect(await computeDiffStat(dir)).toEqual({ added: 1, removed: 0 });
  });

  it('sums commits ahead of main with uncommitted changes on top', async () => {
    writeFileSync(join(dir, 'tracked.ts'), 'line one\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');

    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'tracked.ts'), 'line one\nline two\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'committed on branch');
    writeFileSync(join(dir, 'tracked.ts'), 'line one\nline two\nline three\n');

    expect(await computeDiffStat(dir)).toEqual({ added: 2, removed: 0 });
  });

  it("ignores commits landed on main after the branch forked", async () => {
    writeFileSync(join(dir, 'tracked.ts'), 'line one\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');

    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'feature.ts'), 'a\n');
    git(dir, 'add', 'feature.ts');
    git(dir, 'commit', '-q', '-m', 'feature work');

    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'unrelated.ts'), 'b\nc\n');
    git(dir, 'add', 'unrelated.ts');
    git(dir, 'commit', '-q', '-m', 'unrelated main progress');
    git(dir, 'checkout', '-q', 'feature');

    // A tip-of-main diff would count the 2 unrelated lines added to main as
    // if this branch removed them; the merge-base must exclude that.
    expect(await computeDiffStat(dir)).toEqual({ added: 1, removed: 0 });
  });

  it('falls back to master when there is no local main', async () => {
    const masterDir = mkdtempSync(join(tmpdir(), 'shepherd-diffstat-master-'));
    try {
      git(masterDir, 'init', '-q', '-b', 'master');
      git(masterDir, 'config', 'user.email', 'test@example.com');
      git(masterDir, 'config', 'user.name', 'Test');
      writeFileSync(join(masterDir, 'tracked.ts'), 'line one\n');
      git(masterDir, 'add', 'tracked.ts');
      git(masterDir, 'commit', '-q', '-m', 'initial');

      git(masterDir, 'checkout', '-q', '-b', 'feature');
      writeFileSync(join(masterDir, 'tracked.ts'), 'line one\nline two\n');
      git(masterDir, 'add', 'tracked.ts');
      git(masterDir, 'commit', '-q', '-m', 'committed on branch');

      expect(await computeDiffStat(masterDir)).toEqual({ added: 1, removed: 0 });
    } finally {
      rmSync(masterDir, { recursive: true, force: true });
    }
  });

  it('falls back to HEAD when neither main nor master exists locally', async () => {
    const customDir = mkdtempSync(join(tmpdir(), 'shepherd-diffstat-custom-'));
    try {
      git(customDir, 'init', '-q', '-b', 'trunk');
      git(customDir, 'config', 'user.email', 'test@example.com');
      git(customDir, 'config', 'user.name', 'Test');
      writeFileSync(join(customDir, 'tracked.ts'), 'line one\n');
      git(customDir, 'add', 'tracked.ts');
      git(customDir, 'commit', '-q', '-m', 'initial');

      writeFileSync(join(customDir, 'tracked.ts'), 'line one\nline two\n');
      expect(await computeDiffStat(customDir)).toEqual({ added: 1, removed: 0 });

      // Committing that change means it's no longer visible in a
      // `HEAD`-only diff — proving there's genuinely no main/master
      // fallback silently kicking in here.
      git(customDir, 'add', 'tracked.ts');
      git(customDir, 'commit', '-q', '-m', 'committed');
      expect(await computeDiffStat(customDir)).toEqual({ added: 0, removed: 0 });
    } finally {
      rmSync(customDir, { recursive: true, force: true });
    }
  });

  // Regression coverage for #89: the daemon crashed in production because
  // a computation slower than a 3s poll interval let every subsequent
  // caller start ANOTHER full computation on top of the one still
  // running — an unbounded pile-up of concurrent git subprocesses. These
  // two tests exercise exactly the conditions that exposed it: a repo with
  // realistically many untracked files (not the 1-2 files every other test
  // here uses), and concurrent callers for the same cwd.

  it('handles a repo with many untracked files correctly and reasonably fast', async () => {
    const FILE_COUNT = 200;
    for (let i = 0; i < FILE_COUNT; i += 1) {
      writeFileSync(join(dir, `file-${String(i)}.ts`), 'one line\n');
    }

    const started = Date.now();
    const result = await computeDiffStat(dir);
    const elapsedMs = Date.now() - started;

    expect(result).toEqual({ added: FILE_COUNT, removed: 0 });
    // Not a tight perf budget — just a sanity check that this is genuinely
    // parallelized (concurrency-limited) rather than one git spawn per
    // file in sequence, which would take far longer than this for 200
    // files given real per-process spawn overhead.
    expect(elapsedMs).toBeLessThan(8_000);
  }, 15_000);

  it('shares one computation across concurrent calls for the same cwd', async () => {
    writeFileSync(join(dir, 'new.ts'), 'a\nb\n');

    // Fired in the same synchronous tick, before either has had a chance
    // to resolve — if de-duped, both must be the identical Promise
    // instance, proving only one underlying computation is in flight
    // rather than two independent ones racing to the same answer.
    const p1 = computeDiffStat(dir);
    const p2 = computeDiffStat(dir);
    expect(p1).toBe(p2);
    expect(await p1).toEqual({ added: 2, removed: 0 });

    // Once resolved, a fresh call must NOT reuse the stale (now-cleared)
    // entry — it has to reflect current disk state, not the past.
    writeFileSync(join(dir, 'another.ts'), 'c\n');
    const p3 = computeDiffStat(dir);
    expect(p3).not.toBe(p1);
    expect(await p3).toEqual({ added: 3, removed: 0 });
  });
});
