import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileSync = vi.fn();
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => execFileSync(...args) }));

// cachedExe lives at module scope, so each test needs a fresh module instance
// to observe caching behavior in isolation from the others.
async function freshResolver() {
  vi.resetModules();
  const mod = await import('./claudeExecutable.js');
  return mod.resolveClaudeExecutable;
}

describe('resolveClaudeExecutable', () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it('caches a successful resolution — the shell-out only happens once', async () => {
    const shimDir = process.platform === 'win32' ? 'C:\\nvm4w\\nodejs' : '/usr/local/bin';
    execFileSync.mockReturnValue(`${shimDir}\\claude.cmd\n`);
    const resolveClaudeExecutable = await freshResolver();

    const first = resolveClaudeExecutable();
    const second = resolveClaudeExecutable();

    expect(first).toBe(second);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed resolution, so a later call can recover once the environment heals', async () => {
    execFileSync.mockImplementation(() => {
      throw new Error('where: claude.cmd not found');
    });
    const resolveClaudeExecutable = await freshResolver();

    const whileBroken = resolveClaudeExecutable();
    expect(whileBroken).toBe(process.platform === 'win32' ? 'claude.exe' : 'claude');
    expect(execFileSync).toHaveBeenCalledTimes(1);

    // The environment "heals" — e.g. nvm settles back onto the right Node
    // version — and the lookup would now succeed. A permanently-cached
    // fallback would never notice; this call must retry.
    const shimDir = process.platform === 'win32' ? 'C:\\nvm4w\\nodejs' : '/usr/local/bin';
    execFileSync.mockReturnValue(`${shimDir}\\claude.cmd\n`);
    const afterHealing = resolveClaudeExecutable();

    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(afterHealing).not.toBe(whileBroken);

    // And now that a real resolution succeeded, IT gets cached.
    const third = resolveClaudeExecutable();
    expect(third).toBe(afterHealing);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
